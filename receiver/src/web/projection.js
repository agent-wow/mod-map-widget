// SPDX-License-Identifier: GPL-2.0-or-later
/** @typedef {import('../schema.ts').Position} Position */
/** @typedef {import('../schema.ts').Catalog} Catalog */
/** @typedef {import('../schema.ts').Area} Area */
/** @typedef {import('../schema.ts').Bounds} Bounds */
// Wowhead Wrath maps.js and data/zones (2026-10-06), not game map or DungeonMap IDs.
const CONTINENTS = /** @type {Record<number, number>} */ ({ 0: -3, 1: -6, 530: -2, 571: -5 });
const FLOORS = /** @type {Record<number, number[]>} */ ({
  206: [1, 2, 3], 1196: [1, 2], 3456: [1, 2, 3, 4, 5, 6], 4100: [0, 1], 4196: [1, 2],
  4228: [0, 1, 2, 3, 4], 4264: [1], 4265: [1], 4272: [1, 2], 4273: [0, 1, 2, 3, 4, 5],
  4277: [1, 2, 3], 4395: [0, 1], 4415: [1], 4416: [0, 1], 4494: [1], 4500: [1], 4603: [1],
  4722: [1, 2], 4723: [1], 4809: [1], 4812: [1, 2, 3, 4, 5, 6, 7, 8], 4820: [1],
});
/** @param {Area} area @param {number} floor */
export function parchmentAsset(area, floor) {
  if (!area.area) return !floor && CONTINENTS[area.map] !== undefined ? String(CONTINENTS[area.map]) : null;
  const levels = FLOORS[area.area];
  if (!levels) return floor === 0 ? String(area.area) : null;
  const level = area.area === 4395 ? floor - 1 : floor;
  return levels.includes(level) ? `${area.area}-${level}` : null;
}
/** @param {number} x @param {number} y @param {Bounds} b */
export function normalized(x, y, b) {
  if (![x, y, b.left, b.right, b.top, b.bottom].every(Number.isFinite) ||
    b.left <= b.right || b.top <= b.bottom) return null;
  return { u: (b.left - y) / (b.left - b.right), v: (b.top - x) / (b.top - b.bottom) };
}
/** @param {Position} p @param {Area} area @param {number} floor @param {Catalog} catalog */
export function project(p, area, floor, catalog) {
  let { x, y, map } = p;
  // Relocated starting zones keep physical coordinates on their zone map. Transform only for a continent.
  if (!area.area) {
    const t = catalog.transforms.find(t => t.map === map && t.new_map === area.map &&
      t.new_map !== t.map && x >= t.min_x && x <= t.max_x && y >= t.min_y && y <= t.max_y);
    if (t) { x += t.offset_x; y += t.offset_y; map = t.new_map; }
  }
  if (map !== area.map || (floor > 0 && p.floor !== null && p.floor !== floor)) return null;
  const f = floor > 0 ? catalog.floors.find(f => f.map === area.map && f.floor === floor &&
    (area.dungeon ? f.id === area.dungeon || f.parent === catalog.floors.find(d => d.id === area.dungeon)?.parent
      : true)) : undefined;
  const b = floor > 0 ? f?.bounds : area.bounds;
  return b ? normalized(x, y, b) : null;
}
/** Terrain origin and 512px-per-ADT convention follow Marlamin/map.wow.tools (MIT).
 * @param {number} x @param {number} y @param {{min_x:number,min_y:number}} terrain */
export function terrainPoint(x, y, terrain) {
  const adt = 1600 / 3;
  return { x: (32 - y / adt - terrain.min_x) * 512, y: (32 - x / adt - terrain.min_y) * 512 };
}
/** @param {number} from @param {number} to @param {number} t */
export function facingBetween(from, to, t) {
  const tau = Math.PI * 2;
  const delta = ((to - from + Math.PI) % tau + tau) % tau - Math.PI;
  return from + delta * t;
}
/** @param {Position} a @param {Position} b @param {number} t @param {boolean} [snap] */
export function interpolate(a, b, t, snap = false) {
  if (snap || a.map !== b.map || a.instance !== b.instance || a.phase !== b.phase || a.floor !== b.floor ||
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 40) return b;
  t = Math.max(0, Math.min(1, t));
  return { ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t, facing: facingBetween(a.facing, b.facing, t) };
}
