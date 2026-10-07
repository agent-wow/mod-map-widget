// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash } from "node:crypto";
import { PANELS, STALE_MS } from "./schema.ts";
import { validFollow } from "./watch.ts";
import type { Batch, Catalog, CatalogChunk, CatalogEntry, Panel, PanelData, PresenceData, Update, View }
  from "./schema.ts";

export class SelectionError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const key = (...parts: string[]) => JSON.stringify(parts);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
interface CatalogState {
  count: number; chunks: Map<number, CatalogEntry[]>; hashes: Map<number, string>;
  bytes: number; updated: number; value?: Catalog;
}
interface Timed { update: Update; received: number }
interface Entry {
  process: string; revision: string; guid: string; name: string; sequence: string;
  presence?: Timed; panels: Map<Panel, Timed>; updated: number; bytes: number;
}
interface Source { process: string; retired: Set<string>; entries: Map<string, Entry> }
export class Store {
  private sources = new Map<string, Source>();
  private catalogs = new Map<string, CatalogState>();
  private listeners = new Set<() => void>();
  private now: () => number;
  private maxBytes: number;
  private maxCharacters: number;
  private maxCatalogBytes: number;
  constructor(now = () => performance.now(), maxBytes = 256 * 1024 * 1024,
    maxCharacters = 10000, maxCatalogBytes = 64 * 1024 * 1024) {
    this.now = now; this.maxBytes = maxBytes; this.maxCharacters = maxCharacters;
    this.maxCatalogBytes = maxCatalogBytes;
  }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private notify() { for (const fn of this.listeners) fn(); }
  catalog(source: string, process: string, revision: string): Catalog | undefined {
    return this.catalogs.get(key(source, process, revision))?.value;
  }
  ingestCatalog(chunk: CatalogChunk) {
    if (this.sources.get(chunk.source_id)?.retired.has(chunk.process_id)) return;
    const now = this.now();
    for (const [id, c] of this.catalogs) {
      if (!c.value && now - c.updated > 60000) this.catalogs.delete(id);
    }
    const id = key(chunk.source_id, chunk.process_id, chunk.revision);
    const prior = this.catalogs.get(id);
    if (prior && prior.count !== chunk.chunk_count) throw new SelectionError(422, "Conflicting catalogue chunks");
    const hash = createHash("sha256").update(JSON.stringify(chunk.entries)).digest("hex");
    if (prior?.hashes.has(chunk.chunk_index)) {
      if (prior.hashes.get(chunk.chunk_index) !== hash) throw new SelectionError(422, "Immutable catalogue changed");
      return;
    }
    const size = bytes(chunk.entries) * 2 + 512;
    const total = [...this.catalogs.values()].reduce((n, c) => n + c.bytes, 0);
    if (total + size > this.maxCatalogBytes || (!prior && this.catalogs.size >= 256)) {
      throw new SelectionError(503, "Catalogue capacity reached");
    }
    const next: CatalogState = { count: chunk.chunk_count, chunks: new Map(prior?.chunks),
      hashes: new Map(prior?.hashes), bytes: (prior?.bytes ?? 0) + size, updated: now };
    next.chunks.set(chunk.chunk_index, chunk.entries);
    next.hashes.set(chunk.chunk_index, hash);
    if (next.chunks.size === next.count) {
      const value: Catalog = { areas: [], floors: [], transforms: [], continents: [] };
      const seen = new Set<string>();
      for (let i = 0; i < next.count; ++i) for (const entry of next.chunks.get(i)!) {
        const identity = `${entry.kind}:${entry.data.id}`;
        if (seen.has(identity)) throw new SelectionError(422, "Duplicate catalogue entry");
        seen.add(identity);
        (value[entry.kind] as CatalogEntry["data"][]).push(entry.data);
      }
      next.value = value;
      next.chunks.clear();
    }
    this.catalogs.set(id, next);
  }
  ingest(batch: Batch) {
    const now = this.now();
    const old = this.sources.get(batch.source_id);
    if (old?.retired.has(batch.process_id)) return;
    const fresh = batch.updates.filter((u) => u.age_ms < STALE_MS);
    if (!fresh.length) return;
    for (const u of fresh) if (!this.catalog(batch.source_id, batch.process_id, u.catalog_revision)) {
      throw new SelectionError(409, "catalog_required");
    }
    const changedProcess = old && old.process !== batch.process_id;
    if ((!old && this.sources.size >= 128) || (changedProcess && old.retired.size >= 128)) {
      throw new SelectionError(503, "Source capacity reached");
    }
    const source: Source = { process: batch.process_id, retired: new Set(old?.retired),
      entries: new Map(old?.entries) };
    if (changedProcess) source.retired.add(old.process);
    const touched = new Set<string>();
    for (const u of fresh) {
      const prior = source.entries.get(u.guid);
      const same = prior?.process === batch.process_id && prior.revision === u.catalog_revision;
      const previous = same ? u.panel === "presence" ? prior.presence : prior.panels.get(u.panel) : undefined;
      if (previous && BigInt(previous.update.sequence) >= BigInt(u.sequence)) continue;
      if (same && u.panel !== "presence" && prior.presence &&
        (prior.presence.update.data as PresenceData).presence !== "online" &&
        BigInt(u.sequence) <= BigInt(prior.presence.update.sequence)) continue;
      const entry: Entry = same ? { ...prior, panels: new Map(prior.panels) } : {
        process: batch.process_id, revision: u.catalog_revision, guid: u.guid, name: u.name,
        sequence: u.sequence, panels: new Map(), updated: now, bytes: 0,
      };
      if (BigInt(u.sequence) >= BigInt(entry.sequence)) { entry.name = u.name; entry.sequence = u.sequence; }
      entry.updated = now;
      const timed = { update: u, received: now };
      if (u.panel === "presence") entry.presence = timed;
      else entry.panels.set(u.panel, timed);
      entry.bytes = 1024 + (entry.presence ? bytes(entry.presence.update) * 2 : 0) +
        [...entry.panels.values()].reduce((n, p) => n + bytes(p.update) * 2, 0);
      source.entries.set(u.guid, entry);
      touched.add(u.guid);
    }
    if (!touched.size) return;
    // Work on copies until both state admission and eviction can be committed atomically.
    const sources = new Map(this.sources);
    sources.set(batch.source_id, source);
    let total = 0;
    let count = 0;
    const candidates: { source: string; entry: Entry }[] = [];
    for (const [id, s] of sources) for (const entry of s.entries.values()) {
      total += entry.bytes; ++count;
      if (!(id === batch.source_id && touched.has(entry.guid)) && this.inactive(entry, s.process, now)) {
        candidates.push({ source: id, entry });
      }
    }
    candidates.sort((a, b) => a.entry.updated - b.entry.updated);
    for (const candidate of candidates) {
      if (total <= this.maxBytes && count <= this.maxCharacters) break;
      const current = sources.get(candidate.source)!;
      const copy = { ...current, entries: new Map(current.entries) };
      copy.entries.delete(candidate.entry.guid);
      sources.set(candidate.source, copy);
      total -= candidate.entry.bytes; --count;
    }
    if (total > this.maxBytes || count > this.maxCharacters) throw new SelectionError(503, "State capacity reached");
    this.sources = sources;
    this.pruneCatalogs();
    this.notify();
  }
  private pruneCatalogs() {
    const used = new Set<string>();
    for (const [id, s] of this.sources) for (const e of s.entries.values()) used.add(key(id, e.process, e.revision));
    for (const [id, c] of this.catalogs) {
      if (c.value && !used.has(id) && this.now() - c.updated > 60000) this.catalogs.delete(id);
    }
  }
  private inactive(e: Entry, process: string, now: number) {
    return e.process !== process || !e.presence ||
      (e.presence.update.data as PresenceData).presence !== "online" ||
      e.presence.update.age_ms + now - e.presence.received >= STALE_MS;
  }
  characters(source: string, name?: string) {
    const entries = this.sources.get(source)?.entries.values() ?? [];
    return [...entries].filter((e) => !name || e.name.toLowerCase() === name.toLowerCase())
      .map((e) => ({ guid: e.guid, name: e.name, presence: this.view(source, e.guid)!.presence }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  resolve(params: URLSearchParams) {
    const source = params.get("source");
    const guid = params.get("guid");
    const character = params.get("character");
    if (!validFollow(params) || !source || source.length > 256 || Boolean(guid) === Boolean(character) ||
      params.getAll("source").length !== 1 || params.getAll("guid").length > 1 ||
      params.getAll("character").length > 1 || (guid ?? character ?? "").length > 256) {
      throw new SelectionError(400, "Select a source and one character name or GUID");
    }
    if (guid) return { source, guid };
    const found = this.characters(source, character!);
    if (!found.length) throw new SelectionError(404, "Waiting for this character to be observed");
    if (found.length > 1) throw new SelectionError(409, "Ambiguous character name; use a GUID");
    return { source, guid: found[0]!.guid };
  }
  watchedGuid(source: string, observer: string): string | null {
    const view = this.view(source, observer);
    if (!view || view.stale) return null;
    return view.presence === "offline" ? observer : view.watch_target?.guid ?? observer;
  }
  view(sourceId: string, guid: string, panel: Panel | "all" = "all", follow = false): View | null {
    if (follow) {
      const selected = this.watchedGuid(sourceId, guid);
      return selected === null ? null : this.view(sourceId, selected, panel);
    }
    const source = this.sources.get(sourceId);
    const e = source?.entries.get(guid);
    if (!source || !e) return null;
    const now = this.now();
    const age = e.presence ? e.presence.update.age_ms + Math.max(0, now - e.presence.received) : STALE_MS;
    const presence = e.presence ? (e.presence.update.data as PresenceData).presence : "unavailable";
    const revisions = e.presence ? (e.presence.update.data as PresenceData).revisions : undefined;
    const lastObserved = e.presence ? e.presence.received - e.presence.update.age_ms : now;
    const contentTime = Math.min(now, lastObserved + (presence === "online" ? STALE_MS : 0));
    const result: View = { source_id: sourceId, process_id: e.process, guid, name: e.name, presence,
      stale: e.process !== source.process || (presence !== "offline" && age >= STALE_MS), age_ms: age,
      catalog_revision: e.revision, sequence: e.sequence,
      watch_target: e.presence ? (e.presence.update.data as PresenceData).watch_target ?? null : null,
      revisions, panels: {} };
    for (const p of PANELS) {
      if (panel !== "all" && panel !== p) continue;
      const value = e.panels.get(p);
      if (value) result.panels[p] = { sequence: value.update.sequence,
        stale: presence === "online" &&
          (!revisions?.[p] || BigInt(value.update.sequence) < BigInt(revisions[p]!)),
        age_ms: Math.max(0, value.update.age_ms + contentTime - value.received),
        data: value.update.data as PanelData[Panel] };
    }
    return result;
  }
}
