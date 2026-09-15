import { expect, test } from "bun:test"
import type { Card } from "../state/AppState"
import { initialGuide } from "../state/AppState"
import { LIBRARIAN_LAUNCH_OWNER } from "../state/LibrarianLaunch"
import { guideActionState, INSTALL_CHECK_OWNER } from "./actionState"
import { GUIDE_STAGES } from "./lessons"

test("completed live actions remain usable after Back even if their run expired or has not hydrated", () => {
  const guide = { ...initialGuide(), step: 4, autoPaused: true, completed: ["issue.researched"] }
  for (const cards of [[], [card("completed")], [card("failed", 0, "Session expired")]]) {
    expect(guideActionState(GUIDE_STAGES[4]!.kind === "do" ? GUIDE_STAGES[4]!.actions[0]! : action, cards, guide))
      .toMatchObject({ label: "Run repro", key: "r", flow: "onboarding.act", args: "next" })
  }
})

test("advancing into another completed beat uses its receipt even after navigation clears the pause", () => {
  const lesson = GUIDE_STAGES[8]!
  if (lesson.kind !== "do") throw Error("expected file lesson")
  expect(guideActionState(lesson.actions[0]!, [], { ...initialGuide(), step: 8, autoPaused: false,
    completed: ["diff.opened", "diff.file.opened"] }))
    .toMatchObject({ flow: "onboarding.act", args: "next", key: "o" })
})

const action = { label: "Run repro", key: "r", flow: "issue.repro" }
const card = (phase: string, playthrough = 0, observationError?: string): Card => ({
  id: "research", kind: "run-trace", title: "Research", status: "active", createdAt: 1, ordinal: 1,
  payload: { repo: "practice:hello-server", workflow: "issue.research", runId: "run", phase, steps: [], result: null, lastSeq: 0, observationError,
    input: { liveTutorial: { operation: "research", playthrough } } },
}) as Card

test("a known quota refusal offers continuation until its deadline, then an explicit retry", () => {
  const rejected = card("failed", 0, "Daily practice limit")
  if (rejected.kind !== "run-trace") throw Error("run fixture")
  rejected.payload.input = { ...rejected.payload.input, liveTutorialLimit: { kind: "rate-limit", retryAt: Date.now() + 60_000 } }
  expect(guideActionState(action, [rejected], initialGuide())).toMatchObject({ label: "Continue without practice", flow: "onboarding.act", args: "skip-practice" })
  expect(guideActionState(action, [rejected], { ...initialGuide(), playthrough: 1 })).toEqual(action)
  rejected.payload.input.liveTutorialLimit = { kind: "rate-limit", retryAt: Date.now() - 1 }
  expect(guideActionState(action, [rejected], initialGuide())).toMatchObject({ label: "Retry repro", flow: "tutorial.live.retry", args: "research" })
})

test("current live operation offers chat while background work runs and retry after failure", () => {
  for (const phase of ["launching", "running"]) {
    expect(guideActionState(action, [card(phase)], initialGuide())).toMatchObject({ label: "Chat while it runs", flow: "chat.open", args: undefined })
  }
  expect(guideActionState(action, [card("failed")], initialGuide())).toMatchObject({ label: "Retry repro", flow: "tutorial.live.retry", args: "research" })
  expect(guideActionState(action, [card("completed")], { ...initialGuide(), completed: ["issue.researched"] })).toMatchObject({ label: "Research complete", disabled: true })
})

test("observation failure reconnects and expiry restarts, while old playthroughs never block", () => {
  const disconnected = card("running", 0, "Connection lost")
  if (disconnected.kind !== "run-trace") throw Error("run fixture")
  disconnected.payload.input = { ...disconnected.payload.input, liveTutorialSnapshot: {
    sessionId: "session", runId: "run", operation: "research", phase: "running", createdAt: 1, updatedAt: 1, events: [],
  } }
  expect(guideActionState(action, [disconnected], initialGuide())).toMatchObject({ label: "Reconnect to run", flow: "tutorial.live.retry", args: "research" })
  expect(guideActionState(action, [card("failed", 0, "Session expired")], initialGuide())).toMatchObject({ label: "Start new tutorial", flow: "onboarding.act", args: "restart" })
  expect(guideActionState(action, [card("running")], { ...initialGuide(), playthrough: 1 })).toEqual(action)
})


test("returning to a completed Change's picker advances without creating another live Change", () => {
  const completed = card("completed")
  if (completed.kind !== "run-trace") throw Error("run fixture")
  completed.payload.input = { liveTutorial: { operation: "change", playthrough: 0 } }
  const change = { label: "Make the Change", key: "g", flow: "change.open", args: "{picked}" }
  expect(guideActionState(change, [completed], { ...initialGuide(), step: 9, autoPaused: true, completed: ["change.opened"] }))
    .toMatchObject({ label: "Make the Change", key: "g", flow: "onboarding.act", args: "next" })
})


test("background suggestions reflect the matching repository launch and recover interrupted setup", () => {
  const wiki = { label: "Create Wiki", key: "u", flow: "wiki.create" }
  const launch = { kind: "wiki" as const, repo: "will/demo", scope: JSON.stringify(["will/demo", null, null, null, null, 0]), startedAt: 1, owner: LIBRARIAN_LAUNCH_OWNER, phase: "preparing" as const }
  const guide = { ...initialGuide(), repo: "will/demo", librarianLaunches: [launch] }
  expect(guideActionState(wiki, [], guide)).toMatchObject({ disabled: true, busy: true, label: "Preparing Wiki…" })
  expect(guideActionState(wiki, [], { ...guide, repo: "other/repo" })).toEqual(wiki)
  expect(guideActionState(wiki, [], { ...guide, playthrough: 1 })).toEqual(wiki)
  expect(guideActionState(wiki, [], { ...guide, librarianLaunches: [{ ...launch, owner: "old-page" }] })).toMatchObject({ label: "Retry Wiki" })
  expect(guideActionState(wiki, [], { ...guide, librarianLaunches: [{ ...launch, phase: "failed" }] })).toMatchObject({ label: "Retry Wiki" })
  expect(guideActionState(wiki, [], { ...guide, librarianLaunches: [{ ...launch, phase: "launching" }] })).toMatchObject({ label: "Preparing Wiki…", disabled: true })
  expect(guideActionState(wiki, [], { ...guide, librarianLaunches: [{ ...launch, phase: "started" }] })).toMatchObject({ disabled: true, label: "Wiki started" })
})


test("a Change request rejected before acknowledgement offers retry, not reconnection", () => {
  const rejected = card("stopped", 0, "Too many live runs (429)")
  if (rejected.kind !== "run-trace") throw Error("run fixture")
  rejected.payload.runId = "pending-change"
  rejected.payload.input = { liveTutorial: { operation: "change", playthrough: 0 } }
  const change = { label: "Make the Change", key: "g", flow: "change.open", args: "{picked}" }
  expect(guideActionState(change, [rejected], initialGuide())).toMatchObject({ label: "Retry Change", flow: "tutorial.live.retry", args: rejected.id })
})


test("older durable failures still project a concise retry action", () => {
  const wiki = { label: "Create Wiki", key: "u", flow: "wiki.create" }
  expect(guideActionState(wiki, [], { ...initialGuide(), step: 12, repo: "will/demo",
    notice: "Create Wiki didn't start: upstream failed", librarianLaunches: [{ kind: "wiki", repo: "will/demo",
      scope: JSON.stringify(["will/demo", null, null, null, null, 0]), phase: "failed", startedAt: 1, reason: "upstream failed" }] }))
    .toMatchObject({ label: "Retry Wiki" })
})

test("the install pill is busy only while this page's GitHub check is in flight", () => {
  const install = { label: "Install the GitHub App", key: "a", flow: "github.app.open" }
  const guide = { ...initialGuide(), step: 11 }
  expect(guideActionState(install, [], { ...guide, installCheck: INSTALL_CHECK_OWNER })).toMatchObject({ label: "Checking GitHub…", disabled: true, busy: true })
  // A check persisted by an earlier page load never leaves a dead button.
  expect(guideActionState(install, [], { ...guide, installCheck: "old-page" })).toEqual(install)
  expect(guideActionState(install, [], guide)).toEqual(install)
})
