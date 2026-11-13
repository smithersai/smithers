# 0025. One Foldkit app, an Electrobun host

Status: implemented locally, 2026-11-07. Rulings: VL-4, VL-5, VL-6, VL-7, VL-8, VL-11, VL-13, VL-23, VL-27,
VL-29; SDK-4, DUR-5. Roadmap: brick 7. Reference: [desktop design](../designs/desktop/index.html),
[designer notes](../designs/desktop/NOTES.md).

`apps/vibelang-desktop` is a composition root. It imports the existing Foldkit model, update, subscriptions,
conversation machine, chat view, styles, mock Factory and live protocol. Its wrapper renders the native titlebar,
folder and model controls, Models pane and real file receipts. Search counts remain visible when collapsed; expanded search shows the actual matching lines. A receipt records its producing model, so later selection cannot relabel old work. No desktop code enters the web bundle. The shared
HTTP transport exposes its existing conversation handler independently of the project-history handler; neither
transport owns business rules. This is a runtime host, rather than a new project feature or a private plugin API.

Electrobun is approved by name in VL-6. Pin 1.18.1 and use its published 1.x Bun API. Override its older bundled Bun with 1.4.2, this repository's toolchain. Its source-only native
API is behind a small declaration port and a package-private conditional import in `@smthrs/platform-bun`.
`BunDesktop` loads FFI only while its layer is built; the real native test checks the port. Scoped close failures are sanitized to the same typed boundary failure and observed without OS diagnostics. `BunServer` supplies a
scoped Effect HTTP server on loopback. Bun 1.4 decodes native cstring callback arguments; Electrobun 1.18.1
incorrectly decodes them again. The retained native regression requires no callback-conversion errors. A pnpm patch
accepts both forms and removes raw callback payload/error logging. The Linux native URL opener also interpolates
the URL into a shell fallback; a retained benign marker-file regression reproduced command substitution. The patch
uses an argument vector with the OS opener, bounds its wait and suppresses URL-bearing child diagnostics instead.
The required compatibility marker is version 3, covering both corrections and native chooser cancellation: Bun 1.4 returns null for Cancel, which the upstream wrapper dereferenced. The real chooser regression selects a folder and cancels a second dialog. The SDK ships that patch for external consumers
and requires its exported compatibility marker before opening any window; an unpatched peer fails closed. The app never calls Bun, Node filesystem APIs or sockets directly.

Local files use `BunFileSystem` and the kernel's existing descriptor-relative `confined` view: the selected root is
pinned by identity, symlinks, hard links and traversal are refused, with no pathname-based fallback. The packaged
SDK helper stays outside the chosen folder. File reads and writes default to one MiB, configured by
`VIBELANG_DESKTOP_FILE_BYTES`. A failed folder selection preserves the existing folder. An unchanged edit produces
no write and no duplicate diff. A reply records its model and folder selection; closing or switching folders
revokes its captured file capability and reports Folder changed. A stale reply cannot mark a newly selected model failed: each choice has its own persisted selection identity. Reopening a saved folder requires the same device/inode identity. Each settings
Action includes its atomic save, so cached replay never restores only the display. File edits persist a stable-call
write-ahead intent, then write a private sibling and use the SDK's atomic rename; a partial temporary write cannot
truncate the original. `fs.edit` requires the exact original from `fs.read` as `before`; a stale expected original or unchanged replacement returns false without a write. A changed original is also refused immediately before the SDK rename. Completed replay validates its original folder/path/before/after request before returning the cached success. Receipts and failures persist across process crashes. File contents and diffs are product data; logs, spans and counters carry operation
and outcome only.

Local model discovery and selection are the injected `LocalModels` service. The person chooses a loopback
OpenAI-compatible endpoint and one of its listed models. The SDK's OpenAI route handles its real HTTP/SSE protocol,
without a provider key. Discovery has a configured finite deadline (`VIBELANG_DESKTOP_DISCOVERY_MS`, default 10 seconds). `AgentAction` supplies its own durable `ModelStep`s and cell harness; the ordinary flow
bindings `fs.search`, `fs.list`, `fs.read` and `fs.edit` reach the selected folder. Search uses the standard `Grep`/`PortableSearch` service over the same confined filesystem, returning relative paths directly usable by read and edit. Post, dispatch, model calls, preferences and
tool effects run in the Bun SQLite flow engine. The conversation's sequencer remains the only writer of its events.
Settings and conversation events persist on this machine, independently of the chosen working folder.

The native window serves trusted bundled assets and its API from a loopback server with same-origin checks and a
CSP. Every `/desktop/*` and `/api/*` request also needs this launch's random secret: the host opens the window at
`/desktop/launch` with it, which sets an HttpOnly SameSite=Strict cookie and redirects to the app, so another local
process cannot read the person's folder or choose the model by forging Host and Origin.
Native navigation is restricted to that origin, the view has no Electrobun RPC, and ordinary builds enable no CDP
port. The headless test build opts into a CDP port for Playwright. Mock is the product MockFactory, with no
model or backend; selecting a local model changes the injected Factory. The agent's tour retains its existing
mock flow in its isolated tour conversation, labelled Mock. A saved Mock choice restores without consulting its
saved local provider. Selecting a local model exits that mock conversation.

The shared History link landed while this lane was running. Its page uses the shared Foldkit history model,
view, subscriptions, role source and real `MockMythical` flows. With no shared project backend configured it is
labelled Mock, independently of the chat's selected local model. It adds no second project service or sign-in. The shared Factory accounts seam delegates to the real product Mock accounts while in Mock. A local model restores the local host's Viewer session (`available: false`), so sign-in reports unavailable without navigating to an absent OAuth flow. Selection synchronously clears Mock identity and refreshes the shared account state; late identity responses cannot cross either direction. Mock roles never carry into local project authority. A local tour labels only its guided conversation Mock and retains unavailable Viewer project controls.
The web entry, view/style components and Vite build choices remain unchanged. The shared keyboard subscription ignores already-handled events so a picker Escape is consumed once. Test-only Node types and happy-dom align to the root so Effect Vitest and each app use one physical Vitest 5.0.0 instance after a fresh install.

Design conflicts, where the rulings win:

- The shared marketing media (VL-19, decision 0026) arrived after this design; keep those images and tour assets in the same shared view.
- The main branch added History (VL-29) after the desktop design. Keep that shared feature; native navigation
  wraps on phone screens instead of dropping links. The same page's no-backend state remains truthfully Mock.
- The design shows downloads, disk capacity and deletion of model files. VL-6 specifies a person-chosen local
  endpoint; this host lists and selects the models that endpoint already serves. Model installation and deletion
  remain with that endpoint's manager. There are no invented sizes, percentages or success states.
- The design shows separate cloud-provider sign-ins. Shared project identity belongs to decision 0019; VL-6 adds
  local capabilities to the same app. This lane adds no second authentication or cloud model catalog.
- The design's Mock pill is shown next to a scripted local-model example. VL-13 requires the mode to be truthful:
  Mock appears only while the product mock answers. A real local model is labelled local.
- Native controls follow the OS. The Mac traffic lights are not drawn as nonfunctional controls on Linux. The
  designer's dashed review harness is not application UI.
- A provider can report that a model is unavailable, without saying that memory is exhausted. The error names the
  model and offers Choose a model; the host does not invent a memory diagnosis. Loading reflects the real selection
  request, rather than fabricated RAM or download progress.
- The agent's existing guided tour remains the shared mock tour when using a local model. A local model is not
  asked to impersonate a verified tour; project backend features remain the shared app's, outside this host's API.

Tests: service units use the real pinned filesystem and a faulty external HTTP Effect service. The native browser
case launches Electrobun under Xvfb, uses its actual GTK chooser through X11, and drives the same Foldkit chat against
an OpenAI-compatible test server written as an Effect service. It kills and restarts the native process, retains edit diffs and model failures, changes folders during a held provider response, and verifies blocked native navigation. The native fixtures retain one advisory OS lock until bounded process teardown completes; simultaneous validation cannot overlap their Electrobun resources. No request interception or application mock is used.
The server is deliberately small and deterministic; it is protocol evidence, not a model-quality evaluation.
The five marked admission/selection/edit functions have LemmaScript/Dafny contracts (ten verified obligations), with five unchanged-contract negative controls; URL parsing, native syscalls, Effect, SQLite and the SDK
runtime remain trusted boundaries. This is not a claim of proofs of those dependencies. Native wrapper coverage runs under Node/V8 against an actual Electrobun fixture through a foreign transport; it does not count native C++ as V8 coverage.

Build macOS artifacts on the lead's Mac with the commands in the [desktop README](../../../vibelang-desktop/README.md).
Linux artifacts and the real native test are this lane's evidence. Signing, notarization and deployment are separate.

Reused tools awaiting Will's VL-5 review: VibeLang/Vite, VibeLang-unplugin/esbuild, Vitest, Effect Vitest and
Playwright, at the monorepo versions already listed in 0008. Electrobun itself is the explicit VL-6 approval.
No additional runtime library choice is introduced; `vibelang-runtime` 0.0.12 is also required by the new SDK `.vibe`
modules, at the same version as the existing app and SDK packages.

Tool history is stored per conversation beside its event log; settings contain only folder and model choices.
The state endpoint reads only the requested conversation's receipts, and the view rejects receipts arriving after
a conversation switch. Edit receipts retain a bounded changed span and short context rather than complete files;
search receipt text is bounded too. Exact edit originals remain in a separate write-ahead file until tool calls
return, their receipt is archived and their reply settles. Startup migrates older settings idempotently and
archives completed recovery intents before reclaiming those whose reply has a durable terminal event.
Confirmed refusals discard their intents; uncertain filesystem outcomes retain their originals for recovery.
