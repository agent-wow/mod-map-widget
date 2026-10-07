// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { createReceiver } from "../src/receiver.ts";
import { batch, catalogChunk } from "../examples/fixtures.ts";
import { isBatch, PANELS, STALE_MS } from "../src/schema.ts";
import type { PresenceData } from "../src/schema.ts";
import { Store } from "../src/store.ts";
import { snapshotStream } from "../src/stream.ts";
import type { WatchTarget } from "../src/watch.ts";

function watched(sequence = 1, name = "Observer", target: WatchTarget | null = null,
  presence: PresenceData["presence"] = "online", process = "demo-process") {
  const value = batch(sequence, name, 0, process);
  const state = value.updates.find(u => u.panel === "presence")!.data as PresenceData;
  state.watch_target = target; state.presence = presence;
  return value;
}
const alice = { guid: "Alice", name: "Alice" }, bob = { guid: "Bob", name: "Bob" };
function setup() {
  let now = 0;
  const store = new Store(() => now); store.ingestCatalog(catalogChunk());
  store.ingest(watched()); store.ingest(watched(1, "Alice")); store.ingest(watched(1, "Bob"));
  return { store, advance: (time: number) => { now = time; } };
}
test("follow routes by observer, never recursively, and preserves direct selection", () => {
  const { store } = setup();
  expect(store.view("realm-1", "Observer", "all", true)?.guid).toBe("Observer");
  store.ingest(watched(100, "Observer", alice));
  store.ingest(watched(100, "Alice", bob));
  expect(store.view("realm-1", "Observer", "all", true)?.guid).toBe("Alice");
  expect(store.view("realm-1", "Observer")?.guid).toBe("Observer");
  store.ingest(watched(1, "Other", alice));
  store.ingest(watched(200, "Observer", bob));
  expect(store.view("realm-1", "Other", "all", true)?.guid).toBe("Alice");
  expect(store.view("realm-1", "Observer", "all", true)?.guid).toBe("Bob");
  store.ingest(watched(300, "Observer"));
  store.ingest(watched(200, "Observer", alice));
  expect(store.view("realm-1", "Observer", "all", true)?.guid).toBe("Observer");
  expect(store.view("another-realm", "Observer", "all", true)).toBeNull();
});
test("offline and unknown targets retain assignment; observer staleness suspends routing", () => {
  const { store, advance } = setup();
  store.ingest(watched(100, "Observer", { guid: "Unknown", name: "Offline" }));
  expect(store.view("realm-1", "Observer", "all", true)).toBeNull();
  store.ingest(watched(200, "Observer", alice, "unavailable"));
  store.ingest(watched(100, "Alice", null, "offline"));
  expect(store.view("realm-1", "Observer", "all", true)?.presence).toBe("offline");
  advance(STALE_MS); store.ingest(watched(200, "Alice"));
  expect(store.view("realm-1", "Observer", "all", true)).toBeNull();
  store.ingest(watched(300, "Observer", alice));
  expect(store.view("realm-1", "Observer", "all", true)?.presence).toBe("online");
  store.ingest(watched(400, "Observer", alice, "offline"));
  expect(store.view("realm-1", "Observer", "all", true)?.guid).toBe("Observer");
});
test("restart retires watch assignments and legacy publishers fall back to observer", () => {
  const { store } = setup();
  store.ingest(watched(100, "Observer", alice));
  store.ingestCatalog(catalogChunk("new-process"));
  store.ingest(watched(1, "Alice", null, "online", "new-process"));
  expect(store.view("realm-1", "Observer", "all", true)).toBeNull();
  const legacy = watched(1, "Observer", null, "online", "new-process");
  delete (legacy.updates.find(u => u.panel === "presence")!.data as PresenceData).watch_target;
  expect(isBatch(legacy)).toBe(true); store.ingest(legacy);
  store.ingest(watched(1000, "Observer", bob));
  expect(store.view("realm-1", "Observer", "all", true)?.guid).toBe("Observer");
});
test("watch metadata and follow selectors are validated atomically", () => {
  const { store } = setup();
  for (const invalid of [false, {}, { guid: "", name: "Name" }, { guid: "a", name: 5 }]) {
    const value = watched();
    (value.updates.find(u => u.panel === "presence")!.data as PresenceData).watch_target = invalid as never;
    expect(isBatch(value)).toBe(false);
  }
  for (const mode of ["follow=other", "follow=", "follow=watch&follow=watch"]) {
    expect(() => store.resolve(new URLSearchParams(`source=realm-1&guid=Observer&${mode}`))).toThrow();
  }
});
test("SSE resets panels on same-process retarget and reconnect resolves the observer again", async () => {
  const { store, advance } = setup(); store.ingest(watched(100, "Observer", alice));
  const stream = snapshotStream(store, "realm-1", "Observer", new AbortController().signal,
    undefined, "all", undefined, true);
  const reader = stream.stream.getReader(); const decoder = new TextDecoder();
  const next = async () => decoder.decode((await reader.read()).value);
  try {
    expect(await next()).toContain('"guid":"Alice"');
    for (const panel of PANELS) expect(await next()).toContain(`"panel":"${panel}"`);
    store.ingest(watched(200, "Observer", bob));
    const changed = await next(); expect(changed).toContain("event: snapshot");
    expect(changed).toContain('"guid":"Bob"'); expect(changed).toContain('"panels":{}');
    for (const panel of PANELS) expect(await next()).toContain(`"panel":"${panel}"`);
    advance(STALE_MS);
    expect(await next()).toContain("data: null");
  } finally { await reader.cancel(); }
  store.ingest(watched(300, "Observer"));
  const resumed = snapshotStream(store, "realm-1", "Observer", new AbortController().signal,
    undefined, "all", undefined, true);
  const retry = resumed.stream.getReader();
  try { expect(decoder.decode((await retry.read()).value)).toContain('"guid":"Observer"'); }
  finally { await retry.cancel(); }
});

test("HTTP follow remains opt-in and validates query parameters", async () => {
  const receiver = createReceiver({ host: "127.0.0.1", port: 0 });
  try {
    receiver.store.ingestCatalog(catalogChunk());
    receiver.store.ingest(watched(1, "Observer", alice)); receiver.store.ingest(watched(1, "Alice"));
    const url = new URL("/api/map?source=realm-1&character=Observer", receiver.server.url);
    expect((await (await fetch(url)).json()).guid).toBe("Observer");
    url.searchParams.set("follow", "watch");
    expect((await (await fetch(url)).json()).guid).toBe("Alice");
    url.searchParams.append("follow", "watch"); expect((await fetch(url)).status).toBe(400);
    url.searchParams.set("follow", "invalid"); expect((await fetch(url)).status).toBe(400);
    expect((await fetch(new URL("/follow.js", receiver.server.url))).status).toBe(200);
  } finally { await receiver.stop(); }
});
