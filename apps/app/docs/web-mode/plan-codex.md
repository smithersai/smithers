# Native-default Smithers with a web funnel

Status: proposed architecture, 2026-09-02. This plan preserves one product and one state model, but emits separate native and web artifacts. “Native” means the local Bun host, normally wrapped by Electrobun; “web” means the Cloudflare-hosted cloud runtime.

Tree check: the working tree is ahead of the brief while the sidebar lane is in flight. `Flows.ts` currently has 88 `cloud`, 20 `local.targets`, 14 `identity`, 11 `local.repositories`, 3 `local.harnesses`, 2 `keys.byok`, 2 `billing.checkout`, 2 `agent`, and 1 `local.terminal` runtime declarations. The architectural fact is unchanged: declarations carry their host needs and the registry filters them against bootstrap capabilities ([Flows.ts](../../src/mainview/flows/Flows.ts#L117-L151), [Commands.ts](../../src/mainview/flows/Commands.ts#L128-L145)).

## 1. Mode model

### Decision

`GET /api/bootstrap` is the only authority for product mode and features. `bootstrap.host === "cloud"` means web; `bootstrap.host === "local"` means native/local. `window.__electrobun` answers only whether the local page has the two privileged shell doors (folder picker and external-browser open); it must not turn cloud capabilities on or off. This matches the existing separation between `AppRuntime.backend` and `AppRuntime.shell`, and it keeps headless local T1 valid without pretending Chromium is Electrobun ([Runtime.ts](../../src/mainview/runtime/Runtime.ts#L20-L33), [Runtime.ts](../../src/mainview/runtime/Runtime.ts#L63-L85), [NativeBridge.ts](../../src/mainview/native/NativeBridge.ts#L7-L44), [LOCAL-APP.md](../LOCAL-APP.md#composition-roots)).

The client validates bootstrap before constructing the controller; a missing or invalid bootstrap remains a boot error. Build mode is not authorization: a compile-time `web` or `native` constant may select a module graph, but visible and executable behavior still comes from the validated bootstrap. Native production should also diagnose `host: local` without the Electrobun bridge as “local browser/headless”; it is a supported test/development host, not web mode ([AppBootstrap.ts](../../../../packages/rpc/src/AppBootstrap.ts#L3-L35), [ControllerBoot.client.ts](../../src/mainview/ControllerBoot.client.ts#L27-L51), [serve.ts](../../src/bun/serve.ts#L1-L23)).

Keep the existing `RuntimeCapability` vocabulary and each flow's `runtime` / `runtimeAny` metadata. Do not add a second `webFeatures` list. The Worker and Bun bootstrap responses remain the composition roots; the command registry remains the single registration gate ([AppBootstrap.ts](../../../../packages/rpc/src/AppBootstrap.ts#L6-L31), [server.ts](../../src/bun/server.ts#L517-L539), [index.ts](../../../server/src/index.ts#L2236-L2254), [registry.test.ts](../../src/mainview/flows/registry.test.ts#L464-L501)).

### Honest unavailability

Preserve two projections from the same declarations:

- `enabled`: declarations whose `runtime` and `runtimeAny` are satisfied; only these enter buttons, slash results, the model tool catalog, recommendations, and `data-flows`.
- `unavailable`: declarations rejected by that same predicate, retained only to classify an explicit request. It is never an executable catalog.

If web receives an exact native-only invocation, resolve it in `unavailable` and produce: “`<act>` is not available in the web app — download the native app.” Attach the `native.download` action. Do not return `unknown-command`, which currently makes an unavailable known flow indistinguishable from a typo ([Commands.ts](../../src/mainview/flows/Commands.ts#L224-L250)). Missing identity or sign-in remains a state prerequisite and uses the existing defer/prompt behavior; it is not a mode refusal ([registry.ts](../../src/mainview/flows/registry.ts#L136-L169)).

`native.download` is the user-only navigation flow. `native.download.prompt` is model-invocable and renders an inline CTA card whose button invokes `native.download`; the agent never navigates. The generated instruction block must derive one web-only line from bootstrap plus the unavailable projection: local repositories, local targets, local terminal, and installed local harnesses require native; when asked, state that fact and invoke `native.download.prompt`. This extends the catalog-grounded honesty mechanism instead of relying on prompt folklore ([Instructions.ts](../../src/mainview/state/Instructions.ts#L45-L78), [Instructions.ts](../../src/mainview/state/Instructions.ts#L273-L314), [Flows.ts](../../src/mainview/flows/Flows.ts#L11-L20)).

## 2. Web feature set

The web app is a useful cloud workbench, not a disabled desktop demo. All cloud HTTP calls stay same-origin through the Worker, which validates the cookie session, obtains the user's cloud token server-side, and forwards only allowlisted route families ([index.ts](../../../server/src/index.ts#L2008-L2037), [index.ts](../../../server/src/index.ts#L2150-L2223)).

| Feature | Web | Native | Reason / boundary |
| --- | --- | --- | --- |
| Cloud repositories and file reads | Yes | Yes | The Worker already proxies `/api/repos/*`; `FilesSeam` already reads cloud contents, while Bun forwards the same product family. Extend the sidebar tree to use that seam for cloud repository nodes ([FilesSeam.ts](../../src/mainview/state/seams/FilesSeam.ts#L1-L13), [server.ts](../../src/bun/server.ts#L298-L311)). |
| Issues | Yes | Yes | `issues.*` is `cloud`-gated and therefore belongs to both hosts when each advertises `cloud` ([Flows.ts](../../src/mainview/flows/Flows.ts#L953-L1079)). |
| Changes and review | Yes | Yes | Change, landing, and review flows are cloud operations and already carry `runtime: ["Smithers Cloud"]`; consequential land/review acts retain confirmation ([Flows.ts](../../src/mainview/flows/Flows.ts#L1596-L1682), [AGENTS.md](../../AGENTS.md#frames-are-the-navigation-model)). |
| Cloud workspaces | Yes | Yes | Workspace CRUD/cards are `cloud` flows and use the same card in both shells ([WORKBENCH-UX.md](../WORKBENCH-UX.md#31-workspace-desktop-compute-citc--googles-cloud), [WorkspaceSeam.ts](../../src/mainview/state/seams/WorkspaceSeam.ts#L1-L20)). |
| Cloud workspace terminal | Yes | Yes | Web uses a direct Smithers Cloud socket with a short-lived ticket; native keeps its Bun-held-bearer tunnel. Details below. |
| Agent chat | Yes | Yes | Both clients use the HTTP `AgentPort` interface; the browser posts NDJSON turns to the same-origin Worker, while local Bun owns its relay ([WebAgent.ts](../../src/mainview/native/WebAgent.ts#L127-L216), [CloudAgent.ts](../../src/bun/CloudAgent.ts#L1-L20)). |
| Flows and durable runs | Yes | Yes | `flow.*`, `runs.*`, and approvals are `cloud`/gateway-backed and render the same embedded run cards. No browser-local engine fork ([Flows.ts](../../src/mainview/flows/Flows.ts#L439-L703), [wrangler.jsonc](../../../server/wrangler.jsonc#L20-L42)). |
| Local repositories and their file tree | No | Yes | The picker, canonical path grant, repository store, and bounded reads live in Electrobun/Bun; the renderer never supplies a production path ([index.ts](../../src/bun/index.ts#L1-L7), [repoTargets.ts](../../src/bun/routes/repoTargets.ts#L24-L39), [RepoFiles.ts](../../src/bun/RepoFiles.ts#L1-L13)). |
| Local targets | No | Yes | Query/run authority resolves opaque repo and target grants in Bun and rechecks them before process launch ([LOCAL-APP.md](../LOCAL-APP.md#repository-and-process-authority)). |
| Local terminal / installed harness sessions | No | Yes | The PTY and harness discovery are Bun services and their flows are explicitly `local.terminal` / `local.harnesses` gated ([Flows.ts](../../src/mainview/flows/Flows.ts#L1694-L1759), [server.ts](../../src/bun/server.ts#L129-L136)). |
| BYOK provider keys | No | Yes, after a native keychain lane | Today both hosts correctly omit `keys.byok`, and the Worker explicitly refuses its nonexistent cloud key store. Native may advertise it only after Bun stores secrets in the OS keychain and exposes masked metadata; secret bytes never enter cards, TanStack DB, logs, or browser storage ([index.ts](../../../server/src/index.ts#L2069-L2078), [KeysSeam.ts](../../src/mainview/state/seams/KeysSeam.ts#L1-L16), [KeysCard.tsx](../../src/mainview/cards/KeysCard.tsx#L1-L39)). |
| Billing balance and checkout | Yes | Yes | Balance is same-origin on both. Checkout/portal register only when `billing.checkout` is advertised; canary currently keeps checkout off while alpha usage is comped ([Flows.ts](../../src/mainview/flows/Flows.ts#L2119-L2143), [index.ts](../../../server/src/index.ts#L2039-L2053), [server.ts](../../src/bun/server.ts#L304-L311)). |

### Web terminal transport

Use **direct-to-cloud with a 30-second, single-use terminal ticket**. Do not proxy the byte stream through the Worker and do not add a terminal Durable Object. The Worker adds one exact, session-gated ticket-mint route: it validates the web cookie, obtains the per-user cloud bearer, calls Smithers Cloud's ticket endpoint, and returns only the narrow ticket. The browser immediately opens Smithers Cloud's terminal URL with subprotocol `terminal` and the ticket, then discards it. The existing backend contract already defines this browser ticket, binary PTY frames, JSON resize frames, a 64 KiB ceiling, and terminal close semantics ([0002-citc-sandbox-kinds.md](../decisions/0002-citc-sandbox-kinds.md#terminal-attach-contract-plue-0c-2026-09-02), [CloudTerminalClient.ts](../../src/mainview/state/CloudTerminalClient.ts#L59-L85)).

This keeps the long-lived, latency-sensitive stream off the product Worker and avoids creating a stateful relay whose only job is copying frames. A raw PAT or gateway token must never reach JavaScript; current Worker gateway records and native cloud credentials already follow that rule ([index.ts](../../../server/src/index.ts#L365-L369), [CloudAuth.ts](../../src/bun/CloudAuth.ts#L1-L18)). The ticket is exposed to the browser by necessity, but its damage radius is one attach for 30 seconds. It must be absent from TanStack rows, analytics, error reports, referrers, and logs; CSP `connect-src` allows only the product origin and the exact Smithers Cloud WSS origin. Configure Smithers Cloud's allowed browser origin for production before enabling the capability.

## 3. Funnel

### First visit and first value

Auth remains a conversation state, never a landing page. The first transcript contains one derived Smithers message and its real actions; the composer stays mounted. This follows the one-chat rule and replaces the current web signed-out empty transcript with an intentional funnel ([DESIGN.md](../../../DESIGN.md#3-layout-grammar), [App.tsx](../../src/mainview/App.tsx#L218-L258), [AuthChat.test.tsx](../../src/mainview/state/AuthChat.test.tsx#L167-L192)).

```text
┌ Workspace ───────────┐  ┌────────────────────────────────────────────┐
│                      │  │ Smithers                                   │
│ Cloud work appears   │  │ Connect GitHub to open a repository and   │
│ here after sign-in.  │  │ read its files here.                      │
│                      │  │                                            │
│                      │  │ [Sign in with GitHub]  [Download the app]  │
│ Download the app     │  │                                            │
│ Theme                │  │ ────────────────────────────────────────── │
└──────────────────────┘  │ Ask Smithers…                              │
                          └────────────────────────────────────────────┘
```

The primary action is `auth.sign-in`; the secondary action is `native.download`. The message states only scopes returned by the identity seam. OAuth returns to the same frame URL. On a valid session the Worker-backed inventory loads, then a repo-chooser card asks one question; it never silently watches a repository ([AppController.ts](../../src/mainview/state/AppController.ts#L790-L817), [DESIGN.md](../../../DESIGN.md#3-layout-grammar), [ControllerBoot.client.ts](../../src/mainview/ControllerBoot.client.ts#L55-L76)).

After selection, expand that cloud repository's root in the sidebar and render its returned entries. Clicking `README.md` invokes the existing `files.read` flow and places the existing bounded file card in chat; it does not open a new page. The in-flight sidebar currently expands only local copies, so the walking skeleton must generalize `repo.tree` to `runtimeAny: ["Smithers Cloud", "local.repositories"]` and give its persisted row a cloud/local source rather than create a second tree ([sidebar-tree.md](../workbench-lanes/sidebar-tree.md#target-sidebar), [ChromeBar.tsx](../../src/mainview/tabs/ChromeBar.tsx#L182-L238), [FilesSeam.ts](../../src/mainview/state/seams/FilesSeam.ts#L246-L365)).

First-value SLO: for a signed-in user with an already mirrored repository, GitHub return → choose repo → readable file card in under 60 seconds. A cold import remains an honest import-progress card and is not counted as meeting that SLO until Smithers Cloud can actually do it; the UI must not fake a tree while an import is running ([RepoImportSeam.ts](../../src/mainview/state/seams/RepoImportSeam.ts#L213-L290)).

### Download placement and ownership

Place `Download the app` in three web-only places, all bound to `native.download`: secondary action in the opening message, a persistent text action in the sidebar footer above theme, and the action on any native-only refusal card. It is not a takeover: the click is explicit browser navigation, while every capability result and refusal still appears as a chat card. Native mode registers none of this funnel chrome ([AGENTS.md](../../AGENTS.md#the-embed-law--read-this-before-anything-else-will-2026-08-09-permanent), [ChromeBar.tsx](../../src/mainview/tabs/ChromeBar.tsx#L632-L680)).

`https://app.smithers.sh/download` lives in the production product Worker and is emitted by the web Vite build as a small second HTML entry backed by a checked release manifest. `apps/app` builds the page and signed native artifacts; `apps/server` serves it and owns routing/headers. Render only artifact/platform facts present in the manifest. The existing native packaging script is the build owner, but there is not yet a signed/notarized app release pipeline in this tree, so the page must not launch before that manifest gate exists ([build-native.ts](../../scripts/build-native.ts#L1-L34), [electrobun.config.ts](../../electrobun.config.ts#L17-L57)).

### Continue into native

Use a **one-time sign-in handoff delivered by a deep link**, not shared cookies. The native app is loopback-hosted, so the web origin's cookie cannot be shared; the existing native flow already proves a one-time claim can land a re-scoped HttpOnly session in the local WebView ([auth-billing.ts](../../src/mainview/state/controller/auth-billing.ts#L227-L379), [LOCAL-APP.md](../LOCAL-APP.md#local-origin-security)).

When a signed-in web user chooses Download, the Worker mints a five-minute, single-use continuation containing only server-side `login`, selected `owner/repo`, file path/frame pointer, and return URL. The download page carries an opaque handoff id. After install, `smithers://continue/<id>` launches the app; Bun claims the handoff server-to-server, establishes its local cookie through the existing claim pattern, loads the cloud inventory, selects the same repo, and renders the same file card. The URL contains no cookie, PAT, gateway token, or transcript. If claim expires, native opens its normal chat and offers its existing browser sign-in. V1 continues identity and cloud context, not the locally persisted transcript; cross-device transcript continuation waits for server-backed collection sync.

## 4. Build and deploy

### Build decision

Produce **two Vite artifacts from one SPA source**:

- `dist/web`: browser adapter, cloud runtime, funnel, download entry; no `electrobun/view`, local-session transport, PTY client, local repo/target implementations, or Bun code.
- `dist/native`: Electrobun adapter and local-session transport plus the shared cloud UI; no web funnel/download chrome.

The compile-time mode chooses only adapter imports and allows tree-shaking. Runtime bootstrap still decides capabilities. This changes today's arrangement, where native packaging first runs `build:web` and copies the same `dist` ([build-native.ts](../../scripts/build-native.ts#L14-L18), [electrobun.config.ts](../../electrobun.config.ts#L32-L39), [vite.config.ts](../../vite.config.ts#L69-L115)). Keep lazy feature boundaries for heavy editors/graphs; fail a bundle-contract test if `dist/web` contains `electrobun`, local-session meta/header literals, or native-only source chunks ([LOCAL-APP.md](../LOCAL-APP.md#build-and-verification)).

### Cloudflare topology

Leave `smithers-mvp-web` and `canary.smithers.sh` untouched as the frozen canary. Add a new production Worker, `smithers-web`, on `app.smithers.sh`, with its own config and fresh DO namespaces for `TURN_CANCELS`, `TURN_LIMITS`, `GATEWAY_SESSIONS`, and `CLIENT_ERRORS`. Fresh production DO state is deliberate; renaming the canary would orphan its state and detach its domain ([DEPLOY.md](../../../server/DEPLOY.md#frozen-identity--read-this-before-touching-wranglerjsonc), [wrangler.jsonc](../../../server/wrangler.jsonc#L1-L42)).

Production serves `dist/web` with SPA fallback, running the Worker first for the existing API/gateway families and exact `/download`/handoff routes. Secrets and upstream URLs are separate production bindings; never inherit canary credentials implicitly. The terminal needs only the ticket-mint HTTP route, not a new DO binding. Keep same-origin API rejection and the route allowlist ([wrangler.jsonc](../../../server/wrangler.jsonc#L14-L18), [index.ts](../../../server/src/index.ts#L1995-L2006)).

PRs receive an ephemeral `smithers-web-pr-<number>` Worker on its `workers.dev` URL, its own temporary DOs, preview identity origin, and read-only fixture account. CI posts that URL; closing the PR removes the preview. Vite preview is not an acceptance environment because it bypasses bootstrap, Worker auth/proxy behavior, assets fallback, DOs, and response headers.

### Targets, release, and rollback

Add owner targets, never shell commands in a root `BUILD.ts`:

- `//apps/app:webBundle`, `//apps/app:nativeBundle`, `//apps/app:bundleContract`, `//apps/app:webE2e`.
- `//apps/server:workerDryRun`, `//apps/server:previewDeploy` (manual/network), `//apps/server:prodDeploy` (tag/manual approval), and post-deploy probes.
- Aggregate those through the existing apps CI/deploy graph; generated workflow YAML is regenerated from targets, not hand-edited ([apps/app/BUILD.ts](../../BUILD.ts#L1-L81), [apps/server/BUILD.ts](../../../server/BUILD.ts#L1-L53), [repository AGENTS.md](../../../../AGENTS.md#invariants)).

Generalize `scripts/deploy.ts` to accept a checked deployment descriptor, build `dist/web`, deploy the selected immutable Worker identity, and write a receipt containing environment, Worker, domain, git SHA/dirty bit, web asset digest, Wrangler version id, and native release-manifest version. A real deploy with no version id remains a failure ([deploy.ts](../../../server/scripts/deploy.ts#L47-L118)). Roll back by recorded version id; DO state is retained because identity is unchanged. Canary promotes to production only after the web walking skeleton and probes pass; production is never “promoted” by renaming canary ([DEPLOY.md](../../../server/DEPLOY.md#rollback)).

## 5. State and persistence

The collection model stays identical. Web persists conversations, cards, frame graph, selections, world notes, and UI preferences in origin-scoped OPFS SQLite; it falls back transactionally to localStorage, then to an explicit non-persistent memory session. The backend selection already happens before collection creation and both implementations preserve the same collection boundary ([persistence.md](../persistence.md#backend-selection), [AppStore.ts](../../src/mainview/state/AppStore.ts#L1-L15), [persistence.md](../persistence.md#collection-contract)).

Native uses the same renderer collection store in its WebView profile, plus Bun-owned disk state for reopened repository grants and an OS keychain for cloud/BYOK secrets. Do not describe native collection state as a separate reducer or database model: Electrobun is a shell around the local host, and current repository persistence is explicitly under Application Support/XDG state ([index.ts](../../src/bun/index.ts#L30-L42), [repoTargets.ts](../../src/bun/routes/repoTargets.ts#L24-L37)).

Never place session cookies, cloud PATs, gateway relay tokens, BYOK values, terminal tickets, OAuth claim secrets, or download-handoff secrets in TanStack rows, OPFS/localStorage, URLs beyond the single-use opaque id, DOM/meta tags, client error payloads, analytics, or logs. The native local-session capability is the sole exception to the DOM rule: it is a per-launch 256-bit loopback capability already injected into the document and attached only to same-origin `/api` calls ([LocalSession.ts](../../src/mainview/runtime/LocalSession.ts#L9-L45), [server.ts](../../src/bun/server.ts#L717-L743)).

Existing protections to retain:

- Cloud responses carry COOP `same-origin` and COEP `require-corp`, required by OPFS SQLite; static assets are wrapped too ([index.ts](../../../server/src/index.ts#L170-L174), [index.ts](../../../server/src/index.ts#L2337-L2342), [_headers](../../src/mainview/public/_headers)).
- API requests with a foreign `Origin` are rejected, and client-supplied identity/authorization headers are stripped before trusted claims are injected ([index.ts](../../../server/src/index.ts#L176-L189), [index.ts](../../../server/src/index.ts#L995-L1025), [index.ts](../../../server/src/index.ts#L1995-L2006)).
- The identity Worker owns the session cookie and this Worker forwards it opaquely. Native re-scoping intentionally removes `Domain` and `Secure` on loopback while retaining other attributes ([index.ts](../../../server/src/index.ts#L995-L1004), [server.ts](../../src/bun/server.ts#L327-L337), [server.test.ts](../../src/bun/server.test.ts#L261-L320)).

There is no app-wide CSP in this tree today; only isolated HTML cards define one. Before production, add a nonce/hash-based CSP at the Worker response boundary: `default-src 'self'`, exact script/style/font/image needs, `connect-src 'self' https://api.jjhub.tech wss://api.jjhub.tech` (narrowed to deployed origins), `object-src 'none'`, `base-uri 'none'`, and `frame-ancestors 'none'`. Also add Referrer-Policy, X-Content-Type-Options, and a minimal Permissions-Policy. Test the actual web response, not only `_headers` ([TargetCards.tsx](../../src/mainview/cards/TargetCards.tsx#L780-L790), [_headers](../../src/mainview/public/_headers)). Require the production identity response to set `HttpOnly; Secure; SameSite=Lax; Path=/`; the app repo can prove forwarding, but the cookie issuer lives upstream.

## 6. Testing

### Shell matrix

Keep current local T1 and packaged T2. Add a `web` Playwright project that builds `dist/web` and runs the real Worker with `wrangler dev`; do not use Vite preview. The existing T1 deliberately boots `src/bun/serve.ts`, so it proves the local browser host, not the deployed web shell ([playwright.config.ts](../../playwright.config.ts#L3-L37), [e2e README](../../e2e/README.md#L8-L25), [webserver.ts](../../e2e/playwright/webserver.ts#L1-L35)).

Tag shared specs by required capability and execute the same source against eligible projects:

- `both`: frame history, chat/card embedding, auth-state rendering, cloud repo selection/read, issues/changes/workspaces/runs reads.
- `web`: funnel CTA, OAuth return, production headers, terminal ticket/direct socket, handoff mint, and absence of native code/controls.
- `native`: picker, local file tree, local targets, PTY, harnesses, keychain, and packaged bridge.

This avoids cloning the native suite. Web T1 uses a dedicated real identity, an already mirrored read-only repository, real Worker routes/DOs, and Playwright `storageState` containing an HttpOnly test session; page JavaScript never receives credentials. Mutating cloud acts remain in isolated accounts and keep their confirmation. Post-deploy smoke repeats the read-only funnel on the actual preview/canary domain.

### Parity matrix gate

Generate a row for every flow declaration against canonical web and native bootstrap fixtures. For each cell, expected registration is exactly the `runtime.every && runtimeAny.some` predicate in `Commands.ts`; assert the command registry, slash tree, model-disclosed catalog, recommendation list, rendered `data-flow` controls, and `data-flows` manifest agree. A native-only flow must be absent—not disabled—from every web enabled surface; its only permitted web rendering is an unavailable/refusal card whose enabled action is `native.download` ([Commands.ts](../../src/mainview/flows/Commands.ts#L132-L145), [App.tsx](../../src/mainview/App.tsx#L332-L340), [parity.test.ts](../../src/mainview/flows/parity.test.ts#L360-L392)).

Add three drift failures: a declaration with a runtime capability unknown to `AppBootstrapSchema`; a bootstrap capability with no tested host policy; and any web DOM `data-flow` missing from the web registry. Bundle-contract tests also reject Electrobun/local-session/native route literals in `dist/web`. Existing button/flow parity and bootstrap registration tests remain the base ([AppBootstrap.test.ts](../../../../packages/rpc/src/AppBootstrap.test.ts), [registry.test.ts](../../src/mainview/flows/registry.test.ts#L464-L501)).

## 7. Migration path

1. **Freeze the contract.** Add canonical web/native bootstrap fixtures, unavailable-flow projection, `native.download` plus `native.download.prompt`, deterministic web honesty, and parity tests. No UI layout or deploy changes yet.
2. **Prove the walking skeleton on canary.** Emit `dist/web`; add the opening chat card and sidebar download action; generalize the existing repo tree to cloud; prove visitor → GitHub sign-in → choose mirrored repo → expand root → read file card. This is the first useful release.
3. **Harden and split artifacts.** Add adapter entrypoints and bundle-contract checks, CSP/security headers, `/download`, signed release manifest, and preserve `dist/native` packaging.
4. **Stand up production.** Create `smithers-web`/`app.smithers.sh`, fresh DO bindings and production secrets; deploy a receipt-bearing build after canary and read-only production probes pass.
5. **Add browser terminal.** Ship ticket mint, direct Smithers Cloud WebSocket, origin allowlist, ticket redaction, 64 KiB/close-code tests; advertise web terminal only after the end-to-end attach passes.
6. **Continue into native.** Register the custom protocol, add one-time continuation records/claim, and resume auth + repo/path. Transcript sync is explicitly later.
7. **Finish native differentiation.** Put provider keys in the OS keychain, then advertise `keys.byok` only from native bootstrap. Do not expose a web BYOK control until a real server-side secret store exists.

### Risks and mitigations

- **Capability drift creates false UI.** One declaration predicate, generated parity matrix, and DOM/bundle gates prevent it.
- **A ticket leaks through observability.** Short TTL/single use limits impact; structured redaction tests cover Worker logs, client errors, URLs captured in state, and receipts.
- **COEP or CSP blocks a dependency/socket.** Run response-header and full browser tests against `wrangler dev` before production; add only exact origins proved necessary.
- **OAuth works on canary but not production.** Production gets explicit identity allowed-origin/callback configuration and a real signed-in smoke before DNS launch.
- **“Continue” overpromises.** V1 copy says the app carries sign-in and repository context; transcript portability is not claimed until server synchronization exists.
- **Cold imports miss one minute.** Measure separately, show the real import card, and never substitute invented file data.

### Open questions for Will

1. **Production URL?** Default: `app.smithers.sh`; retain `canary.smithers.sh` only for promotion testing.
2. **First downloadable platform?** Default: signed/notarized macOS arm64 only, because packaged T2 is macOS-only today; render no Windows/Linux links until their artifacts pass equivalent gates ([e2e README](../../e2e/README.md#L29-L36)).
3. **Cold-import promise?** Default: the under-one-minute claim applies to already mirrored repositories; cold imports show truthful progress until backend measurements support the same SLO.
4. **Continuation depth?** Default: identity + selected repo + file/frame pointer, not transcript or unsaved drafts.
5. **BYOK scope?** Default: native-only OS keychain for this release; web waits for a reviewed server-side encrypted secret store.

## Lanes

| Lane | Files | Tests | Depends on |
| --- | --- | --- | --- |
| A — mode and honesty | `packages/rpc/src/AppBootstrap.ts`; `apps/app/src/mainview/{runtime/Runtime.ts,flows/{Flows,Commands,registry}.ts,state/Instructions.ts}` | AppBootstrap, Runtime, requirements, registry, instruction/honesty, generated parity matrix | — |
| B — web artifact split | `apps/app/vite.config.ts`; `apps/app/package.json`; `apps/app/src/mainview/adapters/*`; `apps/app/scripts/build-native.ts`; `apps/app/electrobun.config.ts` | two-build smoke; web bundle forbidden-import/literal scan; native packaged smoke | A |
| C — funnel and cloud tree (walking skeleton) | `apps/app/src/mainview/{App.tsx,tabs/ChromeBar.tsx,Onboarding.ts,flows/Flows.ts,state/{AppState,AppStore}.ts,state/seams/{RepoTreeSeam,FilesSeam}.ts,styles/*}` | shared Playwright funnel; cloud tree seam/card; EMBED, no-invention, button-flow parity | A, B |
| D — Worker web boundary | `apps/server/src/{index.ts,index.test.ts}`; `apps/server/wrangler.jsonc` (canary unchanged); new production/preview descriptors; `apps/server/BUILD.ts` | bootstrap capability, allowlist, same-origin, CSP/headers, assets/download routing, DO wiring | B |
| E — download/release | `apps/app/src/download/*`; native release-manifest builder under `apps/app/scripts/`; `apps/server/scripts/deploy.ts`; `apps/server/DEPLOY.md` | manifest schema/signature; no invented platform row; receipt/rollback probes | B, D |
| F — web terminal | `apps/server/src/index.ts`; `apps/app/src/mainview/state/{CloudTerminalClient.ts,AppController.ts}`; `apps/app/src/mainview/tabs/TerminalView.tsx`; shared route contract | mint auth/redaction/expiry; direct WS binary/resize/64 KiB/close codes; real web T1 attach | A, D; Smithers Cloud origin configured |
| G — native continuation | `packages/rpc/src/*Handoff*`; `apps/server/src/index.ts`; `apps/app/src/bun/{index,server}.ts`; `apps/app/electrobun.config.ts`; auth controller | one-time/expiry/replay; no credential in deep link/state/log; packaged launch resumes repo/file | C, D, E |
| H — native BYOK | `apps/app/src/bun/*Keychain*`; bootstrap route; `KeysSeam.ts`; flow/card contracts | keychain lifecycle; renderer sees masked metadata only; web parity stays absent | A, B |
| I — CI, previews, rollout | `apps/app/BUILD.ts`; `apps/server/BUILD.ts`; `ci/BUILD.ts`; generated app deploy workflow; deploy/canary scripts | `wrangler dev` web project; preview smoke; canary→prod receipt/build/rollback probes | C–G |

### Production sign-in origin (2026-09-16)

The web bootstrap selects the existing `native-handoff` protocol. The user gesture reserves a popup before durable command admission; GitHub completes there while the original repository page remains usable. Only the one-time claim response sets the session cookie on the requesting origin. This avoids tying production sign-in to the identity worker's fixed canary callback and retains the parked action on its original page. No poll secret or session is placed in the popup URL.
