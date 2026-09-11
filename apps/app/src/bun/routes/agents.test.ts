import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENT_ROLE_IDS, AgentsResponseSchema, HarnessModelsResponseSchema } from "@smthrs/rpc/AgentRoles"
import type { Harness } from "@smthrs/rpc/LocalApp"
import { LOCAL_SESSION_HEADER } from "@smthrs/rpc/LocalSession"
import { atomicWriteJson } from "../atomicWriteJson"
import { createPtyManager } from "../Pty"
import { startLocalServer } from "../server"
import { SANDBOX_EXEC } from "../Sandbox"
import { createAgentStore, modelListCommand, parseModelLines } from "./agents"

/*
 * Agents as data over a real local origin with a temp state dir
 * (custom-agents.md): the store seeds from the built-ins on first read, a
 * PUT creates or edits and persists to `<stateDir>/agents.json`, a built-in
 * cannot be removed, an unknown harness or a flag-shaped model id is
 * refused, and the models route runs the harness's own list command (a fake
 * opencode script here) under the cap.
 */

const reviewer = {
  label: "Reviewer",
  purpose: "Reviews diffs for correctness and tests.",
  harness: "codex",
  model: { provider: "openai", id: "gpt-5.6-terra", label: "GPT-5.6 Terra" }
} as const

const harnesses = (fakeOpencode: string): ReadonlyArray<Harness> => [
  {
    id: "codex",
    displayName: "Codex",
    binary: "/bin/echo",
    version: "1.0.0",
    status: "signed-in",
    account: { email: "will@example.com" },
    launch: { argv: ["codex"] },
    models: { suggestions: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], listable: false }
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    binary: fakeOpencode,
    version: "1.18.22",
    status: "signed-in",
    account: { label: "kimi-for-coding" },
    launch: { argv: ["opencode"] },
    models: { suggestions: ["kimi-for-coding/k3"], listable: true }
  },
  {
    id: "opencode-cerebras",
    displayName: "OpenCode · Cerebras",
    binary: null,
    version: null,
    status: "unavailable",
    account: null,
    launch: { argv: ["opencode", "--model", "cerebras/gpt-oss-120b"] },
    models: { suggestions: ["cerebras/gpt-oss-120b"], listable: true }
  },
  {
    id: "crush",
    displayName: "Crush",
    binary: "/bin/echo",
    version: "0.1.0",
    status: "api-key",
    account: { label: "OPENAI_API_KEY" },
    launch: { argv: ["crush"] }
  }
]

const setup = async () => {
  const dist = await mkdtemp(join(tmpdir(), "smithers-agents-dist-"))
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Smithers</title>")
  const stateDir = await mkdtemp(join(tmpdir(), "smithers-agents-state-"))
  /*
   * A fake `opencode` binary: `models` prints provider/model lines the way
   * the real one does (plus noise the parser drops); `models cerebras`
   * fails, the way a provider without a credential answers.
   */
  const fakeOpencode = join(dist, "opencode")
  await writeFile(
    fakeOpencode,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"models\" ] && [ -z \"$2\" ]; then",
      // A session token that reached the child would show up as a model id.
      "  [ -n \"$GITHUB_TOKEN$SMITHERS_CLOUD_TOKEN\" ] && echo \"leak/$GITHUB_TOKEN$SMITHERS_CLOUD_TOKEN\"",
      "  printf 'kimi-for-coding/k3\\n\\ncerebras/gpt-oss-120b\\n  cerebras/gemma-4-31b  \\nnot a model id\\n'",
      "  exit 0",
      "fi",
      "echo 'no credential for cerebras' >&2",
      "exit 2"
    ].join("\n")
  )
  await chmod(fakeOpencode, 0o755)
  const server = await startLocalServer({
    port: 0,
    distDir: dist,
    chatStub: true,
    node: { path: "/fake/node", version: "v22.19.0" },
    home: tmpdir(),
    stateDir,
    harnesses: async () => harnesses(fakeOpencode),
    pty: (deps) =>
      createPtyManager({
        ...deps,
        shell: "/bin/sh",
        home: tmpdir(),
        sandboxHost: { platform: "linux", disabled: true, log: () => {} },
        killGraceMs: 300,
        log: () => {}
      }),
    log: () => {}
  })
  const apiFetch = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set(LOCAL_SESSION_HEADER, server.sessionToken)
    return fetch(`${server.origin}${path}`, { ...init, headers })
  }

  const put = (id: string, body: unknown): Promise<Response> =>
    apiFetch(`/api/agents/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  return {
    apiFetch, put, stateDir, harnesses: () => harnesses(fakeOpencode),
    [Symbol.asyncDispose]: async () => {
      await server.stop()
      await rm(dist, { recursive: true, force: true })
      await rm(stateDir, { recursive: true, force: true })
    }
  }
}

describe("the agents routes", () => {
  test("GET seeds the built-ins on first read, in table order, with no argv stored", async () => {
    await using fixture = await setup()
    const { apiFetch } = fixture
    const response = await apiFetch("/api/agents")
    expect(response.status).toBe(200)
    const body = AgentsResponseSchema.parse(await response.json())
    expect(body.agents.map((agent) => agent.id)).toEqual([...AGENT_ROLE_IDS])
    for (const agent of body.agents) {
      expect(agent.builtin).toBe(true)
      expect("launch" in agent).toBe(false)
    }
  })

  test("PUT creates a custom agent (201), persists it under the state dir, and lists it after the built-ins", async () => {
    await using fixture = await setup()
    const { put, apiFetch, stateDir } = fixture
    const created = await put("reviewer", reviewer)
    expect(created.status).toBe(201)
    const body = (await created.json()) as { agent: { id: string; builtin: boolean; createdAt: number } }
    expect(body.agent).toMatchObject({ id: "reviewer", builtin: false, harness: "codex", model: { id: "gpt-5.6-terra" } })
    const listed = AgentsResponseSchema.parse(await (await apiFetch("/api/agents")).json())
    expect(listed.agents.map((agent) => agent.id)).toEqual([...AGENT_ROLE_IDS, "reviewer"])
    const onDisk = JSON.parse(await readFile(join(stateDir, "agents.json"), "utf8")) as { agents: Array<{ id: string }> }
    expect(onDisk.agents.some((agent) => agent.id === "reviewer")).toBe(true)
    // A fresh store over the same dir reads it back: the file is the truth across launches.
    const reopened = createAgentStore({ stateDir })
    expect((await reopened.get("reviewer"))?.label).toBe("Reviewer")
  })

  test("PUT edits an existing agent (200) and a built-in's model and purpose; a built-in's harness stays fixed", async () => {
    await using fixture = await setup()
    const { put } = fixture
    expect((await put("reviewer", reviewer)).status).toBe(201)
    const edited = await put("reviewer", { ...reviewer, purpose: "Reviews diffs, strictly." })
    expect(edited.status).toBe(200)
    expect(((await edited.json()) as { agent: { purpose: string } }).agent.purpose).toBe("Reviews diffs, strictly.")
    const explainer = await put("explainer", {
      label: "Explainer",
      purpose: "Explains, briefly.",
      harness: "opencode-kimi",
      model: { provider: "kimi-for-coding", id: "kimi-for-coding/k3", label: "Kimi K3" }
    })
    expect(explainer.status).toBe(200)
    expect(((await explainer.json()) as { agent: { builtin: boolean; purpose: string } }).agent).toMatchObject({ builtin: true, purpose: "Explains, briefly." })
    const moved = await put("explainer", { ...reviewer, label: "Explainer" })
    expect(moved.status).toBe(409)
    expect(((await moved.json()) as { error: { code: string } }).error.code).toBe("builtin_harness_fixed")
  })

  test("PUT refuses a bad id, an unknown harness, a harness with no verified model flag, and a flag-shaped model id", async () => {
    await using fixture = await setup()
    const { put, apiFetch } = fixture
    const badId = await put("Bad%20Id", reviewer)
    expect(badId.status).toBe(400)
    expect(((await badId.json()) as { error: { code: string } }).error.code).toBe("invalid_id")
    const unknown = await put("ghost", { ...reviewer, harness: "ghostwriter" })
    expect(unknown.status).toBe(400)
    const noFlag = await put("crusher", { ...reviewer, harness: "crush" })
    expect(noFlag.status).toBe(400)
    expect(((await noFlag.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "harness_no_model_flag" })
    for (const model of ["--dangerously-skip-permissions", "gpt 5", "-m"]) {
      const injected = await put("evil", { ...reviewer, model: { ...reviewer.model, id: model } })
      expect(injected.status).toBe(400)
    }
    const listed = AgentsResponseSchema.parse(await (await apiFetch("/api/agents")).json())
    expect(listed.agents.map((agent) => agent.id)).not.toContain("evil")
    expect(listed.agents.map((agent) => agent.id)).not.toContain("crusher")
  })

  test("a custom agent launches through POST /api/pty by role id with its composed argv", async () => {
    await using fixture = await setup()
    const { put, apiFetch } = fixture
    expect((await put("reviewer", reviewer)).status).toBe(201)
    const response = await apiFetch("/api/pty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "harness", cols: 80, rows: 24, roleId: "reviewer", task: "review it" })
    })
    expect(response.status).toBe(201)
    const { sessionId } = (await response.json()) as { sessionId: string }
    const deadline = Date.now() + 5000
    let output = ""
    while (Date.now() < deadline) {
      const read = (await (await apiFetch(`/api/pty/${sessionId}/output`)).json()) as { output: string; alive: boolean }
      output = read.output
      if (!read.alive) break
      await Bun.sleep(25)
    }
    expect(output).toContain("-m gpt-5.6-terra review it")
    await apiFetch(`/api/pty/${sessionId}`, { method: "DELETE" })
    const unknown = await apiFetch("/api/pty", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "harness", cols: 80, rows: 24, roleId: "poet" })
    })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("unknown_role")
  })

  test("DELETE removes a custom agent, refuses a built-in with the reason, and 404s an unknown id", async () => {
    await using fixture = await setup()
    const { put, apiFetch, stateDir } = fixture
    expect((await put("reviewer", reviewer)).status).toBe(201)
    const builtin = await apiFetch("/api/agents/orchestrator", { method: "DELETE" })
    expect(builtin.status).toBe(409)
    expect(((await builtin.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "builtin_agent" })
    const removed = await apiFetch("/api/agents/reviewer", { method: "DELETE" })
    expect(removed.status).toBe(200)
    expect((await apiFetch("/api/agents/reviewer", { method: "DELETE" })).status).toBe(404)
    const listed = AgentsResponseSchema.parse(await (await apiFetch("/api/agents")).json())
    expect(listed.agents.map((agent) => agent.id)).toEqual([...AGENT_ROLE_IDS])
    const onDisk = JSON.parse(await readFile(join(stateDir, "agents.json"), "utf8")) as { agents: Array<{ id: string }> }
    expect(onDisk.agents.map((agent) => agent.id)).toEqual([...AGENT_ROLE_IDS])
  })

  test("GET /api/harnesses/{id}/models runs the harness's list command, falls back to the table's suggestions, and states failures", async () => {
    await using fixture = await setup()
    const { apiFetch } = fixture
    const saved = { github: process.env.GITHUB_TOKEN, cloud: process.env.SMITHERS_CLOUD_TOKEN }
    process.env.GITHUB_TOKEN = "ghp_probe"
    process.env.SMITHERS_CLOUD_TOKEN = "smithers_probe"
    let listed
    try {
      listed = HarnessModelsResponseSchema.parse(await (await apiFetch("/api/harnesses/opencode/models")).json())
    } finally {
      if (saved.github === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = saved.github
      if (saved.cloud === undefined) delete process.env.SMITHERS_CLOUD_TOKEN
      else process.env.SMITHERS_CLOUD_TOKEN = saved.cloud
    }
    expect(listed).toEqual({
      harnessId: "opencode",
      models: ["kimi-for-coding/k3", "cerebras/gpt-oss-120b", "cerebras/gemma-4-31b"],
      source: "list"
    })
    // No list command: the table's verified suggestions.
    const codex = HarnessModelsResponseSchema.parse(await (await apiFetch("/api/harnesses/codex/models")).json())
    expect(codex).toEqual({ harnessId: "codex", models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], source: "suggestions" })
    // A list command whose binary is not installed: the suggestions, with the reason.
    const absent = HarnessModelsResponseSchema.parse(await (await apiFetch("/api/harnesses/opencode-cerebras/models")).json())
    // The suggestions are the SERVER table's (Harnesses.ts), never the fixture row's.
    expect(absent).toMatchObject({
      models: ["cerebras/gpt-oss-120b", "cerebras/gemma-4-31b"],
      source: "suggestions",
      reason: "OpenCode · Cerebras is not installed here."
    })
    // No verified model flag at all: empty, with the reason.
    const crush = HarnessModelsResponseSchema.parse(await (await apiFetch("/api/harnesses/crush/models")).json())
    expect(crush.models).toEqual([])
    expect(crush.reason).toContain("no model flag")
    expect((await apiFetch("/api/harnesses/ghost/models")).status).toBe(404)
  })

  test("a failing list command answers empty with its exit and first stderr line", async () => {
    await using fixture = await setup()
    const { harnesses } = fixture
    const { listHarnessModels } = await import("./agents")
    const failing: Harness = { ...harnesses()[1]!, id: "opencode-cerebras", displayName: "OpenCode · Cerebras" }
    const result = await listHarnessModels(failing, async (argv) => {
      const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { code, stdout, stderr }
    })
    expect(result).toEqual({
      harnessId: "opencode-cerebras",
      models: [],
      source: "list",
      reason: "opencode models cerebras exited 2: no credential for cerebras"
    })
    const timedOut = await listHarnessModels(failing, async () => {
      throw new Error("timed out after 5000 ms")
    })
    expect(timedOut.models).toEqual([])
    expect(timedOut.reason).toContain("timed out")
  })

  test("the list command runs under the probe sandbox with the probe environment", () => {
    const darwin = { platform: "darwin", disabled: false, log: () => {} }
    const source = { HOME: "/Users/u", PATH: "/usr/bin", KIMI_API_KEY: "kimi", GITHUB_TOKEN: "ghp", SMITHERS_CLOUD_TOKEN: "pat" }
    const wrapped = modelListCommand(["/opt/bin/fakelist", "models"], source, darwin)
    expect(wrapped.argv[0]).toBe(SANDBOX_EXEC)
    expect(wrapped.argv.slice(-2)).toEqual(["/opt/bin/fakelist", "models"])
    expect(wrapped.env).toEqual({ HOME: "/Users/u", PATH: "/usr/bin", KIMI_API_KEY: "kimi", NO_COLOR: "1" })
    // opencode writes its log outside scratch on `models`: the documented exception.
    expect(modelListCommand(["/opt/bin/opencode", "models", "cerebras"], source, darwin).argv).toEqual(["/opt/bin/opencode", "models", "cerebras"])
    expect(modelListCommand(["/opt/bin/opencode", "--version"], source, darwin).argv[0]).toBe(SANDBOX_EXEC)
  })

  test("parseModelLines keeps one id per line and drops noise", () => {
    expect(parseModelLines("a/b\n\n  c.d-e:f  \nnot a model\n-flag\n")).toEqual(["a/b", "c.d-e:f"])
  })

  for (const mutation of ["put", "remove"] as const) {
    test.each(["write", "sync", "rename"])(`${mutation}: a failed %s preserves the durable store and memory`, async (failure) => {
      await using fixture = await setup()
      const { stateDir } = fixture
      const path = join(stateDir, "agents.json")
      let fail = false
      const store = createAgentStore({
        stateDir,
        writeJson: (target, value) => atomicWriteJson(target, value, {
          open: async (...args) => {
            const file = await open(...args)
            if (fail && args[1] === "wx") {
              if (failure === "write") {
                const write = file.writeFile.bind(file)
                file.writeFile = async () => {
                  await write('{ "agents": [', "utf8")
                  throw new Error("injected write failure")
                }
              } else if (failure === "sync") {
                file.sync = async () => { throw new Error("injected sync failure") }
              }
            }
            return file
          },
          rename: async (from, to) => {
            if (fail && failure === "rename") throw new Error("injected rename failure")
            await rename(from, to)
          }
        })
      })
      expect((await store.put("reviewer", reviewer)).status).toBe("created")
      const before = await readFile(path, "utf8")
      const rows = await store.list()
      fail = true
      const mutate = () => mutation === "put"
        ? store.put("reviewer", { ...reviewer, purpose: "Edited" })
        : store.remove("reviewer")
      await expect(mutate()).rejects.toThrow(`injected ${failure} failure`)
      expect(await readFile(path, "utf8")).toBe(before)
      expect(await store.list()).toEqual(rows)
      expect(await createAgentStore({ stateDir }).list()).toEqual(rows)
      expect((await readdir(stateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
      // A rejected mutation must not poison the serialization queue.
      fail = false
      expect((await mutate()).status).toBe(mutation === "put" ? "updated" : "removed")
      expect(await createAgentStore({ stateDir }).list()).toEqual(await store.list())
    })
  }

  test("atomic replacement flushes the sibling file before rename and the parent afterwards", async () => {
    await using fixture = await setup()
    const { stateDir } = fixture
    const path = join(stateDir, "agents.json")
    await writeFile(path, "previous bytes")
    const events: Array<string> = []
    const temporaryPaths: Array<string> = []
    const io = {
      open: async (...args: Parameters<typeof open>) => {
        const file = await open(...args)
        const kind = args[1] === "wx" ? "file" : "directory"
        if (kind === "file") {
          const temporary = String(args[0])
          expect(temporary.startsWith(`${path}.`)).toBe(true)
          expect(temporary.endsWith(".tmp")).toBe(true)
          expect(args[2]).toBe(0o600)
          temporaryPaths.push(temporary)
        } else {
          expect(args[0]).toBe(stateDir)
        }
        const sync = file.sync.bind(file)
        const close = file.close.bind(file)
        file.sync = async () => { events.push(`${kind}:sync`); await sync() }
        file.close = async () => { events.push(`${kind}:close`); await close() }
        return file
      },
      rename: async (from: Parameters<typeof rename>[0], to: Parameters<typeof rename>[1]) => {
        expect(await readFile(path, "utf8")).toBe("previous bytes")
        expect(JSON.parse(await readFile(from, "utf8"))).toEqual({ agents: [] })
        events.push("rename")
        await rename(from, to)
      }
    }
    await atomicWriteJson(path, { agents: [] }, io)
    expect(events).toEqual(["file:sync", "file:close", "rename", "directory:sync", "directory:close"])
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ agents: [] })
    await writeFile(path, "previous bytes")
    await atomicWriteJson(path, { agents: [] }, io)
    expect(new Set(temporaryPaths).size).toBe(2)
    expect((await readdir(stateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("a store read error other than absence rejects without seeding", async () => {
    await using fixture = await setup()
    const { stateDir } = fixture
    await mkdir(join(stateDir, "agents.json"))
    const store = createAgentStore({ stateDir })
    await expect(store.list()).rejects.toMatchObject({ code: "EISDIR" })
    await expect(store.put("reviewer", reviewer)).rejects.toMatchObject({ code: "EISDIR" })
    expect((await readdir(stateDir)).filter((name) => name.startsWith("agents.json"))).toEqual(["agents.json"])
  })

  test.each(["{ not json", '{"agents": [{}]}'])("a corrupt store is preserved and reported: %s", async (bytes) => {
    await using fixture = await setup()
    const { stateDir } = fixture
    const path = join(stateDir, "agents.json")
    await writeFile(path, bytes)
    const lines: Array<string> = []
    const store = createAgentStore({ stateDir, log: (line) => lines.push(line) })
    await expect(store.list()).rejects.toThrow("preserved")
    await expect(store.put("reviewer", reviewer)).rejects.toThrow("preserved")
    await expect(store.remove("reviewer")).rejects.toThrow("preserved")
    const backups = (await readdir(stateDir)).filter((name) => name.startsWith("agents.json.corrupt-"))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(stateDir, backups[0]!), "utf8")).toBe(bytes)
    expect(lines.some((line) => line.includes("preserved") && line.includes(backups[0]!))).toBe(true)
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
    // Recovery on a fresh launch cannot overwrite the preserved bytes.
    expect((await createAgentStore({ stateDir }).put("reviewer", reviewer)).status).toBe("created")
    expect(await readFile(join(stateDir, backups[0]!), "utf8")).toBe(bytes)
  })

  test("a store without a state dir is memory only", async () => {
    const memory = createAgentStore()
    expect((await memory.put("scratch", reviewer)).status).toBe("created")
    expect((await memory.list()).map((agent) => agent.id)).toContain("scratch")
  })
})
