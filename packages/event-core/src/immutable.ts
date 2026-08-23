/** Recursively readonly protocol data. Functions are preserved as-is. */
export type DeepReadonly<Value> = Value extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? Value
  : Value extends (...args: never[]) => unknown
    ? Value
    : Value extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : Value extends object
        ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
        : Value;

/**
 * Freeze a parsed protocol value without trusting shallow `readonly` types.
 *
 * Event schemas only produce acyclic JSON-like values, but the WeakSet keeps
 * this utility safe if a future transform introduces a shared or cyclic object.
 */
export function deepFreeze<Value>(value: Value): DeepReadonly<Value> {
  const seen = new WeakSet<object>();

  function freeze(candidate: unknown): void {
    if (
      (typeof candidate !== "object" && typeof candidate !== "function") ||
      candidate === null
    ) {
      return;
    }
    if (seen.has(candidate)) return;
    seen.add(candidate);

    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor && "value" in descriptor) freeze(descriptor.value);
    }
    Object.freeze(candidate);
  }

  freeze(value);
  return value as DeepReadonly<Value>;
}
