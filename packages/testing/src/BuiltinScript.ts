/**
 * A scripted model for the built-in flows a Smithers install runs: a TODO's
 * coding run, the stack's review of its pull request, a conflict resolution,
 * `/review`, and the wiki review.
 *
 * A test of an install drives a TODO through its states: Working, Needs you,
 * failed checks, a repaired attempt, In review. A recording replays one real
 * run, but no real model asks a question, breaks the build once, or waits on
 * cue. This script does, on purpose and on every run. Each turn is recognized
 * by its step's own system teaching and answered with one cell that settles
 * the step's declared output: the plan names one file, the edit appends a
 * greeting to it, the review approves, and the judge routes the TODO to
 * implement and finds every result sound.
 *
 * The test steers a TODO with {@link Directives}, written into the TODO's
 * prompt by {@link tag}. The prompt is the one channel an out-of-process test
 * has into the model, so a directive travels as a bracketed tag such as
 * `[ASK]` or `[HOLD t2]`; ordinary prose never sets one.
 *
 * `smthrs-model-server --script builtin` serves it over HTTP.
 *
 * @since 1.0.0
 */

import * as Evaluator from "@smthrs/model/Evaluator"
import type { ModelRequest } from "@smthrs/model/ModelRequest"
import { Effect } from "effect"
import * as ScriptedModel from "./ScriptedModel.vibe"

/**
 * How a TODO's prompt steers its scripted run.
 *
 * @category models
 * @since 1.0.0
 */
export interface Directives {
  /** The request review asks {@link QUESTION} first, so the TODO needs you; the edit writes the answer. */
  readonly ask?: boolean | undefined
  /** The edit empties `JOURNEY.md`, so a check that reads it fails, until a later message says `fixed`. */
  readonly fail?: boolean | undefined
  /**
   * The first edit leaves `JOURNEY.md` one blank line: `test -s` passes and
   * `grep -q .` fails its first attempt. The repair restores the file, so the
   * second attempt passes in the same run.
   */
  readonly failOnce?: boolean | undefined
  /** The edit also appends a line to `JOURNEY.md`; the repair of `failOnce` sets it. */
  readonly restore?: boolean | undefined
  /** Ends `fail` and `failOnce`, from a steer, an answer or retry feedback. */
  readonly fixed?: boolean | undefined
  /** The edit turn waits on this `TurnGate` key until the test releases it. */
  readonly hold?: string | undefined
  /** A conflict turn on this TODO's file gives up instead of resolving it. */
  readonly noResolve?: boolean | undefined
  /** The edit appends to this path instead of `JOURNEY.md`. */
  readonly file?: string | undefined
  /** The edit writes only `.smithers/flows/todo/flow.ts`: the TODO flow plus {@link CHANGELOG_STEP}. */
  readonly flowEdit?: boolean | undefined
  /** The edit also appends one line to `CHANGELOG.md`. */
  readonly changelog?: boolean | undefined
  /** Before writing, the edit runs `id -u` and refuses unless the coding tools run as this uid. */
  readonly observeUid?: number | undefined
  /** The pull request review tries `write` and `bash` and approves only when both are refused. */
  readonly probeReview?: boolean | undefined
}

const flags = {
  ask: "ASK",
  fail: "FAIL",
  failOnce: "FAILONCE",
  restore: "RESTORE",
  fixed: "FIXED",
  noResolve: "NORESOLVE",
  flowEdit: "FLOWEDIT",
  changelog: "CHANGELOG",
  probeReview: "PROBEREVIEW"
} as const

const key = /^[A-Za-z0-9._-]+$/
const path = /^[A-Za-z0-9._/-]+$/

/**
 * The prompt text that carries `directives`: one bracketed tag each.
 *
 * @throws Error when a hold key, a file path or a uid cannot be written as a tag.
 * @category constructors
 * @since 1.0.0
 */
export const tag = (directives: Directives): string => {
  const tags: Array<string> = []
  for (const [name, word] of Object.entries(flags)) {
    if (directives[name as keyof typeof flags] === true) tags.push(`[${word}]`)
  }
  if (directives.hold !== undefined) {
    if (!key.test(directives.hold)) {
      throw new Error(`hold key ${JSON.stringify(directives.hold)} is not [A-Za-z0-9._-]+`)
    }
    tags.push(`[HOLD ${directives.hold}]`)
  }
  if (directives.file !== undefined) {
    if (!path.test(directives.file)) throw new Error(`file ${JSON.stringify(directives.file)} is not [A-Za-z0-9._/-]+`)
    tags.push(`[FILE ${directives.file}]`)
  }
  if (directives.observeUid !== undefined) {
    if (!Number.isInteger(directives.observeUid) || directives.observeUid < 0) {
      throw new Error(`uid ${directives.observeUid} is not a non-negative integer`)
    }
    tags.push(`[OBSERVEUID ${directives.observeUid}]`)
  }
  return tags.join(" ")
}

/**
 * The directives a text carries, as the script reads them: `fail` and
 * `failOnce` are already ended by `fixed`. A value that is not a string is
 * read as its JSON.
 *
 * @category constructors
 * @since 1.0.0
 */
export const directives = (value: unknown): Directives => {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? "")
  const has = (word: string) => raw.includes(`[${word}]`)
  const fixed = has(flags.fixed)
  const uid = /\[OBSERVEUID ([0-9]+)\]/.exec(raw)?.[1]
  return {
    ask: has(flags.ask),
    fail: has(flags.fail) && !fixed,
    failOnce: has(flags.failOnce) && !fixed,
    restore: has(flags.restore),
    fixed,
    hold: /\[HOLD ([A-Za-z0-9._-]+)\]/.exec(raw)?.[1],
    noResolve: has(flags.noResolve),
    file: /\[FILE ([A-Za-z0-9._/-]+)\]/.exec(raw)?.[1],
    flowEdit: has(flags.flowEdit),
    changelog: has(flags.changelog),
    observeUid: uid === undefined ? undefined : Number(uid),
    probeReview: has(flags.probeReview)
  }
}

/**
 * The question an `ask` TODO's request review asks.
 *
 * @category constants
 * @since 1.0.0
 */
export const QUESTION = "Which greeting should the file carry?"

/**
 * The greeting the edit appends when the options name none.
 *
 * @category constants
 * @since 1.0.0
 */
export const GREETING = "Hello from Smithers!"

/**
 * The one commit message the scripted run writes.
 *
 * @category constants
 * @since 1.0.0
 */
export const SUBJECT = "📝 docs: add a greeting to JOURNEY.md"

/**
 * The step a `flowEdit` TODO adds to every later TODO's request.
 *
 * @category constants
 * @since 1.0.0
 */
export const CHANGELOG_STEP = "[CHANGELOG] Add one line for this change to CHANGELOG.md."

/**
 * The scripted review of a TODO's pull request: `approve` on its first line.
 *
 * @category constants
 * @since 1.0.0
 */
export const REVIEW_ANSWER = "approve\n\nThe change does what the TODO asks and nothing else."

/**
 * The system teaching that names each scripted step: the script answers a
 * turn whose system text contains its step's teaching, and a conflict turn
 * whose messages contain `conflict`. A flow that rewords its teaching leaves
 * its turn unscripted, so a test of the flows asserts each one still appears.
 *
 * @category constants
 * @since 1.0.0
 */
export const teachings = {
  "coding/review-request": "Review a coding request against supplied repository memory",
  "coding/draft-plan": "Plan one linear mythical coding progression",
  "coding/edit-atom": "Implement the single atomic change",
  "coding/select-owner-repair": "Select one existing JJ atom owned by this Change to correct the supplied findings",
  "coding/review-final-history": "Clean the descriptions of the validated request",
  "coding/review-lens": "Review one implementation diff through exactly one lens",
  "review/change": "Your answer's first line is exactly `approve` or `request-changes`",
  "review/file": "You are a precise code reviewer.",
  "review/verify": "You adjudicate code-review findings against the diff",
  "wiki/review-page": "Review a repository wiki page against its exact source snapshot.",
  conflict: "Resolve the conflict in path"
} as const

/**
 * One finding the scripted `/review` reports.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReviewFinding {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly content: string
  readonly existingCode: string
  readonly severity: string
  readonly category: string
  readonly confidence: string
  /** The finding is reported when the reviewed text holds `path` and this text; `existingCode` by default. */
  readonly match?: string | undefined
  /** Why the verification turn keeps it. */
  readonly reason?: string | undefined
}

/**
 * What a builtin script is built from.
 *
 * @category models
 * @since 1.0.0
 */
export interface Options {
  /** The greeting the edit appends; {@link GREETING} by default. */
  readonly greeting?: string | undefined
  /** The source of `.smithers/flows/todo/flow.ts`, which a `flowEdit` TODO edits. Required for `flowEdit`. */
  readonly todoFlow?: string | undefined
  /**
   * Steps besides `coding/edit-atom` that hold on the TODO's `hold` key, such
   * as `coding/draft-plan` to pause a TODO while it plans.
   */
  readonly holdAt?: ReadonlyArray<string> | undefined
  /** What the scripted `/review` reports. Nothing by default. */
  readonly reviewFindings?: ReadonlyArray<ReviewFinding> | undefined
}

/**
 * A message as a Chat Completions client sends it.
 *
 * @category models
 * @since 1.0.0
 */
export interface ChatMessage {
  readonly role?: unknown
  readonly content?: unknown
}

/**
 * A built script.
 *
 * It keeps one piece of state: the directives each planned file's TODO
 * carried, so a later conflict turn on that file answers as its TODO asked.
 *
 * @category models
 * @since 1.0.0
 */
export interface BuiltinScript {
  /** The reply for a Chat Completions conversation, or `undefined` for a turn no builtin step sends. */
  readonly respond: (messages: ReadonlyArray<ChatMessage>) => ScriptedModel.Reply | undefined
  /** {@link respond} as a `ScriptedModel` script. */
  readonly script: ScriptedModel.Script
}

/** A Chat Completions message's text, whether it is a string or text parts. */
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
    ? content.map((part: unknown) =>
      typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""
    ).join("")
    : ""

type Json = any // Payloads are read structurally.

/** The JSON value that opens `raw`, when it opens with an object or array. */
const leadingJson = (raw: string): Json => {
  const text = raw.trimStart()
  if (text[0] !== "{" && text[0] !== "[") return undefined
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const c = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === "\"") quoted = false
    } else if (c === "\"") quoted = true
    else if (c === "{" || c === "[") depth++
    else if ((c === "}" || c === "]") && --depth === 0) {
      try {
        return JSON.parse(text.slice(0, index + 1))
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

const isObject = (value: unknown): value is Record<string, Json> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * The step's arguments. An agent action's task is its payload's JSON after
 * "The task for this run:" in the system context; a prompt flow renders each
 * field as a `## <field>` section under "# Arguments"; else the last user
 * message's JSON.
 */
const payloadOf = (system: string, messages: ReadonlyArray<ChatMessage>): Json => {
  const task = system.lastIndexOf("The task for this run:")
  const payload = task < 0 ? undefined : leadingJson(system.slice(task + "The task for this run:".length))
  if (isObject(payload)) return payload
  const at = system.lastIndexOf("# Arguments\n")
  if (at >= 0) {
    const parts = system.slice(at).split(/\n\n## ([^\n]+)\n\n/)
    const fields: Record<string, Json> = {}
    for (let index = 1; index + 1 < parts.length; index += 2) {
      fields[parts[index]!] = leadingJson(parts[index + 1]!) ?? parts[index + 1]!.trim()
    }
    if (Object.keys(fields).length > 0) return fields
  }
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue
    const body = textOf(message.content)
    for (const candidate of [body, body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)]) {
      try {
        const value: unknown = JSON.parse(candidate)
        if (value !== null && typeof value === "object") return value
      } catch {
        // Not JSON; try the next candidate.
      }
    }
  }
  return undefined
}

const cell = (source: string) => "```cell\n" + source + "\n```"
const done = (value: unknown) => cell(`ctx.done(${JSON.stringify(value)});`)

/** The request a planning step reads: the TODO's prompt, its feedback and the answer to its question. */
const requestOf = (payload: Json) => [payload?.input?.prompt, payload?.input?.feedback, payload?.answer]

/** A person's answer as text, whether the wait settled with a string or an object. */
const answerText = (answer: unknown): string =>
  typeof answer === "string"
    ? answer.trim()
    : isObject(answer)
    ? String(answer.answer ?? answer.text ?? JSON.stringify(answer)).trim()
    : ""

/**
 * The tags a plan writes into its atom's intent, which is all the edit turn
 * reads, so the plan's directives and the person's answer reach the edit.
 */
const intentTags = (found: Directives, answer: unknown): string =>
  [
    tag({
      fail: found.fail,
      failOnce: found.failOnce,
      hold: found.hold,
      flowEdit: found.flowEdit,
      changelog: found.changelog,
      observeUid: found.observeUid,
      file: found.file
    }),
    answerText(answer) === "" ? "" : `[ANSWER ${JSON.stringify(answerText(answer))}]`
  ].filter(Boolean).join(" ")

/** The first `{changeId, intent}` atom in a correction payload. */
const firstAtom = (value: Json): Json => {
  if (value === null || typeof value !== "object") return undefined
  if (typeof value.changeId === "string" && value.changeId !== "" && typeof value.intent === "string") return value
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = firstAtom(child)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The plan's atom intent. The coding host hands edit-atom a JSON intent whose
 * `atom` is the plan's, beside the request and the change; an `[ANSWER "…"]`
 * inside it is JSON-escaped there.
 */
const atomIntent = (intent: string): string => {
  try {
    const parsed: unknown = JSON.parse(intent)
    if (isObject(parsed) && typeof parsed.atom === "string") return parsed.atom
  } catch {
    // A plain intent.
  }
  return intent
}

const TODO_FLOW = ".smithers/flows/todo/flow.ts"

/** The TODO flow whose request also asks for the changelog step. */
const editedFlow = (source: string | undefined): string => {
  if (source === undefined) throw new Error("a flowEdit TODO needs the todoFlow option")
  const edited = source.replace(
    "Request.call(input)",
    `Request.call({ ...input, prompt: \`\${input.prompt}\\n\\n${CHANGELOG_STEP}\` })`
  )
  if (edited === source) throw new Error("the TODO flow has no Request.call(input) to edit")
  return edited
}

/** One edit cell: append the greeting (or the answer) to the file, and what the directives add. */
const editCell = (hosted: string, greeting: string, todoFlow: string | undefined): string => {
  const intent = atomIntent(hosted)
  const found = directives(intent)
  const answer = /\[ANSWER ("(?:[^"\\]|\\.)*")\]/.exec(intent)
  const line = answer === null ? greeting : `${greeting} ${JSON.parse(answer[1]!)}`
  const file = found.file ?? "JOURNEY.md"
  const writes: Array<string> = []
  const lines = [
    `const append = async (path, line) => {`,
    `  const read = await ctx.call("read", { path });`,
    `  const before = read.ok === false ? "" : String(read.content ?? "");`,
    `  const content = (before.endsWith("\\n") || before === "" ? before : before + "\\n") + line + "\\n";`,
    `  const written = await ctx.call("write", { path, content });`,
    `  if (written.ok === false) throw new Error(written.error?.message ?? "write failed");`,
    `};`,
    `const put = async (path, content) => {`,
    `  await ctx.call("read", { path });`,
    `  const written = await ctx.call("write", { path, content });`,
    `  if (written.ok === false) throw new Error(written.error?.message ?? "write failed");`,
    `};`
  ]
  if (found.observeUid !== undefined) {
    const expected = JSON.stringify(`${found.observeUid}\n`)
    lines.push("const identity = await ctx.call(\"bash\", { command: \"id -u\" });")
    lines.push(
      `if (identity.exitCode !== 0 || identity.stdout !== ${expected}) throw new Error("coding tool UID refused");`
    )
    lines.push("await put(\".outside-note-uid\", identity.stdout);")
  }
  if (found.flowEdit === true) {
    lines.push(`await put(${JSON.stringify(TODO_FLOW)}, ${JSON.stringify(editedFlow(todoFlow))});`)
    writes.push(TODO_FLOW)
  } else {
    lines.push(`await append(${JSON.stringify(file)}, ${JSON.stringify(line)});`)
    writes.push(file)
  }
  if (found.changelog === true) {
    lines.push(`await append("CHANGELOG.md", ${JSON.stringify(`- ${line}`)});`)
    writes.push("CHANGELOG.md")
  }
  if (found.fail === true) {
    // An empty JOURNEY.md fails both checks (test -s, grep -q .).
    lines.push(`await put("JOURNEY.md", "");`)
    if (!writes.includes("JOURNEY.md")) writes.push("JOURNEY.md")
  } else if (found.failOnce === true) {
    // A blank line passes test -s and fails grep -q ., which the repair restores.
    lines.push(`await put("JOURNEY.md", "\\n");`)
    if (!writes.includes("JOURNEY.md")) writes.push("JOURNEY.md")
  }
  if (found.restore === true) {
    lines.push(`await append("JOURNEY.md", ${JSON.stringify(line)});`)
    if (!writes.includes("JOURNEY.md")) writes.push("JOURNEY.md")
  }
  lines.push(
    `ctx.done(${JSON.stringify({ summary: `Appended a greeting to ${writes.join(", ")}.`, reads: writes, writes })});`
  )
  return cell(lines.join("\n"))
}

/** A conflict turn's cell: keep every side's lines, or report that it gave up. */
const resolveCell = (file: string, resolve: boolean): string =>
  resolve
    ? cell([
      `const read = await ctx.call("read", { path: ${JSON.stringify(file)} });`,
      `if (read.ok === false) throw new Error(read.error?.message ?? "read failed");`,
      `const kept = [];`,
      `let diff = false;`,
      `for (const line of String(read.content ?? "").split("\\n")) {`,
      `  if (/^(<{7}|>{7}|={7}|\\+{7}|-{7})/.test(line)) { diff = false; continue; }`,
      `  if (/^%{7}/.test(line)) { diff = true; continue; }`,
      `  if (diff && line.startsWith("-")) continue;`,
      `  kept.push(diff && (line.startsWith("+") || line.startsWith(" ")) ? line.slice(1) : line);`,
      `}`,
      `const written = await ctx.call("write", { path: ${JSON.stringify(file)}, content: kept.join("\\n") });`,
      `if (written.ok === false) throw new Error(written.error?.message ?? "write failed");`,
      `ctx.done(${
        JSON.stringify({
          summary: `Resolved the conflict in ${file} keeping both sides.`,
          reads: [file],
          writes: [file],
          resolved: true
        })
      });`
    ].join("\n"))
    : done({ summary: `Could not resolve the conflict in ${file}.`, reads: [file], writes: [], resolved: false })

/** The review cell a `probeReview` TODO's pull request gets: approve only when write and bash are refused. */
const probeCell = cell([
  "const write = await ctx.call(\"write\", { path: \"REVIEW_MUST_NOT_WRITE\", content: \"forbidden\" });",
  "if (write.ok !== false || write.error?.code !== \"capability_refused\") throw new Error(\"review write was allowed\");",
  "const exec = await ctx.call(\"bash\", { command: \"printf REVIEW_MUST_NOT_EXEC\" });",
  "if (exec.ok !== false || exec.error?.code !== \"capability_refused\") throw new Error(\"review exec was allowed\");",
  "ctx.done(\"approve\\n\\nREVIEW_BOUNDARY_TOOL_REFUSALS: write and bash refused\");"
].join("\n"))

/** The source link a wiki page writes: `](../sources/<path>#L<line>)`. */
const sourceLink = /\]\(\.\.\/sources\/([A-Za-z0-9_./@-]+)#L([1-9][0-9]*)\)/g

interface Line {
  readonly path: string
  readonly line: number
  readonly quote: string
}

/**
 * A source's visible lines as the review evidence numbers them
 * (`<n> | <text>`), each with the quote a citation may carry: the line's
 * first nonblank run between carriage returns, trimmed. Blank lines carry none.
 */
const visibleLines = (source: Json): ReadonlyArray<Line> =>
  String(source?.lines ?? "").split("\n").flatMap((entry) => {
    const numbered = /^(\d+) \| (.*)$/s.exec(entry)
    const quote = numbered?.[2]!.split("\r").map((part) => part.trim()).find(Boolean)
    return quote === undefined ? [] : [{ path: String(source.path), line: Number(numbered![1]), quote }]
  })

/**
 * The wiki review. Its task carries the page's review evidence: the spec, the
 * heading sections and each source's visible lines. A section is supported by
 * exact visible lines, and a current page never by its own document alone:
 * every line it links; else the first line it quotes verbatim; else, for a
 * heading alone, the first line of the file the heading names, or of the
 * first source. Any other section is uncertain.
 */
const wikiReview = (system: string): ReadonlyArray<unknown> | undefined => {
  const task = system.slice(system.lastIndexOf("The task for this run:"))
  const evidence = leadingJson(task.slice(task.indexOf("\n{") + 1))
  if (!Array.isArray(evidence?.sections) || !Array.isArray(evidence?.sources)) return undefined
  const own = evidence.spec?.kind === "intent" ? undefined : evidence.spec?.document
  const lines = (evidence.sources as Array<Json>).filter((source) => source?.path !== own).flatMap(visibleLines)
  return (evidence.sections as Array<Json>).map((section) => {
    const markdown = String(section?.markdown ?? "")
    const linked = [...markdown.matchAll(sourceLink)].flatMap(([, file, line]) =>
      lines.filter((entry) => entry.path === file && entry.line === Number(line))
    )
    const quoted = lines.find((entry) => /\w{3}/.test(entry.quote) && markdown.includes(entry.quote))
    const heading = /^#{1,3} ([^\n]+)$/.exec(markdown.trim())?.[1]!.trim()
    const titled = heading === undefined
      ? undefined
      : (evidence.sources as Array<Json>).some((source) => source?.path === heading)
      ? lines.find((entry) => entry.path === heading)
      : lines[0]
    const citations = linked.length > 0
      ? [...new Map(linked.map((entry) => [`${entry.path}:${entry.line}`, entry])).values()]
      : [quoted ?? titled].filter((entry) => entry !== undefined)
    return {
      id: section.id,
      verdict: citations.length > 0 ? "supported" : "uncertain",
      explanation: citations.length > 0
        ? "Each cited line states what this section says."
        : "No supplied source line states this section.",
      citations
    }
  })
}

/** The conflict prompt names the conflicted path. */
const conflictPath = new RegExp(`${teachings.conflict} "([^"]+)"`)

interface Step {
  readonly step: string
  readonly teaching: string
  readonly answer: (payload: Json, all: string) => string
}

/**
 * Builds a script.
 *
 * @category constructors
 * @since 1.0.0
 */
export const make = (options: Options = {}): BuiltinScript => {
  const greeting = options.greeting ?? GREETING
  const holdAt = new Set(options.holdAt ?? [])
  const findings = options.reviewFindings ?? []
  const fileDirectives = new Map<string, Directives>()

  const steps: ReadonlyArray<Step> = [
    {
      step: "coding/review-request",
      teaching: teachings["coding/review-request"],
      answer: (payload) =>
        done({
          explanation: "The request names one file and one edit; the evidence is sufficient.",
          clarification: directives(requestOf(payload).slice(0, 2)).ask === true ? QUESTION : ""
        })
    },
    {
      step: "coding/draft-plan",
      teaching: teachings["coding/draft-plan"],
      answer: (payload) => {
        const context = payload?.context ?? {}
        const checks: Array<Json> = context.checks ?? []
        const required = checks.filter((check) => check.required).map((check) => check.id)
        const found = directives(requestOf(payload))
        const file = found.file ?? "JOURNEY.md"
        const writes = found.flowEdit === true ? [TODO_FLOW] : [file]
        if (found.changelog === true) writes.push("CHANGELOG.md")
        if (found.observeUid !== undefined) writes.push(".outside-note-uid")
        if ((found.fail === true || found.failOnce === true) && !writes.includes("JOURNEY.md")) {
          writes.push("JOURNEY.md")
        }
        fileDirectives.set(file, found)
        const answer = payload?.answer ||
          (typeof payload?.input?.feedback === "string" ? payload.input.feedback : undefined)
        return done({
          rationale: "Append one documentation change on the current head.",
          baseChangeId: context.head?.changeId ?? context.history?.at(-1)?.changeId,
          changes: [{
            id: "greeting",
            title: "Add a greeting",
            intent: `${writes.join(", ")} carries a greeting.`,
            atoms: [{
              changeId: null,
              message: SUBJECT,
              intent: `Append a greeting line to ${file}. ${intentTags(found, answer)}`.trim(),
              reads: writes,
              writes
            }],
            checks: required.length >= 2 ? required : checks.map((check) => check.id)
          }]
        })
      }
    },
    {
      step: "coding/edit-atom",
      teaching: teachings["coding/edit-atom"],
      answer: (payload) => editCell(String(payload?.atom?.intent ?? ""), greeting, options.todoFlow)
    },
    {
      step: "coding/select-owner-repair",
      teaching: teachings["coding/select-owner-repair"],
      answer: (payload, all) => {
        // The planned Change (owner) carries the intent, its implementation the JJ change ids.
        const atom = firstAtom(payload)
        const changeId = payload?.implementation?.atoms?.[0]?.changeId ?? atom?.changeId ?? "unknown"
        const intent = String(
          payload?.owner?.atoms?.[0]?.intent ?? atom?.intent ?? "Append a greeting line to JOURNEY.md."
        )
        // A fixed anywhere in the turn ends a scripted failure; a failOnce edit is always restored.
        const repaired = directives(all).fixed === true ? intent.replace("[FAIL]", "").trim() : intent
        return done({ changeId, intent: repaired.replace("[FAILONCE]", "[RESTORE]") })
      }
    },
    {
      step: "coding/review-final-history",
      teaching: teachings["coding/review-final-history"],
      answer: (payload) => {
        const changes: Array<Json> = payload?.request?.outcome?.result?.changes ?? []
        const atoms = changes.flatMap((change) => change.implementation?.atoms ?? [])
        return done({
          summary: SUBJECT,
          atoms: atoms.map((atom: Json) => ({ changeId: atom.changeId, description: SUBJECT }))
        })
      }
    },
    {
      step: "coding/review-lens",
      teaching: teachings["coding/review-lens"],
      answer: () => done({ verdict: "approve", findings: [] })
    },
    {
      // The stack's review of a TODO's open pull request: its first line is the verdict.
      step: "review/change",
      teaching: teachings["review/change"],
      answer: (_payload, all) => directives(all).probeReview === true ? probeCell : done(REVIEW_ANSWER)
    }
  ]

  const respond = (messages: ReadonlyArray<ChatMessage>): ScriptedModel.Reply | undefined => {
    const system = messages.filter((message) => message?.role === "system").map((message) => textOf(message.content))
      .join("\n")
    const all = messages.map((message) => textOf(message?.content)).join("\n")
    if (system.includes(teachings["review/file"])) {
      const comments = findings.filter((finding) =>
        all.includes(finding.path) && all.includes(finding.match ?? finding.existingCode)
      )
        .map(({ match: _match, reason: _reason, ...comment }) => comment)
      return { name: "review/file", text: done({ status: "success", comments }) }
    }
    if (system.includes(teachings["review/verify"])) {
      const verdicts = findings.map((finding, index) => ({
        index,
        verdict: "keep",
        reason: finding.reason ?? "The finding holds."
      }))
      return { name: "review/verify", text: done({ verdicts }) }
    }
    if (system.includes(teachings["wiki/review-page"])) {
      const sections = wikiReview(system)
      return sections === undefined ? undefined : { name: "wiki/review-page", text: done({ sections }) }
    }
    const conflict = conflictPath.exec(all)
    if (conflict !== null) {
      const file = conflict[1]!
      const resolve = directives(all).noResolve !== true && fileDirectives.get(file)?.noResolve !== true
      return { name: resolve ? "conflict/resolve" : "conflict/noresolve", text: resolveCell(file, resolve) }
    }
    const matched = steps.find((entry) => system.includes(entry.teaching))
    if (matched === undefined) return undefined
    const payload = payloadOf(system, messages)
    const text = matched.answer(payload, all)
    const hold = matched.step === "coding/edit-atom"
      ? directives(String(payload?.atom?.intent ?? "")).hold
      : holdAt.has(matched.step)
      ? directives(all).hold
      : undefined
    return { name: matched.step, text, hold }
  }

  return { respond, script: (request: ModelRequest) => respond(ScriptedModel.transcript(request)) }
}

/**
 * The reply for a turn no builtin step sends: a cell that settles it with
 * `{ messages: ["scripted"] }`, named `unscripted`, with the turn's system
 * teaching and last message (6,000 characters of each) on its trace entry,
 * so the next step can be scripted from the evidence.
 *
 * @category constructors
 * @since 1.0.0
 */
export const unscripted: ScriptedModel.Script = (request) => {
  const messages = ScriptedModel.transcript(request)
  return {
    name: "unscripted",
    text: done({ messages: ["scripted"] }),
    detail: {
      system: messages.filter((message) => message.role === "system").map((message) => message.content).join("\n")
        .slice(0, 6000),
      last: (messages.at(-1)?.content ?? "").slice(0, 6000)
    }
  }
}

/** The question ids the coding run asks the judge. */
const judged = /^(route|complete|on_target|overclaims|invented|confident|(needed|unnecessary)_\d+)$/

/**
 * Whether an evaluation is one the coding run asks.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isJudgement = (questions: Readonly<Record<string, unknown>> | null | undefined): boolean =>
  Object.keys(questions ?? {}).some((name) => judged.test(name))

/**
 * The judge's answer to one question: route a TODO to implement, call its
 * result complete and on target and nothing else, and a wiki citation
 * supported.
 *
 * @throws Error for a choice it cannot route or a question type it does not know.
 * @category constructors
 * @since 1.0.0
 */
export const answer = (
  name: string,
  question: { readonly type?: unknown; readonly criteria?: unknown }
): Evaluator.RawAnswer => {
  switch (question.type) {
    case "boolean":
      return { type: "boolean", probability: ["complete", "on_target"].includes(name) ? 0.99 : 0.01 }
    case "score":
      return {
        type: "score",
        score: name === "confident" && Array.isArray(question.criteria) ? question.criteria.length - 1 : 0
      }
    case "choice": {
      const keys = Object.keys(isObject(question.criteria) ? question.criteria : {})
      const choice = (name === "support" ? ["supports"] : ["implement", "none"]).find((option) => keys.includes(option))
      if (choice === undefined) throw new Error(`unexpected choice question: ${name}`)
      return { type: "choice", choice }
    }
    default:
      throw new Error(`unexpected evaluation type: ${String(question.type)}`)
  }
}

/**
 * {@link answer} as an evaluator. A question it cannot answer fails the
 * evaluation as `invalid_question`. Each answer reports 120 input tokens, so a
 * metering proxy prices it as it prices any judgment.
 *
 * @category constructors
 * @since 1.0.0
 */
export const evaluator: Evaluator.Evaluator = {
  evaluate: (request) =>
    Effect.try({
      try: () => ({
        answers: Object.fromEntries(
          Object.entries(request.questions).map(([name, question]) => [name, answer(name, question)])
        ),
        usage: { inputTokens: 120, outputTokens: 0 },
        latencyMs: 0
      }),
      // `answer` throws only Errors.
      catch: (error) => new Evaluator.EvaluatorError({ code: "invalid_question", message: (error as Error).message })
    })
}
