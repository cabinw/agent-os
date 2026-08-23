export const MAX_SSE_CLIENTS = 64;
export const MAX_SSE_BUFFER_BYTES = 256 * 1024;

const SSE_HEADERS = Object.freeze({
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
});

/**
 * Own the bounded lifetime and output queue for authenticated event streams.
 * `buildInitialFrame` is deliberately lazy: a saturated request is rejected
 * before replay or response headers are touched.
 */
export function createSseClientRegistry({
  maxClients = MAX_SSE_CLIENTS,
  maxBufferedBytes = MAX_SSE_BUFFER_BYTES,
  pingIntervalMs = 15_000,
  timerApi = { setInterval, clearInterval },
} = {}) {
  for (const [label, value] of [
    ["maxClients", maxClients],
    ["maxBufferedBytes", maxBufferedBytes],
    ["pingIntervalMs", pingIntervalMs],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`SSE registry ${label} must be a positive integer`);
    }
  }
  if (
    !timerApi ||
    typeof timerApi.setInterval !== "function" ||
    typeof timerApi.clearInterval !== "function"
  ) {
    throw new TypeError("SSE registry timerApi must provide setInterval / clearInterval");
  }

  const clients = new Map();

  const detach = (entry) => {
    if (clients.get(entry.response) !== entry) return false;
    clients.delete(entry.response);
    if (entry.ping !== null) timerApi.clearInterval(entry.ping);
    entry.response.off("close", entry.onClose);
    entry.response.off("error", entry.onError);
    return true;
  };

  const terminate = (entry) => {
    if (!detach(entry)) return;
    try {
      if (!entry.response.writableEnded) entry.response.end();
    } catch {
      // Destroy below is the final bounded cleanup path.
    }
    try {
      if (!entry.response.destroyed) entry.response.destroy();
    } catch {
      // The entry is already detached, so a broken response cannot retain it.
    }
  };

  const write = (entry, frame) => {
    const response = entry.response;
    if (response.destroyed || response.writableEnded) {
      terminate(entry);
      return false;
    }
    const frameBytes = Buffer.byteLength(frame, "utf8");
    const writableLength = Number.isFinite(response.writableLength)
      ? response.writableLength
      : 0;
    if (frameBytes > maxBufferedBytes || writableLength > maxBufferedBytes - frameBytes) {
      terminate(entry);
      return false;
    }
    try {
      if (response.write(frame) !== false) return true;
    } catch {
      // A synchronous stream failure follows the same bounded drop path.
    }
    terminate(entry);
    return false;
  };

  const admit = (response, buildInitialFrame) => {
    if (typeof buildInitialFrame !== "function") {
      throw new TypeError("SSE admission requires buildInitialFrame");
    }
    if (clients.size >= maxClients) {
      return Object.freeze({ accepted: false, reason: "capacity" });
    }

    const entry = {
      response,
      ping: null,
      onClose: null,
      onError: null,
    };
    entry.onClose = () => detach(entry);
    entry.onError = () => terminate(entry);
    clients.set(response, entry);
    response.once("close", entry.onClose);
    response.once("error", entry.onError);

    let initialFrame;
    try {
      initialFrame = buildInitialFrame();
      if (typeof initialFrame !== "string") {
        throw new TypeError("SSE initial frame must be a string");
      }
    } catch (error) {
      detach(entry);
      throw error;
    }
    if (Buffer.byteLength(initialFrame, "utf8") > maxBufferedBytes) {
      detach(entry);
      return Object.freeze({ accepted: false, reason: "initial_frame_too_large" });
    }

    try {
      response.writeHead(200, SSE_HEADERS);
    } catch (error) {
      terminate(entry);
      throw error;
    }
    if (!write(entry, initialFrame)) {
      return Object.freeze({ accepted: true, closed: true });
    }
    // A response implementation may synchronously emit `close` from write().
    // Do not install an interval after that close already detached the entry.
    if (clients.get(response) !== entry) {
      return Object.freeze({ accepted: true, closed: true });
    }
    try {
      entry.ping = timerApi.setInterval(() => write(entry, ": ping\n\n"), pingIntervalMs);
    } catch (error) {
      terminate(entry);
      throw error;
    }
    entry.ping?.unref?.();
    return Object.freeze({ accepted: true, closed: false });
  };

  return Object.freeze({
    get size() {
      return clients.size;
    },
    admit,
    broadcast(frame) {
      for (const entry of [...clients.values()]) write(entry, frame);
    },
    closeAll() {
      for (const entry of [...clients.values()]) terminate(entry);
    },
  });
}
