import { Effect } from "effect"
import { execFileSync, spawn, type SpawnOptions } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { sandboxImage } from "./sandboxImage.globalSetup.ts"

const scratchDirectory = fileURLToPath(new URL("../../../../.cache/", import.meta.url))

export interface ContainerExec {
  readonly env?: Record<string, string>
  readonly user?: string
  readonly cwd?: string
  readonly stdin?: "ignore" | "pipe"
  readonly stdout?: "ignore" | "pipe"
  readonly stderr?: "ignore" | "pipe"
  readonly pty?: { readonly cols: number; readonly rows: number }
  readonly signal?: AbortSignal
}

const docker = (args: ReadonlyArray<string>) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

/** A Linux container through Alchemy's raw exec boundary. The checkout, shell, tmux and scripts run in Docker. */
const dockerSandbox = (checkout = false) => {
  const id = `branch-sandbox-test-${crypto.randomUUID()}`
  let running = false
  let removed: Promise<void>
  let end: () => void
  const starts: Array<unknown> = []
  const intercepts = new Map<string, unknown>()
  const root = (argv: ReadonlyArray<string>) => docker(["exec", "--user", "0:0", id, ...argv])
  const remove = () => {
    if (!running) return
    docker(["rm", "-f", id])
    running = false
    end()
  }
  const container = {
    get running() { return running },
    start(options: unknown) {
      docker(["run", "-d", "--rm", "--network", "none", "--name", id, sandboxImage])
      running = true
      starts.push(options)
      removed = new Promise<void>((resolve) => { end = resolve })
      if (!checkout) return
      mkdirSync(scratchDirectory, { recursive: true })
      const repo = mkdtempSync(join(scratchDirectory, "branch-object-checkout-"))
      try {
        execFileSync("jj", ["--no-pager", "git", "init", "--colocate", repo], { stdio: "ignore" })
        writeFileSync(join(repo, "README.md"), "sandbox checkout\n")
        execFileSync("jj", ["--no-pager", "-R", repo, "commit", "-m", "Branch sandbox fixture"], { stdio: "ignore" })
        docker(["cp", join(repo, ".git"), `${id}:/workspace/.git`])
        docker(["cp", join(repo, "README.md"), `${id}:/workspace/README.md`])
        root(["chown", "-R", "1000:2000", "/workspace"])
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    },
    destroy: async () => remove(),
    monitor: () => removed,
    setInactivityTimeout: async (ms: number) => {
      if (!running || ms <= 0) throw new Error("cannot arm the container")
    },
    interceptOutboundHttp: async (host: string, fetcher: unknown) => void intercepts.set(`http:${host}`, fetcher),
    interceptAllOutboundHttp: async (fetcher: unknown) => void intercepts.set("http:*", fetcher),
    interceptOutboundHttps: async (host: string, fetcher: unknown) => void intercepts.set(`https:${host}`, fetcher),
    exec: async (argv: ReadonlyArray<string>, options: ContainerExec = {}) => {
      const args = ["exec"]
      if (options.stdin === "pipe" || options.pty !== undefined) args.push("-i")
      if (options.user !== undefined) args.push("--user", options.user)
      if (options.cwd !== undefined) args.push("--workdir", options.cwd)
      for (const [key, value] of Object.entries(options.env ?? {})) args.push("--env", `${key}=${value}`)
      const stdio: SpawnOptions["stdio"] = [
        options.pty === undefined ? options.stdin ?? "ignore" : "pipe",
        options.stdout ?? "pipe",
        options.stderr ?? "pipe",
      ]
      const quote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'"
      const command = options.pty === undefined ? argv : ["script", "-qefc", argv.map(quote).join(" "), "/dev/null"]
      const child = spawn("docker", [...args, id, ...command], { stdio, signal: options.signal })
      const exitCode = new Promise<number>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code) => resolve(code ?? 137))
      })
      // Alchemy owns the process scope and still observes the original rejected exit when asked.
      void exitCode.catch(() => {})
      return {
        pid: child.pid ?? 0,
        isPty: options.pty !== undefined,
        stdin: options.stdin !== "pipe" || child.stdin === null ? undefined : Writable.toWeb(child.stdin),
        stdout: child.stdout === null ? undefined : Readable.toWeb(child.stdout),
        stderr: child.stderr === null ? undefined : Readable.toWeb(child.stderr),
        exitCode,
        kill: () => child.kill("SIGKILL"),
      }
    },
  }
  return { container, root, starts, intercepts, remove }
}

export const withDockerSandbox = (checkout = false) =>
  Effect.acquireRelease(Effect.sync(() => dockerSandbox(checkout)), (box) => Effect.sync(box.remove))
