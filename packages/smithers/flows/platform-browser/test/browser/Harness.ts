/**
 * Bundles the suites' pages (the engine's at `/`, the cache's at `/cache`,
 * TanStack DB's persistence at `/tanstack`, the agent's at `/agent`, the
 * shared mount's at `/mount`) and engine workers, serves them on a loopback
 * port, and launches Playwright's Chromium on a persistent profile, so a
 * suite can kill the browser and open the same origin's OPFS and Cache
 * Storage again.
 */
import { build, type Plugin } from "esbuild"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type BrowserContext, chromium, type Page } from "playwright"
import vibelang from "vibelang-unplugin/esbuild"
import { expect } from "vitest"

const require = createRequire(import.meta.url)

const html = `<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>`

/**
 * What a browser bundler does with the one Node built-in just-bash's browser
 * build still imports statically, `node:zlib` for gzip and gunzip: a tab has
 * none, so the import resolves to a module whose functions throw when a script
 * reaches them, as Vite externalizes a built-in for the browser.
 */
const noZlib: Plugin = {
  name: "no-node-zlib",
  setup: (build) => {
    build.onResolve({ filter: /^node:zlib$/ }, () => ({ path: "node:zlib", namespace: "no-node-zlib" }))
    build.onLoad({ filter: /.*/, namespace: "no-node-zlib" }, () => ({
      contents: [
        "const unavailable = () => { throw new Error(\"node:zlib is not available in a browser\") }",
        "export const constants = {}",
        "export const gunzipSync = unavailable",
        "export const gzipSync = unavailable"
      ].join("\n"),
      loader: "js"
    }))
  }
}

/**
 * Bundles `entries`, each named by its output file, for the browser, under
 * the extra export `conditions` and with the extra `plugins`. Without tree
 * shaking every module the entries reach is evaluated, as a dev server serves
 * them.
 */
const bundle = (
  entries: Record<string, string>,
  conditions: Array<string> = [],
  treeShaking = true,
  plugins: Array<Plugin> = []
) =>
  build({
    bundle: true,
    plugins: [vibelang({ root: fileURLToPath(new URL("../../", import.meta.url)) }), ...plugins],
    conditions,
    treeShaking,
    entryPoints: Object.fromEntries(
      Object.entries(entries).map(([name, path]) => [name, fileURLToPath(new URL(path, import.meta.url))])
    ),
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    outdir: "/",
    write: false
  })

/**
 * The bundled pages and worker, the SQLite build, and a server for them.
 * With `agent`, also the agent suite's page and worker, bundled apart so the
 * other suites never load `@smthrs/agent`. With `mount`, also the shared-mount
 * suite's page and the jj wasm it mounts, bundled apart so the other suites
 * never load ZenFS or just-bash.
 */
export const serve = async (
  options: { readonly agent?: boolean; readonly mount?: boolean } = {}
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> => {
  const bundled = await bundle({
    page: "./app/page.ts",
    worker: "./app/worker.ts",
    cache: "./app/cache.ts",
    tanstack: "./app/tanstack.ts",
    "wal-worker": "./app/wal-worker.ts"
  })
  // The agent's worker is built the way Vite serves an app's worker: the
  // `browser` condition and no `worker` one, every module evaluated. A module
  // that touches the DOM while it loads, as `decode-named-character-reference`
  // does under `browser`, kills the worker here as it did in the app.
  const agent = options.agent === true
    ? [
      ...(await bundle({ agent: "./app/agent.ts" })).outputFiles,
      ...(await bundle({ "agent-worker": "./app/agent-worker.ts" }, [], false)).outputFiles
    ]
    : []
  const mount = options.mount === true
    ? (await bundle({ mount: "./app/mount.ts" }, [], true, [noZlib])).outputFiles
    : []
  const files = new Map<string, { readonly type: string; readonly body: Uint8Array | string }>([
    ["/", { type: "text/html", body: html }],
    ["/cache", { type: "text/html", body: html.replace("/page.js", "/cache.js") }],
    ["/tanstack", { type: "text/html", body: html.replace("/page.js", "/tanstack.js") }],
    ["/agent", { type: "text/html", body: html.replace("/page.js", "/agent.js") }],
    ["/mount", { type: "text/html", body: html.replace("/page.js", "/mount.js") }],
    ...(options.mount === true
      ? [
        ["/flows_jj.wasm", {
          type: "application/wasm",
          body: readFileSync(fileURLToPath(new URL("../../../jj/wasm/flows_jj.wasm", import.meta.url)))
        }] as const
      ]
      : []),
    // An engine worker that throws while it loads, as one whose module fails to evaluate.
    ["/broken-worker.js", {
      type: "text/javascript",
      body: "throw new TypeError(\"the engine worker failed to load\")"
    }],
    ["/wa-sqlite.wasm", {
      type: "application/wasm",
      body: readFileSync(require.resolve("@journeyapps/wa-sqlite/dist/wa-sqlite.wasm"))
    }],
    ...[...bundled.outputFiles, ...agent, ...mount].map((file) =>
      [file.path, { type: "text/javascript", body: file.contents }] as const
    )
  ])
  const server: Server = createServer((request, response) => {
    const file = files.get(new URL(request.url!, "http://localhost").pathname)
    if (file === undefined) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "content-type": file.type, "cache-control": "no-store" }).end(file.body)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    origin: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/** A Chromium profile directory that outlives every browser launched on it. */
export const profile = (): { readonly directory: string; readonly remove: () => void } => {
  const directory = mkdtempSync(join(tmpdir(), "platform-browser-profile-"))
  return { directory, remove: () => rmSync(directory, { recursive: true, force: true }) }
}

/** Launches Chromium on `directory`. */
export const launch = (directory: string): Promise<BrowserContext> =>
  chromium.launchPersistentContext(directory, { headless: true })

/**
 * Kills every process of the browser running on `directory` with SIGKILL:
 * no unload handler, no worker finalizer, no graceful close.
 */
export const kill = (directory: string): void => {
  execFileSync("pkill", ["-9", "-f", `user-data-dir=${directory}`])
}

/** One step a worker started. */
export interface Logged {
  readonly label: string
  readonly worker: string
}

/** Opens the suites' page, the engine's at `/` unless `path` names another, and waits for its harness. */
export const open = async (
  context: BrowserContext,
  origin: string,
  mode: "block" | "finish",
  path = "/"
): Promise<Page> => {
  const page = await context.newPage()
  if (process.env.BROWSER_TEST_DEBUG) {
    const tag = `${mode}-${Math.random().toString(36).slice(2, 6)}`
    page.on("console", (message) => process.stdout.write(`[page ${tag}] ${message.text()}\n`))
    page.on(
      "worker",
      (worker) => worker.on("console", (message) => process.stdout.write(`[worker ${tag}] ${message.text()}\n`))
    )
  }
  await page.goto(`${origin}${path}?mode=${mode}`)
  await page.waitForFunction(() => "harness" in globalThis)
  return page
}

/** What the page's step log holds now. */
export const logged = (page: Page): Promise<ReadonlyArray<Logged>> =>
  page.evaluate(() => (globalThis as unknown as { harness: { log: Array<Logged> } }).harness.log)

/** Waits until the page's step log holds `label`. */
export const waitForStep = (page: Page, label: string): Promise<unknown> =>
  page.waitForFunction(
    (label) =>
      (globalThis as unknown as { harness: { log: Array<Logged> } }).harness.log.some((l) => l.label === label),
    label,
    { timeout: 30_000 }
  )

/** Waits for this page's worker in the engine lock's held or pending queue. */
const waitForWorkerLock = (page: Page, queue: "held" | "pending"): Promise<void> =>
  expect.poll(
    () =>
      page.evaluate(async (queue) => {
        const { workerClientId } = (globalThis as unknown as {
          harness: { readonly workerClientId?: string }
        }).harness
        const state = await navigator.locks.query()
        return workerClientId !== undefined &&
          (state[queue] ?? []).some((lock) => lock.name === "browser-test" && lock.clientId === workerClientId)
      }, queue),
    { timeout: 30_000 }
  ).toBe(true)

/** Waits until the page's own engine worker holds the engine lock. */
export const waitForLeader = (page: Page): Promise<void> => waitForWorkerLock(page, "held")

/** Waits until the page's own worker is queued for the engine lock. */
export const waitForFollower = (page: Page): Promise<void> => waitForWorkerLock(page, "pending")

/** Waits until the page has seen the engine commit `eventType` for `executionId`. */
export const waitForEvent = (page: Page, executionId: string, eventType: string): Promise<unknown> =>
  page.waitForFunction(
    ([executionId, eventType]) =>
      (globalThis as unknown as { harness: { events: Array<{ executionId: string; eventType: string }> } }).harness
        .events.some((event) => event.executionId === executionId && event.eventType === eventType),
    [executionId, eventType] as const,
    { timeout: 30_000 }
  )
