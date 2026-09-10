/*
 * The composer boundary: slash argument text in, a flow's typed payload out.
 *
 * Under the old `Command` interface every handler re-parsed its own `args?:
 * string` — the same trailing-`owner/repo` split written out dozens of times,
 * each free to drift. Flows take DECODED payloads, so the text-shaped step
 * happens exactly once: here, at the edge where a human's `/name <text>` (or
 * an agent's single argument string) becomes the record the flow's input
 * schema validates.
 *
 * A parse either produces the payload or an honest error naming what is
 * missing. The error never reaches the flow: an invocation that cannot be
 * parsed is refused before the handler runs, which is why no handler below the
 * boundary contains an argument check.
 */
import { splitRunSource, takesRunSource } from "./RunCommand"
import { parseFileArgs } from "./FileArgs"
import { isTraceFilter, TRACE_FILTER_IDS } from "../cards/RunTrace"
import { splitTrailingRepo } from "../state/RepoContext"
import type { KnownRepositories } from "../state/RepoContext"

/** A parsed invocation, or the honest refusal that names what is missing. */
export type Parsed =
  | { readonly payload: Record<string, unknown> }
  | { readonly error: string }

/**
 * One flow's grammar: its slash text, and the repositories a trailing
 * `owner/repo` token beside other text may name (RepoContext.ts
 * splitTrailingRepo). Absent `known`, the token's shape alone decides.
 */
export type Grammar = (args: string | undefined, known?: KnownRepositories) => Parsed

const ok = (payload: Record<string, unknown>): Parsed => ({ payload })
const no = (error: string): Parsed => ({ error })

/** The empty payload every no-argument flow takes. */
const NONE: Parsed = { payload: {} }

const trimmed = (args: string | undefined): string => (args ?? "").trim()

/** A required single-value payload, refused by name when the text is blank. */
const required = (field: string, args: string | undefined, reason: string): Parsed => {
  const value = trimmed(args)
  return value === "" ? no(reason) : ok({ [field]: value })
}

/** An optional single-value payload: blank text means the field is absent. */
const optional = (field: string, args: string | undefined): Parsed => {
  const value = trimmed(args)
  return ok(value === "" ? {} : { [field]: value })
}

/** A repo-scoped flow that takes nothing but its optional `owner/repo` target. */
const repoOnly = (name: string, args: string | undefined): Parsed => {
  // This grammar only accepts a repository, including one not yet imported.
  const { rest, repo } = splitTrailingRepo(args)
  if (rest !== "") return no(`${name} takes just an owner/repo name`)
  return ok(repo === undefined ? {} : { repo })
}

/** A positive issue or pull-request number beside its optional repo. */
const numbered = (args: string | undefined, reason: string, known?: KnownRepositories): Parsed => {
  const { rest, repo } = splitTrailingRepo(args, known)
  const number = Number(rest)
  if (!Number.isInteger(number) || number <= 0) return no(reason)
  return ok(repo === undefined ? { number } : { number, repo })
}

/** Preserve JSON string whitespace when extracting the optional flow input. */
export const flowRunParts = (args: string | undefined): { name?: string; repo?: string; input?: string; sourceCard?: string } => {
  const source = splitRunSource(args)
  const parts = flowRunBody(source.args)
  return source.sourceCard === undefined ? parts : { ...parts, sourceCard: source.sourceCard }
}
const flowRunBody = (args: string | undefined): { name?: string; repo?: string; input?: string } => {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed(args))
  if (match === null) return {}
  const name = match[1]!
  const rest = match[2]?.trim() ?? ""
  if (rest === "") return { name }
  if (rest.startsWith("{") || rest.startsWith("[")) return { name, input: rest }
  const target = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest)!
  return { name, repo: target[1]!, ...(target[2] === undefined ? {} : { input: target[2] }) }
}

/** The three sandbox kinds `workspace.open --kind` accepts (ADR 0002). */
const KINDS: ReadonlyArray<string> = ["container", "vm", "desktop"]

/**
 * The rest of the trimmed line after its first `count` tokens, with the
 * spacing inside it intact — how a grammar takes a tail that may hold
 * whitespace (a path, a message, a name).
 */
const restAfter = (args: string | undefined, count: number): string => {
  let rest = trimmed(args)
  for (let index = 0; index < count; index += 1) {
    const match = /^\S+\s*/.exec(rest)
    if (match === null) return ""
    rest = rest.slice(match[0].length)
  }
  return rest.trim()
}

const tokensOf = (args: string | undefined): Array<string> =>
  trimmed(args)
    .split(/\s+/)
    .filter((token) => token !== "")

/**
 * `<path>:<line>:<col> [owner/repo]` (docs/code-intel/PLAN.md §4): a 1-based
 * position in a file, both numbers required. Only the TRAILING `:n:n` comes
 * off the token, so a path with a colon of its own keeps working, as
 * files.read's anchor does.
 */
const positioned = (name: string, args: string | undefined): Parsed => {
  const parsed = parseFileArgs(args)
  if ("error" in parsed) return parsed
  const tokens = parsed.tokens
  const [token, repo] = tokens
  const usage = `/${name} <path>:<line>:<col> [owner/repo]`
  if (token === undefined) return no(`${name} needs a position: ${usage}`)
  if (tokens.length > 2) return no(`${name} takes a position and optionally an owner/repo`)
  const match = /^(.+):(\d+):(\d+)$/.exec(token)
  if (match === null) return no(`${name} needs <path>:<line>:<col>: ${usage}`)
  const [, path = "", lineText = "", columnText = ""] = match
  const line = Number(lineText)
  const column = Number(columnText)
  if (line === 0 || column === 0) return no(`${name} lines and columns count from 1: ${usage}`)
  return ok({ path, line, column, ...(repo === undefined ? {} : { repo }) })
}

/**
 * A repository id followed by an optional workspace and a target label
 * (`//pkg:name`). A label never holds whitespace, so the LAST token is the
 * label and everything between it and the repo id is the workspace path — a
 * detected workspace whose directory name has a space still runs where it
 * was declared. The plugin and targets cards dispatch `repoId workspace
 * label`; the html panel's bridge sends only `repoId label` and runs at the
 * root.
 */
/** `<repoId> <//...:name>`: a grouped row of one open repository. */
const groupRef = (name: string, args: string | undefined) => {
  const [repoId, ...rest] = tokensOf(args)
  if (repoId === undefined) return no(`${name} needs a repository id`)
  const group = rest.join(" ").trim()
  if (group === "") return no(`${name} needs a group label`)
  return ok({ repoId, group })
}

/** `<repoId> <label>`: a star names one target of one open repository. */
const starRef = (name: string, args: string | undefined) => {
  const [repoId, ...rest] = tokensOf(args)
  if (repoId === undefined) return no(`${name} needs a repository id`)
  const label = rest.join(" ").trim()
  if (label === "") return no(`${name} needs a target label`)
  return ok({ repoId, label })
}

const targetRef = (name: string, args: string | undefined): Parsed => {
  const [repoId, ...rest] = tokensOf(args)
  if (repoId === undefined || repoId === "" || rest.length === 0) {
    return no(`${name} needs a repository id and a target label`)
  }
  const label = rest[rest.length - 1] ?? ""
  if (rest.length === 1) return ok({ repoId, label })
  return ok({ repoId, workspace: rest.slice(0, -1).join(" "), label })
}

/*
 * The grammar, one entry per flow that accepts arguments. A flow absent from
 * this table takes the empty payload — which is also what a flow with no args
 * hint gets, since `parseSubmit` routes `/name <text>` for such a flow to the
 * agent as a prompt rather than to the flow.
 */
/** `<changeId> <n>`: a change id followed by one positive id (a thread, a finding). */
const numberedChangeRef = (name: string, field: string, what: string, args: string | undefined): Parsed => {
  const [changeId, raw, ...rest] = tokensOf(args)
  const id = Number(raw)
  if (changeId === undefined || raw === undefined || rest.length > 0 || !Number.isInteger(id) || id <= 0) {
    return no(`${name} takes a change id and ${what}`)
  }
  return ok({ changeId, [field]: id })
}

const GRAMMAR: Readonly<Record<string, Grammar>> = {
  "appearance.theme": (args) => ok({ palette: args ?? "" }),
  "chat.send": (args) => required("text", args, "send needs the text to submit"),
  "chat.clear": (args) => trimmed(args) === "" ? NONE : trimmed(args) === "--summarize"
    ? ok({ summarize: true })
    : no("chat.clear accepts only --summarize; omit it to archive locally"),
  "browser.open": (args) => required("url", args, "browser needs a URL: /browser.open https://example.com"),
  /*
   * The description keeps the trailing `owner/repo` token: createWorkflow
   * applies its OWN split, which (unlike splitTrailingRepo) leaves a lone
   * repo-shaped word as the description. Splitting here would change which
   * inputs name a target.
   */
  "flow.create": (args) => ok({ description: trimmed(args) }),
  "flow.repo.choose": (args) => required("repo", args, "flow.repo.choose needs a repository name"),
  "flow.run.stop": (args) => {
    const [cardId, ...rest] = tokensOf(args)
    if (cardId === undefined) return no("flow.run.stop needs the card id")
    const reason = rest.join(" ").trim()
    return ok(reason === "" ? { cardId } : { cardId, reason })
  },
  "flow.run.retry": (args) => required("cardId", args, "flow.run.retry needs the card id"),
  /*
   * Lane runs — the run inbox and its acts. `runs.list` takes its filters in
   * any order: `by=`/`lineage=` name theirs, a trailing owner/repo names the
   * workspace, and the remaining positionals are [status] [flow].
   */
  "runs.list": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    const payload: Record<string, string> = {}
    const positional: Array<string> = []
    for (const token of tokensOf(rest)) {
      const keyed = /^(by|lineage|sourceCard)=(.+)$/.exec(token)
      if (keyed !== null) payload[keyed[1]!] = keyed[2]!
      else positional.push(token)
    }
    if (positional.length > 2) return no("runs.list takes [status] [flow] [by=…] [lineage=…] [sourceCard=…] [owner/repo]")
    const [status, flow] = positional
    if (status !== undefined) payload["status"] = status
    if (flow !== undefined) payload["flow"] = flow
    if (repo !== undefined) payload["repo"] = repo
    return ok(payload)
  },
  "runs.open": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    const runId = rest.trim()
    if (runId === "" || /\s/.test(runId)) return no("runs.open needs a run id: /runs.open <runId> [owner/repo]")
    return ok(repo === undefined ? { runId } : { runId, repo })
  },
  "runs.resume": (args) => required("runId", args, "runs.resume needs a run id"),
  "runs.rerun": (args) => required("runId", args, "runs.rerun needs a run id"),
  "runs.signal": (args) => {
    const [runId, name] = tokensOf(args)
    if (runId === undefined) return no("runs.signal needs a run id")
    if (name === undefined) return no("runs.signal needs the signal's name: /runs.signal <runId> <name> [json]")
    // The payload keeps its original spacing — JSON is whitespace-sensitive to a reader.
    const payload = trimmed(args).slice(runId.length).trim().slice(name.length).trim()
    return ok(payload === "" ? { runId, name } : { runId, name, payload })
  },
  "runs.steer": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.steer needs a run id")
    const body = rest.join(" ").trim()
    if (body === "") return no("runs.steer needs the message to deliver")
    return ok({ runId, body })
  },
  "runs.seat": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.seat needs a run id")
    const seat = rest.join(" ").trim()
    if (seat === "") return no("runs.seat needs the seat to move the run to")
    return ok({ runId, seat })
  },
  "runs.thinking": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.thinking needs a run id")
    const thinking = rest.join(" ").trim()
    if (thinking === "") return no("runs.thinking needs the thinking level")
    return ok({ runId, thinking })
  },
  "runs.tools": (args) => {
    const [runId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.tools needs a run id")
    const toolNames = rest.join(" ").trim()
    if (toolNames === "") return no("runs.tools needs the tool names, comma-separated")
    return ok({ runId, toolNames })
  },
  "runs.logs": (args) => {
    const tokens = tokensOf(args)
    const follow = tokens.includes("--follow")
    const [runId, ...rest] = tokens.filter((token) => token !== "--follow")
    if (runId === undefined) return no("runs.logs needs a run id: /runs.logs <runId> [--follow]")
    if (rest.length > 0) return no("runs.logs takes a run id and optionally --follow")
    return ok(follow ? { runId, follow } : { runId })
  },
  /* The run trace's reader gestures (factory spec 06 §6): a filter word, or a node with an optional journal seq. */
  "runs.trace.filter": (args) => {
    const [runId, filter, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.trace.filter needs a run id")
    if (filter === undefined || !isTraceFilter(filter)) {
      return no(`runs.trace.filter needs one of ${TRACE_FILTER_IDS.join(", ")}`)
    }
    if (rest.length > 0) return no("runs.trace.filter takes a run id and one filter")
    return ok({ runId, filter })
  },
  "runs.trace.select": (args) => {
    const [runId, nodeId, seqText, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.trace.select needs a run id")
    if (nodeId === undefined) return no("runs.trace.select needs the trace node to select")
    if (rest.length > 0) return no("runs.trace.select takes a run id, a node and optionally a journal seq")
    if (seqText === undefined) return ok({ runId, nodeId })
    const seq = Number(seqText)
    if (!Number.isInteger(seq) || seq < 0) return no("runs.trace.select's seq is a journal sequence number")
    return ok({ runId, nodeId, seq })
  },
  "runs.events": (args) => required("runId", args, "runs.events needs a run id"),
  "runs.coding.select": (args) => {
    const [runId, changeId, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.coding.select needs a run id")
    if (changeId === undefined) return no("runs.coding.select needs a predicted Change")
    if (rest.length > 0) return no("runs.coding.select takes a run id and one Change")
    return ok({ runId, changeId })
  },
  "runs.trace.live": (args) => required("runId", args, "runs.trace.live needs a run id"),
  "runs.trace.view": (args) => {
    const [runId, view, ...rest] = tokensOf(args)
    if (runId === undefined) return no("runs.trace.view needs a run id")
    if (view !== "turns" && view !== "timeline") return no("runs.trace.view needs turns or timeline")
    if (rest.length > 0) return no("runs.trace.view takes a run id and one view")
    return ok({ runId, view })
  },
  "runs.steps": (args) => required("runId", args, "runs.steps needs a run id"),
  "approvals.list": (args) => repoOnly("approvals.list", args),
  "flow.run.stop-all": (args) => repoOnly("flow.run.stop-all", args),
  "approvals.open": (args) => required("runId", args, "approvals.open needs a run id"),
  "flow.list": (args) => repoOnly("flow.list", args),
  "triggers.list": (args) => repoOnly("triggers.list", args),
  "triggers.register": (args) => repoOnly("triggers.register", args),
  "factory.show": (args) => repoOnly("factory.show", args),
  "flow.run": (args) => {
    const { name, repo, input } = flowRunParts(args)
    if (name === undefined) return no("flow.run needs a flow name")
    const target = { name, ...(repo === undefined ? {} : { repo }) }
    if (input === undefined) return ok(target)
    try {
      const value: unknown = JSON.parse(input)
      if (value === null || typeof value !== "object" || Array.isArray(value)) return no("Flow input must be a JSON object.")
      return ok({ ...target, input: value })
    } catch { return no("Flow input is not valid JSON. Fix the JSON object before running it.") }
  },
  "card.maximize": (args) => required("cardId", args, "card.maximize needs the card id"),
  "card.dismiss": (args) => required("cardId", args, "card.dismiss needs the card id"),
  // The clipboard text is taken verbatim: trimming would silently rewrite what
  // the human asked to copy.
  "chat.copy-message": (args) => (args ?? "") === "" ? no("copy-message needs the text to copy") : ok({ text: args ?? "" }),
  "approval.approve": (args) => required("cardId", args, "approval.approve needs the card id"),
  "approval.deny": (args) => required("cardId", args, "approval.deny needs the card id"),
  "connector.add": (args) => {
    const access = trimmed(args)
    if (access !== "read" && access !== "read-write") {
      return no("connector.add needs an access level: read or read-write")
    }
    return ok({ access })
  },
  "connector.downgrade": (args) => required("connectorId", args, "connector.downgrade needs the connector id"),
  "connector.remove.ask": (args) => required("connectorId", args, "connector.remove.ask needs the connector id"),
  "connector.remove": (args) => required("connectorId", args, "connector.remove needs the connector id"),
  "wiki.select": (args) => required("documentId", args, "wiki.select needs the document id"),
  "wiki.cloud": (args) => {
    const [repo, page] = tokensOf(args)
    if (repo === undefined) return no("Choose a repository for its Wiki.")
    return ok({ repo, ...(page === undefined ? {} : { page: Number(page) }) })
  },
  "wiki.cloud.open": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    return rest === "" || repo === undefined ? no("Choose a Wiki page slug and repository.") : ok({ slug: rest, repo })
  },
  "wiki.sync": (args) => required("documentId", args, "wiki.sync needs the document id"),
  "wiki.card.select": (args) => {
    const [cardId, documentId] = tokensOf(args)
    return cardId === undefined || documentId === undefined ? no("Choose a Wiki card and page.") : ok({ cardId, documentId })
  },
  "wiki.card.view": (args) => {
    const [cardId, view] = tokensOf(args)
    return cardId === undefined || view === undefined ? no("Choose a Wiki card and view.") : ok({ cardId, view })
  },
  "wiki.edit": (args) => {
    const [documentId] = tokensOf(args)
    if (documentId === undefined) return no("Choose a Wiki page and its Markdown.")
    const body = trimmed(args).slice(documentId.length).trim()
    if (body === "") return no("Supply the Wiki page's Markdown.")
    try { return ok({ documentId, body: JSON.parse(body) }) }
    catch { return no("Supply Markdown as a JSON string, or open the Wiki edit form without a body.") }
  },
  "wiki.delete": (args) => required("documentId", args, "wiki.delete needs the document id"),
  // Librarian L5: a note by path, file stem or title; wiki.graph without one is the whole Wiki.
  "wiki.open": (args) => required("path", args, "wiki.open needs a note path or title"),
  "wiki.backlinks": (args) => required("path", args, "wiki.backlinks needs a note path or title"),
  "wiki.graph": (args) => optional("path", args),
  "wiki.heading": (args) => required("line", args, "wiki.heading needs the heading's source line"),
  /* Hidden aliases of the two above (entries/world.ts). */
  "world.select": (args) => required("documentId", args, "world.select needs the document id"),
  "world.delete": (args) => required("documentId", args, "world.delete needs the document id"),
  "toast.dismiss": (args) => required("toastId", args, "toast.dismiss needs the toast id"),
  /* The Library's two acts: one plugin id, the one the shelf lists. */
  "plugins.install": (args) => required("plugin", args, "plugins.install needs a plugin id — /plugins lists them"),
  "plugins.remove": (args) => required("plugin", args, "plugins.remove needs a plugin id — /plugins lists what is installed"),
  /* The flow the card names as absent; blank renders the generic "That is not in the web app". */
  "app.download.prompt": (args) => optional("flow", args),
  "repos.import": (args) => repoOnly("repos.import", args),
  "issues.list": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    const filter = rest === "" ? "open" : rest
    if (filter !== "open" && filter !== "closed" && filter !== "all") {
      return no("issues.list takes open, closed, or all")
    }
    return ok(repo === undefined ? { filter } : { filter, repo })
  },
  "issues.view": (args, known) => numbered(args, "issues.view needs an issue number", known),
  "issues.create": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    if (rest === "") return no("issues.create needs a title")
    return ok(repo === undefined ? { title: rest } : { title: rest, repo })
  },
  /*
   * The repository welcome and its three answers (controller/onboarding.ts):
   * each takes only its optional target. `feature.prototype` reads like
   * issues.create: the request is the line, a trailing owner/repo the target.
   */
  "repo.welcome": (args) => repoOnly("repo.welcome", args),
  "repo.maintain": (args) => repoOnly("repo.maintain", args),
  "repo.contribute": (args) => repoOnly("repo.contribute", args),
  "repo.explore": (args) => repoOnly("repo.explore", args),
  "repo.home": (args) => repoOnly("repo.home", args),
  "feature.prototype": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    if (rest === "") return no("feature.prototype needs what the feature should do")
    return ok(repo === undefined ? { request: rest } : { request: rest, repo })
  },
  "issues.close": (args, known) => numbered(args, "issues.close needs an issue number", known),
  "issues.reopen": (args, known) => numbered(args, "issues.reopen needs an issue number", known),
  "issues.comment": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    const [head, ...tail] = rest.split(/\s+/)
    const number = Number(head)
    const text = tail.join(" ").trim()
    if (!Number.isInteger(number) || number <= 0) return no("issues.comment needs an issue number")
    if (text === "") return no("issues.comment needs the comment text")
    return ok(repo === undefined ? { number, text } : { number, text, repo })
  },
  "prs.list": (args) => repoOnly("prs.list", args),
  "prs.view": (args, known) => numbered(args, "prs.view needs a pull request number", known),
  "prs.create": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    // The source bookmark rides as a `from:<name>` token anywhere in the text;
    // /branches.list shows the choices.
    const tokens = rest.split(/\s+/).filter((token) => token !== "")
    const fromToken = tokens.find((token) => token.startsWith("from:"))
    const from = fromToken?.slice("from:".length)
    const title = tokens.filter((token) => !token.startsWith("from:")).join(" ")
    if (title === "") return no("prs.create needs a title")
    if (fromToken !== undefined && (from === undefined || from === "")) {
      return no("prs.create's from: token needs a bookmark name — see /branches.list")
    }
    return ok({
      title,
      ...(from === undefined || from === "" ? {} : { from }),
      ...(repo === undefined ? {} : { repo })
    })
  },
  "prs.land": (args, known) => numbered(args, "prs.land needs a pull request number", known),
  "prs.review": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    const [head, verdict, ...tail] = rest.split(/\s+/)
    const number = Number(head)
    if (!Number.isInteger(number) || number <= 0) return no("prs.review needs a pull request number")
    const type = verdict === "approve"
      ? "approve"
      : verdict === "request-changes"
      ? "request_changes"
      : verdict === "comment"
      ? "comment"
      : undefined
    if (type === undefined) {
      return no("prs.review needs a verdict: approve, request-changes, or comment")
    }
    const text = tail.join(" ").trim()
    return ok(repo === undefined ? { number, verdict: type, text } : { number, verdict: type, text, repo })
  },
  "billing.upgrade": (args) => optional("plan", args),
  "env.view": (args) => repoOnly("env.view", args),
  "env.set": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    if (rest === "") return no("env.set needs a NAME=value pair")
    return ok(repo === undefined ? { assignment: rest } : { assignment: rest, repo })
  },
  "secrets.list": (args) => repoOnly("secrets.list", args),
  /*
   * The palette flows (Search and Command Palette Spec 2026-09-07 §6): the
   * whole line is the query, qualifiers included (`retry section:tried`);
   * the seam reads them in the mode's own grammar. Only search.open takes
   * a flag, `--kinds a,b`, and only it may run with no query at all.
   */
  "search.open": (args) => {
    const tokens = tokensOf(args)
    const at = tokens.indexOf("--kinds")
    const kinds = at === -1 ? undefined : tokens[at + 1]
    const query = tokens.filter((_, index) => at === -1 || (index !== at && index !== at + 1)).join(" ")
    return ok({ ...(query === "" ? {} : { query }), ...(kinds === undefined ? {} : { kinds }) })
  },
  "search.files": (args) => required("query", args, "search.files needs a query"),
  "search.symbols": (args) => required("query", args, "search.symbols needs a query"),
  "search.text": (args) => required("query", args, "search.text needs a query"),
  "search.flows": (args) => required("query", args, "search.flows needs a query"),
  "search.targets": (args) => required("query", args, "search.targets needs a query"),
  "search.wiki": (args) => required("query", args, "search.wiki needs a query"),
  "search.history": (args) => required("query", args, "search.history needs a query"),
  "search.runs": (args) => required("query", args, "search.runs needs a query"),
  "search.changes": (args) => required("query", args, "search.changes needs a query"),
  "search.issues": (args) => required("query", args, "search.issues needs a query"),
  "search.boxes": (args) => required("query", args, "search.boxes needs a query"),
  "search.secrets": (args) => required("query", args, "search.secrets needs a query"),
  "search.people": (args) => required("query", args, "search.people needs a query"),
  "onboarding.act": (args) => {
    const [action = "next", ...rest] = trimmed(args).split(" ")
    const raw = rest.join(" ")
    if (raw.startsWith('"')) {
      try { const value: unknown = JSON.parse(raw); return typeof value === "string" ? ok({ action, value }) : no("Expected text") }
      catch { return no("Expected a quoted text value") }
    }
    return ok({ action, value: raw })
  },
  "palette.open": (args) => optional("prefix", args),
  "palette.actions": (args) => required("ref", args, "palette.actions needs an item ref"),
  "history.show": (args) => repoOnly("history.show", args),
  "history.bootstrap": (args) => repoOnly("history.bootstrap", args),
  "history.amend": (args) => repoOnly("history.amend", args),
  "history.fold": (args) => repoOnly("history.fold", args),
  "branches.list": (args) => repoOnly("branches.list", args),
  /*
   * Lane citc: the workspace flows. An id is always one token; fork's and
   * snapshot's optional name is the rest of the line; template's name is one
   * token (a slug), with the workspace id trailing it.
   */
  "workspace.list": (args) => repoOnly("workspace.list", args),
  "workspace.open": (args, known) => {
    /*
     * ADR 0002: the kind IS the choice, so it rides the line as `--kind
     * <container|vm|desktop>` wherever the caller put it — the card's three
     * buttons append it, a human may type it anywhere. Everything left after
     * it is the bookmark and the optional trailing owner/repo.
     */
    const flagged = /(?:^|\s)--kind(?:\s+(\S+))?/.exec(args ?? "")
    if (flagged !== null && (flagged[1] === undefined || !KINDS.includes(flagged[1]))) {
      return no("workspace.open's kind must be container, vm, or desktop")
    }
    const kind = flagged?.[1]
    const line = flagged === null ? args : (args ?? "").replace(flagged[0], " ")
    const { rest, repo } = splitTrailingRepo(line, known)
    const bookmark = rest.trim()
    if (/\s/.test(bookmark)) return no("workspace.open takes a bookmark and optionally an owner/repo")
    return ok({
      ...(bookmark === "" ? {} : { bookmark }),
      ...(repo === undefined ? {} : { repo }),
      ...(kind === undefined ? {} : { kind })
    })
  },
  "workspace.view": (args) => required("workspaceId", args, "workspace.view needs a workspace id"),
  "workspace.terminal": (args) => optional("workspaceId", args),
  "workspace.suspend": (args) => optional("workspaceId", args),
  "workspace.resume": (args) => optional("workspaceId", args),
  "workspace.fork": (args) => {
    const [workspaceId, ...rest] = tokensOf(args)
    const name = rest.join(" ").trim()
    return ok({
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(name === "" ? {} : { name })
    })
  },
  "workspace.snapshot": (args) => {
    const [workspaceId, ...rest] = tokensOf(args)
    const name = rest.join(" ").trim()
    return ok({
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(name === "" ? {} : { name })
    })
  },
  "workspace.snapshot.delete": (args) => {
    const [snapshotId, workspaceId, ...rest] = tokensOf(args)
    if (snapshotId === undefined) return no("workspace.snapshot.delete needs a snapshot id")
    if (rest.length > 0) return no("workspace.snapshot.delete takes a snapshot id and optionally a workspace id")
    return ok(workspaceId === undefined ? { snapshotId } : { snapshotId, workspaceId })
  },
  "workspace.snapshot.fork": (args) => {
    const [snapshotId, workspaceId, ...rest] = tokensOf(args)
    if (snapshotId === undefined) return no("workspace.snapshot.fork needs a snapshot id")
    if (rest.length > 0) return no("workspace.snapshot.fork takes a snapshot id and optionally a workspace id")
    return ok(workspaceId === undefined ? { snapshotId } : { snapshotId, workspaceId })
  },
  "workspace.template": (args) => {
    /*
     * Two spellings: `<snapshotId> <one-word-name> [workspaceId]`, and
     * `<snapshotId> [workspaceId] --name <the rest of the line>` for a
     * multi-word name (the Snapshots facet's button emits the second, since a
     * snapshot's own name may carry spaces).
     */
    const tokens = tokensOf(args)
    const flag = tokens.indexOf("--name")
    const positional = flag === -1 ? tokens : tokens.slice(0, flag)
    const flagged = flag === -1 ? undefined : tokens.slice(flag + 1).join(" ").trim()
    const [snapshotId, second, third, ...rest] = positional
    if (flagged !== undefined) {
      if (snapshotId === undefined || flagged === "") {
        return no("workspace.template needs a snapshot id and a name: /workspace.template <snapshotId> [workspaceId] --name <name>")
      }
      if (third !== undefined || rest.length > 0) return no("workspace.template takes a snapshot id, optionally a workspace id, then --name <name>")
      return ok(second === undefined ? { snapshotId, name: flagged } : { snapshotId, name: flagged, workspaceId: second })
    }
    if (snapshotId === undefined || second === undefined) {
      return no("workspace.template needs a snapshot id and a name: /workspace.template <snapshotId> <name> [workspaceId]")
    }
    if (rest.length > 0) return no("workspace.template takes a snapshot id, a one-word name, and optionally a workspace id (use --name for a multi-word name)")
    return ok(third === undefined ? { snapshotId, name: second } : { snapshotId, name: second, workspaceId: third })
  },
  "workspace.sessions": (args) => optional("workspaceId", args),
  "workspace.session.destroy": (args) => {
    const [sessionId, workspaceId, ...rest] = tokensOf(args)
    if (sessionId === undefined) return no("workspace.session.destroy needs a session id")
    if (rest.length > 0) return no("workspace.session.destroy takes a session id and optionally a workspace id")
    return ok(workspaceId === undefined ? { sessionId } : { sessionId, workspaceId })
  },
  "workspace.delete": (args) => {
    /* `<workspaceId> <name>`: the name typed back is required; the card sends the draft the user typed. */
    const [workspaceId, ...rest] = tokensOf(args)
    if (workspaceId === undefined) return no("workspace.delete needs a workspace id and its name typed back: /workspace.delete <workspaceId> <name>")
    const confirmName = rest.join(" ").trim()
    if (confirmName === "") return no(`workspace.delete needs the workspace's name typed back: /workspace.delete ${workspaceId} <name>`)
    return ok({ workspaceId, confirmName })
  },
  "workspace.facet": (args) => {
    const [workspaceId, facet, ...rest] = tokensOf(args)
    if (workspaceId === undefined || facet === undefined || rest.length > 0) {
      return no("workspace.facet takes a workspace id and a facet")
    }
    return ok({ workspaceId, facet })
  },
  /*
   * Lane L3: the facet reads. A path is one token (plue's own listing refuses
   * a name with a separator in it), so the workspace id, when given, trails
   * it; the egress cursor is plue's opaque base64 keyset position and trails
   * the workspace id.
   */
  "workspace.files": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const [path, workspaceId, ...rest] = parsed.tokens
    if (rest.length > 0) return no("workspace.files takes a path and optionally a workspace id")
    return ok({
      ...(path === undefined ? {} : { path }),
      ...(workspaceId === undefined ? {} : { workspaceId })
    })
  },
  "workspace.file": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const [path, workspaceId, ...rest] = parsed.tokens
    if (path === undefined) return no("workspace.file needs a path: /workspace.file <path> [workspaceId]")
    if (rest.length > 0) return no("workspace.file takes a path and optionally a workspace id")
    return ok(workspaceId === undefined ? { path } : { path, workspaceId })
  },
  "workspace.services": (args) => optional("workspaceId", args),
  /* Lane L3b: the desktop mints a credential, so it is always addressed by id. */
  "workspace.desktop": (args) => required("workspaceId", args, "workspace.desktop needs a workspace id"),
  "workspace.desktop.rotate": (args) =>
    required("workspaceId", args, "workspace.desktop.rotate needs a workspace id"),
  "workspace.images": (args) => repoOnly("workspace.images", args),
  "workspace.egress": (args) => {
    const [workspaceId, cursor, ...rest] = tokensOf(args)
    if (rest.length > 0) return no("workspace.egress takes a workspace id and optionally a page cursor")
    return ok({
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(cursor === undefined ? {} : { cursor })
    })
  },
  "egress.session": (args) => {
    const [sessionId, repo, cursor, ...rest] = tokensOf(args)
    if (sessionId === undefined) return no("egress.session needs an agent session id")
    if (rest.length > 0) return no("egress.session takes a session id, optionally an owner/repo, then a page cursor")
    return ok({
      sessionId,
      ...(repo === undefined ? {} : { repo }),
      ...(cursor === undefined ? {} : { cursor })
    })
  },
  /* Lane change: a change id is one token; the pins and the path trail it. */
  "change.view": (args) => {
    const [changeId, rev, ...rest] = tokensOf(args)
    if (changeId === undefined) return no("change.view needs a change id")
    if (rest.length > 0) return no("change.view takes a change id and optionally a revision number")
    if (rev === undefined) return ok({ changeId })
    const seq = Number(rev)
    if (!Number.isInteger(seq) || seq <= 0) return no("change.view's revision is a positive number")
    return ok({ changeId, rev: seq })
  },
  "change.diff": (args) => {
    const [changeId, from, to] = tokensOf(args)
    if (changeId === undefined) return no("change.diff needs a change id")
    /* The path is the REST of the line: a file's path may hold a space, and neither pin ever does. */
    const path = restAfter(args, 3)
    return ok({
      changeId,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(path === "" ? {} : { path })
    })
  },
  "change.land": (args) => required("changeId", args, "change.land needs a change id"),
  "change.split-ready": (args) => required("changeId", args, "change.split-ready needs a change id"),
  /* plue#489 splits by PATH, and refuses an empty list — so at least one path is the grammar. */
  "change.split": (args) => {
    const [changeId, ...paths] = tokensOf(args)
    if (changeId === undefined || paths.length === 0) {
      return no("change.split takes a change id and at least one path to move")
    }
    return ok({ changeId, paths })
  },
  "change.resolve": (args) => {
    const [changeId] = tokensOf(args)
    /* The conflicted file's path is the rest of the line, so a path with a space resolves too. */
    const path = restAfter(args, 1)
    if (changeId === undefined || path === "") {
      return no("change.resolve takes a change id and the conflicted file's path")
    }
    return ok({ changeId, path })
  },
  "change.revert": (args) => required("changeId", args, "change.revert needs a change id"),
  "change.facet": (args) => {
    const [changeId, facet, ...rest] = tokensOf(args)
    if (changeId === undefined || facet === undefined || rest.length > 0) {
      return no("change.facet takes a change id and a facet")
    }
    return ok({ changeId, facet })
  },
  /* Lane L1: the pins and pickers are tokens; a thread or finding id is a positive number after the change id. */
  "change.pins": (args) => {
    const [changeId, from, to, ...rest] = tokensOf(args)
    if (changeId === undefined || from === undefined || to === undefined || rest.length > 0) {
      return no("change.pins takes a change id and two pins: parent|<rev> and <rev>|current")
    }
    return ok({ changeId, from, to })
  },
  "change.checks": (args) => {
    const [changeId, seq, ...rest] = tokensOf(args)
    const number = Number(seq)
    if (changeId === undefined || seq === undefined || rest.length > 0 || !Number.isInteger(number) || number <= 0) {
      return no("change.checks takes a change id and a revision number")
    }
    return ok({ changeId, seq: number })
  },
  "change.open-computer": (args) => {
    const [changeId, snapshotId, ...rest] = tokensOf(args)
    if (changeId === undefined || snapshotId === undefined || rest.length > 0) {
      return no("change.open-computer takes a change id and the revision's snapshot id")
    }
    return ok({ changeId, snapshotId })
  },
  "review.since-mine": (args) => required("changeId", args, "review.since-mine needs a change id"),
  "review.done": (args) => numberedChangeRef("review.done", "threadId", "a thread id", args),
  "review.ack": (args) => numberedChangeRef("review.ack", "threadId", "a thread id", args),
  "review.reopen": (args) => numberedChangeRef("review.reopen", "threadId", "a thread id", args),
  /* plue#488: a login, or `agent:<name>` for a named agent — the seam sends whichever the wire expects. */
  "review.request": (args) => {
    const [changeId, reviewer, ...rest] = tokensOf(args)
    if (changeId === undefined || reviewer === undefined || rest.length > 0) {
      return no("review.request takes a change id and a login (or agent:<name>)")
    }
    return ok({ changeId, reviewer })
  },
  "review.unrequest": (args) => numberedChangeRef("review.unrequest", "requestId", "a review-request id", args),
  "findings.please-fix": (args) => numberedChangeRef("findings.please-fix", "findingId", "a finding id", args),
  "findings.not-useful": (args) => numberedChangeRef("findings.not-useful", "findingId", "a finding id", args),
  "files.list": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const tokens = parsed.tokens
    if (tokens.length > 2) return no("files.list takes a path and optionally an owner/repo")
    const [path, repo] = tokens
    return ok(repo === undefined ? { path: path ?? "" } : { path: path ?? "", repo })
  },
  /*
   * The line anchor (docs/code-intel/PLAN.md §1): `<path>[:<line>[:<col>]]`.
   * Only a TRAILING numeric suffix comes off the token, so a repository path
   * with a colon of its own keeps working; the parser stays first-token-is-path.
   */
  "files.read": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const tokens = parsed.tokens
    const [token, repo] = tokens
    if (token === undefined) return no("files.read needs a file path")
    if (tokens.length > 2) return no("files.read takes a path and optionally an owner/repo")
    const anchor = /^(.*?):(\d+)(?::(\d+))?$/.exec(token)
    const path = anchor === null ? token : anchor[1] ?? ""
    if (path === "") return no("files.read needs a file path")
    const line = anchor === null ? undefined : Number(anchor[2])
    const column = anchor?.[3] === undefined ? undefined : Number(anchor[3])
    if (line === 0 || column === 0) return no("files.read lines and columns count from 1: /files.read <path>[:<line>[:<col>]]")
    return ok({
      path,
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      ...(repo === undefined ? {} : { repo })
    })
  },
  /* Code intelligence (docs/code-intel/PLAN.md §4): a position for hover and definition, a path for diagnostics. */
  "code.hover": (args) => positioned("code.hover", args),
  "code.definition": (args) => positioned("code.definition", args),
  "code.diagnostics": (args) => {
    const parsed = parseFileArgs(args)
    if ("error" in parsed) return parsed
    const tokens = parsed.tokens
    const [path, repo] = tokens
    if (path === undefined) return no("code.diagnostics needs a file path: /code.diagnostics <path> [owner/repo]")
    if (tokens.length > 2) return no("code.diagnostics takes a path and optionally an owner/repo")
    return ok(repo === undefined ? { path } : { path, repo })
  },
  "repos.app": (args) => repoOnly("repos.app", args),
  /* Lane sync (ADR 0005): Linear and GitHub sync as actions. */
  "github.app": (args) => repoOnly("github.app", args),
  "github.app.open": (args) => repoOnly("github.app.open", args),
  "github.reconcile": (args) => repoOnly("github.reconcile", args),
  "github.mirror-sync": (args) => repoOnly("github.mirror-sync", args),
  /* plue#491: the ref name is one token (it carries slashes) with the usual optional trailing repo. */
  "github.mirror.retry-ref": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    if (rest === "" || /\s/.test(rest)) return no("github.mirror.retry-ref needs one ref name")
    return ok(repo === undefined ? { ref: rest } : { ref: rest, repo })
  },
  "repos.import.retry": (args) => required("jobId", args, "repos.import.retry needs the job id"),
  "linear.connect": (args) => repoOnly("linear.connect", args),
  "linear.connect.open": (args) => repoOnly("linear.connect.open", args),
  "linear.connect.confirm": (args) => repoOnly("linear.connect.confirm", args),
  "linear.connect.team": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    if (rest === "" || /\s/.test(rest)) return no("linear.connect.team needs the team id")
    return ok(repo === undefined ? { teamId: rest } : { teamId: rest, repo })
  },
  "linear.connect.repo": (args) => {
    const tokens = tokensOf(args)
    const [cardRepo, repo] = tokens
    if (cardRepo === undefined || repo === undefined || tokens.length > 2) {
      return no("linear.connect.repo needs the card's repository and the picked owner/repo")
    }
    return ok({ cardRepo, repo })
  },
  "linear.sync": (args) => optional("integration", args),
  "linear.activity": (args) => optional("integration", args),
  "linear.disconnect": (args) => {
    /* `<integration> <teamKey>`: the key typed back confirms; without it the seam names the exact invocation. */
    const tokens = tokensOf(args)
    const [integration, confirmKey] = tokens
    if (integration === undefined) return no("linear.disconnect needs an integration: /linear.disconnect <id|team> <teamKey>")
    if (tokens.length > 2) return no("linear.disconnect takes an integration and its team key typed back")
    return ok(confirmKey === undefined ? { integration } : { integration, confirmKey })
  },
  "sync.retry": (args) => required("opId", args, "sync.retry needs an op id"),
  "sync.ops.show-more": (args) => required("cardId", args, "sync.ops.show-more needs the card id"),
  "sync.ops.load-older": (args) => required("cardId", args, "sync.ops.load-older needs the card id"),
  "issues.link-linear": (args, known) => {
    const { rest, repo } = splitTrailingRepo(args, known)
    const [head, identifier, ...extra] = rest.split(/\s+/)
    const number = Number(head)
    if (!Number.isInteger(number) || number <= 0) return no("issues.link-linear needs an issue number")
    if (identifier === undefined || identifier === "" || extra.length > 0) {
      return no("issues.link-linear needs the Linear identifier: /issues.link-linear <n> <identifier>")
    }
    return ok(repo === undefined ? { number, identifier } : { number, identifier, repo })
  },
  "issues.unlink-linear": (args, known) => {
    /* `<n> <identifier> [owner/repo]`: the identifier typed back confirms; without it the seam names the exact invocation. */
    const { rest, repo } = splitTrailingRepo(args, known)
    const [head, identifier, ...extra] = rest.split(/\s+/)
    const number = Number(head)
    if (!Number.isInteger(number) || number <= 0) return no("issues.unlink-linear needs an issue number")
    if (extra.length > 0) return no("issues.unlink-linear takes an issue number, its Linear identifier typed back, and optionally an owner/repo")
    const confirmed = identifier === undefined || identifier === "" ? {} : { identifier }
    return ok(repo === undefined ? { number, ...confirmed } : { number, ...confirmed, repo })
  },
  "debug.backend": (args) => ok({ backend: args ?? "" }),
  "admin.allowlist.add": (args) => required("login", args, "admin.allowlist.add needs a login"),
  "admin.allowlist.remove": (args) => required("login", args, "admin.allowlist.remove needs a login"),
  "admin.grant": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length > 2) return no("admin.grant takes an amount in dollars and a login")
    const [amountRaw, login] = tokens
    const amountUsd = Number(amountRaw)
    if (
      amountRaw === undefined ||
      !Number.isFinite(amountUsd) ||
      amountUsd <= 0 ||
      login === undefined ||
      login === ""
    ) {
      return no("admin.grant needs an amount in dollars and a login: /admin.grant 25 octocat")
    }
    return ok({ amountUsd, login })
  },
  "admin.grant.confirm": (args) => required("cardId", args, "admin.grant.confirm needs the card id"),
  "admin.grant.cancel": (args) => required("cardId", args, "admin.grant.cancel needs the card id"),
  "admin.queue.approve": (args) => required("login", args, "admin.queue.approve needs a login"),
  /* `[cwd]`: an OPEN working copy by path, id, name, or key; blank means the active one (the server never takes a bare path). */
  "tab.terminal": (args) => optional("cwd", args),
  "tab.harness": (args) => required("harnessId", args, "tab.harness needs a harness id"),
  "agent.role": (args) => required("roleId", args, "agent.role needs a role id"),
  "agent.delegate": (args) => {
    const [roleId, ...rest] = tokensOf(args)
    const task = trimmed(args).slice(roleId?.length ?? 0).trim()
    if (roleId === undefined || rest.length === 0) {
      return no("agent.delegate needs a role and a task: /agent.delegate implementation add a retry to the fetch")
    }
    return ok({ roleId, task })
  },
  "agent.explain": (args) => required("what", args, "agent.explain needs something to explain: /agent.explain <what>"),
  /*
   * Agents as data (custom-agents.md). `agent.new` takes its prefill
   * positionally; `agent.create` needs the three that define an agent, the
   * purpose is the rest of the line; `agent.edit` reads `--model`,
   * `--purpose`, `--label` anywhere on the line, each value running to the
   * next flag.
   */
  "agent.new": (args) => {
    const [id, harness, model, ...rest] = tokensOf(args)
    const purpose = rest.join(" ").trim()
    return ok({
      ...(id === undefined ? {} : { id }),
      ...(harness === undefined ? {} : { harness }),
      ...(model === undefined ? {} : { model }),
      ...(purpose === "" ? {} : { purpose })
    })
  },
  /* THE FORM LAW: the generic form card's acts. `form.set`'s value is the rest of the line (blank clears). */
  "form.set": (args) => {
    const [cardId, field, ...rest] = tokensOf(args)
    if (cardId === undefined) return no("form.set needs the card id")
    if (field === undefined) return no("form.set needs the field name")
    const value = trimmed(args).slice(cardId.length).trim().slice(field.length).trim()
    return ok({ cardId, field, value: rest.length === 0 ? "" : value })
  },
  "form.submit": (args) => required("cardId", args, "form.submit needs the card id"),
  "agent.create": (args) => {
    const [id, harness, model, ...rest] = tokensOf(args)
    if (id === undefined || harness === undefined || model === undefined) {
      return no("agent.create needs an id, a harness, and a model: /agent.create reviewer codex gpt-5.6-terra Reviews diffs")
    }
    const purpose = rest.join(" ").trim()
    return ok(purpose === "" ? { id, harness, model } : { id, harness, model, purpose })
  },
  "agent.edit": (args) => {
    const [id, ...rest] = tokensOf(args)
    if (id === undefined) return no("agent.edit needs an agent id: /agent.edit <id> [--model <id>] [--purpose <text>] [--label <name>]")
    const payload: Record<string, string> = { id }
    let current: "model" | "purpose" | "label" | undefined
    for (const token of rest) {
      if (token === "--model" || token === "--purpose" || token === "--label") {
        current = token.slice(2) as "model" | "purpose" | "label"
        payload[current] = ""
        continue
      }
      if (current === undefined) return no("agent.edit takes an id then --model, --purpose, or --label")
      payload[current] = payload[current] === "" ? token : `${payload[current]} ${token}`
    }
    if (payload["model"] === "") return no("agent.edit's --model needs a model id")
    if (payload["label"] === "") return no("agent.edit's --label needs a name")
    return ok(payload)
  },
  "agent.remove": (args) => required("id", args, "agent.remove needs an agent id"),
  "agent.models": (args) => required("harness", args, "agent.models needs a harness id: /agent.models opencode"),
  "tab.card": (args) => required("cardId", args, "tab.card needs the card id"),
  "tab.select": (args) => required("tab", args, "tab.select needs a tab id or a position 1-9"),
  "tab.read": (args) => required("tab", args, "tab.read needs a tab id"),
  "tab.close": (args) => optional("tabId", args),
  "tab.menu": (args) => optional("repo", args),
  "repo.select": (args) => required("repo", args, "repo.select needs a pinned repository key"),
  "repo.unpin": (args) => required("repo", args, "repo.unpin needs a pinned repository key"),
  /* `<copyId>[#path]`: the tree row's own id, split at the first `#` (a copy id never carries one; a path may have spaces). */
  "repo.tree": (args) => {
    const text = trimmed(args)
    if (text === "") return no("repo.tree needs a working copy id: /repo.tree <copyId>[#path]")
    const hash = text.indexOf("#")
    if (hash === -1) return ok({ copy: text })
    const copy = text.slice(0, hash).trim()
    const path = text.slice(hash + 1).trim()
    if (copy === "") return no("repo.tree needs a working copy id: /repo.tree <copyId>[#path]")
    return ok(path === "" ? { copy } : { copy, path })
  },
  "workspace.rename": (args) => required("name", args, "workspace.rename needs a name: /workspace.rename <name>"),
  /* `[path]`: a typed path opens directly (where the host allows one); blank is the folder dialog, the human's door alone. */
  "repo.open": (args) => optional("path", args),
  "target.run": (args) => targetRef("target.run", args),
  "target.open": (args) => targetRef("target.open", args),
  /* `<repoId> [workspace] <verb> <pattern>`: the last two tokens are the run; anything between is the workspace path. */
  "target.run.pattern": (args) => {
    const tokens = tokensOf(args)
    const [repoId] = tokens
    if (repoId === undefined || tokens.length < 3) {
      return no("target.run.pattern needs a repository id, a verb, and a pattern")
    }
    const pattern = tokens[tokens.length - 1]!
    const verb = tokens[tokens.length - 2]!
    const workspace = tokens.slice(1, -2).join(" ")
    return ok(workspace === "" ? { repoId, verb, pattern } : { repoId, workspace, verb, pattern })
  },
  /* `<repoId> key=value…`: every facet is optional; a bare value with no `=` is the query. */
  "target.filter": (args) => {
    const [repoId, ...rest] = tokensOf(args)
    if (repoId === undefined) return no("target.filter needs a repository id")
    const payload: Record<string, string> = { repoId }
    const query: Array<string> = []
    for (const token of rest) {
      const split = /^(mode|query|kind|state|workspace)=(.*)$/.exec(token)
      if (split === null) query.push(token)
      else payload[split[1]!] = split[2]!
    }
    if (query.length > 0) payload["query"] = [payload["query"] ?? "", ...query].join(" ").trim()
    return ok(payload)
  },
  "target.select": (args) => {
    const [repoId, ...rest] = tokensOf(args)
    if (repoId === undefined) return no("target.select needs a repository id")
    return ok(rest.length === 0 ? { repoId } : { repoId, label: rest.join(" ") })
  },
  "target.star": (args) => starRef("target.star", args),
  "target.unstar": (args) => starRef("target.unstar", args),
  "target.expand": (args) => groupRef("target.expand", args),
  "target.run.set": (args) => groupRef("target.run.set", args),
  "target.pick": (args) => {
    const [repoId, group, ...rest] = tokensOf(args)
    if (repoId === undefined) return no("target.pick needs a repository id")
    if (group === undefined) return no("target.pick needs a group label")
    const member = rest.join(" ").trim()
    if (member === "") return no("target.pick needs a member label, all, or none")
    return ok({ repoId, group, member })
  },
  /*
   * The target-graph commands (docs/LOCAL-APP.md "Cards: target graph"). The
   * repo id may go unnamed — the controller resolves the one open repository
   * — so a lone `//…` token is the LABEL, anything else the repo id.
   */
  "target.graph": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length === 0) return ok({})
    if (tokens.length === 1) {
      const [only] = tokens
      return only !== undefined && only.startsWith("//") ? ok({ label: only }) : ok({ repoId: only })
    }
    const [repoId, ...rest] = tokens
    return ok({ repoId, label: rest.join(" ") })
  },
  /* Same shape as target.graph: a lone `//…` token is the label to pin, none clears the focus. */
  "target.graph.focus": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length === 0) return ok({})
    if (tokens.length === 1) {
      const [only] = tokens
      return only !== undefined && only.startsWith("//") ? ok({ label: only }) : ok({ repoId: only })
    }
    const [repoId, ...rest] = tokens
    return ok({ repoId, label: rest.join(" ") })
  },
  /* `<repoId> [query=…] [private=on|off]`: a bare token with no `=` is the query. */
  "target.graph.filter": (args) => {
    const [repoId, ...rest] = tokensOf(args)
    if (repoId === undefined) return no("target.graph.filter needs a repository id")
    const payload: Record<string, string> = { repoId }
    const query: Array<string> = []
    for (const token of rest) {
      const split = /^(query|private)=(.*)$/.exec(token)
      if (split === null) query.push(token)
      else payload[split[1]!] = split[2]!
    }
    if (query.length > 0) payload["query"] = [payload["query"] ?? "", ...query].join(" ").trim()
    return ok(payload)
  },
  "target.timeline": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length > 2) return no("target.timeline takes a run id and optionally a repository id")
    const [first, second] = tokens
    if (first === undefined) return ok({})
    return second === undefined ? ok({ runId: first }) : ok({ repoId: first, runId: second })
  },
  "target.list": (args) => optional("repoId", args),
  "target.history": (args) => optional("repoId", args),
  "target.affected": (args) => optional("repoId", args),
  "target.ci": (args) => optional("repoId", args),
  "target.runs.select": (args) => {
    const tokens = tokensOf(args)
    if (tokens.length > 2) return no("target.runs.select takes a run id and optionally a repository id")
    const [first, second] = tokens
    if (first === undefined) return no("target.runs.select needs a run id")
    return second === undefined ? ok({ runId: first }) : ok({ repoId: first, runId: second })
  },
  "target.run.scrub": (args) => {
    const [runId, cursorRaw] = tokensOf(args)
    const cursor = Number(cursorRaw)
    if (runId === undefined || cursorRaw === undefined || !Number.isFinite(cursor)) {
      return no("target.run.scrub needs a run id and a cursor (epoch ms)")
    }
    return ok({ runId, cursor })
  },
  "target.source.open": (args) => {
    const [repoId, file] = tokensOf(args)
    if (repoId === undefined || file === undefined) return no("target.source.open needs a repository id and a file")
    return ok({ repoId, file })
  }
}

/**
 * Whether a decoder for this flow exists in the table above.
 *
 * The gate in SlashPayload.test.ts reads it: a declaration that takes
 * arguments and names no decoder here (and carries none as
 * `metadata.grammar`) would silently decode to the EMPTY payload, discarding
 * what the human typed — the drift `triggers.register` shipped with.
 *
 * @category conversions
 */
export const hasGrammar = (name: string): boolean => GRAMMAR[name] !== undefined

/**
 * Turns one flow's slash argument text into its typed payload.
 *
 * @category conversions
 */
export const payloadFor = (
  name: string,
  args: string | undefined,
  grammar?: Grammar,
  known?: KnownRepositories
): Parsed => {
  const parse = GRAMMAR[name] ?? grammar
  if (parse === undefined) return NONE
  if (takesRunSource(name)) {
    const source = splitRunSource(args)
    const parsed = parse(source.args, known)
    return "payload" in parsed && source.sourceCard !== undefined ? ok({ ...parsed.payload, sourceCard: source.sourceCard }) : parsed
  }
  return parse(args, known)
}

/**
 * The grammar of a flow declared at runtime that takes only its optional
 * `owner/repo` target (a repository's flow leaf, entries/flow.ts): the table
 * above cannot name it, so the flow carries this as `metadata.grammar`.
 */
export const repoTargetGrammar = (name: string): Grammar => (args) => repoOnly(name, args)
