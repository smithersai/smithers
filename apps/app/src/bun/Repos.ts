/*
 * Open repositories and Smithers workspace detection (LOCAL-APP.md,
 * "Repository detection"). A repository is a directory on disk; its id is a
 * short hash of the absolute path so the same folder always maps to the same
 * record. Detection reads only the files the rule names; git facts come from
 * `git` run in the repository.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative } from "node:path"
import type { Repo, RepoWorkspace } from "@smthrs/rpc/LocalApp"
import { currentSandboxHost, probePolicy, wrapSandbox } from "./Sandbox"
import { sanitizeRemoteUrl } from "./sanitizeRemoteUrl"

export type SmithersDetection = Repo["smithers"]

const WORKSPACE_FILES = ["WORKSPACE.ts", ".smithers/WORKSPACE.ts"] as const
const ROOT_DECLARATION_FILES = ["WORKSPACE.ts", ".smithers/WORKSPACE.ts", "legacy declaration"] as const
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".flows", "dist", "build"])
/** The workspace discovery walk skips the manifest dir too, so `.smithers` itself is never reported as a workspace. */
const WORKSPACE_SKIPPED_DIRS = new Set([...SKIPPED_DIRS, "target", ".smithers"])
/** Child workspaces are discovered at depth 1 and 2 below the root. */
const MAX_WORKSPACE_DEPTH = 2
/** Deep enough for any package layout; keeps a runaway tree from stalling the open. */
const MAX_WALK_DEPTH = 12

/** `from "@smthrs/...` or `from "smthrs...`, single or double quotes. */
export const IMPORTS_SMTHRS = /from\s+["'](?:@smthrs\/|smthrs)/

export const repoId = (absolutePath: string): string =>
  createHash("sha256").update(absolutePath).digest("hex").slice(0, 12)

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const importsSmthrs = (path: string): boolean => {
  try {
    return IMPORTS_SMTHRS.test(readFileSync(path, "utf8"))
  } catch {
    return false
  }
}

/*
 * Every PACKAGE.ts — and, below the root, every legacy declaration — skipping the
 * vendored and generated trees. A legacy declaration-rooted checkout declares its
 * targets in `packages/x/legacy declaration`; leaving those out meant `target.source.open`
 * refused every package target's declaration ("must be one of the
 * repository's declaration files") while the targets card listed them all.
 * The root's own legacy declaration is a root declaration file, listed by its caller.
 */
const DECLARATION_BASENAMES = new Set(["PACKAGE.ts", "legacy declaration"])
const packageFiles = (root: string): Array<string> => {
  const found: Array<string> = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return
    let entries: Array<import("node:fs").Dirent>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path, depth + 1)
      } else if (DECLARATION_BASENAMES.has(entry.name) && entry.isFile() && !(depth === 0 && entry.name === "legacy declaration")) {
        found.push(path)
      }
    }
  }
  walk(root, 0)
  return found.sort()
}

/** The directory's own workspace file, or null. */
const workspaceFileOf = (dir: string): string | null => WORKSPACE_FILES.find((file) => isFile(join(dir, file))) ?? null

/*
 * The root-level `legacy declaration` authoring surface. `smithers-build query //...`
 * loads a checkout rooted on legacy declaration (this repository is one), so the UI must
 * count it as the root workspace too: refusing it left the Smithers checkout
 * itself opening with "no WORKSPACE.ts" and no targets card. Only the ROOT
 * qualifies — a package's legacy declaration below it is a target file the root loads,
 * never a workspace of its own — and only when it imports the smthrs surface,
 * so an unrelated legacy declaration (Bazel's, say) stays undetected.
 */
const rootBuildFileOf = (root: string): string | null => {
  const file = join(root, "legacy declaration")
  return isFile(file) && importsSmthrs(file) ? "legacy declaration" : null
}

const childDirs = (dir: string): Array<string> => {
  let entries: Array<import("node:fs").Dirent>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !WORKSPACE_SKIPPED_DIRS.has(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort()
}

/**
 * The root and child workspaces (LOCAL-APP.md "Repository detection"):
 * every directory up to two levels deep that carries WORKSPACE.ts or
 * .smithers/WORKSPACE.ts. The root is "."; a child's title is its last
 * segment.
 */
export const discoverWorkspaces = (root: string): Array<RepoWorkspace> => {
  const found: Array<RepoWorkspace> = []
  if (workspaceFileOf(root) !== null || rootBuildFileOf(root) !== null) found.push({ path: ".", title: basename(root) })
  let frontier = childDirs(root)
  for (let depth = 1; depth <= MAX_WORKSPACE_DEPTH && frontier.length > 0; depth += 1) {
    const next: Array<string> = []
    for (const dir of frontier) {
      if (workspaceFileOf(dir) !== null) found.push({ path: relative(root, dir), title: basename(dir) })
      if (depth < MAX_WORKSPACE_DEPTH) next.push(...childDirs(dir))
    }
    frontier = next
  }
  return found
}

/**
 * The detection verdict for a root directory. Detected iff the workspace
 * list is nonempty; `reason` names the negative verdict.
 */
export const detectSmithers = (root: string): SmithersDetection => {
  const workspaces = discoverWorkspaces(root)
  if (workspaces.length === 0) {
    return {
      detected: false,
      workspaceFile: null,
      declarationFiles: [],
      reason: "no WORKSPACE.ts or smthrs legacy declaration",
      workspaces
    }
  }
  const candidates = [
    ...ROOT_DECLARATION_FILES.map((file) => join(root, file)).filter(isFile),
    ...packageFiles(root)
  ]
  const declarationFiles = [...new Set(candidates.filter(importsSmthrs).map((file) => relative(root, file)))]
  return {
    detected: true,
    workspaceFile: workspaceFileOf(root),
    declarationFiles,
    reason: `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} detected`,
    workspaces
  }
}

/** Seatbelt matches resolved paths, so the scratch dir the probe may write is canonicalised. */
const probeTmpdir = (): string => {
  try {
    return realpathSync(tmpdir())
  } catch {
    return tmpdir()
  }
}

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<string | null> => {
  try {
    // Read-only probe: no network, writes confined to scratch (LOCAL-APP.md, "Sandbox").
    const wrapped = wrapSandbox(["git", "-C", cwd, ...args], probePolicy({ tmpdir: probeTmpdir() }), currentSandboxHost())
    const child = Bun.spawn([...wrapped.argv], {
      env: { ...(Bun.env as Record<string, string | undefined>), GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore"
    })
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
    const value = stdout.trim()
    return code === 0 && value !== "" ? value : null
  } catch {
    return null
  }
}

/** `owner/name` from a GitHub-style remote (https or scp syntax), else null. */
export const ownerNameOf = (remote: string | null): string | null => {
  if (remote === null) return null
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim())
  if (match === null) return null
  return `${match[1]}/${match[2]}`
}

/*
 * The jj probe (lane piper, ADR 0001): a jj checkout states its own position
 * — the working copy's change/commit ids and how far it is ahead of trunk —
 * the facts the sidebar's copy rows and the composer's origin chip render.
 * Read-only like the git probe, through the same sandbox; any failure is the
 * honest absence of the field, never a fake zero.
 */
/**
 * A probe spawn may not hold the open request hostage: `jj log -r @` snapshots
 * the working copy and takes its lock, and on a large checkout that other
 * sessions are committing in that is seconds, or a wait on the lock. So every
 * probe runs `--ignore-working-copy` (no snapshot, no lock; the facts are the
 * repo's, which is what the sidebar states) and is killed after
 * JJ_PROBE_TIMEOUT_MS, answering the honest absence of the field.
 */
export const JJ_PROBE_TIMEOUT_MS = 3000

const jj = async (cwd: string, args: ReadonlyArray<string>): Promise<string | null> => {
  try {
    const wrapped = wrapSandbox(
      ["jj", "--ignore-working-copy", "-R", cwd, ...args],
      probePolicy({ tmpdir: probeTmpdir() }),
      currentSandboxHost()
    )
    const child = Bun.spawn([...wrapped.argv], {
      env: { ...(Bun.env as Record<string, string | undefined>) },
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore"
    })
    /*
     * The bound is a race, not a kill alone: the sandbox wrapper's grandchild
     * can keep the stdout pipe open after the wrapper dies, so awaiting the
     * pipe would still hang. On timeout the answer is null now and the
     * process tree is killed behind it.
     */
    const work = Promise.all([child.exited, new Response(child.stdout).text()]).then(([code, stdout]) => {
      const value = stdout.trim()
      return code === 0 && value !== "" ? value : null
    })
    let deadline: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<null>((resolve) => {
      deadline = setTimeout(() => {
        child.kill("SIGKILL")
        resolve(null)
      }, JJ_PROBE_TIMEOUT_MS)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      work.catch(() => null)
    }
  } catch {
    return null
  }
}

const probeJj = async (root: string): Promise<Repo["jj"]> => {
  try {
    if (!statSync(join(root, ".jj")).isDirectory()) return undefined
  } catch {
    return undefined
  }
  const [ids, aheadLines, bookmarks] = await Promise.all([
    jj(root, ["log", "--no-graph", "-r", "@", "-T", 'change_id ++ " " ++ commit_id']),
    jj(root, ["log", "--no-graph", "-r", "::@ ~ ::trunk()", "-T", 'commit_id ++ "\n"']),
    jj(root, ["log", "--no-graph", "-r", "trunk()", "-T", "local_bookmarks"])
  ])
  if (ids === null) return undefined
  const [changeId = null, commitId = null] = ids.split(/\s+/, 2)
  const ahead = aheadLines === null ? null : aheadLines.split("\n").filter((line) => line.trim() !== "").length
  const bookmark = bookmarks === null ? null : bookmarks.split(/[\s,]+/).filter((name) => name !== "")[0] ?? null
  return { changeId: changeId ?? null, commitId: commitId ?? null, ahead, bookmark: bookmark ?? null }
}

export type InspectRepoResult =
  | { readonly status: "ok"; readonly repo: Repo }
  | { readonly status: "error"; readonly code: "not_a_directory" | "invalid_path"; readonly message: string }

/** The Repo record for a path: realpath, git facts, and the detection verdict. */
export const inspectRepo = async (path: string): Promise<InspectRepoResult> => {
  let root: string
  try {
    root = await realpath(path)
    if (!(await stat(root)).isDirectory()) {
      return { status: "error", code: "not_a_directory", message: `${path} is not a directory.` }
    }
  } catch {
    return { status: "error", code: "invalid_path", message: `${path} does not exist or cannot be read.` }
  }
  const inside = (await git(root, ["rev-parse", "--is-inside-work-tree"])) === "true"
  const [branch, rawRemote] = inside
    ? await Promise.all([git(root, ["branch", "--show-current"]), git(root, ["remote", "get-url", "origin"])])
    : [null, null]
  // The record reaches the renderer through /api/repo/open and /api/repos.
  const remote = sanitizeRemoteUrl(rawRemote)
  const smithers = detectSmithers(root)
  const jj = await probeJj(root)
  return {
    status: "ok",
    repo: {
      id: repoId(root),
      path: root,
      name: ownerNameOf(remote) ?? basename(root),
      git: inside ? { branch, remote } : null,
      ...(jj === undefined ? {} : { jj }),
      warnings: [],
      smithers
    }
  }
}

export interface RepoStore {
  readonly open: (path: string) => Promise<InspectRepoResult>
  readonly close: (repoId: string) => boolean
  readonly get: (repoId: string) => Repo | undefined
  readonly list: () => ReadonlyArray<Repo>
}

/** The open repositories, in open order; reopening a path refreshes its record in place. */
export const createRepoStore = (): RepoStore => {
  const repos = new Map<string, Repo>()
  return {
    open: async (path) => {
      const result = await inspectRepo(path)
      if (result.status === "ok") repos.set(result.repo.id, result.repo)
      return result
    },
    close: (id) => repos.delete(id),
    get: (id) => repos.get(id),
    list: () => [...repos.values()]
  }
}
