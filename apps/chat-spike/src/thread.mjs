/**
 * The thread reducer — docs/product/threads.md, ADR-006.
 *
 * A pure fold over events. Same log in, same thread out, every time: that is
 * what makes the UI a projection rather than a second source of truth
 * (ADR-005). Nothing here reaches for storage, a clock, or a network.
 *
 * A thread is scoped to a task; messages sent without one land in the project
 * thread, which is all the spike has.
 *
 * Interleaving is the point. A thread showing only messages reads as
 * disembodied chat; folding in lifecycle events makes it a record of the work.
 */

/** @returns {{items: object[], agents: Record<string, object>}} */
export function emptyThread() {
  return { items: [], agents: {} };
}

/**
 * Two things the log deliberately does **not** carry, and why:
 *
 *  - `ms` (turn latency) is *derived* here from the causal chain, not stored.
 *    A field that can be reduced from the log must not also be written to it.
 *  - `fresh` (vendor cold start) is not in the log at all. It describes the
 *    adapter's session, not the project, so it is live telemetry that replay
 *    correctly forgets.
 *
 * @param {ReturnType<typeof emptyThread>} state
 * @param {object} evt
 */
export function reduce(state, evt) {
  switch (evt.type) {
    case "agent.registered": {
      const { id, name, provider, capabilities, integration } = evt.payload;
      return {
        ...state,
        agents: {
          ...state.agents,
          [id]: { id, name, provider, capabilities, integration },
        },
        items: [
          ...state.items,
          {
            kind: "divider",
            id: evt.id,
            at: evt.at,
            seq: evt.seq,
            label: `${name} 加入会话`,
            tone: "neutral",
          },
        ],
      };
    }

    case "message.sent": {
      const { from, to, content, type } = evt.payload;

      // Latency is the gap to the message this one answers — derived, never stored.
      let ms;
      if (evt.causedBy) {
        const cause = state.items.find((i) => i.id === evt.causedBy);
        if (cause) ms = Date.parse(evt.at) - Date.parse(cause.at);
      }

      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "message",
            id: evt.id,
            at: evt.at,
            seq: evt.seq,
            actorKind: evt.actor.kind,
            from,
            to,
            messageType: type,
            text: content,
            agent: state.agents[from] ?? null,
            ...(ms !== undefined ? { ms } : {}),
          },
        ],
      };
    }

    default:
      // An unknown type is not an error — old logs outlive the code that reads
      // them, and a reducer that throws on one can never replay history.
      return state;
  }
}

/** Fold a whole log. This is the definition of "the thread". */
export function project(events) {
  return events.reduce(reduce, emptyThread());
}
