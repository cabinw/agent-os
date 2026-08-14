/**
 * Boundary validation for the MCP tools.
 *
 * Hand-rolled rather than pulled from a library so the rule the specs care
 * about stays legible: **unknown fields are rejected, not ignored**
 * (docs/protocol/mcp-protocol.md). Packages will use Zod `.strict()`; here the
 * behaviour is the lesson, so it is written out.
 */

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/** The type vocabulary a spec may use. Adding a type means adding a check. */
const CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  "string[]": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
};

/**
 * @param {object} spec  field → { type, required?, enum? }
 * @param {object} input
 * @returns {object} the accepted value, with nothing the spec did not name
 */
export function validate(spec, input, label = "params") {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError(`${label} 必须是对象`);
  }

  // Rejecting first is deliberate: a typo'd field name must fail loudly rather
  // than silently doing nothing, which is how protocol drift starts.
  const unknown = Object.keys(input).filter((k) => !(k in spec));
  if (unknown.length > 0) {
    throw new ValidationError(
      `${label} 含未知字段：${unknown.join(", ")}（已知字段：${Object.keys(spec).join(", ")}）`,
    );
  }

  const out = {};
  for (const [key, rule] of Object.entries(spec)) {
    const value = input[key];

    if (value === undefined || value === null) {
      if (rule.required) throw new ValidationError(`${label}.${key} 是必填的`);
      continue;
    }

    if (!CHECKS[rule.type]) throw new ValidationError(`spec 里未知的类型 ${rule.type}`);
    if (!CHECKS[rule.type](value)) {
      throw new ValidationError(
        `${label}.${key} 必须是 ${rule.type}，收到 ${Array.isArray(value) ? "array" : typeof value}`,
      );
    }

    if (rule.enum && !rule.enum.includes(value)) {
      throw new ValidationError(
        `${label}.${key} 必须是 ${rule.enum.join(" | ")} 之一，收到 "${value}"`,
      );
    }

    if (rule.type === "string" && rule.required && value.trim() === "") {
      throw new ValidationError(`${label}.${key} 不能为空`);
    }

    out[key] = value;
  }

  return out;
}
