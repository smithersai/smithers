# Repository onboarding

`src/mainview/onboarding/lessons.ts` owns the current tutorial's copy, buttons, keyboard shortcuts, and completion signals. The earlier TUTORIAL2 planning documents describe historical implementation work; the running lesson table is authoritative.

| Stage | Action | Completion |
|---:|---|---|
| 0 | Start tutorial | tutorial.started |
| 1 | Read the tip and repository update; show issues | issues.opened |
| 2 | Read issue #3 in the same embedded frame | issue.opened |
| 3 | Inspect the existing issue flows and repro prompt | issue.flows.opened |
| 4 | Run live research | issue.researched |
| 5 | Choose Implement to generate a plan | plan.ready |
| 6 | Approve the plan and run live implementation | commits.made |
| 7 | Review the actual implementation diff | diff.opened |
| 8 | Open the changed file from the diff | diff.file.opened |
| 9 | Select actual commits and create a local review Change | change.opened |
| 10 | Optional GitHub sign-in | identity.signed-in |
| 11 | Install the GitHub App for selected repositories | github.app.installed |
| 12 | Launch Wiki and Mythical history flows | librarian.runs.launched |
| 13 | Open Chat; learn Dictation | palette.opened |
| 14 | Finish, or explore capabilities at a manual pace | explicit Finish |

## Live example before sign-in

Research, planning, implementation, and POC use the anonymous live service through `/api/tutorial/live`. No GitHub login or installation is required to complete stages 0–9. The example issue and repository inventory are bundled; agent work, tests, commits, files, patches, and elapsed steps are actual execution results. No recorded run is substituted when the live service fails.

The Worker scopes an HttpOnly signed visitor cookie to a credential-free example workspace. The coordinator runs Smithers AgentAction flows durably and delegates constrained filesystem/test/git operations to isolated gVisor pods. See [the coordinator](../../tutorial-coordinator/README.md) and [executor](../../tutorial-executor/README.md) for deployment, isolation, and lifetime details. The resulting Change is a local review artifact, not a published GitHub pull request.

Requests persist an idempotency key before submission. Reload reconnects to the same operation. A playthrough guard prevents an old response from advancing a replay. A plan is reviewed before implementation; only actual commits with passing protected tests complete it. Failed or disconnected runs retain their error and expose Retry or Reconnect. Expired sessions preserve saved artifacts and explicitly require a new tutorial for new agent work.

## Embedded interaction and persistence

Issue list → issue detail and diff → file replace the current embedded frame, with persisted Back/Forward history. Pull requests open their own chat cards. Issue actions expose comment, close, repro, POC, implementation, existing flows, and Add flow through the shared flow registry.

Starting the tutorial runs `repo.update`. Repository notifications are scoped by identity and repository, deduplicated by source and version, and track processing, announcement, read versions, and tags separately. Source failures appear as partial updates. Marking one update read cannot consume a newer notification version.

The greeting has one Start tutorial action. Suggested actions follow the transcript content. Body typography is 16px and the chat column is wider. Chat and Dictation are separate footer controls. Command-K opens the composer; sending an accepted message closes it. Dictation fills a draft for review and submission. The sidebar starts closed on every launch; the Smithers logo or W toggles it, while text fields retain ordinary typing.

Lesson completion comes from persisted outcomes in the current playthrough. Required actions are never completed by Next. The capability reel advances only when the user chooses Next and ends with Finish. Finishing persists `guide.finished` and removes the tutorial shell. All controls retain their registered slash, button, and agent paths, with native keyboard semantics.

## Returning to the tutorial and installing GitHub

The greeting's Start button is only the first-visit gate. Store hydration resumes a greeting cursor when durable tutorial cards, messages, or completion receipts already exist, including older sessions with no guide row. It preserves the existing transcript, commit selection, and playthrough. Older guide migrations keep completion receipts and map to the matching current lesson. An explicit replay starts a new playthrough and does not adopt old artifacts. A partially completed recorded tutorial resumes at live research while retaining its old transcript and commit selection; recorded plans cannot authorize a live implementation.

The tutorial opens the registered `smitherspreviewrelease` GitHub App (app 4163546) in a separate browser tab after persistence settles. Returning to Smithers checks `/api/user/github-app/installations`; a setup callback can also supply an installation id to the same route. The server uses the caller's GitHub repository inventory and verifies each candidate's live GitHub App and user access diagnosis through the existing authenticated Cloud bridge. Inventory membership alone never completes installation. A callback id only filters verified results; it does not grant access. This source-only read does not require a prior repository import into Cloud; the diagnosis checks GitHub's live installation lookup and the user's own credential. Returns from another playthrough or an identity changed while verification was pending cannot advance the guide.
