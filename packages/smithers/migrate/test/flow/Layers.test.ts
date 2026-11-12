/**
 * The grant rules a migration runs under, asked of a real kernel grant store.
 *
 * The rules are the only place the tool's two promises about run state are
 * *enforced* rather than asserted, so they are tested by asking the store the
 * same questions the kernel asks it: may this write land, and may this command
 * run. The store is unattended, which is what a migration is, so anything the
 * rules do not name is refused rather than queued for a person.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Capability, GrantStore, Workspace } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as KernelProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as Command from "@smthrs/migrate/flow/Command"
import type * as Contract from "@smthrs/migrate/flow/Contract"
import * as Layers from "@smthrs/migrate/flow/Layers"
import * as Transform from "@smthrs/migrate/flow/Transform"
import * as Verify from "@smthrs/migrate/flow/Verify"
import * as Scan from "@smthrs/migrate/Scan"
import * as Units from "@smthrs/migrate/Units"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as ProcessSandbox from "@smthrs/platform-node/ProcessSandbox"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { copyFixture, journeyHost, nodeLayer, sandboxAvailable } from "../fixtures/helpers.ts"

/** Node's services with the confinement a real composition gives verification. */
const hostVerification = Layer.merge(NodeServices.layer, Layers.layerVerificationConfinement(journeyHost))

const root = Effect.runSync(Layers.migrationRoot("/tmp/project"))

const commands: Contract.Commands = {
  install: "pnpm install --frozen-lockfile",
  format: "dprint fmt",
  typecheck: ["tsc --noEmit -p tsconfig.json", "tsc --noEmit -p test/tsconfig.json"],
  test: "vitest run",
  flowsDir: "flows"
}

const runStatePaths = [
  ".smithers/claude-mirror-subscriptions.json",
  ".smithers/executions",
  ".smithers/smithers.db"
]

const store = GrantStore.layer({
  attended: false,
  rules: Layers.rules({ root, runStatePaths, commands })
}).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)

/** Whether the store lets one capability through. */
const permitted = (action: Capability.Action, resource: string): Effect.Effect<boolean> =>
  Effect.gen(function*() {
    const grants = yield* GrantStore.GrantStore
    return yield* grants.check(Capability.make(action, resource)).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    )
  }).pipe(Effect.provide(store))

describe("Layers composition contracts", () => {
  it("keeps composition checks out of the public API", () => {
    // @ts-expect-error the compilation assertion is an implementation detail
    type InternalAssertion = Layers.CompositionRootsAreComplete
    expectTypeOf<InternalAssertion>().toEqualTypeOf<InternalAssertion>()
  })

  it("provides every service required by each composition root", () => {
    expectTypeOf<Layer.Services<ReturnType<typeof Layers.layerNode>>>().toEqualTypeOf<never>()
    expectTypeOf<Layer.Services<ReturnType<typeof Layers.layerNodeScanned>>>().toEqualTypeOf<never>()
    expectTypeOf<Layer.Services<ReturnType<typeof Layers.layerScripted>>>().toEqualTypeOf<never>()
  })
})

describe("Layers.verificationCommands", () => {
  it("is every command a verification runs, once each", () => {
    expect(Layers.verificationCommands(commands)).toEqual([
      "pnpm install --frozen-lockfile",
      "dprint fmt",
      "tsc --noEmit -p tsconfig.json",
      "tsc --noEmit -p test/tsconfig.json",
      "vitest run"
    ])
  })

  it("omits what the project does not configure", () => {
    expect(Layers.verificationCommands({ typecheck: [], flowsDir: "flows" })).toEqual([])
  })

  it("keeps one grant for a command that is both the typecheck and the test", () => {
    expect(
      Layers.verificationCommands({ typecheck: ["bun run check"], test: "bun run check", flowsDir: "flows" })
    ).toEqual(["bun run check"])
  })
})

describe("Layers.commandsFor over a real project", () => {
  it.effect("reads the project's own commands when the operator names none", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const scanned = yield* Scan.scan(project)

      const derived = Layers.commandsFor(scanned.detection, {}, "flows")

      expect(derived.flowsDir).toBe("flows")
      expect(derived.typecheck.length).toBeGreaterThan(0)
      expect(derived.test).toEqual(Units.argv("npm", "run", "test"))
      // What the host grants is the rendered line of the same argv.
      expect(Layers.verificationCommands(derived)).toContain("npm run test")
    }).pipe(Effect.provide(nodeLayer)))

  it.effect("takes the operator's overrides, so the host permits what the brief lists", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const scanned = yield* Scan.scan(project)

      // The same overrides the live and scripted runs pass. Before these
      // must reach both the unit brief and the orchestrator's verification.
      const derived = Layers.commandsFor(
        scanned.detection,
        { typecheck: [], test: "node -e \"process.exit(0)\"" },
        "flows"
      )

      expect(derived.typecheck).toEqual([])
      expect(derived.test).toBe("node -e \"process.exit(0)\"")
      expect(Layers.verificationCommands(derived)).toContain("node -e \"process.exit(0)\"")
    }).pipe(Effect.provide(nodeLayer)))
})

describe("Layers.rules over a real grant store", () => {
  it.effect("refuses a relative root in the smart constructor rules are built from", () =>
    Effect.gen(function*() {
      // `rules` takes a `MigrationRoot`, so the only way to a rule set is
      // through this constructor and a relative root never reaches a pattern.
      const failure = yield* Effect.flip(Layers.migrationRoot("../project"))

      expect(Command.isMigrateError(failure)).toBe(true)
      if (Command.isMigrateError(failure)) {
        expect(failure.code).toBe("unsupported-project")
        expect(failure.message).toContain("../project")
      }
      // The other half of the same claim, which only a typecheck can make: an
      // unproven string is not a root `rules` accepts, so the relative case is
      // unreachable rather than guarded against. `tsc` fails this file if this
      // call ever compiles.
      // @ts-expect-error a bare string is not a proven-absolute migration root
      expect(() => Layers.rules({ root: "/tmp/project", runStatePaths, commands })).not.toThrow()
    }))

  it.effect("refuses a relative root in the package's own error channel when a host is composed", () =>
    Effect.gen(function*() {
      // A library caller with a relative path gets a `MigrateError` an entry
      // point can map to an exit status, not a defect from inside a layer.
      for (
        const layer of [
          Layers.layerNode({ root: "relative/project", commands, runStatePaths }),
          Layers.layerNodeScanned({ root: "relative/project" })
        ]
      ) {
        const failure = yield* Effect.flip(Effect.scoped(Layer.build(layer)))
        expect(Command.isMigrateError(failure)).toBe(true)
        if (Command.isMigrateError(failure)) {
          expect(failure.code).toBe("unsupported-project")
          expect(failure.message).toContain("relative/project")
        }
      }
    }))

  it.effect("lets a unit write inside the project", () =>
    Effect.gen(function*() {
      expect(yield* permitted("fs:write", `${root}/flows/simple/flow.ts`)).toBe(true)
      expect(yield* permitted("fs:read", `${root}/simple-workflow.jsx`)).toBe(true)
    }))

  it.effect("lets a unit write the project root itself, which is a file's parent", () =>
    Effect.gen(function*() {
      // `write` creates the parent directory of its target before writing it,
      // and the parent of `package.json` is the root. A rule set that granted
      // only `<root>/**` let the agent write `flows/x/flow.ts` and refused
      // `package.json`, which is the one file the dependencies unit exists to
      // rewrite. The refusal reached the model as "Could not write
      // package.json", with nothing to say it was a permission.
      expect(yield* permitted("fs:write", root)).toBe(true)
      expect(yield* permitted("fs:write", `${root}/package.json`)).toBe(true)
    }))

  it.effect("refuses a write to the project's 0.x run state", () =>
    Effect.gen(function*() {
      expect(yield* permitted("fs:write", `${root}/.smithers/smithers.db`)).toBe(false)
      expect(yield* permitted("fs:write", `${root}/.smithers/executions/run-1/stdout.log`)).toBe(false)
      expect(yield* permitted("fs:write", `${root}/.smithers/claude-mirror-subscriptions.json`)).toBe(false)
    }))

  it.effect("keeps migration-owned lock state outside every agent filesystem grant", () =>
    Effect.gen(function*() {
      for (const action of ["fs:read", "fs:write"] as const) {
        for (
          const target of [".smithers-migrate", ".smithers-migrate/apply.lock", ".smithers-migrate/apply.lock.sqlite"]
        ) {
          expect([action, target, yield* permitted(action, `${root}/${target}`)]).toEqual([action, target, false])
        }
      }
    }))

  it.effect("refuses to read, list, or stat run state too, because a read is a copy into the model", () =>
    Effect.gen(function*() {
      // The contract says "do not read", and a sentence is not an enforcement.
      // Every filesystem action on the exact path and on everything under it
      // is vetoed, and the veto is configured, so no envelope lifts it.
      expect(yield* permitted("fs:read", `${root}/.smithers/smithers.db`)).toBe(false)
      expect(yield* permitted("fs:read", `${root}/.smithers/executions`)).toBe(false)
      expect(yield* permitted("fs:read", `${root}/.smithers/executions/run-1/stdout.log`)).toBe(false)
      expect(yield* permitted("fs:read", `${root}/.smithers/claude-mirror-subscriptions.json`)).toBe(false)
      // The sibling that is source, not state, stays readable and writable.
      expect(yield* permitted("fs:read", `${root}/.smithers/workflows/review.tsx`)).toBe(true)
      expect(yield* permitted("fs:write", `${root}/.smithers/workflows/review.tsx`)).toBe(true)
      expect(yield* permitted("fs:read", `${root}/.smithers`)).toBe(true)
    }))

  it.effect("refuses a write outside the project entirely", () =>
    Effect.gen(function*() {
      expect(yield* permitted("fs:write", "/etc/hosts")).toBe(false)
    }))

  it.effect("refuses agent execution even for configured verification commands", () =>
    Effect.gen(function*() {
      for (const command of Layers.verificationResources(commands)) {
        expect([command, yield* permitted("proc:spawn", command)]).toEqual([command, false])
      }
    }))

  it.effect("runs configured verification commands through the trusted orchestrator", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const result = yield* Verify.run({
        root: project,
        commands: { typecheck: ["node -e \"\" && node -e \"\""], flowsDir: "flows" },
        expectFlows: false
      })
      expect(result.typecheck[0]?.exitCode).toBe(0)
    }).pipe(Effect.provide(hostVerification)))

  for (const approved of ["npm test -- tests/*", "npm test -- tests/?", "npm test -- *"]) {
    it.effect(`does not turn ${approved} into a wildcard shell grant`, () =>
      Effect.gen(function*() {
        const grants = yield* GrantStore.GrantStore
        // These are permission probes only. No process is spawned.
        for (
          const unexpected of [
            "npm test -- tests/x; rm -rf ~",
            `${approved}; printf PROBE_ONLY`,
            `${approved} && printf PROBE_ONLY`,
            `${approved} | cat`,
            `${approved}\nprintf PROBE_ONLY`,
            `${approved}$(printf PROBE_ONLY)`,
            `${approved}\`printf PROBE_ONLY\``,
            "npm test -- tests/x",
            "npm test --"
          ]
        ) {
          const allowed = yield* grants.check(Capability.make("proc:spawn", unexpected)).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false))
          )
          expect([unexpected, allowed]).toEqual([unexpected, false])
        }
        // The glob grammar cannot express these exact resources. The
        // host-owned verification flow still runs the configured command.
        const refused = yield* Effect.flip(grants.check(Capability.make("proc:spawn", approved)))
        expect(refused.code).toBe("permission_required")
        expect((yield* Effect.flip(grants.check(Capability.make("proc:spawn", "npm run test")))).code).toBe(
          "permission_required"
        )
      }).pipe(Effect.provide(
        GrantStore.layer({
          attended: false,
          rules: Layers.rules({
            root,
            runStatePaths,
            commands: { typecheck: ["npm run test"], test: approved, flowsDir: "flows" }
          })
        }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
      )))
  }

  it.effect("keeps exact glob commands available to deterministic verification", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      mkdirSync(join(project, "grant-tests"))
      writeFileSync(join(project, "grant-tests", "x"), "")
      const approved = "printf '%s' grant-tests/*"
      const result = yield* Verify.run({
        root: project,
        commands: { typecheck: [], test: approved, flowsDir: "flows" },
        expectFlows: false
      })
      expect(result.tests?.command).toBe(approved)
      expect(result.tests?.exitCode).toBe(0)
      expect(result.tests?.stdoutTail).toBe("grant-tests/x")
    }).pipe(Effect.provide(hostVerification)))

  it.effect("refuses every other command, including the ones that would reach run state anyway", () =>
    Effect.gen(function*() {
      // A spawned process writes at the OS level, where no `fs:write` rule can
      // see it. Confining the spawn is the only place that can be stopped.
      expect(yield* permitted("proc:spawn", `sqlite3 ${root}/.smithers/smithers.db "delete from _smithers_runs"`))
        .toBe(false)
      expect(yield* permitted("proc:spawn", `rm -rf ${root}/.smithers`)).toBe(false)
      expect(yield* permitted("proc:spawn", "bash -lc 'pnpm install --frozen-lockfile'")).toBe(false)
      expect(yield* permitted("proc:spawn", "pnpm install")).toBe(false)
      expect(yield* permitted("proc:spawn", "git push")).toBe(false)
    }))

  it.effect("refuses every command when the project configures none", () =>
    Effect.gen(function*() {
      const grants = yield* GrantStore.GrantStore
      const allowed = yield* grants.check(Capability.make("proc:spawn", "pnpm install --frozen-lockfile")).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
      expect(allowed).toBe(false)
    }).pipe(Effect.provide(
      GrantStore.layer({
        attended: false,
        rules: Layers.rules({ root, runStatePaths, commands: { typecheck: [], flowsDir: "flows" } })
      }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
    )))
})

describe("Layers.rules over run-state paths outside the project", () => {
  const gateway = "/tmp/smithers-gateway/workspaces.json"

  it.effect("carries a gateway state file from the scan to a deny on its own absolute path", () =>
    Effect.gen(function*() {
      const project = copyFixture("jsx-single")
      const temporary = copyFixture("jsx-single")
      mkdirSync(join(temporary, "smithers-gateway"), { recursive: true })
      writeFileSync(
        join(temporary, "smithers-gateway", "gateway.json"),
        JSON.stringify({ workspace: project, port: 7331 })
      )

      const scanned = yield* Scan.scan(project, { runState: { tmpdir: temporary } }).pipe(Effect.provide(nodeLayer))
      const paths = Transform.runStatePaths(scanned)
      const built = Layers.rules({ root, runStatePaths: paths, commands })
      const denied = built.filter((rule) => rule.effect === "deny").map((rule) => rule.pattern.resource)

      const file = join(temporary, "smithers-gateway", "gateway.json")
      expect(paths).toContain(file)
      expect(denied).toContain(file)
      expect(denied).toContain(`${file}/**`)
    }).pipe(Effect.provide(nodeLayer)))

  it("denies an absolute gateway state path by its own path, not by one joined under the root", () => {
    const built = Layers.rules({ root, runStatePaths: [gateway], commands })
    const denied = built.filter((rule) => rule.effect === "deny").map((rule) => rule.pattern.resource)

    // Joined under the root the pattern is `${root}//tmp/...`, which matches
    // nothing: the file would sit outside every rule while the report calls
    // it covered.
    expect(denied).toContain(gateway)
    expect(denied).toContain(`${gateway}/**`)
    expect(denied.some((resource) => resource.includes("//tmp"))).toBe(false)
  })

  it.effect("keeps the store's answer for the gateway file a refusal", () =>
    Effect.gen(function*() {
      const grants = yield* GrantStore.GrantStore
      const allowed = yield* grants.check(Capability.make("fs:write", gateway)).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
      expect(allowed).toBe(false)
    }).pipe(Effect.provide(
      GrantStore.layer({
        attended: false,
        rules: Layers.rules({ root, runStatePaths: [gateway], commands })
      }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
    )))
})

describe("Layers.rules over host-owned and secret paths", () => {
  const probe = (reportDir: string | undefined, action: Capability.Action, resource: string) =>
    Effect.gen(function*() {
      const grants = yield* GrantStore.GrantStore
      return yield* grants.check(Capability.make(action, resource)).pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false))
      )
    }).pipe(Effect.provide(
      GrantStore.layer({
        attended: false,
        rules: Layers.rules({ root, runStatePaths, commands, ...(reportDir === undefined ? {} : { reportDir }) })
      }).pipe(Layer.provide(Workspace.layer(root)), Layer.orDie)
    ))

  it.effect("denies the configured report directory, not only the default one", () =>
    Effect.gen(function*() {
      // A custom `--report-dir` holds the backups, the tree manifests, and
      // pending-unit.json that restore trusts. The agent must not reach them.
      for (const action of ["fs:read", "fs:write"] as const) {
        for (
          const target of [
            "build/migrate",
            "build/migrate/report.json",
            "build/migrate/pending-unit.json",
            "build/migrate/backup/workflow/demo.tree.json",
            ".smithers-migrate/apply.lock.sqlite"
          ]
        ) {
          expect([action, target, yield* probe("build/migrate", action, `${root}/${target}`)])
            .toEqual([action, target, false])
        }
      }
      expect(yield* probe("build/migrate", "fs:write", `${root}/build/other.ts`)).toBe(true)
    }))

  it.effect("denies version-control metadata, so a rewrite cannot plant a hook", () =>
    Effect.gen(function*() {
      for (const action of ["fs:read", "fs:write"] as const) {
        for (const target of [".git", ".git/hooks/pre-commit", ".git/config", ".jj", ".jj/repo/config.toml"]) {
          expect([action, target, yield* probe(undefined, action, `${root}/${target}`)])
            .toEqual([action, target, false])
        }
      }
      expect(yield* probe(undefined, "fs:write", `${root}/.gitignore`)).toBe(true)
    }))

  it.effect("denies every case spelling of the fixed names, which a case-insensitive volume resolves to one file", () =>
    Effect.gen(function*() {
      // The kernel keeps the caller's spelling and the matcher is literal,
      // so on APFS `.GIT/hooks/pre-commit` would otherwise miss the deny.
      for (const action of ["fs:read", "fs:write"] as const) {
        for (
          const target of [
            ".GIT/hooks/pre-commit",
            ".Git/config",
            ".gIT",
            ".JJ/repo/config.toml",
            ".jJ",
            ".ENV",
            ".Env.local",
            "apps/web/.eNV.production"
          ]
        ) {
          expect([action, target, yield* probe(undefined, action, `${root}/${target}`)])
            .toEqual([action, target, false])
        }
      }
      expect(yield* probe(undefined, "fs:write", `${root}/.GITIGNORE`)).toBe(true)
      expect(yield* probe(undefined, "fs:write", `${root}/src/ENVIRONMENT.ts`)).toBe(true)
    }))

  it.effect("denies every dotenv file, at the root and nested, so injected text cannot read a key", () =>
    Effect.gen(function*() {
      for (const action of ["fs:read", "fs:write"] as const) {
        for (const target of [".env", ".env.local", "apps/web/.env", "apps/web/.env.production"]) {
          expect([action, target, yield* probe(undefined, action, `${root}/${target}`)])
            .toEqual([action, target, false])
        }
      }
      // `*` crosses `/`, so a directory whose name starts with `.env` is
      // denied whole. That over-deny is deliberate and fails closed.
      expect(yield* probe(undefined, "fs:read", `${root}/.envoy/config.ts`)).toBe(false)
      expect(yield* probe(undefined, "fs:read", `${root}/src/environment.ts`)).toBe(true)
      expect(yield* probe(undefined, "fs:read", `${root}/.envrc.example.md`)).toBe(false)
    }))
})

describe("Layers.rules over a SQLite database's sidecars", () => {
  it.effect("refuses the agent's filesystem a live WAL, its index, and a journal that does not exist yet", () =>
    Effect.gen(function*() {
      // A real project whose database is open in WAL mode: the committed run
      // payload sits in `-wal` until a checkpoint copies it into the database.
      const project = realpathSync(mkdtempSync(join(tmpdir(), "migrate-wal-")))
      mkdirSync(join(project, ".smithers"))
      const database = new DatabaseSync(join(project, ".smithers", "smithers.db"))
      yield* Effect.addFinalizer(() => Effect.sync(() => database.close()))
      database.exec("PRAGMA journal_mode = WAL")
      database.exec("PRAGMA wal_autocheckpoint = 0")
      database.exec("CREATE TABLE _smithers_runs (run_id TEXT PRIMARY KEY, status TEXT, input TEXT)")
      database.prepare("INSERT INTO _smithers_runs VALUES (?, ?, ?)").run("run-1", "finished", "PRIVATE_RUN_PAYLOAD")
      const wal = ".smithers/smithers.db-wal"
      const journal = ".smithers/smithers.db-journal"
      expect(readFileSync(join(project, wal), "latin1")).toContain("PRIVATE_RUN_PAYLOAD")
      expect(existsSync(join(project, journal))).toBe(false)

      const scanned = yield* Scan.scan(project, { flowsDir: "flows" }).pipe(Effect.provide(nodeLayer))
      const migration = yield* Layers.migrationRoot(project)
      const grants = GrantStore.layer({
        attended: false,
        rules: Layers.rules({ root: migration, runStatePaths: Transform.runStatePaths(scanned), commands })
      }).pipe(Layer.provide(Workspace.layer(migration)), Layer.orDie)
      // The kernel guard the rewrite agent's filesystem flows run behind.
      const guarded = Layer.orDie(KernelFileSystem.layer).pipe(
        Layer.provide([Workspace.layer(migration), grants]),
        Layer.provideMerge(Layer.provideMerge(AtomicFileSystem.layer, NodeServices.layer))
      )
      const outcome = (use: (fs: FileSystem.FileSystem) => Effect.Effect<unknown, unknown>) =>
        Effect.gen(function*() {
          return yield* use(yield* FileSystem.FileSystem)
        }).pipe(
          Effect.as("allowed"),
          Effect.catch((error) => Effect.succeed((error as { reason?: { _tag?: string } }).reason?._tag)),
          Effect.provide(guarded)
        )

      for (const file of [wal, ".smithers/smithers.db-shm", ".smithers/smithers.db"]) {
        expect([file, yield* outcome((fs) => fs.readFile(join(project, file)))]).toEqual([file, "PermissionDenied"])
      }
      expect(yield* outcome((fs) => fs.writeFileString(join(project, journal), ""))).toBe("PermissionDenied")
      // The source beside the run state stays the agent's to read.
      writeFileSync(join(project, ".smithers", "workflow.tsx"), "export {}\n")
      expect(yield* outcome((fs) => fs.readFile(join(project, ".smithers", "workflow.tsx")))).toBe("allowed")
    }).pipe(Effect.scoped))
})

describe("Layers.verificationEnvironment", () => {
  it("keeps the bootstrap names and drops everything else the operator exports", () => {
    expect(Layers.verificationEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/operator",
      USER: "operator",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm",
      TMPDIR: "/tmp",
      SHELL: "/bin/sh",
      ANTHROPIC_API_KEY: "key",
      NPM_TOKEN: "token",
      AWS_SECRET_ACCESS_KEY: "secret",
      NODE_OPTIONS: "--require ./planted.cjs",
      LC_CTYPE: undefined
    })).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/operator",
      USER: "operator",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      TERM: "xterm",
      TMPDIR: "/tmp",
      SHELL: "/bin/sh"
    })
  })
})

describe("Layers.layerVerificationConfinement", () => {
  const profile: KernelProcessConfinement.Profile = {
    workspaceRoot: "/project",
    reads: ["."],
    writes: ["."],
    readOnly: [".git"],
    network: "open"
  }

  it.effect("replaces the command's environment whatever confinement it wraps", () => {
    const seen: Array<{ readonly command: ChildProcess.StandardCommand; readonly profile: unknown }> = []
    const recording = Layer.succeed(KernelProcessConfinement.ProcessConfinement)({
      confine: (command, given) =>
        Effect.sync(() => {
          seen.push({ command, profile: given })
          return command
        })
    })
    return Effect.gen(function*() {
      const confinement = yield* KernelProcessConfinement.ProcessConfinement
      yield* confinement.confine(
        ChildProcess.make("npm", ["install"], {
          cwd: "/project",
          env: { NPM_TOKEN: "token" },
          extendEnv: true
        }),
        profile
      )
      yield* confinement.confine(ChildProcess.make("npm run test", { cwd: "/project", shell: true }), profile)

      expect(seen.map((entry) => [entry.command.command, entry.command.args])).toEqual([
        ["npm", ["install"]],
        ["npm run test", []]
      ])
      for (const entry of seen) {
        expect(entry.profile).toEqual(profile)
        expect(entry.command.options.env).toEqual({ PATH: "/usr/bin", LC_ALL: "C" })
        expect(entry.command.options.extendEnv).toBe(false)
        expect(entry.command.options.cwd).toBe("/project")
      }
      expect(seen[1]?.command.options.shell).toBe(true)
    }).pipe(
      Effect.scoped,
      Effect.provide(Layers.layerVerificationConfinement({
        environment: { PATH: "/usr/bin", LC_ALL: "C", NPM_TOKEN: "operator-token", ANTHROPIC_API_KEY: "key" },
        confinement: recording
      }))
    )
  })

  it.effect("gives a command no environment when the host was given none", () => {
    const seen: Array<ChildProcess.StandardCommand> = []
    return Effect.gen(function*() {
      const confinement = yield* KernelProcessConfinement.ProcessConfinement
      yield* confinement.confine(ChildProcess.make("tsc", ["--noEmit"]), profile)
      expect(seen[0]?.options.env).toEqual({})
      expect(seen[0]?.options.extendEnv).toBe(false)
    }).pipe(
      Effect.scoped,
      Effect.provide(Layers.layerVerificationConfinement({
        confinement: Layer.succeed(KernelProcessConfinement.ProcessConfinement)({
          confine: (command) =>
            Effect.sync(() => {
              seen.push(command)
              return command
            })
        })
      }))
    )
  })

  // Every apply journey confines its verification wherever the host can. CI's
  // Linux lanes install bubblewrap, so there a skip would hide the confinement.
  it.skipIf(process.env.CI === undefined || process.platform !== "linux")(
    "has a process sandbox wherever CI runs this suite on Linux",
    () => {
      expect(sandboxAvailable).toBe(true)
    }
  )

  it.effect.skipIf(!sandboxAvailable)(
    "confines an install whose lifecycle script the agent rewrote",
    () =>
      Effect.gen(function*() {
        // The review's reproduction: the argv is the operator's unchanged
        // `npm install`, and the manifest it reads names a `preinstall`.
        const base = realpathSync(mkdtempSync(join(tmpdir(), "migrate-confined-install-")))
        try {
          const project = join(base, "project")
          const outside = join(base, "outside-the-project")
          mkdirSync(join(project, ".git", "hooks"), { recursive: true })
          mkdirSync(join(project, ".smithers-migrate"), { recursive: true })
          writeFileSync(join(project, ".smithers-migrate", "pending-unit.json"), "host-owned")
          const attempt = (path: string): string =>
            `try { fs.writeFileSync(${JSON.stringify(path)}, 'planted') } catch (error) { console.log('refused ' + ${
              JSON.stringify(path)
            }) }`
          const program = [
            "const fs = require('node:fs')",
            attempt(outside),
            attempt(".git/hooks/pre-commit"),
            attempt(".smithers-migrate/pending-unit.json"),
            "fs.writeFileSync('inside-the-project', 'written')",
            "console.log('operator value: ' + process.env.MIGRATE_OPERATOR_VALUE)",
            "console.log('home=' + process.env.HOME)"
          ].join("; ")
          writeFileSync(
            join(project, "package.json"),
            JSON.stringify({
              name: "planted",
              version: "1.0.0",
              scripts: { preinstall: `node -e ${JSON.stringify(program)}` }
            })
          )

          const result = yield* Verify.run({
            root: project,
            commands: {
              install: Units.argv("npm", "install", "--no-audit", "--no-fund", "--foreground-scripts"),
              typecheck: [],
              flowsDir: "flows"
            },
            expectFlows: false,
            sealed: [".smithers-migrate"]
          }).pipe(
            Effect.provide(Layer.merge(
              NodeServices.layer,
              Layers.layerVerificationConfinement({
                environment: { ...process.env, MIGRATE_OPERATOR_VALUE: "operator-only" }
              })
            ))
          )

          expect(result.install?.exitCode, result.install?.stderrTail).toBe(0)
          // The script ran, and it could write the project.
          expect(readFileSync(join(project, "inside-the-project"), "utf8")).toBe("written")
          // It reached nothing outside the project, no version-control hook,
          // and nothing the host owns.
          expect(existsSync(outside)).toBe(false)
          expect(existsSync(join(project, ".git", "hooks", "pre-commit"))).toBe(false)
          expect(readFileSync(join(project, ".smithers-migrate", "pending-unit.json"), "utf8")).toBe("host-owned")
          expect(result.install?.stdoutTail).toContain("refused .git/hooks/pre-commit")
          expect(result.install?.stdoutTail).toContain("refused .smithers-migrate/pending-unit.json")
          // It saw neither the operator's environment nor the operator's home.
          expect(result.install?.stdoutTail).toContain("operator value: undefined")
          expect(result.install?.stdoutTail).not.toContain(`home=${homedir()}`)
        } finally {
          rmSync(base, { recursive: true, force: true })
        }
      }),
    120_000
  )
})

describe("Layers.layerVerificationConfinement on a host with no sandbox", () => {
  const without = (platform: NodeJS.Platform): ProcessSandbox.Host => ({
    ...ProcessSandbox.host(),
    platform,
    executable: () => undefined
  })
  const built = (host: ProcessSandbox.Host) =>
    Effect.flip(Effect.scoped(Layer.build(Layers.layerVerificationConfinement({ host }))))

  it.effect("refuses to build on Linux without bubblewrap, naming it and the opt-out", () =>
    Effect.gen(function*() {
      const failure = yield* built(without("linux"))
      expect(failure.code).toBe("no-sandbox")
      expect(failure.message).toBe("verification commands need a process sandbox, and this host has none")
      expect(failure.details).toContain("bwrap is not on PATH (install the bubblewrap package)")
      expect(failure.details).toContain("--verify-unconfined")
    }))

  it.effect("refuses to build on Windows, which has no sandbox to install", () =>
    Effect.gen(function*() {
      const failure = yield* built(without("win32"))
      expect(failure.code).toBe("no-sandbox")
      expect(failure.details).toContain("win32 has no process sandbox this tool can use.")
      expect(failure.details).not.toContain("docker")
      expect(failure.details).toContain("--verify-unconfined")
    }))

  it.effect("runs a command exactly as given once the operator chooses to run unconfined", () =>
    Effect.gen(function*() {
      const command = ChildProcess.make("npm", ["install"], { cwd: "/project", env: { NPM_TOKEN: "token" } })
      const confinement = yield* KernelProcessConfinement.ProcessConfinement
      const started = yield* Effect.scoped(confinement.confine(command, {
        workspaceRoot: "/project",
        reads: ["."],
        writes: ["."],
        readOnly: [],
        network: "open"
      }))
      expect(started).toBe(command)
    }).pipe(
      Effect.provide(Layers.layerVerificationConfinement({
        host: without("win32"),
        verifyUnconfined: true,
        environment: { PATH: "/usr/bin" }
      }))
    ))

  it("words the warning an entry point prints for that choice", () => {
    expect(Command.unconfinedWarning).toBe(Layers.unconfinedWarning)
    expect(Layers.unconfinedWarning).toContain("--verify-unconfined")
    expect(Layers.unconfinedWarning).toContain("with no sandbox")
    expect(Layers.unconfinedWarning).toContain("your privileges, your environment, and your credentials")
  })
})

describe("Layers.layerVerificationConfinement in the host's sandbox", () => {
  const temporaries: Array<string> = []
  const project = (files: Readonly<Record<string, string>>): { readonly base: string; readonly root: string } => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "migrate-verification-")))
    temporaries.push(base)
    const root = join(base, "project")
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(root, name, ".."), { recursive: true })
      writeFileSync(join(root, name), content)
    }
    return { base, root }
  }
  const verify = (
    root: string,
    commands: Omit<Contract.Commands, "flowsDir">,
    config: Layers.VerificationConfig = {}
  ) =>
    Verify.run({ root, commands: { ...commands, flowsDir: "flows" }, expectFlows: false }).pipe(
      Effect.provide(Layer.merge(
        NodeServices.layer,
        Layers.layerVerificationConfinement({ root, environment: process.env, ...config })
      )),
      Effect.ensuring(Effect.sync(() => {
        for (const base of temporaries.splice(0)) rmSync(base, { recursive: true, force: true })
      }))
    )
  const printing = (path: string): Contract.VerificationCommand =>
    Units.argv("node", "-e", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(path)}, "utf8"))`)
  const packageManagers = ["npm", "pnpm"].every((name) => ProcessSandbox.host().executable(name) !== undefined)

  it.effect.skipIf(!sandboxAvailable || !packageManagers)(
    "runs pnpm, an npm script that starts npm and pnpm, and a shell-line override",
    () =>
      Effect.gen(function*() {
        const { root } = project({
          "package.json": JSON.stringify({
            name: "confined-toolchain",
            version: "1.0.0",
            scripts: {
              own: "node -e \"console.log('own-script-ran')\"",
              nested: "npm --version && pnpm --version && echo nested-ran"
            }
          })
        })

        const result = yield* verify(root, {
          // pnpm starts every script through a sequenced socketpair.
          format: Units.argv("pnpm", "run", "own"),
          // The package manager the host resolved starts two more by name.
          typecheck: [Units.argv("npm", "run", "nested")],
          // The operator's override is a shell line, resolved by `/bin/sh`.
          test: "npm run own"
        })

        expect(result.format?.exitCode, result.format?.stderrTail).toBe(0)
        expect(result.format?.stdoutTail).toContain("own-script-ran")
        expect(result.typecheck[0]?.exitCode, result.typecheck[0]?.stderrTail).toBe(0)
        expect(result.typecheck[0]?.stdoutTail).toContain("nested-ran")
        expect(result.tests?.command).toBe("npm run own")
        expect(result.tests?.exitCode, result.tests?.stderrTail).toBe(0)
        expect(result.tests?.stdoutTail).toContain("own-script-ran")
      }),
    180_000
  )

  it.effect.skipIf(!sandboxAvailable)(
    "hides dotenv files from a verification command until --verify-read names one",
    () =>
      Effect.gen(function*() {
        const files = {
          ".env": "root-secret-line",
          "packages/api/.env.local": "nested-secret-line",
          "packages/api/.env.example": "example-line",
          "settings.json": "plain-settings"
        }
        const commands = {
          format: printing(".env"),
          typecheck: [printing("packages/api/.env.local"), printing("packages/api/.env.example")],
          test: printing("settings.json")
        }

        const hidden = yield* verify(project(files).root, commands)
        for (const command of [hidden.format, ...hidden.typecheck]) {
          expect(`${command?.stdoutTail}${command?.stderrTail}`).not.toMatch(/root-secret|nested-secret|example-line/)
          expect(command?.stdoutTail).toBe("")
        }
        expect(hidden.tests?.stdoutTail).toBe("plain-settings")

        // A relative path resolves from the project root and reopens that one file.
        const reopened = yield* verify(project(files).root, commands, {
          verifyRead: ["packages/api/.env.example"]
        })
        expect(reopened.typecheck[1]?.exitCode, reopened.typecheck[1]?.stderrTail).toBe(0)
        expect(reopened.typecheck[1]?.stdoutTail).toBe("example-line")
        expect(reopened.format?.stdoutTail).toBe("")
        expect(reopened.typecheck[0]?.stdoutTail).toBe("")
      }),
    120_000
  )

  it.effect.skipIf(!sandboxAvailable)(
    "opens a path outside the project only when --verify-read names it",
    () =>
      Effect.gen(function*() {
        const closed = project({ "package.json": "{}" })
        const outside = join(closed.base, "registry-settings")
        writeFileSync(outside, "outside-value")

        const refused = yield* verify(closed.root, { typecheck: [printing(outside)] })
        expect(refused.typecheck[0]?.exitCode).not.toBe(0)
        expect(refused.typecheck[0]?.stdoutTail).toBe("")

        const opened = project({ "package.json": "{}" })
        const named = join(opened.base, "registry-settings")
        writeFileSync(named, "outside-value")
        const read = yield* verify(opened.root, {
          typecheck: [printing(named)],
          test: Units.argv("node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(named)}, "changed")`)
        }, { verifyRead: [named] })
        expect(read.typecheck[0]?.exitCode, read.typecheck[0]?.stderrTail).toBe(0)
        expect(read.typecheck[0]?.stdoutTail).toBe("outside-value")
        expect(read.tests?.exitCode).not.toBe(0)

        // A host that names no root passes an absolute path through as it is.
        const rootless = project({ "package.json": "{}" })
        const absolute = join(rootless.base, "registry-settings")
        writeFileSync(absolute, "outside-value")
        const direct = yield* verify(rootless.root, { typecheck: [printing(absolute)] }, {
          root: undefined,
          verifyRead: [absolute]
        })
        expect(direct.typecheck[0]?.exitCode, direct.typecheck[0]?.stderrTail).toBe(0)
        expect(direct.typecheck[0]?.stdoutTail).toBe("outside-value")
      }),
    120_000
  )
})
