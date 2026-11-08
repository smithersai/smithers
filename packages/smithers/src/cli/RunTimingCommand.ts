/**
 * `runs show --timing`: the timing report, mounted on the run's status command.
 * @since 1.0.0
 */

import { Control } from "@smthrs/control"
import { Effect } from "effect"
import { Cli, z } from "incur"
import * as CliError from "../CliError.vibe"
import * as Globals from "../commands/Globals.vibe"
import * as BoundedEvents from "../internal/BoundedEvents.vibe"
import * as Bridge from "./ControlBridge.ts"
import * as Presentation from "./Presentation.ts"
import * as RunTiming from "./RunTiming.ts"

const unknownRun = (runId: string) =>
  new CliError.Refused({ fault: "user", code: "run_not_found", message: `Unknown run ${runId}` })

/**
 * Adds `--timing` to an existing runs group's `show`.
 *
 * A flag rather than a command of its own: `runs show` is the one status door
 * install help, skills and MCP already list, and the report is a second
 * reading of the events that command reads. With the flag the command returns
 * the {@link RunTiming.Report} in place of the run card; without it nothing
 * changes. It only reads, as `runs show` does, so it answers over a store
 * another process is writing and over one copied from another machine.
 *
 * @category constructors
 * @since 1.0.0
 */
export const appendRunTiming = (cli: Cli.Cli, runtime: Bridge.Runtime = {}): Cli.Cli => {
  const commands = Cli.toCommands.get(cli)!
  const show = commands.get("show")
  if (show === undefined || !("run" in show)) {
    throw new CliError.Refused({ fault: "bug", code: "runs_show_unregistered", message: "runs show is not registered" })
  }
  const timing = (c: any) =>
    Presentation.guard(c, async () => {
      const runId: string = c.args.run
      if (!Bridge.hasRecords(c.options, runtime)) {
        await Bridge.project(Globals.guard({ environment: runtime.environment ?? process.env }), c.options, runtime)
        throw unknownRun(runId)
      }
      return Bridge.read(
        Effect.gen(function*() {
          const control = yield* Control.Control
          const page = yield* control.list({ _tag: "runs", filters: { runId } })
          const run = page._tag === "runs" ? page.items.find((row) => row.runId === runId) : undefined
          if (run === undefined) throw unknownRun(runId)
          const limits = { operation: "run timing", subject: run.runId }
          // The plan's own events are journaled under the plan's id; with them the
          // report counts from the plan's creation, not from the run's first event.
          const planned = run.planId === undefined
            ? []
            : yield* BoundedEvents.collect(control.watch({ runId: `plan:${run.planId}`, follow: false }), limits)
          const events = yield* BoundedEvents.collect(control.watch({ runId: run.runId, follow: false }), limits)
          return RunTiming.fold([...planned, ...events], run.runId)
        }),
        c.options,
        runtime
      )
    }, {
      next: Presentation.runs({ show: false }),
      render: (report) => ({ human: RunTiming.render(report) })
    })
  commands.set("show", {
    ...show,
    options: (show.options ?? z.object({})).extend({
      timing: z.boolean().default(false).describe("Report where the run's time and tokens went")
    }),
    run: (c: any) => c.options.timing ? timing(c) : show.run(c)
  })
  return cli
}
