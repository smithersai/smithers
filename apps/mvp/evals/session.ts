// How one eval case runs (docs/features/agent-evals.md#how-a-case-runs): the real agent on the browser's architecture in
// Node, against ChatApi's real handler and the real model. Nothing is scripted.
//
// - ChatApi: its real handler on a scratch schema of the compose Postgres (worker/test/harness.ts), serving the metered
//   model endpoint with the deployment's default model (`CHAT_MODEL`, else `DEFAULT_CHAT_MODEL`), its key read from the
//   environment. Every role (`agent`, `judge`, `renderer`) is that model unless an admin set one.
// - The device: a fresh tab and engine leader per trial (src/test/device.ts), so the theme starts unset and the tab
//   answers its navigations. The tab dispatches `chat/Answer` as the composer does.
// - The person: when the agent asks (`app/agent/ask`), the trial answers through `run/answer`, as the card's Answer does.
// - The budget: the session adds up what the endpoint's model reported each trial spent, and a trial that would start
//   once that reaches the cap fails at once. The endpoint charges a call what it spent, and a call the provider refused
//   before any output what the provider reported, so the two agree; each trial reads both (`chargedTokens`).
// - A refusing provider: a case with `provider: "refuses"` asks a second ChatApi whose model is the deployment's
//   default with a key its provider rejects, so every call is a real refusal before any output.
import { openBudget } from "../bench/cerebras-load/budget.ts"
import { guardedModel } from "../bench/cerebras-load/guard.ts"
import { candidateConfig, refusalConfig } from "./candidate"
import { openProviderResource, waitForDispatch } from "./session-lifecycle.ts"
import { afterAll } from "vitest"
import { HostModel } from "@smthrs/model-host"
import { EgressHttpClient } from "@smthrs/platform-node"
import { ConfigProvider, Effect, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { testFile } from "../worker/test/harness.ts"
import { DEFAULT_CHAT_MODEL } from "../worker/ModelRoles.ts"
import { answerRow, openAgent } from "../src/test/agent"
import { openDevice } from "../src/test/device"
import { renderSource, SOURCE_PATH } from "../src/features/flows-ui/source"
import type { CaseInput, Person, Seed } from "./cases"
import type { Asked, Draft, ModelFailure, Trial, Usage, View } from "./checks"
import { tokenCap } from "./report"

/** How long one answer may take, asks and flow drafts included, before the trial counts it unanswered. */
export const ANSWER_WITHIN_MS = 4 * 60_000

/** How often a trial looks for a question the agent asked. */
const POLL = "250 millis"

const providers = new Set<Awaited<ReturnType<typeof openProviderResource>>>()
afterAll(async () => { for (const provider of providers) await provider.close() })

const budgets = new Set<ReturnType<typeof openBudget>>()
afterAll(() => { for (const budget of budgets) budget.close() })

type Runtime = ReturnType<typeof testFile>
type Device = Awaited<ReturnType<typeof openDevice>>

interface RunRow {
  readonly status: string
  readonly version: number
  readonly wait: { readonly execution: string; readonly kind: string; readonly prompt: string } | null
}

/**
 * The deployment's default model, as ChatApi builds it: `CHAT_MODEL` and its key from the environment. Its provider
 * calls go through `fetch`: on Node, the host's HTTP/1.1 provider fetch, since Node's own fetch wedges on an HTTP/2
 * session the provider tore down (`EgressHttpClient.providerFetch`).
 */
export const defaultModel = (fetch: typeof globalThis.fetch) =>
  Effect.gen(function* () {
    return yield* HostModel
  }).pipe(Effect.provide(HostModel.layerConfig("CHAT_MODEL", DEFAULT_CHAT_MODEL, { fetch })))

/** The default model's provider with a key it rejects: each call is refused before any output. */
const refusedModel = (fetch: typeof globalThis.fetch) =>
  defaultModel(fetch).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(refusalConfig(process.env)))),
  )

/**
 * ChatApi with the real model on `runtime`'s schema, and a way to run one trial of a case against it, until the trials
 * have spent `maxTokens`.
 */
export const openSession = async (runtime: Runtime, maxTokens: number) => {
  /** The model calls that failed since the trial began, so an artifact says why a model failed, not only that it did. */
  const failures: Array<ModelFailure> = []
  // Synthetic eval conversations only: keep the model's cells and renderer corrections in the artifact, never logs.
  const transcript: Array<{ request: unknown; reply: string }> = []
  // The provider pool lives as long as the eval program.
  const provider = await openProviderResource(EgressHttpClient.providerFetch(process.env))
  providers.add(provider)
  const providerFetch = provider.value
  /** The provider requests this trial made through `providerFetch`, and how many failed before an answer. */
  let requests = { made: 0, failed: 0 }
  /** The trial's provider fetch, noting what broke under a request that failed before its answer: the model sees only `transport`. */
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    requests.made++
    try {
      return await providerFetch(input, init)
    } catch (error) {
      requests.failed++
      const cause = (error as { readonly cause?: { readonly code?: unknown; readonly message?: unknown } }).cause
      failures.push({
        code: "fetch",
        httpStatus: null,
        providerCode: typeof cause?.code === "string" ? cause.code : null,
        message: typeof cause?.message === "string" ? cause.message.slice(0, 300) : String(error).slice(0, 300),
      })
      throw error
    }
  }) as typeof globalThis.fetch
  const rawModel = await Effect.runPromise(defaultModel(fetch))
  const candidate = candidateConfig(process.env)
  const budget = candidate ? openBudget(process.env.INFERENCE_LEDGER!, process.env.INFERENCE_PROVIDER!, candidate, 'eval', 2) : undefined
  const guarded = budget ? guardedModel(rawModel, budget) : rawModel
  /** `host` noting each call that failed, as the SDK's `ModelError` says, in the trial's `modelFailures`. */
  const observed = (host: typeof guarded): typeof guarded => ({
    ...host,
    model: { ...host.model, stream: (request: Parameters<typeof host.model.stream>[0]) => {
      const turn = { request, reply: "" }
      transcript.push(turn)
      return host.model.stream(request).pipe(
        Stream.tap((event) => Effect.sync(() => { if (event.type === "text-delta") turn.reply += event.text })),
        Stream.tapError((error) => Effect.sync(() => failures.push(
        error._tag === "flows/model/ModelError"
          ? {
            code: error.code,
            httpStatus: error.httpStatus ?? null,
            providerCode: error.providerCode ?? null,
            message: error.message.slice(0, 300),
          }
          : { code: error._tag, httpStatus: null, providerCode: null, message: "" },
      ))))
    } },
  })
  const model = observed(guarded)
  if (budget) budgets.add(budget)
  const agent = await openAgent(runtime, () => Stream.die(new Error("the evals' model is real")), {
    model,
    partsEvery: "250 millis",
  })
  /** ChatApi whose provider refuses every call, opened for the first case that asks for it. */
  let refusing: typeof agent | undefined
  const agentFor = async (provider: CaseInput["provider"]) => {
    if (provider === "model") return agent
    refusing ??= await openAgent(runtime, () => Stream.die(new Error("the evals' model is real")), {
      model: observed(await Effect.runPromise(refusedModel(fetch))),
      partsEvery: "250 millis",
    })
    return refusing
  }
  const query = <A>(statement: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<A>, unknown>) =>
    runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, statement))
  /** The tokens the model reported for every trial so far, against the run's cap. */
  const cap = tokenCap(maxTokens)

  /**
   * Runs `answerId`'s answer on `device` to its end, answering each question the agent asks as `person` would.
   * Resolves with the questions it answered, or `null` when the answer took longer than {@link ANSWER_WITHIN_MS}.
   */
  const answer = async (device: Device, answerId: string, person: Person): Promise<ReadonlyArray<Asked> | null> => {
    const asked: Array<Asked> = []
    const completed = await waitForDispatch(
      device.dispatch.dispatch("chat/Answer", { answerId }, { door: "composer", executionId: answerId }),
      Effect.promise(async () => {
        const [row] = await query<RunRow>((sql) => sql`SELECT status, version, wait FROM runs WHERE id = ${answerId}`)
        if (row?.status === "needs_you" && row.wait !== null && asked.length < row.version) {
          const value = row.wait.kind === "approval" ? person.approve : person.words
          // What the person saw while the question waited, as their answer's row holds it before they answer.
          const shown = (await answerRow(runtime, answerId)).text
          asked.push({ kind: row.wait.kind, prompt: row.wait.prompt, value, shown: shown === "" ? null : shown })
          const answered = await Effect.runPromise(
            device.dispatch.dispatch(
              "run/answer",
              { runId: answerId, version: row.version, execution: row.wait.execution, value },
              { door: "button" },
            ),
          )
          // A refused answer would leave the agent waiting out the trial: the case fails now, saying why.
          if (answered._tag === "Failed") throw new Error(`The person's answer failed: ${JSON.stringify(answered.error)}`)
        }
      }),
      ANSWER_WITHIN_MS,
      POLL,
    )
    if (!completed) return null
    return asked
  }

  /**
   * Makes what `seed` names on `device` as a person's own presses do (door `button`, which asks nothing), before the
   * ask: a flow saved from a ready draft written through ChatApi's route, or a run of the device's engine.
   */
  const plant = async (asking: typeof agent, device: Device, seed: Seed) => {
    const press = (flow: string, payload: unknown) =>
      Effect.runPromise(Effect.exit(device.dispatch.dispatch(flow as never, payload as never, { door: "button" })))
    if (seed === "theme-run") return void await press("app/theme/set", { mode: "dark" })
    // ChatApi here routes no repositories, so the lookup fails as an unreachable repository does.
    if (seed === "failed-run") return void await press("repo/refs", { repo: "octocat/Spoon-Knife" })
    const draftId = crypto.randomUUID()
    const written = await asking.h.fetch(`/api/flow-drafts/${draftId}`, {
      method: "POST",
      body: JSON.stringify({
        scope: "person",
        round: 0,
        request: "Open the Effect docs for me",
        name: "effect-docs",
        status: "ready",
        summary: null,
        files: [{
          path: SOURCE_PATH,
          text: renderSource({
            name: "effect-docs",
            description: "Opens the Effect docs in the chat.",
            flows: ["app/web/open"],
            instructions: "Open https://effect.website/docs in the chat, then say it is open.",
          }),
        }],
        checks: [{ check: "parses", ok: true }],
        questions: [],
        failure: null,
        flowId: null,
      }),
    })
    if (written.status !== 200) throw new Error(`the seed's draft wasn't written: ${written.status}`)
    // A draft seed stays a ready draft, not saved.
    if (seed === "draft") return
    const saved = await press("flow/save", { draftId })
    if (saved._tag !== "Success") throw new Error("the seed's flow wasn't saved")
  }

  /** One trial of `kase`: a fresh conversation and device, its ask, and what came of it. */
  const trial = async (kase: CaseInput): Promise<Trial> => {
    cap.before(kase.name)
    // The endpoint's day budget starts over too: a failed call keeps its whole reservation, so a few model failures
    // would otherwise spend the scratch deployment's day and refuse every later case `quota_exceeded`. The run's own
    // cap is `maxTokens`, counted from what the model reported.
    await query((sql) =>
      sql`TRUNCATE message_pins, messages, views, runs, flow_drafts, flow_revisions, flows, model_usage, model_budget_days, watches
        RESTART IDENTITY CASCADE`
    )
    const asking = await agentFor(kase.provider)
    failures.length = 0
    transcript.length = 0
    requests = { made: 0, failed: 0 }
    const device = await openDevice(asking.fetch, {}, undefined, kase.at === undefined ? {} : { at: kase.at })
    try {
      if (kase.seed !== null) await plant(asking, device, kase.seed)
      // What the seed painted or moved isn't the agent's.
      const [paintedBefore, navigatedBefore] = [device.painted.length, device.navigated.length]
      const started = Date.now()
      const answerId = await asking.ask(kase.ask)
      const asked = await answer(device, answerId, kase.person)
      const ms = Date.now() - started
      const row = await answerRow(runtime, answerId)
      const inspection = await Effect.runPromise(device.engine.inspect(answerId))
      const views = await query<{
        readonly template: string
        readonly props: { readonly url?: unknown } & Record<string, unknown>
        readonly html: string | null
        readonly interactions: Record<string, { readonly kind: string }> | null
      }>((sql) => sql`SELECT template, props, html, interactions FROM views ORDER BY position`)
      const drafts = await query<Omit<Draft, "source"> & { readonly files: ReadonlyArray<{ readonly text: string }> }>(
        (sql) => sql`SELECT name, status, checks, files FROM flow_drafts ORDER BY created_at`,
      )
      const usage = await query<Usage>((sql) =>
        sql`SELECT role, model_id AS "modelId", input_tokens AS "inputTokens", output_tokens AS "outputTokens",
            charged_tokens AS "chargedTokens"
          FROM model_usage ORDER BY created_at`
      )
      cap.add(usage.reduce((sum, call) => sum + call.inputTokens + call.outputTokens, 0))
      return {
        status: asked === null ? "unanswered" : row.status,
        failure: row.failure,
        text: row.text,
        calls: [...inspection.children]
          .sort((a, b) => a.createdAtMs - b.createdAtMs)
          .map((child) => ({
            flow: child.flowName,
            input: parsed(child.input.text),
            status: child.status,
            result: child.result === null ? null : parsed(child.result.text),
          })),
        painted: device.painted.slice(paintedBefore).filter((mode) => mode !== undefined),
        navigated: device.navigated.slice(navigatedBefore),
        views: views.map((view): View => ({
          template: view.template,
          url: typeof view.props.url === "string" ? view.props.url : null,
          props: view.props,
          html: view.html,
          interactions: view.interactions,
        })),
        asked: asked ?? [],
        drafts: drafts.map(({ name, status, checks, files }) => ({
          name,
          status,
          checks,
          source: files[0]?.text ?? null,
        })),
        usage,
        pending: [
          ...inspection.steps
            .filter((step) => step.status === "running" || step.status === "waiting")
            .map((step) => `${step.action ?? step.nodeId}:${step.status}`),
          ...(inspection.run.waiting === null ? [] : [`waiting:${inspection.run.waiting.kind}`]),
        ],
        ms,
        modelFailures: [...failures],
        requests,
        transcript: [...transcript],
      }
    } finally {
      await device.close()
    }
  }

  return {
    modelId: model.modelId,
    trial,
    cap,
    price: candidate ? { modelId: model.modelId, input: candidate.input, output: candidate.output } : undefined,
    campaignEstimatedUsd: () => budget?.total(),
  }
}

/** A child's input as the engine shows it: JSON when it reads, else the text. */
const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
