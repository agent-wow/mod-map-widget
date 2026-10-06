// SPDX-License-Identifier: GPL-2.0-or-later
/** @typedef {import('../schema.ts').View} View */

// Presence and motion travel independently. Keep the last confirmed position during a brief
// revision gap, but never extend its lifetime with heartbeats that advertise missing motion.
export class MotionFreshness {
  identity = "";
  confirmedAt = -Infinity;

  /** @param {View | null} view @param {number} receivedAt */
  observe(view, receivedAt) {
    const identity = view ? JSON.stringify([view.source_id, view.process_id, view.catalog_revision, view.guid]) : "";
    if (identity !== this.identity || view?.presence !== "online") this.confirmedAt = -Infinity;
    this.identity = identity;
    if (!view || view.presence !== "online" || view.stale) return false;
    const motion = view.panels.motion, expected = view.revisions?.motion;
    const current = !!motion && (expected ? BigInt(motion.sequence) >= BigInt(expected) : !motion.stale);
    if (current) this.confirmedAt = receivedAt - view.age_ms;
    return current;
  }

  /** @param {number} now */
  available(now) { return now - this.confirmedAt < 5000; }
}
