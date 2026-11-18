// What the live eval runs on: the Node host, a durable flow engine over one SQLite file, and the host's own judge.
// The judge is the one `smthrs` binds (docs/libraries.md, "Decide inside a flow"): Jev through the Vercel AI Gateway
// when AI_GATEWAY_API_KEY is set, else a signed-in subscription. This file reads the process environment, which a
// .vibe file cannot.
import type { Evaluator } from "@smthrs/model"
import { NodeHost, TestNodeRuntime } from "@smthrs/platform-node"
import * as Layer from "effect/Layer"
import * as Score from "../src/select/Score.vibe"

/** The variables the judge may read. A value is passed on, never printed. */
const inherited = [
  "HOME",
  "PATH",
  "USER",
  "AI_GATEWAY_API_KEY",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "SMITHERS_OPENAI_AUTH"
]

const environment: Record<string, string> = Object.fromEntries(
  inherited.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]])
)

/** Where the eval reads its rows (`rows.jsonl`) and keeps its run journal (`eval.sqlite`). */
export const directory = process.env["SMITHERS_CI_EVAL_DIR"] ?? ""

/** How many changes of the test week to score; every one when unset. */
export const changes = process.env["SMITHERS_CI_EVAL_CHANGES"] === undefined
  ? undefined
  : Number(process.env["SMITHERS_CI_EVAL_CHANGES"])

// The CLI's sources do not typecheck under this package's ES2022 library, so its module is loaded untyped.
const cli: string = "@smthrs/cli/NodeControl"
const NodeControl = await import(cli)

/** How many changes are scored at once; 4 when unset. Each change asks in up to 4 requests at once. */
export const concurrency = Number(process.env["SMITHERS_CI_EVAL_CONCURRENCY"] ?? 4)

/** The host's judge. */
export const judge: Layer.Layer<Evaluator.Evaluator> = NodeControl.layerSeatEvaluator(environment).pipe(
  Layer.provide(NodeControl.layerRebuildableRequestExecutor(NodeControl.environmentDispatcher(environment)))
)

/**
 * The file system, a durable flow engine journaling in `eval.sqlite`, the judge, and the scorer's flow registered
 * once on that engine.
 */
export const layer = Score.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeHost.layer,
      TestNodeRuntime.durableEngine(`${directory}/eval.sqlite`, "smithers-ci-eval"),
      judge
    )
  )
)
