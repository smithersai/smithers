/** The offline CLI host belongs to processes, never a compiler's worker threads. */
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const execute = promisify(execFile)
const preload = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const esbuild = import.meta.resolve("esbuild")

it("carries the offline host into child processes without booting it in compiler workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scripted-host-preload-"))
  try {
    await writeFile(
      join(directory, "worker.mjs"),
      `import { parentPort } from "node:worker_threads";
parentPort.postMessage(Boolean(globalThis[Symbol.for("smthrs/effect-resolution-installed")]));`
    )
    await writeFile(
      join(directory, "main.mjs"),
      `import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { transformSync } from ${JSON.stringify(esbuild)};
const installed = () => Boolean(globalThis[Symbol.for("smthrs/effect-resolution-installed")]);
const worker = new Worker(new URL("./worker.mjs", import.meta.url), { execArgv: [] });
const workerInstalled = await new Promise((resolve, reject) => {
  worker.once("message", resolve);
  worker.once("error", reject);
});
await new Promise((resolve, reject) => {
  worker.once("exit", code => code === 0 ? resolve() : reject(Error("worker failed")));
});
const child = await promisify(execFile)(process.execPath, ["-e",
  "console.log(Boolean(globalThis[Symbol.for('smthrs/effect-resolution-installed')]))"
], { env: process.env });
const transformed = transformSync("export const value: number = 42", { loader: "ts", format: "esm" });
console.log(JSON.stringify({ main: installed(), child: child.stdout.trim(), worker: workerInstalled,
  transformed: transformed.code.includes("const value = 42") }));`
    )
    const child = await execute(process.execPath, ["--import", preload, join(directory, "main.mjs")], {
      env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" },
      timeout: 55_000
    })
    expect(JSON.parse(child.stdout), child.stderr).toEqual({
      main: true,
      child: "true",
      worker: false,
      transformed: true
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
