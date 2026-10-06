// SPDX-License-Identifier: GPL-2.0-or-later
#include "MapWidgetMetadata.h"
#include <gtest/gtest.h>
#include <bit>
#include <fstream>

namespace
{
void Write32(std::ofstream& file, std::uint32_t value)
{
    for (unsigned i = 0; i < 4; ++i)
        file.put(static_cast<char>(value >> (8 * i)));
}
}

TEST(MapWidgetMetadata, ValidatesWdbcLayoutStringsAndFloatFields)
{
    auto path = std::filesystem::temp_directory_path() /
        ("map-widget-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".dbc");
    {
        std::ofstream file(path, std::ios::binary);
        for (auto value : {0x43424457u, 1u, 3u, 12u, 6u, 7u, 1u, std::bit_cast<std::uint32_t>(-9000.5f)})
            Write32(file, value);
        file.write("\0Zone\0", 6);
    }
    MapWidget::DbcTable table;
    EXPECT_TRUE(table.Load(path, 3));
    EXPECT_EQ(table.Text(7, 1), "Zone");
    EXPECT_FLOAT_EQ(table.Float(7, 2), -9000.5f);
    EXPECT_FALSE(table.Load(path, 4));
    std::filesystem::remove(path);
}

TEST(MapWidgetMetadata, RejectsDegenerateBoundsAndSeparatesInstancesAndPhases)
{
    EXPECT_TRUE(MapWidget::Bounds(0, 0, 0, 0).is_null());
    EXPECT_FALSE(MapWidget::Bounds(1500, -1900, -7900, -10200).is_null());
    EXPECT_TRUE(MapWidget::SameSpace(631, 42, 3, 631, 42, 2));
    EXPECT_FALSE(MapWidget::SameSpace(631, 42, 1, 631, 43, 1));
    EXPECT_FALSE(MapWidget::SameSpace(631, 42, 1, 631, 42, 2));
    EXPECT_FALSE(MapWidget::SameSpace(0, 0, 1, 1, 0, 1));
    EXPECT_TRUE(MapWidget::Tracked(2, 2));
    EXPECT_FALSE(MapWidget::Tracked(2, 3));
    EXPECT_FALSE(MapWidget::Tracked(2, 0));
    EXPECT_FALSE(MapWidget::Tracked(2, 33));
}

TEST(MapWidgetMetadata, ResolvesChunkHeightsAndRefusesAmbiguousFloors)
{
    auto path = std::filesystem::temp_directory_path() /
        ("map-widget-floors-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directory(path);
    auto table = [&path](char const* name, std::uint32_t fields,
        std::vector<std::vector<std::uint32_t>> const& rows)
    {
        std::ofstream file(path / (std::string(name) + ".dbc"), std::ios::binary);
        for (auto value : {0x43424457u, std::uint32_t(rows.size()), fields, fields * 4, 1u})
            Write32(file, value);
        for (auto const& row : rows)
            for (auto value : row)
                Write32(file, value);
        file.put(0);
    };
    auto f = [](float value) { return std::bit_cast<std::uint32_t>(value); };
    table("WorldMapArea", 11, {{604, 631, 4812, 0, 0, 0, 0, 0, 0, 0xffffffff, 0}});
    table("WorldMapContinent", 14, {});
    table("WorldMapTransforms", 10, {});
    table("DungeonMap", 8, {{103, 631, 1, f(1384), f(2739), f(-764), f(138), 492},
        {104, 631, 2, f(1600), f(2700), f(-750), f(-40), 492}});
    table("DungeonMapChunk", 5, {{1, 631, 7, 103, f(0)}, {2, 631, 7, 104, f(100)},
        {3, 631, 8, 103, f(0)}, {4, 631, 8, 104, f(0)}});
    MapWidget::Metadata metadata;
    metadata.Load(path);
    EXPECT_EQ(metadata.WorldMap(631, 4812), 604);
    EXPECT_EQ(metadata.Floor(631, 7, 50), 1);
    EXPECT_EQ(metadata.Floor(631, 7, 100), 2);
    EXPECT_TRUE(metadata.Floor(631, 8, 50).is_null());
    EXPECT_TRUE(metadata.Floor(631, -1, 50).is_null());
    EXPECT_TRUE(metadata.Floor(0, 7, 50).is_null());
    EXPECT_TRUE(metadata.Floor(631, 7, -1).is_null());
    auto catalog = metadata.Catalog();
    EXPECT_EQ(catalog[0]["data"]["dungeon"], 0);
    EXPECT_EQ(catalog[1]["data"]["bounds"], MapWidget::Bounds(2739, 1384, 138, -764));
    std::filesystem::remove_all(path);
}
