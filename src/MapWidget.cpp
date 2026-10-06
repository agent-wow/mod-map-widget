// SPDX-License-Identifier: GPL-2.0-or-later
#include "MapWidgetProjection.h"
#include "MapWidgetObservation.h"
#include "ServerScript.h"
#include "Opcodes.h"
#include "WorldPacket.h"
#include "MapWidgetSender.h"
#include "Config.h"
#include "CryptoRandom.h"
#include "Log.h"
#include "Player.h"
#include "PlayerScript.h"
#include "StringFormat.h"
#include "World.h"
#include "WorldScript.h"
#include "WorldSession.h"
#include "WorldSessionMgr.h"
#include <boost/uuid/uuid.hpp>
#include <boost/uuid/uuid_io.hpp>
#include <algorithm>
#include <atomic>
#include <map>
#include <sstream>
#include <stdexcept>
#include <unordered_set>

namespace MapWidget
{
namespace
{
Time Now() { return std::chrono::steady_clock::now(); }

std::string ProcessId()
{
    auto bytes = Acore::Crypto::GetRandomBytes<16>();
    boost::uuids::uuid id;
    std::copy(bytes.begin(), bytes.end(), id.begin());
    return boost::uuids::to_string(id);
}

std::string Lower(std::string name)
{
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c)
    {
        return c >= 'A' && c <= 'Z' ? char(c + 'a' - 'A') : char(c);
    });
    return name;
}

struct Track
{
    Time Next{};
    Time NextContent{};
    std::map<std::string, std::pair<std::string, Time>> Sent;
    Json Revisions = Json::object();
};

struct Observations
{
    std::string Guid;
    uint32 Map = 0;
    uint32 Instance = 0;
    uint32 Phase = 0;
    uint32 MovementEpoch = 0;
    Json Statuses = Json::object();
    Json Guard = nullptr;
};

class Service
{
public:
    void Start()
    {
        if (_sender || !sConfigMgr->GetOption<bool>("MapWidget.Enable", true))
            return;
        auto endpoint = sConfigMgr->GetOption<std::string>("MapWidget.Endpoint", "");
        if (endpoint.empty())
            return;
        try
        {
            _interval = sConfigMgr->GetOption<uint32>("MapWidget.UpdateIntervalMs", 100);
            _contentInterval = sConfigMgr->GetOption<uint32>("MapWidget.ContentIntervalMs", 1000);
            auto queueBytes = sConfigMgr->GetOption<uint32>("MapWidget.QueueBytes", 64 * 1024 * 1024);
            auto source = sConfigMgr->GetOption<std::string>("MapWidget.SourceId",
                Acore::StringFormat("realm-{}", sConfigMgr->GetOption<uint32>("RealmID", 1)));
            if (_interval < 50 || _interval > 1000 || _contentInterval < _interval || _contentInterval > 2000 ||
                queueBytes < 8 * 1024 * 1024 || queueBytes > 256 * 1024 * 1024 || source.empty() || source.size() > 256)
                throw std::invalid_argument("invalid map widget configuration");
            std::istringstream configured(sConfigMgr->GetOption<std::string>("MapWidget.Characters", ""));
            for (std::string name; std::getline(configured, name, ',');)
            {
                auto begin = name.find_first_not_of(" \t");
                auto end = name.find_last_not_of(" \t");
                if (begin != std::string::npos)
                    _allowlist.insert(Lower(name.substr(begin, end - begin + 1)));
            }
            HttpOptions http;
            http.Destination = ParseEndpoint(endpoint);
            http.BearerToken = sConfigMgr->GetOption<std::string>("MapWidget.BearerToken", "");
            http.CaFile = sConfigMgr->GetOption<std::string>("MapWidget.CAFile", "");
            http.ConnectTimeout = Milliseconds(sConfigMgr->GetOption<uint32>("MapWidget.ConnectTimeoutMs", 750));
            http.RequestTimeout = Milliseconds(sConfigMgr->GetOption<uint32>("MapWidget.RequestTimeoutMs", 1500));
            if (http.RequestTimeout > Milliseconds(3000))
                throw std::invalid_argument("request timeout exceeds freshness budget");
            _process = ProcessId();
            _metadata.Load(std::filesystem::path(sWorld->GetDataPath()) / "dbc");
            _projection = std::make_unique<Projection>(_metadata);
            auto catalog = CatalogChunks(_projection->Catalog(), source, _process, _process);
            _sender = std::make_unique<Sender>(std::move(http), source, _process, queueBytes, std::move(catalog));
            _enabled.store(true);
            LOG_INFO("module.mapwidget", "Map widget enabled; movement {}ms, content {}ms",
                _interval, _contentInterval);
        }
        catch (std::exception const&)
        {
            LOG_ERROR("module.mapwidget", "Invalid map widget configuration or metadata; capture disabled");
        }
    }

    void Stop()
    {
        _enabled.store(false);
        _sender.reset();
    }

    void Identity(Player* player)
    {
        if (!_enabled.load() || !Allowed(player))
            return;
        std::lock_guard lock(_observationsMutex);
        auto account = player->GetSession()->GetAccountId();
        if (!_observations.contains(account) && _observations.size() >= 10000)
            return;
        auto& observation = _observations[account];
        auto guid = player->GetGUID().ToString();
        if (observation.Guid != guid || observation.Map != player->GetMapId() ||
            observation.Instance != player->GetInstanceId() || observation.Phase != player->GetPhaseMask())
        {
            _statusCount -= observation.Statuses.size();
            observation = {guid, player->GetMapId(), player->GetInstanceId(), player->GetPhaseMask(),
                observation.MovementEpoch + 1};
        }
    }

    void Teleport(Player* player)
    {
        if (!_enabled.load())
            return;
        std::lock_guard lock(_observationsMutex);
        auto found = _observations.find(player->GetSession()->GetAccountId());
        if (found != _observations.end())
            ++found->second.MovementEpoch;
    }

    void Packet(WorldSession* session, WorldPacket const& packet)
    {
        if (!_enabled.load() || !session || (packet.GetOpcode() != SMSG_GOSSIP_POI &&
            packet.GetOpcode() != SMSG_QUESTGIVER_STATUS && packet.GetOpcode() != SMSG_QUESTGIVER_STATUS_MULTIPLE))
            return;
        auto data = Observe(packet);
        if (data.empty())
            return;
        std::lock_guard lock(_observationsMutex);
        auto found = _observations.find(session->GetAccountId());
        if (found == _observations.end())
            return;
        auto& observation = found->second;
        if (data.contains("statuses"))
            for (auto const& status : data["statuses"])
            {
                std::string guid = status["guid"];
                if (!observation.Statuses.contains(guid))
                {
                    if (observation.Statuses.size() >= 2048 || _statusCount >= 65536)
                        continue;
                    ++_statusCount;
                }
                observation.Statuses[guid] = status["status"];
            }
        if (data.contains("guard"))
        {
            auto const& guard = data["guard"];
            observation.Guard = {{"id", "guard"}, {"name", guard["name"]}, {"kind", "guard"}, {"status", 0},
                {"map", observation.Map}, {"instance", observation.Instance}, {"phase", observation.Phase},
                {"x", guard["x"]}, {"y", guard["y"]}, {"z", 0}, {"facing", 0},
                {"area", 0}, {"zone", 0}, {"floor", nullptr}};
        }
    }

    void Update()
    {
        if (!_sender)
            return;
        auto now = Now();
        // World::Update calls this after MapMgr joins its workers. Pointers remain local to this call.
        std::vector<Player*> players;
        for (auto const& [account, session] : sWorldSessionMgr->GetAllSessions())
        {
            static_cast<void>(account);
            auto player = session->GetPlayer();
            if (player && !session->PlayerLogout() && Allowed(player))
                players.push_back(player);
        }
        if (players.empty())
            return;
        unsigned captured = 0;
        for (std::size_t visited = 0; visited < players.size() && captured < 32; ++visited)
        {
            _cursor %= players.size();
            auto player = players[_cursor++];
            auto guid = player->GetGUID().ToString();
            if (!_tracked.contains(guid) && _tracked.size() >= 10000)
                continue;
            auto& track = _tracked[guid];
            if (now < track.Next)
                continue;
            track.Next = now + Milliseconds(_interval);
            ++captured;
            if (!player->IsInWorld() || player->IsBeingTeleported())
            {
                Push(player, "presence", {{"presence", "unavailable"}}, now);
                track.NextContent = Time{};
                continue;
            }
            try
            {
                Identity(player);
                auto motion = _projection->Motion(player);
                {
                    std::lock_guard lock(_observationsMutex);
                    auto found = _observations.find(player->GetSession()->GetAccountId());
                    motion["movement_epoch"] = found == _observations.end() ? 0 : found->second.MovementEpoch;
                }
                Publish(player, track, "motion", std::move(motion), now);
                if (now >= track.NextContent)
                {
                    track.NextContent = now + Milliseconds(_contentInterval);
                    Json statuses = Json::object(), guard = nullptr;
                    {
                        std::lock_guard lock(_observationsMutex);
                        auto found = _observations.find(player->GetSession()->GetAccountId());
                        if (found != _observations.end())
                        {
                            auto& observation = found->second;
                            std::unordered_set<std::string> visible;
                            player->DoForAllVisibleWorldObjects([&visible](WorldObject* object)
                            {
                                visible.insert(object->GetGUID().ToString());
                            });
                            for (auto it = observation.Statuses.begin(); it != observation.Statuses.end();)
                                if (!visible.contains(it.key()))
                                {
                                    it = observation.Statuses.erase(it);
                                    --_statusCount;
                                }
                                else
                                    ++it;
                            statuses = observation.Statuses;
                            guard = observation.Guard;
                        }
                    }
                    Publish(player, track, "markers", _projection->Markers(player, statuses, guard), now);
                    Publish(player, track, "quests", _projection->Quests(player), now);
                }
                Push(player, "presence", {{"presence", "online"}, {"revisions", track.Revisions}}, now);
            }
            catch (std::exception const&)
            {
                if (now >= _nextError)
                {
                    LOG_WARN("module.mapwidget", "Unable to capture map state; waiting for next sample");
                    _nextError = now + std::chrono::seconds(30);
                }
            }
        }
    }

    void Logout(Player* player)
    {
        if (!_sender || !Allowed(player))
            return;
        Push(player, "presence", {{"presence", "offline"}}, Now());
        auto found = _tracked.find(player->GetGUID().ToString());
        if (found != _tracked.end())
        {
            for (auto const& [panel, sent] : found->second.Sent)
            {
                static_cast<void>(panel);
                _cacheBytes -= sent.first.size();
            }
            _tracked.erase(found);
        }
        std::lock_guard lock(_observationsMutex);
        auto observation = _observations.find(player->GetSession()->GetAccountId());
        if (observation != _observations.end())
        {
            _statusCount -= observation->second.Statuses.size();
            _observations.erase(observation);
        }
    }

private:
    bool Allowed(Player* player) const
    {
        return _allowlist.empty() || _allowlist.contains(Lower(player->GetName())) ||
            _allowlist.contains(Lower(player->GetGUID().ToString()));
    }

    void Publish(Player* player, Track& track, std::string const& panel, Json data, Time now)
    {
        auto encoded = data.dump();
        auto& sent = track.Sent[panel];
        if (encoded != sent.first || now - sent.second >= std::chrono::seconds(3))
        {
            track.Revisions[panel] = std::to_string(Push(player, panel, std::move(data), now));
            _cacheBytes -= sent.first.size();
            sent.first.clear();
            if (_cacheBytes + encoded.size() <= 64 * 1024 * 1024)
            {
                _cacheBytes += encoded.size();
                sent.first = std::move(encoded);
            }
            sent.second = now;
        }
    }

    std::uint64_t Push(Player* player, std::string const& panel, Json data, Time now)
    {
        auto guid = player->GetGUID().ToString();
        _sender->Push({guid + "/" + panel, ++_sequence, now, {{"guid", guid}, {"name", player->GetName()},
            {"panel", panel}, {"catalog_revision", _process}, {"data", std::move(data)}}});
        return _sequence;
    }

    Metadata _metadata;
    std::unique_ptr<Projection> _projection;
    std::unique_ptr<Sender> _sender;
    std::unordered_map<std::string, Track> _tracked;
    std::unordered_set<std::string> _allowlist;
    std::unordered_map<uint32, Observations> _observations;
    std::mutex _observationsMutex;
    std::atomic<bool> _enabled{false};
    std::string _process;
    std::uint64_t _sequence = 0;
    std::size_t _cursor = 0;
    std::size_t _cacheBytes = 0;
    std::size_t _statusCount = 0;
    uint32 _interval = 100;
    uint32 _contentInterval = 1000;
    Time _nextError{};
};

class World final : public WorldScript
{
public:
    explicit World(std::shared_ptr<Service> service) : WorldScript("MapWidgetWorld",
        {WORLDHOOK_ON_STARTUP, WORLDHOOK_ON_UPDATE, WORLDHOOK_ON_SHUTDOWN}), _service(std::move(service)) { }
    ~World() override { _service->Stop(); }
    void OnStartup() override { _service->Start(); }
    void OnUpdate(uint32) override { _service->Update(); }
    void OnShutdown() override { _service->Stop(); }

private:
    std::shared_ptr<Service> _service;
};

class Players final : public PlayerScript
{
public:
    explicit Players(std::shared_ptr<Service> service) : PlayerScript("MapWidgetPlayers",
        {PLAYERHOOK_ON_BEFORE_LOGOUT, PLAYERHOOK_ON_LOGIN, PLAYERHOOK_ON_LOAD_FROM_DB,
            PLAYERHOOK_ON_MAP_CHANGED, PLAYERHOOK_ON_BEFORE_TELEPORT}),
        _service(std::move(service)) { }
    void OnPlayerBeforeLogout(Player* player) override { _service->Logout(player); }
    void OnPlayerLoadFromDB(Player* player) override { _service->Identity(player); }
    void OnPlayerLogin(Player* player) override { _service->Identity(player); }
    void OnPlayerMapChanged(Player* player) override { _service->Identity(player); }
    bool OnPlayerBeforeTeleport(Player* player, uint32, float, float, float, float, uint32, Unit*) override
    {
        _service->Teleport(player);
        return true;
    }

private:
    std::shared_ptr<Service> _service;
};

class Packets final : public ServerScript
{
public:
    explicit Packets(std::shared_ptr<Service> service) : ServerScript("MapWidgetPackets", {SERVERHOOK_ON_PACKET_SENT}),
        _service(std::move(service)) { }
    void OnPacketSent(WorldSession* session, WorldPacket const& packet) override { _service->Packet(session, packet); }

private:
    std::shared_ptr<Service> _service;
};
}
}

void Addmod_map_widgetScripts()
{
    auto service = std::make_shared<MapWidget::Service>();
    new MapWidget::World(service);
    new MapWidget::Players(service);
    new MapWidget::Packets(service);
}
