/**
 * The factory that develops smithersai/smithers: what this repository
 * features, what its Dispatcher listens for, who writes `main`, and the home
 * pane a visitor sees first. Declared here beside WORKSPACE.ts, never in a
 * PACKAGE.ts; a target it needs is named by label, `S.label("//:ci")`, never
 * imported. `//:factoryProjection` projects this file into
 * `.smithers/factory.json` and `.smithers/home.json`, the files smithers.sh
 * reads from the public mirror signed out; `ci` fails on drift.
 */
import { Smithers as S } from "@smthrs/targets"

// --- featured flows --------------------------------------------------------
// The flows this repository recommends first, and the one line each shows
// under its id. A flow describes itself in flows/<id>/flow.mdx; how the
// repository presents it is declared here and nowhere else, riding the same
// summary and featured pair every target carries. The projection joins these
// declarations over the discovered flows; a declaration naming no discovered
// flow fails that projection by id.
export const review = S.Flow({
  flow: "review",
  summary: "Review the working-copy change and return a verdict with the reasons behind it.",
  featured: true
})
export const lint = S.Flow({
  flow: "lint",
  summary: "Lint the files you name against this repository's conventions and fix what it finds.",
  featured: true
})
export const prTriage = S.Flow({
  flow: "pr-triage",
  summary: "Triage one pull request for scope, tests, docs, and review readiness from its diff alone.",
  featured: true
})
export const issueTriage = S.Flow({
  flow: "issue-triage",
  summary: "Reproduce and triage one GitHub issue into a structured maintainer response.",
  featured: true
})
export const releaseNotes = S.Flow({
  flow: "release-notes",
  summary: "Draft release notes from the commits since the last tag, grouped by package.",
  featured: true
})
// --- end featured flows ----------------------------------------------------

export const factory = S.Factory({
  summary: "How smithersai/smithers develops itself.",
  flows: [review, lint, prTriage, issueTriage, releaseNotes],
  // The day-one Dispatcher table (factory design 2026-09-07 §7). These are
  // the rules the factory declares; the Dispatcher card shows each as a
  // declared row with its sentence. The flows they name land with the
  // factory flows; a rule whose flow is not registered yet is still the
  // declaration, never a live registration.
  on: {
    "issue.opened": { flow: "issue", description: "Triage every new issue" },
    "issue.labeled:smithers": { flow: "implement", description: "Implement an issue labeled smithers" },
    "change.opened": { flow: "review", description: "Review every Change" },
    "change.updated": { flow: "review", description: "Review every Change" },
    "change.landed": {
      flow: ["wiki", "history.fold", "improve.mine"],
      description: "Regenerate the wiki, fold main into the mythical history, mine the landing"
    },
    "github.push:main": { flow: "history.fold", description: "Fold outside merges into the mythical history" },
    "schedule:0 9 * * 1-5": { flow: "review", description: "Weekday morning review of main" },
    "nomination": {
      flow: "factory.bootstrap",
      description: "Fork, claim, generate PACKAGE.ts from CI, bootstrap the mythical history"
    },
    "box.session.ended": {
      flow: "improve.mine",
      description: "Mine every landing and box session for a better factory"
    },
    "schedule:0 10 * * 1": {
      flow: "improve.suggest",
      description: "Suggest factory improvements once a week; every one needs your approval"
    }
  },
  // Ours: Smithers Cloud writes main and pushes it to GitHub after every
  // landing, issues move both ways, and a Change lands here (RULINGS 23).
  github: S.Github.Policy({ mirror: "push", issues: "two-way", changes: "land" })
})

// --- home pane -------------------------------------------------------------
// The first card a visitor sees on smithers.sh/smithersai/smithers, above the
// welcome: what this repository is, the flows to try first, and the CI
// benchmark. Blocks are declared values, never raw HTML; the app renders each
// from data. The benchmark numbers are not measured yet; the block names the
// measures and the app hides them until a measurement exists.
export const home = S.Factory.Home({
  blocks: [
    S.Home.Flows({ title: "Try first" }),
    S.Home.CiBenchmark({ title: "CI on Smithers" }),
    S.Home.Links({
      title: "Read more",
      links: [
        { label: "Source on GitHub", url: "https://github.com/smithersai/smithers" },
        { label: "smithers.sh", url: "https://smithers.sh" }
      ]
    })
  ]
})
// --- end home pane ---------------------------------------------------------
