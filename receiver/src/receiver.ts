// SPDX-License-Identifier: GPL-2.0-or-later
import { timingSafeEqual } from "node:crypto";
import { isBatch, isCatalogChunk, PANELS } from "./schema.ts";
import { Store, SelectionError } from "./store.ts";
import type { Panel } from "./schema.ts";
import type { Artwork } from "./artwork.ts";
import { snapshotStream } from "./stream.ts";

export const MAX_BODY = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const assets = new Map([
  ["/widget", ["widget.html", "text/html; charset=utf-8"]],
  ["/widget.js", ["widget.js", "text/javascript; charset=utf-8"]],
  ["/render.js", ["render.js", "text/javascript; charset=utf-8"]],
  ["/motion-state.js", ["motion-state.js", "text/javascript; charset=utf-8"]],
  ["/projection.js", ["projection.js", "text/javascript; charset=utf-8"]],
  ["/widget.css", ["widget.css", "text/css; charset=utf-8"]],
]);
function failure(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store",
    ...(status === 503 ? { "Retry-After": "1" } : {}) } });
}
async function readBody(request: Request, timeout: number) {
  if (!request.body) throw new SelectionError(400, "Empty request body");
  const reader = request.body.getReader();
  const interrupted = Promise.withResolvers<never>();
  const timer = setTimeout(() => interrupted.reject(new SelectionError(408, "Upload deadline exceeded")), timeout);
  const abort = () => interrupted.reject(new SelectionError(400, "Upload interrupted"));
  request.signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (request.signal.aborted) throw new SelectionError(400, "Upload interrupted");
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted.promise]);
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BODY) throw new SelectionError(413, "Body exceeds 8 MiB");
      chunks.push(value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(result);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

export interface ReceiverOptions {
  host?: string; port?: number; token?: string; store?: Store; artwork?: Artwork; bodyTimeoutMs?: number;
  diagnostic?: (message: string) => void;
}
export function createReceiver(options: ReceiverOptions = {}) {
  const store = options.store ?? new Store();
  const diagnostic = options.diagnostic ?? ((message: string) => console.error(message));
  const digest = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest();
  const expected = options.token ? digest(`Bearer ${options.token}`) : null;
  const streams = new Set<() => void>();
  let active = 0;
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: options.host ?? "127.0.0.1", port: options.port ?? 3003,
    maxRequestBodySize: MAX_BODY, idleTimeout: 15,
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        if (stopping) return failure(503, "Receiver stopping");
        if (["/maps", "/catalogs"].includes(url.pathname)) {
          if (request.method !== "POST") return failure(405, "Use POST /maps");
          if (expected && !timingSafeEqual(expected, digest(request.headers.get("authorization") ?? ""))) {
            return failure(401, "Unauthorized");
          }
          if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
            ![null, "identity"].includes(request.headers.get("content-encoding"))) {
            return failure(415, "Uncompressed application/json required");
          }
          if (Number(request.headers.get("content-length")) > MAX_BODY) return failure(413, "Body exceeds 8 MiB");
          if (active >= 4) return failure(503, "Receiver unavailable; retry this batch");
          server.timeout(request, 0);
          ++active;
          try {
            let value: unknown;
            try { value = JSON.parse(await readBody(request, options.bodyTimeoutMs ?? 3000)); }
            catch (error) {
              if (error instanceof SelectionError) throw error;
              throw new SelectionError(400, "Invalid JSON or UTF-8");
            }
            if (stopping) return failure(503, "Receiver stopping");
            if (url.pathname === "/catalogs") {
              if (!isCatalogChunk(value)) return failure(422, "Invalid catalogue schema");
              store.ingestCatalog(value);
            } else {
              if (!isBatch(value)) return failure(422, "Invalid character panel schema");
              store.ingest(value);
            }
            return new Response(null, { status: 204 });
          } finally { --active; }
        }
        if (request.method !== "GET") return failure(405, "Use GET");
        const asset = assets.get(url.pathname);
        if (asset) return new Response(Bun.file(new URL(`./web/${asset[0]}`, import.meta.url)), {
          headers: { "Content-Type": asset[1]!, "Cache-Control": "no-cache",
            "Content-Security-Policy": "default-src 'self'; img-src 'self'; " +
              "style-src 'self' 'unsafe-inline'; connect-src 'self'" },
        });
        if (url.pathname.startsWith("/assets/") || url.pathname === "/api/terrain") {
          return await options.artwork?.handle(url) ?? failure(404, "Artwork unavailable");
        }
        if (url.pathname === "/api/catalog") {
          const value = store.catalog(url.searchParams.get("source") ?? "", url.searchParams.get("process") ?? "",
            url.searchParams.get("revision") ?? "");
          if (!value) return failure(404, "Catalogue unavailable");
          return Response.json(value, { headers: { "Cache-Control": "no-store" } });
        }
        if (url.pathname === "/api/characters") {
          const source = url.searchParams.get("source");
          if (!source || source.length > 256) return failure(400, "Source required");
          return Response.json({ characters: store.characters(source, url.searchParams.get("character") ?? undefined) },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (["/api/map", "/api/map/stream"].includes(url.pathname)) {
          const { source, guid } = store.resolve(url.searchParams);
          const panel = url.searchParams.get("panel") ?? "all";
          if (panel !== "all" && !PANELS.includes(panel as Panel)) return failure(400, "Invalid panel");
          if (url.pathname === "/api/map") {
            return Response.json(store.view(source, guid, panel as Panel | "all"), {
              headers: { "Cache-Control": "no-store" },
            });
          }
          if (streams.size >= 128) return failure(503, "Stream capacity reached");
          server.timeout(request, 0);
          let close = () => {};
          const connection = snapshotStream(store, source, guid, request.signal, () => streams.delete(close),
            panel as Panel | "all");
          close = connection.close;
          if (!connection.closed) streams.add(close);
          return new Response(connection.stream, { headers: { "Content-Type": "text/event-stream",
            "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
        }
        return failure(404, "Not found");
      } catch (error) {
        if (error instanceof SelectionError) return failure(error.status, error.message);
        diagnostic("Map widget request failed");
        return failure(500, "Internal error");
      }
    },
  });
  return { server, store, get activeRequests() { return active; }, stop() {
    stopPromise ??= (async () => {
      stopping = true;
      for (const close of streams) close();
      await server.stop(true);
      options.artwork?.close();
    })();
    return stopPromise;
  } };
}
