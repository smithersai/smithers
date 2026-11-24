/**
 * What a stored checkpoint names is read from `.git/config`, which the agent
 * can write, and becomes an argument to host git. It is an object name or it
 * is refused before any git that would take it as an argument starts.
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Cause, Effect, Exit, Layer, Option, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Checkpoints from "../src/Checkpoints.ts"

const host = (spawns: Array<string>, stored: string) =>
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.sync(() => {
        const standard = command as ChildProcess.StandardCommand
        const line = [standard.command, ...standard.args as ReadonlyArray<string>].join(" ")
        spawns.push(line)
        const stdout = line.includes("--show-toplevel")
          ? "/work/repo\n/work/repo/.git\n/work/repo/.git/index\nsha1\n"
          : line.includes("--get flows-checkpoint")
          ? `${stored}\n`
          : line.includes("stat -c %d")
          ? "1\n1\n1\n\n"
          : ""
        return makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.succeed(ExitCode(line.includes("--get-regexp") ? 1 : 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
  }))

const materialize = (spawns: Array<string>, stored: string) =>
  Effect.runPromiseExit(
    Effect.flatMap(
      Checkpoints.makeGit({ root: "/work/repo" }),
      (store) => store.materialize("cp-0-1", () => Effect.void)
    )
      .pipe(Effect.provide(host(spawns, stored)))
  )

describe("a checkpoint commit read from .git/config", () => {
  it.each([
    ["an option", "--empty"],
    ["a ref name", "refs/heads/main"],
    ["an abbreviated id", "abc123"],
    ["upper-case hex", "A".repeat(40)],
    ["an id with a trailing option", `${"a".repeat(40)} --empty`]
  ])("refuses %s before host git takes it as an argument", async (_, stored) => {
    const spawns: Array<string> = []
    const exit = await materialize(spawns, stored)
    const failure = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
    expect(failure).toMatchObject({ code: "invalid_input" })
    expect((failure as { message: string }).message).toContain("is not a commit id")
    expect(spawns.some((line) => line.includes("read-tree") || line.includes("init --quiet --bare"))).toBe(false)
    expect(spawns.every((line) => !line.startsWith("git ") || !line.includes(stored))).toBe(true)
  })

  it.each([["SHA-1", "a1".repeat(20)], ["SHA-256", "b2".repeat(32)]])(
    "passes a %s object name to read-tree after --end-of-options",
    async (_, stored) => {
      const spawns: Array<string> = []
      const exit = await materialize(spawns, stored)
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(spawns.find((line) => line.includes("read-tree"))).toMatch(
        new RegExp(` read-tree --reset -u --end-of-options ${stored}$`)
      )
    }
  )
})
