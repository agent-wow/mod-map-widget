// SPDX-License-Identifier: GPL-2.0-or-later
// Queue adapted from mod-unit-widget bcc630b, by hazim-j (Hazim Jumali).
#include "MapWidgetState.h"
#include <algorithm>
#include <array>
#include <stdexcept>

namespace MapWidget
{
bool Retryable(unsigned status)
{
    return !status || status == 408 || status == 429 || (status >= 500 && status < 600);
}

std::vector<Json> CatalogChunks(Json const& entries, std::string const& source, std::string const& process,
    std::string const& revision)
{
    std::vector<Json> chunks{Json::array()};
    std::size_t bytes = 0;
    for (auto const& entry : entries)
    {
        auto size = entry.dump().size() + 1;
        if (size > 1024 * 1024)
            throw std::invalid_argument("catalogue entry exceeds chunk limit");
        if (bytes + size > 1024 * 1024 || chunks.back().size() >= 5000)
        {
            chunks.push_back(Json::array());
            bytes = 0;
        }
        chunks.back().push_back(entry);
        bytes += size;
    }
    if (chunks.size() > 64)
        throw std::invalid_argument("catalogue exceeds chunk count limit");
    for (std::size_t i = 0; i < chunks.size(); ++i)
        chunks[i] = {{"schema_version", 1}, {"source_id", source}, {"process_id", process},
            {"revision", revision}, {"chunk_index", i}, {"chunk_count", chunks.size()},
            {"entries", std::move(chunks[i])}};
    return chunks;
}

SnapshotQueue::SnapshotQueue(std::size_t bytes, std::size_t count) : _maxBytes(bytes), _maxCount(count) { }

bool SnapshotQueue::Push(Snapshot snapshot)
{
    snapshot.Bytes = snapshot.Data.dump().size() + 256;
    if (snapshot.Bytes > _maxBytes || snapshot.Bytes > 2 * 1024 * 1024)
        return false;
    std::lock_guard lock(_mutex);
    auto found = _index.find(snapshot.Key);
    if (found != _index.end())
    {
        if (found->second->Sequence >= snapshot.Sequence)
            return false;
        if (_bytes - found->second->Bytes + snapshot.Bytes > _maxBytes)
            return false;
        _bytes -= found->second->Bytes;
        *found->second = std::move(snapshot);
        _bytes += found->second->Bytes;
        return true;
    }
    if (_items.size() >= _maxCount || _bytes + snapshot.Bytes > _maxBytes)
        return false;
    _bytes += snapshot.Bytes;
    _items.push_back(std::move(snapshot));
    _index.emplace(_items.back().Key, std::prev(_items.end()));
    return true;
}

std::vector<Snapshot> SnapshotQueue::Take(Time now, std::size_t count, std::size_t bytes)
{
    std::vector<Snapshot> result;
    std::lock_guard lock(_mutex);
    std::size_t used = 1024;
    while (!_items.empty() && result.size() < count)
    {
        auto& item = _items.front();
        bool expired = now - item.Captured >= Freshness;
        if (!expired && used + item.Bytes > bytes)
            break;
        if (!expired)
            used += item.Bytes;
        _bytes -= item.Bytes;
        _index.erase(item.Key);
        if (!expired)
            result.push_back(std::move(item));
        _items.pop_front();
    }
    return result;
}

void SnapshotQueue::Retry(std::vector<Snapshot> snapshots, Time now)
{
    for (auto& item : snapshots)
        if (now - item.Captured < Freshness)
            Push(std::move(item));
}

std::size_t SnapshotQueue::Size() const
{
    std::lock_guard lock(_mutex);
    return _items.size();
}

Json Batch(std::string const& source, std::string const& process, std::vector<Snapshot> const& items, Time now)
{
    Json snapshots = Json::array();
    for (auto const& item : items)
    {
        auto data = item.Data;
        data["sequence"] = std::to_string(item.Sequence);
        data["age_ms"] = std::max<std::int64_t>(0,
            std::chrono::duration_cast<Milliseconds>(now - item.Captured).count());
        snapshots.push_back(std::move(data));
    }
    return {{"schema_version", 1}, {"source_id", source}, {"process_id", process},
        {"updates", std::move(snapshots)}};
}

}
