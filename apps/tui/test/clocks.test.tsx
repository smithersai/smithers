/**
 * A clock reads whole or not at all on every surface that clips: the footer, the
 * focused chip, a run card, a Summary row, a graph box and a worker's header.
 * At 80x24 the footer showed `⠏ 5.1` without its unit while approval keys
 * filled it (#3672, F09).
 */
import { testRender } from "@opentui/react/test-utils"
import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { act } from "react"
import stringWidth from "string-width"
import { StatusLine } from "../src/app-view.tsx"
import * as Extension from "../src/extension.ts"
import * as Inbox from "../src/inbox.ts"
import * as Keys from "../src/keys.ts"
import { RunCardView } from "../src/run-card-view.tsx"
import * as RunCard from "../src/run-card.ts"
import * as SubagentView from "../src/subagent-view.tsx"
import { chip, TabStrip, WorkerView } from "../src/tabs-view.tsx"
import * as Tabs from "../src/tabs.ts"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

let mounted: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(async () => {
  await act(() => mounted?.renderer.destroy())
  mounted = undefined
})
const draw = async (node: Parameters<typeof testRender>[0], width = 80) => {
  mounted = await act(() => testRender(node, { width, height: 24 }))
  await act(() => mounted!.renderOnce())
  return mounted.captureCharFrame()
}
const worker = (status: Tab["status"], elapsed: number): Tab => ({
  id: "clock",
  title: "Fix",
  prompt: "Fix",
  depth: 0,
  seat: "replay:test",
  file: "/tmp/clock.jsonl",
  status,
  startedAt: 10_000,
  ...(status === "running" ? {} : { endedAt: 10_000 + elapsed })
})
const models = [{ seat: "replay:test", label: "Test", provider: "Replay" }]
const longModels = [{ seat: "replay:test", label: "Claude Opus 5.5", provider: "Replay" }]
const approvalHints = Keys.registry.filter((binding) => binding.context === "approval")
/** 999,000 seconds: the widest clock a worker reads, with a space inside it. */
const long = 999_000_000

test.each(["⠏ 5.1s", "⠹ 24.4s"])("footer keeps the %s timer and the approval actions at 80x24", async (timer) => {
  const items = [
    { id: "one", text: "a".repeat(timer.length === 6 ? 24 : 23) },
    { id: "two", text: "界".repeat(21) },
    { id: "clock", text: timer }
  ].map((item) => Schema.decodeUnknownSync(Extension.Status)(item))
  const frame = await draw(
    <StatusLine
      lead="inventory-replay (master)"
      width={80}
      hints={approvalHints}
      items={items}
      onItem={() => {}}
      meter={{ percent: 0, label: "" }}
    />
  )
  expect(frame).toContain(timer)
  expect(frame).toContain("y Allow once")
  expect(frame).toContain("n Deny")
})

test.each([80, 60, 40, 24, 16, 8])("footer shows a timer whole or not at all at %s columns", async (width) => {
  const timer = "⠏ 5.1s"
  const frame = await draw(
    <StatusLine
      lead="inventory-replay (master)"
      width={width}
      hints={approvalHints}
      items={[{ id: "clock", text: timer }]}
      onItem={() => {}}
      meter={{ percent: 0, label: "" }}
    />,
    width
  )
  if (width >= 40) expect(frame).toContain(timer)
  if (frame.includes("⠏")) expect(frame).toContain(timer)
  if (width >= 60) expect(frame).toContain("n Deny")
  if (width >= 40) expect(frame).toContain("y Allow once")
})

test.each([80, 60, 40, 32, 24, 16])("a narrow chip keeps its clock whole at %s columns", async (width) => {
  const tab = { ...worker("failed", 24_400), title: "界界界界界界界界界界" }
  const clock = Tabs.clock(24_400)
  const frame = await draw(
    <TabStrip
      chips={[{ id: "chat", label: "Chat" }, { id: "summary", label: "Summary" }, chip(tab, 90_000)]}
      active="tab:clock"
      width={width}
      onSelect={() => {}}
    />,
    width
  )
  if (width >= 32) expect(frame).toContain(clock)
  if (frame.includes(clock.slice(0, 2))) expect(frame).toContain(clock)
})

test.each([80, 60, 40, 18, 12])("a narrow card keeps a long clock whole at %s columns", async (width) => {
  const tab = worker("failed", long)
  const card = RunCard.worker(tab, Transcript.empty, 9_999_999_999)
  const frame = await draw(
    <RunCardView id="long-clock" card={card} width={width} focused={false} lane="#ffffff" onOpen={() => {}} />,
    width
  )
  const head = card.duration.split(" ")[0]!
  if (width >= 18) expect(frame).toContain(card.duration)
  if (frame.includes(head)) expect(frame).toContain(card.duration)
})

test.each([80, 60, 40])("a worker's header keeps its clock whole beside its actions at %s columns", async (width) => {
  const tab = { ...worker("running", 24_400), seat: "replay:long-model-name" }
  const now = 34_400
  const clock = Tabs.clock(24_400)
  const frame = await draw(
    <WorkerView
      tab={tab}
      transcript={Transcript.empty}
      models={[]}
      now={now}
      tick="⠏"
      tone="#ffffff"
      width={width}
      expanded={false}
      onAction={() => {}}
      onBack={() => {}}
      onRelease={() => {}}
      tabs={[tab]}
      cards={{ transcript: () => Transcript.empty, now, lane: () => "#ffffff", focused: undefined, onOpen: () => {} }}
      earlierOpen={false}
      onEarlier={() => {}}
    />,
    width
  )
  if (width >= 60) expect(frame).toContain(clock)
  if (frame.includes(clock.slice(0, 2))) expect(frame).toContain(clock)
})

const rowClocks = [["Test", Tabs.clock(long)], ["Test", "41s"], ["", Tabs.clock(long)], ["Test", ""]] as const

test.each([28, 30, 40, 46, 64, 80])("a Summary row keeps its clock whole and inside a %s cell pane", (inner) => {
  for (const lead of [4, 8, 14]) {
    for (const [seat, clock] of rowClocks) {
      const row: Inbox.Row = {
        key: "w",
        group: "working",
        level: 0,
        status: "running",
        name: "Fix the failing test",
        seat,
        clock
      }
      const drawn = SubagentView.treeRow(row, lead, inner, SubagentView.seatColumn([{ seat }], inner))
      const line = `${" ".repeat(lead)}${drawn.title}${" ".repeat(drawn.gap)}${drawn.aside}`
      // Nothing the pane would cut off, and a clock that is shown is shown whole.
      expect(stringWidth(line.trimEnd())).toBeLessThanOrEqual(inner - 1)
      if (clock !== "") expect(line).toContain(clock)
    }
  }
})

test.each([[46, 41_000], [46, long], [80, long]] as const)(
  "Summary keeps every row's clock whole beside a long model in a %s column terminal (%sms)",
  async (width, elapsed) => {
    const now = 10_000 + elapsed
    const expected = Tabs.clock(elapsed)
    // A deep chain: the deepest row's indent leaves the least room for its columns.
    const tabs = [0, 1, 2, 3].map((depth) => ({
      ...worker("running", elapsed),
      id: `clock${depth}`,
      depth,
      ...(depth === 0 ? {} : { parent: `clock${depth - 1}` })
    }))
    const sections = Inbox.rows({ tabs, runs: [], models: longModels, now })
    expect(Inbox.flat(sections, true).map((row) => row.level)).toEqual([0, 1, 2, 3])
    const frame = await draw(
      <SubagentView.Overview
        sections={sections}
        selected="clock0"
        pane="tree"
        width={width}
        tabs={tabs}
        failedOpen
        cards={{ transcript: () => Transcript.empty, now, lane: () => "#ffffff", focused: undefined, onOpen: () => {} }}
        onSelect={() => {}}
        review={null}
      />,
      width
    )
    // Every row's clock survives the tree pane's edge whole; the model name gives up cells instead.
    const pane = SubagentView.overviewWidths(width).tree
    const shown = frame.split("\n").map((line) => [...line].slice(0, pane).join("")).filter((line) =>
      line.includes(expected)
    )
    expect(shown).toHaveLength(4)
    for (const line of frame.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(width)
  }
)

test("a graph box keeps the clock whole and clips the model name instead", async () => {
  const tab = worker("running", long)
  const now = 10_000 + long
  const row = Inbox.flat(Inbox.rows({ tabs: [tab], runs: [], models: longModels, now }), true)[0]!
  expect(row.seat).toBe("Claude Opus 5.5")
  expect(row.clock).toBe(Tabs.clock(long))
  const frame = await draw(
    <SubagentView.GraphView root={SubagentView.forest(row, [row], [tab], () => [], now)} selected={row.key} />
  )
  expect(frame).toContain(row.clock)
  expect(frame).toContain(`… · ${row.clock}`)
})
