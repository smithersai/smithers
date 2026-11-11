/**
 * `smthrs alerts`: the probe report, the standing list and the
 * acknowledgement, for a probe that runs from a shell or a schedule rather
 * than inside a flow step.
 *
 * Every operation runs over the project's durable journal, the one the local
 * control plane writes. The run a probe reports into need not be a run the
 * control plane started: the journal keeps any run id, and one owning run per
 * problem is what makes a probe that fails on every invocation one condition
 * and one page.
 *
 * The policy is `.smithers/alerts.json`. Every probe the run has reported
 * gets a rule, `{ afterMs: 0 }` unless the file names one, so a probe nobody
 * configured still pages on its first failure and still shows in the list.
 *
 * @since 1.0.0
 */

import { Journal, JournalEvent } from "@smthrs/journal"
import { Alerts, Channels, NotificationQueue } from "@smthrs/notifications"
import { Effect, Layer, Redacted, Schema, SchemaIssue } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { userInfo } from "node:os"
import { join } from "node:path"
import * as CliError from "../CliError.vibe"
import * as Environment from "../Environment.ts"
import * as Project from "../Project.ts"
import * as Globals from "./Globals.vibe"

/**
 * Where a project keeps its alert policy, relative to the project root.
 *
 * @category constants
 * @since 1.0.0
 */
export const configFile = ".smithers/alerts.json"

/** The environment variable that holds the Telegram bot token. */
const telegramTokenVariable = "SMITHERS_ALERT_TELEGRAM_TOKEN"

/** The environment variable that holds the Resend API key. */
const emailKeyVariable = "SMITHERS_ALERT_EMAIL_API_KEY"

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"]

/**
 * Whether a provider origin is on this machine.
 *
 * The file is part of the repository and the credential is the host's, so a
 * repository may point the provider only at a local stand-in, never at a
 * server of its own choosing.
 */
const isLoopback = (raw: string): boolean => {
  try {
    const url = new URL(raw)
    return (url.protocol === "http:" || url.protocol === "https:") && loopbackHosts.includes(url.hostname) &&
      url.username === "" && url.password === ""
  } catch {
    return false
  }
}

const LoopbackUrl = Schema.String.check(
  Schema.makeFilter(isLoopback, { expected: "an http: or https: URL on 127.0.0.1, localhost or [::1]" })
)

/**
 * The contents of `.smithers/alerts.json`.
 *
 * `defaults` applies to every probe, `probes` names a rule per probe, and
 * `telegram` or `email` is where a page goes. `url` replaces the provider's
 * public origin with a local one, for a test or a relay on this machine.
 *
 * @category models
 * @since 1.0.0
 */
export const Config = Schema.Struct({
  defaults: Schema.optional(Schema.Struct({
    severity: Schema.optional(Alerts.Severity),
    owner: Schema.optional(Schema.String),
    runbook: Schema.optional(Schema.String)
  })),
  probes: Schema.optional(Schema.Record(Schema.String, Alerts.Rule)),
  telegram: Schema.optional(Schema.Struct({
    chatId: Channels.TelegramChatId,
    url: Schema.optional(LoopbackUrl)
  })),
  email: Schema.optional(Schema.Struct({
    to: Schema.NonEmptyArray(Channels.EmailAddress).check(Schema.isMaxLength(Channels.maxEmailRecipients)),
    from: Schema.NonEmptyString,
    url: Schema.optional(LoopbackUrl)
  }))
})

/**
 * The contents of `.smithers/alerts.json`.
 *
 * @category models
 * @since 1.0.0
 */
export type Config = typeof Config.Type

// A misspelled key is refused, not dropped: a dropped `telegram` is a page
// that never goes out.
const decodeConfig = Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })

const usage = (message: string) => new CliError.UsageError({ message })

/** The project's policy file, or an empty policy when the project has none. */
const readConfig = Effect.fnUntraced(function*() {
  const file = join(yield* Project.ProjectRoot, configFile)
  if (!existsSync(file)) return {}
  const text = yield* Effect.try({
    try: () => readFileSync(file, "utf8"),
    catch: () => usage(`Cannot read ${configFile}`)
  })
  const parsed = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: () => usage(`${configFile} is not valid JSON`)
  })
  return yield* decodeConfig(parsed).pipe(
    Effect.mapError((error) => usage(`${configFile} is invalid: ${SchemaIssue.makeFormatterDefault()(error.issue)}`))
  )
})

/** The probes a run has reported, read off its journal. */
const reportedProbes = Effect.fnUntraced(function*(runId: string) {
  const journal = yield* Journal.Journal
  const names = new Set<string>()
  let after: JournalEvent.Seq | undefined
  while (true) {
    const page = yield* journal.entries({
      runId: JournalEvent.RunId.make(runId),
      ...(after === undefined ? {} : { after }),
      limit: 512
    })
    for (const entry of page.entries) {
      const probe = (entry.payload as { readonly probe?: unknown } | null)?.probe
      if (typeof probe === "string" && entry.eventType === Alerts.probeEventType(probe)) names.add(probe)
    }
    if (!page.hasMore || page.entries.length === 0) return names
    after = page.entries.at(-1)!.seq
  }
})

/** The policy over every probe the run reported and every probe the file names. */
const policyFor = (config: Config, probes: Iterable<string>): Alerts.Policy => ({
  ...(config.defaults === undefined ? {} : { defaults: config.defaults }),
  ...Alerts.probes({
    ...Object.fromEntries(Array.from(probes, (probe) => [probe, { afterMs: 0 }])),
    ...config.probes
  })
})

/**
 * Where a report's page went: a channel, or `none` with the reason nothing
 * was sent.
 *
 * @category models
 * @since 1.0.0
 */
export type Destination = "telegram" | "email" | "none"

/** A channel to page on, or the reason there is none. */
type Selected =
  | { readonly destination: "telegram" | "email"; readonly sink: Layer.Layer<Alerts.Sink> }
  | { readonly destination: "none"; readonly note: string }

/** The sink the configuration and the environment select, or none with the reason. */
const sinkFor = (config: Config, environment: Environment.Source): Selected => {
  const token = Environment.read(environment, telegramTokenVariable)
  if (config.telegram !== undefined && token !== undefined) {
    const { chatId, url } = config.telegram
    return {
      destination: "telegram",
      sink: Alerts.layerChannels({ destination: { _tag: "telegram", chatId } }).pipe(
        Layer.provide(Channels.layer({ telegram: { token: Redacted.make(token), url } }))
      )
    }
  }
  const key = Environment.read(environment, emailKeyVariable)
  if (config.email !== undefined && key !== undefined) {
    const { from, to, url } = config.email
    return {
      destination: "email",
      sink: Alerts.layerChannels({ destination: { _tag: "email", to } }).pipe(
        Layer.provide(Channels.layer({ email: { apiKey: Redacted.make(key), from, url } }))
      )
    }
  }
  const missing = config.telegram !== undefined
    ? `telegram is configured but ${telegramTokenVariable} is not set`
    : config.email !== undefined
    ? `email is configured but ${emailKeyVariable} is not set`
    : "no destination configured"
  return { destination: "none", note: `${missing}; recorded only` }
}

/** The alert runtime over `policy`, the project's journal and `sink`. */
const runtimeOf = (policy: Alerts.Policy, sink: Layer.Layer<Alerts.Sink>) =>
  Alerts.layer(policy).pipe(Layer.provide(Layer.mergeAll(NotificationQueue.layer, sink)))

/**
 * One alert as a command prints it. `alertId` is the id a person
 * acknowledges, the same on every reminder; `reminder` counts the repeat.
 *
 * @category models
 * @since 1.0.0
 */
export interface Page {
  readonly alertId: string
  readonly condition: string
  readonly severity: Alerts.Severity
  readonly since: string
  readonly reminder?: number
  readonly summary?: string
}

const pageOf = (alert: Alerts.Alert): Page => ({
  alertId: Alerts.alertId({ coalescingKey: alert.coalescingKey, since: alert.since }),
  condition: alert.condition,
  severity: alert.severity,
  since: new Date(alert.since).toISOString(),
  ...(alert.reminder === undefined ? {} : { reminder: alert.reminder }),
  ...(alert.summary === undefined ? {} : { summary: alert.summary })
})

/**
 * What `alerts report` reads.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReportOptions {
  readonly runId: string
  readonly probe: string
  readonly state: Alerts.ProbeState
  readonly summary?: string | undefined
}

/**
 * What one report did: where its page went and what the tick that followed
 * it decided. A page the channel refused is in `failed` and goes out on the
 * next report.
 *
 * @category models
 * @since 1.0.0
 */
export interface ReportOutcome {
  readonly runId: string
  readonly probe: string
  readonly state: Alerts.ProbeState
  readonly destination: Destination
  readonly note?: string
  readonly delivered: ReadonlyArray<Page>
  readonly failed: ReadonlyArray<Page>
  readonly refused: ReadonlyArray<Page>
  readonly suppressed: ReadonlyArray<Page>
}

/**
 * Journals one probe result into the owning run, then ticks the run so an
 * alert that has waited long enough pages.
 *
 * A failing probe is not a failing command: the outcome says what was paged.
 * The command fails only when the journal does, or the policy file is bad.
 *
 * @param options the probe result
 * @param globals the shared guard's inputs
 * @category operations
 * @since 1.0.0
 */
export const report = (options: ReportOptions, globals: Globals.Options) =>
  Effect.gen(function*() {
    yield* Globals.guard(globals)
    const config = yield* readConfig()
    yield* Alerts.report(options)
    const selected = sinkFor(config, globals.environment ?? process.env)
    const policy = policyFor(config, yield* reportedProbes(options.runId))
    // With no channel the run is not ticked. A sink that drops the page would
    // journal it as delivered, and a destination configured later would then
    // never page about it; untouched, the alert stays `raised` until one does.
    const tick: Alerts.Tick = selected.destination === "none"
      ? { delivered: [], failed: [], refused: [], suppressed: [] }
      : yield* Effect.flatMap(Alerts.AlertRuntime, (alerts) => alerts.tick(options.runId)).pipe(
        Effect.provide(runtimeOf(policy, selected.sink))
      )
    return {
      runId: options.runId,
      probe: options.probe,
      state: options.state,
      destination: selected.destination,
      ...(selected.destination === "none" ? { note: selected.note } : {}),
      delivered: tick.delivered.map(pageOf),
      failed: tick.failed.map(pageOf),
      refused: tick.refused.map(pageOf),
      suppressed: tick.suppressed.map(pageOf)
    } satisfies ReportOutcome
  })

/** The alert runtime for reading and acknowledging, which never pages. */
const quiet = Effect.fnUntraced(function*(runId: string) {
  const config = yield* readConfig()
  return runtimeOf(policyFor(config, yield* reportedProbes(runId)), Alerts.layerNoop)
})

/**
 * One alert a run has open, as `alerts list` prints it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Listed extends Page {
  readonly state: Alerts.Standing["state"]
  readonly acknowledgedBy?: string
}

/**
 * The alerts a run has open now: every open condition past its delay, with
 * whether it was delivered and who acknowledged it.
 *
 * @param runId the owning run
 * @param globals the shared guard's inputs
 * @category operations
 * @since 1.0.0
 */
export const list = (runId: string, globals: Globals.Options) =>
  Effect.gen(function*() {
    yield* Globals.guard(globals)
    const standing = yield* Effect.flatMap(Alerts.AlertRuntime, (alerts) => alerts.standing(runId)).pipe(
      Effect.provide(yield* quiet(runId))
    )
    return {
      runId,
      alerts: standing.map((item): Listed => ({
        ...pageOf(item.alert),
        state: item.state,
        ...(item.acknowledgedBy === undefined ? {} : { acknowledgedBy: item.acknowledgedBy })
      }))
    }
  })

/**
 * What `alerts ack` reads. `by` defaults to the operating system's user name.
 *
 * @category models
 * @since 1.0.0
 */
export interface AckOptions {
  readonly runId: string
  readonly alertId: string
  readonly by?: string | undefined
}

/**
 * Records that a person has taken an open alert, so it is neither paged nor
 * repeated again. An id no open alert on the run has is refused: the probe
 * reported `ok` since, or the id names another run's alert.
 *
 * @param options the alert and the person
 * @param globals the shared guard's inputs
 * @category operations
 * @since 1.0.0
 */
export const acknowledge = (options: AckOptions, globals: Globals.Options) =>
  Effect.gen(function*() {
    yield* Globals.guard(globals)
    const by = options.by ?? (yield* Effect.try({
      try: () => userInfo().username,
      catch: () => usage("Cannot read the operating system user name; pass --by")
    }))
    const taken = yield* Effect.flatMap(
      Alerts.AlertRuntime,
      (alerts) => alerts.acknowledge(options.runId, options.alertId, by)
    ).pipe(Effect.provide(yield* quiet(options.runId)))
    if (!taken) {
      return yield* new CliError.Refused({
        fault: "user",
        code: "alert_not_open",
        message:
          `No open alert on run ${options.runId} has the id ${options.alertId}; the probe may have reported ok since`
      })
    }
    return { runId: options.runId, alertId: options.alertId, by, acknowledged: true }
  })

const line = (label: string, pages: ReadonlyArray<Page>) =>
  pages.map((page) =>
    `${label}: ${page.condition} ${page.alertId}${page.reminder === undefined ? "" : ` (reminder ${page.reminder})`}`
  )

/**
 * The lines a person reads after `alerts report`.
 *
 * @param outcome what the report did
 * @category formatting
 * @since 1.0.0
 */
export const renderReport = (outcome: ReportOutcome): string =>
  [
    `Recorded ${outcome.probe} ${outcome.state} on ${outcome.runId}.`,
    ...line(`Delivered by ${outcome.destination}`, outcome.delivered),
    ...line("Not delivered, retried on the next report", outcome.failed),
    ...line("Refused, the run's inbox is full", outcome.refused),
    ...line("Already paged or acknowledged", outcome.suppressed),
    ...(outcome.note === undefined ? [] : [`${outcome.note[0]!.toUpperCase()}${outcome.note.slice(1)}.`])
  ].join("\n")

/**
 * The lines a person reads after `alerts list`: one row per open alert.
 *
 * @param listing the run's open alerts
 * @category formatting
 * @since 1.0.0
 */
export const renderList = (listing: { readonly runId: string; readonly alerts: ReadonlyArray<Listed> }): string =>
  listing.alerts.length === 0
    ? `No open alerts on ${listing.runId}.`
    : listing.alerts.map((alert) =>
      [
        alert.condition,
        alert.state,
        alert.acknowledgedBy ?? "-",
        alert.since,
        alert.alertId,
        alert.summary ?? ""
      ].join("  ").trimEnd()
    ).join("\n")
