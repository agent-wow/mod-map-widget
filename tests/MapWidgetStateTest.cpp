// SPDX-License-Identifier: GPL-2.0-or-later
#include "MapWidgetState.h"
#include <gtest/gtest.h>

namespace
{
using namespace MapWidget;
using namespace std::chrono_literals;
Snapshot Make(std::string key, std::uint64_t sequence)
{
    return {key, sequence, Time{}, {{"guid", "Alice"}, {"panel", key}, {"data", Json::object()}}};
}

TEST(MapWidgetState, CoalescesMotionWithoutStarvingGeometryOrRestoringOlderRetries)
{
    SnapshotQueue queue;
    queue.Push(Make("motion", 1));
    queue.Push(Make("quests", 2));
    queue.Push(Make("motion", 3));
    auto flight = queue.Take(Time{}, 1);
    ASSERT_EQ(flight.size(), 1);
    EXPECT_EQ(flight[0].Sequence, 3);
    queue.Push(Make("motion", 4));
    queue.Retry(std::move(flight), Time{} + 1s);
    auto next = queue.Take(Time{} + 1s);
    ASSERT_EQ(next.size(), 2);
    EXPECT_EQ(next[0].Key, "quests");
    EXPECT_EQ(next[1].Sequence, 4);
    queue.Retry(std::move(next), Time{} + 5s);
    EXPECT_EQ(queue.Size(), 0);
}

TEST(MapWidgetState, RejectsOversizedReplacementWithoutLosingPendingState)
{
    SnapshotQueue queue(4096, 1);
    EXPECT_TRUE(queue.Push(Make("motion", 1)));
    EXPECT_FALSE(queue.Push(Make("quests", 2)));
    auto big = Make("motion", 3);
    big.Data["data"] = std::string(5000, 'x');
    EXPECT_FALSE(queue.Push(std::move(big)));
    EXPECT_EQ(queue.Take(Time{})[0].Sequence, 1);
    EXPECT_TRUE(Retryable(429));
    EXPECT_FALSE(Retryable(401));
}

TEST(MapWidgetState, UsesLosslessSequenceStringsAndRelativeAge)
{
    auto data = Batch("realm", "process", {Make("motion", 18446744073709551615ull)}, Time{} + 1200ms);
    EXPECT_EQ(data["updates"][0]["sequence"], "18446744073709551615");
    EXPECT_EQ(data["updates"][0]["age_ms"], 1200);
}

TEST(MapWidgetState, CatalogueChunksPreserveAllMetadata)
{
    Json entries = Json::array();
    for (unsigned i = 0; i < 6000; ++i)
        entries.push_back({{"id", i}, {"name", std::string(300, 'x')}});
    auto chunks = CatalogChunks(entries, "realm", "process", "revision");
    std::size_t count = 0;
    for (auto const& chunk : chunks)
    {
        EXPECT_LT(chunk.dump().size(), 1024 * 1024 + 1024);
        count += chunk["entries"].size();
    }
    EXPECT_EQ(count, entries.size());
}
}
