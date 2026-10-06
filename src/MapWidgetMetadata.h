// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_MAP_WIDGET_METADATA_H
#define MOD_MAP_WIDGET_METADATA_H

#include "MapWidgetState.h"
#include <filesystem>
#include <optional>

namespace MapWidget
{
class DbcTable
{
public:
    bool Load(std::filesystem::path const& path, std::uint32_t fields);
    std::uint32_t Number(std::uint32_t id, std::uint32_t field) const;
    float Float(std::uint32_t id, std::uint32_t field) const;
    std::string Text(std::uint32_t id, std::uint32_t field) const;
    std::vector<std::uint32_t> const& Ids() const { return _ids; }

private:
    std::vector<unsigned char> _bytes;
    std::unordered_map<std::uint32_t, std::size_t> _rows;
    std::vector<std::uint32_t> _ids;
    std::size_t _strings = 0;
    std::uint32_t _fields = 0;
};

Json Bounds(float left, float right, float top, float bottom);
bool SameSpace(std::uint32_t map, std::uint32_t instance, std::uint32_t phase,
    std::uint32_t otherMap, std::uint32_t otherInstance, std::uint32_t otherPhase);
bool Tracked(std::uint32_t mask, std::uint32_t type);

class Metadata
{
public:
    void Load(std::filesystem::path const& path);
    Json Catalog() const;
    Json WorldMap(std::uint32_t map, std::uint32_t zone) const;
    Json Floor(std::uint32_t map, std::int32_t group, float z) const;
    std::unordered_map<std::string, DbcTable> Tables;

private:
    std::unordered_map<std::uint64_t, std::vector<std::pair<float, std::uint32_t>>> _floors;
    std::unordered_map<std::uint64_t, std::uint32_t> _areas;
};
}
#endif
