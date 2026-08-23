const EVENT_ID_PREFIX = "evt_";
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RANDOM_BYTES = 10;
const RANDOM_LENGTH = 16;
const TIME_LENGTH = 10;
const MAX_TIMESTAMP = 2 ** 48 - 1;
const MAX_RANDOM = (1n << 80n) - 1n;
const EVENT_ID_PATTERN = /^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Sortable unique event id: `evt_` followed by a canonical ULID. */
export type EventId = string & { readonly __brand: "EventId" };

export type EventIdClock = () => number;
export type EventIdRandom = (bytes: Uint8Array) => void;

export type EventIdGeneratorOptions = {
  readonly clock?: EventIdClock;
  readonly random?: EventIdRandom;
};

type CryptoWithRandomValues = {
  getRandomValues<T extends Uint8Array>(bytes: T): T;
};

function defaultRandom(bytes: Uint8Array): void {
  const crypto = (globalThis as { crypto?: CryptoWithRandomValues }).crypto;
  if (crypto === undefined) throw new Error("Secure random source is unavailable");
  crypto.getRandomValues(bytes);
}

function readTimestamp(clock: EventIdClock): number {
  const timestamp = clock();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP) {
    throw new RangeError(
      `Event ID clock must return an integer from 0 to ${MAX_TIMESTAMP}`,
    );
  }
  return timestamp;
}

function readRandom(random: EventIdRandom): bigint {
  const bytes = new Uint8Array(RANDOM_BYTES);
  random(bytes);

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function encodeBase32(value: bigint, length: number): string {
  const encoded = new Array<string>(length);
  let remaining = value;

  for (let index = length - 1; index >= 0; index -= 1) {
    encoded[index] = CROCKFORD_BASE32.charAt(Number(remaining & 31n));
    remaining >>= 5n;
  }

  if (remaining !== 0n) throw new RangeError("Value exceeds its base32 field");
  return encoded.join("");
}

/**
 * Creates an isolated monotonic Event ID generator.
 *
 * A clock rollback is treated like another call in the last logical millisecond.
 * If all 80 random bits overflow, the logical timestamp advances by one rather
 * than wrapping to a smaller id.
 */
export function createEventIdGenerator(
  options: EventIdGeneratorOptions = {},
): () => EventId {
  const clock = options.clock ?? Date.now;
  const random = options.random ?? defaultRandom;
  let lastTimestamp = -1;
  let lastRandom = 0n;

  return (): EventId => {
    const wallTimestamp = readTimestamp(clock);

    if (wallTimestamp > lastTimestamp) {
      const nextRandom = readRandom(random);
      lastTimestamp = wallTimestamp;
      lastRandom = nextRandom;
    } else if (lastRandom < MAX_RANDOM) {
      lastRandom += 1n;
    } else {
      if (lastTimestamp === MAX_TIMESTAMP) {
        throw new RangeError("Event ID space exhausted");
      }
      const nextRandom = readRandom(random);
      lastTimestamp += 1;
      lastRandom = nextRandom;
    }

    const ulid =
      encodeBase32(BigInt(lastTimestamp), TIME_LENGTH) +
      encodeBase32(lastRandom, RANDOM_LENGTH);
    return `${EVENT_ID_PREFIX}${ulid}` as EventId;
  };
}

/** Process-wide generator for ordinary event construction. */
export const newEventId = createEventIdGenerator();

/** Accepts only the canonical, uppercase `evt_` + ULID representation. */
export function isEventId(value: unknown): value is EventId {
  return typeof value === "string" && EVENT_ID_PATTERN.test(value);
}

/** Parse an untrusted value or fail without normalizing it. */
export function parseEventId(value: unknown): EventId {
  if (!isEventId(value)) throw new TypeError("Invalid Event ID");
  return value;
}
