// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artwork, selectTerrain } from "../src/artwork.ts";
const active: Artwork[] = [];
afterEach(() => { for (const a of active.splice(0)) a.close(); });
const hash = "a".repeat(32);
const manifest = {
  Maps: { "1": { InternalMapID: 0, InternalName: "Azeroth" } },
  Versions: { "1": { Build: 10571, FullBuild: "3.3.0.10571" }, "2": { Build: 12000, FullBuild: "4.0.0.12000" },
    "3": { Build: 40000, FullBuild: "3.4.0.40000" } },
  MapVersions: { "1": Object.fromEntries(["1", "2", "3"].map(id => [id, { MD5: hash,
    Config: { MinX: 24, MinY: 20, ResX: 1024, ResY: 2048, MaxZoom: 3 } }])) },
};
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
test("provider selection rejects Cataclysm/Classic and unknown WMO offsets", () => {
  expect(selectTerrain(manifest).get(0)?.build).toBe(10571);
  const bad = structuredClone(manifest);
  bad.MapVersions["1"]["1"]!.Config.MinX = -1;
  expect(() => selectTerrain(bad)).toThrow("Empty terrain");
});
test("deduplicates images, sends only fixed asset URLs, and caches failures", async () => {
  const requested: string[] = [];
  const art = new Artwork({ fetcher: async (url, init) => {
    requested.push(url); expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("user-agent")).toContain("mod-map-widget");
    await Bun.sleep(10);
    return url.includes("12.jpg") ? new Response(png, { headers: { "Content-Type": "image/png" } }) :
      new Response("missing", { status: 404 });
  } }); active.push(art);
  const u = new URL("http://localhost/assets/world/12.jpg");
  expect((await Promise.all([art.handle(u), art.handle(u)])).map(r => r.status)).toEqual([200, 200]);
  expect(requested).toHaveLength(1);
  expect((await art.handle(new URL("http://localhost/assets/world/99.jpg"))).status).toBe(404);
  await art.handle(new URL("http://localhost/assets/world/99.jpg"));
  expect(requested).toHaveLength(2);
  const arbitrary = new URL("http://localhost/assets/world/evil.jpg?url=https://example.com");
  expect((await art.handle(arbitrary)).status).toBe(404);
  expect(requested).toHaveLength(2);
});
test("terrain routes validate hashes, offsets, zoom and tile extents", async () => {
  const requested: string[] = [];
  const art = new Artwork({ fetcher: async url => {
    requested.push(url); return url.includes("manifest") ? Response.json(manifest) :
      new Response(png, { headers: { "Content-Type": "image/png" } });
  } }); active.push(art);
  expect((await art.handle(new URL("http://localhost/api/terrain?map=0"))).status).toBe(200);
  expect((await art.handle(new URL(`http://localhost/assets/terrain/0/${hash}/3/0/0.png`))).status).toBe(200);
  expect((await art.handle(new URL(`http://localhost/assets/terrain/0/${hash}/3/0/99.png`))).status).toBe(404);
  expect((await art.handle(new URL(`http://localhost/assets/terrain/0/${hash}/9/0/0.png`))).status).toBe(404);
  expect(requested).toHaveLength(2);
});
test("persistent cached images work offline and eviction respects the byte budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "map-widget-"));
  const cachePath = join(directory, "maps.sqlite");
  let art = new Artwork({ cachePath, maxBytes: png.length, fetcher: async () =>
    new Response(png, { headers: { "Content-Type": "image/png" } }) });
  try {
    await art.handle(new URL("http://localhost/assets/world/12.jpg"));
    await Bun.sleep(2);
    await art.handle(new URL("http://localhost/assets/world/1.jpg"));
    art.close();
    art = new Artwork({ cachePath, offline: true });
    expect((await art.handle(new URL("http://localhost/assets/world/1.jpg"))).status).toBe(200);
    expect((await art.handle(new URL("http://localhost/assets/world/12.jpg"))).status).toBe(404);
  } finally { art.close(); await rm(directory, { recursive: true }); }
});
test("rejects HTML masquerading as artwork and oversized advertised bodies", async () => {
  const art = new Artwork({ fetcher: async url => url.includes("12.jpg") ?
    new Response("<script>bad</script>", { headers: { "Content-Type": "image/png" } }) :
    new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": "9999999" } }) });
  active.push(art);
  expect((await art.handle(new URL("http://localhost/assets/world/12.jpg"))).status).toBe(404);
  expect((await art.handle(new URL("http://localhost/assets/world/13.jpg"))).status).toBe(404);
});
test("concurrent first terrain requests share the completed manifest", async () => {
  let requests = 0;
  const art = new Artwork({ fetcher: async () => {
    ++requests; await Bun.sleep(10); return Response.json(manifest);
  } });
  active.push(art);
  const url = new URL("http://localhost/api/terrain?map=0");
  const responses = await Promise.all([art.handle(url), art.handle(url), art.handle(url)]);
  expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
  expect(requests).toBe(1);
});
