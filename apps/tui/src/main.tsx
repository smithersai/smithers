#!/usr/bin/env bun
/**
 * smithers-tui [directory] [--model provider:id] [-c | -r] [-p "prompt"]
 *
 *   -c, --continue   continue the latest session in this directory
 *   -r, --resume     pick a session to continue
 *   -p, --print      run one prompt and print the answer
 */
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { App } from "./app.tsx"
import * as Context from "./context.ts"
import * as FlowControl from "./flow-control.ts"
import * as Approvals from "./approvals.ts"
import * as Host from "./host.ts"
import * as Models from "./models.ts"
import * as Session from "./session.ts"

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string", short: "m" },
    continue: { type: "boolean", short: "c" },
    resume: { type: "boolean", short: "r" },
    print: { type: "string", short: "p" }
  },
  allowPositionals: true
})
const cwd = resolve(positionals[0] ?? process.cwd())
// Resolved before the chdir below, so a relative recording names the caller's file.
const replay = process.env.SMITHERS_TUI_REPLAY === undefined ? undefined : resolve(process.env.SMITHERS_TUI_REPLAY)
process.chdir(cwd)

const available = Models.detect(process.env)
const seat = values.model ?? (replay === undefined ? available.defaultSeat : `replay:${replay}`)
if (seat === undefined) {
  console.error("No model is available. Run `codex login` for the ChatGPT subscription, or set a provider API key.")
  process.exit(1)
}
const approvals = Approvals.mode(process.env, { print: values.print !== undefined })
if (typeof approvals === "object") {
  console.error(approvals.error)
  process.exit(1)
}
const host = Host.make({ cwd, environment: available.environment, approvals })

if (values.print !== undefined) {
  const notice = Approvals.notices()
  const turn = host.run({
    prompt: values.print,
    seat,
    history: [] as Array<Context.Entry>,
    onEvent: (event) => {
      if (event._tag !== "cell-call-settled" || !Approvals.denied(event.result)) return
      const line = notice(event.flowName)
      if (line !== undefined) console.error(line)
    }
  })
  const outcome = await turn.done
  await host.dispose()
  if (outcome._tag === "done") {
    console.log(outcome.answer)
    process.exit(0)
  }
  console.error(outcome._tag === "failed" ? outcome.message : "Stopped")
  process.exit(1)
}

// Opens nothing until a flow runs; discovery alone never imports a flow module.
const flows = FlowControl.make({ cwd, environment: available.environment })
const resumeFile = values.continue === true ? Session.latest(cwd) : undefined
const branch = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).stdout?.trim()
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
createRoot(renderer).render(
  <App
    host={host}
    seat={seat}
    workerSeat={replay === undefined ? available.workerSeat ?? seat : seat}
    models={available.models}
    contextWindow={(id) => SeatResolver.contextWindowTokensFor(Seat.modelIdOf(id))}
    {...(resumeFile === undefined ? {} : { resume: resumeFile })}
    pickSession={values.resume === true}
    flows={flows}
    {...(branch === undefined || branch === "" ? {} : { branch })}
  />
)
