// SPDX-License-Identifier: GPL-2.0-or-later
import { PANELS } from "./schema.ts";
import type { Panel } from "./schema.ts";
import type { Store } from "./store.ts";

// Pull at most one panel at a time. Undelivered changes coalesce in Store, never in an event history.
export function snapshotStream(store: Store, source: string, guid: string, signal: AbortSignal,
  onClose: () => void = () => {}, panel: Panel | "all" = "all", highWaterMark = 4 * 1024 * 1024) {
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setInterval> | undefined;
  let identity = "";
  let header = "";
  let blocked = 0;
  let lastPing = performance.now();
  const delivered = new Map<Panel, string>();
  const encoder = new TextEncoder();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    unsubscribe(); signal.removeEventListener("abort", close); onClose();
  };
  const close = () => { if (!closed) { cleanup(); controller.close(); } };
  function send(event: string, value: unknown) {
    const bytes = encoder.encode(event ? `event: ${event}\ndata: ${JSON.stringify(value)}\n\n` : ": keepalive\n\n");
    if (bytes.length > highWaterMark) { close(); return false; }
    if ((controller.desiredSize ?? 0) < bytes.length) {
      blocked ||= performance.now();
      if (performance.now() - blocked > 15000) close();
      return false;
    }
    blocked = 0;
    controller.enqueue(bytes);
    lastPing = performance.now();
    return true;
  }
  function pump() {
    if (closed) return;
    const view = store.view(source, guid, panel);
    if (!view) {
      if (identity !== "waiting" && send("snapshot", null)) { identity = "waiting"; delivered.clear(); header = ""; }
    } else {
      const nextIdentity = `${view.process_id}:${view.catalog_revision}`;
      const nextHeader = `${view.sequence}:${view.presence}:${view.stale}`;
      const base = { ...view, panels: {} };
      if (identity !== nextIdentity) {
        if (send("snapshot", base)) { identity = nextIdentity; header = nextHeader; delivered.clear(); }
        return;
      }
      if (header !== nextHeader) {
        if (send("presence", base)) header = nextHeader;
        return;
      }
      for (const p of PANELS) {
        const data = view.panels[p];
        const signature = data ? `${data.sequence}:${data.stale}` : "";
        if (data && delivered.get(p) !== signature) {
          if (send("panel", { panel: p, ...data })) delivered.set(p, signature);
          return;
        }
      }
    }
    if (performance.now() - lastPing >= 15000) send("", null);
  }
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      unsubscribe = store.subscribe(pump);
      timer = setInterval(pump, 250);
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close();
      else pump();
    },
    pull() { pump(); },
    cancel() { cleanup(); },
  }, { highWaterMark, size: (chunk) => chunk?.byteLength ?? 0 });
  return { stream, close, get closed() { return closed; } };
}
