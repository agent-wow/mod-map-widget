// SPDX-License-Identifier: GPL-2.0-or-later
#include "MapWidgetObservation.h"
#include "ObjectGuid.h"
#include "Opcodes.h"
#include "WorldPacket.h"
#include <gtest/gtest.h>

TEST(MapWidgetObservation, CopiesSingleAndMultipleStatusesWithoutChangingPacketCursor)
{
    ObjectGuid guid = ObjectGuid::Create<HighGuid::Player>(123);
    WorldPacket single(SMSG_QUESTGIVER_STATUS);
    single << guid << uint8(8);
    auto result = MapWidget::Observe(single);
    EXPECT_EQ(single.rpos(), 0);
    EXPECT_EQ(result["statuses"][0]["guid"], guid.ToString());
    EXPECT_EQ(result["statuses"][0]["status"], 8);
    WorldPacket multiple(SMSG_QUESTGIVER_STATUS_MULTIPLE);
    multiple << uint32(1) << guid << uint8(10);
    EXPECT_EQ(MapWidget::Observe(multiple)["statuses"][0]["status"], 10);
    multiple << uint8(0);
    EXPECT_TRUE(MapWidget::Observe(multiple).empty());
}

TEST(MapWidgetObservation, CapturesGuardCoordinatesAndRejectsMalformedPackets)
{
    WorldPacket poi(SMSG_GOSSIP_POI);
    poi << uint32(0) << float(-9000) << float(500) << uint32(6) << uint32(0) << std::string("Bank");
    auto data = MapWidget::Observe(poi);
    EXPECT_EQ(data["guard"]["name"], "Bank");
    EXPECT_EQ(data["guard"]["x"], -9000);
    WorldPacket truncated(SMSG_QUESTGIVER_STATUS);
    truncated << uint8(1);
    EXPECT_TRUE(MapWidget::Observe(truncated).empty());
    WorldPacket excessive(SMSG_QUESTGIVER_STATUS_MULTIPLE);
    excessive << uint32(100000);
    EXPECT_TRUE(MapWidget::Observe(excessive).empty());
}
