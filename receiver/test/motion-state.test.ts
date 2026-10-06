// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { batch, catalogChunk } from "../examples/fixtures.ts";
import type { PanelView, View } from "../src/schema.ts";
import { Store } from "../src/store.ts";
import { MotionFreshness } from "../src/web/motion-state.js";

function fixture() {
  const store = new Store(() => 0); store.ingestCatalog(catalogChunk()); store.ingest(batch());
  return store.view("realm-1", "Alice")!;
}
const motion = (view: View, sequence: string, stale = false): PanelView =>
  ({ ...view.panels.motion!, sequence, stale });

test("continuous movement stays available regardless of motion/heartbeat delivery order", () => {
  const state = new MotionFreshness(), view = fixture();
  state.observe(view, 0);
  for (let tick = 1; tick <= 100; ++tick) {
    const now = tick * 100, sequence = String(tick * 10);
    if (tick % 2) {
      // The presence event reaches the browser while its cached panel still claims to be fresh.
      view.revisions = { ...view.revisions, motion: sequence };
      expect(state.observe(view, now)).toBe(false);
      expect(state.available(now)).toBe(true);
      view.panels.motion = motion(view, view.panels.motion!.sequence, true);
      expect(state.observe(view, now)).toBe(false);
      expect(state.available(now + 50)).toBe(true);
    }
    view.panels.motion = motion(view, sequence);
    expect(state.observe(view, now)).toBe(true);
    expect(state.available(now + 50)).toBe(true);
    view.revisions = { ...view.revisions, motion: sequence };
    expect(state.observe(view, now + 60)).toBe(true);
  }
});
test("unchanged positions stay confirmed by heartbeats; missing revisions expire despite fresh presence", () => {
  const state = new MotionFreshness(), view = fixture();
  state.observe(view, 0);
  expect(state.observe(view, 60000)).toBe(true);
  expect(state.available(60000)).toBe(true);
  view.revisions = { ...view.revisions, motion: "100" };
  for (const now of [60100, 62000, 64999, 65000]) {
    expect(state.observe(view, now)).toBe(false);
    expect(state.available(now)).toBe(now < 65000);
  }
  view.panels.motion = motion(view, "100", true);
  // The current heartbeat confirms this revision even if its earlier panel event marked it stale.
  expect(state.observe(view, 65100)).toBe(true);
  expect(state.available(65100)).toBe(true);
});
test("initial missing motion and real capture age are not hidden by the grace period", () => {
  const state = new MotionFreshness(), view = fixture();
  const pending = { ...view, panels: {} };
  expect(state.observe(pending, 0)).toBe(false);
  expect(state.available(0)).toBe(false);
  view.age_ms = 4900;
  state.observe(view, 10000);
  expect(state.available(10099)).toBe(true);
  expect(state.available(10100)).toBe(false);
  view.stale = true;
  expect(state.observe(view, 11000)).toBe(false);
  expect(state.available(11000)).toBe(false);
});
test("same-generation SSE snapshots retain position while process and catalogue changes reset it", () => {
  const state = new MotionFreshness(), view = fixture();
  state.observe(view, 0);
  expect(state.observe({ ...view, panels: {} }, 100)).toBe(false);
  expect(state.available(100)).toBe(true);
  for (const identity of [{ process_id: "restart" }, { catalog_revision: "new-catalogue" }, { guid: "Bob" }]) {
    state.observe(view, 200);
    expect(state.observe({ ...view, ...identity, panels: {} }, 300)).toBe(false);
    expect(state.available(300)).toBe(false);
  }
});
test("logout and transfer immediately invalidate motion until the advertised position arrives", () => {
  for (const presence of ["offline", "unavailable"] as const) {
    const state = new MotionFreshness(), view = fixture(); state.observe(view, 0);
    expect(state.observe({ ...view, presence }, 100)).toBe(false);
    expect(state.available(100)).toBe(false);
    view.revisions = { ...view.revisions, motion: "100" };
    expect(state.observe(view, 200)).toBe(false);
    expect(state.available(200)).toBe(false);
    view.panels.motion = motion(view, "100");
    expect(state.observe(view, 250)).toBe(true);
    expect(state.available(250)).toBe(true);
    state.observe(null, 300);
    expect(state.available(300)).toBe(false);
  }
});
