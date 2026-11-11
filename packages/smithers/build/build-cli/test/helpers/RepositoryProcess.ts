/** Real child processes controlled through IPC. */
import { Effect } from "effect"
import { spawn, type SpawnOptions } from "node:child_process"
import * as RepositoryProcess from "../../src/internal/RepositoryProcess.ts"

const program = [
  "process.on(\"message\", ({ stream, text, exit, signal, tree }) => {",
  "if (tree) {",
  "const child = require(\"node:child_process\").spawn(process.execPath, [\"-e\", \"process.on(\\\"message\\\", () => {}); process.send(\\\"ready\\\")\"], { stdio: [\"ignore\", \"inherit\", \"inherit\", \"ipc\"] });",
  "child.once(\"message\", () => process.send({ descendant: child.pid })); return;",
  "}",
  "if (stream) process[stream].write(text);",
  "if (signal) process.kill(process.pid, signal);",
  "else if (exit !== undefined) { process.exitCode = exit; process.disconnect(); }",
  "else process.send(\"written\");",
  "}); process.send(\"ready\");"
].join("\n")

export const fixture = () => {
  const requests: Array<{ command: string; args: ReadonlyArray<string>; options: SpawnOptions }> = []
  const children: Array<ReturnType<typeof spawn>> = []
  const closes: Array<Promise<void>> = []
  const descendants: Array<number> = []
  const starts: Array<ReturnType<typeof Promise.withResolvers<void>>> = []
  const started = (index: number) => starts[index] ??= Promise.withResolvers<void>()
  const output: Array<string> = []
  const services: RepositoryProcess.Services = {
    ...RepositoryProcess.live,
    spawn: (command, args, options) =>
      Effect.try(() => {
        const index = requests.length
        requests.push({ command, args, options })
        const child = spawn(process.execPath, ["--input-type=commonjs", "-e", program], {
          ...options,
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe", "ipc"]
        })
        children.push(child)
        closes.push(new Promise<void>((resolve) => child.once("close", () => resolve())))
        child.once("message", () => started(index).resolve())
        return child as RepositoryProcess.Child
      }),
    output: (stream, text) => {
      output.push(stream + ":" + text)
    }
  }
  const ready = async (index = 0) => {
    await started(index).promise
    return children[index]!
  }
  const write = async (stream: "stdout" | "stderr", text: string, index = 0) => {
    const child = await ready(index)
    const ack = new Promise<void>((resolve) => child.once("message", () => resolve()))
    const pipe = child[stream]!
    const drained = new Promise<void>((resolve) => {
      let remaining = Buffer.byteLength(text)
      if (remaining === 0) {
        resolve()
        return
      }
      const read = (chunk: Buffer) => {
        remaining -= chunk.byteLength
        if (remaining <= 0) {
          pipe.off("data", read)
          resolve()
        }
      }
      pipe.on("data", read)
    })
    child.send!({ stream, text })
    await Promise.all([ack, drained])
  }
  const finish = async (exit: number | null = 0, index = 0) => {
    const child = await ready(index)
    child.send!(exit === null ? { signal: "SIGKILL" } : { exit })
    await closes[index]
  }
  const tree = async () => {
    const child = await ready()
    const pid = new Promise<number>((resolve) =>
      child.once("message", (message) => resolve((message as { descendant: number }).descendant))
    )
    child.send!({ tree: true })
    const descendant = await pid
    descendants.push(descendant)
    return descendant
  }
  const cleanup = async () => {
    for (const pid of descendants) {
      try {
        process.kill(pid, "SIGKILL")
      } catch { /* The group was already joined. */ }
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await Promise.all(closes)
  }
  return { services, requests, children, closes, output, ready, write, finish, tree, cleanup }
}
