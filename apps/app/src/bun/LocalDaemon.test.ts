import { afterEach, expect, test } from "bun:test"
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { LOCAL_SESSION_HEADER, localSessionProtocol } from "@smthrs/rpc/LocalSession"
import { attachLocalDaemon, type LocalDaemonAttachment } from "./LocalDaemonClient"
import { daemonRequest, descriptorPath, readDaemonDescriptor, type DaemonConfiguration } from "./LocalDaemonProtocol"
import { createPtyClient } from "../mainview/state/PtyClient"
import { shutdownLocalDaemon } from "./LocalDaemonStop"

const roots: string[] = []
const until = async (check: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 5000
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Session fixture did not become ready")
    await Bun.sleep(10)
  }
}
afterEach(async () => {
  for (const root of roots) await shutdownLocalDaemon(join(root, "state"))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "smithers-daemon-"))
  roots.push(root)
  await writeFile(join(root, "index.html"), "<!doctype html><html><head></head><body>fixture</body></html>")
  const configuration: DaemonConfiguration = {
    stateDir: join(root, "state"), distDir: root, chatStub: true,
    cloudMode: "offline", allowManualRepositoryPaths: false, build: "fixture-build"
  }
  const options = {
    entrypoint: join(import.meta.dir, "index.ts"),
    env: { HOME: root, SHELL: "/bin/sh", PATH: "/usr/bin:/bin", SMITHERS_SANDBOX: "0" }
  }
  const attach = async () => {
    const owner = await attachLocalDaemon(configuration, options)
    return owner
  }
  return { root, configuration, options, attach }
}
const api = async (owner: LocalDaemonAttachment) => {
  const html = await (await fetch(owner.origin)).text()
  const token = /name="smithers-local-session" content="([^"]+)"/.exec(html)?.[1]
  if (token === undefined) throw new Error("No local session capability in fixture document")
  const request = (path: string, init?: RequestInit) => fetch(owner.origin + path, {
    ...init, headers: { [LOCAL_SESSION_HEADER]: token, "content-type": "application/json", ...init?.headers }
  })
  return { token, request }
}

test("a real launcher exits; reopen retains the exact shell, variables, output and authenticated origin", async () => {
  const f = await fixture()
  const launcher = join(f.root, "launcher.ts")
  await writeFile(launcher, `
    import { attachLocalDaemon } from ${JSON.stringify(join(import.meta.dir, "LocalDaemonClient.ts"))};
    const owner = await attachLocalDaemon(${JSON.stringify(f.configuration)}, ${JSON.stringify(f.options)});
    import { createPtyClient } from ${JSON.stringify(join(import.meta.dir, "../mainview/state/PtyClient.ts"))};
    const html = await (await fetch(owner.origin)).text();
    const token = /name="smithers-local-session" content="([^"]+)"/.exec(html)[1];
    const headers = { "x-smithers-local-session": token, "content-type": "application/json" };
    const created = await (await fetch(owner.origin + "/api/pty", {
      method: "POST", headers, body: JSON.stringify({ kind: "terminal", cols: 80, rows: 24 })
    })).json();
    const session = (await (await fetch(owner.origin + "/api/pty", { headers })).json()).sessions[0];
    let output = "";
    const transport = createPtyClient({ baseUrl: owner.origin, http: fetch,
      socketUrl: () => owner.origin.replace("http:", "ws:") + "/ws", socketProtocols: () => ["smithers.local." + token] });
    transport.attach(created.sessionId, { onOutput: (data) => { output += data }, onExit: () => {} });
    transport.input(created.sessionId, ${JSON.stringify("stty -echo; SMITHERS_CONTINUITY=retained; printf '\\ninitial:%s:%s\\n' \"$$\" \"$SMITHERS_CONTINUITY\"\n")});
    const deadline = Date.now() + 5000;
    while (!output.includes("initial:" + session.pid + ":retained")) {
      if (Date.now() > deadline) throw new Error("launcher terminal did not execute");
      await Bun.sleep(10);
    }
    transport.dispose();
    console.log(JSON.stringify({ origin: owner.origin, instance: owner.instance, session }));
    await owner.detach();
  `)
  const child = Bun.spawn([process.execPath, launcher], { stdout: "pipe", stderr: "pipe" })
  expect(await child.exited).toBe(0)
  const first = JSON.parse(await new Response(child.stdout).text()) as {
    origin: string; instance: string; session: { sessionId: string; pid: number }
  }
  const owner = await f.attach()
  expect(owner.origin).toBe(first.origin)
  expect(owner.instance).toBe(first.instance)
  const { token, request } = await api(owner)
  const session = first.session
  const sessionId = session.sessionId
  const connect = () => createPtyClient({
    baseUrl: owner.origin, http: (url, init) => fetch(url, { ...init, headers: { ...init?.headers, [LOCAL_SESSION_HEADER]: token } }),
    socketUrl: () => owner.origin.replace("http:", "ws:") + "/ws", socketProtocols: () => [localSessionProtocol(token)]
  })
  await owner.detach()
  const reopened = await f.attach()
  expect(reopened.instance).toBe(first.instance)
  expect((await (await request("/api/pty")).json() as { sessions: unknown[] }).sessions[0]).toEqual(session)
  let restored = ""
  const second = connect()
  second.attach(sessionId, { onOutput: (data) => { restored += data }, onExit: () => {} })
  await until(() => restored.includes(`initial:${session.pid}:retained`))
  second.input(sessionId, "printf '\\nreopened:%s:%s\\n' \"$$\" \"$SMITHERS_CONTINUITY\"\n")
  await until(() => restored.includes(`reopened:${session.pid}:retained`))
  second.dispose()
  expect((await request(`/api/pty/${sessionId}`, { method: "DELETE" })).status).toBe(200)
  expect((await (await request("/api/pty")).json() as { sessions: unknown[] }).sessions).toEqual([])
  expect(() => process.kill(session.pid, 0)).toThrow()
}, 20_000)

test("concurrent first launches converge; incompatible builds preserve the running owner", async () => {
  const f = await fixture()
  const attached = await Promise.all([f.attach(), f.attach(), f.attach()])
  expect(new Set(attached.map((owner) => owner.instance)).size).toBe(1)
  expect(new Set(attached.map((owner) => owner.origin)).size).toBe(1)
  await expect(attachLocalDaemon({ ...f.configuration, build: "different" }, f.options)).rejects.toThrow("different Smithers build")
  expect((await f.attach()).instance).toBe(attached[0]!.instance)
}, 20_000)

test("private native control rejects renderer credentials, browser Origin and malformed picker grants", async () => {
  const f = await fixture()
  const owner = await f.attach()
  const descriptor = (await readDaemonDescriptor(f.configuration.stateDir))!
  const { token, request } = await api(owner)
  expect((await lstat(descriptorPath(f.configuration.stateDir))).mode & 0o077).toBe(0)
  expect((await lstat(descriptor.socket)).mode & 0o077).toBe(0)
  expect(descriptor.token).not.toBe(token)
  const privateFetch = (headers: Record<string, string>) => fetch("http://localhost/health", { unix: descriptor.socket, headers })
  expect((await privateFetch({ authorization: `Bearer ${token}` })).status).toBe(403)
  expect((await privateFetch({ authorization: `Bearer ${descriptor.token}`, origin: owner.origin })).status).toBe(403)
  expect((await daemonRequest(descriptor, "/authorize-repository", { path: f.root, access: "write" })).status).toBe(400)
  expect((await request("/authorize-repository", { method: "POST", body: "{}" })).status).toBe(405)
  expect((await request("/shutdown", { method: "POST", body: "{}" })).status).toBe(405)
  await chmod(descriptorPath(f.configuration.stateDir), 0o644)
  await expect(f.attach()).rejects.toThrow("must be private")
  await chmod(descriptorPath(f.configuration.stateDir), 0o600)
}, 20_000)

test("explicit shutdown reaps sessions; the new owner keeps the origin without restarting commands", async () => {
  const f = await fixture()
  const owner = await f.attach()
  const { request } = await api(owner)
  await request("/api/pty", { method: "POST", body: JSON.stringify({ kind: "terminal", cols: 80, rows: 24 }) })
  const before = (await (await request("/api/pty")).json() as { sessions: { pid: number }[] }).sessions[0]!
  await owner.shutdown()
  expect(() => process.kill(before.pid, 0)).toThrow()
  const next = await f.attach()
  expect(next.origin).toBe(owner.origin)
  expect(next.instance).not.toBe(owner.instance)
  const restarted = await api(next)
  expect((await (await restarted.request("/api/pty")).json() as { sessions: unknown[] }).sessions).toEqual([])
}, 20_000)

test("the bundled main entry runs the daemon without importing the native SDK", async () => {
  const f = await fixture()
  const outdir = join(f.root, "bundle")
  const build = await Bun.build({
    entrypoints: [f.options.entrypoint], target: "bun", format: "esm", outdir,
    external: ["electrobun/main"], splitting: false
  })
  expect(build.success).toBe(true)
  const owner = await attachLocalDaemon(f.configuration, { ...f.options, entrypoint: join(outdir, "index.js") })
  expect((await (await api(owner)).request("/api/pty")).status).toBe(200)
}, 20_000)
