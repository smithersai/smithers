import type { FlowName, Minimum } from "../../flows/registry"
import { rankOf, type Viewer } from "./catalog"

// Global Command Palette & Go-to-File model (docs/features/repo.md, docs/features/factory.md):
// Pure, framework-free builder for `⌘P` / `Ctrl+P` destinations, repository-scoped plugin commands (`/{repo}/...`),
// and repository file jumps from cached tree paths.

const REPO_TOKEN = "/{repo}/"
const RANKS = { anyone: 0, guest: 1, member: 2, maintainer: 3, admin: 4 } as const satisfies Record<Minimum, number>

/** A repository target (either the currently open repository or a fallback synced repository). */
export interface RepoTarget {
  readonly owner: string
  readonly name: string
  readonly revision?: string | null
}

/**
 * Resolves a plugin command path starting with `/{repo}/` against the active repository (or `fallback` when outside a
 * repository page). Non-templated paths pass through unchanged; returns `undefined` when no repository is known.
 */
export const resolveRepoTarget = (
  to: string,
  active: RepoTarget | undefined,
  fallback: RepoTarget | undefined,
): string | undefined => {
  if (!to.startsWith(REPO_TOKEN)) return to
  const target = active ?? fallback
  if (target === undefined || target.owner === "" || target.name === "") return undefined
  return `/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/${to.slice(REPO_TOKEN.length)}`
}

/** A plugin command declaration as read by the palette. */
export interface PalettePluginCommand {
  readonly id: string
  readonly flow: string
  readonly title: string
  readonly minimum: Minimum
  readonly palette?: boolean
  readonly args?: Readonly<Record<string, unknown>>
}

/** One selectable item in the global command palette. */
export interface PaletteEntry {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly badge: string
  readonly flow: FlowName
  readonly args: Readonly<Record<string, unknown>>
}

export interface PaletteInput {
  readonly viewer: Viewer
  readonly commands: ReadonlyArray<PalettePluginCommand>
  readonly activeRepo?: RepoTarget | undefined
  readonly fallbackRepo?: RepoTarget | undefined
  readonly paths?: ReadonlyArray<string> | undefined
}

const CORE_DESTINATIONS: ReadonlyArray<{
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly to: string
  readonly minimum: Minimum
}> = [
  { id: "go:chat", label: "Chat", detail: "/app", to: "/app", minimum: "anyone" },
  { id: "go:flows", label: "Flows", detail: "/app/flows", to: "/app/flows", minimum: "member" },
  { id: "go:runs", label: "Runs", detail: "/app/runs", to: "/app/runs", minimum: "member" },
  { id: "go:settings", label: "Settings", detail: "/app/settings", to: "/app/settings", minimum: "guest" },
]

const REPO_SECTIONS: ReadonlyArray<{ readonly slug: string; readonly label: string; readonly suffix: string }> = [
  { slug: "code", label: "Repository home", suffix: "" },
  { slug: "issues", label: "Issues", suffix: "/issues" },
  { slug: "pulls", label: "Pull requests", suffix: "/pulls" },
  { slug: "runs", label: "Repository runs", suffix: "/runs" },
  { slug: "stack", label: "TODO stack", suffix: "/stack" },
  { slug: "docs", label: "Repository docs", suffix: "/docs" },
  { slug: "settings", label: "Repository settings", suffix: "/settings" },
]

/** Scores a candidate string against a normalized lowercase query: lower is better, `undefined` means no match. */
export const matchScore = (needle: string, haystack: string): number | undefined => {
  if (needle === "") return 0
  const lower = haystack.toLowerCase()
  if (lower === needle) return 0
  const base = lower.split("/").at(-1)!
  if (base === needle) return 1
  if (base.startsWith(needle)) return 2
  const at = lower.indexOf(needle)
  if (at >= 0) return 3 + at
  return undefined
}

/** Encodes a repository file path into its blob URL at `revision` (defaults to `HEAD`). */
export const blobPathOf = (repo: RepoTarget, filePath: string): string => {
  const clean = filePath.replace(/^\/+/, "")
  const encoded = clean.split("/").map(encodeURIComponent).join("/")
  const ref = encodeURIComponent(repo.revision ?? "HEAD")
  return `/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/blob/${ref}/${encoded}`
}

/** Builds the filtered, ranked list of commands and Go-to-File items for `query`. */
export const paletteItemsOf = (query: string, input: PaletteInput): ReadonlyArray<PaletteEntry> => {
  const needle = query.trim().toLowerCase()
  const rank = rankOf(input.viewer)
  const scored: Array<{ readonly score: number; readonly entry: PaletteEntry }> = []

  const push = (entry: PaletteEntry, searchText: string, groupBias: number) => {
    const score = matchScore(needle, searchText)
    if (score !== undefined) scored.push({ score: score * 10 + groupBias, entry })
  }

  for (const dest of CORE_DESTINATIONS) {
    if (rank < RANKS[dest.minimum]) continue
    push(
      { id: dest.id, label: dest.label, detail: dest.detail, badge: "Go", flow: "app/navigate", args: { to: dest.to } },
      `${dest.label} ${dest.detail}`,
      0,
    )
  }

  if (input.activeRepo !== undefined && input.activeRepo.owner !== "" && input.activeRepo.name !== "") {
    const base = `/${encodeURIComponent(input.activeRepo.owner)}/${encodeURIComponent(input.activeRepo.name)}`
    for (const section of REPO_SECTIONS) {
      const to = `${base}${section.suffix}`
      push(
        { id: `repo:${section.slug}`, label: section.label, detail: to, badge: "Repo", flow: "app/navigate", args: { to } },
        `${section.label} ${to}`,
        1,
      )
    }
  }

  for (const command of input.commands) {
    if (command.palette !== true || rank < RANKS[command.minimum]) continue
    const rawTo = typeof command.args?.to === "string" ? command.args.to : undefined
    const resolvedTo = rawTo === undefined ? undefined : resolveRepoTarget(rawTo, input.activeRepo, input.fallbackRepo)
    if (rawTo !== undefined && resolvedTo === undefined) continue
    const args = resolvedTo === undefined ? (command.args ?? {}) : { ...command.args, to: resolvedTo }
    push(
      {
        id: `cmd:${command.id}`,
        label: command.title,
        detail: resolvedTo ?? command.flow,
        badge: "Command",
        flow: command.flow as FlowName,
        args,
      },
      `${command.title} ${resolvedTo ?? command.id}`,
      2,
    )
  }

  if (input.activeRepo !== undefined && input.activeRepo.owner !== "" && input.activeRepo.name !== "") {
    const fileMatches: Array<{ readonly score: number; readonly path: string }> = []
    for (const filePath of input.paths ?? []) {
      const score = matchScore(needle, filePath)
      if (score !== undefined) fileMatches.push({ score, path: filePath })
    }
    fileMatches.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
    const shownFiles = fileMatches.slice(0, 25)
    for (const match of shownFiles) {
      const to = blobPathOf(input.activeRepo, match.path)
      scored.push({
        score: match.score * 10 + 3,
        entry: { id: `file:${match.path}`, label: match.path.split("/").at(-1)!, detail: match.path, badge: "File", flow: "app/navigate", args: { to } },
      })
    }
    // Direct path jump when the user typed a relative file path not listed in the current cached tree
    const direct = query.trim().replace(/^\/+/, "")
    if (direct !== "" && (direct.includes("/") || direct.includes(".")) && !shownFiles.some((f) => f.path === direct)) {
      const to = blobPathOf(input.activeRepo, direct)
      scored.push({
        score: 999,
        entry: { id: `file-direct:${direct}`, label: `Open ${direct}`, detail: to, badge: "File", flow: "app/navigate", args: { to } },
      })
    }
  }

  scored.sort((a, b) => a.score - b.score || a.entry.label.localeCompare(b.entry.label))
  return scored.slice(0, 40).map((item) => item.entry)
}
