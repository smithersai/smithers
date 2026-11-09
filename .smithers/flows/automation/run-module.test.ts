/**
 * `runModule` over real child processes: the default Node interpreter, a named
 * shell interpreter, and the typed failure for a non-zero exit and for an
 * interpreter that cannot start.
 */
import { Effect, Exit } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { ModuleFailed, runModule, vibeLangLoader } from "./run-module.ts"

const inScratch = async <A>(body: (directory: string) => Promise<A>) => {
  // A checkout root of its own, so the module's name is relative to it.
  const directory = mkdtempSync(join(tmpdir(), "run-module-"))
  writeFileSync(join(directory, "pnpm-workspace.yaml"), "")
  try {
    return await body(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const failureOf = (exit: Exit.Exit<void, ModuleFailed>): ModuleFailed => {
  assert.ok(Exit.isFailure(exit))
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  assert.ok(error !== undefined && error._tag === "Fail", JSON.stringify(exit.cause))
  return error.error
}

test("runs a module with this Node binary, its arguments and the extra environment", async () => {
  await inScratch(async (directory) => {
    const module = join(directory, "write.mjs")
    writeFileSync(
      module,
      "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], `${process.argv[3]} ${process.env.RUN_MODULE_PROBE}`)\n"
    )
    const out = join(directory, "out.txt")
    const exit = await Effect.runPromiseExit(
      runModule(pathToFileURL(module), [out, "node"], { env: { RUN_MODULE_PROBE: "seen" } })
    )
    assert.ok(Exit.isSuccess(exit))
    assert.equal(readFileSync(out, "utf8"), "node seen")
  })
})

test("runs a shell script with the named interpreter", async () => {
  await inScratch(async (directory) => {
    const script = join(directory, "write.sh")
    // `[[` is bash, not POSIX sh: the script runs only under the interpreter named.
    writeFileSync(script, "[[ \"$2\" == bash ]] && printf '%s' \"$2\" > \"$1\"\n")
    const out = join(directory, "out.txt")
    const exit = await Effect.runPromiseExit(runModule(pathToFileURL(script), [out, "bash"], { interpreter: "bash" }))
    assert.ok(Exit.isSuccess(exit))
    assert.equal(readFileSync(out, "utf8"), "bash")
  })
})

test("a non-zero exit is a typed failure naming the module and its exit code", async () => {
  await inScratch(async (directory) => {
    const script = join(directory, "fail.sh")
    writeFileSync(script, "exit 3\n")
    const failure = failureOf(
      await Effect.runPromiseExit(runModule(pathToFileURL(script), [], { interpreter: "bash" }))
    )
    assert.equal(failure._tag, "automation/ModuleFailed")
    assert.equal(failure.module, "fail.sh")
    assert.equal(failure.exitCode, 3)
    assert.equal(failure.signal, null)
  })
})

test("an interpreter that cannot start is a typed failure with no exit code", async () => {
  const failure = failureOf(
    await Effect.runPromiseExit(
      runModule(new URL("./run-module.ts", import.meta.url), [], { interpreter: "smithers-no-such-interpreter" })
    )
  )
  assert.equal(failure.module, ".smithers/flows/automation/run-module.ts")
  assert.equal(failure.exitCode, null)
})

test("preloads VibeLang's loader for a Node module when the checkout installs it", async () => {
  await inScratch(async (directory) => {
    const module = join(directory, "flags.mjs")
    writeFileSync(
      module,
      "import { writeFileSync } from 'node:fs'\nwriteFileSync(process.argv[2], JSON.stringify(process.execArgv))\n"
    )
    const out = join(directory, "out.json")
    const exit = await Effect.runPromiseExit(runModule(pathToFileURL(module), [out], { nodeArgs: ["--no-warnings"] }))
    assert.ok(Exit.isSuccess(exit))
    const [loader = "", ...rest] = JSON.parse(readFileSync(out, "utf8")) as Array<string>
    assert.deepEqual(rest, ["--no-warnings"])
    assert.equal(loader, `--import=${import.meta.resolve("vibelang/register")}`)
    assert.deepEqual(vibeLangLoader(), [loader])
  })
})
