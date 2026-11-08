# 0022. GitHub issues, committed tasks, and VIP review changes

Status: verified core and durable fixture flows landed; browser and GitHub host integration next. Live chat binding held by the documented compiler gap, 2026-11-08. Rulings: VL-4, VL-8 to VL-15, VL-17 to VL-23, VL-29; GH-1, FLOW-3.

## Authority and policy

`smithersai/vibelang` on GitHub owns issues, comments, labels, assignments and the tree. A parent is a GitHub
sub-issue relation, never a Markdown checklist or a separate application tree. App state contains ordered
observations, not an independent issue database. The conversation machine owns the pure projection and commitment
and review transitions. GitHub is read after writes; a refusal, partial listing or unknown write outcome is an error,
never a successful local change. Public reading uses an explicitly blank credential, not an ambient token.

A task is the same GitHub issue with label `vibelang:task` and a nonempty GitHub assignee. An open task is Queued,
`vibelang:running` makes it Running, and a closed task is Done. Uncommit removes the task and running labels and
assignments, preserving the issue's number, body, parent, state and other labels. Only a Maintainer commits or
uncommits. “VibeLang agent” in fixture mode is an explicit assignee; a live deployment must configure its actual
assignable GitHub login. Missing configuration refuses assignment rather than pretending a bot was assigned.

The least roles follow 0019: Viewer reads; New files and comments; Community drafts and proposes a VIP;
Contributor links and splits; Maintainer commits, uncommits, accepts and declines. `issuePolicyAction` maps operations onto 0019’s `Policy.authorize`; `issuePermission` directly calls 0019’s
proved predicate. There is one role ledger. Client controls are hidden below their least role, and the host checks the authenticated role again.
A request cannot supply an actor, role, token or repository. Session resolution and credentials stay on the host.

A write is an explicit person's request, using that person's user access token. There is no App installation token
or autonomous write fallback. No merge operation is implemented or offered to the agent. Accept records a human
review decision; it does not merge the pull request or silently commit work.

## Shared Smithers implementation and flows

The library catalog's GitHub entry is `@smthrs/integrations`. `GitHub.Calls.withToken` is extracted from
`apps/mvp/worker/github/Calls.ts`; that app re-exports it. The client, pagination, issue/comment operations,
sub-issue reads and `Action.once` reconciliation are unchanged shared Smithers code. Missing sub-issue mutations,
assignment updates and fork preparation belong in that package, with tests and docs, not a second app HTTP client.

`vibelang/issues/{read,new,comment,link,split,commit,uncommit,draft,propose,accept,decline}` are `@smthrs/flow` flows.
Factory exposes the same API to Foldkit, CLI and MCP. The host supplies identity and storage. Mock mode runs the same
flows on the memory engine with the designer's fixtures. Workerd runs them on its real SQLite engine. Logs,
spans and counters carry operation and outcome only, never content or credentials. Created issues, comments,
branches, commits and review changes use the SDK's keyed reconciliation; no app retry loop is introduced.

## VIPs

One VIP proposes one language feature. The four steps keep Summary, Example and Prior art before Review. “Draft with
agent” runs Smithers' AgentAction through the durable layer, with VibeLang's skill as context and the existing model
host and token budget. The fixture writer works without backend or model. Drafting changes no repository. The
person can edit the generated draft; Submit VIP is the explicit write.

Submission creates a branch and a fenced commit in the person's fork, under `docs/design/vips/`, then opens that
person's pull request for review and a GitHub issue tracking it. A hidden marker in the issue names its document and
review URL. The VIP's displayed number is the tracking issue's GitHub number. Paths use the operation identity to
avoid concurrent proposal filename collisions. A VIP requires a title, summary, example and prior art; one-feature
semantics are checked by the drafting instruction and human review, not claimed as a syntactic proof.

## Design and departures

The source design is copied verbatim to `wiki/designs/issues/`: index.html, NOTES.md and supporting sources/assets.
The design-doc toolbar is excluded from the app. List, detail, tree, badges, commit picker and four-step form use
the exact Smithers CSS classes and the designer's ix-* extensions. The app remains dark and has a Mock pill.

Where policy or the requested source of truth differs from the design:

- NOTES allows New to propose VIPs and Community to link issues in its role table. Decision 0019 wins:
  Community proposes, Contributor shapes the tree.
- NOTES models a VIP as just an issue. The requested repository-backed proposal wins: the issue links its document
  and review change. A “Draft with agent” action and “Review change” link make those required steps usable.
- The mock design omits child records from its list and supplies fixed counts. The running app derives counts from
  its complete fixture projection, so child issues are included and every filter/search count stays honest.
- The app needs an Issues navigation entry and a maximizable chat pane to reach the supplied screens (VL-17).
  Split and Link reuse the same dialog primitives because the design depicts their buttons but supplies no forms.
- A live assignee is an actual GitHub login. The fixture's display-only agent cannot be silently treated as an
  assignable GitHub account.

No new third-party runtime dependency is added. `@smthrs/integrations` is the already catalogued Smithers package
explicitly required by this lane. The Cloudflare SDK directly declares the monorepo’s existing vibelang-unplugin 0.0.12 test tool, recorded in
0008’s existing tool row as awaiting Will’s VL-5 approval. Native test children load the shipped vibelang/register.

## Verification boundaries

The contracts prove ordered observations, role gates, commitment identity/content/tree preservation, explicit
assignment, uncommit, and human review state without task commitment. Executable mutations retain unchanged
contracts and must fail Dafny obligations. Browser and scene suites exercise actual views and commands; workerd
asserts real persisted run receipts and repeated execution identity. The real GitHub suite targets only
`roninjin10/smithers-github-tests`, uses `GITHUB_TEST_TOKEN`, and states its skip reason when absent.

The bounded tree walk is proved to terminate and reject invalid issue identities. Preservation of acyclicity is
checked by 500 generated forests and attempted links; it is not claimed as a Dafny theorem.
These proofs do not prove GitHub, OAuth, the model, browser layout or transport liveness. Those boundaries have
behavioral tests. Full-app fuzz, benchmark and coverage evidence belongs to lanes 0015–0018 and must include this
feature; configured coverage thresholds are not evidence of an executed 100% suite.

## Recovery and source observations

Native planned action nodes make a failed operation inspectable and recoverable with the SDK’s `retryFrom`.
GitHub write markers hash the original repository, person, operation, request key and write name, so a recovery
execution adopts the original external write. A changed payload cannot silently replace a journaled request.
A cached receipt still requires today’s least role. A validation error releases the form only when a fresh
execution proves it never entered a potentially mutating operation. Rate-limited 403s retain their retry delay.

The browser retains a request reference in its URL while a live write is unsettled. Explicit Connect GitHub carries
only that validated operation, key and recovery ID through the person/session-bound OAuth state. On return, a read
retrieves the original typed request from that person’s native flow journal and polls its receipt. It displays a
completed receipt without writing; only an explicit Retry resumes unfinished work. An unknown recovery falls back
to its original request. No second outbox or issue store is introduced.

Additional source-of-truth departures from the static design: live reviewers come from GitHub reviews, timeline
actors from GitHub events, and dates are the observed calendar dates. They are never invented as Will or a fixed
relative age. The draft document link opens the review’s file diff because its path may not exist on main yet.
On phones, destination links scroll independently of the account controls, preserving keyboard access and menu
visibility. Role changes also feed mock sandbox admission through the shared identity service.

## VibeLang gap

`issues-nested-effect` reproduces VibeLang 0.0.12 dropping a nested effect handler’s runs inside a plain sync callback.
The independent projection review confirms it. Live chat issue bindings are held outside production until Will
authorizes the requested compiler-behavior fix and it lands through the VibeLang merge queue. No app workaround is
used. Browser actions, the real VIP drafting agent, CLI/MCP flows and fixture chat are independent of that shape.
The report names the reproduction and candidate patch. This decision does not claim the held live chat screens work.
