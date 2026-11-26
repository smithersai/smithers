import { Action } from "@smthrs/flow"
import { TabChannel } from "@smthrs/platform-browser"
import { Context, Effect, Exit, Layer, Metric, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { afterEach, describe, expect, test } from "vitest"
import { runFlow } from "../../../worker/test/flowHost"
import { TabRequests } from "../../flows/requests.vibe"
import { RepoClient } from "./api"
import { Clipboard } from "../../clipboard.vibe"
import { clipboardChannel } from "./contract"
import * as Copy from "./copy"
import { RepoCopy } from "./flows.vibe"
import { copies } from "./metrics"
import { readerLayer } from "./reader.vibe"
import { tabClipboard } from "./tab.vibe"

// `repo/copy` over the engine's clipboard channel, on Node's own `BroadcastChannel`: which tab writes, the door it
// reports, and what the step ignores. The whole tab, with RepoApi's real handler, is in repo.test.ts.

// Nothing listens here, so a read RepoApi would answer fails at once.
const ORIGIN = "http://127.0.0.1:9"
const scopes: Array<Scope.Closeable> = []
afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void))
})

/** A tab on engine `name` that started `requests`, each through the composer; its clipboard keeps what it got. */
const tab = async (name: string, requests: ReadonlyArray<string>) => {
  const copied: Array<string> = []
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  const context = await Effect.runPromise(
    Scope.provide(scope)(
      Layer.build(
        tabClipboard({ name }).pipe(
          Layer.provideMerge(TabRequests.layer()),
          Layer.provide(Clipboard.layer(async (text) => void copied.push(text))),
          Layer.provide(TabChannel.layer),
        ),
      ),
    ),
  )
  const added = Context.get(context, TabRequests)
  for (const request of requests) await Effect.runPromise(added.add(request, "composer"))
  return copied
}

/** `repo/copy` on the Node host, its clipboard over engine `name`'s channel; RepoApi is never reached here. */
const registration = (name: string, registry: Metric.MetricRegistry) =>
  Copy.registration.pipe(
    Layer.provide(readerLayer),
    Layer.provide(RepoClient.layer({ origin: ORIGIN, within: "1 second" }).pipe(Layer.provide(FetchHttpClient.layer))),
    Layer.provide(Copy.TabClipboard.layerChannel({ name, origin: ORIGIN, within: "2 seconds" })),
    Layer.provide(TabChannel.layer),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(Layer.succeed(Metric.MetricRegistry, registry)),
  )

const count = (registry: Metric.MetricRegistry, attributes: Record<string, string>) =>
  Effect.runSync(
    Metric.value(Metric.withAttributes(copies, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)),
  ).count

describe("repo/copy over the clipboard channel", () => {
  test("the agent's call writes the clipboard of the tab whose composer asked, and no other", async () => {
    const name = `copy-${crypto.randomUUID()}`
    const asking = await tab(name, ["answer-1"])
    const other = await tab(name, ["answer-2"])
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(RepoCopy, { repo: "octocat/Spoon-Knife", what: "clone-url" }, registration(name, registry), {
      executionId: "answer-1/chat/Respond@1/call/0.0",
    })
    expect(ran.exit).toEqual(Exit.succeed({ copied: true }))
    expect(asking).toEqual(["https://github.com/octocat/Spoon-Knife.git"])
    expect(other).toEqual([])
    expect(count(registry, { what: "clone-url", door: "agent", outcome: "copied" })).toBe(1)
  })

  test("a refused copy still learns its door from the tab, which writes nothing", async () => {
    const name = `copy-${crypto.randomUUID()}`
    const executionId = crypto.randomUUID()
    const copied = await tab(name, [executionId])
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(RepoCopy, { repo: "octocat/Spoon-Knife", what: "path" }, registration(name, registry), {
      executionId,
    })
    expect(Exit.isFailure(ran.exit)).toBe(true)
    expect(copied).toEqual([])
    expect(count(registry, { what: "path", door: "composer", outcome: "refused" })).toBe(1)
  })

  test("the agent's permalink without a kind: a file's when it names a path, else the root's", async () => {
    const name = `copy-${crypto.randomUUID()}`
    const sha = "a".repeat(40)
    const copied = await tab(name, ["answer-3"])
    const registry: Metric.MetricRegistry = new Map()
    for (const path of [{ path: "src/a.ts", line: 4 }, {}]) {
      await runFlow(RepoCopy, { repo: "octocat/Spoon-Knife", what: "permalink", revision: sha, ...path }, registration(name, registry), {
        executionId: `answer-3/call/${crypto.randomUUID()}`,
      })
    }
    expect(copied).toEqual([
      `${ORIGIN}/octocat/Spoon-Knife/blob/${sha}/src/a.ts?L=4`,
      `${ORIGIN}/octocat/Spoon-Knife/tree/${sha}`,
    ])
  })

  test("a file RepoApi can't serve now is unavailable, and nothing is copied", async () => {
    const name = `copy-${crypto.randomUUID()}`
    const executionId = crypto.randomUUID()
    const copied = await tab(name, [executionId])
    const registry: Metric.MetricRegistry = new Map()
    // This origin answers nothing: the read fails as unreachable.
    const ran = await runFlow(
      RepoCopy,
      { repo: "octocat/Spoon-Knife", what: "contents", revision: "a".repeat(40), path: "README.md" },
      registration(name, registry),
      { executionId },
    )
    expect(Exit.isFailure(ran.exit)).toBe(true)
    expect(copied).toEqual([])
    expect(count(registry, { what: "contents", door: "composer", outcome: "unavailable" })).toBe(1)
  })

  test("the step waits for its own reply: other replies and stray messages on the channel are ignored", async () => {
    const name = `copy-${crypto.randomUUID()}`
    const executionId = crypto.randomUUID()
    const copied = await tab(name, [executionId])
    // Something else on the channel answers every call first, with another id, and with junk.
    const noisy = new BroadcastChannel(clipboardChannel(name))
    noisy.onmessage = () => {
      noisy.postMessage("junk")
      noisy.postMessage({ kind: "smithers/asking-tab-reply", id: "another", door: "button", output: { copied: false } })
    }
    const registry: Metric.MetricRegistry = new Map()
    const ran = await runFlow(
      RepoCopy,
      { repo: "octocat/Spoon-Knife", what: "path", path: "README.md" },
      registration(name, registry),
      { executionId },
    )
    noisy.close()
    expect(ran.exit).toEqual(Exit.succeed({ copied: true }))
    expect(copied).toEqual(["README.md"])
    expect(count(registry, { what: "path", door: "composer", outcome: "copied" })).toBe(1)
  })
})
