import { LiveTutorialRunSchema } from "@smthrs/rpc/LiveTutorial"
import type { SeamContext } from "./SeamContext"
import { lessonCompletion } from "../../onboarding/completion"
import { PRACTICE_REPO, PRACTICE_CARD, practiceImplementation, isPracticeRepo } from "../practice/PracticeRepository"
import { unsafePath, encodeRepoPath, CARD_CONTENT_CAP } from "./FilesSeam"
import { readErrorMessage, readResult } from "./SeamContext"

export const PRACTICE_DIFF_CARD = "practice-implementation-diff"
export const createDiffFilesSeam = (ctx: SeamContext) => {
  const complete = async (signal: string, playthrough: number | undefined) => {
    const guide = ctx.store.session().guide
    const next = guide?.playthrough === playthrough ? lessonCompletion(guide, signal) : undefined
    if (next) await ctx.dispatch({ type: "guide.changed", actor: ctx.actor(), guide: next }).isPersisted.promise
  }
  return {
    showPracticeDiff: async () => {
      const guide = ctx.store.session().guide
      if (!guide?.completed?.includes("commits.made")) return "Implement the fix before viewing its diff."
      const implementation = practiceImplementation()
      const existing = ctx.store.collections.cards.get(PRACTICE_DIFF_CARD)
      await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
        id: PRACTICE_DIFF_CARD, kind: "diff", title: "Implementation diff · hello-server", status: "active",
        ordinal: existing?.ordinal ?? ctx.nextOrdinal(), createdAt: existing?.createdAt ?? Date.now(),
        payload: { repo: PRACTICE_REPO, changeId: implementation.changeId, from: implementation.base, to: implementation.commitId,
          pin: { changeId: implementation.changeId, seq: null, commitId: implementation.commitId }, files: implementation.files }
      } }).isPersisted.promise
      await complete("diff.opened", guide.playthrough)
      return readResult(implementation.files.map(file => `${file.path}\n${file.patch}`).join("\n\n"))
    },
    openDiffFile: async (cardId: string, path: string) => {
      const card = ctx.store.collections.cards.get(cardId)
      if (card?.kind !== "diff") return "Open the diff before selecting a file."
      const file = card.payload.files.find(file => file.path === path)
      if (!file || unsafePath(path)) return "Select a file in this diff."
      if (file.changeType === "deleted") return "This file was deleted at the selected revision."
      if (file.isBinary) return "This file is binary."
      const commitId = card.payload.pin.commitId
      if (!commitId) return "This diff has no pinned commit to read. Refresh the diff first."
      const playthrough = ctx.store.session().guide?.playthrough
      let content: string
      if (isPracticeRepo(card.payload.repo)) {
        const implementationCard = ctx.store.collections.cards.get(PRACTICE_CARD.run)
        const live = LiveTutorialRunSchema.safeParse(implementationCard?.kind === "run-trace" ? implementationCard.payload.input?.liveTutorialSnapshot : undefined)
        if (live.success) {
          if (live.data.commits?.at(-1)?.commitId !== commitId || live.data.files?.[path] === undefined) return "The live file is not available at this revision."
          content = live.data.files[path]!
        } else {
          const implementation = practiceImplementation()
          if (commitId !== implementation.commitId || implementation.contents[path] === undefined) return "The recorded file is not available at this revision."
          content = implementation.contents[path]!
        }
      } else {
        const [owner, repo] = card.payload.repo.split("/")
        try {
          const response = await ctx.http(`${ctx.baseUrl}/api/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repo!)}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(commitId)}`)
          if (!response.ok) return await readErrorMessage(response, `Could not read ${path} at ${commitId} (${response.status}).`)
          const body = await response.json() as { content?: unknown; encoding?: unknown }
          if (typeof body.content !== "string") return "The pinned file response contained no readable content."
          content = body.encoding === "base64" ? new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(body.content.replace(/\s+/g, "")), char => char.charCodeAt(0))) : body.content
          if (content.includes("\u0000")) return "This file is binary."
        } catch (error) { return `Could not read the pinned file: ${error instanceof Error ? error.message : String(error)}` }
      }
      if (ctx.store.collections.cards.get(cardId) !== card) return "The frame changed while the file was loading. Select the file again."
      await ctx.dispatch({ type: "card.navigated", actor: ctx.actor(), card: {
        ...card, kind: "file", title: `${path} · ${card.payload.repo}`, payload: { repo: card.payload.repo, path,
          content: content.slice(0, CARD_CONTENT_CAP), truncated: content.length > CARD_CONTENT_CAP,
          readAt: { changeId: card.payload.pin.changeId, commitId } }
      } }).isPersisted.promise
      if (isPracticeRepo(card.payload.repo)) await complete("diff.file.opened", playthrough)
      return readResult(content.slice(0, CARD_CONTENT_CAP))
    }
  }
}
