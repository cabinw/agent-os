import {
  createServerLifecycle,
  installShutdownSignalHandlers,
} from "../../apps/chat-spike/src/server-lifecycle.mjs";

const secret = process.env.SHUTDOWN_FIXTURE_SECRET ?? "missing-fixture-secret";
const lifecycle = createServerLifecycle({
  server: {
    close(callback) {
      callback();
    },
  },
  closeRunner: async () => {
    throw new Error(`persistence close failed: ${secret}`);
  },
});
installShutdownSignalHandlers({
  shutdown: lifecycle.shutdown,
});

console.log("shutdown fixture ready");
setInterval(() => {}, 1_000);
