import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"
import type { GraphEdge, GraphNode, TargetGraphResponse } from "@smthrs/rpc/TargetGraph"
import { splitLabel } from "@smthrs/rpc/LocalApp"
import { isPrivateLabel } from "@smthrs/rpc/TargetGraphCli"
import type { NodeSidecar } from "./Node"
import { declarationBindings } from "./DeclarationBindings"
import { currentSandboxHost, loaderPolicy, wrapSandbox } from "./Sandbox"
import type { SandboxHost } from "./Sandbox"
import {
  buildCliEnvironment,
  planArgv,
  QUERY_TIMEOUT_MS,
  queryTargets,
  resolveBuildCli,
  sandboxPathsFor
} from "./Targets"

type JsonObject = Record<string, unknown>

const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null ? value as JsonObject : undefined

const strings = (value: unknown): Array<string> | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined

export const parseTextGraph = (
  text: string,
  rows: ReadonlyArray<{ readonly label: string; readonly rule?: string; readonly target?: string; readonly kinds?: ReadonlyArray<string> }> = []
): { readonly nodes: Array<GraphNode>; readonly edges: Array<GraphEdge> } => {
  const rowByLabel = new Map(rows.map((row) => [row.label, row]))
  const labels = new Set<string>()
  const edges: Array<GraphEdge> = []
  const ruleOf = new Map<string, string>()
  const seen = new Set<string>()
  const addEdge = (from: string, to: string, kind: GraphEdge["kind"]): void => {
    const key = `${from} ${to} ${kind}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, kind })
  }
  let from: string | undefined
  /*
   * Two text forms. The whole graph (`graph //...`) lists each label on its
   * own line with `  - <kind> -> //dep` edge lines under it. A scoped graph
   * (`graph <label>`) is a TREE: `//root (Rule)` then `├─ //dep (Rule)` /
   * `└─ //dep (Rule)` rows whose depth is the glyph's column (three columns
   * per level), every row a `deps` edge from the nearest shallower row.
   */
  const stack: Array<string> = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue
    const edge = /^\s+-\s*(data|gates|services|deps)\s*->\s*(\/\/\S+)\s*$/.exec(line)
    if (edge !== null && from !== undefined) {
      const to = edge[2]!
      labels.add(to)
      addEdge(from, to, edge[1] as GraphEdge["kind"])
      continue
    }
    const branch = /^([\s│|]*)[├└]─+\s*(\/\/\S+)(?:\s+\(([^)]*)\))?(?:\s+\[[^\]]*\])?\s*$/.exec(line)
    if (branch !== null) {
      const depth = Math.floor((branch[1] ?? "").length / 3) + 1
      const label = branch[2]!
      labels.add(label)
      if (branch[3] !== undefined) ruleOf.set(label, branch[3])
      stack.length = Math.min(stack.length, depth)
      const parent = stack[depth - 1]
      if (parent !== undefined) addEdge(parent, label, "deps")
      stack[depth] = label
      continue
    }
    const root = /^(\/\/\S+)(?:\s+\(([^)]*)\))?(?:\s+\[[^\]]*\])?\s*$/.exec(line)
    if (root !== null) {
      const label = root[1]!
      from = label
      labels.add(label)
      if (root[2] !== undefined) ruleOf.set(label, root[2])
      stack.length = 0
      stack[0] = label
    }
  }
  for (const row of rows) labels.add(row.label)
  const nodes = [...labels].map((label): GraphNode => {
    const row = rowByLabel.get(label)
    const parts = splitLabel(label)
    return {
      label,
      ...parts,
      rule: row?.rule ?? row?.target ?? ruleOf.get(label) ?? "",
      kinds: [...(row?.kinds ?? [])],
      /* The contract's rule, shared with the dev fixture stream's reader so a card hides the same nodes either way. */
      private: isPrivateLabel(label)
    }
  })
  return { nodes, edges }
}

export const foldPlan = (nodes: ReadonlyArray<GraphNode>, envelopes: ReadonlyArray<unknown>): Array<GraphNode> => {
  const plans = new Map<string, GraphNode["plan"]>()
  for (const envelope of envelopes) {
    const targets = object(envelope)?.targets
    if (!Array.isArray(targets)) continue
    for (const value of targets) {
      const row = object(value)
      if (row === undefined || typeof row.label !== "string") continue
      const mode = row.mode === "execute" || row.mode === "check" || row.mode === "write" ? row.mode : undefined
      const plan: NonNullable<GraphNode["plan"]> = {
        ...(mode === undefined ? {} : { mode }),
        ...(typeof row.cacheable === "boolean" ? { cacheable: row.cacheable } : {}),
        ...(typeof row.key === "string" ? { key: row.key } : {}),
        ...(typeof row.refusal === "string" ? { refusal: row.refusal } : {}),
        ...(strings(row.argv) === undefined ? {} : { argv: strings(row.argv)! }),
        ...(typeof row.sandbox === "string" ? { sandbox: row.sandbox } : {}),
        ...(strings(row.outDirs) === undefined ? {} : { outDirs: strings(row.outDirs)! }),
        ...(strings(row.outFiles) === undefined ? {} : { outFiles: strings(row.outFiles)! }),
        ...(strings(row.inputs) === undefined ? {} : { inputs: strings(row.inputs)! })
      }
      plans.set(row.label, plan)
    }
  }
  return nodes.map((node) => plans.has(node.label) ? { ...node, plan: plans.get(node.label) } : { ...node })
}

const SKIPPED_DIRS = [".git", ".flows", "node_modules", "dist", "build"]
const DECLARATION_FILES = ["PACKAGE.ts", "WORKSPACE.ts"]

/** The declaration set of a workspace: a content digest, the files read, plus each labeled const's declaration site. */
export interface DeclarationSet {
  readonly digest: string
  readonly files: ReadonlyArray<string>
  readonly sources: ReadonlyMap<string, GraphNode["source"]>
}

/*
 * Fingerprints the workspace's declarations, ASYNCHRONOUSLY, by content.
 *
 * This runs on every graph/affected/ci request - it is what makes a graph go
 * stale the instant a declaration is edited - so it walks the whole source
 * tree. Done with synchronous fs calls it measured 160-190ms of blocked event
 * loop per request on ~/artsy/force, during which the server answered nothing
 * and no frame of a streaming run reached a live overlay. Sibling directories
 * are walked concurrently, file contents are read in modest batches so the
 * loop breathes, and the digest is fed in sorted path order so it stays
 * stable whatever order the filesystem and the scheduler answer in. Hashing
 * contents (not mtime/size) means an edit that keeps size and mtime still
 * re-keys the graph; the same pass records where each labeled const is
 * declared for the drawer's "open declaration" affordance.
 */
const declarationSet = async (repo: string): Promise<DeclarationSet> => {
  const found: Array<string> = []
  const walk = async (dir: string): Promise<void> => {
    let entries: Array<import("node:fs").Dirent>
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    await Promise.all(entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.includes(entry.name)) await walk(join(dir, entry.name))
        return
      }
      if (entry.isFile() && DECLARATION_FILES.includes(entry.name)) found.push(join(dir, entry.name))
    }))
  }
  await walk(repo)
  found.sort((left, right) => left.localeCompare(right))
  const contents = new Map<string, string>()
  const BATCH = 64
  for (let offset = 0; offset < found.length; offset += BATCH) {
    await Promise.all(found.slice(offset, offset + BATCH).map(async (path) => {
      try { contents.set(path, await readFile(path, "utf8")) } catch { /* A declaration that vanished mid-walk is simply not in the graph. */ }
    }))
  }
  const hash = createHash("sha256")
  const files: Array<string> = []
  const sources = new Map<string, GraphNode["source"]>()
  for (const path of found) {
    const text = contents.get(path)
    if (text === undefined) continue
    const file = relative(repo, path).split(sep).join("/")
    files.push(file)
    hash.update(file).update("\0").update(text).update("\0")
    if (path.endsWith("PACKAGE.ts")) {
      const packageDir = dirname(file) === "." ? "" : dirname(file)
      for (const binding of declarationBindings(text)) {
        const line = text.slice(0, binding.start).split("\n").length
        sources.set(`//${packageDir}:${binding.name}`, { file, line })
      }
    }
  }
  return { digest: hash.digest("hex"), files, sources }
}

/*
 * The repository's declaration files as they are NOW, repo-relative.
 *
 * The affected and CI routes read the list inspectRepo computed once, at
 * `/api/repo/open`, so a PACKAGE.ts written after that open matched nothing -
 * neither its own inputs nor its own edit - while the graph digest beside it
 * re-walked the tree on every request. This is the walk the digest already
 * does, so both answers describe the same checkout.
 */
export const declarationFilesOf = async (repo: string): Promise<ReadonlyArray<string>> =>
  (await declarationSet(repo)).files

interface CachedGraph { readonly digest: string; readonly response: TargetGraphResponse }
const graphCache = new Map<string, CachedGraph>()
/*
 * The whole-graph refusal, remembered per declaration digest: a checkout
 * whose `graph //...` fails takes seconds to say so, and every scoped read
 * (one drawer open) would otherwise pay that again before falling back. An
 * edit to any declaration re-keys the digest and the whole graph is tried
 * again.
 */
const wholeGraphFailures = new Map<string, { readonly digest: string; readonly error: Error }>()
type TargetsResult = Awaited<ReturnType<typeof queryTargets>>

/*
 * One repository's cold load, shared by everyone who wants it.
 *
 * A cold read spawns `query` and `graph //...` and takes SECONDS on a
 * monorepo. `/api/targets/affected`, `/api/targets/ci` and the run route's
 * revalidation all reach queryTargetGraph, so overlapping callers each
 * spawned their own pair of loader children and each rewrote the same cache
 * entry. Keyed by declaration digest as well as repository, the way
 * TargetRunHistory keys `loading`: a declaration edit re-keys the digest, so
 * a caller after the edit starts a fresh load instead of joining a stale one.
 * Only the WHOLE graph is shared - a label-scoped fallback answers one
 * caller's labels and is never cached, so it is never handed to another.
 */
interface GraphLoad {
  readonly digest: string
  readonly targets: Promise<TargetsResult>
  readonly whole: Promise<CachedGraph>
}
const loading = new Map<string, GraphLoad>()

export const clearTargetGraphCache = (): void => {
  graphCache.clear()
  wholeGraphFailures.clear()
  loading.clear()
}

export interface TargetGraphOptions {
  readonly repoId: string
  readonly repo: string
  readonly node: NodeSidecar | null
  readonly plan?: boolean
  readonly labels?: ReadonlyArray<string>
  readonly cli?: string
  readonly sandboxHost?: SandboxHost
  readonly timeoutMs?: number
}

/*
 * What a failed loader actually said. `smithers-build --format json` reports
 * its own failures as a `{ code, message }` envelope on STDOUT with a nonzero
 * exit and nothing on stderr, so reading stderr alone showed the human
 * "The loader exited 1: " and hid the reason (a declared input that is not a
 * regular file, on this very checkout). The envelope's message leads; stderr
 * follows when it has anything; a bare exit says so.
 */
export const loaderFailureText = (stdout: string, stderr: string): string => {
  const parts: Array<string> = []
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (typeof parsed === "object" && parsed !== null && "message" in parsed && typeof parsed.message === "string") {
      const code = "code" in parsed && typeof parsed.code === "string" ? `${parsed.code}: ` : ""
      parts.push(`${code}${parsed.message}`)
    }
  } catch {
    // Not an envelope: stderr (or the raw stdout) is the story.
  }
  const err = stderr.trim()
  if (err !== "") parts.push(err)
  if (parts.length === 0) {
    const out = stdout.trim()
    return out === "" ? "no output" : out
  }
  return parts.join("\n").slice(0, 2000)
}

const runJson = async (options: TargetGraphOptions, args: ReadonlyArray<string>): Promise<unknown> => {
  if (options.node === null) throw new Error("No Node.js >= 22.19 was found for the smithers-build loader.")
  const cli = options.cli ?? resolveBuildCli()
  if (!existsSync(cli)) throw new Error(`The smithers-build loader is missing at ${cli}.`)
  const wrapped = wrapSandbox(
    [options.node.path, cli, ...args],
    loaderPolicy(sandboxPathsFor(options.repo)),
    options.sandboxHost ?? currentSandboxHost()
  )
  const environment = buildCliEnvironment(cli)
  const child = Bun.spawn([...wrapped.argv], {
    cwd: options.repo,
    ...(environment === undefined ? {} : { env: environment }),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore"
  })
  const timer = setTimeout(() => child.kill(), options.timeoutMs ?? QUERY_TIMEOUT_MS)
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout as ReadableStream).text(),
    new Response(child.stderr as ReadableStream).text()
  ])
  clearTimeout(timer)
  /* Name the invocation: `graph //...` and `graph <label>` fail for different reasons on the same checkout. */
  if (code !== 0) throw new Error(`The loader exited ${code} (${args.slice(0, 2).join(" ")}): ${loaderFailureText(stdout, stderr)}`)
  try { return JSON.parse(stdout) } catch { throw new Error(`The loader did not answer JSON: ${stdout.trim().slice(0, 200)}`) }
}

/*
 * The one target's own subgraph — `graph <label>` — for revalidating a run.
 *
 * The run route used to revalidate against the WHOLE `//...` graph, so a
 * single bad declaration anywhere in the checkout (this repository's
 * `vendor/jj` input) answered `target_graph_unavailable` for every target,
 * including the hundreds that load fine. The label-scoped graph is exactly
 * what a run needs (the target and the edges into it) and fails only when
 * that target's own closure is broken. Uncached: a revalidation must read the
 * declarations as they are now.
 */
export const revalidateTarget = async (
  options: TargetGraphOptions,
  label: string
): Promise<{ readonly nodes: Array<GraphNode>; readonly edges: Array<GraphEdge> }> => {
  const body = object(await runJson(options, ["graph", label, "--format", "json"]))
  if (typeof body?.graph !== "string") throw new Error("The graph envelope has no text graph field.")
  const rows = Array.isArray(body.targets)
    ? body.targets.map(object).filter((row): row is JsonObject => row !== undefined).filter((row) => typeof row.label === "string").map((row) => ({ label: row.label as string, target: typeof row.target === "string" ? row.target : "", kinds: strings(row.kinds) ?? [] }))
    : []
  return parseTextGraph(body.graph, rows)
}

const assemble = (
  options: TargetGraphOptions,
  declarations: DeclarationSet,
  targetResult: TargetsResult,
  envelopes: ReadonlyArray<JsonObject>,
  started: number
): CachedGraph => {
  const nodesByLabel = new Map<string, GraphNode>()
  const edges: Array<GraphEdge> = []
  const seenEdges = new Set<string>()
  for (const body of envelopes) {
    const rows = Array.isArray(body.targets)
      ? body.targets.map(object).filter((row): row is JsonObject => row !== undefined).filter((row) => typeof row.label === "string").map((row) => ({ label: row.label as string, target: typeof row.target === "string" ? row.target : "", kinds: strings(row.kinds) ?? [] }))
      : []
    const merged = new Map(rows.map((row) => [row.label, row]))
    for (const target of targetResult.targets) merged.set(target.label, { label: target.label, target: target.target, kinds: target.kinds })
    const parsed = parseTextGraph(body.graph as string, [...merged.values()])
    for (const node of parsed.nodes) {
      const source = declarations.sources.get(node.label)
      nodesByLabel.set(node.label, source === undefined ? node : { ...node, source })
    }
    for (const edge of parsed.edges) {
      const key = `${edge.from} ${edge.to} ${edge.kind}`
      if (seenEdges.has(key)) continue
      seenEdges.add(key)
      edges.push(edge)
    }
  }
  const nodes = [...nodesByLabel.values()]
  const generatedAt = new Date().toISOString()
  /*
   * `digest` is the field a card compares to decide whether its cached
   * graph went stale after a declaration edit; it has to reach the UI, not
   * just this cache, or the documented staleness check can never fire.
   */
  const digest = declarations.digest
  return { digest, response: { repoId: options.repoId, nodes, edges, warnings: targetResult.warnings, generatedAt, digest, durationMs: Date.now() - started } }
}

const loadWholeGraph = (options: TargetGraphOptions, declarations: DeclarationSet): GraphLoad => {
  const digest = declarations.digest
  const shared = loading.get(options.repo)
  if (shared !== undefined && shared.digest === digest) return shared
  const started = Date.now()
  const targets = queryTargets({ repo: options.repo, node: options.node, ...(options.cli === undefined ? {} : { cli: options.cli }), ...(options.sandboxHost === undefined ? {} : { sandboxHost: options.sandboxHost }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) })
  /* A whole-graph refusal without labels leaves nobody to await the targets: an unobserved rejection must not fell the host. */
  void targets.catch(() => {})
  const whole = (async (): Promise<CachedGraph> => {
    let body: JsonObject | undefined
    try {
      const remembered = wholeGraphFailures.get(options.repo)
      if (remembered !== undefined && remembered.digest === digest) throw remembered.error
      body = object(await runJson(options, ["graph", "//...", "--format", "json"]))
      if (typeof body?.graph !== "string") throw new Error("The graph envelope has no text graph field.")
    } catch (error) {
      wholeGraphFailures.set(options.repo, { digest, error: error instanceof Error ? error : new Error(String(error)) })
      throw error
    }
    const base = assemble(options, declarations, await targets, [body], started)
    graphCache.set(options.repo, base)
    return base
  })()
  const load: GraphLoad = { digest, targets, whole }
  const forget = (): void => { if (loading.get(options.repo) === load) loading.delete(options.repo) }
  void whole.then(forget, forget)
  loading.set(options.repo, load)
  return load
}

export const queryTargetGraph = async (options: TargetGraphOptions): Promise<TargetGraphResponse> => {
  const started = Date.now()
  const declarations = await declarationSet(options.repo)
  let base = graphCache.get(options.repo)
  if (base === undefined || base.digest !== declarations.digest) {
    const load = loadWholeGraph(options, declarations)
    try {
      base = await load.whole
    } catch (error) {
      /*
       * The whole graph could not load. When the caller named labels, each
       * label's own subgraph (`graph <label>`, the same scoped read the run
       * route revalidates with) answers instead: a targets-card drawer asking
       * about one target must not die because a declaration elsewhere in the
       * checkout (this repository's `vendor/jj` input) is broken. A scoped
       * answer is never cached as the repository's graph.
       */
      if (!options.labels?.length) throw error
      const envelopes = await Promise.all(options.labels.map(async (label) => {
        const body = object(await runJson(options, ["graph", label, "--format", "json"]))
        if (typeof body?.graph !== "string") throw new Error("The graph envelope has no text graph field.")
        return body
      }))
      base = assemble(options, declarations, await load.targets, envelopes, started)
    }
  }
  let nodes = base.response.nodes.map((node) => ({ ...node, kinds: [...node.kinds], ...(node.plan === undefined ? {} : { plan: { ...node.plan } }) }))
  if (options.plan === true) {
    /*
     * Named labels plan in the workspace's own form (`planArgv`: verb-led on
     * a nested declaration checkout, bare on a workspace one); the whole `//...`
     * keeps the bare form, which is the only one the CLI plans a pattern in.
     */
    const kindsOf = new Map(nodes.map((entry) => [entry.label, entry.kinds]))
    const envelopes = await Promise.all(
      options.labels?.length
        ? options.labels.map((label) => runJson(options, planArgv(options.repo, label, kindsOf.get(label) ?? [])))
        : [runJson(options, ["//...", "--plan", "--format", "json"])]
    )
    nodes = foldPlan(nodes, envelopes)
  }
  return { ...base.response, repoId: options.repoId, nodes, edges: base.response.edges.map((edge) => ({ ...edge })), durationMs: Date.now() - started }
}
