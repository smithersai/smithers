Deployment model tests use the test account's own saved model. Supply `E2E_PERSONAL_MODEL_KEY` securely in the runner environment. Optional settings:

- `E2E_PERSONAL_MODEL_PROTOCOL`: `openai-chat` (default) or `anthropic-messages`.
- `E2E_PERSONAL_MODEL_BASE_URL`: defaults to `https://api.openai.com`.
- `E2E_PERSONAL_MODEL_ID`: defaults to `gpt-4.1-mini`.

The deployment-auth setup saves through Settings' `PUT /api/me/model` and verifies through `POST /api/me/model/test`. A rejected key or exhausted provider quota fails setup before specs run. The failure names only a known refusal reason and a valid HTTP status; unknown response fields are withheld. No deployment or hosted provider credential is used as a fallback. Without the explicit key, `requires("personalModel")` skips answering tests with a reason; `liveModel` also requires this key on deployments. The shared device helper declares `personalModel` before sending questions, including specs that reach it indirectly.

Ship acceptance: `E2E_SHIP_ACCEPTANCE=1 E2E_PROD_URL=<production URL> pnpm e2e:prod`.
The required features/specs, browser targets and prerequisite variables live together in `ship.ts`.
Missing prerequisites fail before sign-in; required specs must execute successfully on both targets, and a
skip cannot pass the acceptance summary. See [infrastructure](../docs/infrastructure.md#against-a-deployment).

Deployment specs run with one worker because they share an account. Tests that remove or replace the model must disable traces and restore it in `afterEach`, including on failure. Personal-model tests exercise Remove without asking the hosted model afterward. Setup has video and trace disabled; the restoration helper never reports credential-bearing request diagnostics or provider bodies. Never pass keys on a command line or print them.

For a deployment: `BASE_URL=https://your-deployment.example pnpm exec playwright test agent.spec.ts --grep 'ask:'` runs deployment setup first. For collection only: `pnpm exec playwright test --list`. Run the prerequisite regression with `pnpm vitest run e2e/target.test.ts --coverage.enabled=false`.

Mobile layout audits retain full-document PNG evidence and original recordings.
Full-page capture can temporarily resize Chromium's recorded surface. The
`fullPageScreenshot` helper records these tool intervals as `captures` in the
media manifest; `gifs.mjs` excludes them before allocating scene and chapter
holds. It never infers exclusions from visual glitches. Chromium's screencast
sends a recorded frame only when the compositor draws, and restoring the
viewport draws nothing, so the helper ends each interval with a viewport
screenshot (`recordCurrentPicture`): the recording then holds the restored page,
not the tall surface's gray margin, after the cut. Unmarked flashes,
blank pages, frozen previews and missing chapters still fail validation.
The helper and teardown await renderer paint acknowledgments spanning two
recording sample slots, so short audits retain their final visible screen.

## Cold reads and shared branches

Cold-path regressions require `faults` and run against the dev build. `holdColdReads` configures the injected
`ColdReads` service before navigation; the inline first-paint host and the app's `FetchHttpClient.Fetch` share
its switches. Only the selected first-paint, role and issue-shape reads wait. Release resumes real HTTP;
cancellation stops the caller, and an abandoned hold expires within 30 seconds. Every cold journey checks the
content-free expiry record so a response after expiry cannot pass as held-sync evidence. Production bundles contain
none of this service. Happy-path first-paint and search journeys retain their real services.

Opening a branch updates the account's conversation history, including its archived state. Every suite opening
the fixed `octocat/Spoon-Knife` branches declares their exclusive branch leases in `resources.ts`, including
the history/archive, workspace, repository browser, sandbox and mobile journeys. Browser profiles alone do
not isolate those server-side writes.

## Distinct people

`branch-sharing.spec.ts` and the two-person journey in `coedit.spec.ts` run locally with developer identities, and against deployments with real GitHub test accounts. A single account on two devices never satisfies this proof.

In the deployment's private `e2e.env` (or environment), configure:

- `E2E_TEAMMATE_LOGIN` and `E2E_TEAMMATE_SESSION`: the other test account's expected GitHub login and absolute path to its private Playwright app-session file. It must be a Member or above on the scratch repository.
- `E2E_GUEST_LOGIN` and `E2E_GUEST_SESSION`: a Guest test account for the repository-link and role-ceiling journey. It must be distinct from the owner and have Guest access on the same scratch repository. The three-person journey also needs the Member account.

Provision each session through the existing deployment sign-in setup with that account's `E2E_GITHUB_LOGIN`, its own `E2E_GITHUB_PROFILE`, and a separate `E2E_SESSION_DIR`. Use the production runner and the same `E2E_PROD_LOCK` as the owner's run; never run two test-account sessions against the deployment concurrently. The profile must already be signed in to the named test account on GitHub. The setup verifies the login and saves only the app cookie. Point `E2E_TEAMMATE_SESSION` or `E2E_GUEST_SESSION` to that saved `session.json` (mode 600); never copy a personal account's session.

Both Member accounts also need an active saved model that resolves the Fast tier, provisioned and tested through each account's Settings. The composer journeys read both accounts' model shapes using the product's routing policy; missing readiness reports `blocked sharingModels`. The Guest never needs a model. No test copies a provider key between accounts.

The helper checks `/api/auth/session` for both people and `/api/repos/<owner>/<name>/role` for the other account before opening its app page. Duplicate person ids or logins, wrong accounts, wrong roles, expired sessions and insecure session files fail. Missing configuration is a **blocked prerequisite**, which makes the production runner fail, rather than an accepted deployment skip. Local `devPeople` restrictions remain unchanged.

Production fixtures use dedicated `smithers-e2e-sharing` and `smithers-e2e-coedit` branches on the harness's scratch repository. They never share the ordinary run's conversation. The owner removes fixture grants before each test and in `finally`, including grants left by a failed run. The sharing proof exercises the UI and direct API authorization, and holds independent branch, text and terminal sockets across revocation. Those sockets must close with policy code 1008; revoked text, terminal and message shapes must return no rows.

Run with `E2E_PROD_URL=<deployment> pnpm e2e:prod branch-sharing.spec.ts coedit.spec.ts --project=deployment --grep 'branch sharing:|co-editing: Maya'`. Source support is not a production pass: retain the runner's blocked/failing receipts until all real-person journeys pass.
