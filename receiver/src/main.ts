// SPDX-License-Identifier: GPL-2.0-or-later
import { Artwork } from "./artwork.ts";
import { createReceiver } from "./receiver.ts";
import { Store } from "./store.ts";
try {
  const port = Number(process.env.MAP_WIDGET_PORT ?? 3003);
  const stateBytes = Number(process.env.MAP_WIDGET_STATE_BYTES ?? 268435456);
  const cacheBytes = Number(process.env.MAP_WIDGET_CACHE_BYTES ?? 268435456);
  const mode = process.env.MAP_WIDGET_ARTWORK_MODE ?? "hosted";
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
    ![stateBytes, cacheBytes].every(n => Number.isInteger(n) && n >= 8 * 1024 * 1024 && n <= 1024 ** 3) ||
    !["hosted", "offline"].includes(mode)) throw new Error("Invalid settings");
  const artwork = await Artwork.open({ cachePath: process.env.MAP_WIDGET_CACHE,
    offline: mode === "offline", maxBytes: cacheBytes });
  const receiver = createReceiver({ port, host: process.env.MAP_WIDGET_HOST ?? "127.0.0.1",
    token: process.env.MAP_WIDGET_BEARER_TOKEN, artwork, store: new Store(undefined, stateBytes) });
  console.error(`Map widget listening at ${receiver.server.url}`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    void receiver.stop().then(() => { clearTimeout(deadline); process.exit(0); });
  });
} catch { console.error("Unable to start map widget; check settings, cache path, and port"); process.exitCode = 1; }
