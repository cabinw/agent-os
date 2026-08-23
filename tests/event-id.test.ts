import { describe, expect, it } from "vitest";
import {
  createEventIdGenerator,
  isEventId,
  newEventId,
  parseEventId,
} from "../packages/event-core/src/id.js";

const MAX_TIMESTAMP = 2 ** 48 - 1;

function fill(byte: number): (bytes: Uint8Array) => void {
  return (bytes) => bytes.fill(byte);
}

describe("Event ID", () => {
  it("generates the canonical evt_ + uppercase Crockford ULID shape", () => {
    const id = newEventId();

    expect(id).toMatch(/^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(id).toHaveLength(30);
    expect(isEventId(id)).toBe(true);
    expect(parseEventId(id)).toBe(id);
  });

  it("supports deterministic clock and random sources", () => {
    const next = createEventIdGenerator({ clock: () => 0, random: fill(0) });

    expect(next()).toBe("evt_00000000000000000000000000");
    expect(next()).toBe("evt_00000000000000000000000001");
  });

  it("sorts by time even when newly sampled randomness is smaller", () => {
    const timestamps = [1_000, 1_001, 1_002];
    let randomByte = 0xff;
    const next = createEventIdGenerator({
      clock: () => timestamps.shift() ?? 1_002,
      random: (bytes) => {
        bytes.fill(randomByte);
        randomByte = 0;
      },
    });
    const ids = [next(), next(), next()];

    expect(ids).toEqual([...ids].sort());
  });

  it("is strictly monotonic within one millisecond", () => {
    const next = createEventIdGenerator({ clock: () => 42, random: fill(0x7f) });
    const ids = Array.from({ length: 200 }, next);

    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays monotonic when the wall clock moves backwards", () => {
    const timestamps = [100, 99, 98, 101];
    const next = createEventIdGenerator({
      clock: () => timestamps.shift() ?? 101,
      random: fill(0),
    });
    const ids = [next(), next(), next(), next()];

    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("advances logical time instead of wrapping an exhausted random field", () => {
    const next = createEventIdGenerator({ clock: () => 42, random: fill(0xff) });
    const at42 = createEventIdGenerator({ clock: () => 42, random: fill(0xff) })();
    const at43 = createEventIdGenerator({ clock: () => 43, random: fill(0xff) })();

    expect(next()).toBe(at42);
    expect(next()).toBe(at43);
  });

  it("fails safely rather than wrapping the complete ULID space", () => {
    const next = createEventIdGenerator({
      clock: () => MAX_TIMESTAMP,
      random: fill(0xff),
    });

    expect(next()).toBe(`evt_7${"Z".repeat(25)}`);
    expect(next).toThrowError(new RangeError("Event ID space exhausted"));
  });

  it("does not advance state or synthesize ids when entropy stays unavailable", () => {
    let calls = 0;
    const next = createEventIdGenerator({
      clock: () => 42,
      random: () => {
        calls += 1;
        throw new Error("entropy down");
      },
    });

    expect(next).toThrowError("entropy down");
    expect(next).toThrowError("entropy down");
    expect(calls).toBe(2);
  });

  it("retries entropy sampling after failure before committing a new timestamp", () => {
    let calls = 0;
    const next = createEventIdGenerator({
      clock: () => 42,
      random: (bytes) => {
        calls += 1;
        if (calls === 1) throw new Error("entropy down");
        bytes.fill(1);
      },
    });
    const expected = createEventIdGenerator({ clock: () => 42, random: fill(1) })();

    expect(next).toThrowError("entropy down");
    expect(next()).toBe(expected);
    expect(calls).toBe(2);
  });

  it("does not advance logical time when overflow entropy sampling fails", () => {
    let calls = 0;
    const next = createEventIdGenerator({
      clock: () => 42,
      random: (bytes) => {
        calls += 1;
        if (calls === 1) return bytes.fill(0xff);
        if (calls === 2) throw new Error("entropy down");
        return bytes.fill(0);
      },
    });
    const at42 = createEventIdGenerator({ clock: () => 42, random: fill(0xff) })();
    const at43 = createEventIdGenerator({ clock: () => 43, random: fill(0) })();

    expect(next()).toBe(at42);
    expect(next).toThrowError("entropy down");
    expect(next()).toBe(at43);
    expect(calls).toBe(3);
  });

  it("rejects invalid clock output", () => {
    for (const timestamp of [-1, 1.5, Number.NaN, MAX_TIMESTAMP + 1]) {
      const next = createEventIdGenerator({ clock: () => timestamp, random: fill(0) });
      expect(next).toThrow(RangeError);
    }
  });

  it.each([
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "evt_01ARZ3NDEKTSV4RRFFQ69G5FA",
    "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV0",
    "evt_01arz3ndektsv4rrffq69g5fav",
    "evt_01ARZ3NDEKTSV4RRFFQ69G5FAI",
    "evt_81ARZ3NDEKTSV4RRFFQ69G5FAV",
    " evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  ])("strictly rejects non-canonical value %j", (value) => {
    expect(isEventId(value)).toBe(false);
    expect(() => parseEventId(value)).toThrowError(new TypeError("Invalid Event ID"));
  });

  it("rejects non-string values without coercing them", () => {
    for (const value of [
      null,
      undefined,
      0,
      {},
      new String("evt_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    ]) {
      expect(isEventId(value)).toBe(false);
      expect(() => parseEventId(value)).toThrow(TypeError);
    }
  });
});
