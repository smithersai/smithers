import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import stringWidth from "string-width"
import { RunCardView } from "../src/run-card-view.tsx"
import * as RunCard from "../src/run-card.ts"
import * as Subagents from "../src/subagents.ts"
import * as Theme from "../src/theme.ts"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

// Commands are inert transcript data, never passed to a shell or a Host.
const tab: Tab = {
  id: "receipt",
  depth: 0,
  title: "Check",
  prompt: "Check.",
  seat: "test",
  file: "session",
  status: "running",
  startedAt: 0
}
const history = (commands: ReadonlyArray<readonly [string, number | undefined]>): Transcript.Transcript => ({
  ...Transcript.empty,
  items: [{
    kind: "cell",
    id: "c",
    index: 1,
    source: "original cell",
    prose: "",
    status: "done",
    startedAt: 0,
    printed: "original output",
    calls: commands.map(([subject, exit], index) => ({
      flow: "bash",
      subject,
      status: "ok",
      startedAt: index,
      ...(exit === undefined ? {} : { exit })
    }))
  }]
})
const retained = [
  "git diff | grep x",
  "jj diff | grep x",
  "git log --oneline | head",
  "git status | jj diff",
  "git diff || grep x",
  "git diff && test -s result",
  "git diff; npm test",
  "git diff\nnpm test",
  "git diff --check",
  "git diff --exit-code",
  "git diff --quiet",
  "jj diff --quiet=true",
  "git diff > result",
  "git diff &",
  "git diff $(node check.mjs)",
  "git diff `node check.mjs`",
  "git diff # comment\nnode check.mjs",
  "git diff -- \"literal|path\"",
  "git diff -- 'literal;path'",
  "git diff -- 'literal&&path'",
  "git diff -- 'literal||path'",
  "git diff -- 'git status;git diff'",
  "git diff -- 'unterminated",
  "git diff;",
  "git diff;;git status",
  "git diff &&",
  "git diff --check=true"
]

test.each(retained)("retains uncertain or validating command %j and its actual result", (command) => {
  for (const exit of [0, 1, 7]) {
    const transcript = history([["node prior-check.mjs", 2], [command, exit], ["jj st", 0]])
    expect(Subagents.result(transcript).check).toEqual({ command: Subagents.oneLine(command), exit })
    const card = RunCard.worker({ ...tab, status: "done", endedAt: 10 }, transcript, 99)
    expect(card.receipts).toEqual([`${Subagents.oneLine(command)} exit ${exit}`])
  }
})

test.each([
  "git status",
  "git status --porcelain",
  "git diff -- src",
  "git log --oneline",
  "git show HEAD",
  "git blame src/a.ts",
  "jj st",
  "jj status",
  "jj diff",
  "git status --porcelain; git diff",
  "git status&&jj diff",
  "git status || jj diff",
  "git status\njj diff",
  "  git diff\n"
])("only plain successful state displays %j leave the meaningful check in place", (command) => {
  const before = history([["git diff | grep x", 0]])
  expect(Subagents.result(history([["git diff | grep x", 0], [command, 0]])).check)
    .toEqual(Subagents.result(before).check)
  expect(Subagents.result(history([[command, 3]])).check).toEqual({ command: Subagents.oneLine(command), exit: 3 })
  expect(Subagents.result(history([[command, 0]])).check).toBeUndefined()
})

const multiline: ReadonlyArray<readonly [string, string]> = [
  ["node first.mjs\nnode second.mjs", "node first.mjs ↵ node second.mjs"],
  ["bun test \\\n  ./test &&\n  bun run typecheck\n", "bun test \\ ↵   ./test && ↵   bun run typecheck ↵ "],
  ["printf '%s' 'a\n  b;|&&\n'", "printf '%s' 'a ↵   b;|&& ↵ '"],
  ["printf \"%s\" \"a\n  b\"", "printf \"%s\" \"a ↵   b\""],
  ["cat <<EOF\n  foo\n\nEOF", "cat <<EOF ↵   foo ↵  ↵ EOF"],
  ["cat <<'EOF'\nfoo; | && $HOME\nEOF", "cat <<'EOF' ↵ foo; | && $HOME ↵ EOF"],
  ["cat <<-EOF\n\t\tfoo\nEOF", "cat <<-EOF ↵   foo ↵ EOF"],
  ["git diff\r\nnpm test", "git diff ↵ npm test"],
  ["printf '%s' 'a\rb'", "printf '%s' 'a ↵ b'"],
  ["if test -f a; then\n  echo a\nfi", "if test -f a; then ↵   echo a ↵ fi"],
  ["git diff |\n  grep x", "git diff | ↵   grep x"],
  ["cat <<EOF\n\nEOF\nnode check.mjs", "cat <<EOF ↵  ↵ EOF ↵ node check.mjs"],
  ["printf '%s' 'literal ↵ value'", "printf '%s' 'literal ↵ value'"],
  ["  node check.mjs  ", "  node check.mjs  "]
]

test.each(multiline)("command source and live/settled cards preserve %j", (command, display) => {
  const transcript = history([[command, 7]])
  const original = structuredClone(transcript)
  expect(Subagents.oneLine(command)).toBe(display)
  // Line breaks become markers and each tab one space; nothing else changes, even in quotes and heredocs.
  if (!command.includes(" ↵ ")) {
    expect(display.replaceAll(" ↵ ", "\n"))
      .toBe(command.replaceAll(/\r\n|\r/g, "\n").replaceAll("\t", " "))
  }
  // Nothing the terminal would act on survives into a card line.
  for (const character of display) expect(character.codePointAt(0)).toBeGreaterThan(0x1f)
  expect(Subagents.result(transcript).check).toEqual({ command: display, exit: 7 })
  const live = RunCard.worker(tab, transcript, 99)
  const settled = RunCard.worker({ ...tab, status: "done", endedAt: 10 }, transcript, 99)
  expect(live.steps).toEqual([`✗ ${display} exit 7`])
  expect(live.receipts).toEqual([`${display} exit 7`])
  expect(settled.receipts).toEqual(live.receipts)
  expect(transcript).toEqual(original)
})

test("pending or refused commands cannot invent an exit or replace a prior check", () => {
  expect(Subagents.result(history([["node check.mjs", 1], ["git diff | grep x", undefined]])).check)
    .toEqual({ command: "node check.mjs", exit: 1 })
})

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  if (setup !== undefined) act(() => setup?.renderer.destroy())
  setup = undefined
})

test.each([80, 40])("native live steps clip while command receipts wrap at %s columns", async (width) => {
  const command = `printf '%s' 'first\n  second ${"word ".repeat(20)}tail'`
  const transcript = history([[command, 0]])
  const card = RunCard.worker(tab, transcript, 99)
  expect(card.steps).toEqual([`✓ ${Subagents.oneLine(command)} exit 0`])
  expect(card.receipts).toEqual([`${Subagents.oneLine(command)} exit 0`])
  setup = await act(() =>
    testRender(
      <RunCardView id="receipt" card={card} width={width} focused={false} lane={Theme.color.info} onOpen={() => {}} />,
      { width, height: 16 }
    )
  )
  await act(() => setup!.renderOnce())
  const frame = setup.captureCharFrame()
  expect(frame).toContain("first ↵")
  expect(frame).toContain("…")
  expect(frame).toContain("tail' exit 0")
  expect(frame).not.toContain(";")
  const lines = frame.split("\n").filter((line) => line.trim() !== "")
  expect(lines.length).toBeGreaterThan(3)
  for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width)
  expect(transcript.items[0]).toMatchObject({ calls: [{ subject: command, exit: 0 }] })
})

test("a tabbed heredoc body clips with a marker and stays whole in the receipt", async () => {
  const command = `cat <<-EOF\n${"\t".repeat(12)}body tail\nEOF`
  const transcript = history([[command, 0]])
  const live = RunCard.worker(tab, transcript, 99)
  expect(live.steps).toEqual([`✓ ${Subagents.oneLine(command)} exit 0`])
  setup = await act(() =>
    testRender(
      <RunCardView id="receipt" card={live} width={40} focused={false} lane={Theme.color.info} onOpen={() => {}} />,
      { width: 40, height: 16 }
    )
  )
  await act(() => setup!.renderOnce())
  // The step is wider than the pane, so it says so rather than losing `body tail ↵ EOF` silently.
  const step = setup.captureCharFrame().split("\n")[1]!
  expect(step).toContain("cat <<-EOF ↵")
  expect(step).toContain("…")
  expect(stringWidth(step)).toBeLessThanOrEqual(40)
  act(() => setup!.renderer.destroy())
  setup = undefined
  const settled = RunCard.worker({ ...tab, status: "done", endedAt: 10 }, transcript, 99)
  setup = await act(() =>
    testRender(
      <RunCardView id="receipt" card={settled} width={40} focused={false} lane={Theme.color.info} onOpen={() => {}} />,
      { width: 40, height: 16 }
    )
  )
  await act(() => setup!.renderOnce())
  const frame = setup.captureCharFrame()
  for (const word of ["cat <<-EOF", "body tail", "EOF exit 0"]) expect(frame).toContain(word)
  for (const line of frame.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(40)
  expect(transcript.items[0]).toMatchObject({ calls: [{ subject: command, exit: 0 }] })
})

test.each([80, 40].flatMap((width) => [
  { width, command: "git diff | grep x", visible: "git diff | grep x exit 0" },
  { width, command: "cat <<EOF\nfoo\nEOF", visible: "cat <<EOF ↵ foo ↵ EOF exit 0" }
]))("native receipt $command renders faithfully at $width columns", async ({ width, command, visible }) => {
  const transcript = history([["node prior-check.mjs", 0], [command, 0], ["jj st", 0]])
  const card = RunCard.worker({ ...tab, status: "done", endedAt: 10 }, transcript, 99)
  setup = await act(() =>
    testRender(
      <RunCardView id="receipt" card={card} width={width} focused={false} lane={Theme.color.info} onOpen={() => {}} />,
      { width, height: 16 }
    )
  )
  await act(() => setup!.renderOnce())
  const frame = setup.captureCharFrame()
  expect(frame).toContain(visible)
  expect(frame).not.toContain("cat <<EOF; foo; EOF")
  expect(frame).not.toContain("node prior-check.mjs exit 0")
  expect(frame).toContain("enter Open")
  for (const line of frame.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width)
  act(() => setup!.renderer.destroy())
  setup = undefined
})
