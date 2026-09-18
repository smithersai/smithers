/**
 * The recorded turn the scripted driver replays: two frames that read
 * `package.json`, ask Jev whether it matters to the task, and run a shell
 * command behind a permission, a read-only demand in between, and a final
 * answer.
 *
 * Hand-authored in the shape `Agent.run` emits, with the identities the
 * durable engine derives from the session, frame, cell digest and ordinal,
 * so the projection is exercised the way the engine driver will exercise it.
 * The permission park is followed by the replay of frame zero, which is what
 * a resumed execution produces (composition brief section 8). The frame
 * closes before the answer is reported, the order the engine emits.
 *
 * @since 1.0.0
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { Option } from "effect"
import type * as Driver from "./Driver.ts"
import type * as ScriptedDriver from "./ScriptedDriver.ts"

const effects = {
  reads: [] as ReadonlyArray<string>,
  writes: [] as ReadonlyArray<string>,
  mode: "expected" as const,
  onConflict: "serialize" as const,
  tier: "sealed" as const
}

const identity = (session: string, frame: number, cell: string, ordinal: number) =>
  new Cell.CallIdentity({ session, frame, cell, ordinal, declaration: "demo", layers: [] })

const call = (
  session: string,
  frame: number,
  cell: string,
  ordinal: number,
  flowName: string,
  input: Cell.Call["input"]
) =>
  new Cell.Call({
    flowName,
    input,
    capabilities: [],
    effects,
    placement: Option.none(),
    identity: identity(session, frame, cell, ordinal)
  })

const deltas = (text: string): Array<AgentEvent.AgentEvent> =>
  text.split(/(?<=\s)/).map((piece) =>
    new AgentEvent.ModelDelta({
      eventType: "flows.harness.model-delta.v1",
      delta: { type: "text-delta", id: "t", text: piece }
    })
  )

const settled = (text: string, usage: { input: number; output: number }) =>
  new AgentEvent.ModelSettled({
    eventType: "flows.harness.model-settled.v1",
    message: ModelRequest.Message.assistant(text, { stopReason: "stop" }),
    usage: { inputTokens: usage.input, outputTokens: usage.output },
    durationMillis: 900
  })

const opened = () =>
  new AgentEvent.TurnOpened({
    eventType: "flows.harness.turn-opened.v1",
    seat: "scripted:demo",
    modelParams: new ModelRequest.GenerationParams({}),
    activeToolNames: [],
    contextDigest: "demo"
  })

const closed = (outcome: "continue" | "resolved") =>
  new AgentEvent.TurnClosed({
    eventType: "flows.harness.turn-closed.v1",
    stopReason: "stop",
    outcome
  })

const frameZero = (session: string): Array<AgentEvent.AgentEvent> => {
  const source = Cell.source(
    `const pkg = await ctx.call("read", { path: "package.json" })\nconst root = await ctx.call("ls", { path: "." })\nconst verdict = await ctx.call("classify/triage/relevance", { task: "Read package.json and tell me the name field.", file: "package.json", excerpt: pkg.content })\nconsole.log(pkg.content)\nconsole.log(root.entries.map((e) => e.name).join(" "))\nconsole.log(JSON.stringify(verdict.answers))\nreturn ctx.continue()`
  )
  const text = `I'll read package.json and list the directory first.\n\n\`\`\`javascript\n${source.text}\n\`\`\``
  return [
    opened(),
    ...deltas(`I'll read package.json and list the directory first.\n\n`),
    settled(text, { input: 812, output: 96 }),
    new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell: source, blocks: 1 }),
    new AgentEvent.CellCallStarted({
      eventType: "flows.harness.cell-call-started.v1",
      call: call(session, 0, source.digest, 0, "read", { path: "package.json" })
    }),
    new AgentEvent.CellCallSettled({
      eventType: "flows.harness.cell-call-settled.v1",
      flowName: "read",
      identity: identity(session, 0, source.digest, 0),
      result: new Cell.CallResult({
        outcome: "success",
        value: { content: `{"name":"demo-repo","version":"0.1.0"}\n` }
      })
    }),
    new AgentEvent.CellCallStarted({
      eventType: "flows.harness.cell-call-started.v1",
      call: call(session, 0, source.digest, 1, "ls", { path: "." })
    }),
    new AgentEvent.CellCallSettled({
      eventType: "flows.harness.cell-call-settled.v1",
      flowName: "ls",
      identity: identity(session, 0, source.digest, 1),
      result: new Cell.CallResult({
        outcome: "success",
        value: {
          entries: [{ name: "README.md", kind: "file" }, { name: "package.json", kind: "file" }, {
            name: "src/",
            kind: "directory"
          }],
          total: 3,
          truncated: false
        }
      })
    }),
    new AgentEvent.CellCallStarted({
      eventType: "flows.harness.cell-call-started.v1",
      call: call(session, 0, source.digest, 2, "classify/triage/relevance", {
        task: "Read package.json and tell me the name field.",
        file: "package.json",
        excerpt: `{"name":"demo-repo","version":"0.1.0"}\n`
      })
    }),
    new AgentEvent.CellCallSettled({
      eventType: "flows.harness.cell-call-settled.v1",
      flowName: "classify/triage/relevance",
      identity: identity(session, 0, source.digest, 2),
      result: new Cell.CallResult({
        outcome: "success",
        value: {
          answers: {
            relevant: { value: true, probability: 0.93 },
            role: {
              value: "implementation",
              probabilities: { implementation: 0.81, fixture: 0.14, unrelated: 0.05 },
              confidence: 0.81
            },
            risk: {
              value: 0.4,
              label: "none",
              probabilities: { none: 0.62, low: 0.3, medium: 0.06, high: 0.02 },
              confidence: 0.62
            }
          },
          confidence: { relevant: 0.86, role: 0.81, risk: 0.62 },
          latencyMs: 212
        }
      })
    }),
    new AgentEvent.CellPrinted({
      eventType: "flows.harness.cell-printed.v1",
      cell: source.digest,
      text:
        `{"name":"demo-repo","version":"0.1.0"}\n\nREADME.md package.json src/\n{"relevant":{"value":true,"probability":0.93},"role":{"value":"implementation"},"risk":{"label":"none"}}\n`
    }),
    new AgentEvent.CellSettled({
      eventType: "flows.harness.cell-settled.v1",
      cell: source.digest,
      outcome: new Cell.Settled({ transition: new Cell.Continue({}) })
    }),
    new AgentEvent.TransitionApplied({
      eventType: "flows.harness.transition-applied.v1",
      transition: new Cell.Continue({})
    }),
    new AgentEvent.ReadOnlyDemandIssued({
      eventType: "flows.harness.read-only-demand-issued.v1",
      streak: 1,
      cap: 1,
      nextFrame: 1
    }),
    closed("continue")
  ]
}

const frameOne = (session: string, source: Cell.Source): Array<AgentEvent.AgentEvent> => [
  opened(),
  ...deltas(`The read-only cap asks for an action, so I'll run the command and answer.\n\n`),
  settled(
    `The read-only cap asks for an action, so I'll run the command and answer.\n\n\`\`\`javascript\n${source.text}\n\`\`\``,
    { input: 1240, output: 88 }
  ),
  new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell: source, blocks: 1 }),
  new AgentEvent.ReadOnlyDemanded({
    eventType: "flows.harness.read-only-demanded.v1",
    streak: 1,
    cap: 1,
    nextFrame: 1,
    nextAction: "justification"
  })
]

const bashSource = Cell.source(
  `const out = await ctx.call("bash", { command: "ls -la" })\nconsole.log(out.stdout)\nreturn ctx.done("The package is demo-repo 0.1.0; the directory holds README.md, package.json and src/.")`
)

const bashSettled = (session: string): Array<AgentEvent.AgentEvent> => [
  new AgentEvent.CellCallStarted({
    eventType: "flows.harness.cell-call-started.v1",
    call: call(session, 1, bashSource.digest, 0, "bash", { command: "ls -la" })
  }),
  new AgentEvent.CellCallSettled({
    eventType: "flows.harness.cell-call-settled.v1",
    flowName: "bash",
    identity: identity(session, 1, bashSource.digest, 0),
    result: new Cell.CallResult({
      outcome: "success",
      value: {
        exitCode: 0,
        stdout:
          "total 16\n-rw-r--r--  1 demo  staff   60 README.md\n-rw-r--r--  1 demo  staff   40 package.json\ndrwxr-xr-x  3 demo  staff   96 src\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0
      }
    })
  }),
  new AgentEvent.CellPrinted({
    eventType: "flows.harness.cell-printed.v1",
    cell: bashSource.digest,
    text:
      "total 16\n-rw-r--r--  1 demo  staff   60 README.md\n-rw-r--r--  1 demo  staff   40 package.json\ndrwxr-xr-x  3 demo  staff   96 src\n\n"
  }),
  new AgentEvent.CellSettled({
    eventType: "flows.harness.cell-settled.v1",
    cell: bashSource.digest,
    outcome: new Cell.Settled({
      transition: new Cell.Complete({
        output: "The package is demo-repo 0.1.0; the directory holds README.md, package.json and src/."
      })
    })
  }),
  new AgentEvent.TransitionApplied({
    eventType: "flows.harness.transition-applied.v1",
    transition: new Cell.Complete({
      output: "The package is demo-repo 0.1.0; the directory holds README.md, package.json and src/."
    })
  }),
  closed("resolved"),
  new AgentEvent.Resolved({
    eventType: "flows.harness.resolved.v1",
    message: ModelRequest.Message.assistant(
      "The package is demo-repo 0.1.0; the directory holds README.md, package.json and src/.",
      { stopReason: "stop" }
    )
  })
]

const bashRefused = (session: string): Array<AgentEvent.AgentEvent> => [
  new AgentEvent.CellCallStarted({
    eventType: "flows.harness.cell-call-started.v1",
    call: call(session, 1, bashSource.digest, 0, "bash", { command: "ls -la" })
  }),
  new AgentEvent.CellCallSettled({
    eventType: "flows.harness.cell-call-settled.v1",
    flowName: "bash",
    identity: identity(session, 1, bashSource.digest, 0),
    result: new Cell.CallResult({
      outcome: "failure",
      value: null,
      message: "The operator refused bash for this call",
      code: "capability_refused"
    })
  }),
  new AgentEvent.CellPrinted({ eventType: "flows.harness.cell-printed.v1", cell: bashSource.digest, text: "" }),
  new AgentEvent.CellSettled({
    eventType: "flows.harness.cell-settled.v1",
    cell: bashSource.digest,
    outcome: new Cell.Settled({
      transition: new Cell.Complete({
        output: "The shell call was refused, so I answered from the read: demo-repo 0.1.0."
      })
    })
  }),
  closed("resolved"),
  new AgentEvent.Resolved({
    eventType: "flows.harness.resolved.v1",
    message: ModelRequest.Message.assistant(
      "The shell call was refused, so I answered from the read: demo-repo 0.1.0.",
      { stopReason: "stop" }
    )
  })
]

/**
 * The turn for one prompt: the session id keys every call identity, so a
 * replayed frame names the same cards.
 *
 * @category constructors
 * @since 1.0.0
 */
export const script = (input: Driver.StartInput): ScriptedDriver.Script => {
  const session = input.sessionID
  const request = new Permission.PermissionRequired({
    requestId: `per_${session}_1_${bashSource.digest.slice(0, 8)}_0`,
    runId: input.messageID,
    capability: Capability.make("proc:spawn", "bash"),
    tier: "irreversible",
    meta: {
      flow: "bash",
      input: { command: "ls -la" },
      identity: { frame: 1, cell: bashSource.digest, ordinal: 0 }
    }
  })
  return {
    segments: [
      { _tag: "events", events: [...frameZero(session), ...frameOne(session, bashSource)] },
      {
        _tag: "permission",
        request,
        // A resumed execution replays frame zero from the journal before it
        // reaches the parked call.
        allowed: [...frameZero(session), ...frameOne(session, bashSource), ...bashSettled(session)],
        rejected: [...frameZero(session), ...frameOne(session, bashSource), ...bashRefused(session)]
      }
    ]
  }
}
