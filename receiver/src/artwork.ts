// SPDX-License-Identifier: GPL-2.0-or-later
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const USER_AGENT = "mod-map-widget/1.0 (AzerothCore OBS map widget)";
const MANIFEST = "https://map.wow.tools/data/manifest_v2.json";
export interface Terrain {
  map: number; name: string; build: number; hash: string; min_x: number; min_y: number;
  width: number; height: number; max_zoom: number;
}
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type Image = { bytes: Uint8Array; type: string };
type Manifest = {
  Maps: Record<string, { InternalMapID: number; InternalName: string }>;
  Versions: Record<string, { Build: number; FullBuild: string }>;
  MapVersions: Record<string, Record<string, { MD5: string; Config: {
    MinX: number; MinY: number; ResX: number; ResY: number; MaxZoom: number; isLowerCase?: boolean;
  } }>>;
};
// Only original pre-Cataclysm builds, never Classic or a newer expansion, even with a lower build number.
export function selectTerrain(input: unknown): Map<number, Terrain> {
  const result = new Map<number, Terrain>();
  const m = input as Manifest;
  if (!m || !m.Maps || !m.Versions || !m.MapVersions) throw new Error("Invalid terrain manifest");
  for (const [key, map] of Object.entries(m.Maps)) {
    if (!Number.isInteger(map.InternalMapID) || map.InternalMapID < 0 ||
      typeof map.InternalName !== "string" || !/^[a-zA-Z0-9 _-]{1,128}$/.test(map.InternalName)) continue;
    for (const [version, record] of Object.entries(m.MapVersions[key] ?? {})) {
      const v = m.Versions[version];
      const c = record.Config;
      if (!v || !/^[123]\./.test(v.FullBuild) || v.Build > 12340 || v.Build < 4000 ||
        !/^[a-f0-9]{32}$/.test(record.MD5) || !c ||
        ![c.MinX, c.MinY, c.ResX, c.ResY, c.MaxZoom].every(Number.isInteger) ||
        c.MinX < 0 || c.MinY < 0 || c.MinX >= 63 || c.MinY >= 63 ||
        c.ResX <= 0 || c.ResY <= 0 || c.ResX > 32768 || c.ResY > 32768 ||
        c.MaxZoom < 0 || c.MaxZoom > 8 || (result.get(map.InternalMapID)?.build ?? 0) >= v.Build) continue;
      result.set(map.InternalMapID, { map: map.InternalMapID,
        name: c.isLowerCase ? map.InternalName.toLowerCase() : map.InternalName, build: v.Build,
        hash: record.MD5, min_x: c.MinX, min_y: c.MinY, width: c.ResX, height: c.ResY, max_zoom: c.MaxZoom });
    }
  }
  if (!result.size) throw new Error("Empty terrain manifest");
  return result;
}
export class Artwork {
  private db: Database;
  private terrain = new Map<number, Terrain>();
  private pending = new Map<string, Promise<Image | null>>();
  private failures = new Map<string, number>();
  private active = 0;
  private closed = false;
  private controllers = new Set<AbortController>();
  private refresh?: Promise<void>;
  private nextManifest = 0;
  private options: { cachePath?: string; offline?: boolean; fetcher?: Fetcher; maxBytes?: number };
  constructor(options: { cachePath?: string; offline?: boolean; fetcher?: Fetcher; maxBytes?: number } = {}) {
    this.options = options;
    this.db = new Database(options.cachePath ?? ":memory:");
    this.db.exec("CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, type TEXT, bytes BLOB, used REAL);");
    this.db.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);");
    const row = this.db.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='terrain'").get();
    if (row) {
      try { this.terrain = selectTerrain(JSON.parse(row.value)); } catch { /* A refresh repairs obsolete metadata. */ }
    }
  }
  static async open(options: { cachePath?: string; offline?: boolean; fetcher?: Fetcher; maxBytes?: number } = {}) {
    const cachePath = options.cachePath ?? "./data/maps.sqlite";
    if (cachePath !== ":memory:") await mkdir(dirname(cachePath), { recursive: true });
    return new Artwork({ ...options, cachePath });
  }
  private async download(url: string, limit: number): Promise<{ bytes: Uint8Array; type: string }> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await (this.options.fetcher ?? fetch)(url, { redirect: "error", signal: controller.signal,
        headers: { "User-Agent": USER_AGENT } });
      if (!r.ok || !r.body || Number(r.headers.get("content-length")) > limit) throw new Error("Artwork unavailable");
      const reader = r.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > limit) throw new Error("Artwork too large");
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { bytes, type: r.headers.get("content-type")?.split(";")[0] ?? "" };
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  private async loadManifest() {
    if (this.refresh) { await this.refresh; return; }
    if (this.closed || this.options.offline || Date.now() < this.nextManifest) return;
    this.refresh ??= (async () => {
      this.nextManifest = Date.now() + 60000;
      try {
        const downloaded = await this.download(MANIFEST, 16 * 1024 * 1024);
        const raw = new TextDecoder("utf-8", { fatal: true }).decode(downloaded.bytes);
        const terrain = selectTerrain(JSON.parse(raw));
        if (this.closed) return;
        this.terrain = terrain;
        this.db.run("INSERT OR REPLACE INTO metadata VALUES ('terrain', ?)", [raw]);
        this.nextManifest = Date.now() + 24 * 3600000;
      } catch { /* Keep last-known valid metadata; a provider outage must not stop ingestion. */ }
    })().finally(() => { this.refresh = undefined; });
    await this.refresh;
  }
  private async image(key: string, url: string): Promise<Image | null> {
    if (this.closed) return null;
    const cached = this.db.query<Image, [string]>("SELECT bytes, type FROM images WHERE key=?").get(key);
    if (cached) { this.db.run("UPDATE images SET used=? WHERE key=?", [Date.now(), key]); return cached; }
    if (this.options.offline || (this.failures.get(key) ?? 0) > Date.now()) return null;
    const prior = this.pending.get(key);
    if (prior) return prior;
    if (this.pending.size >= 32) return null;
    const promise = (async () => {
      // Bounded pending requests wait outside ingestion and the game server.
      while (this.active >= 4 && !this.closed) await Bun.sleep(25);
      if (this.closed) return null;
      ++this.active;
      try {
        const img = await this.download(url, 2 * 1024 * 1024);
        const b = img.bytes;
        if (!(img.type === "image/png" && b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) &&
          !(img.type === "image/jpeg" && b[0] === 255 && b[1] === 216 && b[2] === 255))
          throw new Error("Invalid image");
        if (this.closed) return null;
        const budget = this.options.maxBytes ?? 256 * 1024 * 1024;
        if (b.length > budget) return null;
        this.db.run("INSERT OR REPLACE INTO images VALUES (?, ?, ?, ?)", [key, img.type, b, Date.now()]);
        while (this.db.query<{ size: number }, []>("SELECT coalesce(sum(length(bytes)),0) size FROM images")
          .get()!.size > budget)
          this.db.run("DELETE FROM images WHERE key=(SELECT key FROM images ORDER BY used LIMIT 1)");
        return img;
      } catch {
        if (this.failures.size >= 4096) this.failures.clear();
        this.failures.set(key, Date.now() + 60000);
        return null;
      } finally { --this.active; }
    })().finally(() => { this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }
  async handle(url: URL): Promise<Response> {
    const unavailable = () => Response.json({ error: "Artwork unavailable" },
      { status: 404, headers: { "Cache-Control": "no-store" } });
    if (url.pathname === "/api/terrain") {
      await this.loadManifest();
      const map = url.searchParams.get("map");
      if (!map || !/^\d{1,6}$/.test(map)) return unavailable();
      const terrain = this.terrain.get(Number(map));
      return terrain ? Response.json(terrain, { headers: { "Cache-Control": "no-store" } }) : unavailable();
    }
    let key: string, remote: string;
    const world = /^\/assets\/world\/(-[2356]|\d{1,6})(?:-(\d{1,3}))?\.jpg$/.exec(url.pathname);
    const tile = /^\/assets\/terrain\/(\d{1,6})\/([a-f0-9]{32})\/(\d)\/(\d{1,3})\/(\d{1,3})\.png$/.exec(url.pathname);
    if (world) {
      key = url.pathname;
      remote = "https://wow.zamimg.com/images/wow/wrath/maps/enus/original/" +
        `${world[1]}${world[2] ? `-${world[2]}` : ""}.jpg`;
    } else if (tile) {
      await this.loadManifest();
      const t = this.terrain.get(Number(tile[1]));
      const z = Number(tile[3]), y = Number(tile[4]), x = Number(tile[5]);
      if (!t || tile[2] !== t.hash || z > t.max_zoom ||
        x >= Math.ceil(t.width / 2 ** (t.max_zoom - z) / 256) ||
        y >= Math.ceil(t.height / 2 ** (t.max_zoom - z) / 256)) return unavailable();
      key = url.pathname;
      remote = `https://tiles.wow.tools/tiles/${t.hash}/tiles/${encodeURIComponent(t.name)}/${z}/${y}/${x}.png`;
    } else return unavailable();
    const img = await this.image(key, remote);
    return img ? new Response(new Uint8Array(img.bytes), { headers: { "Content-Type": img.type,
      "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" } }) : unavailable();
  }
  close() { this.closed = true; for (const controller of this.controllers) controller.abort(); this.db.close(); }
}
