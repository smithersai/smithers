import { actorSharedState } from "../ActorBindings"
/*
 * The code-intel seam (docs/code-intel/PLAN.md §4): `code.hover`,
 * `code.definition` and `code.diagnostics` against a language server. Each is
 * ONE act with three doors and answers two things: a `{ value }` the MODEL
 * reads (the FilesSeam rule — a read the model cannot read is a confabulation
 * waiting to happen), and a patch to the human's FILE card through
 * `card.updated` (no new card kind): `hover`, `diagnostics`, and `intel` —
 * what the card knows about the server. The definition opens its target
 * through files.read's line anchor.
 *
 * The client follows the card's repository (lane L6): a local working copy
 * asks the local app's server (LspClient.ts → `/api/lsp/*`); a cloud
 * repository with a RUNNING workspace asks the server plue runs inside that
 * workspace (CloudLspClient.ts, through the Bun tunnel); a cloud repository
 * without one is told which act opens or resumes a workspace; a file no
 * language the workspace relays handles is told the DTO's list.
 *
 * Honesty: a missing language server is stated with its install line and
 * never installed; a position the server has nothing for is stated; a
 * definition the server found outside the repository is stated as that,
 * never as "none"; every cap the host applied is stated (`N of M shown`,
 * `… and N more`, `cut at 4 KiB`); every close reason and every refusal the
 * cloud relay answers is shown verbatim, never a silent close. Diagnostics
 * the server publishes with no request patch the card they belong to; a
 * publication for a file nobody opened has nowhere to render and is dropped.
 *
 * A local answer is about the file on DISK (the host syncs the document from
 * disk on every request) and names the digest of that text; the card shows
 * the text it was read with. Before an answer lands on a card whose digest
 * differs, the card is re-read in place — same id, ordinal and anchor, the
 * old text's annotations dropped with it — and the answer lands only when
 * the two agree. A cloud answer is about the CARD's text (the client sends
 * it), so it lands only while the card still shows that text. A hover drawn
 * under line 12 of text that no longer has that line would be an invention.
 */
import { LSP_HOVER_CAP_CHARS, LSP_LANGUAGE_SERVER_MISSING, LSP_REQUEST_TIMEOUT_MS, lspLanguageFor } from "@smthrs/rpc/LocalApp"
import type { LspDiagnostic, LspLocation, Repo } from "@smthrs/rpc/LocalApp"
import { parseRepoSelection } from "../AppState"
import type { Actor, Card, CloudWorkspaceRow } from "../AppState"
import type { CloudLspClient, CloudLspDocument, CloudLspEvent } from "../CloudLspClient"
import type { LspAnswer, LspClient, LspRefusal } from "../LspClient"
import { localFileCardId, localFileFields, requestLocalFiles, resolveFileTarget } from "./FilesSeam"
import type { FileAnchor, FilesSeam } from "./FilesSeam"
import type { SeamContext } from "./SeamContext"

export interface CodeIntelSeam {
  readonly hover: (path: string, line: number, column: number, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly definition: (path: string, line: number, column: number, repo?: string) => Promise<string | void | { readonly value: string }>
  readonly diagnostics: (path: string, repo?: string) => Promise<string | void | { readonly value: string }>
  /** Detach every diagnostics subscription (the controller's disposal scope). */
  readonly dispose: () => void
}

export interface CodeIntelSeamOptions {
  readonly lsp: LspClient
  /**
   * Lane L6: the workspace language-server transport. Absent where this host
   * has no cloud tunnel (the web host until the W4 relay), and a cloud file
   * is then told so instead of dialing nothing.
   */
  readonly cloudLsp?: CloudLspClient
  /**
   * files.read: the definition target opens through it at its line, and a
   * file with no card yet renders one (at the asked position) before the
   * answer patches it — a hover with no card to show it on is nothing the
   * human can see.
   */
  readonly readFile: FilesSeam["readFile"]
  /**
   * How long a first request may run before the card states the server is
   * starting (the 300 ms law): the host spawns on first use and tsserver
   * loads the project for seconds; a card that already saw the server
   * answer is never told "starting" again.
   */
  readonly startingAfterMs?: number
}

/** The web host until the W4 relay: no tunnel, so no workspace language server can be reached from here. */
const CLOUD_TUNNEL_ABSENT = "Hover and definitions on a cloud repository need the native app; this host has no cloud tunnel yet."
const SIGN_OUT_REFUSAL = "Sign in to Smithers Cloud first — /cloud.sign-in."

type FilePayload = Extract<Card, { kind: "file" }>["payload"]
type Intel = NonNullable<FilePayload["intel"]>

const cardIdOf = (repo: string, path: string): string => `file-${repo}-${path}`

/** `line:col severity message (source code)` — one diagnostic as the model reads it. */
const diagnosticRow = (item: LspDiagnostic): string => {
  const origin = [item.source, item.code].filter((part): part is string => part !== undefined).join(" ")
  return `${item.line}:${item.character} ${item.severity} ${item.message}${origin === "" ? "" : ` (${origin})`}`
}

const locationRow = (location: LspLocation): string => `${location.path}:${location.line}:${location.character}`

const HOVER_CUT = `(cut at ${LSP_HOVER_CAP_CHARS / 1024} KiB)`

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

const UNSETTLED: ReadonlySet<string> = new Set(["pending", "starting"])

/** The refusal as the model reads it and as the card states it. */
const refused = (refusal: LspRefusal): { readonly intel: Intel; readonly text: string } =>
  refusal.code === LSP_LANGUAGE_SERVER_MISSING && refusal.install !== undefined
    ? { intel: { state: "missing", note: refusal.install }, text: `${refusal.message} Install: ${refusal.install}` }
    : { intel: { state: "unavailable", note: refusal.message }, text: refusal.message }

/**
 * The cloud relay's refusal, in the workspace's terms: plue's 409
 * `language_server_missing` carries the install line verbatim, and the card
 * says which workspace lacks the server (the native card's "on this machine"
 * would be false here); every other refusal — a close reason, a POST's
 * words — is shown as it came.
 */
const refusedCloud = (refusal: LspRefusal, document: CloudLspDocument, workspace: { readonly id: string; readonly name: string }): { readonly intel: Intel; readonly text: string } =>
  refusal.code === LSP_LANGUAGE_SERVER_MISSING && refusal.install !== undefined
    ? {
      intel: { state: "unavailable", note: `no ${document.language} language server in workspace "${workspace.name}" (${workspace.id}) — install: ${refusal.install}` },
      text: `Workspace "${workspace.name}" (${workspace.id}) has no ${document.language} language server. Install: ${refusal.install}`
    }
    : { intel: { state: "unavailable", note: refusal.message }, text: refusal.message }

type Prepared =
  | { readonly kind: "local"; readonly repo: Repo; readonly path: string; readonly id: string }
  | {
    readonly kind: "cloud"
    readonly repo: string
    readonly path: string
    readonly id: string
    readonly document: CloudLspDocument
    readonly workspace: { readonly id: string; readonly name: string }
  }

export const createCodeIntelSeam = (ctx: SeamContext, options: CodeIntelSeamOptions): CodeIntelSeam => {
  const startingAfterMs = options.startingAfterMs ?? 300

  const fileCard = (id: string): Extract<Card, { kind: "file" }> | undefined => {
    const card = ctx.store.collections.cards.get(id)
    return card?.kind === "file" ? card : undefined
  }

  /** Patch the file card's payload through the dispatcher; false when no such card exists. */
  const patch = (id: string, fields: Partial<FilePayload>, actor: Actor = ctx.actor()): boolean => {
    const card = fileCard(id)
    if (card === undefined) return false
    ctx.dispatch({ type: "card.updated", actor, id, patch: { payload: { ...card.payload, ...fields } } })
    return true
  }

  /** The card's diagnostics fields from an answer: the capped list, and the total only when the cap cut. */
  const diagnosticsFields = (items: ReadonlyArray<LspDiagnostic>, total: number): Partial<FilePayload> => ({
    diagnostics: [...items],
    diagnosticsTotal: total > items.length ? total : undefined
  })

  /*
   * One subscription per LOCAL repository for as long as the controller
   * lives: every publication patches the card of the file it names. The
   * first code.* call on a repository opens it, so a repository nobody asked
   * about costs no socket topic.
   */
  const watching = actorSharedState(ctx, "code-local-watches", () => new Map<string, () => void>())
  const watch = (repo: Repo): void => {
    if (watching.has(repo.id)) return
    watching.set(
      repo.id,
      options.lsp.subscribe(repo.id, (message) => {
        const id = localFileCardId(repo.id, message.path)
        if (fileCard(id) === undefined) return
        void reconciled(repo, message.path, id, message.digest, "system").then((agree) => {
          if (agree) patch(id, diagnosticsFields(message.items, message.total), "system")
        })
      })
    )
  }

  /*
   * The cloud client speaks for every workspace at once: a publication lands
   * on the card still showing the text it is about; a close, and a refusal
   * the server asked to be retried, are stated on every card the connection
   * serves — the documents it opened and the cards whose act is dialing it
   * right now (the first act opens no document until the server is ready).
   * Never a silent close.
   */
  const cloudWatch = actorSharedState(ctx, "code-cloud-watch", () => ({ unwatch: undefined as (() => void) | undefined }))
  const dialing = actorSharedState(ctx, "code-cloud-dialing", () => new Map<string, Set<string>>())
  const connectionKey = (workspaceId: string, language: string): string => `${workspaceId} ${language}`
  const cloudCards = (event: Extract<CloudLspEvent, { readonly paths: ReadonlyArray<string> }>): ReadonlySet<string> =>
    new Set([...event.paths.map((path) => cardIdOf(event.repo, path)), ...(dialing.get(connectionKey(event.workspaceId, event.language)) ?? [])])
  const watchCloud = (): void => {
    if (cloudWatch.unwatch !== undefined || options.cloudLsp === undefined) return
    cloudWatch.unwatch = options.cloudLsp.subscribe((event) => {
      switch (event.type) {
        case "diagnostics": {
          const id = cardIdOf(event.repo, event.path)
          if (fileCard(id)?.payload.content === event.content) patch(id, diagnosticsFields(event.items, event.total), "system")
          return
        }
        case "closed": {
          const note = `the workspace language server closed: ${event.reason === "" ? "no reason given" : event.reason} (${event.code})`
          for (const id of cloudCards(event)) patch(id, { intel: { state: "unavailable", note } }, "system")
          return
        }
        case "waiting": {
          for (const id of cloudCards(event)) patch(id, { intel: { state: "unavailable", note: event.note } }, "system")
          return
        }
      }
    })
  }

  /**
   * True when the card shows the text the answer is about. When it does not,
   * the card is re-read in place through the files route (its id, ordinal and
   * anchor stay; the old text's annotations go) and the answer lands only if
   * the digests then agree — a file changing twice between two reads is
   * stated by silence, never by an annotation on the wrong line.
   */
  const reconciled = async (repo: Repo, path: string, id: string, digest: string, actor: Actor = ctx.actor()): Promise<boolean> => {
    const card = fileCard(id)
    if (card === undefined) return false
    if (card.payload.digest === digest) return true
    const answer = await requestLocalFiles(ctx, repo, path, path, "read")
    if ("error" in answer || answer.body.kind !== "file") return false
    const fields = localFileFields(answer.body)
    patch(id, { ...fields, hover: undefined, diagnostics: undefined, diagnosticsTotal: undefined }, actor)
    return fields.digest === digest
  }

  /** The file card the answer lands on, rendered through files.read when absent; the read's refusal is the answer then. */
  const ensureCard = async (repo: string, path: string, anchor?: FileAnchor): Promise<string | undefined> => {
    if (fileCard(cardIdOf(repo, path)) !== undefined) return undefined
    const read = await options.readFile(path, repo, anchor)
    return typeof read === "string" ? read : undefined
  }

  /** Run one request; past the 300 ms mark a card that never saw the server answer states "starting". */
  const request = async <T>(prepared: Prepared, work: () => Promise<LspAnswer<T>>): Promise<LspAnswer<T>> => {
    const { id } = prepared
    const timer = setTimeout(() => {
      if (fileCard(id)?.payload.intel?.state !== "ready") patch(id, { intel: { state: "starting" } })
    }, startingAfterMs)
    ;(timer as { unref?: () => void }).unref?.()
    const key = prepared.kind === "cloud" ? connectionKey(prepared.document.workspaceId, prepared.document.language) : undefined
    if (key !== undefined) dialing.set(key, (dialing.get(key) ?? new Set()).add(id))
    try {
      return await work()
    } finally {
      clearTimeout(timer)
      if (key !== undefined) {
        const set = dialing.get(key)
        set?.delete(id)
        if (set?.size === 0) dialing.delete(key)
      }
    }
  }

  /*
   * The workspace a cloud repository's act means: the active working copy
   * when it is a running workspace of that repository, else the one running
   * workspace of it — never a guess among several. Without a running one,
   * the refusal names the act that gets one.
   */
  const workspaceFor = (repo: string): { readonly workspace: CloudWorkspaceRow } | { readonly refusal: string } => {
    const rows = [...ctx.store.collections.cloudWorkspaces.values()].filter((row) => row.repoId === repo)
    const running = rows.filter((row) => row.status === "running")
    const key = ctx.store.session().activeRepoKey ?? null
    const selection = key === null ? null : parseRepoSelection(key)
    const copyId = selection === null ? undefined : "repoId" in selection ? selection.copyId : selection.localCopyId
    const copy = copyId === undefined ? undefined : ctx.store.collections.workingCopies.get(copyId)
    const active = copy?.kind === "workspace" ? running.find((row) => row.id === copy.workspaceId) : undefined
    if (active !== undefined) return { workspace: active }
    if (running.length === 1) return { workspace: running[0]! }
    if (running.length > 1) {
      return { refusal: `Several workspaces of ${repo} are running (${running.map((row) => `"${row.name}" ${row.id}`).join(", ")}) — select one in the sidebar first.` }
    }
    const resumable = rows.find((row) => row.status === "suspended" || row.status === "stopped")
    if (resumable !== undefined) {
      return { refusal: `Hover and definitions need a running workspace of ${repo}: "${resumable.name}" (${resumable.id}) is ${resumable.status} — /workspace.resume ${resumable.id} first.` }
    }
    const settling = rows.find((row) => UNSETTLED.has(row.status))
    if (settling !== undefined) {
      return { refusal: `Hover and definitions need a running workspace of ${repo}: "${settling.name}" (${settling.id}) is ${settling.status} — wait for it to settle (the card tracks it).` }
    }
    return { refusal: `Hover and definitions need a running workspace of ${repo} — /workspace.open ${repo} first.` }
  }

  /** The cloud half of `prepare`: the tunnel, the sign-in, the workspace, the language it relays, and the card's whole text. */
  const prepareCloud = async (repo: string, path: string, anchor: FileAnchor | undefined): Promise<Prepared | string> => {
    const id = cardIdOf(repo, path)
    if (options.cloudLsp === undefined) {
      patch(id, { intel: { state: "unavailable", note: CLOUD_TUNNEL_ABSENT } })
      return CLOUD_TUNNEL_ABSENT
    }
    if (ctx.store.collections.cloudSessions.get("cloud")?.state !== "signed-in") return SIGN_OUT_REFUSAL
    const found = workspaceFor(repo)
    if ("refusal" in found) {
      patch(id, { intel: { state: "unavailable", note: found.refusal } })
      return found.refusal
    }
    const { workspace } = found
    const language = lspLanguageFor(path)
    const served = workspace.lspLanguages ?? null
    if (language === null || (served !== null && !served.includes(language))) {
      const extension = /\.[^./]+$/.exec(path)?.[0]
      const noun = extension === undefined ? "this file" : `${extension} files`
      const refusal = served === null
        ? `No workspace language server handles ${noun}.`
        : `No workspace language server handles ${noun} — "${workspace.name}" (${workspace.id}) serves ${served.length === 0 ? "no language" : served.join(", ")}.`
      patch(id, { intel: { state: "unavailable", note: refusal } })
      return refusal
    }
    const unread = await ensureCard(repo, path, anchor)
    if (unread !== undefined) return unread
    const card = fileCard(id)
    if (card === undefined) return `${path} in ${repo} could not be rendered.`
    if (card.payload.binary === true) return `${path} in ${repo} is a binary file; a language server has nothing to read there.`
    if (card.payload.truncated) {
      const refusal = `${path} in ${repo} is larger than the card cap; hover, definitions and diagnostics need the whole file.`
      patch(id, { intel: { state: "unavailable", note: refusal } })
      return refusal
    }
    watchCloud()
    return {
      kind: "cloud",
      repo,
      path,
      id,
      workspace: { id: workspace.id, name: workspace.name },
      document: { repo, workspaceId: workspace.id, language, path, content: card.payload.content }
    }
  }

  /** The target, its card, and the subscription, or the honest refusal — shared by the three acts. */
  const prepare = async (pathArg: string, repoArg: string | undefined, anchor?: FileAnchor): Promise<Prepared | string> => {
    const target = resolveFileTarget(ctx.store, pathArg, repoArg)
    if ("error" in target) return target.error
    if (target.path === "") return "code intelligence needs a file path"
    if (target.kind === "cloud") return prepareCloud(target.repo, target.path, anchor)
    const refusal = await ensureCard(target.repo.id, target.path, anchor)
    if (refusal !== undefined) return refusal
    watch(target.repo)
    return { kind: "local", repo: target.repo, path: target.path, id: localFileCardId(target.repo.id, target.path) }
  }

  const repoNameOf = (prepared: Prepared): string => prepared.kind === "local" ? prepared.repo.name : prepared.repo

  /** The digest a local answer names; a cloud answer names none (it is about the card's own text). */
  const digestOf = (ok: object): string | undefined => {
    const digest = (ok as { readonly digest?: unknown }).digest
    return typeof digest === "string" ? digest : undefined
  }

  /** The refusal, stated on the card and to the model, in the terms of the host that answered. */
  const refuse = (prepared: Prepared, refusal: LspRefusal): string => {
    const { intel, text } = prepared.kind === "local" ? refused(refusal) : refusedCloud(refusal, prepared.document, prepared.workspace)
    patch(prepared.id, { intel })
    return text
  }

  /**
   * True when the card shows the text the answer is about. Local answers name
   * a digest and reconcile through the files route; a cloud answer is about
   * the text the client sent, which lands only while the card still shows it.
   */
  const current = async (prepared: Prepared, digest: string | undefined): Promise<boolean> =>
    prepared.kind === "local"
      ? digest !== undefined && reconciled(prepared.repo, prepared.path, prepared.id, digest)
      : fileCard(prepared.id)?.payload.content === prepared.document.content

  return {
    hover: async (pathArg, line, column, repoArg) => {
      const prepared = await prepare(pathArg, repoArg, { line, column })
      if (typeof prepared === "string") return prepared
      const { path, id } = prepared
      const repo = repoNameOf(prepared)
      const answer = await request(prepared, () =>
        prepared.kind === "local"
          ? options.lsp.hover({ repoId: prepared.repo.id, path, line, character: column })
          : options.cloudLsp!.hover(prepared.document, { line, character: column }))
      if ("refusal" in answer) return refuse(prepared, answer.refusal)
      const { hover } = answer.ok
      if (await current(prepared, digestOf(answer.ok))) {
        patch(id, {
          intel: { state: "ready" },
          hover: hover === null ? null : { line, character: column, contents: hover.contents, ...(hover.truncated ? { truncated: true } : {}) }
        })
      } else {
        patch(id, { intel: { state: "ready" } })
      }
      return {
        value: hover === null
          ? `The language server has nothing at ${path}:${line}:${column} in ${repo}.`
          : `${path}:${line}:${column} in ${repo}\n${hover.contents}${hover.truncated ? `\n${HOVER_CUT}` : ""}`
      }
    },

    definition: async (pathArg, line, column, repoArg) => {
      const prepared = await prepare(pathArg, repoArg, { line, column })
      if (typeof prepared === "string") return prepared
      const { path, id } = prepared
      const repo = repoNameOf(prepared)
      const answer = await request(prepared, () =>
        prepared.kind === "local"
          ? options.lsp.definition({ repoId: prepared.repo.id, path, line, character: column })
          : options.cloudLsp!.definition(prepared.document, { line, character: column }))
      if ("refusal" in answer) return refuse(prepared, answer.refusal)
      const { locations, total, omitted } = answer.ok
      const at = `${path}:${line}:${column} in ${repo}`
      const [first, ...rest] = locations
      if (first === undefined) {
        /*
         * The server found nothing, or found it only outside the repository
         * (a linked package, a lib.d.ts): two different facts. The second is
         * the common one for a checkout without its own node_modules, and
         * "no definition found" would be false. The card states it too.
         */
        const outside = omitted === 0 ? undefined : `outside the repository (${plural(omitted, "location")} not openable here)`
        patch(id, { intel: outside === undefined ? { state: "ready" } : { state: "ready", note: `Definition of ${path}:${line}:${column}: ${outside}` } })
        return { value: outside === undefined ? `No definition found for ${at}.` : `${at} is defined ${outside}.` }
      }
      patch(id, { intel: { state: "ready" } })
      /*
       * The card effect (§4): the first target opens at its line through
       * files.read's anchor — the same card id, the same dedupe, the same
       * scroll. The read's own value stays out of this answer: the model
       * asked where, not what; it reads the target with files.read. A
       * refusal still belongs in the answer because the target did not open.
       */
      const opened = await options.readFile(first.path, prepared.kind === "local" ? prepared.repo.id : repo, { line: first.line, column: first.character })
      const more = total - omitted - locations.length
      const trailer = [
        ...(more > 0 ? [`… and ${more} more`] : []),
        ...(omitted > 0 ? [`(${plural(omitted, "more location")} outside the repository, not openable here)`] : [])
      ]
      return { value: `${at} is defined at:\n${[first, ...rest].map(locationRow).join("\n")}${trailer.length === 0 ? "" : `\n${trailer.join("\n")}`}${typeof opened === "string" ? `; the target could not be opened: ${opened}` : ""}` }
    },

    diagnostics: async (pathArg, repoArg) => {
      const prepared = await prepare(pathArg, repoArg)
      if (typeof prepared === "string") return prepared
      const { path, id } = prepared
      const repo = repoNameOf(prepared)
      const answer = await request(prepared, () =>
        prepared.kind === "local"
          ? options.lsp.diagnostics({ repoId: prepared.repo.id, path })
          : options.cloudLsp!.diagnostics(prepared.document))
      if ("refusal" in answer) return refuse(prepared, answer.refusal)
      const { items, total } = answer.ok
      if (items === null || total === null) {
        // The server published nothing within the wait: the card keeps no count rather than a false zero.
        patch(id, { intel: { state: "ready" } })
        return { value: `The language server published no diagnostics for ${path} in ${repo} within ${LSP_REQUEST_TIMEOUT_MS / 1000} s.` }
      }
      if (await current(prepared, digestOf(answer.ok))) patch(id, { intel: { state: "ready" }, ...diagnosticsFields(items, total) })
      else patch(id, { intel: { state: "ready" } })
      const shown = total > items.length ? ` (first ${items.length} shown)` : ""
      return {
        value: items.length === 0
          ? `${path} in ${repo}: no diagnostics.`
          : `${path} in ${repo}: ${plural(total, "diagnostic")}${shown}\n${items.map(diagnosticRow).join("\n")}`
      }
    },

    dispose: () => {
      for (const detach of watching.values()) detach()
      watching.clear()
      cloudWatch.unwatch?.()
      cloudWatch.unwatch = undefined
      dialing.clear()
    }
  }
}
