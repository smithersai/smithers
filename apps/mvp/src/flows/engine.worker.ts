// First: the worker's first session read starts before the rest of its bundle evaluates
// (src/flows/sessionStart.worker.ts).
import { started as sessionStarted } from "./sessionStart.worker"
import wasmUrl from "@journeyapps/wa-sqlite/dist/wa-sqlite.wasm?url"
import { Migrations } from "@smthrs/effect-tanstack-db"
import type { Model } from "@smthrs/model"
import { BrowserRuntime, type SharedSqlite } from "@smthrs/platform-browser"
import { Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { answer, authorizeDevice, boundFetch, IDENTITY_MESSAGE, type Receipt, sessionNow, VISITOR } from "../device/identity"
import { deviceRegistry } from "../device/registry"
import { getSession } from "../features/auth/api"
import { NO_DEVICE_DATA, SESSION_ROUTE } from "../features/auth/contract"
import { ENGINE_NAME } from "./contract"
import { firstReadFrom } from "./sessionRead"
import { clientFlows } from "./declarations"
import { engineRequests, engineTelemetry } from "./engine"
import { workerRegistrations } from "./registrations"

// The engine worker each tab starts (src/flows/engine.ts `tabEngine`): a program boundary, like src/main.tsx, which
// hands the host's capabilities to the program. It, not the tab, imports every client flow's declaration and steps, the
// agent's included. The worker whose tab holds the engine's Web Lock runs every client flow over SQLite in OPFS
// (decision 0011); the others wait their turn. It reaches ChatApi on the page's origin, and this device's collections
// through its own tab. Its logs, spans and metrics go to ChatApi's relay, as the tab's do.

// Whose data the device holds (src/device/identity.ts): checked before the engine starts and sent to this worker's tab
// and every waiting tab. While this worker leads, a tab about to follow it asks, and gets the receipt checked against
// the browser's session now. A refused check stops the engine, so this worker never leads and answers no one. Every
// request this worker makes to ChatApi carries the owner.
let receipt: Receipt | undefined
const identity = new BroadcastChannel(IDENTITY_MESSAGE)
const unbound = self.fetch.bind(self)
// Under the dev server, the end-to-end tests' parameters, which main.tsx names this worker with (`dev:<parameters>`).
const dev = import.meta.env.DEV && self.name.startsWith("dev:") ? new URLSearchParams(self.name.slice("dev:".length)) : undefined
const scripted = dev?.get("agent") ?? undefined
const faulted = dev?.get("faults") === "session-503"
// Who the browser is signed in as, read for the device's owner check; behind the page's switch under
// `?faults=session-503` (src/test/authFaults.ts). The first read takes the one the worker started as it loaded
// (src/flows/sessionRead.ts), except behind that switch, whose refused reads never reach it.
let session = getSession(self.location.origin, "10 seconds").pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(
    FetchHttpClient.Fetch,
    firstReadFrom(unbound, `${self.location.origin}${SESSION_ROUTE}`, faulted ? undefined : sessionStarted),
  ),
)
// While this worker leads: the device store its activation checked, which it checks again to adopt a visitor's data.
let database: SharedSqlite.Service | undefined
const report = (owner: string | undefined, outcome: string, continuous: boolean) => {
  // `continuous`: the owner held the data before this activation. An adopted visitor's data never is, so the
  // person who adopts it never owns the outbox's writes stored before writes named who queued them.
  receipt = { _tag: IDENTITY_MESSAGE, owner, outcome, ...(continuous ? { continuous: true } : {}) }
  self.postMessage(receipt)
  identity.postMessage(receipt)
}
// A page saw the session name a person on the visitor's data this worker opened (decision 0023, "Adopting in
// place"): the owner check again, which claims the data for them, and its receipt to every tab, which takes the owner
// with no reload. Not now (ChatApi couldn't say), the visitor's receipt again; anything else, the receipt as it is.
const adopt = (opened: Receipt) => Effect.gen(function* () {
  if (opened.owner !== VISITOR || database === undefined) return identity.postMessage(opened)
  const checked = yield* Effect.exit(authorizeDevice({ database, session, report }))
  if (checked._tag === "Failure" && receipt === opened) identity.postMessage({ ...opened, outcome: "unavailable" })
})
// This listener belongs to the existing BrowserRuntime program, including its scope and telemetry. Requests are
// handled in order; adopting never starts a second runtime from a BroadcastChannel callback.
const identityRequests = Layer.effectDiscard(
  Stream.fromEventListener<MessageEvent>(identity, "message").pipe(
    Stream.runForEach((event) => Effect.gen(function* () {
      const opened = receipt
      if (opened?.owner === undefined) return
      if (event.data?.request === "adopt") return yield* adopt(opened)
      if (event.data?.request !== true) return
      const current = yield* Effect.promise(() =>
        unbound(`${self.location.origin}${SESSION_ROUTE}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) })
          .then(sessionNow, () => "unreachable" as const),
      )
      identity.postMessage(answer(opened, current))
    })),
    Effect.forkScoped({ startImmediately: true }),
  ),
)
self.fetch = boundFetch(unbound, { origin: self.location.origin, principal: () => receipt?.owner ?? NO_DEVICE_DATA })

const run = (model?: Model.Model, summaryModel?: Model.Model, rendererModel?: Model.Model) =>
  BrowserRuntime.run({
    name: ENGINE_NAME,
    // The SQLite build loads only once this worker leads, and only in this worker's bundle.
    sqlite: {
      module: () => import("@journeyapps/wa-sqlite/dist/wa-sqlite.mjs"),
      wasm: () => fetch(wasmUrl).then((response) => response.arrayBuffer()),
    },
    flows: clientFlows,
    // Before it serves the device store to any tab, the leader brings it to this build's versions, once per epoch, as
    // the durable flow `device/prepare` (decision 0021).
    prepare: Migrations.prepare(deviceRegistry),
    // Before the engine exists, every time this worker is about to lead, whose data the device holds.
    authorize: (opened) =>
      authorizeDevice({
        database: opened,
        session,
        report: (owner, outcome, continuous) => {
          database = opened
          report(owner, outcome, continuous)
        },
      }),
    // `http:` pages on this machine open only under the dev server (src/features/web/url.ts).
    registerFlows: workerRegistrations(self, {
      origin: self.location.origin,
      name: ENGINE_NAME,
      localHttp: import.meta.env.DEV,
      ...(model === undefined ? {} : { model }),
      ...(summaryModel === undefined ? {} : { summaryModel }),
      ...(rendererModel === undefined ? {} : { rendererModel }),
    }),
    telemetry: identityRequests.pipe(
      Layer.provideMerge(engineRequests(self.location.origin)),
      Layer.provideMerge(engineTelemetry(self.location.origin)),
    ),
  })

// Under the dev server, `?agent=<script>` answers with a scripted model for the end-to-end tests
// (src/test/scriptedAgent.ts), and `?faults=session-503` opens the session read refused until the page heals it
// (src/test/authFaults.ts). A production build drops these branches, and the modules with them.
if (scripted === undefined && !faulted) run()
else {
  void Promise.all([
    faulted ? import("../test/authFaults").then((faults) => void (session = faults.faultySession(session, true))) : undefined,
    scripted === undefined ? undefined : Promise.all([import("../test/scriptedAgent"), import("../test/scriptedSummary")]),
  ]).then(([, models]) =>
    models === undefined ? run() : run(models[0].scriptedModel(scripted!), models[1].scriptedSummary, models[0].scriptedRenderer)
  )
}
