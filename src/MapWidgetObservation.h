// SPDX-License-Identifier: GPL-2.0-or-later
#ifndef MOD_MAP_WIDGET_OBSERVATION_H
#define MOD_MAP_WIDGET_OBSERVATION_H
#include "MapWidgetState.h"
class WorldPacket;
namespace MapWidget
{
// Empty object for unrelated or invalid packets. Never modifies the supplied packet's read cursor.
Json Observe(WorldPacket const& packet);
}
#endif
