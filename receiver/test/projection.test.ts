// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { catalog, panelData } from "../examples/fixtures.ts";
import { normalized, project, terrainPoint, interpolate, facingBetween,
  parchmentAsset } from "../src/web/projection.js";
test("provider IDs and Dalaran floor numbering remain distinct from game identifiers", () => {
  const continent = catalog.areas[0]!;
  expect([0, 1, 530, 571].map(map => parchmentAsset({ ...continent, map }, 0)))
    .toEqual(["-3", "-6", "-2", "-5"]);
  const dalaran = catalog.areas.find(a => a.id === 504)!;
  expect(parchmentAsset(dalaran, 1)).toBe("4395-0");
  expect(parchmentAsset(dalaran, 2)).toBe("4395-1");
  expect(parchmentAsset(dalaran, 0)).toBeNull();
  const icc = catalog.areas.find(a => a.id === 604)!;
  expect(parchmentAsset(icc, 1)).toBe("4812-1");
  expect(parchmentAsset(icc, 0)).toBeNull();
});
test("Elwynn projection swaps server axes and preserves north/west orientation", () => {
  const area = catalog.areas.find(a => a.id === 30)!;
  const b = area.bounds!;
  expect(normalized(b.top, b.left, b)).toEqual({ u: 0, v: 0 });
  expect(normalized(b.bottom, b.right, b)).toEqual({ u: 1, v: 1 });
  const p = panelData().motion.player;
  const goldshire = project({ ...p, x: -9465, y: 65 }, area, 0, catalog)!;
  expect(goldshire.u).toBeCloseTo(.4236, 3); expect(goldshire.v).toBeCloseTo(.659, 3);
  expect(normalized(0, 0, { left: 0, right: 0, top: 0, bottom: 0 })).toBeNull();
});
test("physical Outland starting zones transform only on Eastern Kingdoms continent maps", () => {
  const p = { ...panelData().motion.player, map: 530, x: 10000, y: -6500 };
  const zone = project(p, catalog.areas.find(a => a.id === 462)!, 0, catalog)!;
  expect(zone.u).toBeCloseTo(.4086, 3);
  const continent = catalog.areas.find(a => a.id === 14)!;
  expect(project(p, continent, 0, catalog)).toEqual(normalized(7600, -4100, continent.bounds!));
  expect(project({ ...p, x: 1000 }, continent, 0, catalog)).toBeNull();
});
test("Dalaran and ICC use floor bounds and reject known other floors", () => {
  const p = panelData().motion.player;
  const dalaran = catalog.areas.find(a => a.id === 504)!;
  expect(project({ ...p, map: 571, floor: 1, x: 5790, y: 637.5 }, dalaran, 1, catalog)?.u).toBeCloseTo(.5, 3);
  expect(project({ ...p, map: 571 }, dalaran, 0, catalog)).toBeNull();
  const icc = catalog.areas.find(a => a.id === 604)!;
  expect(project({ ...p, map: 631, floor: 1, x: -313.01651, y: 2062.065005 }, icc, 1, catalog)?.v)
    .toBeCloseTo(.5, 5);
  expect(project({ ...p, map: 631, floor: 2 }, icc, 1, catalog)).toBeNull();
});
test("terrain offsets align grid corners and interpolation snaps discontinuities", () => {
  const adt = 1600 / 3;
  expect(terrainPoint((32 - 20) * adt, (32 - 24) * adt, { min_x: 24, min_y: 20 })).toEqual({ x: 0, y: 0 });
  const p = panelData().motion.player;
  expect(interpolate(p, { ...p, x: p.x + 10 }, .5).x).toBe(p.x + 5);
  // A changed movement epoch or transport attachment snaps even a short displacement.
  expect(interpolate(p, { ...p, x: p.x + 10 }, .5, true).x).toBe(p.x + 10);
  expect(interpolate(p, { ...p, x: p.x + 100 }, .5).x).toBe(p.x + 100);
  expect(interpolate(p, { ...p, instance: 42, x: p.x + 10 }, .5).x).toBe(p.x + 10);
  expect(interpolate(p, { ...p, floor: 1, x: p.x + 10 }, .5).floor).toBe(1);
  expect(facingBetween(6.2, .1, .5)).toBeCloseTo(6.29159, 4);
});
