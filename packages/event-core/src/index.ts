/**
 * event-core — the kernel.
 *
 * Owns the append-only log, ordering, snapshots, replay, and reducer
 * registration. Knows nothing about tasks, agents, UI, or AI vendors: it moves,
 * persists, orders and replays opaque records and runs reducers registered by
 * higher layers.
 *
 * This package is the bottom of the dependency stack. It imports nothing from
 * this repo — see docs/architecture/packages.md.
 *
 * Contract to implement (Phase 1.1–1.4, docs/development/roadmap.md):
 *   append(event)          → persist, allocate seq, acknowledge after durable
 *   subscribe(handler)     → live stream for Canvas / Pulse / menu bar
 *   replay(from)           → deterministic re-run from seq 0
 *   registerReducer(fn)    → pure (state, event) => state
 */

/** Stable per-project identifier, e.g. `proj_oldwebsite`. */
export type ProjectId = string & { readonly __brand: "ProjectId" };

/**
 * Per-project monotonic ordinal. Replay order is defined by `seq`, never by
 * wall-clock time — see docs/architecture/event-core.md.
 */
export type Seq = number & { readonly __brand: "Seq" };

/** Sortable unique event id (ULID), e.g. `evt_01H...`. */
export type EventId = string & { readonly __brand: "EventId" };

export const PACKAGE = "event-core" as const;
