/**
 * The host's implementations of the organization flows' own steps.
 *
 * They read only the host's configuration and the trusted roster registry;
 * every principal a role names in its result is resolved against the pinned
 * snapshot here, so a role can hand work only to an active principal that
 * holds the grants the work needs.
 */
import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import { Clock, Effect, Layer } from "effect"
import * as Authority from "../../packages/smithers/agent/organization/src/Authority.ts"
import type * as Gates from "../../packages/smithers/agent/organization/src/Gates.ts"
import type * as Profile from "../../packages/smithers/agent/organization/src/Profile.ts"
import type * as Prompt from "../../packages/smithers/agent/organization/src/Prompt.ts"
import type * as Workspace from "../../packages/smithers/agent/organization/src/Workspace.ts"
import {
  Admit,
  type Answer,
  Assign,
  type Assignment,
  BuildTask,
  CheckTask,
  CorrectTask,
  Decide,
  DeliveryFailed,
  Describe,
  IntakeRefused,
  LeadTask,
  RenderReply,
  type Request,
  RouteTask,
  Settle,
  type Stage,
  StatusFailed,
  WriteStatus
} from "./schema.ts"

/** What the host decided at startup that every admission uses. */
export interface Options {
  /** Organization root: the directory holding `Org/`. */
  readonly root: string
  /** The assistant principal the organization page names. */
  readonly assistant: string
  /** Repository names to trusted host paths. */
  readonly repositories: Readonly<Record<string, string>>
  /** The loaded gate policy. */
  readonly gates: Gates.GatePolicy
  /** The checks every change runs in a fresh machine. */
  readonly checks: ReadonlyArray<Workspace.Check>
  /** Slack user ids admitted as the owner. */
  readonly owners: ReadonlyArray<string>
  readonly maxRounds: number
  /** The generated directory receipts go under, and the status page. */
  readonly generatedDir: string
  readonly statusFile: string
}

/** The branch every landed change goes to, under `organization/`. */
export const branchFor = (key: string): string => {
  const slug = key.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 48)
  return `organization/${slug === "" ? "request" : slug}-${createHash("sha256").update(key).digest("hex").slice(0, 8)}`
}

const line = (text: string, max = 1_900): string => {
  const flat = text.replaceAll(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}
const paragraph = (text: string, max = 7_900): string => {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}
const lines = (texts: ReadonlyArray<string>) => texts.map((text) => line(text)).filter((text) => text !== "")
const taskId = (key: string, step: string) => `${key.slice(0, 100)}/${step}`

const requestContext = (request: Request, at: number): Prompt.ContextEntry => ({
  source: { provider: request.source, id: request.key },
  provenance: { retrievedAtMs: at },
  text: request.text
})
const conversationOf = (request: Request) =>
  request.conversation === undefined ? {} : {
    conversation: {
      provider: "slack",
      container: request.conversation.channel,
      thread: request.conversation.thread
    }
  }

const stop = (principal: string, outcome: Stage["outcome"], reason: string, task: Profile.TaskContract): Stage => ({
  proceed: false,
  outcome,
  reason: reason.trim() === "" ? outcome : reason,
  principal,
  task,
  context: []
})

/** The roster lines a routing or contract task lists as candidates. */
const candidates = (
  snapshot: Authority.Snapshot,
  admit: (profile: Profile.Profile) => boolean
): ReadonlyArray<string> =>
  [...snapshot.roster.profiles.values()]
    .filter((profile) => profile.status === "active" && admit(profile))
    .map((profile) => `${profile.id} (${profile.name}): ${profile.charter.objective}`)

const holdsRepository = (profile: Profile.Profile, repository: string) =>
  profile.grants.tools.includes("workspace") && profile.grants.repositories.includes(repository)

const describeResult = (answer: Answer): string =>
  answer.valid
    ? answer.result.summary
    : `${answer.result.summary} (${answer.principal} broke its charter: ${answer.violations.join("; ")})`

const negativeVerdict = /^(?:request-changes|changes-requested|reject(?:ed)?|fail(?:ed)?|blocked|inconclusive)$/i

const fence = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters not shown)`

const atomicWrite = async (root: string, path: string, content: string) => {
  const target = resolve(root, path)
  if (!target.startsWith(resolve(root) + sep)) throw new Error(`${path} is outside the organization root`)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, { mode: 0o644 })
  await rename(temporary, target)
  return relative(root, target)
}

/** The delivery receipts under the generated directory, newest first. */
export const readReceipts = async (root: string, generatedDir: string) => {
  const directory = resolve(root, generatedDir)
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const receipts: Array<{ readonly key: string; readonly status: string; readonly summary: string; readonly at: number; readonly branch?: string; readonly commit?: string }> = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const text = await readFile(join(directory, entry.name, "deliver.json"), "utf8").catch(() => undefined)
    if (text === undefined) continue
    try {
      const parsed = JSON.parse(text) as {
        readonly admission?: { readonly at?: number }
        readonly report?: { readonly key?: string; readonly status?: string; readonly summary?: string; readonly applied?: { readonly branch?: string; readonly commit?: string } }
      }
      const report = parsed.report ?? {}
      receipts.push({
        key: report.key ?? entry.name,
        status: report.status ?? "unknown",
        summary: report.summary ?? "",
        at: parsed.admission?.at ?? 0,
        ...(report.applied?.branch === undefined ? {} : { branch: report.applied.branch }),
        ...(report.applied?.commit === undefined ? {} : { commit: report.applied.commit })
      })
    } catch {
      continue
    }
  }
  return receipts.sort((left, right) => right.at - left.at || (left.key < right.key ? -1 : 1))
}

/** Every organization step the flows call, over the trusted registry and the host's options. */
export const layer = (options: Options) =>
  Layer.mergeAll(
    Admit.toLayer(({ request }) =>
      Effect.gen(function*() {
        if (request.source === "slack" && (request.user === undefined || !options.owners.includes(request.user))) {
          return yield* new IntakeRefused({ reason: "not-owner", message: "only the organization's owner may make requests" })
        }
        const names = Object.keys(options.repositories)
        const repository = request.repository ?? (names.length === 1 ? names[0] : undefined)
        if (repository === undefined) {
          return yield* new IntakeRefused({ reason: "no-repository", message: `name one of the configured repositories: ${names.join(", ")}` })
        }
        if (!Object.hasOwn(options.repositories, repository)) {
          return yield* new IntakeRefused({ reason: "unknown-repository", message: `repository ${repository} is not configured on this host` })
        }
        return {
          assistant: options.assistant,
          repository,
          commit: "HEAD",
          branch: branchFor(request.key),
          checks: options.checks,
          gates: options.gates,
          maxRounds: options.maxRounds,
          at: yield* Clock.currentTimeMillis
        }
      }), { implementationVersion: "admit/v1" }),
    RouteTask.toLayer(({ assistant, request, revision }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const { snapshot } = yield* registry.resolve(revision, assistant)
        const at = yield* Clock.currentTimeMillis
        return {
          proceed: true,
          outcome: "blocked" as const,
          reason: "",
          principal: assistant,
          task: {
            id: taskId(request.key, "route"),
            objective:
              "Route the owner's request in the context below to the one role accountable for delivering it, or answer it yourself when it needs no work.",
            inputs: lines([
              "The owner's request, in the context below.",
              ...candidates(snapshot, (profile) => profile.id !== assistant).map((entry) => `Role ${entry}`)
            ]),
            acceptance: lines([
              "Return done.",
              "When the request needs work, include exactly one handoff: `to` is the accountable role's id from the inputs, `objective` restates the request, and `inputs` lists what the role needs.",
              "When it needs no work, include no handoff and put the answer in the summary.",
              "Fill every output field your charter declares."
            ]),
            evidence: ["The request text and the routing reason."],
            requestedBy: "owner" as const,
            ...conversationOf(request)
          },
          context: [requestContext(request, at)]
        }
      }), { implementationVersion: "route-task/v1" }),
    LeadTask.toLayer(({ repository, request, revision, routed }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const snapshot = yield* registry.get(revision)
        const at = yield* Clock.currentTimeMillis
        const placeholder: Profile.TaskContract = {
          id: taskId(request.key, "contract"),
          objective: "No contract.",
          inputs: [],
          acceptance: [],
          evidence: [],
          requestedBy: routed.principal
        }
        if (!routed.valid) return stop(routed.principal, "blocked", describeResult(routed), placeholder)
        if (routed.result.status !== "done") return stop(routed.principal, "blocked", routed.result.summary, placeholder)
        const handoff = routed.result.handoffs[0]
        if (handoff === undefined) return stop(routed.principal, "answered", routed.result.summary, placeholder)
        if (handoff.to === routed.principal) {
          return stop(routed.principal, "blocked", `${routed.principal} handed the request to itself`, placeholder)
        }
        // An inactive or unknown lead is a refusal, not a quiet stop.
        yield* registry.resolve(revision, handoff.to)
        return {
          proceed: true,
          outcome: "blocked" as const,
          reason: "",
          principal: handoff.to,
          task: {
            id: taskId(request.key, "contract"),
            objective: paragraph(handoff.objective),
            inputs: lines([
              ...handoff.inputs,
              `Repository: ${repository}.`,
              ...candidates(snapshot, (profile) => holdsRepository(profile, repository)).map((entry) =>
                `Can build or check in ${repository}: ${entry}`
              )
            ]),
            acceptance: lines([
              "Return done with exactly two handoffs.",
              `The first hands the change to the role that builds it: \`objective\` is the one change to make in ${repository}, and \`inputs\` are its acceptance criteria, one per entry.`,
              "The second hands the finished change to a different role that independently checks it against those criteria.",
              "Fill every output field your charter declares."
            ]),
            evidence: ["The request and the checks the acceptance relies on."],
            requestedBy: routed.principal,
            ...conversationOf(request)
          },
          context: [requestContext(request, at)]
        }
      }), { implementationVersion: "lead-task/v2" }),
    Assign.toLayer(({ contract, repository, revision }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const blocked = (reason: string): Assignment => ({
          proceed: false,
          reason,
          lead: contract.principal,
          builder: contract.principal,
          checker: contract.principal,
          objective: "",
          acceptance: [],
          message: "No change",
          checkerWorkspace: false
        })
        if (!contract.valid) return blocked(describeResult(contract))
        if (contract.result.status !== "done") return blocked(contract.result.summary)
        const [build, check] = contract.result.handoffs
        if (build === undefined || check === undefined) {
          return blocked(`${contract.principal}'s contract names no builder and checker`)
        }
        if (build.to === check.to) return blocked("the builder cannot check its own change")
        // Resolving refuses an unknown, paused, or retired principal outright.
        const builder = (yield* registry.resolve(revision, build.to)).profile
        const checker = (yield* registry.resolve(revision, check.to)).profile
        if (!holdsRepository(builder, repository)) {
          return blocked(`${builder.id} holds no workspace for ${repository}`)
        }
        const objective = line(build.objective, 7_900)
        return {
          proceed: true,
          reason: "",
          lead: contract.principal,
          builder: builder.id,
          checker: checker.id,
          objective,
          acceptance: lines(build.inputs),
          message: line(objective, 72),
          checkerWorkspace: holdsRepository(checker, repository)
        }
      }), { implementationVersion: "assign/v3" }),
    BuildTask.toLayer(({ assignment, findings, request, round, workdir }) =>
      Clock.currentTimeMillis.pipe(Effect.map((at): Stage => ({
        proceed: true,
        outcome: "blocked",
        reason: "",
        principal: assignment.builder,
        task: {
          id: taskId(request.key, `build-${round}`),
          objective: paragraph(assignment.objective),
          inputs: lines([
            `The repository checkout is ${workdir} in your workspace machine.`,
            ...(findings.length === 0 ? [] : [`Round ${round}: the checker asked for changes; its findings are in the context below.`])
          ]),
          acceptance: lines([
            ...assignment.acceptance,
            "Change only what these criteria require, inside the workspace.",
            "Return done with every output field your charter declares and the commands you ran as evidence."
          ]),
          evidence: ["Command output from the workspace."],
          requestedBy: assignment.lead,
          ...conversationOf(request)
        },
        context: [
          requestContext(request, at),
          ...(findings.length === 0 ? [] : [{
            source: { provider: "organization", id: `findings/${round - 1}` },
            provenance: { retrievedAtMs: at },
            text: findings.join("\n")
          }])
        ]
      }))), { implementationVersion: "build-task/v1" }),
    CheckTask.toLayer(({ assignment, build, checks, diff, request, round, workdir }) =>
      Clock.currentTimeMillis.pipe(Effect.map((at): Stage => ({
        proceed: true,
        outcome: "blocked",
        reason: "",
        principal: assignment.checker,
        task: {
          id: taskId(request.key, `check-${round}`),
          objective: paragraph(`Decide whether this change meets its acceptance criteria: ${assignment.objective}`),
          inputs: lines([
            "The diff, the check receipts from a fresh machine, and the builder's summary, in the context below.",
            `${diff.files.length} file(s) changed, +${diff.added} -${diff.deleted}; configured checks ${checks.passed ? "passed" : "did not pass"}.`,
            ...(assignment.checkerWorkspace
              ? [`The change is applied in the repository checkout at ${workdir} in your workspace machine: reproduce the criteria there, and change nothing.`]
              : [])
          ]),
          acceptance: lines([
            ...assignment.acceptance.map((criterion) => `Criterion: ${criterion}`),
            "Return done only when every criterion is met and every configured check passed; otherwise return blocked with the unmet criteria as the summary.",
            "Fill every output field your charter declares."
          ]),
          evidence: ["Check receipts and diff references."],
          requestedBy: assignment.lead,
          ...conversationOf(request)
        },
        workspace: assignment.checkerWorkspace,
        context: [
          {
            source: { provider: "organization", id: `diff/${round}` },
            provenance: { retrievedAtMs: at },
            text: fence(diff.patch, 24_000)
          },
          {
            source: { provider: "organization", id: `checks/${round}` },
            provenance: { retrievedAtMs: at },
            text: fence(
              checks.receipts.map((receipt) =>
                `${receipt.name}: ${receipt.argv.join(" ")} → exit ${receipt.exitCode ?? "none"}${receipt.timedOut ? " (timed out)" : ""}\n${receipt.stdout.text}${receipt.stderr.text}`
              ).join("\n\n") || "No checks are configured.",
              12_000
            )
          },
          {
            source: { provider: "organization", id: `build/${round}` },
            provenance: { retrievedAtMs: at },
            text: fence(`${build.principal}: ${describeResult(build)}`, 4_000)
          }
        ]
      }))), { implementationVersion: "check-task/v3" }),
    CorrectTask.toLayer(({ result, stage, validation }) =>
      Clock.currentTimeMillis.pipe(Effect.map((at): Stage => ({
        ...stage,
        context: [
          ...stage.context,
          {
            source: { provider: "organization", id: `correction/${stage.task.id}` },
            provenance: { retrievedAtMs: at },
            text: [
              "Your previous answer to this task broke your charter:",
              ...validation.violations.map((violation) => `- ${violation.message}`),
              "Answer the task again with a result that keeps your charter. Your previous result:",
              fence(JSON.stringify(result, null, 2), 8_000)
            ].join("\n")
          }
        ]
      }))), { implementationVersion: "correct-task/v1" }),
    Decide.toLayer(({ build, check, checks, diff }) =>
      Effect.sync(() => {
        const findings: Array<string> = []
        if (!build.valid || build.result.status !== "done") findings.push(`The builder did not finish: ${describeResult(build)}`)
        if (diff.files.length === 0) findings.push("The workspace holds no change.")
        for (const receipt of checks.receipts) {
          if (receipt.exitCode !== 0) {
            findings.push(`Check ${receipt.name} ${receipt.timedOut ? "timed out" : `exited ${receipt.exitCode}`}: ${line(receipt.stderr.text || receipt.stdout.text, 400)}`)
          }
        }
        const verdicts = Object.values(check.result.fields).filter((value): value is string => typeof value === "string")
        const refused = verdicts.some((value) => negativeVerdict.test(value.trim()))
        if (!check.valid || check.result.status !== "done" || refused) findings.push(`${check.principal}: ${describeResult(check)}`)
        return { approved: findings.length === 0 && checks.passed, findings: lines(findings) }
      }), { implementationVersion: "decide/v2" }),
    RenderReply.toLayer(({ speaker, text }) =>
      Effect.gen(function*() {
        const registry = yield* Authority.RosterRegistry
        const snapshot = yield* registry.current
        const profile = snapshot.roster.profiles.get(speaker)
        const trimmed = text.trim()
        return {
          text: trimmed === "" ? "Done." : trimmed.length <= 3_000 ? trimmed : `${trimmed.slice(0, 2_999)}…`,
          persona: { username: (profile?.name ?? (speaker === "" ? "Organization" : speaker)).slice(0, 80) }
        }
      }), { implementationVersion: "render-reply/v1" }),
    Describe.toLayer(({ failure }) =>
      Effect.sync(() => {
        const tag = failure._tag.split("/").at(-1) ?? failure._tag
        const detail = "reason" in failure ? failure.reason : "code" in failure ? String(failure.code) : undefined
        return { code: detail === undefined ? tag : `${tag}(${detail})`, message: line(failure.message, 1_000) }
      }), { implementationVersion: "describe-failure/v1" }),
    Settle.toLayer(({ receipt, report }) => {
      const settled = { ...report, receipt }
      return settled.status === "landed" || settled.status === "answered"
        ? Effect.succeed(settled)
        : Effect.fail(new DeliveryFailed({ status: settled.status, message: `${settled.status}: ${settled.summary}` }))
    }, { implementationVersion: "settle/v1" }),
    WriteStatus.toLayer(() =>
      Effect.tryPromise({
        try: async () => {
          const receipts = await readReceipts(options.root, options.generatedDir)
          const rows = receipts.slice(0, 50).map((receipt) =>
            `| ${receipt.at === 0 ? "" : new Date(receipt.at).toISOString()} | ${receipt.key} | ${receipt.status} | ${
              receipt.branch === undefined ? "" : `${receipt.branch} ${receipt.commit?.slice(0, 12) ?? ""}`
            } | ${line(receipt.summary, 200).replaceAll("|", "\\|")} |`
          )
          const content = [
            "# Status",
            "",
            `${receipts.length} deliveries.`,
            "",
            "| Admitted | Request | Status | Branch | Summary |",
            "| --- | --- | --- | --- | --- |",
            ...rows,
            ""
          ].join("\n")
          const path = await atomicWrite(options.root, options.statusFile, content)
          return { path, deliveries: receipts.length }
        },
        catch: (cause) => new StatusFailed({ message: cause instanceof Error ? cause.message : String(cause) })
      }), { implementationVersion: "write-status/v1" })
  )
