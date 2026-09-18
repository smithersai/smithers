# End-to-end tiers (`apps/app/e2e/`)

The hermetic web harness that lived here (`run.ts`, `suites/`, the Worker
doubles) was removed with the web build path on 2026-08-26
(`docs/LOCAL-APP.md`). End-to-end coverage has one browser tier and one
packaged-app tier.

| Tier | Script                               | Runner                 | Specs                    |
| ---- | ------------------------------------ | ---------------------- | ------------------------ |
| T1   | `pnpm --filter smithers-app test:e2e` | `playwright.config.ts` | `playwright/*.spec.ts`   |
| T2   | `bun run test:e2e` (repository root) | `packaged/run.ts`      | `packaged/*.e2e.test.ts` |

T1 boots the local origin without a window (`playwright/webserver.ts` builds
the SPA and runs `bun src/bun/serve.ts` on port 47311 with
`SMITHERS_CHAT_STUB=1`) and drives it with headless Chromium. Specs that
belong to a lane whose server seams do not exist yet keep the server behind
`page.route` / `page.routeWebSocket` (`tabs.spec.ts`), so they pass unchanged
against the real origin.

T2 builds the stable Electrobun package and launches its real executable with
the production native renderer. A test-only, bearer-authenticated HTTP bridge
binds `127.0.0.1` only when the runner supplies `SMITHERS_E2E_BRIDGE=1`; DOM
evaluation crosses Electrobun's own WebView RPC. The local origin, its HTTP
routes and the native renderer are production implementations.

Every test gets a temporary home and uses the app's persisted local origin, so
relaunch tests exercise production origin selection without touching the user's profile. An atomic suite lease
and per-test marker are cleared only after process and fixture cleanup. A dead
prior lease is removed and fails preflight once; rerun after inspecting the
stale-fixture report, or set `SMITHERS_E2E_RECOVER_STALE=1` to repair and
continue explicitly. Failure logs, reports, and best-effort screenshots land
under `test-results/electrobun-packaged/`. T2 currently requires macOS and
network access to the public fixture remote.

`contracts/` holds the assertion contracts both tiers share: pure predicates
that decide what counts as evidence, each with its own Bun test.
`assistantReplyEvidence.ts` requires a completed assistant bubble rendered
after the user turn a send appended, so the bubbles the app renders at boot
never read as a reply to it. `//apps/app:unitTests` runs `contracts/` alongside
`src`, and `packaged/run.ts` reruns it in preflight.

`native/` holds the main-process subprocess probe driven by
`src/bun/Main.test.ts`; see `native/README.md`.

## Sign-in probe (`probes/signin-roundtrip.mjs`)

`probes/signin-roundtrip.mjs` proves the app's own sign-in door round trip
against the deployed host, https://smithers.sh by default. It opens the
repository page, clicks the `Sign in with GitHub` door (clearing only the
host's cookies first when the profile is already signed in, never GitHub's),
signs in as the shared test account `codeplanesmithers`, expects the door to
return to that same repository page with the `signed-in` marker stripped, and
then expects the Account card to read `Account · @codeplanesmithers`. It is a plain Node
script, not a Playwright spec: `playwright.config.ts` only collects
`e2e/playwright`, and `PACKAGE.ts` only globs `e2e/**/*.ts`, so it never runs
inside the T1 suite or the typecheck target.

Run it with `node apps/app/e2e/probes/signin-roundtrip.mjs [host] [owner/repo]`.
Its paths come only from the environment: `SMITHERS_E2E_PROFILE` names the
persistent Chromium profile (default `~/.multi-e2e-profile`),
`SMITHERS_E2E_NOTES` names a notes file outside the repository holding a
`password: <value>` line (default the `multi-test-github-account` memory file),
and `SMITHERS_E2E_USER` overrides the login. The probe never prints
credentials; when the saved GitHub session has expired it logs the account in
again from the notes file, and it fails with a reason when GitHub asks for a
device code. Run it after every deploy that touches auth, chrome, or the shell.

That profile is the one the real-E2E suites lease, so the probe takes the same
atomic lease (`<profile>.smithers-real-e2e.lock`) before opening it and releases
it on every exit; a second owner gets `FAIL: the persistent profile is in use`
instead of a shared browser. A door counts only when it is visible: a dismissed
composer overlay and an answered transcript step both keep a sign-in button in
the DOM, and counting those read a signed-in page as signed out (2026-09-17).
`probes/support.mjs` holds both rules and `bun test e2e/probes/support.test.mjs`
proves them offline against a local Chromium.

After the Account card check it reads `GET /api/auth/session` back and prints
the claims that carried the round trip. `codeplanesmithers` is in the identity
Worker's `ADMIN_LOGINS` today, so the probe prints `admin=true` and continues;
`SMITHERS_E2E_REQUIRE_NON_ADMIN=1` fails the run on that claim instead, which is
how a run proves the ruling below.

## The identity the suites run as

Will's ruling (Factory spec 2026-09-08, `review/RULINGS.md` 35): open sign-in
is on and the permission tiers behind it stay deliberately narrow, so the e2e
and canary suites run as a scoped-down signed-in user and prove the product
works under the permissions a real visitor has. A suite that authenticates as
the factory admin is green while the product refuses everyone else, which is
the permission bug the suite exists to catch.

`codeplanesmithers` is that scoped-down account. It is a plain GitHub login: it
must not appear in the identity Worker's `ADMIN_LOGINS`, must not hold a
maintainer claim on any repository, and must not appear on the hand-seeded
closed-alpha roster `CANARY_ALLOWLIST_LOGINS`. The sign-in probe signs in as it
(`$SMITHERS_E2E_USER`), and the server-side canary carries its session in
`$CANARY_SESSION_COOKIE` and its login in `$CANARY_SESSION_LOGIN`; those
variables are documented in `apps/server/DEPLOY.md`, under "The canary and e2e
suites sign in as a scoped-down user".

T1's server doubles answer with the same account. `playwright/identity.ts`
holds it once, `SCOPED_TEST_USER` for `/api/auth/session` and
`SCOPED_TEST_USER_CLOUD_SESSION` for `/api/cloud-auth/session`, so no spec
invents a login of its own. `allowlisted` is `true` there because open sign-in
makes identity answer `true` for every login (Factory spec 01 §3); the
privilege is the `admin` claim and the seeded roster, never that flag. A spec
that genuinely needs a maintainer or an admin says so in the spec, with the
reason, rather than raising the constant for every other spec.
