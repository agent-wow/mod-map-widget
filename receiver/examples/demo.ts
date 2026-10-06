// SPDX-License-Identifier: GPL-2.0-or-later
import { batch, catalogChunk } from "./fixtures.ts";
const endpoint = process.env.MAP_WIDGET_DEMO_ENDPOINT ?? "http://127.0.0.1:3003/maps";
const token = process.env.MAP_WIDGET_BEARER_TOKEN;
const splitUpdates = process.env.MAP_WIDGET_DEMO_SPLIT_UPDATES === "1";
const processId = crypto.randomUUID();
const demoBatch = (sequence: number, name: string, tick = 0) => batch(sequence, name, tick, processId);
const post = (url: string, data: unknown) => fetch(url, { method: "POST", headers: {
  "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
}, body: JSON.stringify(data) });
const catalogURL = endpoint.replace(/\/maps$/, "/catalogs");
await post(catalogURL, catalogChunk(processId));
console.error("Synthetic map demo: Alice, Offline, Dungeon, Unknown, and A very long character name for layout checks");
for (let tick = 0; ; ++tick) {
  const current = demoBatch(tick * 100 + 1, "Alice", tick);
  const long = demoBatch(tick * 100 + 10, "A very long character name for layout checks", tick);
  const longMotion = long.updates[0]!.data as ReturnType<typeof import("./fixtures.ts").panelData>["motion"];
  longMotion.area_name = "A very long zone and subzone label for OBS layout checks";
  const offline = demoBatch(tick * 100 + 20, "Offline");
  offline.updates.at(-1)!.data = { presence: "offline" };
  if (tick) offline.updates = [offline.updates.at(-1)!];
  const dungeon = demoBatch(tick * 100 + 30, "Dungeon");
  const motion = dungeon.updates[0]!.data as ReturnType<typeof import("./fixtures.ts").panelData>["motion"];
  Object.assign(motion.player, { map: 631, instance: 42, zone: 4812, area: 4812, x: -400, y: 2200, floor: 1 });
  Object.assign(motion, { world_map: 604, indoors: true, group: [],
    zone_name: "Icecrown Citadel", area_name: "The Lower Spire" });
  const unknown = demoBatch(tick * 100 + 40, "Unknown");
  const missing = unknown.updates[0]!.data as typeof motion;
  missing.player.map = 99999; missing.world_map = null; missing.area_name = "Uncharted territory";
  current.updates.push(...long.updates, ...offline.updates, ...dungeon.updates, ...unknown.updates);
  try {
    const parts = splitUpdates ? [
      current.updates.filter(u => u.panel !== "presence"),
      current.updates.filter(u => u.panel === "presence"),
    ] : [current.updates];
    if (tick % 2) parts.reverse();
    const capturedAt = performance.now();
    for (let i = 0; i < parts.length; ++i) {
      const updates = parts[i]!;
      updates.forEach(u => { u.age_ms = Math.round(performance.now() - capturedAt); });
      const r = await post(endpoint, { ...current, updates });
      if (r.status === 409) await post(catalogURL, catalogChunk(processId));
      else if (!r.ok) console.error(`Demo update rejected: ${r.status}`);
      if (i < parts.length - 1) await Bun.sleep(50);
    }
  } catch { console.error("Demo receiver unavailable; retrying"); }
  await Bun.sleep(splitUpdates ? 50 : 100);
}
