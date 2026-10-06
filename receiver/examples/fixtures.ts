// SPDX-License-Identifier: GPL-2.0-or-later
import type { Actor, Batch, Catalog, CatalogChunk, PanelData, PresenceData, Update } from "../src/schema.ts";
import { PANELS } from "../src/schema.ts";
export const catalog: Catalog = {
  continents: [{ id: 1, map: 0, grid_left: 26, grid_right: 44, grid_top: 8, grid_bottom: 60,
    offset_x: 16.875, offset_y: -1.5, scale: .7, world_map: 1 }],
  areas: [
    { id: 14, map: 0, area: 0, name: "Eastern Kingdoms", virtual_map: -1, parent: 0, dungeon: 0,
      bounds: { left: 18171.97, right: -22569.21, top: 11176.34375, bottom: -15973.34375 } },
    { id: 30, map: 0, area: 12, name: "Elwynn Forest", virtual_map: -1, parent: 0, dungeon: 0,
      bounds: { left: 1535.416626, right: -1935.416626, top: -7939.583008, bottom: -10254.166016 } },
    { id: 462, map: 530, area: 3430, name: "Eversong Woods", virtual_map: 0, parent: 0, dungeon: 0,
      bounds: { left: -4487.5, right: -9412.5, top: 11041.666016, bottom: 7758.333008 } },
    { id: 504, map: 571, area: 4395, name: "Dalaran", virtual_map: -1, parent: 510, dungeon: 27, bounds: null },
    { id: 604, map: 631, area: 4812, name: "Icecrown Citadel", virtual_map: -1, parent: 0, dungeon: 0, bounds: null },
  ],
  floors: [
    { id: 27, map: 571, floor: 1, parent: 495,
      bounds: { left: 1052.51, right: 222.495, top: 6066.67, bottom: 5513.33 } },
    { id: 103, map: 631, floor: 1, parent: 492,
      bounds: { left: 2739.80005, right: 1384.32996, top: 138.80701, bottom: -764.84003 } },
    { id: 104, map: 631, floor: 2, parent: 492,
      bounds: { left: 2698, right: 1631, top: -43.3333, bottom: -754.667 } },
  ],
  transforms: [{ id: 2, map: 530, new_map: 0, min_x: 4800, min_y: -10133.333,
    max_x: 16000, max_y: -2666.667, offset_x: -2400, offset_y: 2400, dungeon: 0 }],
};
export function catalogChunk(process = "demo-process"): CatalogChunk {
  return { schema_version: 1, source_id: "realm-1", process_id: process, revision: process,
    chunk_index: 0, chunk_count: 1, entries: [
      ...catalog.areas.map(data => ({ kind: "areas" as const, data })),
      ...catalog.floors.map(data => ({ kind: "floors" as const, data })),
      ...catalog.transforms.map(data => ({ kind: "transforms" as const, data })),
      ...catalog.continents.map(data => ({ kind: "continents" as const, data })),
    ] };
}
export function panelData(tick = 0, name = "Alice"): PanelData {
  const p: Actor = { guid: name, name, kind: "player", map: 0, instance: 0, phase: 1,
    x: -9465 + Math.sin(tick / 30) * 45, y: 65 + Math.cos(tick / 30) * 45, z: 65,
    facing: ((tick / 30) % (Math.PI * 2)), area: 87, zone: 12, floor: null };
  return {
    motion: { player: p, group: [{ ...p, guid: "Bob", name: "Bob", kind: "group", x: -9440, y: 50 }],
      corpse: null, zone_name: "Elwynn Forest", area_name: "Goldshire", world_map: 30,
      indoors: false, transport: false, movement_epoch: 0 },
    markers: { markers: [
      { ...p, id: "inn", name: "Lion's Pride Inn", kind: "inn", status: 0, x: -9460, y: 20 },
      { ...p, id: "quest", name: "Marshal Dughan", kind: "quest", status: 8, x: -9438, y: 52 },
      { ...p, id: "mail", name: "Mailbox", kind: "mail", status: 0, x: -9445, y: 75 },
      { ...p, id: "herb", name: "Peacebloom", kind: "herb", status: 0, x: -9500, y: 110 },
    ], truncated: false },
    quests: { quests: [{ id: 7, name: "Kobold Camp Cleanup", status: "incomplete", pois: [
      { id: 0, objective: 0, map: 0, world_map: 30, floor: 0, points: [
        { x: -9350, y: 50 }, { x: -9250, y: 90 }, { x: -9310, y: 160 },
      ] },
    ], objectives_text: "Defeat the kobolds near Northshire.",
    objectives: [{ text: "Kobold Vermin", value: 2, max: 10 }] }], truncated: false },
  };
}
export function batch(sequence = 1, name = "Alice", tick = 0, process = "demo-process"): Batch {
  const data = panelData(tick, name);
  const updates: Update[] = PANELS.map((panel, i) => ({ guid: name, name, panel,
    sequence: String(sequence + i), age_ms: 0, catalog_revision: process, data: data[panel] }));
  const presence: PresenceData = { presence: "online",
    revisions: Object.fromEntries(updates.map(u => [u.panel, u.sequence])) };
  updates.push({ guid: name, name, panel: "presence", sequence: String(sequence + 3), age_ms: 0,
    catalog_revision: process, data: presence });
  return { schema_version: 1, source_id: "realm-1", process_id: process, updates };
}
