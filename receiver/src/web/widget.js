// SPDX-License-Identifier: GPL-2.0-or-later
import { resolveObserver, validFollow, SelectionError } from "./follow.js";
import { Maps } from "./render.js";
import { MotionFreshness } from "./motion-state.js";
/** @typedef {import('../schema.ts').View} View */
/** @typedef {import('../schema.ts').Panel} Panel */
const params = new URLSearchParams(location.search);
const follow = params.get("follow") === "watch";
const source = params.get("source"), character = params.get("character");
let guid = params.get("guid");
const mode = params.get("view") || "both";
const status = /** @type {HTMLElement} */ (document.getElementById("connection"));
const maps = new Maps();
const motionFreshness = new MotionFreshness();
document.body.dataset.view = mode;
/** @type {HTMLElement} */ (document.getElementById("mini")).hidden = mode === "map";
/** @type {HTMLElement} */ (document.getElementById("world")).hidden = mode === "minimap";
/** @type {View | null} */ let view = null;
/** @type {EventSource | null} */ let connection = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;
let received = 0, failures = 0, catalogKey = "", catalogLoading = "", nextCatalog = 0, stopped = false;
const sequences = new Map();
async function catalog() {
  if (!view) return;
  const key = `${view.process_id}/${view.catalog_revision}`;
  if (catalogKey === key || catalogLoading || performance.now() < nextCatalog) return;
  catalogLoading = key; nextCatalog = performance.now() + 1000;
  try {
    const query = new URLSearchParams({ source: source ?? "",
      process: view.process_id, revision: view.catalog_revision });
    const r = await fetch(`/api/catalog?${query}`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error("Catalogue unavailable");
    const data = await r.json();
    if (view && `${view.process_id}/${view.catalog_revision}` === key) { maps.setCatalog(data); catalogKey = key; }
  } catch { status.textContent = "Waiting for map catalogue…"; }
  finally { catalogLoading = ""; }
}
function update() {
  const currentMotion = motionFreshness.observe(view, received);
  if (!view) { maps.presence(true, false); return; }
  for (const panel of ["motion", "markers", "quests"]) {
    const record = view.panels[/** @type {Panel} */ (panel)];
    if (!record || (panel === "motion" ? !currentMotion : record.stale) ||
      sequences.get(panel) === record.sequence) continue;
    sequences.set(panel, record.sequence);
    if (panel === "motion") maps.setMotion(/** @type {import('../schema.ts').Motion} */ (record.data));
    if (panel === "markers") maps.markers = /** @type {import('../schema.ts').Markers} */ (record.data).markers;
    if (panel === "quests") maps.setQuests(/** @type {import('../schema.ts').Quests} */ (record.data).quests);
  }
  const limited = [view.panels.markers, view.panels.quests].some(p => p && "truncated" in p.data && p.data.truncated);
  /** @type {HTMLElement} */ (document.getElementById("limits")).textContent =
    limited ? "Some map detail exceeds capture limits." : "";
  void catalog();
}
/** @param {View | null} data */
function snapshot(data) {
  if (!data || !view || view.guid !== data.guid || view.process_id !== data.process_id ||
    view.catalog_revision !== data.catalog_revision) {
    sequences.clear(); maps.markers = []; maps.setQuests([]);
    maps.motion = null; maps.previous = null; maps.frozen = null;
    maps.catalog = null; catalogKey = "";
    maps.follow = true; maps.zoom = 1; maps.pan = { x: 0, y: 0 }; maps.hits = [];
    document.getElementById("tooltip")?.setAttribute("hidden", "");
    const zone = document.getElementById("zone"); if (zone) zone.textContent = "";
    maps.clear();
  }
  view = data; received = performance.now(); update();
}
function schedule() {
  if (stopped) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void connect(); }, Math.min(1000 * 2 ** Math.min(failures++, 4), 10000));
}
async function connect() {
  try {
    guid = await resolveObserver(source, guid, character, follow);
    const query = new URLSearchParams({ source: source || "" });
    if (follow) query.set("follow", "watch");
    query.set(guid ? "guid" : "character", guid || character || "");
    const response = await fetch(`/api/map?${query}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      const data = await response.json(); status.textContent = data.error;
      if ([400, 409].includes(response.status)) { stopped = true; return; }
      throw new Error("Waiting");
    }
    const data = /** @type {View | null} */ (await response.json());
    if (data && !follow) guid = data.guid;
    if (guid) { query.delete("character"); query.set("guid", guid); }
    snapshot(data);
    connection?.close();
    const current = new EventSource(`/api/map/stream?${query}`); connection = current;
    current.onopen = () => { if (connection !== current || stopped) return; failures = 0; };
    current.addEventListener("snapshot", event => {
      if (connection === current && !stopped) snapshot(JSON.parse(event.data));
    });
    current.addEventListener("presence", event => {
      if (connection !== current || stopped) return;
      const data = /** @type {View} */ (JSON.parse(event.data));
      view = { ...data, panels: view?.guid === data.guid ? view.panels : {} }; received = performance.now(); update();
    });
    current.addEventListener("panel", event => {
      if (connection !== current || stopped) return;
      const data = /** @type {import('../schema.ts').PanelView & {panel:Panel}} */ (JSON.parse(event.data));
      if (view) { view.panels[data.panel] = data; update(); }
    });
    current.onerror = () => {
      if (connection !== current || stopped) return;
      current.close(); schedule();
    };
  } catch (error) {
    if (error instanceof SelectionError) {
      status.textContent = error.message;
      if ([400, 409].includes(error.status)) { stopped = true; return; }
    }
    schedule();
  }
}
let last = 0;
/** @param {number} now */
function animate(now) {
  if (now - last >= 33) {
    const stale = !!view && (view.stale || view.age_ms + now - received >= 5000);
    const online = view?.presence === "online";
    const missingMotion = !maps.motion || !motionFreshness.available(now);
    maps.presence(stale || !online || missingMotion, !!online && !missingMotion);
    if (!stopped) status.textContent = !view ? "Waiting for this character…" :
      view.presence === "offline" ? "Character offline" : view.presence === "unavailable" ? "Character changing maps…" :
      stale ? "Stale · waiting for fresh map data" : missingMotion ? "Waiting for position…" : "";
    if (view && !maps.catalog) void catalog();
    maps.draw(); last = now;
  }
  if (!stopped) requestAnimationFrame(animate);
}
if (!validFollow(params) || !source || Boolean(guid) === Boolean(character) ||
  !["minimap", "map", "both"].includes(mode)) {
  status.textContent = "Select /widget?source=realm-1&character=Alice&view=minimap";
} else { void connect(); requestAnimationFrame(animate); }
window.addEventListener("pagehide", () => { stopped = true; connection?.close(); clearTimeout(timer); });
