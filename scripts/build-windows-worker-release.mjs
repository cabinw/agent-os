import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(repositoryRoot, "apps/chat-spike/src");
const sourceInventoryPath = resolve(
  repositoryRoot,
  "deploy/windows/worker-runtime.sources",
);
const outputRoot = resolve(
  repositoryRoot,
  process.argv[2] ?? "dist/windows-worker-runtime",
);
const outputPath = resolve(outputRoot, "runner-worker.bundle.mjs");

const sourceInventory = (await readFile(sourceInventoryPath, "utf8"))
  .trim()
  .split(/\r?\n/u);
const discoveredSources = (await readdir(sourceRoot, { recursive: true }))
  .filter((entry) => entry.endsWith(".mjs"))
  .map((entry) => `apps\\chat-spike\\src\\${entry.replaceAll("/", "\\")}`)
  .sort();
if (JSON.stringify(sourceInventory) !== JSON.stringify(discoveredSources)) {
  throw new Error("Windows Worker source inventory differs from the repository tree");
}

try {
  const metadata = await stat(outputRoot);
  if (!metadata.isDirectory() || (await readdir(outputRoot)).length !== 0) {
    throw new Error("Windows Worker release output must be a new or empty directory");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await mkdir(outputRoot, { recursive: true });
}

await build({
  absWorkingDir: repositoryRoot,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  bundle: true,
  charset: "utf8",
  entryPoints: ["apps/chat-spike/src/runner-worker.mjs"],
  format: "esm",
  legalComments: "none",
  logLevel: "warning",
  minify: true,
  outfile: outputPath,
  platform: "node",
  sourcemap: false,
  target: "node24",
});

const outputFiles = await readdir(outputRoot);
if (outputFiles.length !== 1 || outputFiles[0] !== "runner-worker.bundle.mjs") {
  throw new Error("Windows Worker release contains an unexpected output tree");
}
const bytes = await readFile(outputPath);
const digest = createHash("sha256").update(bytes).digest("hex");
console.log(
  JSON.stringify({
    file: relative(repositoryRoot, outputPath),
    files: 1,
    bytes: bytes.length,
    sha256: digest,
    sources: sourceInventory.length,
  }),
);
