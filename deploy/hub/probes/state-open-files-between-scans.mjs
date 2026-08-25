import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [helperPath, stateRoot, forbiddenCgroup, serviceUid, trigger, published] =
  process.argv.slice(2);
if (
  [helperPath, stateRoot, forbiddenCgroup, serviceUid, trigger, published].some(
    (value) => value === undefined,
  )
) {
  process.stderr.write(
    "usage: between-scans HELPER STATE CGROUP UID TRIGGER PUBLISHED\n",
  );
  process.exit(2);
}

const { runStateOpenFiles } = await import(pathToFileURL(resolve(helperPath)).href);
let linked = false;
try {
  const result = runStateOpenFiles(
    [
      stateRoot,
      "--forbidden-cgroup",
      forbiddenCgroup,
      "--service-uid",
      serviceUid,
      "--unit-inactive-proof",
      "inactive-mainpid0",
    ],
    {
      onBetweenScans() {
        writeFileSync(trigger, "1\n", { flag: "wx", mode: 0o600 });
        const deadline = Date.now() + 5_000;
        while (!linked && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          linked = existsSync(published);
        }
        if (!linked) throw new Error("linkat_timeout");
      },
    },
  );
  process.stdout.write(
    `${JSON.stringify({
      failClosedReason: null,
      linked,
      ok: result.ok,
      scanCount: result.scanCount,
      writableDescriptorDetected: result.writableDescriptorDetected,
    })}\n`,
  );
  if (result.ok || !result.writableDescriptorDetected || !linked) process.exitCode = 1;
} catch (error) {
  const failClosedReason = error?.code ?? "unexpected";
  process.stdout.write(
    `${JSON.stringify({ failClosedReason, linked, ok: false, scanCount: 2 })}\n`,
  );
  if (!linked || failClosedReason !== "state_root_changed") process.exitCode = 1;
}
