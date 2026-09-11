# Repository onboarding

The current brief is the repository tutorial v3. The full inventory, copy, flow/form contracts, migration policy and lane acceptance are in [TUTORIAL2_PLAN.md](../TUTORIAL2_PLAN.md); parallel ownership is [TUTORIAL2_LANES.json](../TUTORIAL2_LANES.json).

| Stage | Lesson | Kind | Completion |
|---:|---|---|---|
| 0 | “I'm Smithers, I help your team manage your repository.” | say | read pause |
| 1 | “First thing you should do is log in.” | do | identity.signed-in |
| 2 | Most-contributed repo in last 90 days, or create local repo | do | repository.ready |
| 3 | Show my issues or Show my pull requests | do | issues.opened or prs.opened |
| 4 | Open a repository file | do | file.opened |
| 5 | Install the Librarian | do | librarian |
| 6 | Create Wiki + Create Mythical history; monitor both async flows | do | librarian.runs.monitored |
| 7 | Suggested feature, planned commits, recursive scripts, one resulting commit above HEAD | do | change.committed |
| 8 | Human turn explanation -> real code trace | do | trace.opened |
| 9 | Workspace destination | say, terminal | none |

`src/mainview/onboarding/lessons.ts` is the source of truth for Smithers copy and numbered instructions. GuideShell renders every do-lesson through GuideSteps. Real completion persists a green check, animates for 200 ms, holds for 700 ms and auto-advances. Reduced motion removes animation. Say lessons advance after the existing word-count read pause; input cancels that pause and Back keeps playback paused. Timer tokens include playthrough and stage. Next never completes required work.

ArrowRight is Next only, ArrowLeft Back. C changes theme, N sends a notification, R starts Create Wiki in its lesson, S sound, Cmd/Ctrl+K toggles the composer, Escape closes it and restores focus. Native Tab, Enter/Space and text editing remain intact. The one-second entrance, palette and header/navigation/fill-height CSS remain as supplied.

Migration is implemented by migrateGuideV3 in controller/guide.ts and invoked during AppStore hydration. New guides use version 3 plus sequence repository-v3 to distinguish the interrupted Library-first v3. Unfinished old guides restart at login, finished ones stay in the workspace, and drafts/plugins survive. Durable stages are 0–9. data-stage is the automation index; terminal data-step=14 preserves existing workspace CSS without altering layout rules.

This skeleton exposes `/onboarding.act signal <completion>` for explicit lane/test integration. Features must emit only after a real persisted outcome in the current repo/run/playthrough. A successful PR read aliases to the issues lesson signal. Library installation already uses its real producer. Other feature producers are assigned to lanes; no missing implementation is automatically marked successful. The end-to-end skeleton test supplies named signals explicitly and does not claim to test OAuth, GitHub or agent execution.

Repository Skip is a creation act, not Next: initialize smithers-playground on the local host, adopt it via the existing local-repo path, and show its actual name and location. A cloud browser requires a local-host handoff. Both generation runs stay asynchronous and inspectable while chat is usable. Changes and traces reuse persisted run cards, coding plan, commit strip and journal projections; outputs embed first.


Every do-lesson action with a flow ID renders one bordered pill with a plain-language label and an internal key chip. Numbered instructions name that button (“Click Log in to GitHub”); command typing belongs only in the talk-directly reel. `lessons.ts` owns label/key/flow/args together (GuideShell supplies LESSON_PLUGIN to avoid the plugin lesson import cycle); GuideShell dispatches clicks and guarded plain-letter keys through `runCommand` / `runCommandArgs`, preserving slash registration, agent policy and missing-input form cards. Pending lane flows still render. Repository choices and turn explanations retain their existing card affordances.

Action keys: L login, G choose repository, M make local repository, I issues, P pull requests, O file, B Librarian, K Wiki, H Mythical history, A feature. R remains the existing Wiki run shortcut. No action key uses modifiers or repeats, fires in a text field, or fires while the composer palette is open. See [BUTTONS.md](../BUTTONS.md) for the lesson-to-flow table and verification.

Flow results and missing-input forms render through the existing persisted CardView in the tutorial transcript, so repository choices and file forms stay accessible while the workspace is covered.
