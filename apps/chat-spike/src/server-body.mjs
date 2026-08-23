export const HUB_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
export const HUB_REQUEST_BODY_TIMEOUT_MS = 3_000;

export class RequestBodyError extends Error {
  constructor(status, message, closeConnection = false) {
    super(message);
    this.name = "RequestBodyError";
    this.status = status;
    this.closeConnection = closeConnection;
  }
}

/**
 * Read one bounded JSON request body. Timer injection exists only so cleanup
 * can be observed deterministically; production callers use the real timers.
 */
export function readHubJsonBody(
  request,
  {
    maxBytes = HUB_REQUEST_BODY_LIMIT_BYTES,
    timeoutMs = HUB_REQUEST_BODY_TIMEOUT_MS,
    timerApi = { setTimeout, clearTimeout },
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Hub request body maxBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Hub request body timeoutMs must be a positive integer");
  }
  if (
    !timerApi ||
    typeof timerApi.setTimeout !== "function" ||
    typeof timerApi.clearTimeout !== "function"
  ) {
    throw new TypeError(
      "Hub request body timerApi must provide setTimeout / clearTimeout",
    );
  }

  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer !== null) timerApi.clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const resolveOnce = (body) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveBody(body);
    };
    const rejectOnce = (error, { drain = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (drain) request.resume();
      rejectBody(error);
    };
    const onData = (chunk) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maxBytes) {
        rejectOnce(new RequestBodyError(413, "request body too large", true), {
          drain: true,
        });
        return;
      }
      chunks.push(value);
    };
    const onEnd = () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw === "") return resolveOnce({});
      try {
        return resolveOnce(JSON.parse(raw));
      } catch {
        return rejectOnce(new RequestBodyError(400, "invalid JSON request body"));
      }
    };
    const onAborted = () => {
      rejectOnce(new RequestBodyError(400, "request body unavailable"));
    };
    const onError = () => {
      rejectOnce(new RequestBodyError(400, "request body unavailable"));
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onError);

    timer = timerApi.setTimeout(() => {
      rejectOnce(new RequestBodyError(408, "request body timed out", true), {
        drain: true,
      });
    }, timeoutMs);
    timer?.unref?.();
    // An injected timer may fire synchronously before its handle is assigned.
    if (settled && timer !== null) timerApi.clearTimeout(timer);

    const contentLength = Number(request.headers?.["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      rejectOnce(new RequestBodyError(413, "request body too large", true), {
        drain: true,
      });
    }
  });
}
