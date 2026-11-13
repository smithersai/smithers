/**
 * What an author is told when a declaration names an attr the rule does not
 * have.
 *
 * The schema knows the accepted keys, so a message that reports only the
 * rejected one makes the author go read the rule's source to learn the rest.
 * That cost is real: the message "Expected no excess property at
 * ["on"]["pullRequestTarget"]" sent a reader to the wrong module and produced
 * a bug report against a property the schema already had. These tests pin the
 * remedy into the message.
 */
import { describe, expect, it } from "vitest"
import * as Attr from "../src/Attr.ts"
import { Smithers } from "../src/index.ts"

describe("an attr the rule does not have", () => {
  it("names the rejected key and lists what the rule accepts", () => {
    expect(() => Smithers.Filegroup({ srcs: [], cwdd: "." } as never))
      .toThrow(/unknown property "cwdd"/)
    expect(() => Smithers.Filegroup({ srcs: [], cwdd: "." } as never))
      .toThrow(/accepted: srcs, cwd/)
  })

  it("suggests the near match an author most likely meant", () => {
    expect(() => Smithers.Filegroup({ srcs: [], cwdd: "." } as never))
      .toThrow(/did you mean "cwd"\?/)
  })

  it("names the enclosing attr when the rejected key is nested", () => {
    const declare = () => Smithers.Github.Workflow({ name: "x", on: { pullRequestTargett: true }, run: [] } as never)
    // The accepted keys are the enclosing struct's, not the rule's top level.
    expect(declare).toThrow(/unknown property "pullRequestTargett" at "on"/)
    expect(declare).toThrow(/did you mean "pullRequestTarget"\?/)
    expect(declare).toThrow(/accepted: pullRequest, pullRequestTarget/)
  })

  it("offers no suggestion when nothing is close, and still lists the keys", () => {
    const declare = () => Smithers.Filegroup({ srcs: [], zzzzzzzz: "." } as never)
    expect(declare).toThrow(/unknown property "zzzzzzzz"/)
    expect(declare).toThrow(/accepted: srcs, cwd/)
    expect(declare).not.toThrow(/did you mean/)
  })

  it("keeps the rule id and the reason the message already carried", () => {
    expect(() => Smithers.Filegroup({ srcs: [], cwdd: "." } as never))
      .toThrow(/Filegroup declaration is invalid/)
  })

  it("says nothing about unknown properties when the failure is a wrong type", () => {
    // A type failure is not a spelling failure; the guidance must not fire.
    expect(() => Smithers.Filegroup({ srcs: "not-an-array" } as never))
      .not.toThrow(/unknown property/)
  })
})

describe("shared Shell executable selectors", () => {
  it("accepts every selector the Shell schema accepts", () => {
    expect(Attr.executableSelectors).toEqual(["bin", "bun", "shell", "script"])
    for (const selector of ["bin", "bun", "shell", "script"]) {
      expect(() => Attr.requireOneExecutable("Shell", { [selector]: "program" })).not.toThrow()
    }
  })

  it("rejects the removed command selector, missing selectors, and competing selectors", () => {
    for (const attrs of [{ command: "echo hello" }, {}, { bin: "node", shell: "echo hello" }]) {
      expect(() => Attr.requireOneExecutable("Shell", attrs)).toThrow(/exactly one of bin, bun, shell, script/)
    }
  })

  it("keeps custom selector sets for generated-output declarations", () => {
    expect(() => Attr.requireOneExecutable("Generate", { command: "echo hello" }, ["emit", "script", "bin", "command"]))
      .not.toThrow()
    expect(() => Attr.requireOneExecutable("Generate", { shell: "echo hello" }, ["emit", "script", "bin", "command"]))
      .toThrow(/exactly one of emit, script, bin, command/)
  })
})
