import { REEL_BUTTON } from "./reel.ts"
import { PRACTICE_CARD, PRACTICE_EDIT_FRAME, PRACTICE_REPO, PRACTICE_RUN_ID } from "../state/practice/PracticeRepository.ts"

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
  /** A practice beat: offline, bundled, and "Skip practice" (Q) is offered. */
  practice?: true
  skippable: false
}

export const GUIDE_STAGES: readonly GuideLesson[] = [
  /* 0: Will's original greeting, verbatim; the practice framing and the goal follow it and sit on the goal card. */
  /* 0 */ { kind: "say", message: "I'm Smithers, I help your team manage your repository.",
    more: "Let's warm up on a practice repo. One goal: fix a bug and send it for review as a Change." },
  /* 1 */ { kind: "do", practice: true, message: "Someone on the team filed a bug. Let's look at the issues.", completion: "issues.opened", skippable: false,
    instruction: "Lists the practice repository's open issues.",
    actions: [{ label: "Show issues", key: "I", flow: "issues.list", args: `open ${PRACTICE_REPO}` }] },
  /* 2 */ { kind: "do", practice: true, goal: "issue", message: "Number 3 looks small. Let's read it.", completion: "issue.opened", skippable: false,
    instruction: "Opens issue #3 with its body.",
    actions: [{ label: "Read issue #3", key: "R", flow: "issues.view", args: `3 ${PRACTICE_REPO}` }] },
  /* 3 */ { kind: "do", practice: true, message: "Before we start, let's check nobody's already fixing it.", completion: "prs.opened", skippable: false,
    instruction: "Lists the practice repository's pull requests.", success: "Mira's on logging, not greetings. It's ours.",
    actions: [{ label: "Show pull requests", key: "P", flow: "prs.list", args: PRACTICE_REPO }] },
  /* 4 */ { kind: "do", practice: true, message: "The greeting lives in src/hello.ts. Take a look.", completion: "file.opened", skippable: false,
    instruction: "Opens src/hello.ts at line 2.", success: "Line 2. With no name, it prints null.",
    actions: [{ label: "Open hello.ts", key: "O", flow: "files.read", args: `src/hello.ts:2 ${PRACTICE_REPO}` }] },
  /* 5 */ { kind: "do", practice: true, goal: "plan", message: "I plan before I touch code. Want a plan for the fix?", completion: "plan.ready", skippable: false,
    instruction: "Smithers plans three commits for the fix.",
    actions: [{ label: "Plan the fix", key: "F", flow: "agent.change", args: `${PRACTICE_REPO} --feature Fix #3` }] },
  /* 6 */ { kind: "do", practice: true, goal: "commits", message: "Three small commits. Should I go ahead?", completion: "commits.made", skippable: false,
    instruction: "Smithers makes the three commits while you watch.", success: "Done. Every commit passes on its own.",
    actions: [{ label: "Go ahead", key: "G", flow: "agent.change.start", args: PRACTICE_CARD.plan }] },
  /* 7 */ { kind: "do", practice: true, message: "Every turn I take leaves a trace. Open it and check my work.", completion: "trace.opened", skippable: false,
    instruction: "Opens the turn that edited src/hello.ts. Up and down arrows move between turns.",
    actions: [{ label: "Open the trace", key: "T", flow: "runs.trace.select", args: `${PRACTICE_RUN_ID} ${PRACTICE_EDIT_FRAME}` }] },
  /* 8 */ { kind: "do", practice: true, goal: "change", message: "A Change is what reviewers see: the commits you pick, stacked in order. I'd leave out the README note so this one is only about the bug.", completion: "change.opened", skippable: false,
    instruction: "Opens a Change with the checked commits. Keys 1 to 3 toggle rows.",
    actions: [{ label: "Make the Change", key: "M", flow: "change.open", args: "{picked}" }] },
  /* 9 */ { kind: "say", message: "That's the whole loop: issue, plan, commits, Change. Nicely done." },
  /* 10 */ { kind: "do", message: "That was practice. Everything you just did works on your own code. First, log in to GitHub.", completion: "identity.signed-in", skippable: false,
    instruction: "Signs in with GitHub. Nothing is shared before you approve it on GitHub.",
    actions: [{ label: "Log in to GitHub", key: "L", flow: "auth.sign-in" }],
    secondary: { label: "Not now", key: "X", flow: "onboarding.act", args: "decline login" } },
  /* 11 */ { kind: "do", requires: "signed-in", message: "Now choose which repositories I can see. GitHub will ask on the next page.", completion: "github.app.installed", skippable: false,
    instruction: "Opens GitHub's install page, where you choose repositories.",
    actions: [{ label: "Install the GitHub App", key: "A", flow: "github.app.open" }],
    secondary: { label: "Later", key: "Z", flow: "onboarding.act", args: "decline install" } },
  /* 12 */ { kind: "do", requires: "installed", message: "I can study {repo} in the background. Start a Wiki that explains the code, and a Mythical history of how it got here.", completion: "librarian.runs.launched", skippable: false,
    instruction: "Starts both background flows on your repository.", success: "Both are running. I'll tell you when they're done.",
    actions: [{ label: "Create Wiki for {repo}", key: "W", flow: "wiki.create", args: "{repo}" },
      { label: "Create Mythical history", key: "H", flow: "history.bootstrap", args: "{repo}", subtitle: "On its own branch. Your branches stay untouched." }] },
  /* 13 */ { kind: "do", message: "Last thing: press ⌘K anytime to ask me or run anything.", completion: "palette.opened", skippable: false,
    instruction: "Opens the command palette. Escape closes it.", success: "That's me. Esc closes it.",
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
export const GUIDE_RESERVED_KEYS = ["S", "C", "N", "Q"] as const

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
