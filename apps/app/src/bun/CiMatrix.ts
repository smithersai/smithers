import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import type { CiMatrixResponse } from "@smthrs/rpc/TargetGraph"
import type { NodeSidecar } from "./Node"
import { buildCliEnvironment, resolveBuildCli, sandboxPathsFor } from "./Targets"
import { loaderPolicy, wrapSandbox } from "./Sandbox"

export type CiWorkflow = CiMatrixResponse["workflows"][number]

const scalar = (value: string): string => value.trim().replace(/^['"]|['"]$/g, "")

export const parseWorkflowYaml = (path: string, yaml: string, source: CiWorkflow["source"] = "on-disk"): CiWorkflow => {
  const lines = yaml.split(/\r?\n/)
  const workflowName = scalar(/^name:\s*(.+)$/.exec(yaml)?.[1] ?? basename(path).replace(/\.ya?ml$/, ""))
  const jobs: Array<CiWorkflow["jobs"][number]> = []
  let inJobs = false
  let current: CiWorkflow["jobs"][number] | undefined
  let inMatrix = false
  let matrixIndent = -1
  let blockAxis: string | undefined
  for (const line of lines) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    if (indent === 0) {
      inJobs = line.trim() === "jobs:"
      inMatrix = false
      continue
    }
    if (!inJobs) continue
    const job = /^  ([A-Za-z0-9_.-]+):\s*$/.exec(line)
    if (job !== null) {
      current = { name: job[1]!, targets: [] }
      jobs.push(current)
      inMatrix = false
      blockAxis = undefined
      continue
    }
    if (current === undefined) continue
    const name = /^\s{4}name:\s*(.+)$/.exec(line)
    if (name !== null) current.name = scalar(name[1]!)
    if (/^\s+matrix:\s*$/.test(line)) { inMatrix = true; matrixIndent = indent; current.matrix = {}; continue }
    if (inMatrix && indent <= matrixIndent && line.trim() !== "matrix:") { inMatrix = false; blockAxis = undefined }
    if (inMatrix && current.matrix !== undefined) {
      const axis = /^\s+([A-Za-z0-9_.-]+):\s*(?:\[(.*)\])?\s*$/.exec(line)
      if (axis !== null && indent > matrixIndent) {
        blockAxis = axis[1]!
        current.matrix[blockAxis] = axis[2] === undefined ? [] : axis[2].split(",").map(scalar).filter(Boolean)
        continue
      }
      const item = /^\s+-\s*(.+)$/.exec(line)
      if (item !== null && blockAxis !== undefined) current.matrix[blockAxis]!.push(scalar(item[1]!))
    }
    for (const match of line.matchAll(/\b(?:smithers-build|smthrs|smithers)\s+(?:(?:run|test|lint|build|ci|docs)\s+)?['"]?(\/\/[^\s'";]+)/g)) {
      if (!current.targets.includes(match[1]!)) current.targets.push(match[1]!)
    }
  }
  return { name: workflowName, path, yaml, source, jobs }
}

const yamlFiles = async (root: string): Promise<Array<string>> => {
  const dir = join(root, ".github", "workflows")
  let names: Array<string>
  try { names = await readdir(dir) } catch { return [] }
  return names.filter((name) => /\.ya?ml$/.test(name)).sort().map((name) => join(dir, name))
}

const readWorkflows = async (root: string, source: CiWorkflow["source"]): Promise<Array<CiWorkflow>> =>
  Promise.all((await yamlFiles(root)).map(async (file) => parseWorkflowYaml(relative(root, file), await readFile(file, "utf8"), source)))

export const renderCiMatrix = async (options: {
  readonly repoId: string
  readonly repo: string
  readonly labels: ReadonlyArray<string>
  readonly declarationFiles: ReadonlyArray<string>
  readonly node: NodeSidecar | null
  readonly cli?: string
}): Promise<CiMatrixResponse> => {
  const started = Date.now()
  const warnings: Array<string> = []
  if (options.node === null || options.labels.length === 0) {
    return { repoId: options.repoId, workflows: await readWorkflows(options.repo, "on-disk"), warnings, durationMs: Date.now() - started }
  }
  const scratch = await mkdtemp(join(tmpdir(), "smithers-ci-preview-"))
  try {
    const files = new Set([...options.declarationFiles, "WORKSPACE.ts", ".smithers/WORKSPACE.ts", "smithers.d.ts", "package.json", "pnpm-workspace.yaml"])
    const queue = [...files]
    for (let index = 0; index < queue.length; index++) {
      const file = queue[index]!
      const source = join(options.repo, file)
      if (!existsSync(source)) continue
      const destination = join(scratch, file)
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue
      const contents = await readFile(source, "utf8")
      for (const match of contents.matchAll(/(?:from\s+|import\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
        const requested = resolve(dirname(source), match[1]!)
        const candidate = existsSync(requested) ? requested : /\.js$/.test(requested) && existsSync(requested.replace(/\.js$/, ".ts")) ? requested.replace(/\.js$/, ".ts") : undefined
        if (candidate === undefined || !candidate.startsWith(options.repo + "/")) continue
        const imported = relative(options.repo, candidate)
        if (!files.has(imported)) { files.add(imported); queue.push(imported) }
      }
    }
    const nodeModules = join(options.repo, "node_modules")
    if (existsSync(nodeModules)) await symlink(nodeModules, join(scratch, "node_modules"), "dir")
    const gitEnv = { ...(Bun.env as Record<string, string | undefined>), GIT_AUTHOR_NAME: "Smithers Preview", GIT_AUTHOR_EMAIL: "preview@localhost", GIT_COMMITTER_NAME: "Smithers Preview", GIT_COMMITTER_EMAIL: "preview@localhost" }
    for (const args of [["init"], ["add", "."], ["commit", "-m", "CI preview baseline"]]) {
      const child = Bun.spawn(["git", ...args], { cwd: scratch, env: gitEnv, stdout: "ignore", stderr: "ignore", stdin: "ignore" })
      await child.exited
    }
    const cli = options.cli ?? resolveBuildCli()
    const environment = buildCliEnvironment(cli)
    for (const label of options.labels) {
      // A scratch cwd is not confinement: imports can still write absolute
      // paths or use the network. Preview has the same read authority as a query.
      const wrapped = wrapSandbox([options.node.path, cli, label, "--write"], loaderPolicy(sandboxPathsFor(scratch)))
      const child = Bun.spawn([...wrapped.argv], {
        cwd: scratch,
        ...(environment === undefined ? {} : { env: environment }),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore"
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      if (code !== 0) warnings.push(`${label} scratch render exited ${code}: ${(stderr || stdout).trim().slice(0, 1000)}`)
    }
    const rendered = await readWorkflows(scratch, "scratch-render")
    if (rendered.length > 0) return { repoId: options.repoId, workflows: rendered, warnings, durationMs: Date.now() - started }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return { repoId: options.repoId, workflows: await readWorkflows(options.repo, "on-disk"), warnings, durationMs: Date.now() - started }
}
