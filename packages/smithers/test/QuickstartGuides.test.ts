/** Linked quickstart examples execute against the project the reader just created. */
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { readFile, writeFile } from "node:fs/promises"
import { createConnection, createServer, type Socket } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import { withTemporaryDirectory } from "./helpers/TemporaryDirectory.ts"

const run = promisify(execFile)
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const preload = fileURLToPath(new URL("./fixtures/init-native-host.ts", import.meta.url))

it.each(["normal", "ssh", "socket"])(
  "plans and launches the linked guide examples after init hello (startup: %s)",
  async (startup) =>
    withTemporaryDirectory("smithers-guide-cli-", async (root) => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY,
        OPENAI_API_KEY: "fixture-never-sent",
        SMITHERS_BACKEND: "sqlite",
        NODE_OPTIONS: `--import=${preload}`
      }
      if (startup !== "normal") {
        if (startup === "ssh") env.SSH_CLIENT = "1"
        delete env.SHLVL
        // Simulate a system startup file that is unsafe under nounset on macOS.
        const rcfile = join(root, ".bashrc")
        await writeFile(rcfile, "printf \"%s\" \"$GUIDE_UNSET_STARTUP_VARIABLE\"\n")
        env.BASH_ENV = rcfile
      }
      const server = startup === "socket" ? createServer() : undefined
      let socket: Socket | undefined
      let peer: Socket | undefined
      if (server) {
        server.listen(join(root, "stdin.sock"))
        await once(server, "listening")
        const connected = once(server, "connection")
        socket = createConnection(join(root, "stdin.sock"))
        ;[peer] = await connected as [Socket]
        await once(socket, "connect")
      }
      const cli = async (...args: Array<string>) =>
        JSON.parse(
          (await run(process.execPath, ["--no-warnings", "--import", preload, bin, ...args, "--json"], {
            cwd: root,
            env,
            timeout: 60_000,
            maxBuffer: 4 * 1024 * 1024
          })).stdout
        )
      const example = async (name: string) => {
        const doc = await readFile(new URL(`../docs/guides/${name}.md`, import.meta.url), "utf8")
        const command = /```bash\n([\s\S]*?)\n```/.exec(doc)![1]
        await writeFile(join(root, "guide-stdout"), "")
        const execute = (clean: boolean, helper = env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY) =>
          new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
            const child = spawn("/bin/bash", [
              ...(clean ? ["--norc", "--noprofile"] : []),
              "-eu",
              "-o",
              "pipefail",
              "-c",
              [
                "set -o errtrace",
                `trap 'printf "Guide command failed at line %s: %s\\n" "$LINENO" "$BASH_COMMAND" >&2; cat "$GUIDE_STDOUT" >&2' ERR`,
                "smthrs() { XDG_CONFIG_HOME=\"$HOME/config\" XDG_DATA_HOME=\"$HOME/data\" OPENAI_API_KEY=fixture-never-sent SMITHERS_BACKEND=sqlite NODE_OPTIONS=\"--import=$GUIDE_PRELOAD\" \"$GUIDE_NODE\" --no-warnings --import \"$GUIDE_PRELOAD\" \"$GUIDE_BIN\" \"$@\" | tee \"$GUIDE_STDOUT\"; }",
                command,
                name === "script-the-cli" ? "printf \"%s\" \"$approval\"" : ""
              ].join("\n")
            ], {
              cwd: root,
              env: {
                ...(!clean ? env : {}),
                PATH: env.PATH,
                HOME: env.HOME,
                ...(clean ? { SHLVL: "1" } : {}),
                GUIDE_NODE: process.execPath,
                GUIDE_PRELOAD: preload,
                GUIDE_BIN: bin,
                SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: helper,
                GUIDE_STDOUT: join(root, "guide-stdout")
              },
              stdio: [clean ? "ignore" : socket ?? "pipe", "pipe", "pipe"],
              timeout: 60_000
            })
            let stdout = ""
            let stderr = ""
            child.stdout!.on("data", (data) => {
              stdout += data
            })
            child.stderr!.on("data", (data) => {
              stderr += data
            })
            child.on("error", reject)
            child.on("close", (code) => {
              if (code === 0) resolve({ stdout, stderr })
              else {reject(
                  new Error(
                    `Guide ${name}: bash exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}\nNative helper: install @smthrs/platform-node with its helper, or run cargo build --locked --release -p smithers-ffi --bin smithers-jj-export and set SMITHERS_WORKSPACE_JJ_EXPORT_BINARY to its absolute path.`
                  )
                )}
            })
          })
        // The old spawn leaks a startup error; macOS bash may continue after it.
        if (startup !== "normal") {
          const old = await execute(false).catch((error: unknown) => ({ stderr: String(error) }))
          expect(old.stderr).toContain("unbound variable")
        }
        if (startup === "normal" && name === "script-the-cli") {
          const failure = await execute(true, join(root, "missing-helper")).catch((error: unknown) => error)
          expect(failure).toBeInstanceOf(Error)
          const message = String(failure)
          for (
            const detail of [
              "bash exited 1",
              "stdout:",
              "stderr:",
              "Guide command failed at line",
              "smthrs flow plan hello --json",
              "AtomicHelperError",
              "\"code\": \"InvalidInput\"",
              "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY",
              "cargo build --locked"
            ]
          ) expect(message).toContain(detail)
        }
        return execute(true)
      }
      try {
        await cli("init", "hello")
        const planned = await example("script-the-cli")
        expect(planned.stderr).toBe("")
        expect(JSON.parse(planned.stdout)).toMatchObject({ target: { _tag: "Plan" }, scope: "run" })
        const detached = await example("launch-a-detached-run")
        expect(detached.stderr).toBe("")
        const launched = JSON.parse(detached.stdout)
        expect(launched).toMatchObject({ detached: true, runId: expect.any(String), logFile: expect.any(String) })
        const page = await cli("runs", "list")
        expect(page.items.some((item: { runId: string }) => item.runId === launched.runId)).toBe(true)
      } finally {
        socket?.destroy()
        peer?.destroy()
        if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
        await cli("runs", "cancel-all")
      }
    }),
  120_000
)
