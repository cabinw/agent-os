import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "../apps/macos/node_modules/react-dom/server.js";
import React from "../apps/macos/node_modules/react/index.js";
import {
  CanvasView,
  type ProjectCanvasViewModel,
  selectCanvasLayer,
} from "../apps/macos/src/Canvas.js";

const CANVAS: ProjectCanvasViewModel = {
  projects: [
    {
      project: "proj_canvas",
      name: "Agent OS",
      progress: 72,
      health: "attention",
      sourceEvents: ["evt_project"],
      nodes: [
        {
          id: "project:proj_canvas",
          project: "proj_canvas",
          kind: "project",
          label: "Agent OS",
          completed: false,
          sourceEvents: ["evt_project"],
        },
        {
          id: "goal:GOAL-CANVAS",
          project: "proj_canvas",
          kind: "goal",
          label: "GOAL-CANVAS",
          completed: false,
          sourceEvents: ["evt_task"],
        },
        {
          id: "agent:agent-codex",
          project: "proj_canvas",
          kind: "agent",
          label: "Codex",
          status: "working",
          completed: false,
          sourceEvents: ["evt_agent"],
        },
        {
          id: "task:TASK-001",
          project: "proj_canvas",
          kind: "task",
          label: "Event Core",
          status: "completed",
          progress: 100,
          executor: "agent-codex",
          dependsOn: [],
          completed: true,
          sourceEvents: ["evt_task", "evt_complete"],
        },
        {
          id: "task:TASK-002",
          project: "proj_canvas",
          kind: "task",
          label: "Canvas",
          status: "running",
          progress: 72,
          executor: "agent-codex",
          dependsOn: ["task:TASK-001"],
          completed: false,
          sourceEvents: ["evt_canvas"],
        },
        {
          id: "knowledge:KN-001",
          project: "proj_canvas",
          kind: "knowledge",
          label: "Use semantic zoom",
          status: "decision",
          completed: false,
          sourceEvents: ["evt_knowledge"],
        },
        {
          id: "resource:artifact-1",
          project: "proj_canvas",
          kind: "resource",
          label: "ui/canvas.png",
          completed: false,
          sourceEvents: ["evt_artifact"],
        },
      ],
      edges: [
        {
          from: "task:TASK-002",
          to: "agent:agent-codex",
          relation: "causedBy",
          event: "evt_canvas",
          eventType: "task.created",
          sourceEvents: ["evt_canvas", "evt_agent"],
        },
        {
          from: "knowledge:KN-001",
          to: "task:TASK-002",
          relation: "causedBy",
          event: "evt_knowledge",
          eventType: "knowledge.created",
          sourceEvents: ["evt_knowledge", "evt_canvas"],
        },
        {
          from: "resource:artifact-1",
          to: "knowledge:KN-001",
          relation: "causedBy",
          event: "evt_artifact",
          eventType: "artifact.produced",
          sourceEvents: ["evt_artifact", "evt_knowledge"],
        },
      ],
    },
  ],
};

describe("RM-4.4 macOS semantic Canvas", () => {
  it("renders the project universe as aggregated cards", () => {
    const html = renderToStaticMarkup(<CanvasView canvas={CANVAS} locale="en" />);
    expect(html).toContain('data-level="universe"');
    expect(html).toContain("Project universe");
    expect(html).toContain("Agent OS");
    expect(html).not.toContain('data-relation="causedBy"');
  });

  it("renders mission nodes and only causedBy edges", () => {
    const html = renderToStaticMarkup(
      <CanvasView canvas={CANVAS} locale="en" initialLevel="mission" />,
    );
    expect(html).toContain('data-level="mission"');
    expect(html.match(/data-relation="causedBy"/gu)).toHaveLength(3);
    expect(html).toContain('data-kind="goal"');
    expect(html).toContain('data-kind="resource"');
    expect(html).toContain('data-completed="true"');
  });

  it("projects an agent workspace without project or goal aggregation nodes", () => {
    const layer = selectCanvasLayer(
      CANVAS,
      "workspace",
      "proj_canvas",
      "agent:agent-codex",
    );
    expect(layer.nodes.map((node) => node.kind)).toEqual([
      "agent",
      "task",
      "task",
      "knowledge",
      "resource",
    ]);
    expect(layer.edges).toHaveLength(3);
    expect(layer.agent).toBe("agent:agent-codex");
  });

  it("renders pan, visual zoom, selection and evidence inspection affordances", () => {
    const html = renderToStaticMarkup(
      <CanvasView canvas={CANVAS} locale="zh-CN" initialLevel="workspace" />,
    );
    expect(html).toContain('aria-label="画布平移与视觉缩放"');
    expect(html).toContain('aria-label="向左平移"');
    expect(html).toContain('aria-label="放大画布"');
    expect(html).toContain("选择节点以检查状态与来源事件");
    expect(html).toContain("智能体焦点");
  });

  it("shows a sourced empty state", () => {
    const html = renderToStaticMarkup(<CanvasView canvas={null} locale="en" />);
    expect(html).toContain("Canvas is waiting for sourced events");
  });
});
