/** The offline CLI host belongs to processes, never a compiler's worker threads. */
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { childEnvironment } from "./support/node-child.ts"

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
      env: childEnvironment({ ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" }),
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

it("keeps the offline SDK host out of the real compiler launcher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scripted-compiler-preload-"))
  try {
    const receipt = join(directory, "loaded.json")
    const audit = join(directory, "audit.mjs")
    await writeFile(
      audit,
      `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
let host = false;
const record = () => writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ host,
  resolver: Boolean(globalThis[Symbol.for("smthrs/effect-resolution-installed")]) }));
registerHooks({ load(url, context, next) {
  if (url.includes("/src/internal/NodeControlHost.vibe")) { host = true; record(); }
  return next(url, context);
} });
record();
process.once("exit", record);`
    )
    const compiler = join(dirname(createRequire(import.meta.url).resolve("vibelang/package.json")), "bin/vibelang")
    const options = {
      env: childEnvironment({ ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" }),
      timeout: 25_000
    }
    const baseline = await execute(process.execPath, ["--import", audit, compiler, "--version"], options)
    const baselineState = JSON.parse(await readFile(receipt, "utf8"))
    expect(baselineState).toEqual({ host: false, resolver: false })
    const compiled = await execute(
      process.execPath,
      ["--import", audit, "--import", preload, compiler, "--version"],
      options
    )
    expect(compiled.stdout.trim(), compiled.stderr).not.toBe("")
    expect(compiled.stdout).toBe(baseline.stdout)
    expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual(baselineState)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
