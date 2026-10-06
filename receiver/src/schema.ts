// SPDX-License-Identifier: GPL-2.0-or-later
export const STALE_MS = 5000;
export const MAX_PANEL_BYTES = 2 * 1024 * 1024;
export const PANELS = ["motion", "markers", "quests"] as const;
export type Panel = typeof PANELS[number];
export type Presence = "online" | "offline" | "unavailable";
export interface Position {
  map: number; instance: number; phase: number; x: number; y: number; z: number; facing: number;
  area: number; zone: number; floor: number | null;
}
export interface Actor extends Position { guid: string; name: string; kind: "player" | "group" | "corpse" }
export interface Motion {
  player: Actor; group: Actor[]; corpse: Actor | null; zone_name: string; area_name: string;
  world_map: number | null; indoors: boolean; transport: boolean; movement_epoch: number;
}
export const MARKER_KINDS = ["vendor", "repair", "trainer", "flight", "bank", "inn", "auction",
  "mail", "quest", "herb", "ore", "fish", "resource", "creature", "guard"] as const;
export type MarkerKind = typeof MARKER_KINDS[number];
export interface Marker extends Position { id: string; name: string; kind: MarkerKind; status: number }
export interface Markers { markers: Marker[]; truncated: boolean }
export interface QuestPOI {
  id: number; objective: number; map: number; world_map: number; floor: number;
  points: { x: number; y: number }[];
}
export interface Quest {
  id: number; name: string; status: "incomplete" | "complete" | "failed"; pois: QuestPOI[];
  objectives_text: string; objectives: { text: string; value: number; max: number }[];
}
export interface Quests { quests: Quest[]; truncated: boolean }
export interface PanelData { motion: Motion; markers: Markers; quests: Quests }
export interface PresenceData { presence: Presence; revisions?: Partial<Record<Panel, string>> }
export interface Update {
  guid: string; name: string; panel: Panel | "presence"; sequence: string; age_ms: number;
  catalog_revision: string; data: PanelData[Panel] | PresenceData;
}
export interface Batch { schema_version: 1; source_id: string; process_id: string; updates: Update[] }
// Bounds use server coordinates: horizontal = Y, vertical = X, both decreasing across the image.
export interface Bounds { left: number; right: number; top: number; bottom: number }
export interface Area {
  id: number; map: number; area: number; name: string; virtual_map: number; parent: number;
  dungeon: number; bounds: Bounds | null;
}
export interface Floor { id: number; map: number; floor: number; bounds: Bounds; parent: number }
export interface Transform {
  id: number; map: number; new_map: number; min_x: number; min_y: number; max_x: number; max_y: number;
  offset_x: number; offset_y: number; dungeon: number;
}
export interface Continent {
  id: number; map: number; grid_left: number; grid_right: number; grid_top: number; grid_bottom: number;
  offset_x: number; offset_y: number; scale: number; world_map: number;
}
export interface Catalog { areas: Area[]; floors: Floor[]; transforms: Transform[]; continents: Continent[] }
export type CatalogEntry = { [K in keyof Catalog]: { kind: K; data: Catalog[K][number] } }[keyof Catalog];
export interface CatalogChunk {
  schema_version: 1; source_id: string; process_id: string; revision: string;
  chunk_index: number; chunk_count: number; entries: CatalogEntry[];
}
export interface PanelView { sequence: string; age_ms: number; stale: boolean; data: PanelData[Panel] }
export interface View {
  source_id: string; process_id: string; guid: string; name: string; presence: Presence;
  stale: boolean; age_ms: number; catalog_revision: string; sequence: string;
  revisions?: Partial<Record<Panel, string>>;
  panels: Partial<Record<Panel, PanelView>>;
}
type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 1024): v is string => typeof v === "string" && v.length <= max;
const identity = (v: unknown): v is string => text(v, 256) && v.length > 0;
const num = (v: unknown, min = -1e6, max = 1e6): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const int = (v: unknown, min = 0, max = 0xffffffff): v is number => num(v, min, max) && Number.isInteger(v);
const list = (v: unknown, check: (v: unknown) => boolean, max: number): v is unknown[] =>
  Array.isArray(v) && v.length <= max && v.every(check);
const unique = (v: unknown[], field: string) => new Set(v.map(x => (x as Obj)[field])).size === v.length;
export const sequence = (v: unknown): v is string => typeof v === "string" &&
  /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n;
const revision = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(v);
function position(v: unknown): v is Obj {
  return object(v) && int(v.map) && int(v.instance) && int(v.phase) && num(v.x) && num(v.y) && num(v.z) &&
    num(v.facing, 0, Math.PI * 2) && int(v.area) && int(v.zone) && (v.floor === null || int(v.floor, 0, 255));
}
function actor(v: unknown): boolean {
  return position(v) && identity(v.guid) && text(v.name) && ["player", "group", "corpse"].includes(v.kind as string);
}
function marker(v: unknown): boolean {
  return position(v) && identity(v.id) && text(v.name) && MARKER_KINDS.includes(v.kind as MarkerKind) && int(v.status);
}
function quest(v: unknown): boolean {
  return object(v) && int(v.id, 1) && text(v.name) &&
    ["incomplete", "complete", "failed"].includes(v.status as string) &&
    text(v.objectives_text, 16384) && list(v.objectives, o => object(o) && text(o.text) &&
      int(o.value) && int(o.max), 16) &&
    list(v.pois, p => object(p) && int(p.id) && int(p.objective, -1, 255) && int(p.map) && int(p.world_map) &&
      int(p.floor, 0, 255) && list(p.points, p => object(p) && num(p.x) && num(p.y), 4096), 64) && unique(v.pois, "id");
}
export function isPanelData(panel: Panel, v: unknown): boolean {
  if (!object(v)) return false;
  switch (panel) {
    case "motion": return actor(v.player) && (v.player as Actor).kind === "player" &&
      list(v.group, a => actor(a) && (a as Actor).kind === "group", 39) && unique(v.group, "guid") &&
      (v.corpse === null || (actor(v.corpse) && (v.corpse as Actor).kind === "corpse")) &&
      text(v.zone_name) && text(v.area_name) &&
      (v.world_map === null || int(v.world_map, 1)) && typeof v.indoors === "boolean" &&
      typeof v.transport === "boolean" && int(v.movement_epoch);
    case "markers": return list(v.markers, marker, 512) && unique(v.markers, "id") &&
      typeof v.truncated === "boolean";
    case "quests": return list(v.quests, quest, 25) && unique(v.quests, "id") && typeof v.truncated === "boolean";
  }
}
function update(v: unknown): boolean {
  if (!object(v) || !identity(v.guid) || !identity(v.name) || !sequence(v.sequence) ||
    !int(v.age_ms, 0, 86400000) || !revision(v.catalog_revision)) return false;
  if (v.panel === "presence") {
    if (!object(v.data) || !["online", "offline", "unavailable"].includes(v.data.presence as string)) return false;
    const r = v.data.revisions;
    return v.data.presence !== "online" || (object(r) && PANELS.every(p => sequence(r[p])));
  }
  return PANELS.includes(v.panel as Panel) && isPanelData(v.panel as Panel, v.data) &&
    new TextEncoder().encode(JSON.stringify(v)).length <= MAX_PANEL_BYTES;
}
export function isBatch(v: unknown): v is Batch {
  return object(v) && v.schema_version === 1 && identity(v.source_id) && revision(v.process_id) &&
    list(v.updates, update, 100);
}
function bounds(v: unknown): boolean {
  return object(v) && num(v.left) && num(v.right) && num(v.top) && num(v.bottom) &&
    v.left > v.right && v.top > v.bottom;
}
function catalogEntry(v: unknown): boolean {
  if (!object(v) || !object(v.data) || !int(v.data.id, 1) || !int(v.data.map)) return false;
  const d = v.data;
  switch (v.kind) {
    case "continents": return int(d.grid_left, 0, 64) && int(d.grid_right, 0, 64) &&
      int(d.grid_top, 0, 64) && int(d.grid_bottom, 0, 64) && num(d.offset_x) && num(d.offset_y) &&
      num(d.scale, .001, 1000) && int(d.world_map);
    case "areas": return int(d.area) && text(d.name) && int(d.virtual_map, -1) && int(d.parent) &&
      int(d.dungeon) && (d.bounds === null || bounds(d.bounds));
    case "floors": return int(d.floor, 0, 255) && bounds(d.bounds) && int(d.parent);
    case "transforms": return int(d.new_map) && num(d.min_x) && num(d.min_y) && num(d.max_x) &&
      num(d.max_y) && d.max_x > d.min_x && d.max_y > d.min_y && num(d.offset_x) && num(d.offset_y) &&
      int(d.dungeon);
    default: return false;
  }
}
export function isCatalogChunk(v: unknown): v is CatalogChunk {
  return object(v) && v.schema_version === 1 && identity(v.source_id) && revision(v.process_id) &&
    revision(v.revision) && int(v.chunk_count, 1, 64) && int(v.chunk_index, 0, v.chunk_count - 1) &&
    list(v.entries, catalogEntry, 5000);
}
