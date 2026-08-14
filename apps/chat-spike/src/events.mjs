/**
 * The event envelope, as specified in docs/architecture/event-core.md.
 *
 * The spike uses the real shape rather than a simplified one, so that what it
 * teaches transfers directly to Phase 1.1 instead of having to be re-learned.
 *
 *   { id, type, seq, project, actor, subject, at, causedBy, payload }
 *
 * Only types listed in docs/protocol/event-catalog.md may appear here —
 * `pnpm check:layers` enforces that mechanically.
 */

/** Crockford base32, per the ULID spec. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastMs = 0;
let lastRand = [];

/**
 * ULID: 48-bit timestamp + 80 bits of randomness, lexicographically sortable.
 * The spec's example ids (`evt_01H…`) are ULIDs; sortability is why.
 * Monotonic within a millisecond so two events in the same tick still order.
 */
function ulid() {
  const now = Date.now();
  let time = "";
  let t = now;
  for (let i = 9; i >= 0; i--) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }

  if (now === lastMs) {
    // Same millisecond: increment the previous random part rather than redraw,
    // so ids stay strictly increasing.
    for (let i = lastRand.length - 1; i >= 0; i--) {
      if (lastRand[i] < 31) {
        lastRand[i]++;
        break;
      }
      lastRand[i] = 0;
    }
  } else {
    lastMs = now;
    lastRand = Array.from({ length: 16 }, () => Math.floor(Math.random() * 32));
  }

  return time + lastRand.map((n) => B32[n]).join("");
}

export const newEventId = () => `evt_${ulid()}`;

/**
 * Build an envelope. `seq` is assigned by the store, not here — allocation has
 * to happen inside the append transaction to stay monotonic.
 *
 * @param {object} o
 * @param {string} o.type       must exist in the event catalog
 * @param {string} o.project
 * @param {{kind: string, id: string}} o.actor
 * @param {{kind: string, id: string}} [o.subject]
 * @param {string} [o.causedBy]
 * @param {object} o.payload
 */
export function makeEvent({ type, project, actor, subject, causedBy, payload }) {
  return {
    id: newEventId(),
    type,
    seq: null,
    project,
    actor,
    ...(subject ? { subject } : {}),
    at: new Date().toISOString(),
    ...(causedBy ? { causedBy } : {}),
    payload,
  };
}
