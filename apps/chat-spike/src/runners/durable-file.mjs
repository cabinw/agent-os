import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const DEFAULT_OPS = Object.freeze({
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
});

function writeAll(ops, fd, body) {
  const bytes = Buffer.from(body, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const written = ops.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!Number.isInteger(written) || written <= 0) {
      throw new Error("durable candidate write made no progress");
    }
    offset += written;
  }
}

export function createWindowsReplacer({ powershellPath, scriptPath, spawn = spawnSync }) {
  return (candidatePath, targetPath) => {
    const result = spawn(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        scriptPath,
        "-CandidatePath",
        candidatePath,
        "-TargetPath",
        targetPath,
      ],
      {
        encoding: "utf8",
        env: Object.fromEntries(
          ["SystemRoot", "WINDIR", "TEMP", "TMP"]
            .map((name) => [name, process.env[name]])
            .filter(([, value]) => typeof value === "string"),
        ),
        windowsHide: true,
      },
    );
    if (result.status !== 0) {
      throw new Error("Windows durable replacement failed");
    }
  };
}

export function publishDurableFile(
  targetPath,
  body,
  { platform = process.platform, ops = DEFAULT_OPS, windowsReplace } = {},
) {
  const candidatePath = `${targetPath}.${process.pid}.${randomUUID()}.candidate`;
  let candidateFd;
  try {
    candidateFd = ops.openSync(
      candidatePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeAll(ops, candidateFd, body);
    ops.fsyncSync(candidateFd);
    ops.closeSync(candidateFd);
    candidateFd = undefined;

    if (platform === "win32") {
      if (typeof windowsReplace !== "function") {
        throw new Error("Windows durable replacement helper is not configured");
      }
      windowsReplace(candidatePath, targetPath);
    } else {
      ops.renameSync(candidatePath, targetPath);
      const directoryFd = ops.openSync(dirname(targetPath), constants.O_RDONLY);
      try {
        ops.fsyncSync(directoryFd);
      } finally {
        ops.closeSync(directoryFd);
      }
    }
  } catch (error) {
    if (candidateFd !== undefined) {
      try {
        ops.closeSync(candidateFd);
      } catch {}
    }
    try {
      ops.unlinkSync(candidatePath);
    } catch {}
    throw error;
  }
}
