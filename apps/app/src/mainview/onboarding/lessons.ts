import { REEL_BUTTON } from "./reel.ts"

/** Buttons and plain-letter shortcuts share the slash door; omitted args render its form. */
export type GuideAction = { label: string; key: string; flow: string; args?: string }

/** Repository tutorial v3. Copy, commands, and completion contracts share one table. */
export type GuideLesson = { kind: "say"; message: string; terminal?: boolean; optionalAction?: typeof REEL_BUTTON } | {
  kind: "do"; message: string; completion: string; instruction: string;
  instructions?: readonly string[]; actions?: readonly GuideAction[]; skippable: false
}
export const GUIDE_STAGES: readonly GuideLesson[] = [
  { kind: "say", message: "I'm Smithers, I help your team manage your repository." },
  { kind: "do", message: "First thing you should do is log in.", completion: "identity.signed-in", skippable: false,
    instruction: "Click Log in to GitHub and finish signing in.",
    actions: [{ label: "Log in to GitHub", key: "L", flow: "auth.sign-in" }] },
  { kind: "do", message: "Let's choose the repository you've contributed to most in the last 90 days. You can skip GitHub and create a new local repository instead.", completion: "repository.ready", skippable: false,
    instruction: "Click Choose a repository and select one, or click Skip, make a local repo to create smithers-playground locally.",
    // Repository lane owns these flow IDs and the existing choice card.
    actions: [{ label: "Choose a repository", key: "G", flow: "repo.choose" },
      { label: "Skip, make a local repo", key: "M", flow: "repo.create", args: "smithers-playground" }] },
  { kind: "do", message: "Let's check the issues or pull requests in your repository.", completion: "issues.opened", skippable: false,
    instruction: "Click Show my issues or Show my pull requests.",
    actions: [{ label: "Show my issues", key: "I", flow: "issues.list" },
      { label: "Show my pull requests", key: "P", flow: "prs.list" }] },
  { kind: "do", message: "You can open files in this repository, too.", completion: "file.opened", skippable: false,
    instruction: "Click Open a file, choose a path in the form, and submit.",
    actions: [{ label: "Open a file", key: "O", flow: "files.read" }] },
  // pluginLesson derives this stage from its completion signal, not from the prose.
  { kind: "do", message: "The Librarian is the only plugin package we need. Install it from the Library.", completion: "librarian", skippable: false,
    instruction: "Click Install the Librarian.",
    // GuideShell supplies LESSON_PLUGIN; pluginLesson derives its stage from this table.
    actions: [{ label: "Install the Librarian", key: "B", flow: "plugins.install" }] },
  { kind: "do", message: "Let's run Create Wiki and Create Mythical history. Both flows run in the background, and we can monitor them while we keep working.", completion: "librarian.runs.monitored", skippable: false,
    instruction: "Click Create Wiki and Create Mythical history, then open their run cards.",
    instructions: ["Click Create Wiki and submit any missing repository details.", "Click Create Mythical history, then open both run cards to monitor the flows."],
    // Background-flow lane owns wiki.create; render while its registration is pending.
    actions: [{ label: "Create Wiki", key: "K", flow: "wiki.create" },
      { label: "Create Mythical history", key: "H", flow: "history.bootstrap" }] },
  { kind: "do", message: "I'll find a useful feature for this codebase and plan the commits before making changes. Watch the agent orchestrate through scripts, then see one resulting commit on top of HEAD.", completion: "change.committed", skippable: false,
    instruction: "Click Add a feature. Review the suggested feature and planned commits, then start the change.",
    // Agent-change lane owns this flow ID; do not hide the button pending integration.
    actions: [{ label: "Add a feature", key: "A", flow: "agent.change" }] },
  { kind: "do", message: "Each turn explains what the agent did. Open a turn to walk through the real code and its debug trace.", completion: "trace.opened", skippable: false,
    instruction: "Click a turn's explanation to open its trace, or Tab to it and press Enter." },
  /* ReelShell reads this same metadata; do not render a second button from it. */
  { kind: "say", message: "Your repository is ready. Call me with Cmd K whenever you need me.", terminal: true, optionalAction: REEL_BUTTON },
]
export const GUIDE_LESSONS = GUIDE_STAGES.map(stage => stage.message)
export const GUIDE_LAST_STEP = GUIDE_STAGES.length - 1
/** Real feature lanes emit these only after their persisted outcome. */
export const GUIDE_SIGNAL_ALIASES: Readonly<Record<string, string>> = { "prs.opened": "issues.opened" }
