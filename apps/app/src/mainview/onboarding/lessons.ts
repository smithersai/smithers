import { REEL_BUTTON } from "./reel.ts"
import { PRACTICE_CARD, PRACTICE_REPO } from "../state/practice/PracticeRepository.ts"
import type { GuideState } from "../state/AppState"
import { librarianLaunchFor } from "../state/LibrarianLaunch"

/*
 * Onboarding tutorial, script v4 (~/Desktop/smithers-tutorial/SCRIPT.md).
 * Copy, pills, keys, flows and completion signals share this one table; the
 * shell, the reducer and the e2e walk all read it, so nothing duplicates copy.
 *
 * Pills are bound to flows (the slash door stays underneath for the agent).
 * `{repo}` in a message, label or args is the user's repository once the
 * GitHub App is installed; `{picked}` is the commit picker's checked set.
 */
export type GuideAction = {
  label: string
  /** The single-letter shortcut, or a chord the shell handles itself ("⌘K"). */
  key: string
  flow: string
  args?: string
  subtitle?: string
}
/** The goal card's checkpoints (beats 0–9). */
export type GoalCheckpoint = "issue" | "plan" | "commits" | "change"
export type GuideLesson = {
  kind: "say"; message: string; more?: string; terminal?: boolean; optionalAction?: typeof REEL_BUTTON
  /** The terminal line after an escape hatch: login declined, or install declined. */
  variants?: { readonly login: string; readonly install: string; readonly background: string }
} | {
  kind: "do"; message: string; touchMessage?: string; completion: string
  /** Optional guidance anchored to one action, never sent as a notification. */
  help?: { actionKey: string; content: string; touchContent?: string; introduction?: ReadonlyArray<{ target: "action" | "chat"; content: string; touchContent?: string }> }
  /** Screen-reader description of the pill (aria-describedby); never rendered as numbered steps. */
  instruction: string
  actions: readonly GuideAction[]
  /** The quiet second choice (Not now, Later). */
  secondary?: GuideAction
  /** The goal-card checkpoint this beat ticks. */
  goal?: GoalCheckpoint
  /** The follow-up line once the signal lands, unless the producer said its own. */
  success?: string
  /** Auto-skipped after the matching escape hatch. */
  requires?: "signed-in" | "installed"
  /** An example-repository beat; Skip tutorial (q) is offered. */
  practice?: true
  skippable: false
}

export const GUIDE_STAGES: readonly GuideLesson[] = [
  /* Retired entry slot: preserve persisted lesson indices without rendering a gate. */
  /* 0 */ { kind: "do", message: "", completion: "tutorial.started", skippable: false,
    instruction: "",
    actions: [] },
  /* 1 */ { kind: "do", practice: true, message: "", completion: "issues.opened", skippable: false,
    help: { actionKey: "i", content: "Start with the practice repository’s issues. Click Show issues or press i.",
      touchContent: "Start with the practice repository’s issues. Tap Show issues.",
      introduction: [
        { target: "action", content: "Smithers makes suggestions as to what we should do next as you use it." },
        { target: "chat", content: "Press C anytime to open Chat and commands.", touchContent: "Tap Chat anytime to open Chat and commands." },
      ] },
    instruction: "Lists the practice repository's open issues.",
    actions: [
      { label: "Show issues", key: "i", flow: "issues.list", args: `open ${PRACTICE_REPO}` },
      { label: "Review changes", key: "r", flow: "prs.list", args: PRACTICE_REPO },
    ] },
  /* 2 */ { kind: "do", practice: true, goal: "issue", message: "", completion: "issue.opened", skippable: false,
    instruction: "Opens issue #3 with its body.",
    actions: [{ label: "Read issue #3", key: "r", flow: "issues.view", args: `3 ${PRACTICE_REPO}` }] },
  /* 3 */ { kind: "do", practice: true, message: "Issue flows handle repeatable tasks. Let's inspect repro before running it.", completion: "issue.flows.opened", skippable: false,
    instruction: "Opens the issue's existing flows and the repro prompt.",
    actions: [{ label: "View issue flows", key: "e", flow: "issue.flows", args: `3 ${PRACTICE_REPO}` }] },
  /* 4 */ { kind: "do", practice: true, message: "Research first: reproduce the report and check the relevant source, tests, and pull requests.", completion: "issue.researched", skippable: false,
    instruction: "Runs the example issue's repro flow and shows its research.",
    actions: [{ label: "Run repro", key: "r", flow: "issue.repro", args: `3 ${PRACTICE_REPO}` }] },
  /* 5 */ { kind: "do", practice: true, goal: "plan", message: "Implement starts with a plan. Review it before the agent changes code.", completion: "plan.ready", skippable: false,
    instruction: "Asks the agent to implement issue #3, beginning with a plan for review.",
    actions: [{ label: "Implement fix", key: "f", flow: "issue.implement", args: `3 ${PRACTICE_REPO}` }] },
  /* 6 */ { kind: "do", practice: true, goal: "commits", message: "Review the plan, then approve the implementation.", completion: "commits.made", skippable: false,
    instruction: "Approves the plan and asks the agent to make the commits.", success: "The implementation is ready to review.",
    actions: [{ label: "Approve implementation", key: "g", flow: "agent.change.start", args: PRACTICE_CARD.plan }] },
  /* 7 */ { kind: "do", practice: true, message: "Review the implementation diff.", completion: "diff.opened", skippable: false,
    instruction: "Shows the changes recorded by the implementing agent.",
    actions: [{ label: "View diff", key: "d", flow: "files.implementation-diff" }] },
  /* 8 */ { kind: "do", practice: true, message: "Open the changed file from the diff to read it in context.", completion: "diff.file.opened", skippable: false,
    instruction: "Opens the fixed src/hello.ts inside the diff frame. Back returns to the diff.",
    actions: [{ label: "Open hello.ts", key: "o", flow: "files.open-diff", args: JSON.stringify({ cardId: "practice-implementation-diff", path: "src/hello.ts" }) }] },
  /* 9 */ { kind: "do", practice: true, goal: "change", message: "A Change is what reviewers see. Choose the commits you want to include, then create the Change.", completion: "change.opened", skippable: false,
    instruction: "Opens a Change with the checked commits. Number keys toggle the matching rows.",
    actions: [{ label: "Make the Change", key: "g", flow: "change.open", args: "{picked}" }] },
  /* 10 */ { kind: "do", message: "That was practice. Everything you just did works on your own code. First, log in to GitHub.", completion: "identity.signed-in", skippable: false,
    instruction: "Signs in with GitHub. Nothing is shared before you approve it on GitHub.",
    actions: [{ label: "Log in to GitHub", key: "a", flow: "auth.sign-in" }],
    secondary: { label: "Not now", key: "x", flow: "onboarding.act", args: "decline login" } },
  /* 11 */ { kind: "do", requires: "signed-in", message: "Now choose which repositories I can see. GitHub will ask on the next page.", completion: "github.app.installed", skippable: false,
    instruction: "Opens GitHub's install page, where you choose repositories.",
    actions: [{ label: "Install the GitHub App", key: "a", flow: "github.app.open" }],
    secondary: { label: "Later", key: "z", flow: "onboarding.act", args: "decline install" } },
  /* 12 */ { kind: "do", requires: "installed", message: "I can study {repo} in the background. Start a Wiki that explains the code, and a Mythical history of how it got here.", completion: "librarian.runs.launched", skippable: false,
    instruction: "Starts both background flows on your repository.", success: "Both are running. I'll tell you when they're done.",
    actions: [{ label: "Create Wiki for {repo}", key: "u", flow: "wiki.create", args: "{repo}" },
      { label: "Create Mythical history", key: "y", flow: "history.bootstrap", args: "{repo}", subtitle: "On its own branch. Your branches stay untouched." }],
    secondary: { label: "Do this later", key: "z", flow: "onboarding.act", args: "decline background" } },
  /* 13 */ { kind: "do", message: "If you ever need to just chat with me rather than using the fast controls or UI to interact you can press C to open Chat. From there you can type any message.\n\nPress M to choose Normal, Vim, or Dictation mode. Vim uses Escape for normal mode and I to insert. Press Ctrl+B, then arrows or H/J/K/L to move between panes; Ctrl+B, Q shows pane numbers and key hints. Dictation starts when you next open Chat; review the text before sending.", completion: "palette.opened", skippable: false,
    touchMessage: "If you ever need to just chat with me rather than using the fast controls or UI to interact you can tap Chat to open Chat. From there you can type any message.\n\nTap Mode to choose Normal, Vim, or Dictation mode. Dictation starts when you next open Chat; review the text before sending.",
    instruction: "Opens Chat. Escape closes it. Sending a message is optional.", success: "Choose Dictation from Mode before opening Chat to speak. Escape closes Chat. You can finish the tutorial without sending a message.",
    actions: [{ label: "Chat", key: "c", flow: "chat.open" }],
    secondary: { label: "Finish tutorial", key: "f", flow: "onboarding.act", args: "finish" } },
  /* 14 */ { kind: "say", terminal: true, optionalAction: REEL_BUTTON,
    message: "You're set. Your Wiki and history will land soon. When you're ready, pick one of {repo}'s issues and we'll make a real Change.",
    variants: { login: "You're set. Log in from Account whenever you want to chat or bring your own repository.",
      install: "Install the GitHub App from Account when you're ready, and I'll start your Wiki and history.",
      background: "You're set. You can ask Chat to create your Wiki and Mythical history later. Pick one of {repo}'s issues when you're ready to make a Change." } },
]
export const GUIDE_LESSONS = GUIDE_STAGES.map(stage => stage.message)
export const GUIDE_LAST_STEP = GUIDE_STAGES.length - 1
/** The last practice beat; the goal card shows through here. */
export const GUIDE_PRACTICE_END = 9
/** Where "Skip practice" and a finished practice land: the bridge. */
export const GUIDE_BRIDGE = 10
/** Global controls and Vim navigation cannot be assigned to lesson actions. */
export const GUIDE_RESERVED_KEYS = ["s", "c", "m", "h", "j", "k", "l", "b", "w", "n", "q"] as const

type GuideContext = Pick<GuideState, "repo" | "playthrough" | "librarianLaunches"> & {
  readonly declined?: ReadonlyArray<string>; readonly completed?: ReadonlyArray<string>; readonly step?: number
}
/** `{repo}` becomes the user's repository; the terminal line follows the escape hatch taken. */
export const lessonText = (text: string, guide: GuideContext): string => text.replaceAll("{repo}", guide.repo ?? "your repository")
export const lessonMessage = (step: number, guide: GuideContext, touch = false): string => {
  const lesson = GUIDE_STAGES[step]
  if (lesson === undefined) return ""
  if (step === GUIDE_BRIDGE && guide.declined?.includes("practice")) return "Bring your own repository to Smithers. First, log in to GitHub."
  if (lesson.kind === "do" && lesson.completion === "palette.opened" && guide.declined?.includes("login")) {
    return (touch ? "Tap Chat" : "Press C") + " to explore Chat and commands. Sign in from Account to send a message. You can finish this tutorial without sending anything.\n\n"
      + (touch ? "Tap Mode" : "Press M") + " to choose Normal, Vim, or Dictation mode. Dictation starts when you next open Chat; review the text before sending."
  }
  if (lesson.kind === "say" && lesson.variants !== undefined) {
    if (guide.declined?.includes("login")) return lesson.variants.login
    if (guide.declined?.includes("install")) return lesson.variants.install
    if (guide.declined?.includes("background") || (["wiki", "history"] as const).some(kind => librarianLaunchFor(guide, kind)?.phase === "failed")) return lessonText(lesson.variants.background, guide)
  }
  return lessonText(touch && lesson.kind === "do" ? lesson.touchMessage ?? lesson.message : lesson.message, guide)
}

/** A jump past declined lessons must not invent transcript messages for them. */
export function lessonVisible(step: number, guide: GuideContext): boolean {
  const lesson = GUIDE_STAGES[step]
  if (lesson?.kind !== "do") return true
  if (lesson.requires === "signed-in" && guide.declined?.includes("login")) return false
  if (lesson.requires === "installed" && (guide.declined?.includes("login") || guide.declined?.includes("install"))) return false
  if (lesson.practice && guide.declined?.includes("practice")) {
    // Existing completion receipts recover the last reached lesson after reload.
    const reached = Math.max(1, ...GUIDE_STAGES.flatMap((asked, index) => asked.kind === "do" && asked.practice && guide.completed?.includes(asked.completion) ? [index + 1] : []))
    return step <= reached || step === guide.step
  }
  return true
}
