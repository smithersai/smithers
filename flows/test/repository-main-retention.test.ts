import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Redacted } from "effect"
import { FlowRuntime } from "@smthrs/flow"
import { Landing } from "../coding/landing.ts"
import { selectChangeSource } from "../repository/changes.ts"
import { captureRepository } from "../repository/inspection.ts"
import { FetchHttpClient } from "effect/unstable/http"
import { NativeCoding, NativeCodingError, nativeLayer } from "../coding/native.ts"
import { layerAt } from "../coding/snapshots.ts"
import { captureChecks, executeCommand } from "../repository/checks.ts"
import { makeRemote, RepositoryRemote } from "../repository/remote.ts"
import { ensureMainSource, hasSourceCommits } from "../repository/retention.ts"
import type { Work } from "../repository/jobs.ts"

const adapterSource = process.env.PLUE_CODING_ADAPTER_SOURCE, exporter = process.env.PLUE_JJ_EXPORT_BINARY
test("two successive missing native main commits are imported and checked without moving editor or saved setup", {
  skip: adapterSource === undefined || exporter === undefined ? "Set the Plue adapter and native exporter paths" : false, timeout: 120_000
}, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "repository-main-import-")))
  let passed = false
  t.diagnostic(`Native successive-main evidence: ${temporary}`)
  t.after(() => passed ? rm(temporary, { recursive: true, force: true }) : Promise.resolve())
  const local = join(temporary, "editor"), foreign = join(temporary, "fork"), project = join(temporary, "git"), bare = join(project, "local/mirror.git")
  const workspace = "22222222-2222-4222-8222-222222222222", socket = join(temporary, "socket")
  const sourceRef = (sha: string) => `refs/smithers/workspaces/${workspace}/sources/${sha}`
  for (const root of [local, foreign]) {
    execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
    execFileSync("jj", ["-R", root, "config", "set", "--repo", "user.name", "Native source import"], { stdio: "pipe" })
    execFileSync("jj", ["-R", root, "config", "set", "--repo", "user.email", "native-source@example.com"], { stdio: "pipe" })
  }
  const jj = (root: string, ...args: string[]) => execFileSync("jj", ["-R", root, ...args], { cwd: root, stdio: "pipe" }).toString()
  await writeFile(join(foreign, "README.md"), "# Main fixture\nRead greeting.mjs.\n")
  await writeFile(join(foreign, "greeting.mjs"), "export const greeting = 'seed';\n")
  jj(foreign, "describe", "-m", "Public seed")
  const seed = jj(foreign, "--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  const mains: string[] = []
  for (const value of ["first", "second", "raced"]) {
    jj(foreign, "new", "-m", `Public main ${value}`)
    await writeFile(join(foreign, "greeting.mjs"), `export const greeting = '${value}';\n`)
    await writeFile(join(foreign, "verify.mjs"), `import{strict as assert}from'node:assert';import{greeting}from'./greeting.mjs';assert.equal(greeting,'${value}');console.log('checked ${value} main');\n`)
    jj(foreign, "status")
    mains.push(jj(foreign, "--ignore-working-copy", "log", "-r", "@", "--no-graph", "-T", "commit_id").trim())
  }
  await mkdir(bare, { recursive: true })
  // The fixture's HTTP Git transport exercises the production import protocol;
  // cloud bookmark/retention authority is tested separately by the API suite.
  execFileSync("git", ["init", "--bare", bare], { stdio: "pipe" })
  execFileSync("git", ["--git-dir", jj(foreign, "git", "root", "--ignore-working-copy").trim(), "push", bare, ...mains.map(sha => `${sha}:${sourceRef(sha)}`)], { stdio: "pipe" })
  await writeFile(join(local, "user.txt"), "committed user contents\n")
  await mkdir(join(local, ".smithers", "repository-jobs", "issues"), { recursive: true })
  await mkdir(join(local, ".smithers", "flows", "repository-jobs"), { recursive: true })
  const promptPath = join(local, ".smithers", "repository-jobs", "issues", "prompt.md")
  const flowPath = join(local, ".smithers", "flows", "repository-jobs", "issues.md")
  await writeFile(promptPath, "saved prompt\n"); await writeFile(flowPath, "saved flow\n")
  jj(local, "status"); jj(local, "bookmark", "set", "main", "-r", "@")
  let authoritativeMain = mains[0]!
  let retained = 0, uploads = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture")
    if (url.pathname.startsWith("/api/")) {
      assert.equal(request.headers.authorization, "Bearer fixture-repository-token")
      response.setHeader("content-type", "application/json")
      if (request.method === "GET") {
        if (url.pathname.endsWith("/repository-source")) response.end(JSON.stringify({ source: "smithers-cloud" }))
        else { assert(["/api/repos/local/mirror/issues", "/api/repos/local/mirror/landings"].includes(url.pathname)); response.end("[]") }
        return
      }
      assert.equal(url.pathname, "/api/repos/local/mirror/repository-source/retain")
      let text = ""; for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      assert.deepEqual(body, { kind: "main", workspace_id: workspace, head: authoritativeMain, base: authoritativeMain })
      retained++
      response.end(JSON.stringify({ status: "retained", source: "smithers-cloud", full_name: "local/mirror", workspace_id: workspace,
        head: authoritativeMain, base: authoritativeMain, head_ref: sourceRef(authoritativeMain), base_ref: sourceRef(authoritativeMain), clone_url: `${origin}/local/mirror.git` })); return
    }
    assert(url.pathname.startsWith("/local/mirror.git/"))
    if (request.headers.authorization !== `Basic ${Buffer.from("x-access-token:fixture-fetch-token").toString("base64")}`) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="native source fixture"' }); response.end(); return
    }
    uploads++
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const process = spawn("git", ["http-backend"], { env: { ...globalThis.process.env, GIT_PROJECT_ROOT: project, GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: request.method!, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: String(body.length), REMOTE_USER: "fixture", HTTP_GIT_PROTOCOL: request.headers["git-protocol"] as string ?? "",
      HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "" }, stdio: ["pipe", "pipe", "pipe"] })
    const output: Buffer[] = [], errors: Buffer[] = []
    process.stdout.on("data", chunk => output.push(chunk)); process.stderr.on("data", chunk => errors.push(chunk)); process.stdin.end(body)
    const code = await new Promise<number | null>(resolve => process.on("close", resolve))
    assert.equal(code, 0, Buffer.concat(errors).toString())
    const raw = Buffer.concat(output), boundary = raw.indexOf("\r\n\r\n")
    assert(boundary > 0)
    for (const line of raw.subarray(0, boundary).toString().split("\r\n")) {
      const at = line.indexOf(":"); if (at < 1) continue
      const name = line.slice(0, at), value = line.slice(at + 1).trim()
      if (name.toLowerCase() === "status") response.statusCode = Number(value.split(" ")[0]); else response.setHeader(name, value)
    }
    response.end(raw.subarray(boundary + 4))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address(); assert(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  execFileSync("git", ["credential-cache", "--socket", socket, "store"], {
    input: `protocol=http\nhost=127.0.0.1:${address.port}\npath=local/mirror.git\nusername=x-access-token\npassword=fixture-fetch-token\n\n`, stdio: ["pipe", "pipe", "pipe"] })
  t.after(() => { try { execFileSync("git", ["credential-cache", "--socket", socket, "exit"], { stdio: "pipe" }) } catch {} })
  const config = join(temporary, "binding.json"), reporter = join(temporary, "reporter"), adapter = join(temporary, "adapter.py"), nativeSource = join(temporary, "native.py")
  await writeFile(config, JSON.stringify({ version: 1, workspaceId: workspace, repositoryId: 42, repositorySlug: "local/mirror", actorId: 42, repositoryPath: local, username: userInfo().username,
    apiBaseUrl: `${origin}/api`, gitUrl: `${origin}/local/mirror.git`, credentialSocket: socket }))
  await writeFile(reporter, 'exec 9>"$op_repo/smithers-coding.lock"')
  await writeFile(nativeSource, (await readFile(adapterSource!, "utf8")).replaceAll('"/usr/local/bin/smithers-jj-export"', JSON.stringify(exporter)))
  await writeFile(adapter, `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("coding",${JSON.stringify(nativeSource)})\ncoding=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(coding)\ncoding.REPORTER_SCRIPT=${JSON.stringify(reporter)}\ntry:\n print(json.dumps(coding.run_local(${JSON.stringify(config)}, engine="--engine" in sys.argv)))\nexcept coding.CodingError as error:\n print(json.dumps({"error":{"code":error.code,"message":error.message}}))\n sys.exit(1)\n`)
  const nativeOptions = { repositoryPath: local, adapterPath: adapter }
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer)))
  const options = { repositoryPath: local, fs, exporterPath: exporter, environment: { PATH: globalThis.process.env.PATH! } }
  const remote = await Effect.runPromise(makeRemote({ apiBaseUrl: `${origin}/api`, repositorySlug: "local/mirror", repositoryId: 42,
    workspaceId: workspace, token: Redacted.make("fixture-repository-token"), gatewayId: "11111111-1111-4111-8111-111111111111", credential: "fixture-gateway-token" }).pipe(Effect.provide(FetchHttpClient.layer)))
  const native = await Effect.runPromise(NativeCoding.pipe(Effect.provide(nativeLayer(nativeOptions)), Effect.provide(NodeServices.layer)))
  const landing: Landing["Service"] = { binding: { repositoryId: 42, workspaceId: workspace }, readMain: Effect.sync(() => authoritativeMain),
    prepare: () => Effect.die("no publication in this import test"), create: () => Effect.die("no landing in this import test"), queue: () => Effect.die("no queue"), observe: () => Effect.die("no observation") }
  const services = Layer.mergeAll(Layer.succeed(NativeCoding, { ...native, sourcePublication: "cloud" }), layerAt(nativeOptions),
    Layer.succeed(RepositoryRemote, remote), Layer.succeed(Landing, landing), Layer.succeed(FlowRuntime.FlowInstance, { executionId: "native-main-test" } as FlowRuntime.FlowInstance["Service"])).pipe(Layer.provideMerge(NodeServices.layer))
  const before = await Effect.runPromise(native.read())
  const bookmarks = jj(local, "bookmark", "list", "--all-remotes", "--ignore-working-copy")
  const dirty = "unsnapshotted user edit stays here\n", dirtyPrompt = "uncommitted prompt edit\n"
  await writeFile(join(local, "user.txt"), dirty); await writeFile(promptPath, dirtyPrompt)
  const unchanged = async () => {
    const current = await Effect.runPromise(native.read())
    const { operationId: _before, ...beforeHead } = before.head, { operationId: _current, ...currentHead } = current.head
    assert.deepEqual(currentHead, beforeHead)
    assert.equal(jj(local, "bookmark", "list", "--all-remotes", "--ignore-working-copy"), bookmarks)
    assert.equal(await readFile(join(local, "user.txt"), "utf8"), dirty)
    assert.equal(await readFile(promptPath, "utf8"), dirtyPrompt)
    assert.equal(await readFile(flowPath, "utf8"), "saved flow\n")
  }
  const evidence = await Effect.runPromise(captureRepository(options, { repo: "local/mirror", prompt: "greeting.mjs", sourceRevision: before.head.commitId }, "immutable").pipe(Effect.provide(services)))
  const command = { id: "execute", name: "Execute", kind: "command" as const, rule: "node verify.mjs", paths: [], policy: "required" as const }
  const work: typeof Work.Type = { repo: "local/mirror", job: "feature", event: { source: "smithers-cloud", type: "manual", action: "manual:feature", manualStep: "feature", deliveryKey: "request", payload: { manual: { prompt: "Update greeting.mjs" } } },
    step: { id: "feature", name: "Feature", mode: "manual", prompt: "Update greeting.mjs" }, checks: [command],
    landing: "ask", replies: "draft", executionMode: "live", deadlineAt: Date.now() + 60_000, evidence }
  for (const [index, main] of mains.slice(0, 2).entries()) {
    authoritativeMain = main
    const state = await Effect.runPromise(native.read())
    assert.equal(await Effect.runPromise(hasSourceCommits(options, [main], state.operationId).pipe(Effect.provide(services))), false, "each new main starts absent from the JJ index")
    const selected = await Effect.runPromise(selectChangeSource(options, work).pipe(Effect.provide(services)))
    assert.equal(selected.blocked, "", "the real proposal source selector imports current main before approval")
    assert.equal(selected.work.evidence.source.commitId, main)
    assert.deepEqual(selected.work.evidence.source.parentCommitIds, [index === 0 ? seed : mains[0]!])
    assert.equal(selected.work.evidence.files.find(file => file.path === "greeting.mjs")?.text, `export const greeting = '${index === 0 ? "first" : "second"}';\n`)
    assert(!selected.work.evidence.files.some(file => file.path.startsWith(".smithers/")), "editing configuration is not included in selected public source")
    const plan = await Effect.runPromise(captureChecks(options, selected.work).pipe(Effect.provide(services)))
    const checked = await Effect.runPromise(executeCommand(options, plan, command, `native-main-${index}`).pipe(Effect.provide(services)))
    assert.equal(checked.status, "passed"); assert.match((checked.detail as { stdout: string }).stdout, new RegExp(`checked ${index === 0 ? "first" : "second"} main`))
    await unchanged()
    assert.equal(retained, index + 1)
    await Effect.runPromise(ensureMainSource(options, main).pipe(Effect.provide(services)))
    assert.equal(retained, index + 1, "already indexed current main needs no new transfer")
  }
  assert(uploads > 0)
  const requests = retained
  await assert.rejects(Effect.runPromise(ensureMainSource(options, mains[0]!).pipe(Effect.provide(services))), /Main changed/)
  assert.equal(retained, requests, "an old retained main cannot authorize work after advancement")
  authoritativeMain = mains[2]!
  const unavailableNative: NativeCoding["Service"] = { ...native, importSource: () => Effect.fail(new NativeCodingError({ code: "source_missing", message: "The verified retained source disappeared" })) }
  const missing = await Effect.runPromise(ensureMainSource(options, mains[2]!).pipe(Effect.provideService(NativeCoding, unavailableNative), Effect.provide(services), Effect.result))
  assert.equal(missing._tag, "Failure")
  if (missing._tag === "Failure") assert.equal(missing.failure.code, "source_missing", "native source failures retain their actionable domain reason")
  await unchanged()
  const racingNative: NativeCoding["Service"] = { ...native, importSource: request => native.importSource!(request).pipe(Effect.tap(() => Effect.sync(() => { authoritativeMain = mains[1]! }))) }
  await assert.rejects(Effect.runPromise(ensureMainSource(options, mains[2]!).pipe(Effect.provideService(NativeCoding, racingNative), Effect.provide(services))), /Main changed/)
  const afterRace = await Effect.runPromise(native.read())
  assert.equal(await Effect.runPromise(hasSourceCommits(options, [mains[2]!], afterRace.operationId).pipe(Effect.provide(services))), true, "imported objects may remain after a moved-main refusal")
  await unchanged()
  passed = true
})
