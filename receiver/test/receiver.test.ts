// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { batch, catalogChunk, panelData } from "../examples/fixtures.ts";
import { createReceiver } from "../src/receiver.ts";
import { snapshotStream } from "../src/stream.ts";
import { Store } from "../src/store.ts";
const running: ReturnType<typeof createReceiver>[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((r) => r.stop())); });
function start(token?: string) {
  const r = createReceiver({ host: "127.0.0.1", port: 0, token });
  running.push(r);
  return r;
}
async function post(r: ReturnType<typeof createReceiver>, path: string, value: unknown, token?: string) {
  return fetch(new URL(path, r.server.url), { method: "POST", headers: { "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
}
test("authenticated ingestion, atomic validation, catalogue replay, discovery and panel filtering", async () => {
  const r = start("secret");
  expect((await post(r, "/maps", batch())).status).toBe(401);
  expect((await post(r, "/maps", batch(), "secret")).status).toBe(409);
  expect((await post(r, "/catalogs", catalogChunk(), "secret")).status).toBe(204);
  const invalid = batch(); invalid.updates[1]!.data = { money: 1 } as never;
  expect((await post(r, "/maps", invalid, "secret")).status).toBe(422);
  expect(r.store.view("realm-1", "Alice")).toBeNull();
  expect((await post(r, "/maps", batch(), "secret")).status).toBe(204);
  const response = await fetch(new URL("/api/map?source=realm-1&character=alice&panel=markers", r.server.url));
  expect(response.headers.get("cache-control")).toBe("no-store");
  const view = await response.json(); expect(Object.keys(view.panels)).toEqual(["markers"]);
  const discovery = await fetch(new URL("/api/characters?source=realm-1", r.server.url));
  expect((await discovery.json()).characters[0].name).toBe("Alice");
  const catalog = await fetch(new URL("/api/catalog?source=realm-1&process=demo-process&revision=demo-process",
    r.server.url));
  expect((await catalog.json()).areas.length).toBeGreaterThan(0);
});
test("moving NPC headings do not interrupt an idle character's presence heartbeats", async () => {
  let now = 0;
  const r = createReceiver({ host: "127.0.0.1", port: 0, store: new Store(() => now) });
  running.push(r);
  expect((await post(r, "/catalogs", catalogChunk())).status).toBe(204);
  expect((await post(r, "/maps", batch())).status).toBe(204);
  for (const facing of [-.5, -1, -2, -3, -Math.PI, Math.fround(2 * Math.PI), .5]) {
    now += 1000;
    const next = batch(now);
    const markers = next.updates[1]!, presence = next.updates.at(-1)!;
    const data = panelData().markers;
    data.markers[0]!.facing = facing;
    markers.data = data;
    presence.data = { presence: "online", revisions: { motion: "1", markers: markers.sequence, quests: "3" } };
    next.updates = [markers, presence];
    expect((await post(r, "/maps", next)).status).toBe(204);
    const view = r.store.view("realm-1", "Alice")!;
    expect(view.stale).toBe(false);
    expect(view.age_ms).toBe(0);
    expect(view.panels.motion?.sequence).toBe("1");
    expect(view.panels.motion?.stale).toBe(false);
  }
});
test("invalid media, JSON, selectors, methods, and paths fail without affecting state", async () => {
  const r = start();
  expect((await fetch(new URL("/maps", r.server.url), { method: "POST", body: "{}" })).status).toBe(415);
  expect((await fetch(new URL("/maps", r.server.url))).status).toBe(405);
  expect((await fetch(new URL("/api/map?source=realm-1", r.server.url))).status).toBe(400);
  expect((await fetch(new URL("/missing", r.server.url))).status).toBe(404);
  expect((await fetch(new URL("/maps", r.server.url), { method: "POST",
    headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
  const widget = await fetch(new URL("/widget", r.server.url));
  expect(widget.headers.get("content-security-policy")).toContain("default-src 'self'");
});
test("oversized ingestion and wrong catalogue credentials leave state untouched", async () => {
  const r = start("secret");
  expect((await post(r, "/catalogs", catalogChunk(), "wrong")).status).toBe(401);
  const response = await fetch(new URL("/maps", r.server.url), { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: "Bearer secret",
  }, body: " ".repeat(8 * 1024 * 1024 + 1) });
  expect(response.status).toBe(413);
  expect(r.store.view("realm-1", "Alice")).toBeNull();
});
test("SSE emits initial identity and each panel, reconnects to latest state, and retains stale data", async () => {
  let now = 0; const store = new Store(() => now); store.ingestCatalog(catalogChunk()); store.ingest(batch());
  const abort = new AbortController(); const stream = snapshotStream(store, "realm-1", "Alice", abort.signal);
  const reader = stream.stream.getReader(); const decoder = new TextDecoder();
  const snapshot = decoder.decode((await reader.read()).value);
  expect(snapshot).toContain("event: snapshot");
  expect(snapshot).toContain('"revisions":{"motion":"1","markers":"2","quests":"3"}');
  let panelEvents = 0;
  while (panelEvents < 3) if (decoder.decode((await reader.read()).value).includes("event: panel")) ++panelEvents;
  now = 5000;
  const stale = decoder.decode((await reader.read()).value); expect(stale).toContain('"stale":true');
  abort.abort(); expect(stream.closed).toBe(true); await reader.cancel();
  store.ingest(batch(100));
  const next = snapshotStream(store, "realm-1", "Alice", new AbortController().signal, undefined, "markers");
  const nextReader = next.stream.getReader(); await nextReader.read();
  expect(decoder.decode((await nextReader.read()).value)).toContain('"sequence":"101"');
  await nextReader.cancel(); expect(next.closed).toBe(true);
});
test("SSE includes advertised motion revisions before delivering the matching panel", async () => {
  const store = new Store(); store.ingestCatalog(catalogChunk()); store.ingest(batch());
  const connection = snapshotStream(store, "realm-1", "Alice", new AbortController().signal);
  const reader = connection.stream.getReader(), decoder = new TextDecoder();
  const read = async () => decoder.decode((await reader.read()).value);
  const until = async (text: string) => {
    for (let i = 0; i < 20; ++i) { const event = await read(); if (event.includes(text)) return event; }
    throw new Error(`Missing SSE event: ${text}`);
  };
  try {
    await until('"panel":"quests"');
    const next = batch(100, "Alice", 1);
    store.ingest({ ...next, updates: [next.updates.at(-1)!] });
    const presence = await until("event: presence");
    expect(presence).toContain("event: presence");
    expect(presence).toContain('"revisions":{"motion":"100","markers":"101","quests":"102"}');
    expect(await until('"panel":"motion"')).toContain('"stale":true');
    store.ingest({ ...next, updates: [next.updates[0]!] });
    const motion = await until('"panel":"motion","sequence":"100"');
    expect(motion).toContain('"panel":"motion","sequence":"100"');
    expect(motion).toContain('"stale":false');
  } finally { await reader.cancel(); }
});
test("SSE rejects an event larger than its buffering budget and closes on shutdown", async () => {
  const r = start(); r.store.ingestCatalog(catalogChunk()); r.store.ingest(batch());
  const stream = snapshotStream(r.store, "realm-1", "Alice", new AbortController().signal, undefined, "all", 1);
  expect(stream.closed).toBe(true);
  const abort = new AbortController();
  const response = await fetch(new URL("/api/map/stream?source=realm-1&guid=Alice", r.server.url),
    { signal: abort.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  abort.abort(); await r.stop();
});
