import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { APIError, Client } from "../src/internal/backend/Client.ts"
import { remote } from "../src/internal/backend/SSH.ts"
import { workspaces, workspaceSSH } from "../src/internal/backend/Workspaces.ts"
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
const hostKey = { algorithm: "ssh-ed25519", public_key: key.split(" ")[1], known_hosts_line: key }
const guest = { command: "ssh guest", hostKeys: [key] }
const state = vi.hoisted(() => ({
  terminal: "stopped",
  sent: [] as unknown[],
  url: "",
  options: {} as unknown
}))
vi.mock(
  "../src/internal/backend/SSH.ts",
  async (original) => ({ ...await original<object>(), remote: vi.fn() })
)
vi.mock("@effect/platform-node/NodeWS", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    WebSocket: class extends EventEmitter {
      closed = false
      constructor(url: string, options: unknown) {
        super()
        state.url = url
        state.options = options
        queueMicrotask(() => {
          if (state.terminal === "error") {
            this.emit("error", new Error("socket failed"))
            return
          }
          this.emit("open")
          this.emit("message", Buffer.from("hello"), true)
          this.emit("message", Buffer.from("not json"), false)
          this.emit("message", Buffer.from(JSON.stringify({ type: "status", status: state.terminal })), false)
        })
      }
      send(value: unknown) {
        state.sent.push(value)
      }
      close() {
        if (!this.closed) {
          this.closed = true
          this.emit("close")
        }
      }
    }
  }
})
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(remote).mockReset()
  state.terminal = "stopped"
  state.sent = []
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const success = (stdout = "", code = 0) => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) })
const fixture = async (environment: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-box-"))
  dirs.push(home)
  const exit = vi.fn(), controller = new AbortController()
  const c = new Client({
    environment: {
      HOME: home,
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_TOKEN: "login-secret",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      ...environment
    },
    exit,
    signal: controller.signal
  })
  const request = vi.spyOn(c, "request").mockImplementation(async (method, path) => {
    if (method === "GET" && path.endsWith("/ssh")) return { ssh_command: "ssh guest", host_keys: [hostKey] }
    if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "generated" }
    if (method === "GET" && path.endsWith("/command-runs/generated")) {
      return {
        operationId: "generated",
        state: "completed",
        result: {
          exit_code: 0,
          stdout: "",
          stderr: "",
          output_truncated: false
        }
      }
    }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  vi.mocked(remote).mockResolvedValue(success())
  return { c, home, exit, request, controller }
}
const options = { repo: "owner/repo" }
describe("box remote execution", () => {
  it("surfaces transient SSH errors for durable callers to retry", async () => {
    const { c, request } = await fixture()
    request.mockRejectedValueOnce(new APIError(503, {}, "GET", "/ssh", new Headers()))
    await expect(workspaceSSH(c, "box", { ...options, user: "root" })).rejects.toThrow("503")
    expect(request).toHaveBeenCalledExactlyOnceWith("GET", "/api/repos/owner/repo/workspaces/box/ssh?user=root")
  })
  it("stops immediately for denied SSH access", async () => {
    const { c, request } = await fixture()
    request.mockRejectedValue(new APIError(403, {}, "GET", "/ssh", new Headers()))
    await expect(workspaceSSH(c, "box", options)).rejects.toThrow("403")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("refuses a malformed advertised host key at once instead of polling", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValue({ ssh_command: "ssh guest", host_keys: [{ known_hosts_line: "ssh-ed25519 not a key" }] })
    await expect(workspaceSSH(c, "box", options)).rejects.toThrow("Invalid workspace SSH host key")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("refuses missing SSH receipts immediately", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValue({})
    await expect(workspaceSSH(c, "box", options)).rejects.toThrow("SSH-ready")
  })
  it("refuses a missing SSH receipt on an aborted invocation", async () => {
    const { c, request, controller } = await fixture()
    request.mockResolvedValue({})
    controller.abort()
    await expect(workspaceSSH(c, "box", options)).rejects.toThrow()
  })
  it("opens an interactive SSH connection and returns its exit status", async () => {
    const { c, exit } = await fixture()
    vi.mocked(remote).mockResolvedValue(success("", 7))
    expect(await workspaces["workspace ssh"]!(c, { id: "box" }, options)).toMatchObject({ connected: false })
    expect(remote).toHaveBeenCalledWith(c, guest, undefined, 0, undefined, true)
    expect(exit).toHaveBeenCalledWith(7)
  })
  it("admits a command through the public command-runs API before polling its receipt", async () => {
    const { c, request } = await fixture()
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "admitted" }
      if (method === "GET" && path.endsWith("/command-runs/admitted")) {
        return {
          operationId: "admitted",
          state: "completed",
          result: { exit_code: 0, stdout: "done", stderr: "", output_truncated: false }
        }
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(
      workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "printf done", "exec-id": "admitted" })
    )
      .resolves.toMatchObject({ exit_code: 0, stdout: "done", stderr: "" })
    expect(request).toHaveBeenCalledWith("POST", "/api/repos/owner/repo/workspaces/box/command-runs", {
      operation_id: "admitted",
      args: ["/bin/bash", "-c", "printf done"],
      environment: {}
    })
  })
  it("detaches after admission and reattaches to the same receipt by exec id", async () => {
    const { c, request, exit } = await fixture()
    let polls = 0
    request.mockImplementation(async (method, path, body) => {
      if (method === "POST" && path.endsWith("/command-runs")) {
        expect(body).toMatchObject({ operation_id: "tests-1", args: ["/bin/bash", "-c", "pnpm test"] })
        return { operationId: "op-1", state: "accepted" }
      }
      if (method === "GET" && path.endsWith("/command-runs/op-1")) {
        return ++polls === 1 ? { operationId: "op-1", state: "running" } : {
          operationId: "op-1",
          state: "completed",
          result: { exit_code: 4, stdout: "ran", stderr: "", output_truncated: false }
        }
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    const input = { ...options, command: "pnpm test", "exec-id": "tests-1" }
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...input, detach: true })).resolves.toEqual({
      workspace_id: "box",
      operation_id: "op-1",
      exec_id: "tests-1",
      state: "accepted"
    })
    expect(request.mock.calls.filter(([method]) => method === "GET")).toHaveLength(0)
    expect(request.mock.calls.filter(([, path]) => String(path).endsWith("/cancel"))).toHaveLength(0)
    expect(exit).not.toHaveBeenCalled()
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, input))
      .resolves.toMatchObject({ operation_id: "op-1", exit_code: 4, stdout: "ran" })
    expect(polls).toBe(2)
    expect(exit).toHaveBeenCalledWith(4)
  })
  it("refuses a detached command with a cancellation timeout before admission", async () => {
    const { c, request } = await fixture()
    await expect(
      workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "x", detach: true, timeout: 5 })
    )
      .rejects.toThrow("--detach cannot be combined with --timeout")
    expect(request).not.toHaveBeenCalled()
  })
  it("omits streamed stdout and stderr from a live receipt and keeps them otherwise", async () => {
    const result = { exit_code: 3, stdout: "out", stderr: "err", output_truncated: false }
    const run = async (live: boolean) => {
      const { c } = await fixture()
      const client = new Client({ environment: { ...c.env, SMITHERS_API_ORIGIN: "https://api.example.test" } }, live)
      vi.spyOn(client, "request").mockImplementation(async (method, path) => {
        if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "r" }
        if (method === "GET" && path.endsWith("/command-runs/r")) {
          return { operationId: "r", state: "completed", result }
        }
        throw new Error(`Unexpected ${method} ${path}`)
      })
      return workspaces["workspace exec"]!(client, { id: "box" }, { ...options, command: "x" })
    }
    const live = await run(true) as Record<string, unknown>
    expect(Object.keys(live).sort()).toEqual(["exit_code", "operation_id", "output_truncated", "workspace_id"])
    expect(Object.keys(await run(false) as object)).toEqual(
      expect.arrayContaining(["stdout", "stderr", "exit_code"])
    )
  })
  it("passes command, environment, and directory as API data", async () => {
    const { c, request, exit } = await fixture()
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "retry" }
      if (method === "GET" && path.endsWith("/command-runs/retry")) {
        return {
          operationId: "retry",
          state: "completed",
          result: {
            exit_code: 9,
            stdout: "out",
            stderr: "err",
            output_truncated: false
          }
        }
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    expect(
      await workspaces["workspace exec"]!(c, { id: "box" }, {
        ...options,
        command: "printf '$value'",
        env: ["VALUE=a b", "EMPTY="],
        cwd: "/a'b",
        "exec-id": "retry"
      })
    ).toMatchObject({ exit_code: 9, stdout: "out", stderr: "err" })
    expect(request).toHaveBeenCalledWith("POST", "/api/repos/owner/repo/workspaces/box/command-runs", {
      operation_id: "retry",
      args: ["/bin/bash", "-c", "printf '$value'"],
      environment: { VALUE: "a b", EMPTY: "" },
      directory: "/a'b"
    })
    expect(exit).toHaveBeenCalledWith(9)
    expect(remote).not.toHaveBeenCalled()
  })
  it("polls a running command until its terminal result", async () => {
    const { c, request } = await fixture()
    let polls = 0
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "poll" }
      if (method === "GET" && path.endsWith("/command-runs/poll")) {
        return ++polls === 1 ? { operationId: "poll", state: "running" } : {
          operationId: "poll",
          state: "completed",
          result: { exit_code: 0, stdout: "ready", stderr: "", output_truncated: false }
        }
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "sleep 1" }))
      .resolves.toMatchObject({ stdout: "ready", exit_code: 0 })
    expect(polls).toBe(2)
  })
  it.each(["failed", "uncertain", "cancelled"])(
    "reports %s without pretending the command completed",
    async (state) => {
      const { c, request } = await fixture()
      request.mockImplementation(async (method, path) => {
        if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "failure" }
        if (method === "GET" && path.endsWith("/command-runs/failure")) {
          return { operationId: "failure", state, error: "remote outcome unavailable" }
        }
        throw new Error(`Unexpected ${method} ${path}`)
      })
      await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true" }))
        .rejects.toThrow()
    }
  )
  it.each([
    {
      receipt: { state: "completed", result: { exit_code: 0, stdout: "", stderr: "" } },
      label: "missing operation id"
    },
    {
      receipt: {
        operationId: "wrong",
        state: "completed",
        result: { exit_code: 0, stdout: "", stderr: "", output_truncated: false }
      },
      label: "wrong operation id"
    },
    { receipt: { operationId: "bad", state: "mystery" }, label: "unknown state" },
    {
      receipt: { operationId: "bad", state: "completed", result: { exit_code: "zero", stdout: "", stderr: "" } },
      label: "invalid exit code"
    }
  ])("rejects a $label receipt without rerunning the command", async ({ receipt }) => {
    const { c, request } = await fixture()
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "bad" }
      if (method === "GET" && path.endsWith("/command-runs/bad")) return receipt
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true", "exec-id": "bad" }))
      .rejects.toThrow("--exec-id bad")
    expect(request.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/command-runs")))
      .toHaveLength(1)
  })
  it("rejects a lost admission response with an explicit reattach id", async () => {
    const { c, request } = await fixture()
    request.mockRejectedValue(new Error("connection lost"))
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true", "exec-id": "retry" }))
      .rejects.toThrow("--exec-id retry")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("uses one explicit operation id when the same command is submitted again", async () => {
    const { c, request } = await fixture()
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true", "exec-id": "same" }))
        .resolves.toMatchObject({ exit_code: 0 })
    }
    const admissions = request.mock.calls.filter(([method, path]) =>
      method === "POST" && path.endsWith("/command-runs")
    )
    expect(admissions).toHaveLength(2)
    expect(admissions.map(([, , body]) => (body as Record<string, unknown>).operation_id)).toEqual(["same", "same"])
  })
  it.each(["abort", "timeout"])("cancels after %s and waits for a terminal receipt", async (reason) => {
    const { c, request, controller } = await fixture({ SMITHERS_WORKSPACE_COMMAND_POLL_INTERVAL_MS: "1" })
    let polls = 0
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "cancel" }
      if (method === "GET" && path.endsWith("/command-runs/cancel")) {
        if (++polls === 1 && reason === "abort") controller.abort()
        return { operationId: "cancel", state: polls > 2 ? "cancelled" : "running" }
      }
      if (method === "POST" && path.endsWith("/command-runs/cancel/cancel")) {
        return { operationId: "cancel", state: "running" }
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, {
      ...options,
      command: "sleep 600",
      "exec-id": "cancel",
      timeout: reason === "timeout" ? 0.001 : 0
    })).rejects.toThrow("Command interrupted")
    expect(
      request.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/command-runs/cancel/cancel"))
    )
      .toHaveLength(1)
    expect(polls).toBeGreaterThan(2)
  })
  it("keeps the reattach id when abort interrupts polling and cancellation cannot be confirmed", async () => {
    const { c, request, controller } = await fixture()
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "recover" }
      if (method === "GET" && path.endsWith("/command-runs/recover")) {
        controller.abort()
        throw new Error("poll request aborted")
      }
      if (method === "POST" && path.endsWith("/command-runs/recover/cancel")) {
        throw new Error("cancel connection lost")
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, {
      ...options,
      command: "sleep 600",
      "exec-id": "recover"
    })).rejects.toThrow("--exec-id recover")
    expect(
      request.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/command-runs/recover/cancel"))
    ).toHaveLength(1)
  })
  it.each([{ command: "" }, { command: "true", timeout: -1 }, { command: "true", env: ["bad-key=value"] }])(
    "rejects invalid exec options %j before admission",
    async (o) => {
      const { c, request } = await fixture()
      await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, ...o })).rejects.toThrow()
      expect(request.mock.calls.some(([method, path]) => method === "POST" && path.endsWith("/command-runs"))).toBe(
        false
      )
    }
  )
  it.each(["stopped", "failed", "error"])("cleans up a terminal on %s", async (terminal) => {
    const { c, request, exit } = await fixture()
    state.terminal = terminal
    request.mockResolvedValue({ id: "terminal" })
    vi.spyOn(process.stdout, "write").mockReturnValue(true)
    if (terminal === "error") {
      await expect(workspaces["workspace shell"]!(c, { id: "box" }, { ...options, cols: 100, rows: 40 })).rejects
        .toThrow("socket failed")
    } else await workspaces["workspace shell"]!(c, { id: "box" }, { ...options, cols: 100, rows: 40 })
    expect(state.url).toBe("wss://api.example.test/api/repos/owner/repo/workspace/sessions/terminal/terminal")
    expect(state.options).toMatchObject({ headers: { Authorization: "token login-secret" } })
    expect(request).toHaveBeenLastCalledWith(
      "POST",
      "/api/repos/owner/repo/workspace/sessions/terminal/destroy",
      undefined,
      { signal: expect.any(AbortSignal) }
    )
    if (terminal === "failed") expect(exit).toHaveBeenCalledWith(1)
  })
  it("refuses a terminal size that is not a whole number from 0 to 65535 before opening a session", async () => {
    const { c, request } = await fixture()
    for (const [flag, value] of [["cols", -5], ["cols", 1.5], ["rows", "x"], ["rows", 65536]] as const) {
      await expect(workspaces["workspace shell"]!(c, { id: "box" }, { ...options, [flag]: value })).rejects.toThrow(
        `--${flag}`
      )
    }
    expect(request).not.toHaveBeenCalledWith("POST", "/api/repos/owner/repo/workspace/sessions", expect.anything())
  })
  it("requires an actual terminal id", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValue({})
    await expect(workspaces["workspace shell"]!(c, { id: "box" }, options)).rejects.toThrow("omitted id")
  })
})
