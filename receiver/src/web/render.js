// SPDX-License-Identifier: GPL-2.0-or-later
import { project, terrainPoint, interpolate, normalized, parchmentAsset } from "./projection.js";
/** @typedef {import('../schema.ts').Catalog} Catalog */
/** @typedef {import('../schema.ts').Motion} Motion */
/** @typedef {import('../schema.ts').Position} Position */
/** @typedef {import('../schema.ts').Area} Area */
/** @typedef {import('../schema.ts').Marker} Marker */
/** @typedef {import('../artwork.ts').Terrain} Terrain */
const colors = { player: "#fff1a0", group: "#75d9ff", corpse: "#c8ccd0", quest: "#ffd147", guard: "#ed6560",
  vendor: "#e4ce94", repair: "#e4ce94", trainer: "#e4ce94", flight: "#8be89a", bank: "#e4ce94", inn: "#e4ce94",
  auction: "#e4ce94", mail: "#f5eee0", herb: "#67df79", ore: "#ffd45c", fish: "#75d9ff",
  resource: "#edba45", creature: "#edba45" };
const symbols = { vendor: "●", repair: "⚒", trainer: "◆", flight: "✦", bank: "▣", inn: "⌂", auction: "◆",
  mail: "✉", quest: "!", guard: "⚑", herb: "✿", ore: "◆", fish: "≈", resource: "◆",
  creature: "●", group: "●", corpse: "✝", player: "▲" };
export const FILTERS = Object.keys(symbols).filter(k => k !== "player");
/** @param {string} id */
const el = id => /** @type {HTMLElement} */ (document.getElementById(id));
export class Maps {
  /** @type {Catalog | null} */ catalog = null;
  /** @type {Motion | null} */ motion = null;
  /** @type {Position | null} */ previous = null;
  /** @type {Position | null} */ frozen = null;
  /** @type {Marker[]} */ markers = [];
  /** @type {import('../schema.ts').Quest[]} */ quests = [];
  /** @type {Terrain | null} */ terrain = null;
  /** @type {Map<string, {image:HTMLImageElement,failed:number}>} */ images = new Map();
  /** @type {{x:number,y:number,name:string,canvas:HTMLCanvasElement}[]} */ hits = [];
  /** @type {Set<string>} */ filters = new Set(FILTERS);
  /** @type {Set<number>} */ hiddenQuests = new Set();
  map = 0;
  floor = 0;
  follow = true;
  zoom = 1;
  pan = { x: 0, y: 0 };
  miniZoom = 2;
  inactive = true;
  live = false;
  received = 0;
  terrainKey = -1;
  nextTerrain = 0;
  snap = false;
  constructor() {
    this.mini = /** @type {HTMLCanvasElement} */ (el("mini-canvas"));
    this.world = /** @type {HTMLCanvasElement} */ (el("world-canvas"));
    this.select = /** @type {HTMLSelectElement} */ (el("map-select"));
    this.floors = /** @type {HTMLSelectElement} */ (el("floor-select"));
    this.select.onchange = () => {
      this.map = Number(this.select.value); this.floor = 0; this.browse(); this.floorOptions();
    };
    this.floors.onchange = () => { this.floor = Number(this.floors.value); this.browse(); };
    el("follow").onclick = () => { this.follow = true; this.zoom = 1; this.pan = { x: 0, y: 0 }; this.followPlayer(); };
    el("world-in").onclick = () => this.scale(1.25);
    el("world-out").onclick = () => this.scale(.8);
    el("mini-in").onclick = () => { this.miniZoom = Math.min(5, this.miniZoom + 1); };
    el("mini-out").onclick = () => { this.miniZoom = Math.max(0, this.miniZoom - 1); };
    this.world.onwheel = e => { e.preventDefault(); this.scale(e.deltaY < 0 ? 1.15 : 1 / 1.15); };
    /** @type {{x:number,y:number} | null} */ let drag = null;
    this.world.onpointerdown = e => {
      drag = { x: e.clientX, y: e.clientY }; this.follow = false; this.world.setPointerCapture(e.pointerId);
    };
    this.world.onpointerup = () => { drag = null; };
    this.world.onpointercancel = () => { drag = null; };
    this.world.onpointermove = e => {
      if (drag) { this.pan.x += e.clientX - drag.x; this.pan.y += e.clientY - drag.y;
        drag = { x: e.clientX, y: e.clientY }; } else this.tooltip(e, this.world);
    };
    this.mini.onpointermove = e => this.tooltip(e, this.mini);
    for (const canvas of [this.mini, this.world]) canvas.onpointerleave = () => { el("tooltip").hidden = true; };
    for (const kind of FILTERS) {
      const label = document.createElement("label"), input = document.createElement("input");
      input.type = "checkbox"; input.checked = true;
      input.onchange = () => { if (input.checked) this.filters.add(kind); else this.filters.delete(kind); };
      label.append(input, ` ${kind[0]?.toUpperCase()}${kind.slice(1)}`); el("filters").append(label);
    }
  }
  /** @param {PointerEvent} e @param {HTMLCanvasElement} canvas */
  tooltip(e, canvas) {
    const b = canvas.getBoundingClientRect();
    const hit = this.hits.find(h => h.canvas === canvas &&
      Math.hypot(e.clientX - b.left - h.x, e.clientY - b.top - h.y) < 13);
    const tip = el("tooltip"); tip.hidden = !hit;
    if (hit) {
      tip.textContent = hit.name;
      tip.style.left = `${Math.max(0, Math.min(innerWidth - 265, e.clientX + 12))}px`;
      tip.style.top = `${Math.max(0, Math.min(innerHeight - 50, e.clientY + 12))}px`; }
  }
  browse() { this.follow = false; this.zoom = 1; this.pan = { x: 0, y: 0 }; }
  /** @param {number} factor */
  scale(factor) { this.follow = false; this.zoom = Math.max(1, Math.min(8, this.zoom * factor));
    if (this.zoom === 1) this.pan = { x: 0, y: 0 }; }
  /** @param {Catalog} catalog */
  setCatalog(catalog) {
    this.catalog = catalog;
    this.select.replaceChildren();
    for (const group of ["Continents", "Zones & instances"]) {
      const optgroup = document.createElement("optgroup"); optgroup.label = group;
      for (const area of catalog.areas.filter(a => Boolean(a.area) === (group !== "Continents"))
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const option = new Option(area.name, String(area.id)); optgroup.append(option);
      }
      this.select.append(optgroup);
    }
    this.followPlayer(); this.floorOptions();
  }
  /** @param {Motion} motion */
  setMotion(motion) {
    const snap = !!this.motion && (this.motion.movement_epoch !== motion.movement_epoch ||
      this.motion.transport !== motion.transport);
    this.previous = this.position() ?? motion.player; this.motion = motion; this.received = performance.now();
    this.snap = snap;
    el("zone").textContent = motion.area_name || motion.zone_name;
    if (motion.player.map !== this.terrainKey) {
      this.terrainKey = motion.player.map; this.terrain = null; this.nextTerrain = 0;
    }
    this.followPlayer();
  }
  followPlayer() {
    if (!this.follow || !this.motion || !this.catalog) return;
    const next = this.motion.world_map ?? 0;
    const floor = this.motion.player.floor ?? 0;
    if (next !== this.map || floor !== this.floor) { this.map = next; this.floor = floor; this.floorOptions(); }
    this.select.value = String(this.map);
  }
  floorOptions() {
    const area = this.catalog?.areas.find(a => a.id === this.map);
    const options = this.catalog?.floors.filter(f => f.map === area?.map &&
      (!area?.dungeon || f.parent === this.catalog?.floors.find(d => d.id === area.dungeon)?.parent)) ?? [];
    this.floors.replaceChildren(new Option("Surface", "0"));
    for (const floor of options) this.floors.append(new Option(`Floor ${floor.floor}`, String(floor.floor)));
    this.floors.value = String(this.floor);
  }
  /** @param {import('../schema.ts').Quest[]} quests */
  setQuests(quests) {
    this.quests = quests; el("quest-list").replaceChildren();
    for (const quest of quests) {
      const input = document.createElement("input"), label = document.createElement("label");
      input.type = "checkbox"; input.checked = !this.hiddenQuests.has(quest.id);
      input.onchange = () => {
        if (input.checked) this.hiddenQuests.delete(quest.id); else this.hiddenQuests.add(quest.id);
      };
      label.append(input, ` ${quest.status === "complete" ? "✓ " : ""}${quest.name}`); el("quest-list").append(label);
      label.title = [quest.objectives_text, ...quest.objectives.map(o => `${o.text}: ${o.value}/${o.max}`)].join("\n");
    }
  }
  /** @param {boolean} inactive @param {boolean} live */
  presence(inactive, live) {
    if (inactive && !this.inactive) this.frozen = this.position();
    this.inactive = inactive; this.live = live;
    el("widget").classList.toggle("inactive", inactive);
  }
  position() {
    if (!this.motion) return null;
    if (this.inactive && this.frozen) return this.frozen;
    return this.previous ? interpolate(this.previous, this.motion.player,
      (performance.now() - this.received) / 100, this.snap)
      : this.motion.player;
  }
  /** @param {string} url */
  image(url) {
    let entry = this.images.get(url);
    if (entry?.failed && performance.now() - entry.failed > 60000) { this.images.delete(url); entry = undefined; }
    if (!entry) {
      const image = new Image(); entry = { image, failed: 0 };
      const record = entry;
      image.onerror = () => { record.failed = performance.now(); };
      image.src = url;
      if (this.images.size >= 256) this.images.delete(this.images.keys().next().value ?? "");
      this.images.set(url, entry);
    }
    return entry.image.complete && entry.image.naturalWidth ? entry.image : null;
  }
  /** @param {HTMLCanvasElement} canvas */
  context(canvas) {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    }
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }
  /** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y
   * @param {string} kind @param {string} name @param {number} facing @param {HTMLCanvasElement} canvas
   * @param {string | undefined} [glyph] */
  pin(ctx, x, y, kind, name, facing, canvas, glyph) {
    if (kind !== "player" && !this.filters.has(kind)) return;
    ctx.save(); ctx.translate(x, y); ctx.shadowColor = "#000"; ctx.shadowBlur = 3;
    ctx.strokeStyle = "#111"; ctx.lineWidth = 3;
    ctx.fillStyle = colors[/** @type {keyof typeof colors} */ (kind)] ?? "#fff";
    if (kind === "player") {
      ctx.rotate(-facing); ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 7);
      ctx.lineTo(0, 3); ctx.lineTo(-7, 7); ctx.closePath(); ctx.stroke(); ctx.fill();
    } else {
      ctx.font = "bold 15px Georgia"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const symbol = glyph ?? symbols[/** @type {keyof typeof symbols} */ (kind)] ?? "●";
      ctx.strokeText(symbol, 0, 0); ctx.fillText(symbol, 0, 0);
    }
    ctx.restore(); this.hits.push({ x, y, name, canvas });
  }
  /** @param {Position} position */
  actors(position) {
    if (!this.live || !this.motion) return [];
    const local = [...this.markers, ...this.motion.group].filter(a => a.map === position.map &&
      a.instance === position.instance && (a.phase & position.phase) &&
      (a.floor === null || position.floor === null || a.floor === position.floor));
    return [...local, ...(this.motion.corpse ? [this.motion.corpse] : []),
      { ...this.motion.player, ...position }];
  }
  async getTerrain() {
    const key = this.terrainKey;
    this.nextTerrain = performance.now() + 60000;
    try {
      const r = await fetch(`/api/terrain?map=${key}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok && key === this.terrainKey) this.terrain = await r.json();
    } catch { /* Retry on the next interval, while retaining any previous terrain. */ }
  }
  draw() {
    this.hits = [];
    const p = this.position();
    el("follow").classList.toggle("active", this.follow);
    if (!this.catalog) return;
    if (p && this.motion && !el("mini").hidden) {
      if (performance.now() >= this.nextTerrain) void this.getTerrain();
      this.drawMini(p);
    }
    if (!el("world").hidden) this.drawWorld(p);
  }
  clear() {
    for (const canvas of [this.mini, this.world]) {
      const { ctx, width, height } = this.context(canvas);
      ctx.clearRect(0, 0, width, height);
    }
  }
  /** @param {Position} p */
  drawMini(p) {
    const { ctx, width, height } = this.context(this.mini);
    const radius = Math.min(width, height) / 2;
    const range = [200, 160, 120, 100, 80, 60][this.miniZoom] ?? 120;
    const scale = radius / range;
    const t = this.terrain;
    ctx.save(); ctx.beginPath(); ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2); ctx.clip();
    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2, height / 2);
    let loaded = false;
    // Hosted terrain has no separate indoor WMO layers. Do not show roof imagery as a correct interior.
    if (t && !this.motion?.indoors) {
      const origin = terrainPoint(p.x, p.y, t);
      const nativeScale = scale * (1600 / 3) / 512;
      const z = Math.max(0, Math.min(t.max_zoom, t.max_zoom + Math.floor(Math.log2(nativeScale))));
      const down = 2 ** (t.max_zoom - z), span = 256 * down;
      const reach = radius * 1.5 / nativeScale;
      for (let y = Math.max(0, Math.floor((origin.y - reach) / span));
        y <= Math.min(Math.ceil(t.height / span) - 1, Math.floor((origin.y + reach) / span)); ++y) {
        for (let x = Math.max(0, Math.floor((origin.x - reach) / span));
          x <= Math.min(Math.ceil(t.width / span) - 1, Math.floor((origin.x + reach) / span)); ++x) {
          const image = this.image(`/assets/terrain/${t.map}/${t.hash}/${z}/${y}/${x}.png`);
          if (image) { loaded = true; ctx.drawImage(image, (x * span - origin.x) * nativeScale,
            (y * span - origin.y) * nativeScale, span * nativeScale + .5, span * nativeScale + .5); }
        }
      }
    }
    ctx.restore();
    el("terrain-status").textContent = this.motion?.indoors ? "Indoor terrain unavailable" :
      loaded ? "" : "Terrain unavailable / loading";
    if (loaded && this.live && this.filters.has("quest")) for (const quest of this.quests) {
      if (this.hiddenQuests.has(quest.id) || quest.status === "failed") continue;
      for (const poi of quest.pois) {
        if (poi.map !== p.map || (poi.floor && poi.floor !== p.floor) || !poi.points.length ||
          (poi.objective === -1) !== (quest.status === "complete")) continue;
        const x = -(poi.points.reduce((sum, point) => sum + point.y, 0) / poi.points.length - p.y) * scale;
        const y = -(poi.points.reduce((sum, point) => sum + point.x, 0) / poi.points.length - p.x) * scale;
        if (Math.hypot(x, y) < radius - 9) this.pin(ctx, width / 2 + x, height / 2 + y,
          "quest", quest.name, 0, this.mini, quest.status === "complete" ? "?" : "!");
      }
    }
    if (loaded) for (const actor of this.actors(p)) {
      if (actor.map !== p.map || actor.instance !== p.instance || !(actor.phase & p.phase)) continue;
      const x = -(actor.y - p.y) * scale, y = -(actor.x - p.x) * scale;
      if (Math.hypot(x, y) < radius - 9) this.pin(ctx, width / 2 + x, height / 2 + y,
        actor.kind, actor.name, actor.facing, this.mini,
        actor.kind === "quest" && "status" in actor && [3, 5, 6, 9, 10].includes(actor.status) ? "?" : undefined);
    }
    ctx.save(); ctx.fillStyle = "#ffe6a3"; ctx.font = "bold 13px Georgia"; ctx.textAlign = "center";
    ctx.shadowBlur = 3; ctx.shadowColor = "#000";
    ctx.fillText("N", width / 2, height / 2 - radius + 16);
    ctx.restore();
    const area = this.catalog?.areas.find(a => a.id === this.motion?.world_map);
    const pos = area?.bounds ? normalized(p.x, p.y, area.bounds) : null;
    el("coords").textContent = pos ? `${(pos.u * 100).toFixed(1)}, ${(pos.v * 100).toFixed(1)}` : "—";
  }
  /** @param {Position | null} p */
  drawWorld(p) {
    const { ctx, width, height } = this.context(this.world);
    ctx.clearRect(0, 0, width, height);
    const catalog = this.catalog;
    const area = catalog?.areas.find(a => a.id === this.map);
    if (!area || !catalog) { el("art-status").textContent = "No map available for this location"; return; }
    const asset = parchmentAsset(area, this.floor);
    const image = asset === null ? null : this.image(`/assets/world/${asset}.jpg`);
    const w = Math.min(width, height * 1.5) * this.zoom, h = w / 1.5;
    const left = (width - w) / 2 + this.pan.x, top = (height - h) / 2 + this.pan.y;
    if (image) ctx.drawImage(image, left, top, w, h);
    const bounds = this.floor ? catalog.floors.some(f => f.map === area.map && f.floor === this.floor) : area.bounds;
    el("art-status").textContent = !image ? "Map artwork unavailable / loading" :
      !bounds ? "Projection unavailable · select a floor" : "";
    if (!image || !this.live || !p) return;
    const locate = (/** @type {Position} */ point) => project(point, area, this.floor, catalog);
    for (const quest of this.quests) {
      if (!this.filters.has("quest") || this.hiddenQuests.has(quest.id) || quest.status === "failed") continue;
      for (const poi of quest.pois) {
        if ((poi.objective === -1) !== (quest.status === "complete")) continue;
        const positions = poi.points.map(point => locate({ ...p, ...point, map: poi.map,
          floor: poi.floor || null }));
        if (!positions.length || positions.some(pos => !pos)) continue;
        const first = positions[0]; if (!first) continue;
        ctx.beginPath(); ctx.moveTo(left + first.u * w, top + first.v * h);
        for (const pos of positions.slice(1)) if (pos) ctx.lineTo(left + pos.u * w, top + pos.v * h);
        ctx.closePath(); ctx.fillStyle = "#ffd14725"; ctx.strokeStyle = "#e8be50aa"; ctx.lineWidth = 1.5;
        ctx.fill(); ctx.stroke();
        const u = positions.reduce((sum, pos) => sum + (pos?.u ?? 0), 0) / positions.length;
        const v = positions.reduce((sum, pos) => sum + (pos?.v ?? 0), 0) / positions.length;
        if (u >= 0 && u <= 1 && v >= 0 && v <= 1)
          this.pin(ctx, left + u * w, top + v * h, "quest", quest.name, 0, this.world,
            quest.status === "complete" ? "?" : "!");
      }
    }
    for (const actor of this.actors(p)) {
      const point = locate(actor);
      if (!point || point.u < 0 || point.u > 1 || point.v < 0 || point.v > 1) continue;
      this.pin(ctx, left + point.u * w, top + point.v * h, actor.kind, actor.name, actor.facing, this.world,
        actor.kind === "quest" && "status" in actor && [3, 5, 6, 9, 10].includes(actor.status) ? "?" : undefined);
    }
  }
}
