import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "../apps/macos/node_modules/react-dom/server.js";
import React from "../apps/macos/node_modules/react/index.js";
import {
  MemoryView,
  type ProjectMemoryViewModel,
  buildKnowledgeGraphLayout,
  filterMemoryResults,
} from "../apps/macos/src/Memory.js";

const MEMORY: ProjectMemoryViewModel = {
  project: "proj_memory",
  results: [
    {
      item: {
        id: "KN-001",
        project: "proj_memory",
        type: "decision",
        title: "Use SQLite",
        summary: "The first storage decision.",
        rationale: "Keep the local boundary small.",
        sourceEvents: ["evt_source_1"],
        relatedTasks: ["TASK-001"],
        author: { kind: "agent", id: "agent-codex" },
        at: "2026-08-20T10:00:00Z",
        createdEvent: "evt_kn_1",
        createdSeq: 2,
        supersededBy: "KN-002",
      },
      relations: [
        {
          kind: "related-task",
          from: "KN-001",
          to: "TASK-001",
          relation: "related-task",
        },
        {
          kind: "superseded-by",
          from: "KN-001",
          to: "KN-002",
          relation: "superseded-by",
        },
      ],
    },
    {
      item: {
        id: "KN-002",
        project: "proj_memory",
        type: "decision",
        title: "Use encrypted SQLite",
        summary: "The active storage decision.",
        rationale: "Protect local project memory.",
        alternatives: ["Plain SQLite"],
        sourceEvents: ["evt_source_2"],
        author: { kind: "human", id: "human-owner" },
        at: "2026-08-21T10:00:00Z",
        createdEvent: "evt_kn_2",
        createdSeq: 3,
        supersedes: "KN-001",
      },
      relations: [
        {
          kind: "supersedes",
          from: "KN-002",
          to: "KN-001",
          relation: "supersedes",
        },
        {
          kind: "linked",
          from: "KN-002",
          to: "measurement-security",
          relation: "validated-by",
          event: "evt_link",
        },
      ],
    },
  ],
};

describe("RM-4.5 macOS Memory list and graph", () => {
  it("normalizes one semantic graph without causedBy edges", () => {
    const graph = buildKnowledgeGraphLayout(MEMORY.results);
    expect(graph.nodes.map((node) => [node.id, node.kind])).toEqual([
      ["KN-001", "knowledge"],
      ["KN-002", "knowledge"],
      ["TASK-001", "task"],
      ["measurement-security", "entity"],
    ]);
    expect(graph.edges.map((edge) => edge.relation).sort()).toEqual([
      "related-task",
      "supersedes",
      "validated-by",
    ]);
    expect(graph.edges.some((edge) => edge.relation === "causedBy")).toBe(false);
  });

  it("retains explicit relation evidence and freezes layout deeply", () => {
    const graph = buildKnowledgeGraphLayout(MEMORY.results);
    expect(graph.edges.find((edge) => edge.relation === "validated-by")).toMatchObject({
      event: "evt_link",
      sourceEvents: ["evt_link"],
    });
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.isFrozen(graph.edges[0]?.sourceEvents)).toBe(true);
  });

  it("applies the same search, type, and status filter before either view", () => {
    expect(
      filterMemoryResults(MEMORY.results, "ENCRYPTED", "decision", "active"),
    ).toHaveLength(1);
    expect(
      filterMemoryResults(MEMORY.results, "sqlite", "decision", "superseded")[0]?.item.id,
    ).toBe("KN-001");
    expect(filterMemoryResults(MEMORY.results, "missing", "all", "all")).toEqual([]);
  });

  it("renders the list as the default first-class Memory view", () => {
    const html = renderToStaticMarkup(<MemoryView memory={MEMORY} locale="en" />);
    expect(html).toContain('data-view="list"');
    expect(html).toContain('data-status="superseded"');
    expect(html).toContain("Use encrypted SQLite");
    expect(html).toContain("evt_kn_2");
  });

  it("renders semantic graph nodes, relations, and inspector affordances", () => {
    const html = renderToStaticMarkup(
      <MemoryView memory={MEMORY} locale="en" initialView="graph" />,
    );
    expect(html).toContain('data-view="graph"');
    expect(html.match(/data-kind="knowledge"/gu)).toHaveLength(2);
    expect(html).toContain('data-kind="task"');
    expect(html).toContain('data-relation="validated-by"');
    expect(html).not.toContain('data-relation="causedBy"');
    expect(html).toContain("Select a knowledge node or relation to inspect its sources.");
  });

  it("renders a truthful sourced empty state", () => {
    const html = renderToStaticMarkup(<MemoryView memory={null} locale="en" />);
    expect(html).toContain("No project knowledge yet");
    expect(html).not.toContain("Use SQLite");
  });
});
