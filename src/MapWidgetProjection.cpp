// SPDX-License-Identifier: GPL-2.0-or-later
#include "MapWidgetProjection.h"
#include "Corpse.h"
#include "Creature.h"
#include "DBCStores.h"
#include "GameObject.h"
#include "Group.h"
#include "Map.h"
#include "ObjectMgr.h"
#include "Player.h"
#include "QuestDef.h"
#include <algorithm>

namespace MapWidget
{
namespace
{
std::string AreaName(uint32 id)
{
    auto entry = sAreaTableStore.LookupEntry(id);
    return entry && entry->area_name[0] ? entry->area_name[0] : "Unknown area";
}

bool SharesSpace(WorldObject* a, WorldObject* b)
{
    return b->IsInWorld() && SameSpace(a->GetMapId(), a->GetInstanceId(), a->GetPhaseMask(),
        b->GetMapId(), b->GetInstanceId(), b->GetPhaseMask());
}
}

Json Projection::Position(WorldObject* object) const
{
    uint32 flags;
    int32 adt, root, group = -1;
    if (!object->GetMap()->GetAreaInfo(object->GetPhaseMask(), object->GetPositionX(), object->GetPositionY(),
        object->GetPositionZ(), flags, adt, root, group))
        group = -1;
    return {{"map", object->GetMapId()}, {"instance", object->GetInstanceId()}, {"phase", object->GetPhaseMask()},
        {"x", object->GetPositionX()}, {"y", object->GetPositionY()}, {"z", object->GetPositionZ()},
        {"facing", object->GetOrientation()}, {"area", object->GetAreaId()}, {"zone", object->GetZoneId()},
        {"floor", _metadata.Floor(object->GetMapId(), group, object->GetPositionZ())}};
}

Json Projection::Catalog() const
{
    auto result = _metadata.Catalog();
    for (auto& entry : result)
        if (entry["kind"] == "areas")
        {
            auto& data = entry["data"];
            uint32 area = data["area"];
            if (area)
            {
                data["name"] = AreaName(area);
                // Core helpers include worldmaparea_dbc overrides for fields the core loads.
                if (!data["bounds"].is_null())
                {
                    float x1 = 0, y1 = 0, x2 = 100, y2 = 100;
                    Zone2MapCoordinates(x1, y1, area);
                    Zone2MapCoordinates(x2, y2, area);
                    data["bounds"] = Bounds(y1, y2, x1, x2);
                }
            }
            else if (auto map = sMapStore.LookupEntry(data["map"].get<uint32>()))
                data["name"] = map->name[0];
        }
    return result;
}

Json Projection::Motion(Player* player) const
{
    auto actor = [this](WorldObject* object, char const* kind)
    {
        auto data = Position(object);
        data["guid"] = object->GetGUID().ToString();
        data["name"] = object->GetName();
        data["kind"] = kind;
        return data;
    };
    auto group = Json::array();
    if (auto members = player->GetGroup())
        for (auto ref = members->GetFirstMember(); ref; ref = ref->next())
            if (auto member = ref->GetSource())
                if (member != player && !member->IsBeingTeleported() && SharesSpace(player, member))
                    group.push_back(actor(member, "group"));
    Json corpse = nullptr;
    if (auto remains = player->GetCorpse(); remains && SharesSpace(player, remains))
    {
        corpse = actor(remains, "corpse");
        corpse["name"] = "Corpse";
    }
    else if (player->HasCorpse() && player->GetCorpseLocation().GetMapId() != player->GetMapId())
    {
        auto loc = player->GetCorpseLocation();
        uint32 map = loc.GetMapId();
        float x = loc.GetPositionX(), y = loc.GetPositionY(), z = loc.GetPositionZ();
        if (map != player->GetMapId())
            if (auto entry = sMapStore.LookupEntry(map))
                if (entry->IsDungeon() && entry->entrance_map >= 0)
                {
                    map = entry->entrance_map;
                    x = entry->entrance_x;
                    y = entry->entrance_y;
                    z = 0;
                }
        corpse = {{"guid", player->GetGUID().ToString()}, {"name", "Corpse"}, {"kind", "corpse"},
            {"map", map}, {"instance", 0}, {"phase", player->GetPhaseMask()},
            {"x", x}, {"y", y}, {"z", z}, {"facing", 0}, {"area", 0}, {"zone", 0}, {"floor", nullptr}};
    }
    return {{"player", actor(player, "player")}, {"group", group}, {"corpse", corpse},
        {"zone_name", AreaName(player->GetZoneId())}, {"area_name", AreaName(player->GetAreaId())},
        {"world_map", _metadata.WorldMap(player->GetMapId(), player->GetZoneId())},
        {"indoors", !player->IsOutdoors()}, {"transport", player->GetTransport() != nullptr}};
}

Json Projection::Markers(Player* player, Json const& statuses, Json const& guard) const
{
    Json markers = Json::array();
    bool truncated = false;
    player->DoForAllVisibleWorldObjects([&](WorldObject* object)
    {
        if (!SharesSpace(player, object) || !player->HaveAtClient(object->GetGUID()) ||
            !player->CanSeeOrDetect(object, false, true) || player->GetDistance(object) > 400)
            return;
        std::vector<std::string> kinds;
        auto guid = object->GetGUID().ToString();
        uint32 status = statuses.value(guid, 0u);
        if (auto creature = object->ToCreature())
        {
            if (!creature->IsAlive())
                return;
            if (!creature->IsHostileTo(player))
            {
                if (creature->IsVendor())
                    kinds.emplace_back("vendor");
                if (creature->IsArmorer())
                    kinds.emplace_back("repair");
                if (creature->IsTrainer())
                    kinds.emplace_back("trainer");
                if (creature->IsTaxi())
                    kinds.emplace_back("flight");
                if (creature->IsBanker())
                    kinds.emplace_back("bank");
                if (creature->IsInnkeeper())
                    kinds.emplace_back("inn");
                if (creature->IsAuctioner())
                    kinds.emplace_back("auction");
                if (creature->IsQuestGiver() && status >= DIALOG_STATUS_LOW_LEVEL_AVAILABLE)
                    kinds.emplace_back("quest");
            }
            if (Tracked(player->GetUInt32Value(PLAYER_TRACK_CREATURES), creature->GetCreatureType()) ||
                creature->HasAuraTypeWithCaster(SPELL_AURA_MOD_STALKED, player->GetGUID()))
                kinds.emplace_back("creature");
        }
        else if (auto go = object->ToGameObject())
        {
            if (!go->isSpawned())
                return;
            if (go->GetGoType() == GAMEOBJECT_TYPE_MAILBOX)
                kinds.emplace_back("mail");
            if (go->GetGoType() == GAMEOBJECT_TYPE_FISHINGHOLE &&
                Tracked(player->GetUInt32Value(PLAYER_TRACK_RESOURCES), LOCKTYPE_FISHING))
                kinds.emplace_back("fish");
            if (go->GetGoType() == GAMEOBJECT_TYPE_QUESTGIVER && status >= DIALOG_STATUS_LOW_LEVEL_AVAILABLE)
                kinds.emplace_back("quest");
            if (auto lock = sLockStore.LookupEntry(go->GetGOInfo()->GetLockId()))
                for (unsigned i = 0; i < MAX_LOCK_CASE; ++i)
                    if (lock->Type[i] == LOCK_KEY_SKILL &&
                        Tracked(player->GetUInt32Value(PLAYER_TRACK_RESOURCES), lock->Index[i]))
                    {
                        if (lock->Index[i] == LOCKTYPE_HERBALISM)
                            kinds.emplace_back("herb");
                        else if (lock->Index[i] == LOCKTYPE_MINING)
                            kinds.emplace_back("ore");
                        else if (lock->Index[i] == LOCKTYPE_FISHING)
                            kinds.emplace_back("fish");
                        else
                            kinds.emplace_back("resource");
                    }
        }
        std::sort(kinds.begin(), kinds.end());
        kinds.erase(std::unique(kinds.begin(), kinds.end()), kinds.end());
        if (kinds.empty())
            return;
        auto position = Position(object);
        for (auto const& kind : kinds)
        {
            if (markers.size() >= 511)
            {
                truncated = true;
                break;
            }
            auto pin = position;
            pin["id"] = guid + "/" + kind;
            pin["name"] = object->GetName();
            pin["kind"] = kind;
            pin["status"] = status;
            markers.push_back(std::move(pin));
        }
    });
    if (!guard.is_null())
        markers.push_back(guard);
    std::sort(markers.begin(), markers.end(), [](auto const& a, auto const& b) { return a["id"] < b["id"]; });
    return {{"markers", markers}, {"truncated", truncated}};
}

Json Projection::Quests(Player* player) const
{
    Json quests = Json::array();
    bool truncated = false;
    std::size_t points = 0;
    for (uint16 slot = 0; slot < MAX_QUEST_LOG_SIZE; ++slot)
    {
        auto id = player->GetQuestSlotQuestId(slot);
        auto quest = sObjectMgr->GetQuestTemplate(id);
        if (!quest)
            continue;
        auto status = player->GetQuestStatus(id);
        auto const& statuses = player->getQuestStatusMap();
        auto saved = statuses.find(id);
        QuestStatusData const* progress = saved == statuses.end() ? nullptr : &saved->second;
        Json objectives = Json::array();
        for (uint8 i = 0; i < QUEST_OBJECTIVES_COUNT; ++i)
            if (quest->RequiredNpcOrGo[i])
                objectives.push_back({{"text", quest->ObjectiveText[i].empty() ?
                    "Creature/object objective" : quest->ObjectiveText[i]},
                    {"value", player->GetQuestSlotCounter(slot, i)}, {"max", quest->RequiredNpcOrGoCount[i]}});
        for (uint8 i = 0; i < QUEST_ITEM_OBJECTIVES_COUNT; ++i)
            if (quest->RequiredItemId[i])
            {
                auto item = sObjectMgr->GetItemTemplate(quest->RequiredItemId[i]);
                objectives.push_back({{"text", item ? item->Name1 : "Required item"},
                    {"value", progress ? progress->ItemCount[i] : 0}, {"max", quest->RequiredItemCount[i]}});
            }
        if (quest->GetPlayersSlain())
            objectives.push_back({{"text", "Players slain"}, {"value", progress ? progress->PlayerCount : 0},
                {"max", quest->GetPlayersSlain()}});
        if (quest->HasSpecialFlag(QUEST_SPECIAL_FLAGS_EXPLORATION_OR_EVENT))
            objectives.push_back({{"text", "Exploration or event"},
                {"value", progress && progress->Explored ? 1 : 0}, {"max", 1}});
        Json pois = Json::array();
        if (auto records = sObjectMgr->GetQuestPOIVector(id))
            for (auto const& poi : *records)
            {
                // Keep complete polygons; never truncate a shape into misleading geometry.
                if (pois.size() >= 64 || poi.points.size() > 4096 || points + poi.points.size() > 20000)
                {
                    truncated = true;
                    continue;
                }
                points += poi.points.size();
                Json shape = Json::array();
                for (auto const& point : poi.points)
                    shape.push_back({{"x", point.x}, {"y", point.y}});
                pois.push_back({{"id", poi.Id}, {"objective", poi.ObjectiveIndex}, {"map", poi.MapId},
                    {"world_map", poi.AreaId}, {"floor", poi.FloorId}, {"points", shape}});
            }
        quests.push_back({{"id", id}, {"name", quest->GetTitle()},
            {"objectives_text", quest->GetObjectives()}, {"objectives", objectives},
            {"status", status == QUEST_STATUS_COMPLETE ? "complete" :
                status == QUEST_STATUS_FAILED ? "failed" : "incomplete"}, {"pois", pois}});
    }
    return {{"quests", quests}, {"truncated", truncated}};
}
}
