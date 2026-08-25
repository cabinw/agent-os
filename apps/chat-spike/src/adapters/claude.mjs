/**
 * Claude Code — subprocess + stdout JSONL.
 *
 * Token streaming needs `--include-partial-messages`; without it the whole
 * answer arrives as a single `assistant` event. Measured ~5.5s on a trivial
 * turn, the fastest of the four.
 */

import { SubprocessAdapter } from "./base.mjs";

export class ClaudeAdapter extends SubprocessAdapter {
  static id = "claude";
  static label = "Claude";
  static capabilities = {
    streaming: true,
    thoughts: false,
    session: true,
    usage: true,
  };

  /** The `result` event carries the authoritative text; deltas are a preview. */
  #final = null;

  buildCommand(prompt, resume) {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    if (resume) args.push("--resume", resume);
    if (this.model) args.push("--model", this.model);
    return { cmd: this.executable, args };
  }

  handleLine(o) {
    switch (o.type) {
      case "stream_event": {
        const d = o.event?.delta;
        if (d?.type === "text_delta" && d.text) {
          this.onEvent({ kind: "delta", text: d.text });
        }
        return undefined;
      }

      case "system":
        this.onEvent({ kind: "progress", label: o.subtype ?? "system" });
        return o.session_id ? { sessionId: o.session_id } : undefined;

      case "rate_limit_event":
        this.onEvent({ kind: "progress", label: "rate limit" });
        return undefined;

      case "result": {
        const u = o.usage;
        if (u) {
          const input = u.input_tokens ?? 0;
          const output = u.output_tokens ?? 0;
          this.onEvent({ kind: "usage", input, output, total: input + output });
        }
        this.#final = typeof o.result === "string" ? o.result : null;
        return o.session_id ? { sessionId: o.session_id } : undefined;
      }

      default:
        return undefined;
    }
  }

  async send(prompt, options) {
    this.#final = null;
    const r = await super.send(prompt, options);
    return { ...r, text: (this.#final ?? r.text).trim() };
  }
}
