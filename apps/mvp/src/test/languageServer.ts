// The browser's language server in Node: `@smthrs/platform-browser`'s `BrowserLanguageServer`, both halves, over a real
// `MessageChannel` in this process, with the real TypeScript and its own lib files: the worker main.tsx starts, run by
// `serve` on one end of a channel instead of in a worker. Code intelligence's tests run on the production layer,
// `LanguageServers.layerBrowser`, over it; nothing about it is scripted.
import { BrowserLanguageServer } from "@smthrs/platform-browser"
import { Effect, Fiber } from "effect"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import ts from "typescript"
import { LanguageServers } from "../features/code-intel/session.vibe"

const libDirectory = dirname(createRequire(import.meta.url).resolve("typescript"))

/** TypeScript's lib file `name`, as the worker's bundle loads it. */
const lib = (name: string) => readFile(join(libDirectory, name), "utf8").catch(() => undefined)

/** A worker: `serve` on one end of a channel, the tab's `Worker` on the other. Terminating it ends both. */
export const inProcessWorker = (): BrowserLanguageServer.WorkerLike => {
  const channel = new MessageChannel()
  const fiber = BrowserLanguageServer.serve({ typescript: ts, lib, port: channel.port1 as never })
  return {
    postMessage: (message) => channel.port2.postMessage(message),
    terminate: () => {
      channel.port2.close()
      Effect.runFork(Fiber.interrupt(fiber))
    },
    addEventListener: (type: "message" | "error", listener: (event: never) => void) => {
      if (type !== "message") return
      channel.port2.addEventListener("message", listener as never)
      channel.port2.start()
    },
  }
}

/** `LanguageServers` whose servers run in this process. */
export const inProcessLanguageServers = LanguageServers.layerBrowser(inProcessWorker)
