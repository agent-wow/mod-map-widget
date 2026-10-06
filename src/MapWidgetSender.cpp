// SPDX-License-Identifier: GPL-2.0-or-later
#include "MapWidgetSender.h"
#include "Log.h"
#include <algorithm>
#include <stdexcept>

namespace MapWidget
{
Sender::Sender(HttpOptions options, std::string source, std::string process, std::size_t queueBytes,
    std::vector<Json> catalog) : _queue(queueBytes), _source(std::move(source)), _process(std::move(process))
{
    _transport = MakeHttpTransport(options);
    if (!options.Destination.Target.ends_with("/maps"))
        throw std::invalid_argument("endpoint must end in /maps");
    options.Destination.Target.resize(options.Destination.Target.size() - std::string("/maps").size());
    options.Destination.Target += "/catalogs";
    _catalogTransport = MakeHttpTransport(std::move(options));
    for (auto const& chunk : catalog)
        _catalog.push_back(chunk.dump());
    _worker = std::thread([this] { Run(); });
}

Sender::~Sender() { Stop(); }

void Sender::Push(Snapshot snapshot)
{
    if (!_stopping.load() && !_queue.Push(std::move(snapshot)))
    {
        auto now = std::chrono::steady_clock::now();
        if (now >= _nextDropDiagnostic)
        {
            LOG_WARN("module.mapwidget", "Character update rejected by queue size or panel limit");
            _nextDropDiagnostic = now + std::chrono::seconds(30);
        }
    }
    _wake.notify_one();
}

void Sender::Stop()
{
    if (!_worker.joinable())
        return;
    _deadline.store(std::chrono::duration_cast<Milliseconds>(
        (std::chrono::steady_clock::now() + std::chrono::seconds(2)).time_since_epoch()).count());
    _stopping.store(true);
    _wake.notify_one();
    _worker.join();
}

void Sender::Run()
{
    auto expired = [this]
    {
        return _stopping.load() && std::chrono::duration_cast<Milliseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count() >= _deadline.load();
    };
    auto nextAttempt = Time{};
    auto nextDiagnostic = Time{};
    unsigned backoff = 1;
    std::size_t catalogIndex = 0;
    try
    {
        while (!expired())
        {
            auto now = std::chrono::steady_clock::now();
            if (_stopping.load() && !_queue.Size())
                break;
            if (now >= nextAttempt)
            {
                bool sendingCatalog = catalogIndex < _catalog.size();
                auto items = sendingCatalog ? std::vector<Snapshot>{} : _queue.Take(now);
                if (sendingCatalog || !items.empty())
                {
                    auto response = sendingCatalog ? _catalogTransport->Post(_catalog[catalogIndex], expired) :
                        _transport->Post(Batch(_source, _process, items, now).dump(), expired);
                    now = std::chrono::steady_clock::now();
                    if (response.Status >= 200 && response.Status < 300)
                    {
                        backoff = 1;
                        nextAttempt = now;
                        if (sendingCatalog)
                            ++catalogIndex;
                    }
                    else
                    {
                        if (response.Status == 409 && !sendingCatalog)
                        {
                            catalogIndex = 0;
                            _queue.Retry(std::move(items), now);
                            nextAttempt = now;
                            continue;
                        }
                        if (Retryable(response.Status))
                            _queue.Retry(std::move(items), now);
                        auto delay = std::max(std::chrono::seconds(backoff), response.RetryAfter);
                        nextAttempt = now + delay;
                        backoff = std::min(backoff * 2, 30u);
                        if (now >= nextDiagnostic)
                        {
                            LOG_WARN("module.mapwidget", "Map widget delivery failed (HTTP {}); retry in {}s",
                                response.Status, delay.count());
                            nextDiagnostic = now + std::chrono::seconds(30);
                        }
                    }
                }
            }
            std::unique_lock lock(_mutex);
            _wake.wait_for(lock, Milliseconds(25));
        }
    }
    catch (std::exception const&)
    {
        LOG_ERROR("module.mapwidget", "Map widget delivery worker stopped after an internal error");
    }
}
}
