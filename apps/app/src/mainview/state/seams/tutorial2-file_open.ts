import { completeGuide } from "../../onboarding/completion"
import { GUIDE_STAGES } from "../../onboarding/lessons"
import type { AppStore } from "../AppStore"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"
import { encodeRepoPath, parseEntry, requestLocalFiles, resolveFileTarget, unsafePath } from "./FilesSeam"

export const fileTargetKey = (store: AppStore, repo?: string): string | undefined => {
  const target = resolveFileTarget(store, "", repo)
  return "error" in target ? undefined : target.kind === "local" ? target.repo.id : target.repo
}

/** Capture before I/O; a reply from an earlier lesson, account, or selection cannot check this lesson. */
export const captureFileLesson = (store: AppStore, repo?: string) => {
  const session = store.session()
  return {
    guide: session.guide,
    selection: session.activeRepoKey,
    identity: JSON.stringify(store.collections.identitySessions.get("identity")),
    repo: fileTargetKey(store, repo),
    selectedRepo: fileTargetKey(store),
  }
}

export const finishFileLesson = async (ctx: SeamContext, scope: ReturnType<typeof captureFileLesson>): Promise<void> => {
  const current = captureFileLesson(ctx.store)
  const guide = current.guide
  const stage = guide === undefined ? undefined : GUIDE_STAGES[guide.step]
  if (!guide || !scope.guide || scope.repo === undefined || scope.repo !== scope.selectedRepo ||
    current.repo !== scope.repo || current.selection !== scope.selection || current.identity !== scope.identity ||
    guide.playthrough !== scope.guide.playthrough || guide.step !== scope.guide.step ||
    stage?.kind !== "do" || stage.completion !== "file.opened" || guide.completed?.includes("file.opened")) return
  await ctx.dispatch({ type: "guide.changed", actor: ctx.actor(), guide: completeGuide(guide, "file.opened") }).isPersisted.promise
}

/** Bounded breadth-first inventory, using the same local/cloud contents routes as files.read. No cards or completion. */
export const fileOptions = async (
  ctx: Pick<SeamContext, "store" | "http" | "baseUrl">,
  repo?: string,
): Promise<{ options: Array<{ value: string; label: string }>; error?: string }> => {
  const target = resolveFileTarget(ctx.store, "", repo)
  if ("error" in target) return { options: [], error: target.error }
  const options: Array<{ value: string; label: string }> = []
  const queue = [""]
  const seen = new Set<string>()
  for (let index = 0; index < queue.length && index < 32 && options.length < 200; index++) {
    const path = queue[index]!
    if (seen.has(path)) continue
    seen.add(path)
    let entries: ReadonlyArray<{ name: string; kind: "file" | "dir" }>
    if (target.kind === "local") {
      const answer = await requestLocalFiles(ctx, target.repo, path, path || "/", "list")
      if ("error" in answer) return { options, error: answer.error }
      if (answer.body.kind !== "dir") return { options, error: "The file chooser expected a directory." }
      entries = answer.body.entries
    } else {
      const [owner, name] = target.repo.split("/")
      try {
        const response = await ctx.http(`${ctx.baseUrl}/api/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/contents${path ? `/${encodeRepoPath(path)}` : ""}`)
        if (!response.ok) return { options, error: await readErrorMessage(response, `Could not list files in ${target.repo} (${response.status}).`) }
        const body: unknown = await response.json()
        if (!Array.isArray(body)) return { options, error: "The file chooser expected a directory." }
        entries = body.flatMap(row => { const entry = parseEntry(row); return entry ? [entry] : [] })
      } catch (error) { return { options, error: error instanceof Error ? error.message : String(error) } }
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (unsafePath(entry.name) || entry.name.includes("/")) continue
      const child = path ? `${path}/${entry.name}` : entry.name
      if (entry.kind === "dir") { if (queue.length < 32) queue.push(child) }
      else if (options.length < 200) options.push({ value: child, label: child })
    }
  }
  return { options }
}
