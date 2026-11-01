# TODO

Open work for the app. An item is done when its last box is ticked and a test proves it.

## Auth, designed on purpose and later

Will, 2026-10-19: auth gets designed later, deliberately, so one design serves every feature, every client (web, TUI, CLI) and every host. Don't bolt it onto one endpoint before then.

Meanwhile:
- Signed-out people browse freely: the app is also our GitHub front page and our docs.
- Asking Smithers needs sign-in (Will, 2026-10-19, may revisit; [rulings](rulings.md) AUTH-2). A signed-out person's data stays in their browser and is never synced; features that can't run browser-first are disabled until sign-in (AUTH-3). Sign-in (decision 0008, phase 1) is built and deployed ([sign-in.md](features/sign-in.md)): the model endpoint and `POST /api/questions` refuse a signed-out call (`401`), and the composer gives way to "Sign in to ask Smithers." Still open: the items under [Not built yet](features/sign-in.md#not-built-yet).
- Some features will need sign-in and others won't, and the design decides which.
- Abuse is caught by alerts on token spend, not by gates (next item).

When the design happens, it must cover:
- [ ] One identity across web, TUI and CLI, through GitHub sign-in (the product's sign-in, M-46).
- [ ] Which features are open, which need sign-in, and how a signed-out visitor's conversation carries over after sign-in.
- [ ] Conversations owned by a person or a team. ChatApi sets the conversation on the server, in each ask and in the shape's `where`, never from the browser.
- [ ] Per-person and per-network admission limits, plus a deployment-wide model budget, before any model call. The deployment-wide daily budget is built (`MODEL_DAILY_TOKEN_BUDGET`, [model-endpoint.md](features/model-endpoint.md#budget)); the per-person and per-network limits wait for sign-in.
- [ ] `/api/telemetry` bound to a session or a signed visitor id, with inbound `traceparent` trusted only from known clients.
- [ ] End-to-end tests for both signed-out and signed-in use, and for isolation between people.

## Alerts on token spend

Signed-out use is open, so heavy token spend must reach a person quickly.
- [x] A metric for tokens by model: `smithers_model_tokens`, by `role`, `model` and `type`, from every call the model endpoint serves ([model-endpoint.md](features/model-endpoint.md#budget)). Per minute and per hour are queries over it.
- [x] An alert that reaches Will on any model spend at all, since there are no users yet (Will, 2026-10-19), at most once per `MODEL_SPEND_ALERT_WINDOW` (15 minutes), with tokens and estimated cost by role. Built and tested ([spend-alerts.md](features/spend-alerts.md)): `ops/SpendAlert` records it and every Admin's devices show it as a toast. `alchemy dev` turns it off; a deploy has it on.
- [x] Where else the alert reaches Will: email and Telegram, configurable (Will, 2026-10-20). Built and tested ([spend-alerts.md](features/spend-alerts.md#channels)): an Admin sets email addresses and a Telegram chat in Settings; `ops/SpendAlert` sends to each through `@smthrs/notifications`' `Channels` and records a receipt. Telegram needs `ALERT_TELEGRAM_BOT_TOKEN` and email `ALERT_EMAIL_API_KEY`. Will adds his own Telegram chat in Settings when he wants to; don't ask or remind him ([rulings](rulings.md) AUTH-4). The Code Storage alert's delivery is still open (below).
- [ ] Thresholds as usage grows: alerts at 50%, 80% and 100% of the day's budget. Each alert already carries today's tokens and the budget.
- [ ] An alert for a window whose only spend is a server flow's own calls (triage): they're carried by the next alert a served call starts.
- [ ] A documented way to act: lower the budget, block a network, or pause asking. Lowering the budget and changing a role's model are documented ([spend-alerts.md](features/spend-alerts.md#acting-on-an-alert)); blocking a network and pausing asking aren't built.
- [ ] Code Storage spend, as [decision 0006's Capacity and spend](decisions/0006-repo-clone-and-view.md#capacity-and-spend) says. Built and tested ([repo.md](features/repo.md#spend)): the budgets as `Config`, admission in `repo/Inspect`, the `code_storage_usage` meter, and `repo.spend.alert` at 50%, 80% and 100% of `REPO_BUDGET_USD`, once a month each. Open: delivering that line to Will with the token-spend alert, and the `repo/SetImports` switch as a flow.

## A size limit for the on-device conversation

Each device stores its whole conversation ([decision 0002](decisions/0002-local-first.md)). Long conversations will hit browser storage limits. Will's model (2026-10-20, [rulings](rulings.md) ARCH-18): each device always keeps a subset of the database, plus an LRU cache for other data.
- [ ] Cap the on-device store, evicting the least recently used conversations or older pages, and refetch them on demand.

## Sandbox budgets, before we ship

Will, 2026-10-19: decide these before shipping, not now ([decision 0005](decisions/0005-sandboxes-secrets-and-the-forge.md), question 3; [rulings](rulings.md) AUTH-5). Each limit is an admin setting, changed without a deploy.
- [ ] Awake sandboxes per deployment (proposed 20) and per person (proposed 2). Past a limit, a request waits for a slot and says so.
- [ ] A sandbox spend alert to Will (proposed $100 a month), beside the model-spend alert.
- [ ] Keep snapshots only for branches touched recently (proposed 30 days).

## The self-hosted install, after ship

Will, 2026-10-20: "Built for hosted only now yes cut scope in that way." ([rulings](rulings.md) SCOPE-8.) The app targets the hosted deployment only ([decision 0010](decisions/0010-web-first-desktop-later.md#hosted-only-will-2026-10-20), [self-hosted install](work/self-host-install.md)).
- [ ] The self-hosted install, after ship: one Apple Silicon Mac, a local Layer for each hosted service (flows, Postgres and Electric, the git store, sandboxes) and a setup flow.
