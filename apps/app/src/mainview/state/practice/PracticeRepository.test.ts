import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Plan, validatePlan } from "../../../../../../flows/coding/schema"
import { validateTutorialPlan } from "../../cards/tutorial2-agent_change-contract"
import {
  practiceCommitsSource, namesPractice, PRACTICE_REPO, practiceChange, practiceCommits, practiceFile, practiceJournal, practicePickOf,
  practicePicker, practicePlan, practiceSnapshot, practiceStack
} from "./PracticeRepository"

/* The pin: every fixture was generated from this base (scripts/record-practice-hello-server.ts). */
test("the fixtures share one pinned base and the plan decodes as one Change with three commits", () => {
  const plan = validateTutorialPlan(Schema.decodeUnknownSync(Plan)(practicePlan))
  validatePlan(plan)
  expect(plan.base.commitId).toBe(practiceSnapshot.base.commitId)
  expect(plan.changes).toHaveLength(1)
  expect(plan.changes[0]!.atoms.map(atom => atom.message)).toEqual(practiceCommits.map(commit => commit.message))
  expect(practiceCommits.map(commit => [commit.tag, commit.locked])).toEqual([["optional", false], ["required", true], ["recommended", false]])
  expect(practiceFile("src/hello.ts")!.split("\n")[1]).toBe("  return `Hello, ${name}!`")
})

test("every pick keeping the fix has a precomputed stack; rebases move exactly the rows that left main's line", () => {
  const cases: Array<[Array<number>, number, number, string]> = [
    [[2, 3], 2, 2, "Rebased 2 commits onto main. Change #1 is ready for review."],
    [[1, 2, 3], 3, 0, "Already in order. Change #1 is a stack of 3."],
    [[1, 2], 2, 0, "Already in order. Change #1 is a stack of 2."],
    [[2], 1, 1, "Rebased 1 commit onto main. Change #1 is ready for review."],
  ]
  for (const [pick, size, rebased, line] of cases) {
    const stack = practiceStack(pick)
    if (typeof stack === "string") throw new Error(stack)
    expect(stack.rows).toHaveLength(size)
    expect(stack.rows.filter(row => "rebased" in row)).toHaveLength(rebased)
    expect(stack.line).toBe(line)
    const change = practiceChange(stack)
    expect(change.stack).toMatchObject({ size, targetBookmark: "main", changeIds: stack.rows.map(row => row.changeId) })
    expect(change.stack?.rows?.map(row => row.message)).toEqual(pick.map(index => practiceCommits[index - 1]!.message))
    for (const row of stack.rows) {
      const original = practiceCommits.find(commit => commit.changeId === row.changeId)!
      expect(row.commitId === original.commitId).toBe(!("rebased" in row))
    }
  }
  expect(practiceStack([1, 3])).toBe("Commit 2 is the fix for #3; it stays in the Change.")
})

test("commit refs resolve by index, change id or id prefix; the picker starts with every row checked", () => {
  const [one, two] = practiceCommits
  expect(practicePickOf(["1", two!.changeId, one!.commitId.slice(0, 7)])).toEqual([1, 2, 1])
  expect(practicePickOf(["deadbeef"])).toBe("No commit deadbeef on smithers/fix-hello-3.")
  expect(practicePicker().picked).toEqual([1, 2, 3])
  expect(practicePicker().rows.find(row => row.locked)?.hint).toBe("the fix for #3")
  expect(namesPractice(`3 ${PRACTICE_REPO}`)).toBe(true)
  expect(namesPractice("3 smithersai/hello-server")).toBe(false)
})

test("the recorded run shows the failing test before the passing one and ends with three commits", () => {
  const steps = practiceJournal.steps.map(step => step.text)
  expect(steps.indexOf("Fails on the old code: Hello, null! (expected)")).toBeLessThan(steps.indexOf("2 tests pass"))
  expect(steps.at(-1)).toBe("3 commits on smithers/fix-hello-3")
  expect(practiceJournal.events.filter(event => event.kind === "control.agent.turn-opened")).toHaveLength(4)
})

test("the commits views read both branches newest first, and one commit with its patches", () => {
  const main = practiceCommitsSource.list()
  if (typeof main === "string") throw new Error(main)
  expect(main.branch).toBe("main")
  expect(main.commits.map((commit) => commit.title)).toEqual(["Run tests on pushes", "Add test for greet", "fix typo", "Add /hello greeting",
    "wip hello", "Document how to run the server (closes #1)", "Add HTTP server with /health", "Initial commit"])
  const fix = practiceCommitsSource.list("smithers/fix-hello-3")
  if (typeof fix === "string") throw new Error(fix)
  expect(fix.commits.slice(0, 3).map((commit) => commit.commitId)).toEqual(practiceCommits.map((commit) => commit.commitId).reverse())
  expect(fix.commits[0]?.author).toMatchObject({ name: "Smithers", login: "smithers" })
  const read = practiceCommitsSource.read(fix.commits[1]!.changeId!)
  if (typeof read === "string") throw new Error(read)
  expect(read.files).toEqual([expect.objectContaining({ path: "src/hello.ts", changeType: "modified", additions: 1, deletions: 1 })])
  expect(read.files[0]?.patch).toContain(`name || "world"`)
  expect(read.parents[0]?.changeId).toBe(fix.commits[2]?.changeId)
  expect(practiceCommitsSource.list("nope")).toContain("No branch nope")
  expect(practiceCommitsSource.read("deadbeef")).toBe("No commit deadbeef in hello-server.")
})
