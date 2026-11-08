# Rulings: vibelang.smithers.sh

Will's rulings for this app, each with his words quoted exactly (typos included), Pacific time. This page is the
source of truth for the app; `apps/mvp/docs/rulings.md` §19 points here. A later ruling replaces an earlier one, and
the replaced one stays below with a **Replaced by** note.

All of the following are from Will's message of 2026-11-07, about 00:30 PST, unless noted.

## What it is

- **VL-1. vibelang.smithers.sh is a special app for contributing to VibeLang, built brick by brick, and this is the
  final version.** "I want to build vibelang.smithers.sh. It's a special app for contributing to vibelang. ... we have
  so much existing poc concept code built this is going to be the final version. So I'm going to tell you what I want
  and we are going to build it brick by brick."
- **VL-2. Every open-source project gets a factory site; we build it on Effect in VibeLang.** "we believe every open
  source project will have a high quality factory website for helping the open source community collaborate so we are
  building this on effect.ts in vibelang which is a language optimized for building workflows and agents."
- **VL-3. Deploy as fast as possible.** "Youw ant to as fast as possible get vibelang.smithers.sh deployed"

## Stack

- **VL-4. Effect for everything, Cloudflare, Alchemy, Foldkit, Smithers' abstractions, written in VibeLang.**
  "1. You use Effect.ts for everything 2. You use cloudflare 3. You use infra as code with alchemy 4. The UI should be
  built with foldkit 5. We ALWAYS try to reuse existing abstractions in smithers.sh to do this 6. We are writing it in
  vibelang"
- **VL-5. No other dependencies; others are reference code only; exceptions go to Will.** "REmember effect for the
  entire stack. Don't use any other dependencies including tanstack or anything we can use these dependencies only as
  reference code. If there is a major exception you can try to get dependencies approved through me."
- **VL-6. Web app plus an Electrobun native app** for local models and the local file system. "This should run like
  smithers.sh as a web app but also a native appw here they have features to use local llms local file system etc. is
  only difference and it uses electrobun for this"
- **VL-7. Upstream bugs are fixed upstream.** "If you find bugs in smithers or vibelang itself we are maintainer that's
  expected and we should always prioritize having subagents fix those issues upstream not just simply working around
  these"

## Architecture

- **VL-8. Flux: one distributed state machine over the front end and back end** (poteto's pstack). "Use a flux like
  pattern to build app. So we should model our app as a distributed state machine that includes our frontend and
  backend. Google poteto pstack from cursor and read how they do it."
- **VL-9. Formally verify the state machine for every feature, with our internal library's comment syntax until the
  VibeLang VIP lands.** "Vibelang has a VIP for formal verification not implemented yet so for now we should use the
  library that we are internally using for that just it's normal comment syntax. We must formally verifify our
  statemachine for all features we add."
- **VL-10. The core is an Effect API; the CLI, a skill, an MCP server and the web app are clients of it.** "The state
  machine should be developed seperately from the UI and the client should be relatively pluggable. The core library
  itself should look like an effect.ts api that can then be used to implement a cli, a skill, an mcp server (incur
  supports tuff like this youc an copy their patterns but use effect). And of course our web app. All UI sourfaces
  should be tested"
- **VL-11. Everything is a flow.** The agent runs on Cloudflare on the smithers.sh agent; the Smithers flows library
  serves until VibeLang has flows. "The agent runs on cloudflare using smithers.sh agent and it's surroounding stuff to
  build it. We follow the same "everything is a flow" principle that we had before. Flows will be added to vibelang
  there are open VIP but in meantime we are unblocked form using our existing smithers flows library."
- **VL-12. Multiplayer, simplest robust version.** "We should support multiplayer but don't overengineer it like we
  have in past just get it working with simplist most robust solution"

## Invariants and testing

- **VL-13. The UI always works in mock mode: no backend, no model.** "Our UI should at all times work in a mock mode
  where there is no backend no llm nothing. THis is an invariant we should hodl throughout all development."
- **VL-14. Every suite, each covering the whole codebase on its own.** "We must inparallel always get the UI working
  with everything mocked. We should connect the 2 and have a high amount of benchmark tests, fuzz tests, e2e tests, and
  unit tests all test suites should be added and by themselves try to cover the entire codebase and all behavior
  idnepeneent of the other sas best as they can."
- **VL-15. Property and fuzz tests use Effect's `Arbitrary`** (fubhy's). Will, 2026-11-07 about 00:40: "Let's use
  arbitrary by fubby too"

## Product and UX

- **VL-16. First brick: a Foldkit chat styled exactly like smithers.sh's React chat.** The home page is a maximized
  splash like vibelang.sh; ⌘K opens the prompt as on smithers.sh; after a prompt the page becomes the chat. "the first
  thing I want you to build is a simple chat app ... a simple foldkit app styled exactly like our react components are
  styled in our chat app. So when we land on the chat app we have a splash page which is the homepage of Vibelang
  similar to what we see if we go to vibelang.sh right now for our docs. Command k just like smithers.sh brings up chat
  and you can talk to an agent."
- **VL-17. Everything is a chat; HTML lives in panes that can be maximized; view transitions make it intuitive.** "We
  have this ux principle of we treat everything like a chat and html gets embedded in panes in the chat and it can
  sometimes be maximized. Like the home page just starts in a maximized splash page of our app with command k to prompt
  the agent and after promting it transitions back to chat mode. View transitions and transition effects make this super
  intuitive smithers.sh is already built in my vision of the general form factor here."
- **VL-18. Copy GitHub whenever possible.** "We want to copy github whenever possible. Github like UI/UX like howe
  smithers.sh works already is really ideal because it's intuitive."
- **VL-19. Use the marketing materials throughout.** "We have marketing materials generated these should be used
  throughout our site just do your best designing a high qualitys site within the same templates we have experienced
  before"
- **VL-20. An open contribution process with filters: proposing a VIP, issues versus tasks, issues as a tree.** "We
  want a really open process of allowing people to contribute. But at same time we want filters. We want thoughtful
  everything so wew want a thoughtful ui ux for proposing a new VIP and how that works. We want a to have a clear
  difference between issues and tasks (tasks are work we committed to doing) and how issues are formed as a tree."
- **VL-21. Roles: maintainer, contributor, community, new, viewer.** "We want contributor maintainer community
  (community is minimal privleges but has participated new and viewer (not logged in) as our roles so far". Promoting
  people between roles is part of the design: "For ux I want this to be thoughtful about many things like how we
  promote roles."
- **VL-22. The mythical history is viewable, and work on VibeLang runs through the mythical-history flow.** "We have
  our mythical history we want that to be viewable and workflows for working on vibelang should work via the mythical
  history flow". This brings back, for this app, what `apps/mvp/docs/rulings.md` TODO-2 deferred.
- **VL-23. The project wiki is the project's working memory, and every decision is documented there.** "ALld ecisions
  like this should be clearly documented in the project wiki which is another part of teh site project wiki represents
  the working memory for the project."
- **VL-24. Actions: registered workflows like GitHub Actions, also run from slash commands by role.** "Actions are
  import wwe will have many workflows and we need a thoughtful workflow solution similar to github actions for our
  registered workflows that can also ran from slach command based on your role"
- **VL-25. Sandboxes with minute allowances.** "Users should be able to spin up sandboxes and get different amoutns of
  minutes."

- **VL-27. Dark only, for now.** On 2026-11-07, Will said the splash's videos and pictures looked bad in light
  mode: "they should be light mode in light mode and dark mode in dark mode for all the pictures and stuff". Then:
  "Do the opposite for now and just make vibelang dark mode only and leave a note in wiki why". See decision 0013.

- **VL-28. Learn more is the primary action and starts a tour the agent drives; Ask the agent and Contribute are
  secondary; Escape ends the tour.** Will, 2026-11-07: "It should say ask the agent as a secondary button the primary
  button should just be learn more and another secondary button should be contribute. Learn more should take us to
  docs and start a tutorial where we have a glow around the entire screen to signify the agent is controlling escape
  escapes it or clicking the thing that says escape escapes it and the agent talks about vibelang and what it is and
  what this open source coding factory is". See decision 0014.

- **VL-29. Finish everything asked for, held to 100% coverage by every suite, fuzzing from our Effect fork as a
  package, formal proofs of all functionality, the mythical history, and a designer's design for every feature that
  has no UI yet.** Will, 2026-11-07 about 21:15: "can you keep going getting everything I asked for first includin
  g100% test coverage benchmark test coverage fuzz test coverage (you can copy the code we wrote in a fork of smithers
  for this copy it into this repo as a package) and make sure all functionality is formally verified. Get everything
  including the mythical history. Any features without UI have a high quality designer agent design it". The fork is
  `github.com/smithersai/effect`, whose `effect/Fuzz`, `effect/testing/FuzzSimulation` and `it.effect.fuzz` are the
  code to copy.

- **VL-30. A visible switch into Mock mode, where every feature works.** Will, 2026-11-08 (relayed 19:20Z): "I don't
  see any in app button to switch into mocked mode to use the entire app and every feature I asked for. There should be
  nothing blocking that and that allows me to verify we are at least building the correct thing earlier." The top bar's
  Live/Mock switch and ⌘K's `/mock` and `/live` do it; see decision 0004.

- **VL-31. Learn more is a live tutorial in a theatre mode: the agent drives the real app, and it works with the sound
  off.** Will, 2026-11-08 about 11:35 PST (relayed): "The learn more is not very good it should work with sound off. We
  have old specs maybe in ~/smithers/.specs or maybe they are gone but it switched to like a theatre mode and worked
  really well as a like a live tutorial of how to use vibelang. This should be exactly that. A live tutorial of an agent
  controlling the app (which it has because we treat all state transitions as "smithers workflows" and smithers
  workflows attatched to ui elements can also be triggered by the agent itself". Then: don't look for the old spec; a
  designer's onboarding design (subtitles, optional sound, the agent driving the app through its real flows) comes
  first. Replaces VL-28's narrated tour where they differ.
- **VL-32. Both acceptance gates of the coding factory are built here (PROC-28).** A proposal (a VIP) is accepted only
  when a maintainer, a person, approves it; an agent review never accepts one. The specification written from accepted
  proposals is accepted only when Codex Astra, Codex Sol, Claude Fable and Claude Opus all answer LGTM with an A grade;
  after that it stays self-consistent while it is built optimistically and fuzz tested. Will, 2026-11-08 11:20 PST: "I
  believe acceptance involved writing a spec and a review of 4 agents astra sol fable and opus all saying lgtm A grade";
  11:22: "Not for the VIP for the spec we reached acceptance in past. The VIP are personally approved by me and then the
  spec needs to be self consistent and optimistically built fuzz tested etc."; about 11:23: "This is important because
  this is the general core of hwo our coding factory works btw". Relayed the same day: it gets built in
  vibelang.smithers.sh.

## Process

- **VL-26. Go fast and in parallel; dogfood at once: the agent through the MCP server, skill or CLI, Will through the
  UI.** "Most features you will be implementing have reference code in smithers that already work so we should be able
  to be ambitions and implement things fast and in parallel. But immediately we should be getting to a place where both
  of us are working via dogfooding our own app. you via the mcp server or skill/cli. And me via the UI we should be able
  to work in paralle."
