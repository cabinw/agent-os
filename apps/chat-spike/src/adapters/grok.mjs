/**
 * Grok — subprocess + stdout JSONL, and the only vendor of the four that
 * streams its reasoning separately from its answer.
 *
 * A trivial turn produced 42 `thought` events against 2 `text` events, which is
 * why the UI folds reasoning by default: rendered inline it buries the answer,
 * dropped entirely it wastes Grok's one differentiating signal.
 */

import { SubprocessAdapter } from "./base.mjs";

export class GrokAdapter extends SubprocessAdapter {
  static id = "grok";
  static label = "Grok";
  static capabilities = {
    streaming: true,
    thoughts: true,
    session: true,
    usage: true,
  };

  buildCommand(prompt, resume) {
    const args = ["--single", prompt, "--output-format", "streaming-json"];
    if (resume) args.push("--resume", resume);
    if (this.model) args.push("-m", this.model);
    return { cmd: this.executable, args };
  }

  handleLine(o) {
    switch (o.type) {
      case "text":
        if (o.data) this.onEvent({ kind: "delta", text: o.data });
        return { text: o.data ?? "" };

      case "thought":
        if (o.data) this.onEvent({ kind: "thought", text: o.data });
        return undefined;

      case "end": {
        const u = o.usage;
        if (u) {
          this.onEvent({
            kind: "usage",
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            total: u.total_tokens ?? 0,
            costUsd: o.total_cost_usd,
          });
        }
        return o.sessionId ? { sessionId: o.sessionId } : undefined;
      }

      default:
        return undefined;
    }
  }
}
