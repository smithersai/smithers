# Benchmarks

`pnpm bench` measures the chat app against `alchemy dev` or any deployment, in real Chromium and over plain HTTP from Node. Nothing is mocked: it uses the real app and its agent, the ChatApi Worker, Postgres, Electric and the model. Every question is asked through a page's composer, and that page's own agent answers it ([agent.md](features/agent.md)). It checks every answer and compares the run with a baseline.

## Run it

| Where | Command |
|---|---|
| Local | Start `pnpm db:up` and `pnpm dev` (`alchemy dev`, http://localhost:1337), then run `pnpm bench`. |
| Live | `BASE_URL=https://<host> pnpm bench` |

- The bench never starts or restarts the server. It waits up to 120 s for `<BASE_URL>/app`, then exits. If `GET /api/shapes/messages?offset=now` fails, it exits at once.
- A default run asks 19 questions (1 + 2 × 5 + 4 × 2) in the shared conversation that everyone sees. Each answer is one agent run, of one model call or more, through the deployment's model endpoint and key.
- **Asking needs a Member.** The bench's pages carry no session. Under `alchemy dev` without the GitHub App's credentials, every page is the local developer, an Admin, and asks. Wherever sign-in is real (a deployment, or `alchemy dev` with the App configured) the pages are signed out: the seed can't ask, so no suite runs. A live run needs a session the bench doesn't carry yet.

| Option | Environment | Default | |
|---|---|---|---|
| `--n <count>` | `BENCH_N` | `10` | Iterations of the suites that don't ask the model: `load`, `cmdk`, `shape` and `repo`. |
| `--n-answer <count>` | `BENCH_N_ANSWER` | `5` | Iterations of the suites that ask the model: `answer` and `sync`. |
| `--concurrency <P>` | `BENCH_CONCURRENCY` | `4` | Devices that ask at once in the `concurrent` suite. |
| `--bursts <count>` | `BENCH_BURSTS` | `2` | How many times `concurrent`'s P devices ask at once. |
| `--only <suites>` | | `load,cmdk,shape,repo,answer,sync,concurrent` | Suites to run, comma-separated. |
| `--threshold <fraction>` | `BENCH_THRESHOLD` | `0.25` | Slowdown that counts as a regression. |
| `--floor-ms <ms>` | `BENCH_FLOOR_MS` | `5` | A regression must also be this many ms slower. |
| `--update-baseline` | | off | Make this run the baseline for its `BASE_URL`. |
| | `BASE_URL` | `http://localhost:1337` | Where the app runs. |

| Exit code | Meaning |
|---|---|
| 0 | Every check passed and nothing regressed, or the baseline was updated. |
| 1 | A correctness check failed, or a p50 or p95 regressed. |
| 2 | Bad option, or the server or its shape never answered. |

The bench's own tests: `node --test bench/`. Typecheck: `tsc -p bench`.

## Method

A run starts one headless Chromium and one **follower**. The follower is a Node client that follows the `messages` shape live through ChatApi's proxy for the whole run, from `offset=now`. It records when Electric delivers each row and each change to it. The run asks a seed question, then runs the suites in order: `load`, `cmdk`, `shape`, `repo`, `answer`, `sync` and `concurrent`. Nothing records video or traces.

**Pages ask; Node never does.** A question is asked as a person asks it: the composer, the outbox's `POST /api/questions`, and that tab's agent (`chat/Answer` on its engine worker) answering through `POST /api/model/agent` and `/api/answers/<id>`. ChatApi only stores a question and its empty `streaming` answer. Nothing would answer a question Node posted, and its `streaming` answer would hold up every later answer, the bench's and everyone else's, for up to `ANSWER_TURN_LIVE_SECONDS` (30 s; [agent.md](features/agent.md#turn-by-turn)). So the `POST` timings come from the asking page's Resource Timing, and Electric's delivery from the follower.

**Seed.** A throwaway page asks one question (`bench-<run>-seed`) and its timings are discarded. This warms the dev server's module transforms, the model endpoint and Electric. It also gives the `load` and `shape` suites a newest message to look for. If the seed's answer fails its check, no suite runs.

**Each context is a new device.** A browser context has its own OPFS, so it keeps its own copy of the conversation (SQLite on OPFS), its own engine and its own outbox ([chat.md](features/chat.md#how-it-works)). A cold load opens a new context and syncs the conversation from Electric's shape. A warm load reloads that context: the conversation comes from the device while Electric resumes from its stored offset, and the HTTP cache may hold the app's modules.

| Metric | Suite, where | Start | End |
|---|---|---|---|
| **Cold load** | `load`, page | Navigation start in a new browser context, with no HTTP cache, cookies or device storage | |
| TTFB | | | `responseStart` of the navigation entry |
| FCP | | | Chromium's `first-contentful-paint` entry |
| LCP | | | The last `largest-contentful-paint` entry, read once chat is usable |
| Chat usable | | | The Chat ⌘K button is in the DOM: the app's shell, which renders from the device without waiting for the network |
| Newest message shown | | | The seed question is in the conversation: from Electric on a cold load, from the device on a warm one |
| **Warm load** | `load`, page | A reload of the same context. The conversation comes from the device, and Electric resumes from its stored offset. The HTTP cache may hold the app's modules. | The same five marks |
| **⌘K** | `cmdk`, page | `timeStamp` of the ⌘K `keydown` | The composer receives `focusin`. Esc hides it between presses. |
| **Shape initial sync** | `shape`, Node | `GET /api/shapes/messages?offset=-1`, with no handle | The response that ends with `up-to-date`, after following `electric-offset` and `electric-handle` |
| **UI: ask to question shown** | `answer`, page | `timeStamp` of the Enter `keydown` | The question is in the asking page's DOM: TanStack DB's optimistic insert |
| **UI: the page's POST to 202** | | The page's `POST /api/questions` starts (Resource Timing's `startTime`) | The first byte of the response ChatApi answered `202` (`responseStart`) |
| **UI: the page's POST to the question from Electric** | | Same | The follower receives the question's row |
| **UI: ask to first answer text / to done** | | The Enter `keydown` | The answer shows its first text, and its `data-streaming` turns `false`. The page's agent writes both through ChatApi's answer routes; Electric delivers them. |
| **Fan-out: question, A to B** | `sync`, two pages | A's Enter `keydown` | The question is in B's DOM |
| **Fan-out: answer done on B** | | Same | B's answer turns `data-streaming="false"` |
| **Repositories shape initial sync** | `repo`, Node | `GET /api/shapes/repositories?offset=-1` | The response that ends with `up-to-date` (`repo.shape.initial_sync`) |
| **Tree and README reads** | `repo`, Node | `GET /api/repos/octocat/Spoon-Knife/tree/<head>` and `/blob/<head>/README.md` sent | The whole body read. The first iteration (`repo.tree.first`, `repo.blob.first`) may read Code Storage; the rest are the immutable cache's (`repo.tree.cached`, `repo.blob.cached`). Without a ready `octocat/Spoon-Knife` (`e2e/repo.spec.ts` clones it) the suite only counts `repo.not_ready`. |
| **Concurrent asks: POST to 202 / to the question / to done** | `concurrent`, P pages | Each page's `POST /api/questions` starts, after P Enter presses at once | Its `202`'s first byte; the follower receiving the question's row; the follower receiving the answer settled. Each burst starts once the last burst's answers are done. |

`concurrent` also counts the status of each page's `POST /api/questions` (resends included), each answer the model refused with 429, and each failure.

- **Two devices.** A and B are separate browser contexts. Each holds its own copy of the conversation and its own Electric long-poll. A's agent writes the answer through ChatApi; both pages show it as Electric delivers it.
- **Answers come in turn** ([agent.md](features/agent.md#turn-by-turn)). An answer waits while an earlier `streaming` answer in the shared conversation is live. `answer` and `sync` ask one question at a time, so they wait only for other people's answers. In `concurrent`, a burst's P answers settle one after another: each `done` includes the answers before it, and `chat/LoadTurn`'s retries (250 ms, doubling to 4 s) between them.
- **Clocks.** Every time is compared as `performance.timeOrigin + performance.now()`, both in the pages and in Node. Everything runs on one machine and shares its clock.
- **"Shown"** means the element reached the DOM. A `MutationObserver` callback runs right after React commits, and the frame paints within one frame after that.
- **Event timestamps.** `event.timeStamp` is when the browser created the input event, so input delay counts.
- **Unique words.** The conversation is shared and persistent, so every question asks for a unique word: `bench-<run id>-<suite letter><i>`, as in `-a3`, `-s0` or `-c0x2`.
- **Statistics.** p50 and p95 use linear interpolation between the closest ranks (NumPy's default) and are reported with min and max. At N=10, p95 lies between the 9th and 10th slowest samples. At N=5 it lies between the 4th and 5th, which is nearly the max.

The code:

| File | Holds |
|---|---|
| `bench/probe.ts` | The in-page instrumentation, and the page's `POST /api/questions` timings from Resource Timing |
| `bench/chatapi.ts` | The Node side: the shape's initial sync and the follower |
| `bench/suites.ts` | The suites |
| `bench/repo.ts` | The `repo` suite: the repositories shape and RepoApi's reads |
| `bench/stats.ts` | The statistics and the baseline comparison |

The bench relies on these contracts. A change that breaks one fails a check or times out:

- **UI:**
  - the `Conversation` region;
  - `article[data-role]` messages, with the answer right after its question;
  - `[data-slot="message-response"][data-streaming]`;
  - the composer form's `data-status`;
  - the "Message Smithers" textbox;
  - the Chat button with `aria-keyshortcuts`;
  - the composer for a page that may ask: a Member or above, the local developer under `alchemy dev` without the GitHub App.
- **HTTP** ([chat.md](features/chat.md#contract)):
  - The page's outbox is the only thing that requests `/api/questions`, from the page itself, so Chromium's Resource Timing lists it with its status (`responseStatus`). ChatApi answers a new question `202`.
  - `GET /api/shapes/messages` speaks Electric's protocol: `offset=-1`, `offset=now`, `live`, `handle` and `cursor` in the request, and `electric-offset` and `electric-handle` in the response.

## Correctness checks

Every iteration checks its result, and any failed check fails the run.

- Every answer contains the word it was asked for, on the page and in the answer row Electric delivered.
- The question appears exactly as asked: on the asking page, on B in `sync`, and in the row Electric delivered in `answer`.
- B's finished answer equals A's.
- Every answer row settles `done`.
- ChatApi answers the page's `POST /api/questions` with `202`, and Electric delivers the question, in `answer` and `concurrent`.
- The shape's initial sync holds the run's newest question.
- After ⌘K, the composer has focus.
- Each load reports TTFB, chat usable and newest message shown.

**429s.** An answer the model refused with 429 (`failure: rate_limited`) is not a latency sample.

- **`seed`, `answer` and `sync`:** the follower reads the answer's `failure`. On a 429, the iteration backs off 30 s and asks again with a new word (`…r1`). On a second 429 it backs off 60 s, and a third fails the check. The summary reports the 429s.
- **`concurrent`:** an answer the model refused with 429 is counted, not failed, and the next burst backs off 30 s. Any other failure fails the check: no `POST` answered `202`, a question Electric didn't deliver within 15 s, an answer not done within 90 s, an answer that failed, or an answer without its word.

A failed run still writes its results file, with `"ok": false` and the failures. It isn't compared with the baseline, and it exits 1. Chromium decides what counts as a contentful paint, so a missing FCP or LCP doesn't fail the run; the summary reports how often each was missing.

## Output

- **The terminal** shows:
  - a Markdown table with n, p50, p95, min and max per metric, and the change from the baseline;
  - the `concurrent` counts;
  - the checks and any regressions.
- **`bench/results/<timestamp>.json`** holds:
  - `env`: the jj commit (`jj log -r @ -T commit_id --no-graph`), base URL, server build (`vite-dev` or `built`), machine, OS, Chromium, Playwright, Node, date, every option, and the conversation's size: `conversationMessages` on the page, and `shape` (rows, operations, requests and bytes of its initial sync). It also records `follower` (`refetches` after an Electric 409, and request `errors`).
  - `metrics` (the summaries), `notReported`, `counts`, `checks` and `comparison`.
  - `samples`: every raw sample.
  - `details`, per iteration: each word, answer text and status, and the statuses of the asking page's `POST /api/questions`. For `load`, each page's shape requests and how many came from the HTTP cache.
- **Version control** ignores runs, except those listed in `bench/results/.gitignore`. `--update-baseline` adds the run it makes the baseline.

## Baseline and regressions

`bench/baseline.json` holds one baseline per `BASE_URL`: the p50 and p95 of every metric, plus the source run, commit, machine and server build.

- **Matching.** A run is compared only with the baseline for its own `BASE_URL`. If the baseline ran on another machine or server build, the summary warns.
- **Regression.** A statistic regresses when `current > baseline × (1 + threshold)` and `current − baseline > floor`. The floor keeps a 2 ms metric that moves to 3 ms from counting. Any regression exits 1.
- **Setting a baseline.** `pnpm bench --update-baseline` replaces the baseline for its `BASE_URL`, and only when every check passed.

**The baseline predates the browser's agent; re-record it.** It is `results/2026-10-20T00-25-19Z.json` ([First local results](#first-local-results)), recorded before the asking tab's agent answered, before the device kept the conversation in OPFS, and while the bench posted questions from Node. Until `pnpm bench --update-baseline` replaces it on a quiet machine, a comparison with it is not like for like, and may flag or hide regressions the change of method explains:

- `question.*` is gone. `answer.accepted` and `answer.confirmed` are new, timed from the page's `POST`, and have no baseline.
- `answer.first_text`, `answer.done`, `sync.answer_done` and `concurrent.done` now include the agent: its engine, its turn and the model endpoint. `concurrent.done` also includes the answers before it in its burst.
- `concurrent.accepted` and `concurrent.confirmed` start at the page's `POST`, not Node's.
- Loads changed too: the shell renders without waiting for the conversation, and a warm load restores the conversation from the device.

**Rerun.** `results/2026-10-20T00-40-21Z.json` ran 15 minutes after the baseline on the same machine. All 84 checks passed and nothing regressed. It isn't a clean noise measure: by then other work in progress had changed the working copy. Against the baseline:

- **Loads, ⌘K, shape sync and `POST` to 202:** p50 within ±8%, except warm TTFB (+13%, or 1.2 ms). The largest p95 increase was the shape sync's +23% (4.3 ms).
- **Fan-out of the question, and concurrent `POST` to 202 or to Electric's delivery:** p50 between +15% and +20%, each under 8 ms.
- **Answer metrics:** p50 22 to 80% faster, for example UI first text at 500 ms against 1912 ms. The bench can't tell the model's variance from the working copy's changes.

Treat a flagged regression as a lead, not a verdict. Before acting on it, rerun on a quiet machine with `--n 30 --n-answer 15`.

## First local results

The baseline is `results/2026-10-20T00-25-19Z.json`. It ran at commit `7f41caf1ab2f`, on 2026-10-19 at 17:25 PDT. The machine was an Apple M3 Max (Mac15,8, 64 GiB) on macOS 26.2, with headless Chromium 151 against `alchemy dev` (`vite-dev`) and the compose Postgres and Electric. The run used N=10, 5 for answering, and 4 asks at once × 2.

It predates the browser's agent, so its API, answer and `concurrent` rows, and its warm loads, measured what the app did then ([Baseline and regressions](#baseline-and-regressions)).

- **Conversation:** 42 messages. The shape synced 42 rows from 106 operations: 206 KiB in 2 requests.
- **Checks:** all 84 passed.
- **429s and failures:** none, and every concurrent ask got a 202.
- **Model use:** 24 calls and 65K input tokens. The median call was 873 input tokens.

| Metric (ms) | p50 | p95 | LiveStore p50 | LiveStore p95 |
|---|--:|--:|--:|--:|
| Cold load: TTFB / FCP | 9.0 / 284 | 11.8 / 290 | 7.2 / 230 | 13.2 / 242 |
| Cold load: chat usable = newest message shown | 598 | 604 | 707 / 998 | 717 / 1031 |
| Warm load: TTFB / FCP | 9.1 / 136 | 11.7 / 142 | 6.9 / 108 | 8.0 / 114 |
| Warm load: chat usable = newest message shown | 448 | 452 | 425 | 428 |
| ⌘K to composer focused | 1.2 | 5.5 | 1.6 | 3.8 |
| Shape initial sync, offset -1 to up-to-date | 15.5 | 18.4 | | |
| API: POST /api/questions to 202 | 26.3 | 39.8 | | |
| API: POST to the question's txid from Electric | 30.1 | 51.0 | | |
| API: POST to first answer text / to done | 2534 / 2541 | 8892 / 8914 | | |
| UI: ask to question shown | 10.2 | 15.6 | 25.1 | 27.3 |
| UI: ask to first answer text / to done | 1912 / 1931 | 2686 / 2707 | 618 | 1488 |
| Fan-out: ask on A to question on B | 40.2 | 57.3 | 70.6 | 88.7 |
| Fan-out: ask on A to answer done on B | 687 | 1326 | | |
| Concurrent asks (4 at once): POST to 202 | 39.5 | 72.8 | | |
| Concurrent asks: POST to txid from Electric | 40.4 | 74.3 | | |
| Concurrent asks: POST to answer done | 2107 | 4531 | | |

Chromium reported no LCP in any of the 20 loads (see below).

**LiveStore columns.** They come from the last LiveStore baseline, `results/2026-10-19T23-04-36Z.json`, kept as history with its rerun `23-05-21Z`. Read them as context, not as a like-for-like comparison:

- That conversation held 306 messages. LiveStore's cold "newest message shown" replayed the whole event log, so it grew with the conversation.
- Its "complete" is this table's "done".
- Its answer delta between devices has no successor.
- Two metrics moved for reasons the conversation size doesn't explain. Asking now shows the question in 10 ms, not 25 ms, and B sees it in 40 ms, not 71 ms. FCP rose by 54 ms cold and 28 ms warm, which the comparison flags as a regression. That has not been investigated: the module graph changed, and these are dev-server numbers.

## Reading the results

These read the first results above, so they describe the app as it was then.

- **Chat usable equals newest message shown, cold and warm.** The `/app` route suspends until the conversation has loaded, so the Chat button and the conversation render in one commit.
- **The network sync is a small part of a load.** Node syncs the whole shape in 15 ms, against 598 ms to a usable page. The rest is the app's modules on Vite's dev server, booting the runtime, TanStack DB and rendering.
- **Cold minus warm (150 ms) is mostly the module cache.** The `load` details count each page's shape requests, and how many came from the HTTP cache. In the rerun, each load made 4 shape requests, and a warm reload got 1 of them from the cache. Electric marks its non-live responses as cacheable: `max-age=604800` at `offset=-1`, and 60 s after that. The baseline's counts read 0, because Vite's modules filled Chromium's 250-entry resource buffer; the probe now raises the buffer.
- **The shape replays Electric's log, not the table.**
  - 42 rows holding 43 KB of text took 206 KiB to sync, because each write to a streaming answer is one more update in the shape.
  - Each update carries the whole `text` so far, so a long answer costs about its length times its number of writes.
  - Every answer streamed since Electric created the shape adds to this, so a full sync grows faster than the conversation. When Electric recreates the shape, the log starts again from a snapshot: in the rerun, 152 rows took 170 operations and 132 KiB.
- **Electric confirms a question about 4 ms after its 202** (30.1 ms against 26.3 ms at p50), so Postgres' commit reaches a live long-poll almost at once.
- **Answer times are the model's.** One answer took 1.0 s and another 10.0 s in the same suite.
- **Fan-out is the same for every device.** B sees A's question 40 ms after A's Enter: the POST, the commit, Electric's live response, TanStack DB and the render. A and B see the answer done within a few milliseconds of each other (687.5 against 687.2 ms in the first `sync` iteration), because both receive it from Electric.
- **Concurrent asks queued on Postgres.** Four at once reached their 202 in 40 ms at p50 and 73 ms at p95, against 26 and 40 ms one at a time, while each ask held a transaction lock (`pg_advisory_xact_lock`). Asks no longer take a lock (`db/migrations/0003_paired_positions.ts`); these figures predate that change.
- **FCP is the loading screen**: `AppLoading`'s Wordmark.
- **LCP is not reported.**
  - The Wordmark is an SVG, which isn't an LCP candidate.
  - Every message fades in from `opacity: 0` (`sui-chat-message-in` in `@smthrs/ui`), and Chromium doesn't take an element that first paints invisible.
  - The Chat button sits below the fold: with 40 messages the page is 38,700 px tall and opens at the top.
  - "Newest message shown" is the content metric.

## Limitations

- **Model and network variance dominate answer times.** Compare answer metrics over many runs.
- **The model's input depends on others.** The agent sends the model its instructions and the finished exchanges before the question (at most 19, up to 24,000 characters, from `GET /api/answers/<id>`), so input size and time to first text depend on what anyone asked before. In the baseline, a call made after long answers carried about 5,000 input tokens; one after the bench's own short exchanges carried 873. The bench asks for one word to keep each call small. A run can still take a large share of a tokens-per-minute limit that other users of the key share.
- **Answer times include the agent.** An answer runs on the asking tab's engine worker: it reads its turn (`GET /api/answers/<id>`), calls the model through ChatApi's `POST /api/model/agent`, and writes through `POST /api/answers/<id>`. First text and done include those requests and the engine, not only the model.
- **Answers need the asking page.** Only the asking tab's agent answers, so an answer runs only while that page is open. The bench closes a page once its answers are done, except when an iteration fails or times out. A page closed mid-answer leaves its answer `streaming`, which holds up every later answer for up to 30 s (`ANSWER_TURN_LIVE_SECONDS`), so one failure can time out the next iteration too.
- **Answers come in turn across the shared conversation.** Anyone else's live answer, such as an e2e run's on the same dev server, holds up the bench's, and the bench's holds up theirs. Run the bench while nothing else asks.
- **One-word answers barely stream.** The agent writes an answer's text at most once a second while it streams, then settles it, so a one-word answer's first text often arrives with its settling write. The bench doesn't measure a long answer streaming.
- **The page shows a window.** The device syncs the whole conversation, but the page renders the latest 50 messages ("Load earlier" shows more), so `conversationMessages` counts at most 50. The `shape` suite measures a full sync from `offset=-1`, as a new device does; `env.shape` records the conversation's full size.
- **N for the shape sync is not a parameter.** ChatApi's proxy fixes the shape to the whole `messages` table, so the bench syncs the conversation as it stands. To see scaling, compare runs as the conversation grows; `env.shape` records its size.
- **The conversation grows with every run.** A default run adds 38 messages, and every write to them adds to Electric's shape log, so loads and shape syncs slow down run over run.
- **The shape sync runs in Node.** It excludes the browser's parsing, TanStack DB and rendering; the load metrics include them. Its bytes are decoded JSON.
- **Local is not production.**
  - `alchemy dev` serves Vite's dev server: unbundled modules, React's development build and the HMR client.
  - The Worker runs in local workerd, and Hyperdrive passes straight through to the compose Postgres.
  - Electric runs in Docker on loopback.
  - Results record `server: vite-dev` or `built`.
- **One machine runs everything locally.** The browser, dev server, Postgres, Electric and other agents' e2e runs share it, and the model key too.
- **Live runs are public, and need a session.** They write to the deployment's shared conversation and spend its model key. The bench carries no session yet, so its pages can't ask where sign-in is real ([Run it](#run-it)).
- **The follower starts at `offset=now`.** It sees only rows written after it started. If Electric answers 409 (`must-refetch`), it starts again from `offset=now`, and a row written in between is missed and times out its check. `env.follower` counts both 409s and request errors.
- **"Shown" is DOM time, not pixel time.** The paint follows within a frame.
- **Chromium only.** FCP and LCP follow Chromium's rules, and WebKit and Firefox don't report LCP.
- **The browser is already running.** A cold load excludes browser start-up.
- **The recorded commit is the local working copy's.** On a live run, it may not be the deployed build.
- **The machine is unthrottled.** Local numbers come from an M3 Max on loopback.
- **Small N makes p95 noisy.** At N=5, p95 is nearly the slowest sample.
- **The `repo` suite reads one tiny repository.** `octocat/Spoon-Knife` has three files, so it measures RepoApi's and the cache's overhead, not a large tree. Decision 0006 also asks for trees of 1,000 and 50,000 paths and the first paint of a 500 KiB file, cold and warm; those need a fixture repository with that shape, which doesn't exist yet. Its "first" read is cold only on a deployment's first run after the clone: the immutable cache keeps a commit's answers. It has no baseline until a run records one.

## Correctness and cleanup

A concurrent ask passes only after its browser displays completion. Shape refetches validate their status and cursor and replay their messages; repository replay merges updates and removes deletes. A follower request times out after 30 seconds at startup or 90 seconds while live, including the response body. Transport failure fails observation instead of retrying across an unmeasured gap. Effect scopes close acquired resources on failure and cancellation.

Selected-suite baseline updates retain omitted metrics. Each metric keeps its original run source and environment; mixed-machine baselines still warn. Run benchmark unit tests with `node --test bench/*.test.ts` from `apps/mvp`.

## ChatApi startup

`pnpm bench:startup --out /tmp/chatapi-startup-<unique-run>` bundles
`worker/ChatApi.ts` with Alchemy's real rolldown and Cloudflare plugins, then
imports the emitted entry in three fresh Node processes. The median elapsed
module evaluation must remain below **200 ms**, unchanged from the former unit
test. Run this separately from parallel suites on an idle machine; an exceeded
budget exits nonzero and retains its result and failure receipt. No retries or
automatic baseline changes occur. The deterministic unit gate separately checks
that `ChatApiProgram.ts` is absent from the entry's static dependency closure,
reachable through a dynamic import, and that the emitted bundle actually loads.

The fresh artifact directory contains `result.json`: all three elapsed and CPU
samples, the median, budget, pass/fail, emitted-file SHA-256 identities, revision,
Node version, CPU, platform and host load before and after. The runner refuses
an existing directory and removes its temporary bundle. There is no warmup;
process module caches are cold but the OS file cache is retained. The benchmark
uses the existing startup-only Node adapter for `cloudflare:*` module values;
it executes no requests, SQL, model calls or credentials.

Node elapsed import time is a local regression proxy, sensitive to scheduling
and different from Cloudflare's startup CPU limit. It is not a production
latency guarantee. For live evidence retain the matching deployment's
`startup_time_ms` upload receipt separately; this command neither deploys nor
measures a live Worker. The historical live observations remain documented in
[infrastructure](infrastructure.md#limits).

The retained [2026-10-23 local receipt](../bench/startup-results/2026-10-23.json)
observed a 63.3 ms median (60.7, 69.2, 63.3 ms) on Node 26.5.0, Apple M4 Pro.
Its recorded load was about 30; it is a reproducibility receipt, not an idle-host
or live-deployment performance claim.

## First load

`BASE_URL=https://smithers.sh pnpm bench:first-load` makes the cold, signed-out
visit a launch visitor makes: five visits each to `/` and `/smithersai/vibelang`,
each in a fresh Chromium context with no cookies, HTTP cache, service worker or
device storage. It records first contentful paint, first meaningful content
(when the route's heading joins the document: the landing's wordmark, the
title of VibeLang's home), the boot's stage marks (`smithers.boot.*`,
[decision 0108](decisions/0108-first-load.md)), and the requests and bytes
fetched before the content. `--n` sets the visits and `--route <path>=<heading>`
replaces the routes.

On a built server it exits nonzero when a route's median first contentful paint
exceeds **4.5 s** or its median content exceeds **5.0 s**
(`--fcp-budget`, `--content-budget`). Against the dev server it reports the
numbers and checks no budget: its modules are unbundled. Each run writes
`bench/first-load-results/<timestamp>.json` with every sample, the summaries,
the method, its limitations and the environment.

The budget fails a regression of the boot, not a slow network: the numbers come
from one machine and one network path, the content time is DOM insertion (a
frame before its paint), and headless Chromium is not every browser.

On 2026-10-25, production (9c0c4e4a53, before decision 0108) measured a median
first contentful paint of 8,284 ms on `/` and 8,724 ms on
`/smithersai/vibelang`, over budget
([receipt](../bench/first-load-results/2026-10-25-production-before.json)).
Decision 0108's build, served locally with `/api/*` on smithers.sh, measured
2,080 ms and 3,084 ms, its stages at `page` 294, `worker` 304, `activation` 949,
`store` 1,974 and `render` 2,037 ms
([receipt](../bench/first-load-results/2026-10-25-local-after.json)); the build
before it, served the same way, 7,064 ms and 7,372 ms
([receipt](../bench/first-load-results/2026-10-25-local-before.json)).
