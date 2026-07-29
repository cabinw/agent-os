/**
 * Kimi — subprocess + stdout JSONL, keyed on `role` rather than `type`.
 *
 * The one vendor of the four with **no token streaming**: the answer arrives as
 * a single `{role:"assistant", content}` line after ~12s. It is the reason the
 * adapter contract declares capabilities instead of assuming them — a UI built
 * on Codex's behaviour would show a frozen pane here.
 */

import { SubprocessAdapter } from "./base.mjs";

export class KimiAdapter extends SubprocessAdapter {
  static id = "kimi";
  static label = "Kimi";
  static capabilities = {
    streaming: false,
    thoughts: false,
    session: true,
    usage: false,
  };

  buildCommand(prompt, resume) {
    const args = ["-p", prompt, "--output-format", "stream-json"];
    if (resume) args.push("-r", resume);
    if (this.model) args.push("-m", this.model);
    return { cmd: "kimi", args };
  }

  handleLine(o) {
    if (o.role === "assistant" && typeof o.content === "string") {
      return { text: o.content };
    }

    // Session id arrives on a meta line that also spells out the resume command.
    if (o.role === "meta" && o.type === "session.resume_hint") {
      this.onEvent({ kind: "progress", label: "session ready" });
      return { sessionId: o.session_id };
    }

    return undefined;
  }
}
