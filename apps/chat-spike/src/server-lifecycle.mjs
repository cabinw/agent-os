export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const SHUTDOWN_FAILURE_MESSAGE = "agent hub shutdown failed";

export class ShutdownError extends Error {
  constructor(code) {
    super(SHUTDOWN_FAILURE_MESSAGE);
    this.name = "ShutdownError";
    this.code = code;
  }
}

export function shouldPrintGeneratedHumanToken({
  runnerMode,
  configuredHumanToken,
  nodeEnv,
  isTty,
}) {
  return (
    runnerMode === "local" &&
    !configuredHumanToken &&
    nodeEnv !== "production" &&
    isTty === true
  );
}

/**
 * Own the HTTP → client streams → Runner shutdown boundary. All failures are
 * deliberately collapsed to fixed codes/messages before they leave this
 * module so a close error cannot copy a credential-bearing path or stderr into
 * process logs.
 */
export function createServerLifecycle({
  server,
  closeRunner,
  closeClients = () => {},
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
}) {
  if (!server || typeof server.close !== "function") {
    throw new TypeError("server lifecycle requires server.close");
  }
  if (typeof closeRunner !== "function") {
    throw new TypeError("server lifecycle requires closeRunner");
  }
  if (typeof closeClients !== "function") {
    throw new TypeError("server lifecycle closeClients must be a function");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("server lifecycle timeoutMs must be a positive integer");
  }

  let stopping = false;
  let shutdownPromise = null;

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;

    // `server.close` synchronously stops new accepts. It must be invoked before
    // either client teardown or Runner close begins.
    const serverClose = new Promise((resolveClose, rejectClose) => {
      try {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
        server.closeIdleConnections?.();
      } catch (error) {
        rejectClose(error);
      }
    });

    const clientsClose = Promise.resolve().then(closeClients);
    const runnerClose = Promise.resolve().then(closeRunner);
    const orderly = Promise.allSettled([clientsClose, runnerClose, serverClose]).then(
      (results) => {
        if (results.some((result) => result.status === "rejected")) {
          throw new ShutdownError("close_failed");
        }
      },
    );

    let deadline;
    const timedOut = new Promise((_, rejectTimeout) => {
      deadline = setTimeout(() => {
        try {
          server.closeAllConnections?.();
        } catch {
          // The fixed deadline error below remains the only exposed failure.
        }
        rejectTimeout(new ShutdownError("deadline_exceeded"));
      }, timeoutMs);
    });

    shutdownPromise = Promise.race([orderly, timedOut]).finally(() => {
      clearTimeout(deadline);
    });
    return shutdownPromise;
  };

  return Object.freeze({
    get stopping() {
      return stopping;
    },
    shutdown,
  });
}

export function installShutdownSignalHandlers({
  shutdown,
  processRef = process,
  logFailure = (message) => console.error(message),
  signals = ["SIGINT", "SIGTERM"],
}) {
  if (typeof shutdown !== "function") {
    throw new TypeError("shutdown signal handler requires shutdown");
  }
  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      void shutdown().catch(() => {
        logFailure(SHUTDOWN_FAILURE_MESSAGE);
        processRef.exit(1);
      });
    };
    handlers.set(signal, handler);
    processRef.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) processRef.off(signal, handler);
  };
}
