// SPDX-License-Identifier: GPL-2.0-or-later
#include "MapWidgetMetadata.h"
#include "Log.h"
#include <algorithm>
#include <bit>
#include <cmath>
#include <limits>
#include <fstream>
#include <iterator>

namespace MapWidget
{
namespace
{
std::uint32_t Read32(std::vector<unsigned char> const& bytes, std::size_t at)
{
    return std::uint32_t(bytes[at]) | (std::uint32_t(bytes[at + 1]) << 8) |
        (std::uint32_t(bytes[at + 2]) << 16) | (std::uint32_t(bytes[at + 3]) << 24);
}
}

bool DbcTable::Load(std::filesystem::path const& path, std::uint32_t fields)
{
    _rows.clear();
    _ids.clear();
    _bytes.clear();
    std::error_code error;
    auto size = std::filesystem::file_size(path, error);
    if (error || size < 20 || size > 64 * 1024 * 1024 || !fields || fields > 256)
        return false;
    std::ifstream file(path, std::ios::binary);
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    if (bytes.size() != size || Read32(bytes, 0) != 0x43424457 || Read32(bytes, 8) != fields ||
        Read32(bytes, 12) != fields * 4)
        return false;
    auto rows = Read32(bytes, 4);
    auto strings = std::uint64_t(20) + std::uint64_t(rows) * fields * 4;
    if (strings + Read32(bytes, 16) != size || !Read32(bytes, 16) || bytes.back() != 0)
        return false;
    _bytes = std::move(bytes);
    _fields = fields;
    _strings = strings;
    for (std::size_t i = 0; i < rows; ++i)
    {
        auto offset = 20 + i * fields * 4;
        if (!_rows.emplace(Read32(_bytes, offset), offset).second)
        {
            _rows.clear();
            _bytes.clear();
            return false;
        }
    }
    for (auto const& [id, offset] : _rows)
    {
        static_cast<void>(offset);
        _ids.push_back(id);
    }
    std::sort(_ids.begin(), _ids.end());
    return true;
}

std::uint32_t DbcTable::Number(std::uint32_t id, std::uint32_t field) const
{
    auto row = _rows.find(id);
    return row == _rows.end() || field >= _fields ? 0 : Read32(_bytes, row->second + field * 4);
}

std::string DbcTable::Text(std::uint32_t id, std::uint32_t field) const
{
    if (!_rows.contains(id) || field >= _fields)
        return {};
    auto offset = Number(id, field);
    if (offset >= _bytes.size() - _strings)
        return {};
    auto start = _bytes.begin() + _strings + offset;
    auto end = std::find(start, _bytes.end(), 0);
    if (end == _bytes.end() || end - start > 16384)
        return {};
    return std::string(start, end);
}

float DbcTable::Float(std::uint32_t id, std::uint32_t field) const
{
    return std::bit_cast<float>(Number(id, field));
}

Json Bounds(float left, float right, float top, float bottom)
{
    if (!std::isfinite(left) || !std::isfinite(right) || !std::isfinite(top) || !std::isfinite(bottom) ||
        left <= right || top <= bottom)
        return nullptr;
    return {{"left", left}, {"right", right}, {"top", top}, {"bottom", bottom}};
}

bool SameSpace(std::uint32_t map, std::uint32_t instance, std::uint32_t phase,
    std::uint32_t otherMap, std::uint32_t otherInstance, std::uint32_t otherPhase)
{
    return map == otherMap && instance == otherInstance && (phase & otherPhase) != 0;
}

bool Tracked(std::uint32_t mask, std::uint32_t type)
{
    return type > 0 && type <= 32 && (mask & (std::uint32_t(1) << (type - 1)));
}

void Metadata::Load(std::filesystem::path const& path)
{
    for (auto const& [name, fields] : std::vector<std::pair<std::string, std::uint32_t>>{
        {"WorldMapArea", 11}, {"WorldMapContinent", 14}, {"DungeonMap", 8},
        {"DungeonMapChunk", 5}, {"WorldMapTransforms", 10}})
        if (!Tables[name].Load(path / (name + ".dbc"), fields))
            LOG_WARN("module.mapwidget", "Supplemental {}.dbc unavailable; affected maps have no projection", name);
    _floors.clear();
    _areas.clear();
    auto const& chunks = Tables.at("DungeonMapChunk");
    auto const& floors = Tables.at("DungeonMap");
    for (auto id : chunks.Ids())
    {
        auto key = (std::uint64_t(chunks.Number(id, 1)) << 32) | chunks.Number(id, 2);
        _floors[key].emplace_back(chunks.Float(id, 4), floors.Number(chunks.Number(id, 3), 2));
    }
    auto const& areas = Tables.at("WorldMapArea");
    for (auto id : areas.Ids())
        _areas[(std::uint64_t(areas.Number(id, 1)) << 32) | areas.Number(id, 2)] = id;
}

Json Metadata::Catalog() const
{
    Json result = Json::array();
    auto const& continents = Tables.at("WorldMapContinent");
    for (auto id : continents.Ids())
        result.push_back({{"kind", "continents"}, {"data", {{"id", id}, {"map", continents.Number(id, 1)},
            {"grid_left", continents.Number(id, 2)}, {"grid_right", continents.Number(id, 3)},
            {"grid_top", continents.Number(id, 4)}, {"grid_bottom", continents.Number(id, 5)},
            {"offset_x", continents.Float(id, 6)}, {"offset_y", continents.Float(id, 7)},
            {"scale", continents.Float(id, 8)}, {"world_map", continents.Number(id, 13)}}}});
    auto const& areas = Tables.at("WorldMapArea");
    for (auto id : areas.Ids())
        result.push_back({{"kind", "areas"}, {"data", {{"id", id}, {"map", areas.Number(id, 1)},
            {"area", areas.Number(id, 2)}, {"name", areas.Text(id, 3)},
            {"virtual_map", std::bit_cast<std::int32_t>(areas.Number(id, 8))},
            {"dungeon", areas.Number(id, 9) == 0xffffffff ? 0 : areas.Number(id, 9)},
            {"parent", areas.Number(id, 10)},
            {"bounds", Bounds(areas.Float(id, 4), areas.Float(id, 5), areas.Float(id, 6), areas.Float(id, 7))}}}});
    auto const& floors = Tables.at("DungeonMap");
    for (auto id : floors.Ids())
    {
        auto bounds = Bounds(floors.Float(id, 4), floors.Float(id, 3), floors.Float(id, 6), floors.Float(id, 5));
        if (!bounds.is_null())
            result.push_back({{"kind", "floors"}, {"data", {{"id", id}, {"map", floors.Number(id, 1)},
                {"floor", floors.Number(id, 2)}, {"bounds", bounds}, {"parent", floors.Number(id, 7)}}}});
    }
    auto const& transforms = Tables.at("WorldMapTransforms");
    for (auto id : transforms.Ids())
        result.push_back({{"kind", "transforms"}, {"data", {{"id", id}, {"map", transforms.Number(id, 1)},
            {"new_map", transforms.Number(id, 6)}, {"min_x", transforms.Float(id, 2)},
            {"min_y", transforms.Float(id, 3)}, {"max_x", transforms.Float(id, 4)},
            {"max_y", transforms.Float(id, 5)}, {"offset_x", transforms.Float(id, 7)},
            {"offset_y", transforms.Float(id, 8)}, {"dungeon", transforms.Number(id, 9)}}}});
    return result;
}

Json Metadata::WorldMap(std::uint32_t map, std::uint32_t zone) const
{
    auto found = _areas.find((std::uint64_t(map) << 32) | zone);
    if (found == _areas.end())
        found = _areas.find(std::uint64_t(map) << 32);
    return found == _areas.end() ? Json(nullptr) : Json(found->second);
}

Json Metadata::Floor(std::uint32_t map, std::int32_t group, float z) const
{
    float threshold = -std::numeric_limits<float>::infinity();
    Json result = nullptr;
    bool ambiguous = false;
    if (group < 0)
        return result;
    auto found = _floors.find((std::uint64_t(map) << 32) | std::uint32_t(group));
    if (found == _floors.end())
        return result;
    for (auto const& [minZ, floor] : found->second)
    {
        if (!std::isfinite(minZ) || !std::isfinite(z) || minZ > z || minZ < threshold || !floor)
            continue;
        if (minZ > threshold)
        {
            result = floor;
            ambiguous = false;
            threshold = minZ;
        }
        else if (result != floor)
            ambiguous = true;
    }
    return ambiguous ? Json(nullptr) : result;
}
}
