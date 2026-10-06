// SPDX-License-Identifier: GPL-2.0-or-later
#include "MapWidgetObservation.h"
#include "ObjectGuid.h"
#include "Opcodes.h"
#include "WorldPacket.h"
#include <cmath>

namespace MapWidget
{
Json Observe(WorldPacket const& packet)
{
    if (packet.size() > 64 * 1024 || (packet.GetOpcode() != SMSG_GOSSIP_POI &&
        packet.GetOpcode() != SMSG_QUESTGIVER_STATUS && packet.GetOpcode() != SMSG_QUESTGIVER_STATUS_MULTIPLE))
        return Json::object();
    try
    {
        WorldPacket copy(packet);
        copy.rpos(0);
        Json result = Json::object();
        if (copy.GetOpcode() == SMSG_GOSSIP_POI)
        {
            uint32 flags, icon, importance;
            float x, y;
            std::string name;
            copy >> flags >> x >> y >> icon >> importance >> name;
            if (!std::isfinite(x) || !std::isfinite(y) || name.size() > 1024)
                return Json::object();
            result["guard"] = {{"x", x}, {"y", y}, {"name", name}};
        }
        else
        {
            uint32 count = 1;
            if (copy.GetOpcode() == SMSG_QUESTGIVER_STATUS_MULTIPLE)
                copy >> count;
            if (count > 2048)
                return Json::object();
            result["statuses"] = Json::array();
            for (uint32 i = 0; i < count; ++i)
            {
                ObjectGuid guid;
                uint8 status;
                copy >> guid >> status;
                result["statuses"].push_back({{"guid", guid.ToString()}, {"status", status}});
            }
        }
        if (copy.rpos() != copy.size())
            return Json::object();
        static_cast<void>(result.dump());
        return result;
    }
    catch (std::exception const&)
    {
        return Json::object();
    }
}
}
