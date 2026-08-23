import { fileURLToPath } from "node:url";
import { SubprocessAdapter } from "../../apps/chat-spike/src/adapters/base.mjs";
import { runRunnerWorker } from "../../apps/chat-spike/src/runner-worker.mjs";

const CLI_FIXTURE = fileURLToPath(new URL("./runner-cli.mjs", import.meta.url));

class RemoteTaskFixtureAdapter extends SubprocessAdapter {
  static id = "claude";
  static label = "Remote task CLI fixture";
  static capabilities = {
    streaming: true,
    thoughts: false,
    session: true,
    usage: true,
  };

  buildCommand(prompt, resume) {
    return { cmd: process.execPath, args: [CLI_FIXTURE, prompt, resume ?? ""] };
  }

  handleLine(line) {
    if (line.type === "delta") {
      this.onEvent({ kind: "delta", text: line.text });
      return undefined;
    }
    if (line.type === "progress") {
      this.onEvent({ kind: "progress", label: line.label });
      return undefined;
    }
    if (line.type === "usage") {
      this.onEvent({
        kind: "usage",
        input: line.input,
        output: line.output,
        total: line.total,
      });
      return undefined;
    }
    return { text: line.text, sessionId: line.sessionId };
  }

  async send(prompt, options) {
    const result = await super.send(prompt, options);
    await this.mcp.reportResult();
    return result;
  }
}

await runRunnerWorker({
  adapterCatalog: [RemoteTaskFixtureAdapter],
  getAdapterImpl: (id) =>
    id === RemoteTaskFixtureAdapter.id ? RemoteTaskFixtureAdapter : null,
  mcpForImpl: (request, _workspace, { url, token }) => ({
    args: [],
    env: {},
    reportResult: async () => {
      if (!request.taskId) throw new Error("fixture taskId missing");
      const response = await fetch(`${url}/mcp/call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "report_result",
          arguments: {
            task: request.taskId,
            status: "completed",
            summary: "remote fixture delivered",
          },
        }),
      });
      if (!response.ok) {
        throw new Error(
          `fixture report_result failed: ${response.status} ${await response.text()}`,
        );
      }
    },
  }),
});
