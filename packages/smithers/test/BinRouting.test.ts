/** Real executable contracts, scheduled in the bounded CLI worker pool. */
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { cli } from "../src/Command.ts"
import * as Unsupported from "../src/Unsupported.ts"
import * as Verb from "../src/Verb.ts"
import { executable, inEmptyDirectory, processBudget, refusal, run, runIn } from "./support/bin.ts"

describe("removed verbs and flags at the process boundary", processBudget, () => {
  // The complete sets are driven through the parser in `Unsupported.test.ts`;
  // one process per entry would be several minutes of spawns for the same
  // fact. These cases pin what only a real process can show: the status code
  // and the message on stderr.
  it("refuses a removed verb with exit 1 and a migration message", () => {
    const result = run(["rewind", "run-1"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs rewind was removed in 1.0.0-rc.0")
    expect(result.stderr).toContain(`${Unsupported.migrationUrl}#rewind`)
  })

  it("names the sub-verb when a removed group is called with one", () => {
    const result = run(["worktrees", "prune"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs worktrees prune was removed in 1.0.0-rc.0")
  })

  it("refuses a removed flag with exit 1 rather than the parser's exit 2", () => {
    // Exit 2 would mean the parser rejected an unknown flag, which carries no
    // migration message: declaring these hidden is what buys the sentence.
    const result = run(["steer", "run-1", "--message", "hello", "--takeover"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs steer --takeover was removed in 1.0.0-rc.0")
  })

  it("refuses the plural `workflows`, which is the spelling the removed-command contract lists", () => {
    // The singular is a command group only so `workflow list` stays reachable.
    // `workflows` is the 0.x did-you-mean key, so it is what a migrating
    // script says, and leaving it unregistered answered with the parser's
    // usage error (exit 2) and no migration message at all.
    const result = run(["workflows"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs workflows was removed in 1.0.0-rc.0")
    expect(result.stderr).toContain(`${Unsupported.migrationUrl}#workflow`)
  })

  it("answers `gateway status` and `gateway stop` with the removed-command message, not a usage error", () => {
    // The removed-command contract keeps bare `gateway` as the `serve` alias and removes the
    // two subcommands. Leaving them unregistered made the parser reject them
    // as stray positional arguments: exit 2, serve's help, and no migration
    // message, the same defect the plural `workflows` had.
    const status = run(["gateway", "status"])
    const stop = run(["gateway", "stop"])

    expect(status.status).toBe(1)
    expect(status.stderr).toContain("smthrs gateway status was removed in 1.0.0-rc.0")
    expect(status.stderr).toContain(`${Unsupported.migrationUrl}#gateway`)
    expect(stop.status).toBe(1)
    expect(stop.stderr).toContain("smthrs gateway stop was removed in 1.0.0-rc.0")
  })

  it("refuses `workflow run` under the packs reason and the singular spelling", () => {
    // The removed-command contract lists `workflow run|path|create|inspect|skills|doctor` under
    // "Packs and scaffolding". Reusing the `workflows` entry printed the
    // plural spelling and the "use `ls`" reason, which sends an operator
    // looking for a listing when what they lost was pack tooling.
    const result = run(["workflow", "path", "ship.tsx"])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("smthrs workflow path was removed in 1.0.0-rc.0")
    expect(result.stderr).toContain("JSX pack tooling is gone")
    expect(result.stderr).toContain(`${Unsupported.migrationUrl}#workflow`)
  })

  it("keeps `workflow list` alive as the `ls` alias while removing the rest", () => {
    const listed = run(["--json", "workflow", "list"])
    const removed = run(["workflow", "run"])

    expect(listed.status).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({ _tag: "flows" })
    expect(removed.status).toBe(1)
    expect(removed.stderr).toContain("was removed in 1.0.0-rc.0")
  })
})

describe("a removed verb refuses before the control plane boots", processBudget, () => {
  /**
   * A refusal is a sentence, not work.
   *
   * Every removed verb used to run under `NodeControl.layer`, so before the
   * one documented sentence reached stderr the process created
   * `<cwd>/.flows/`, opened `engine.db`, and opened `control.db`. Two costs
   * followed. An operator who typed a 0.x verb in any directory got a project
   * state directory there as the side effect of being told the verb is gone.
   * And `scripts/docs-removals.test.mjs` spawns the 75 removed forms eight at
   * a time in one working directory, so eight processes contended on the same
   * two SQLite files and answered with `disk I/O error` or with nothing before
   * the harness's fifteen-second bound.
   *
   * The proof is the file system: run the refusal in an empty directory and
   * assert that it is still empty afterwards.
   */
  it("prints its sentence and leaves the working directory empty", () => {
    const ui = Unsupported.removedVerbs.find((verb) => verb.name === "ui")!

    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["ui"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(Unsupported.message("ui", ui.reason, "ui"))
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for a removed form of a surviving parent", () => {
    const gateway = Unsupported.removedVerbs.find((verb) => verb.name === "gateway")!

    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["gateway", "status"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr.trim()).toBe(Unsupported.message("gateway status", gateway.reason, "gateway"))
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("refuses `--mcp` on a legacy verb and names the unified server", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["ls", "--json", "--mcp"], { SMITHERS_REMOTE: "" })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr.trim()).toBe("--mcp takes no command; run `smthrs --mcp`")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("still boots the control plane for a surviving verb", () => {
    // The guard is scoped to the removal table. `ls` is a real verb, so it
    // still resolves a project and opens its databases, and a guard that
    // swallowed it would show up here rather than as a silent listing of
    // nothing.
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["--json", "ls"])

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "flows" })
      expect(readdirSync(join(cwd, ".flows")).sort()).toContain("control.db")
    })
  })
})

describe("an invocation that never runs a command answers before the control plane boots", processBudget, () => {
  /**
   * A removed verb refused file-free, and every other non-running invocation
   * did not.
   *
   * `smthrs lss` is a typo. The parser answers it with exit 2 and a
   * did-you-mean list, and no handler ever runs, yet the process still built
   * `NodeControl.layer` on its way to the parse: it created `<cwd>/.flows/`
   * and opened `engine.db` and `control.db` before printing usage. The same
   * held for a one-token verb (`smithers "gateway status"`, the shape a shell
   * script produces when it quotes a whole command) and for an unrecognized
   * flag on a real verb (`smthrs ps --nope`).
   *
   * The rule is the same one the removed verbs got: an invocation that will
   * not run a real command touches no file. `bin.ts` now attaches the durable
   * layer to the command's handler rather than to the program, so the command
   * tree itself decides, and the layer is built only once a handler is about
   * to run.
   */
  it("answers an unknown subcommand with usage and leaves the working directory empty", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["lss"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("lss")
      expect(result.stdout).toContain("COMMAND_NOT_FOUND")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for a one-token command line", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["gateway status"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("gateway status")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("leaves the working directory empty for an unrecognized flag on a real verb", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["ps", "--nope"])

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("Unrecognized flag: --nope in command smthrs ps")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it.each(
    [
      [["plan"], "flow-id"],
      [["up"], "flow"],
      [["resume"], "run-id"],
      [["deny"], "approval"],
      [["claude", "node-wait", "run-1"], "node-id"],
      [["bug"], "summary"],
      [["approve"], "approval"],
      [["cancel"], "run-id"],
      [["signal", "run-1"], "signal-json"],
      [["steer", "--message", "continue"], "run-id"],
      [["output"], "run-id"]
    ] as const
  )("names a missing required argument for %j without opening the project", (args, argument) => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, args, { SMITHERS_AUDIENCE: "human" })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain(argument)
      expect(result.stderr).toContain("--wizard")
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("names a missing canonical target without opening the project", () => {
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["run", "--json"])
      expect(result.status).toBe(1)
      expect(result.stdout).toContain("VALIDATION_ERROR")
      expect(JSON.parse(result.stdout).fieldErrors).toContainEqual(
        expect.objectContaining({ path: "patterns", missing: true })
      )
      expect(readdirSync(cwd)).toEqual([])
    })
  })

  it("still builds the control plane for a real command", () => {
    // The other half of the contract. Moving the layer onto the handler must
    // not leave a shipped verb running without the services it declares, so a
    // verb that reads the durable stores is asserted to still open them.
    inEmptyDirectory((cwd) => {
      const result = runIn(cwd, ["--json", "ps"])

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ _tag: "runs" })
      expect(readdirSync(join(cwd, ".flows")).sort()).toContain("control.db")
    })
  })

  // This one spawns the executable once per shipped verb, so its budget is the
  // describe's 26 times over rather than one invocation's. Measured 24.7s
  // locally and 259.3s on a two-core CI runner, a ratio of 10.5 that the
  // shared 240s budget lands just under; 600s keeps the headroom real without
  // hiding a regression, since a verb that started booting the control plane
  // would still blow through it.
  it("classifies every shipped verb as a real command, not an unknown subcommand", { timeout: 600_000 }, () => {
    // The resolver is the command tree, so every name the tree declares has to
    // resolve through it. A verb that stopped resolving would reach an
    // operator as a did-you-mean list for a verb that exists. The removed
    // verbs are swept by `scripts/docs-removals.test.mjs`, which spawns all 75
    // of them; this covers the surviving half.
    const declared = cli.subcommands.flatMap((group) => group.commands.map((command) => command.name))
    const shipped = Verb.subcommands.map((verb) => verb.name)

    expect(shipped.length).toBeGreaterThan(0)
    for (const name of shipped) {
      if (["serve", "init", "suggest", "memory", "mcp"].includes(name)) expect(declared, name).not.toContain(name)
      else expect(declared, name).toContain(name)
      const result = inEmptyDirectory((cwd) => ({ ...runIn(cwd, [name, "--help"]), files: readdirSync(cwd) }))

      expect(result.stderr, name).not.toContain("Unknown subcommand")
      expect(result.status, name).toBe(0)
      expect(result.files, name).toEqual([])
    }
  })
})
