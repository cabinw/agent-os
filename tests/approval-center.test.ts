import { beforeEach, describe, expect, it } from "vitest";
import { newEventId, parseStoredEvent } from "../packages/event-core/src/index.js";
import type {
  EventPayload,
  EventType,
  StoredEvent,
  Subject,
} from "../packages/event-core/src/index.js";
import {
  type ApprovalCenterError,
  admitApprovalIntent,
  buildApprovalCenter,
} from "../packages/mcp-server/src/index.js";

const PROJECT = "proj_approval_center";
const AGENT = "agent-requester";
const HUMAN = "human-owner";
let sequence = 0;
let history: StoredEvent[] = [];

function subject(kind: Subject["kind"], id: string): Subject {
  return { kind, id } as Subject;
}

function add<Type extends EventType>(
  type: Type,
  target: Subject,
  payload: EventPayload<Type>,
  actor: { kind: "agent" | "human" | "system"; id: string },
  at = "2026-08-24T12:00:00Z",
  project = PROJECT,
): StoredEvent<Type> {
  sequence += 1;
  const event = parseStoredEvent({
    schemaVersion: 1,
    id: newEventId(),
    seq: sequence,
    type,
    project,
    actor,
    subject: target,
    at,
    payload,
  }) as StoredEvent<Type>;
  history.push(event);
  return event;
}

function request(
  id: string,
  options: Partial<
    Pick<EventPayload<"approval.requested">, "risk" | "reversible" | "task">
  > = {},
  at = "2026-08-24T12:00:00Z",
) {
  return add(
    "approval.requested",
    subject("approval", id),
    {
      action: `Deploy ${id}`,
      risk: options.risk ?? "medium",
      reversible: options.reversible ?? true,
      requestedBy: AGENT,
      ...(options.task === undefined ? {} : { task: options.task }),
      detail: `Deploy the signed ${id} build to the isolated staging project.`,
    },
    { kind: "agent", id: AGENT },
    at,
  );
}

function decide(
  id: string,
  type: "approval.granted" | "approval.rejected" | "approval.expired",
) {
  if (type === "approval.granted") {
    return add(
      type,
      subject("approval", id),
      { by: HUMAN, note: "Reviewed" },
      { kind: "human", id: HUMAN },
      "2026-08-24T13:00:00Z",
    );
  }
  if (type === "approval.rejected") {
    return add(
      type,
      subject("approval", id),
      { by: HUMAN, reason: "Blast radius is too large" },
      { kind: "human", id: HUMAN },
      "2026-08-24T13:00:00Z",
    );
  }
  return add(
    type,
    subject("approval", id),
    { after: "2026-08-24T12:30:00Z" },
    { kind: "system", id: "approval-timer" },
    "2026-08-24T13:00:00Z",
  );
}

function blockTask() {
  add(
    "task.created",
    subject("task", "TASK-001"),
    {
      title: "Remote activation",
      goal: "goal-approval",
      requires: ["ops"],
      priority: "high",
      dependsOn: [],
      requiresApproval: true,
    },
    { kind: "system", id: "task-engine" },
  );
  add(
    "task.assigned",
    subject("task", "TASK-001"),
    { executor: AGENT, matchedBy: "explicit" },
    { kind: "system", id: "task-engine" },
  );
  add(
    "task.started",
    subject("task", "TASK-001"),
    { executor: AGENT },
    { kind: "agent", id: AGENT },
  );
  return add(
    "task.blocked",
    subject("task", "TASK-001"),
    { reason: "Awaiting owner", severity: "high", needs: "human" },
    { kind: "agent", id: AGENT },
  );
}

function center() {
  return buildApprovalCenter({ project: PROJECT as never, history });
}

beforeEach(() => {
  sequence = 0;
  history = [];
});

describe("RM-3.4 · sourced Approval Center", () => {
  it("returns an honest deeply frozen normal state", () => {
    const view = center();
    expect(view).toEqual({
      project: PROJECT,
      icon: "normal",
      pendingCount: 0,
      blockerCount: 0,
      approvals: [],
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.approvals)).toBe(true);
  });

  it("retains request evidence and allows quick decisions only when safe", () => {
    const low = request("approval-low", { risk: "low", reversible: true });
    const medium = request("approval-medium", {
      risk: "medium",
      reversible: true,
    });
    const high = request("approval-high", { risk: "high", reversible: true });
    const irreversible = request("approval-irreversible", {
      risk: "low",
      reversible: false,
    });

    const view = center();
    expect(view.icon).toBe("waiting");
    expect(view.pendingCount).toBe(4);
    expect(
      Object.fromEntries(
        view.approvals.map((item) => [
          item.approval,
          [item.menuAction, item.sourceEvents],
        ]),
      ),
    ).toEqual({
      "approval-low": ["quick-decision", [low.id]],
      "approval-medium": ["quick-decision", [medium.id]],
      "approval-high": ["review-in-app", [high.id]],
      "approval-irreversible": ["review-in-app", [irreversible.id]],
    });
  });

  it.each(["approval.granted", "approval.rejected", "approval.expired"] as const)(
    "retains request plus %s evidence for terminal state",
    (type) => {
      const requested = request("approval-terminal");
      const terminal = decide("approval-terminal", type);

      expect(center().approvals[0]).toMatchObject({
        status: type.split(".")[1],
        menuAction: "none",
        sourceEvents: [requested.id, terminal.id],
      });
    },
  );

  it("uses waiting over attention and attention over normal", () => {
    blockTask();
    expect(center()).toMatchObject({ icon: "attention", blockerCount: 1 });
    request("approval-pending", { task: "TASK-001" as never });
    expect(center()).toMatchObject({ icon: "waiting", pendingCount: 1, blockerCount: 1 });
  });

  it("sorts pending first, then newest request deterministically", () => {
    request("approval-old", {}, "2026-08-24T10:00:00Z");
    request("approval-terminal", {}, "2026-08-24T11:00:00Z");
    decide("approval-terminal", "approval.granted");
    request("approval-new", {}, "2026-08-24T12:00:00Z");

    expect(center().approvals.map((item) => item.approval)).toEqual([
      "approval-new",
      "approval-old",
      "approval-terminal",
    ]);
  });

  it("rejects malformed, mixed, gapped and duplicated history", () => {
    request("approval-valid");
    const valid = history[0] as StoredEvent;
    const cases: Array<[unknown[], ApprovalCenterError["code"]]> = [
      [[{ bad: true }], "INVALID_HISTORY"],
      [[{ ...valid, project: "proj_other" }], "MIXED_PROJECT"],
      [[{ ...valid, seq: 2 }], "SEQUENCE_GAP"],
      [[valid, { ...valid, seq: 2 }], "DUPLICATE_EVENT"],
    ];
    for (const [candidate, code] of cases) {
      expect(() =>
        buildApprovalCenter({ project: PROJECT as never, history: candidate }),
      ).toThrowError(expect.objectContaining({ code }));
    }
  });

  it("wraps projection failures as invalid history", () => {
    const requested = request("approval-invalid");
    history.push({ ...requested, seq: 2 } as StoredEvent);
    expect(() => center()).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_EVENT" }),
    );

    sequence = 0;
    history = [];
    add(
      "approval.granted",
      subject("approval", "approval-missing"),
      { by: HUMAN },
      { kind: "human", id: HUMAN },
    );
    expect(() => center()).toThrowError(
      expect.objectContaining({ code: "INVALID_HISTORY" }),
    );
  });
});

describe("RM-3.4 · approval surface intent admission", () => {
  it("admits safe menu grants and reasoned rejects", () => {
    request("approval-safe", { risk: "medium", reversible: true });
    const view = center();
    expect(
      admitApprovalIntent(view, {
        surface: "menu-bar",
        action: "grant",
        approval: "approval-safe",
        note: "Within staging boundary",
      }),
    ).toEqual({
      surface: "menu-bar",
      action: "grant",
      approval: "approval-safe",
      note: "Within staging boundary",
    });
    expect(
      admitApprovalIntent(view, {
        surface: "menu-bar",
        action: "reject",
        approval: "approval-safe",
        reason: "Use a smaller blast radius",
      }),
    ).toMatchObject({ action: "reject", reason: "Use a smaller blast radius" });
  });

  it("forces high-risk and irreversible menu decisions into the app", () => {
    request("approval-high", { risk: "high", reversible: true });
    request("approval-irreversible", { risk: "low", reversible: false });
    const view = center();
    for (const approval of ["approval-high", "approval-irreversible"]) {
      for (const action of ["grant", "reject"] as const) {
        expect(() =>
          admitApprovalIntent(view, {
            surface: "menu-bar",
            action,
            approval,
            ...(action === "reject" ? { reason: "No" } : {}),
          }),
        ).toThrowError(expect.objectContaining({ code: "REVIEW_REQUIRED" }));
      }
      expect(
        admitApprovalIntent(view, {
          surface: "menu-bar",
          action: "review-in-app",
          approval,
        }),
      ).toEqual({ surface: "menu-bar", action: "review-in-app", approval });
    }
  });

  it("allows complete in-app review to grant a high-risk request", () => {
    request("approval-high", { risk: "critical", reversible: false });
    expect(
      admitApprovalIntent(center(), {
        surface: "app",
        action: "grant",
        approval: "approval-high",
      }),
    ).toEqual({ surface: "app", action: "grant", approval: "approval-high" });
  });

  it.each([undefined, "", "  ", " padded "])(
    "rejects an invalid rejection reason %j",
    (reason) => {
      request("approval-safe");
      expect(() =>
        admitApprovalIntent(center(), {
          surface: "app",
          action: "reject",
          approval: "approval-safe",
          ...(reason === undefined ? {} : { reason }),
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INTENT" }));
    },
  );

  it("rejects unknown fields instead of accepting actor or event authority", () => {
    request("approval-safe");
    for (const field of ["actor", "project", "task", "event", "status"]) {
      expect(() =>
        admitApprovalIntent(center(), {
          surface: "app",
          action: "grant",
          approval: "approval-safe",
          [field]: "forged",
        }),
      ).toThrowError(expect.objectContaining({ code: "INVALID_INTENT" }));
    }
  });

  it("rejects unknown, terminal and malformed approval intents", () => {
    request("approval-terminal");
    decide("approval-terminal", "approval.granted");
    const view = center();
    expect(() =>
      admitApprovalIntent(view, {
        surface: "app",
        action: "grant",
        approval: "approval-terminal",
      }),
    ).toThrowError(expect.objectContaining({ code: "NOT_PENDING" }));
    expect(() =>
      admitApprovalIntent(view, {
        surface: "app",
        action: "grant",
        approval: "approval-unknown",
      }),
    ).toThrowError(expect.objectContaining({ code: "UNKNOWN_APPROVAL" }));
    expect(() => admitApprovalIntent(view, null)).toThrowError(
      expect.objectContaining({ code: "INVALID_INTENT" }),
    );
    expect(() =>
      admitApprovalIntent(view, {
        surface: "app",
        action: "review-in-app",
        approval: "approval-terminal",
      }),
    ).toThrowError(expect.objectContaining({ code: "NOT_PENDING" }));
  });
});
