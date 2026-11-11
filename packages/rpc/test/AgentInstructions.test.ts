import { describe, expect, test } from "vitest"
import {
  agentCommandLine,
  cantYetsSentence,
  namedCantYets,
  SMITHERS_SUBJECT_READS_DOCS_LINE,
  SMITHERS_SUBJECT_WITHOUT_DOCS_LINE,
  smithersSubjectLine
} from "../src/AgentInstructions.ts"

/*
 * The prompt lines that change with a door's catalog: the Smithers subject line,
 * the can't-yets, and how one command is listed.
 */

describe("smithersSubjectLine", () => {
  test("names the documentation only when the turn is offered the command that reads it", () => {
    expect(smithersSubjectLine(true)).toBe(SMITHERS_SUBJECT_READS_DOCS_LINE)
    expect(smithersSubjectLine(false)).toBe(SMITHERS_SUBJECT_WITHOUT_DOCS_LINE)
    expect(SMITHERS_SUBJECT_READS_DOCS_LINE).not.toBe(SMITHERS_SUBJECT_WITHOUT_DOCS_LINE)
  })
})

describe("namedCantYets", () => {
  const fileLine = (cantYets: ReadonlyArray<string>) => cantYets.find((line) => line.startsWith("read arbitrary files"))

  test("a door with no file reader reads no file at all", () => {
    expect(fileLine(namedCantYets([]))).toBe("read arbitrary files off the user's machine")
  })

  test("a door with file readers names them as the only way to read a repository", () => {
    expect(fileLine(namedCantYets(["/file", "/files"]))).toBe(
      "read arbitrary files off the user's machine — only a repository opened in Smithers, through /file and /files"
    )
  })

  test("names email, messaging, pushing and deploying whatever the door reads", () => {
    const cantYets = namedCantYets([])
    expect(cantYets).toHaveLength(5)
    expect(cantYets).toContain("send or draft email")
    expect(cantYets).toContain("push to a branch or open a pull request — not directly, and not through a run")
  })
})

describe("cantYetsSentence", () => {
  test("states every can't-yet, in order, before the one honest answer", () => {
    const sentence = cantYetsSentence(["send email", "deploy"])
    expect(sentence.startsWith("You cannot send email; deploy. ")).toBe(true)
    expect(sentence).toContain("say plainly that you can't do it yet")
  })
})

describe("agentCommandLine", () => {
  test("lists a command with its arguments and summary", () => {
    expect(agentCommandLine({ name: "todo", args: "<title>", summary: "Create a TODO", agent: "run" })).toBe(
      "- /todo <title> — Create a TODO"
    )
  })

  test("omits absent arguments", () => {
    expect(agentCommandLine({ name: "home", summary: "Show home" })).toBe("- /home — Show home")
  })

  test("says a confirm command only asks", () => {
    expect(agentCommandLine({ name: "merge", summary: "Merge a branch", agent: "confirm" })).toBe(
      "- /merge — Merge a branch (asks the person: it only shows them what to confirm, and their press acts)"
    )
  })
})
