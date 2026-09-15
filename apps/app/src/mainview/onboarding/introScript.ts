/*
 * Beat 12's illustrated introductions (onboarding/IntroSlides.tsx). While a
 * background run builds, the tutorial shows a short landing-page slideshow of
 * what that thing is: maximal visuals, minimal words (headline <= 6 words,
 * caption <= 12 words). The controller imports the slide counts, so the data
 * lives here, away from the JSX.
 */
export type IntroKind = "wiki" | "history"
export type IntroSlide = { id: string; headline: string; caption: string }

export const INTRO_SLIDES: Record<IntroKind, readonly IntroSlide[]> = {
  /* flows/librarian/wiki/flow.ts: an index page plus one page per top-level folder, each naming its source commit. */
  wiki: [
    { id: "map", headline: "Your repository at one commit.", caption: "Smithers indexes every tracked file at a single revision." },
    { id: "pages", headline: "One page per folder.", caption: "Each top-level folder gets a page listing its files." },
    { id: "links", headline: "Linked from one index.", caption: "An index page links to every folder page." },
    { id: "current", headline: "Traced to its source.", caption: "Every page names the exact commit it came from." },
  ],
  /* flows/librarian/history/flow.ts: one snapshot commit of today's tree on refs/heads/mythical, with a note; refs stay in the workspace. */
  history: [
    { id: "raw", headline: "A snapshot of your code.", caption: "Smithers captures your branch's files as they are today." },
    { id: "retold", headline: "Saved on a mythical branch.", caption: "It starts a fresh branch from that one snapshot." },
    { id: "branch", headline: "Branches stay untouched.", caption: "Your source branch and its files never change." },
    { id: "read", headline: "A note keeps the evidence.", caption: "It names the source commit. Nothing is pushed to GitHub." },
  ],
}
