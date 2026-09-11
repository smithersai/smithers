import { realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { TARGET_PATTERN } from "@smthrs/rpc/LocalApp"
import { TARGET_GRAPH_ROUTES } from "@smthrs/rpc/TargetGraph"
import type { NodeSidecar } from "../Node"
import type { RepoStore } from "../Repos"
import { json, jsonError, readJson } from "../routes"
import type { LocalServer } from "../server"
import { declarationFilesOf, queryTargetGraph } from "../TargetGraph"
import type { TargetRunHistory } from "../TargetRunHistory"
import { changedFiles, computeAffected, declarationInputs } from "../Affected"
import { renderCiMatrix } from "../CiMatrix"

export interface TargetGraphRoutesOptions {
  readonly repos: RepoStore
  readonly node: Promise<NodeSidecar | null>
  readonly cli?: string
  readonly history: TargetRunHistory
}

const field = (body: unknown, name: string): unknown =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined

const stringField = (body: unknown, name: string): string | undefined => {
  const value = field(body, name)
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

export const registerTargetGraphRoutes = (
  server: Pick<LocalServer, "router">,
  options: TargetGraphRoutesOptions
): void => {
  server.router.add("POST", TARGET_GRAPH_ROUTES.graph, async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId, plan?, labels? }.")
    const repo = options.repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    const rawLabels = field(parsed.body, "labels")
    /* Each label becomes one CLI argv element, so only a target pattern passes: `--cache-dir` would be read as a flag. */
    if (rawLabels !== undefined && (!Array.isArray(rawLabels) || rawLabels.some((label) => typeof label !== "string" || !TARGET_PATTERN.test(label)))) {
      return jsonError(400, "invalid_request", "labels must be an array of target patterns such as //pkg:name or //pkg/....")
    }
    const result = await queryTargetGraph({
      repoId,
      repo: repo.path,
      node: await options.node,
      plan: field(parsed.body, "plan") === true,
      ...(rawLabels === undefined ? {} : { labels: rawLabels as Array<string> }),
      ...(options.cli === undefined ? {} : { cli: options.cli })
    })
    return json(result)
  })

  server.router.add("POST", TARGET_GRAPH_ROUTES.runs, async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId }.")
    const repo = options.repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    return json({ runs: await options.history.list(repoId, repo.path) })
  })

  server.router.add("POST", TARGET_GRAPH_ROUTES.replay, async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const runId = stringField(parsed.body, "runId")
    if (runId === undefined) return jsonError(400, "invalid_request", "Body must be { runId }.")
    const replay = await options.history.replay(runId, options.repos.list().map((repo) => ({ id: repo.id, path: repo.path })))
    return replay === undefined ? jsonError(404, "run_not_found", `No target run with id ${runId}.`) : json(replay)
  })

  server.router.add("POST", TARGET_GRAPH_ROUTES.affected, async ({ request }) => {
    const started = Date.now()
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId }.")
    const repo = options.repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    /*
     * The declarations are rescanned here, not read off the Repo record: that
     * list is what inspectRepo saw at `/api/repo/open`, so a PACKAGE.ts
     * written afterwards matched nothing while the graph beside it already
     * described the live tree.
     */
    const [graph, changes, declarationFiles] = await Promise.all([
      queryTargetGraph({ repoId, repo: repo.path, node: await options.node, plan: true, ...(options.cli === undefined ? {} : { cli: options.cli }) }),
      changedFiles(repo.path),
      declarationFilesOf(repo.path)
    ])
    const declarations = await declarationInputs(repo.path, declarationFiles)
    return json(computeAffected({
      repoId, base: changes.base, changedFiles: changes.files, nodes: graph.nodes, edges: graph.edges,
      declarations, durationMs: Date.now() - started
    }))
  })

  server.router.add("POST", TARGET_GRAPH_ROUTES.ci, async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    if (repoId === undefined) return jsonError(400, "invalid_request", "Body must be { repoId }.")
    const repo = options.repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    const node = await options.node
    const [graph, declarationFiles] = await Promise.all([
      queryTargetGraph({ repoId, repo: repo.path, node, ...(options.cli === undefined ? {} : { cli: options.cli }) }),
      declarationFilesOf(repo.path)
    ])
    return json(await renderCiMatrix({
      repoId, repo: repo.path, node,
      labels: graph.nodes.filter((entry) => entry.rule === "Github.CiGen").map((entry) => entry.label),
      declarationFiles,
      ...(options.cli === undefined ? {} : { cli: options.cli })
    }))
  })

  server.router.add("POST", TARGET_GRAPH_ROUTES.openSource, async ({ request }) => {
    const parsed = await readJson(request)
    if ("error" in parsed) return parsed.error
    const repoId = stringField(parsed.body, "repoId")
    const file = stringField(parsed.body, "file")
    const rawLine = field(parsed.body, "line")
    if (repoId === undefined || file === undefined || (rawLine !== undefined && (!Number.isInteger(rawLine) || (rawLine as number) < 1))) {
      return jsonError(400, "invalid_request", "Body must be { repoId, file, line? } with a positive line number.")
    }
    const repo = options.repos.get(repoId)
    if (repo === undefined) return jsonError(404, "repo_not_found", `No open repository with id ${repoId}.`)
    const candidate = resolve(repo.path, file)
    const rel = relative(repo.path, candidate)
    if (rel.startsWith("..") || isAbsolute(rel)) return jsonError(400, "invalid_source", "The declaration must be inside the open repository.")
    const allowed = new Set(repo.smithers.declarationFiles.map((entry) => resolve(repo.path, entry)))
    let canonical: string
    try { canonical = await realpath(candidate) } catch { return jsonError(404, "source_not_found", `No declaration exists at ${file}.`) }
    if (!allowed.has(candidate) || relative(repo.path, canonical).startsWith("..")) {
      return jsonError(400, "invalid_source", "The source must be one of the repository's declaration files.")
    }
    return json({ path: canonical, ...(rawLine === undefined ? {} : { line: rawLine as number }) })
  })
}
