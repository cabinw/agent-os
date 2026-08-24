import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "../apps/macos/node_modules/react-dom/server.js";
import React from "../apps/macos/node_modules/react/index.js";
import {
  type ConversationProjectViewModel,
  ThreadsReader,
  createHumanMessageIntent,
} from "../apps/macos/src/Threads.js";

const actor = (kind: "agent" | "human", id: string) => ({ kind, id });
const message = (
  id: string,
  seq: number,
  from: string,
  type: "question" | "answer" | "progress",
  content: string,
  replyTo?: string,
) => ({
  kind: "message" as const,
  event: {
    id,
    seq,
    at: `2026-08-24T09:${String(seq).padStart(2, "0")}:00Z`,
    actor: actor(from === "human" ? "human" : "agent", from),
    type: "message.sent" as const,
    payload: {
      from,
      to: from === "human" ? "codex" : "human",
      type,
      content,
      ...(replyTo === undefined ? {} : { replyTo }),
    },
  },
});

const CONVERSATION: ConversationProjectViewModel = {
  threads: {
    "task-webhook": {
      task: "task-webhook",
      title: "Implement webhook idempotency",
      status: "running",
      progress: 100,
      executor: "codex",
      items: [
        message(
          "evt-question",
          1,
          "codex",
          "question",
          "Should retries use an idempotency key?",
        ),
        {
          kind: "divider",
          event: {
            id: "evt-blocked",
            seq: 2,
            at: "2026-08-24T09:02:00Z",
            type: "task.blocked",
            payload: { reason: "Waiting for a human decision" },
          },
        },
        message(
          "evt-answer",
          3,
          "human",
          "answer",
          "Use the request id as the idempotency key.",
          "evt-question",
        ),
        {
          kind: "divider",
          event: {
            id: "evt-unblocked",
            seq: 4,
            at: "2026-08-24T09:04:00Z",
            type: "task.unblocked",
            payload: { resolution: "Decision recorded" },
          },
        },
        {
          kind: "progress-run",
          events: [
            message("evt-p1", 5, "codex", "progress", "50%").event,
            message("evt-p2", 6, "codex", "progress", "100%").event,
          ],
        },
      ],
    },
    "task-database": {
      task: "task-database",
      title: "Plan database migration",
      status: "review",
      progress: 100,
      executor: "grok",
      items: [
        {
          kind: "message",
          event: {
            id: "evt-database",
            seq: 7,
            at: "2026-08-24T09:07:00Z",
            actor: actor("agent", "grok"),
            type: "message.sent",
            payload: {
              from: "grok",
              to: "human",
              type: "answer",
              content: "The database migration is ready for review.",
            },
          },
        },
      ],
    },
    $project: { items: [] },
  },
};

describe("RM-3.7 macOS conversation reader", () => {
  it("weaves question, blocker, answer, and resolution in one ordered transcript", () => {
    const html = renderToStaticMarkup(
      <ThreadsReader conversation={CONVERSATION} locale="en" task="task-webhook" />,
    );
    const markers = [
      "Should retries",
      "task.blocked",
      "Use the request id",
      "task.unblocked",
    ];
    const positions = markers.map((marker) => html.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(html).toContain("Waiting for a human decision");
    expect(html).toContain("Decision recorded");
  });

  it("renders same-thread reply evidence and keeps progress runs hidden by default", () => {
    const html = renderToStaticMarkup(
      <ThreadsReader conversation={CONVERSATION} locale="en" task="task-webhook" />,
    );
    expect(html).toContain("↳ codex: Should retries");
    expect(html).toContain("Source event · evt-answer");
    expect(html).not.toContain("50%");
    expect(html).toContain("Show progress updates");
    expect(html).toContain("Read-only");
  });

  it("pins the project thread below task threads", () => {
    const html = renderToStaticMarkup(
      <ThreadsReader conversation={CONVERSATION} locale="en" />,
    );
    expect(html.indexOf("Implement webhook idempotency")).toBeLessThan(
      html.indexOf("Project thread"),
    );
  });

  it("renders truthful pending and no-thread states", () => {
    const pending = renderToStaticMarkup(
      <ThreadsReader conversation={null} locale="en" />,
    );
    const empty = renderToStaticMarkup(
      <ThreadsReader conversation={{ threads: {} }} locale="en" />,
    );
    expect(pending).toContain("Waiting for the conversation projection");
    expect(pending).toContain("no sample conversations are inserted");
    expect(empty).toContain("No threads yet");
  });

  it("searches across threads and lands on the matching transcript", () => {
    const html = renderToStaticMarkup(
      <ThreadsReader
        conversation={CONVERSATION}
        locale="en"
        initialQuery="database migration"
      />,
    );
    expect(html).toContain("Plan database migration");
    expect(html).toContain("ready for review");
    expect(html).not.toContain("Implement webhook idempotency");
  });

  it("filters thread membership by participant", () => {
    const html = renderToStaticMarkup(
      <ThreadsReader conversation={CONVERSATION} locale="en" initialParticipant="grok" />,
    );
    expect(html).toContain("Plan database migration");
    expect(html).not.toContain("Implement webhook idempotency");
    expect(html).toContain("All participants");
  });

  it("embeds the same reader at one task scope without the master list", () => {
    const html = renderToStaticMarkup(
      <ThreadsReader
        conversation={CONVERSATION}
        locale="en"
        task="task-webhook"
        embedded
      />,
    );
    expect(html).toContain('data-embedded="true"');
    expect(html).toContain("Implement webhook idempotency");
    expect(html).not.toContain("Plan database migration");
    expect(html).not.toContain("Search all threads");
  });

  it("creates a frozen message-only human intent with no approval authority", () => {
    const intent = createHumanMessageIntent(
      { task: "task-webhook", executor: "codex" },
      "Use the reviewed idempotency plan.",
    );
    expect(intent).toEqual({
      to: "codex",
      type: "instruction",
      content: "Use the reviewed idempotency plan.",
      task: "task-webhook",
    });
    expect(Object.keys(intent).sort()).toEqual(["content", "task", "to", "type"]);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(intent).not.toHaveProperty("actor");
    expect(intent).not.toHaveProperty("approval");
    expect(() => createHumanMessageIntent({}, "  guidance")).toThrow(/trimmed/);
    expect(createHumanMessageIntent({}, "Project guidance").to).toBe("*");
  });

  it("renders the composer only with enabled sourced policy and a trusted client", () => {
    const client = { sendMessage: async () => {} };
    const enabled = renderToStaticMarkup(
      <ThreadsReader
        conversation={CONVERSATION}
        locale="en"
        task="task-webhook"
        postingPolicy={{ enabled: true, sourceEvents: ["evt-policy"] }}
        postingClient={client}
      />,
    );
    expect(enabled).toContain("Send human guidance to the current thread");
    expect(enabled).toContain("it cannot approve a pending request");
    expect(enabled).toContain("Policy sources 1");

    const disabled = renderToStaticMarkup(
      <ThreadsReader
        conversation={CONVERSATION}
        locale="en"
        task="task-webhook"
        postingPolicy={{ enabled: false, sourceEvents: ["evt-created"] }}
        postingClient={client}
      />,
    );
    expect(disabled).not.toContain("Send human guidance to the current thread");
    expect(disabled).toContain("Read-only");
  });

  it("fails closed when policy is enabled without the trusted client", () => {
    const html = renderToStaticMarkup(
      <ThreadsReader
        conversation={CONVERSATION}
        locale="en"
        task="task-webhook"
        postingPolicy={{ enabled: true, sourceEvents: ["evt-policy"] }}
      />,
    );
    expect(html).toContain("trusted message client is not connected");
    expect(html).not.toContain("<textarea");
  });
});
