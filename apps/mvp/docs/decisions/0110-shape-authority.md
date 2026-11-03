# 0110: Decide shape authority before requesting a shape

Status: accepted implementation of Will's 2026-10-25 signed-out-shapes request.

Repository shape requests wait for the device session's role. A visitor may also read when the deployment repository's role answer carries an explicit public-read receipt, checked with the same policy the server applies to shapes. A receipt earned under a signed-in role does not grant anonymous access.

Issues and pulls derive access from these device records. A refused or failed shape records unavailability, never sign-in status or role. Installed receipts remain separate from authorization. The server still authorizes every request.

Library catalog entries: `@smthrs/effect-electric`, `@smthrs/effect-tanstack-db`.

TODO and prompt shapes use the same request gate, with Member authority resolved for their named repository. Public repository visibility alone does not grant stack access.

## 2026-11-03: a shape's 403 revokes

This replaces "a refused shape records unavailability" above, on Will's wipe rule (ruling by effectscript-11), after Astra found that a Member who lost access kept reading cached TODOs: their role row said allowed, and navigation reused it.

One owner decides that a repository refused this person: `RepoStore` (`refuse`, `registerCache`). A 403 from any repository shape or the role read writes a durable mark (`repo-refusals`). Every tab reads the mark and every later load does too, before any of the repository's caches opens, so nothing paints first and a lost message loses nothing. Every shape stops at its gate and requests in flight abort. Each cache registered with the owner drops what it holds, opening first if no page had, and runs again on each load while the mark stands; a test holds `src/device/repoStores.ts`, the device registry, the app's registrations and the source's collections to each other. A role read sent before a refusal says nothing after it (`fenceOf`). One sent after clears the mark only if it grants reading: a role, or a public read (`readable`). `own` says the repository is the deployment's own and grants nothing. Access that came back syncs from the start. A proxy answers Electric's own 401 or 403 as 503, so an outward 403 is only ever the host's decision. Under a bad deploy this costs a re-sync, and drafts stay.

A 401 evicts nothing, whether from a shape or the role read: a bad deploy answering 401 everywhere must not clear every device. It stops the shape and asks the tab to check the session (`AuthStore.askCheck`). Only a session confirmed ended wipes (`wipeStatusOf`).

A refusal outlasts a session that can't answer. Stack, TODO and home stack blocks show private rows only with `allowed`, or `syncing` while the first sync lands. Their `unknown` shows nothing private and offers Try again. Issue and pull pages paint a cached row while a session check is pending and while the network is down. When ChatApi answered and couldn't verify the session (`unverified`), they show no private row and offer Try again. A public-read receipt shows regardless. A repository the person holds a role on counts as private, because the device can't tell otherwise.

The person's drafts and unsent writes stay. A queued write is sent, the route refuses it, and it reads Not sent with Discard.

A tab that watches another tab's writes asks that tab to evict, through the coordinator, and evicts itself if it comes to write first. The details of issues read on an earlier load go too: the store lists them from TanStack DB's private `collection_registry` (`Persistence.collections`). If that table can't be read or changed shape, the listing fails, the store reports it (`smithers_issue_access_details_unlisted`), and those rows stay at rest with nothing rendering them: the mark stands, opening one evicts it first, and the next load tries again. The fleet's shapes are memory only and role-tiered: a 403 on one drops its own rows and stops it, and says nothing of the repository. A 401 stops it and asks the session. A session check that confirms someone, or a role read that answers, starts it again.

### The data gate

The guarantee lives in the data layer, not at routes or components: five review rounds found a leak in each surface someone forgot to gate. `RepoStore` keeps `repo-visible`, one row per repository this tab holds rows of, with `show` set from `repoVisibility(session, roleRow)` (`src/features/repo/visibility.ts`). Its rows change in the same synchronous change that moves the session or a role row, a refusal mark included. A role answer that grants nothing (no role, and no public read) hides the repository as a refusal does, with or without a mark, but wipes nothing: only a 403 wipes. An unanswered role, or one whose read failed, still shows. So the role route never answers `readable: false` for a check that couldn't decide (Postgres or GitHub not answering, a metadata 404 or 410): it answers 503 `unavailable` with a wait, which the client records as a failed read. A session a reached server couldn't verify stays hidden until a session answer: a later network failure doesn't end it. Every visibility row is closed until the device's stored refusal marks are applied (`refusalsKnown`), so a cold load shows no restored row first; `repo.refusals.known` logs how long that took (18 to 24 ms with one mark, on the test machine).

Every repository-scoped store exposes its rows only through live queries built on `RepoStore.gate(raw)` (`src/features/repo/gate.ts`), which inner-joins the rows to `repo-visible` on `repoId` where `show`. TanStack DB re-evaluates the join on any change, so a refusal or an unverified session drops the rows from every joined query before any wipe runs, whatever component reads them. Synced rows carry their `repoId`. Local rows get one at write: repository trees, files, refs, abouts, heads and embeds, docs, homes and their files, comparisons, a branch's pull request title, and run pages, which take their inspection's root run's repository and hide when it is unknown. A conversation's rows (its messages, its views, its runs' waits) join `ConversationOwners` (`my-conversations`, `src/features/conversations/owners.ts`) to their conversation's repository; the runs shape carries `conversation_id` for that. A row with no repository joins nothing and never shows. The home conversation is the person's own by who they are: it shows by the session answer's `homeConversationId`, kept on the device with the confirmed session (`auth-confirmed` v3) so a reload offline shows it too. Any other conversation shows only through a `my-conversations` row whose repository shows, and the conversation list goes through the same join, so a refused repository's conversations leave it, repository and branch names included. A repository's own row (`repo-repositories`) is gated by its `id`, file tabs by the repository they name (`file-tabs` v2), branch statuses and the home's live run blocks by their run's conversation, and a run's transcript by its run's page, only one holding its read.

A narrower shape's 403 (a TODO stack, feeds, domains) is a tier refusal: the person may still read the repository. It never marks the repository. That shape's rows go and its requests wait until the tab's next role answer, which the next route asks for.

Raw collections stay inside their stores and the feature modules that write them. `src/device/dataGate.test.ts` checks one thing with the type checker: no other module reads a raw collection whose rows name a repository. A raw collection read elsewhere is the person's own: declared there, and its row type must name no repository.

The route gate (`repoGated`, `RepoGate`) stays for the page's states: Sign in, and Can't check with Try again. The wipes, fences, source gates and the durable mark stay as cleanup and bandwidth.

## W9 follow-up: repository actions

Repository flow runs remain Member-only, including on a public repository (actions feature and decision 0012).
The actions shape waits for a signed-in Member, Maintainer or Admin on its named repository. An absent authority
store fails closed. The deployment's session role applies only to its own repository; a public-read receipt does
not grant access to runs. The browser uses the catalog's `@smthrs/effect-electric` `ShapeSource.gated`.


## Local writes precede display initialization

Draft persistence and the outbox are independent of repository visibility. `ChatWrites` initializes them below `RepoStore`, `ConversationOwners` and `ViewsStore`; `ChatStore` composes the read side above those services. A queued question's delivery confirmation awaits the read side separately, without holding outbox initialization. The gate still starts closed and no displayed repository row bypasses it. Draft restoration failure retains the existing persistence diagnostic rather than preventing the whole app from opening.

`drafts.test.ts` observes real persistence and outbox initialization to require both before repository restoration starts. Its offline save/reload deadline remains one second. `chat.writes.ready` records the independent startup boundary using elapsed wall time.


### Review corrections: refusal events and system reads (2026-11-03)

A failed restoration of `repo-refusals` never establishes knowledge: the data gate stays closed and records `repo.refusals.unavailable`. Local drafts and the outbox still initialize. Reload may retry storage; a failed read never grants access. A role read answered 401 preserves an earlier authoritative denial while the session check runs or is unreachable.

Every refusal is a separate persisted event, keyed independently from its repository. A role request snapshots the events it observed; an affirmative answer clears only those events, and a newer event fences the answer. Another tab's repeated 403 therefore cannot disappear behind an older grant. Version 2 of the local refusal store migrates each version 1 mark without changing its denial.

A successful remote system-run inspection may show without a repository only when the server's authorized cloud list explicitly identifies that run as an allowed repository-free kind. The page and expanded details carry this attribution; unknown remote runs remain hidden. Local engine reads keep their existing personal attribution.


A refusal event is protected in memory before its insert begins. Protection is tracked per event and survives rollback, timeout and interruption; one successful write cannot unprotect a different failed event. An affirmative read may clear only the protected and persisted event identities that it observed.

Comparison cache keys contain the repository and both SHAs. Each request also owns a unique row identity, and both success and failure completion check that identity and the repository's refusal fence. A late response cannot populate another repository's comparison or a replacement read after a wipe.

Branch Compare registers its cache for repository cleanup too. Refusal removes pending comparisons, so a later affirmative grant can read them again; a fenced late answer never reinstates the old loading row. The regression uses the actual PublishStore.

Branch conversation display gates queued and unsent local questions through ConversationOwners as well as synced messages. Their raw rows remain available to delivery and recovery. Home status and latest-answer queries use the same gated home messages as chat, so removing attribution hides both synchronously. Personal home writes with no branch identifier remain local to the person.

The same ownership gate covers pending branch pins, including their text and failure-state query. Raw pin intents stay durable for delivery; personal home intents remain local.

Ordered queries can otherwise retain a settled snapshot while repairing an underfilled source window, including rows the access gate has already withdrawn. The app supplies `LiveQuery.incremental` to its entire query graph. This SDK policy publishes the graph’s current rows through pending refills; query readiness and window completion remain separate receipts. A minimal reproduction and SDK regression hold a source unready, withdraw access, and inspect the sorted projection in the same Effect. The existing TanStack DB catalog entry is used; a pinned dependency patch supplies the opt-in mode without changing other consumers’ default behavior.

A successful branch-opening response also proves the conversation-to-repository relation. ConversationOwners reads the existing durable branch route cache alongside the synced list, so queued text remains attributable offline before Electric delivers the list row. This cache never grants repository access; refusal and unavailable refusal restoration still close the same gate. Tests that directly create server conversations wait for their ownership receipt before expecting client rows.

Cold-start storage must not serialize draft saves behind schema autocommits. The pinned SQLite adapter uses its existing transactional batch capability for bootstrap DDL, falling back to its existing batch behavior only on drivers without that capability. A failed collection bootstrap rolls back its new tables and remains retryable on a later open. ChatWrites still initializes drafts and the outbox before read stores.
