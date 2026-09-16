import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NativeCoding, nativeLayer } from "../coding/native.ts"
import { layerAt } from "../coding/snapshots.ts"
import { captureChecks, executeCommand } from "../repository/checks.ts"
import { makeRemote, RepositoryRemote } from "../repository/remote.ts"
import { ensureSource, hasSourceCommits } from "../repository/retention.ts"
import { withCapturedCommit } from "../repository/source.ts"
import type { Work } from "../repository/jobs.ts"

const adapterSource = process.env.PLUE_CODING_ADAPTER_SOURCE, exporter = process.env.PLUE_JJ_EXPORT_BINARY
test("a missing fork source is retained, imported and checked without moving the editor or user bookmarks", {
  skip: adapterSource === undefined || exporter === undefined ? "Set the Plue adapter and native exporter paths" : false, timeout: 120_000
}, async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "repository-source-import-")))
  let passed = false
  t.diagnostic(`Native source import evidence: ${temporary}`)
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
  await writeFile(join(foreign, "greeting.mjs"), "export const greeting = 'before';\n")
  await writeFile(join(foreign, "verify.mjs"), "import{strict as assert}from'node:assert';import{greeting}from'./greeting.mjs';assert.equal(greeting,'fork');console.log('checked fork source');\n")
  jj(foreign, "status")
  const base = jj(foreign, "log", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  jj(foreign, "new", "-m", "Change the fork greeting")
  await writeFile(join(foreign, "greeting.mjs"), "export const greeting = 'fork';\n")
  jj(foreign, "status")
  const head = jj(foreign, "log", "-r", "@", "--no-graph", "-T", "commit_id").trim()
  await mkdir(bare, { recursive: true })
  execFileSync("git", ["init", "--bare", bare], { stdio: "pipe" })
  execFileSync("git", ["--git-dir", jj(foreign, "git", "root", "--ignore-working-copy").trim(), "push", bare, `${base}:${sourceRef(base)}`, `${head}:${sourceRef(head)}`], { stdio: "pipe" })
  await writeFile(join(local, "user.txt"), "committed user contents\n")
  jj(local, "status"); jj(local, "bookmark", "set", "main", "-r", "@")
  const actualPR = { number: 7, title: "Change greeting", body: "Inspect greeting.mjs", head: { sha: head, ref: "contribution", repo: { full_name: "contributor/fork" } },
    base: { sha: base, ref: "main", repo: { full_name: "original/source" } } }
  let retained = 0, uploads = 0
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture")
    if (url.pathname.startsWith("/api/")) {
      assert.equal(request.headers.authorization, "Bearer fixture-repository-token")
      response.setHeader("content-type", "application/json")
      if (url.pathname.endsWith("/repository-source")) { response.end(JSON.stringify({ source: "github", full_name: "original/source" })); return }
      let text = ""; for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      if (url.pathname.endsWith("/github-proxy")) {
        assert.deepEqual(body, { method: "GET", path: "/repos/original/source/pulls/7" })
        response.end(JSON.stringify(actualPR)); return
      }
      assert.equal(url.pathname, "/api/repos/local/mirror/repository-source/retain")
      assert.deepEqual(body, { kind: "pull_request", number: 7, head, base, workspace_id: workspace })
      retained++
      response.end(JSON.stringify({ status: "retained", source: "github", full_name: "original/source", workspace_id: workspace,
        head, base, head_ref: sourceRef(head), base_ref: sourceRef(base), clone_url: `${origin}/local/mirror.git` })); return
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
  const services = Layer.mergeAll(nativeLayer(nativeOptions), layerAt(nativeOptions), Layer.succeed(RepositoryRemote, remote)).pipe(Layer.provideMerge(NodeServices.layer))
  const before = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(Effect.provide(services)))
  const bookmarks = jj(local, "bookmark", "list", "--all-remotes", "--ignore-working-copy")
  const dirty = "unsnapshotted user edit stays here\n"
  await writeFile(join(local, "user.txt"), dirty)
  assert.equal(await Effect.runPromise(hasSourceCommits(options, [head, base], before.operationId).pipe(Effect.provide(services))), false)
  const event = { source: "github" as const, type: "pull_request", action: "opened", deliveryKey: "github:real-shaped-pr", issueNumber: 7,
    payload: { repository: { full_name: "original/source" }, pull_request: actualPR } }
  const reviewed = await Effect.runPromise(remote.resolveReview!(event))
  await Effect.runPromise(ensureSource(options, event, reviewed.payload, "native-source-test").pipe(Effect.provide(services)))
  const after = await Effect.runPromise(Effect.flatMap(NativeCoding, native => native.read()).pipe(Effect.provide(services)))
  assert.equal(after.head.commitId, before.head.commitId)
  assert.equal(after.head.changeId, before.head.changeId)
  assert.equal(jj(local, "bookmark", "list", "--all-remotes", "--ignore-working-copy"), bookmarks)
  assert.equal(await readFile(join(local, "user.txt"), "utf8"), dirty)
  assert.equal(retained, 1); assert(uploads > 0)
  await Effect.runPromise(ensureSource(options, event, reviewed.payload, "native-source-replay").pipe(Effect.provide(services)))
  assert.equal(retained, 1, "already captured commits need no second external retention request")
  const source = await Effect.runPromise(withCapturedCommit(options, head, after.operationId, (root, revision) => Effect.gen(function*() {
    assert.equal(yield* fs.readFileString(join(root, "greeting.mjs")), "export const greeting = 'fork';\n")
    return revision
  })).pipe(Effect.provide(services)))
  assert.deepEqual(source.parentCommitIds, [base])
  const command = { id: "execute", name: "Execute", kind: "command" as const, rule: "node verify.mjs", paths: [], policy: "required" as const }
  const work: typeof Work.Type = { repo: "local/mirror", job: "ci", event: { ...event, payload: reviewed.payload },
    step: { id: "checks", name: "Checks", mode: "automatic", prompt: "Check the proposed source" },
    checks: [command, { id: "semantic", name: "Review", kind: "ai", rule: "Inspect the changed greeting", paths: ["greeting.mjs"], policy: "required" }],
    landing: "ask", replies: "draft", executionMode: "trial", deadlineAt: Date.now() + 60_000,
    evidence: { repo: "local/mirror", source, files: [], missing: [], history: [], records: [], sources: [] } }
  const plan = await Effect.runPromise(captureChecks(options, work).pipe(Effect.provide(services)))
  assert.equal(plan.comparison.base, base); assert.equal(plan.comparison.candidate, head)
  assert.deepEqual(plan.comparison.paths, ["greeting.mjs"])
  assert(plan.comparison.diff.includes("+'fork'") || plan.comparison.diff.includes("+export const greeting = 'fork'"))
  assert(plan.comparison.files.some(file => file.path === "greeting.mjs" && file.text.includes("'fork'")))
  const checked = await Effect.runPromise(executeCommand(options, plan, command, "native-source-check").pipe(Effect.provide(services)))
  assert.equal(checked.status, "passed"); assert.match((checked.detail as { stdout: string }).stdout, /checked fork source/)
  assert.equal(jj(local, "bookmark", "list", "--all-remotes", "--ignore-working-copy"), bookmarks)
  assert.equal(await readFile(join(local, "user.txt"), "utf8"), dirty)
  passed = true
})
