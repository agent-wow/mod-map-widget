// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_MAP_WIDGET_PROJECTION_H
#define MOD_MAP_WIDGET_PROJECTION_H
#include "MapWidgetMetadata.h"
class Player;
class WorldObject;
namespace MapWidget
{
class Projection
{
public:
    explicit Projection(Metadata const& metadata) : _metadata(metadata) { }
    Json Catalog() const;
    Json Motion(Player* player) const;
    Json Markers(Player* player, Json const& statuses, Json const& guard) const;
    Json Quests(Player* player) const;
    Json Position(WorldObject* object) const;

private:
    Metadata const& _metadata;
};
}
#endif
