import { REEL_BUTTON } from "./reel.ts"
import { PRACTICE_CARD, PRACTICE_REPO } from "../state/practice/PracticeRepository.ts"

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
  variants?: { readonly login: string; readonly install: string }
} | {
  kind: "do"; message: string; completion: string
  /** Optional guidance anchored to one action, never sent as a notification. */
  help?: { actionKey: string; content: string }
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
    help: { actionKey: "i", content: "Start with the practice repository’s issues. Click Show issues or press i." },
    instruction: "Lists the practice repository's open issues.",
    actions: [{ label: "Show issues", key: "i", flow: "issues.list", args: `open ${PRACTICE_REPO}` }] },
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
    actions: [{ label: "Make the Change", key: "m", flow: "change.open", args: "{picked}" }] },
  /* 10 */ { kind: "do", message: "That was practice. Everything you just did works on your own code. First, log in to GitHub.", completion: "identity.signed-in", skippable: false,
    instruction: "Signs in with GitHub. Nothing is shared before you approve it on GitHub.",
    actions: [{ label: "Log in to GitHub", key: "l", flow: "auth.sign-in" }],
    secondary: { label: "Not now", key: "x", flow: "onboarding.act", args: "decline login" } },
  /* 11 */ { kind: "do", requires: "signed-in", message: "Now choose which repositories I can see. GitHub will ask on the next page.", completion: "github.app.installed", skippable: false,
    instruction: "Opens GitHub's install page, where you choose repositories.",
    actions: [{ label: "Install the GitHub App", key: "a", flow: "github.app.open" }],
    secondary: { label: "Later", key: "z", flow: "onboarding.act", args: "decline install" } },
  /* 12 */ { kind: "do", requires: "installed", message: "I can study {repo} in the background. Start a Wiki that explains the code, and a Mythical history of how it got here.", completion: "librarian.runs.launched", skippable: false,
    instruction: "Starts both background flows on your repository.", success: "Both are running. I'll tell you when they're done.",
    actions: [{ label: "Create Wiki for {repo}", key: "k", flow: "wiki.create", args: "{repo}" },
      { label: "Create Mythical history", key: "h", flow: "history.bootstrap", args: "{repo}", subtitle: "On its own branch. Your branches stay untouched." }] },
  /* 13 */ { kind: "do", message: "If you ever need to just chat with me rather than using the fast controls or UI to interact you can always hit command k. From there you can type any message.\n\nYou can also press v or choose Dictation in the bottom bar to speak your message. Review the text, then send it.", completion: "palette.opened", skippable: false,
    instruction: "Opens Chat. Escape closes it.", success: "Type a message here, or choose Dictation to speak. Escape closes Chat.",
    actions: [{ label: "Press", key: "⌘K", flow: "palette.open" }] },
  /* 14 */ { kind: "say", terminal: true, optionalAction: REEL_BUTTON,
    message: "You're set. Your Wiki and history will land soon. When you're ready, pick one of {repo}'s issues and we'll make a real Change.",
    variants: { login: "You're set. Log in from Account whenever you want to bring your own repository.",
      install: "Install the GitHub App from Account when you're ready, and I'll start your Wiki and history." } },
]
export const GUIDE_LESSONS = GUIDE_STAGES.map(stage => stage.message)
export const GUIDE_LAST_STEP = GUIDE_STAGES.length - 1
/** The last practice beat; the goal card shows through here. */
export const GUIDE_PRACTICE_END = 9
/** Where "Skip practice" and a finished practice land: the bridge. */
export const GUIDE_BRIDGE = 10
/** Keys the shell owns: sound, dark, notify, and Skip practice. */
export const GUIDE_RESERVED_KEYS = ["s", "c", "n", "q"] as const

type GuideContext = { readonly repo?: string; readonly declined?: ReadonlyArray<string> }
/** `{repo}` becomes the user's repository; the terminal line follows the escape hatch taken. */
export const lessonText = (text: string, guide: GuideContext): string => text.replaceAll("{repo}", guide.repo ?? "your repository")
export const lessonMessage = (step: number, guide: GuideContext): string => {
  const lesson = GUIDE_STAGES[step]
  if (lesson === undefined) return ""
  if (lesson.kind === "say" && lesson.variants !== undefined) {
    if (guide.declined?.includes("login")) return lesson.variants.login
    if (guide.declined?.includes("install")) return lesson.variants.install
  }
  return lessonText(lesson.message, guide)
}
