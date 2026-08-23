/**
 * Spike storage: an append-only JSONL file.
 *
 * **This is the throwaway part.** Phase 1.1b replaces it with SQLite + WAL,
 * proper transactional seq allocation, idempotency tokens, and snapshots
 * (docs/development/roadmap.md). What survives is everything built on top of
 * it, because nothing above this file knows how events are stored.
 *
 * What it does implement, because they are the properties the architecture
 * rests on:
 *   - append-only, never edit or delete
 *   - per-project monotonic `seq`, assigned at append
 *   - replay from seq 0 reproduces state exactly
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export class EventLog {
  #path;
  #events = [];
  #seq = 0;
  #subscribers = new Set();
  #needsSeparator = false;

  constructor(path) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.#replayFromDisk();
  }

  /**
   * Rebuild in-memory state from the file. Corrupt lines are skipped loudly
   * rather than silently — a half-written final line is the expected failure
   * mode of an append-only file after a crash.
   */
  #replayFromDisk() {
    if (!existsSync(this.#path)) return;
    const raw = readFileSync(this.#path, "utf8");
    this.#needsSeparator = raw.length > 0 && !raw.endsWith("\n");
    let skipped = 0;

    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const evt = JSON.parse(t);
        this.#events.push(evt);
        if (typeof evt.seq === "number" && evt.seq > this.#seq) this.#seq = evt.seq;
      } catch {
        skipped++;
      }
    }

    if (skipped > 0) {
      console.warn(
        `[log] 跳过 ${skipped} 行损坏记录（append-only 文件崩溃后的常见形态）`,
      );
    }
  }

  /**
   * Append an event. `seq` is assigned here — allocation belongs inside the
   * write, not at construction, or two concurrent producers could collide.
   * Durable before the caller is told it succeeded.
   */
  append(event) {
    const stored = { ...event, seq: ++this.#seq };
    const separator = this.#needsSeparator ? "\n" : "";
    appendFileSync(this.#path, `${separator}${JSON.stringify(stored)}\n`);
    this.#needsSeparator = false;
    this.#events.push(stored);
    for (const fn of this.#subscribers) fn(stored);
    return stored;
  }

  /** Every event from seq 0. Replaying this must reproduce current state. */
  replay() {
    return this.#events.slice();
  }

  get size() {
    return this.#events.length;
  }

  get seq() {
    return this.#seq;
  }

  get path() {
    return this.#path;
  }

  /** @param {(e: object) => void} fn */
  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }
}
