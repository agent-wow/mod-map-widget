// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_MAP_WIDGET_STATE_H
#define MOD_MAP_WIDGET_STATE_H

#include "../vendor/nlohmann/json.hpp"
#include <chrono>
#include <array>
#include <cstdint>
#include <functional>
#include <list>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace MapWidget
{
using Json = nlohmann::json;
using Time = std::chrono::steady_clock::time_point;
using Milliseconds = std::chrono::milliseconds;
constexpr auto Freshness = Milliseconds(5000);

struct Response
{
    unsigned Status = 0;
    std::chrono::seconds RetryAfter{0};
};

bool Retryable(unsigned status);
struct Snapshot
{
    std::string Key;
    std::uint64_t Sequence = 0;
    Time Captured;
    Json Data;
    std::size_t Bytes = 0;
};

class SnapshotQueue
{
public:
    explicit SnapshotQueue(std::size_t bytes = 64 * 1024 * 1024, std::size_t count = 40000);
    bool Push(Snapshot snapshot);
    std::vector<Snapshot> Take(Time now, std::size_t count = 100, std::size_t bytes = 4 * 1024 * 1024);
    void Retry(std::vector<Snapshot> snapshots, Time now);
    std::size_t Size() const;

private:
    mutable std::mutex _mutex;
    std::list<Snapshot> _items;
    std::unordered_map<std::string, std::list<Snapshot>::iterator> _index;
    std::size_t _bytes = 0;
    std::size_t _maxBytes;
    std::size_t _maxCount;
};

Json Batch(std::string const& source, std::string const& process, std::vector<Snapshot> const& items, Time now);
std::vector<Json> CatalogChunks(Json const& entries, std::string const& source, std::string const& process,
    std::string const& revision);
}

#endif
