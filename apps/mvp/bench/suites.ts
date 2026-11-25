// Chromium asks through the app's composer. A benchmark agent pairs over MCP and answers each question with its
// expected word after the Electric follower sees it. The app, ChatApi, Postgres and Electric all run normally.
import { Effect } from "effect"
import { usingResources } from "./resources.ts"
import type { Browser, BrowserContext, Page } from "@playwright/test"
import { attachBenchmarkAgent, type BenchmarkAgent, type Follower, initialSync, settled } from "./chatapi.ts"
import { installProbe, questionPosts, watchExchange, type BenchWindow, type Exchange, type Post } from "./probe.ts"
import { repo } from "./repo.ts"

export type Check = { suite: string; iteration: number; name: string; ok: boolean; detail?: string }

export type Recorder = {
  sample: (metric: string, ms: number) => void
  check: (suite: string, iteration: number, name: string, ok: boolean, detail?: string) => void
  // A browser-reported metric the browser didn't report for one iteration.
  missing: (metric: string) => void
  // An occurrence worth counting, not timing: an HTTP status, a 429, a failure.
  count: (name: string) => void
  detail: (suite: string, record: Record<string, unknown>) => void
}

export type Bench = {
  browser: Browser
  baseUrl: string
  // Iterations of the load suites and the suites that send questions (answer, sync).
  n: number
  nAnswer: number
  // The `concurrent` suite: this many asks at once, this many times.
  concurrency: number
  bursts: number
  runId: string
  // The run's newest question, which the load suite waits to see.
  newestWord: string
  // Listens to the shape for the whole run, as one more device.
  follower: Follower
  record: Recorder
}

const COMPOSER = 'textarea[aria-label="Message Smithers"]'
const ANSWER_TIMEOUT = 90_000
const LOAD_TIMEOUT = 60_000
// The browser's own limit for Electric to deliver an asked question (ChatConfig.confirmWithin).
const CONFIRM_TIMEOUT = 15_000
/** The expected answer is the unique word in the question. */
export const question = (word: string) => `Reply with exactly the word: ${word}`
const wordOf = (bench: Bench, stem: string) => `bench-${bench.runId}-${stem}`

const withAgent = async <A>(bench: Bench, context: BrowserContext, work: (agent: BenchmarkAgent) => Promise<A>) => {
  const agent = await attachBenchmarkAgent(context, bench.baseUrl)
  try {
    return await work(agent)
  } finally {
    await agent.revoke()
  }
}

// The answer to the question containing `word`, as Postgres settled it, seen by the follower.
const settledAnswer = (bench: Bench, word: string, timeoutMs = CONFIRM_TIMEOUT) =>
  bench.follower.until(
    () => {
      const asked = bench.follower.questionWith(word)
      return asked === undefined ? undefined : settled(bench.follower.answerTo(asked.id))
    },
    timeoutMs,
    `settled answer to ${word}`,
  )

// The question containing `word` as Electric delivered it to the follower, and when it arrived.
const delivered = (bench: Bench, word: string) =>
  bench.follower.until(
    () => {
      const row = bench.follower.questionWith(word)
      const seenAt = row === undefined ? undefined : bench.follower.timelines.get(row.id)?.seenAt
      return row === undefined || seenAt === undefined ? undefined : { row, seenAt }
    },
    CONFIRM_TIMEOUT,
    `question ${word}`,
  )

// The page's POST that ChatApi took (202). An earlier send may have failed; a resend of a stored question answers 200.
const takenBy = (posts: ReadonlyArray<Post>) => posts.find((post) => post.status === 202)

// A fresh browser context: a new device, with its own cookies, HTTP cache, OPFS (the device's conversation and its
// engine) and outbox. Under `alchemy dev` without the GitHub App, its requests are the local developer's, an Admin.
const newContext = async ({ browser, baseUrl, newestWord }: Bench) => {
  const context = await browser.newContext({ baseURL: baseUrl })
  try {
    await context.addInitScript(installProbe, newestWord)
    return context
  } catch (error) {
    await context.close()
    throw error
  }
}

const waitForLoad = (page: Page, untilNewest: boolean) =>
  page.waitForFunction(
    (untilNewest) => {
      const probe = (window as unknown as BenchWindow).__bench
      return probe.usableAt > 0 && (!untilNewest || probe.newestAt > 0)
    },
    untilNewest,
    { timeout: LOAD_TIMEOUT },
  )

const openApp = async (context: BrowserContext, untilNewest = true) => {
  const page = await context.newPage()
  await page.goto("/app", { waitUntil: "commit" })
  await waitForLoad(page, untilNewest)
  return page
}

const openComposer = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+k")
  await page.getByRole("textbox", { name: "Message Smithers" }).waitFor({ state: "visible" })
}

// Fills the asker's composer with the question for `word`, and has every watcher page record that exchange.
const prepare = async (asker: Page, word: string, watchers: ReadonlyArray<Page>) => {
  await asker.locator('form[data-slot="chat-composer"][data-status="ready"]').waitFor()
  await asker.getByRole("textbox", { name: "Message Smithers" }).fill(question(word))
  for (const page of watchers) await page.evaluate(watchExchange, word)
  await asker.evaluate(() => {
    ;(window as unknown as BenchWindow).__bench.enterAt = 0
  })
}

const send = (asker: Page) => asker.getByRole("textbox", { name: "Message Smithers" }).press("Enter")

// The asker's last Enter keydown and its `POST /api/questions` requests since, in absolute times. No keydown, no posts:
// an earlier ask's requests aren't this one's.
const sent = async (asker: Page) => {
  const enter = await asker.evaluate(() => (window as unknown as BenchWindow).__bench.enterAt)
  const posts = enter > 0 ? await asker.evaluate(questionPosts, enter) : []
  return { enterAt: (await asker.evaluate(() => performance.timeOrigin)) + enter, posts }
}

// Waits until every watcher page shows the answer to `word` done; returns each watcher's exchange with absolute times
// (timeOrigin + performance.now()).
const answered = async (word: string, watchers: ReadonlyArray<Page>) => {
  await Promise.all(
    watchers.map((page) =>
      page.waitForFunction((word) => ((window as unknown as BenchWindow).__bench.exchanges[word]?.completeAt ?? 0) > 0, word, {
        timeout: ANSWER_TIMEOUT,
      }),
    ),
  )
  return Promise.all(
    watchers.map((page) =>
      page.evaluate((word) => {
        const exchange = (window as unknown as BenchWindow).__bench.exchanges[word]!
        const origin = performance.timeOrigin
        return {
          ...exchange,
          questionAt: origin + exchange.questionAt,
          firstTextAt: origin + exchange.firstTextAt,
          completeAt: origin + exchange.completeAt,
          samples: exchange.samples.map((sample) => ({ at: origin + sample.at, text: sample.text })),
        } satisfies Exchange
      }, word),
    ),
  )
}

const respond = async (bench: Bench, agent: BenchmarkAgent, word: string) => {
  const { row } = await delivered(bench, word)
  await agent.respond(row.id, word)
}

// The composer submits the question, and the attached agent responds through MCP.
const ask = async (bench: Bench, agent: BenchmarkAgent, asker: Page, word: string, watchers: ReadonlyArray<Page>) => {
  await prepare(asker, word, watchers)
  await send(asker)
  await respond(bench, agent, word)
  const exchanges = await answered(word, watchers)
  return { ...(await sent(asker)), exchanges }
}

// Warm up the server, MCP and Electric and give the load and shape suites a newest message to find.
export const seed = async (bench: Bench) => {
  const context = await newContext(bench)
  try {
    const page = await openApp(context, false)
    await openComposer(page)
    await withAgent(bench, context, async (agent) => {
      const word = wordOf(bench, "seed")
      const { exchanges } = await ask(bench, agent, page, word, [page])
      const answer = exchanges[0]!.answerText
      bench.record.check("seed", 0, "answer contains the word", answer === word, answer)
      bench.newestWord = word
    })
  } finally {
    await context.close()
  }
}

// Page load of /app in a fresh context (cold), then a reload of that context (warm). A cold load syncs the conversation
// from Electric's shape; the reload restores it from the device (OPFS), Electric resuming from its stored offset, and
// may get the app's modules from the HTTP cache.
export const load = async (bench: Bench) => {
  const read = (page: Page) =>
    page.evaluate(async () => {
      // Two frames after the last mark, so the LCP candidate for that render has been reported.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const probe = (window as unknown as BenchWindow).__bench
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
      const fcp = performance.getEntriesByName("first-contentful-paint")[0]
      // The shape requests that finished before the conversation showed; the live long-poll is still open.
      const shapes = (performance.getEntriesByType("resource") as Array<PerformanceResourceTiming>).filter((entry) =>
        entry.name.includes("/api/shapes/messages"),
      )
      return {
        ttfb: navigation?.responseStart ?? Number.NaN,
        fcp: fcp?.startTime ?? Number.NaN,
        lcp: probe.lcp > 0 ? probe.lcp : Number.NaN,
        usable: probe.usableAt,
        newest: probe.newestAt,
        messages: probe.messages,
        shapeRequests: shapes.length,
        shapeRequestsFromCache: shapes.filter((entry) => entry.transferSize === 0 && entry.decodedBodySize > 0).length,
      }
    })
  for (let iteration = 0; iteration < bench.n; iteration++) {
    const context = await newContext(bench)
    try {
      const page = await openApp(context)
      const cold = await read(page)
      await page.reload({ waitUntil: "commit" })
      await waitForLoad(page, true)
      const warm = await read(page)
      for (const [kind, marks] of [["cold", cold], ["warm", warm]] as const) {
        for (const metric of ["ttfb", "fcp", "lcp", "usable", "newest"] as const) {
          const value = marks[metric]
          const reported = Number.isFinite(value) && value > 0
          if (reported) bench.record.sample(`load.${kind}.${metric}`, value)
          // Chromium decides what counts as a contentful paint (see docs/benchmarks.md); the app's own marks must exist.
          else if (metric === "fcp" || metric === "lcp") bench.record.missing(`load.${kind}.${metric}`)
          else bench.record.check("load", iteration, `${kind} ${metric} measured`, false, String(value))
        }
      }
      bench.record.detail("load", { iteration, cold, warm })
    } finally {
      await context.close()
    }
  }
}

// From the ⌘K keydown to the composer taking focus; Esc hides it again between presses.
export const cmdk = async (bench: Bench) => {
  const context = await newContext(bench)
  try {
    const page = await openApp(context)
    const chat = page.getByRole("button", { name: /Chat/ })
    for (let iteration = 0; iteration < bench.n; iteration++) {
      await chat.waitFor({ state: "visible" })
      await page.evaluate(() => {
        const probe = (window as unknown as BenchWindow).__bench
        probe.cmdKAt = 0
        probe.focusedAt = 0
      })
      await page.keyboard.press("ControlOrMeta+k")
      await page.waitForFunction(
        () => {
          const probe = (window as unknown as BenchWindow).__bench
          return probe.cmdKAt > 0 && probe.focusedAt > 0
        },
        null,
        { timeout: 10_000 },
      )
      const { cmdKAt, focusedAt, focused } = await page.evaluate((selector) => {
        const probe = (window as unknown as BenchWindow).__bench
        return { cmdKAt: probe.cmdKAt, focusedAt: probe.focusedAt, focused: document.activeElement?.matches(selector) === true }
      }, COMPOSER)
      bench.record.check("cmdk", iteration, "composer has focus", focused)
      bench.record.sample("cmdk.focus", focusedAt - cmdKAt)
      bench.record.detail("cmdk", { iteration, focus: focusedAt - cmdKAt })
      await page.keyboard.press("Escape")
    }
  } finally {
    await context.close()
  }
}

// What a new device fetches first, from Node: GET /api/shapes/messages from offset -1 to up-to-date. The proxy fixes
// the shape to the whole `messages` table, so N is the shared conversation's size, recorded with each iteration.
export const shape = async (bench: Bench) => {
  for (let iteration = 0; iteration < bench.n; iteration++) {
    const sync = await initialSync(bench.baseUrl)
    const texts = [...sync.rows.values()].map((row) => row.text ?? "")
    bench.record.check("shape", iteration, "the snapshot holds the run's newest question", texts.some((text) => text.includes(bench.newestWord)))
    bench.record.sample("shape.initial_sync", sync.ms)
    bench.record.detail("shape", {
      iteration,
      ms: sync.ms,
      rows: sync.rows.size,
      operations: sync.operations,
      requests: sync.requests,
      bytes: sync.bytes,
    })
  }
}

// Time the composer submission, ChatApi's 202 and Electric's question and answer delivery. The MCP fixture writes
// one terminal answer, so its latency uses separate metric names from the earlier streaming model workload.
export const answer = async (bench: Bench) => {
  const context = await newContext(bench)
  try {
    const page = await openApp(context)
    await openComposer(page)
    await withAgent(bench, context, async (agent) => {
      for (let iteration = 0; iteration < bench.nAnswer; iteration++) {
        const word = wordOf(bench, `a${iteration}`)
        const { enterAt, posts, exchanges } = await ask(bench, agent, page, word, [page])
        const row = await settledAnswer(bench, word)
        const asked = await delivered(bench, word)
        const taken = takenBy(posts)
        const exchange = exchanges[0]!
        const check = (name: string, ok: boolean, detail?: string) => bench.record.check("answer", iteration, name, ok, detail)
        check("question shown as asked", exchange.questionText === question(word), exchange.questionText)
        check("ChatApi took the question (202)", taken !== undefined, `HTTP ${posts.map((post) => post.status).join(", ")}`)
        check("Electric delivered the question as asked", asked.row.text === question(word), asked.row.text)
        check("answer contains the word", exchange.answerText.includes(word), exchange.answerText)
        check("the answer row settled done", row.status === "done", `${row.status} ${row.failure ?? ""}`)
        bench.record.sample("answer.question", exchange.questionAt - enterAt)
        if (taken !== undefined) {
          bench.record.sample("answer.accepted", taken.responseAt - taken.startAt)
          bench.record.sample("answer.confirmed", asked.seenAt - taken.startAt)
        }
        bench.record.sample("answer.mcp_first_text", exchange.firstTextAt - enterAt)
        bench.record.sample("answer.mcp_done", exchange.completeAt - enterAt)
        bench.record.detail("answer", {
          iteration,
          word,
          answer: exchange.answerText,
          states: exchange.samples.length,
          posts: posts.map((post) => post.status),
          question: exchange.questionAt - enterAt,
          accepted: taken === undefined ? null : taken.responseAt - taken.startAt,
          confirmed: taken === undefined ? null : asked.seenAt - taken.startAt,
          firstText: exchange.firstTextAt - enterAt,
          done: exchange.completeAt - enterAt,
        })
      }
    })
  } finally {
    await context.close()
  }
}

// Electric fan-out: two devices (separate browser contexts). A asks; from A's Enter keydown to the question in B's DOM,
// and to the answer done on B. The attached agent writes through MCP and both pages receive it from Electric.
export const sync = async (bench: Bench) => {
  return Effect.runPromise(usingResources(
    Effect.tryPromise(() => newContext(bench)),
    (context) => Effect.promise(() => context.close()),
    2,
    ([contextA, contextB]) => Effect.tryPromise(async () => {
      const [a, b] = await Promise.all([openApp(contextA!), openApp(contextB!)])
      await openComposer(a)
      await withAgent(bench, contextA!, async (agent) => {
        for (let iteration = 0; iteration < bench.nAnswer; iteration++) {
          const word = wordOf(bench, `s${iteration}`)
          const { enterAt, exchanges } = await ask(bench, agent, a, word, [a, b])
          await settledAnswer(bench, word)
          const [onA, onB] = exchanges as [Exchange, Exchange]
          bench.record.check("sync", iteration, "B shows the question as asked", onB.questionText === question(word), onB.questionText)
          bench.record.check("sync", iteration, "A's answer contains the word", onA.answerText.includes(word), onA.answerText)
          bench.record.check("sync", iteration, "B's answer matches A's", onB.answerText === onA.answerText, onB.answerText)
          bench.record.sample("sync.question", onB.questionAt - enterAt)
          bench.record.sample("sync.mcp_answer_done", onB.completeAt - enterAt)
          bench.record.detail("sync", {
            iteration,
            word,
            answer: onA.answerText,
            question: onB.questionAt - enterAt,
            doneOnA: onA.completeAt - enterAt,
            doneOnB: onB.completeAt - enterAt,
          })
        }
      })
    }),
  ))
}

/** A server answer is successful only after the asking browser displays completion. */
export const concurrentOK = (wait: PromiseSettledResult<unknown>, serverOK: boolean) => wait.status === "fulfilled" && serverOK

// Multiple browsers submit at once. Each answer is written through the attached session after its question arrives
// in Electric. Each browser must display the completed answer before the burst's check can pass.
export const concurrent = async (bench: Bench) => {
  return Effect.runPromise(usingResources(
    Effect.tryPromise(() => newContext(bench)),
    (context) => Effect.promise(() => context.close()),
    bench.concurrency,
    (contexts) => Effect.tryPromise(async () => {
      const pages = await Promise.all(contexts.map((context) => openApp(context)))
      for (const page of pages) await openComposer(page)
      await withAgent(bench, contexts[0]!, async (agent) => {
        for (let burst = 0; burst < bench.bursts; burst++) {
          const words = pages.map((_, index) => wordOf(bench, `c${burst}x${index}`))
          await Promise.all(pages.map((page, index) => prepare(page, words[index]!, [page])))
          await Promise.all(pages.map(send))
          const waits = await Promise.allSettled(pages.map(async (page, index) => {
            const word = words[index]!
            await respond(bench, agent, word)
            return answered(word, [page])
          }))
          for (const [index, page] of pages.entries()) {
            const word = words[index]!
            const iteration = burst * bench.concurrency + index
            const wait = waits[index]!
            const { posts } = await sent(page)
            const asked = await delivered(bench, word).catch(() => undefined)
            const answer = asked === undefined ? undefined : await settledAnswer(bench, word).catch(() => undefined)
            const taken = takenBy(posts)
            const settledAt = answer === undefined ? 0 : (bench.follower.timelines.get(answer.id)?.settledAt ?? 0)
            bench.record.count("concurrent.asks")
            for (const post of posts) bench.record.count(`concurrent.http.${post.status}`)
            if (taken !== undefined) bench.record.sample("concurrent.accepted", taken.responseAt - taken.startAt)
            if (taken !== undefined && asked !== undefined) bench.record.sample("concurrent.confirmed", asked.seenAt - taken.startAt)
            bench.record.detail("concurrent", {
              iteration,
              burst,
              word,
              posts: posts.map((post) => post.status),
              accepted: taken === undefined ? null : taken.responseAt - taken.startAt,
              confirmed: taken === undefined || asked === undefined ? null : asked.seenAt - taken.startAt,
              settled: taken === undefined || settledAt === 0 ? null : settledAt - taken.startAt,
              answer: answer?.text ?? null,
              answerStatus: answer?.status ?? null,
              failure: answer?.failure ?? null,
              ...(wait.status === "rejected" ? { error: String(wait.reason).split("\n")[0] } : {}),
            })
            bench.record.check("concurrent", iteration, "browser displays completion", wait.status === "fulfilled",
              wait.status === "rejected" ? String(wait.reason).split("\n")[0] : undefined)
            const done = answer?.status === "done"
            if (taken !== undefined && done) bench.record.sample("concurrent.mcp_done", settledAt - taken.startAt)
            const ok = concurrentOK(wait, taken !== undefined && asked !== undefined && done && answer.text?.includes(word) === true)
            if (!ok) bench.record.count("concurrent.failed")
            bench.record.check(
              "concurrent",
              iteration,
              "taken, confirmed and answered with the word",
              ok,
              wait.status === "rejected"
                ? String(wait.reason).split("\n")[0]
                : `HTTP ${posts.map((post) => post.status).join(", ")}, answer ${answer?.status} ${answer?.failure ?? ""} ${answer?.text ?? ""}`,
            )
          }
        }
      })
    }),
  ))
}

export const SUITES = { load, cmdk, shape, repo, answer, sync, concurrent } as const
export type SuiteName = keyof typeof SUITES
