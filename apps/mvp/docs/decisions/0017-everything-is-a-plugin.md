# 0017: Everything is a plugin: a core of primitives, one manifest, and our features as plugins

Status: approved by Will 17:03; Astra and Fable reviews applied; ready to build slice 0. Designed by panel P (Opus, Fable, Sol and Astra) and merged 2026-10-20. Will's words at approval (2026-10-20 17:03): "Looks good but you should have fable and astra review this one extra time". His answers to the three open questions changed the design; they are [below](#wills-answers-2026-10-20-1703). The [review fixes](#review-fixes-astra-and-fable-2026-10-20) record every finding of Astra's and Fable's extra reviews. Fable's verdict: ready to build slices 0 and 1 once the host-owned action contract and the credential-run rule were written in, which they now are. Slice 0's run credentials are built ([sign-in.md](../features/sign-in.md#run-credentials)); its confirmation receipts and the host's confirm dialog are not. Slice 1 is built ([plugins.md](../features/plugins.md)): `@smthrs/plugin`'s `Manifest`, `Load` and `PluginHost`, the app's host in `src/plugins/`, and `needs-you` under decision 0022's name `queue` (`plugins/queue/`). Not yet in it: inline views, the deletion test in CI, the boot-time budget measured live, offline and two-device e2e cases. The strip's note is kept on the device per item; its Sending state is not kept through a reload.

It answers rulings PLUGIN-1 to PLUGIN-3 ([rulings](../rulings.md#0-everything-is-a-plugin-strong-rule)) and mvp.md M-55, and binds to FLOW-1 to FLOW-3, DUR-1 to DUR-7, SDK-1, SDK-11, FE-9, M-30, M-45, M-47, M-49, M-52 and M-56. It builds on decisions [0003](0003-flows-and-the-agent.md) (the registry and parity), [0004](0004-agent-ui-codemode-and-rendering.md) (the views realm and frame), [0005](0005-sandboxes-secrets-and-the-forge.md) (sandboxes and the egress), [0007](0007-roles-and-tags.md) (roles), [0008](0008-auth.md) (actors and sessions), [0009](0009-notifications-and-live-work.md) (notifications), [0011](0011-the-agent-runs-in-the-browser.md) (placement), [0012](0012-git-end-to-end.md) (triage's Decide), [0014](0014-flows-authoring-debugging-and-home-view.md) (activation receipts) and [0015](0015-agent-status.md) (waits and `run/answer`). Priority P2: it runs beside the release and never blocks it.

The review page is [design/plugins/plugins.html](../design/plugins/plugins.html).

**In one sentence:** the app becomes a short, named list of core primitives plus plugins, our own features included; every plugin is a `plugin.json` manifest that binds `Flow.make` flows to declared contribution points; and everything that isn't compiled into the app runs in a sandbox: plugin and flow code in the QuickJS realm, React apps in a sandboxed frame, and code that needs a machine in a container.

## Will's answers (2026-10-20 17:03)

| # | The question | Will's answer, verbatim | What it changed |
|---|---|---|---|
| 1 | May built-in plugins draw with React, or must they use the views realm? | Option 1, and broader: "they should be able to make arbitrary react based apps that are embedded in chat or can be full screened this is extremely important functionality just like how agent itself can directly do this" | Every plugin, not only built-ins, can ship an arbitrary React app, inline in chat or full screen. A plugin that isn't compiled in runs its app in a sandboxed frame with a typed bridge to flows, never in the app's realm. The agent gets the same ability. This overrides the panel's unanimous "no plugin JavaScript in a frame with a bridge" ([Custom UIs](#custom-uis-and-trust-tiers)). |
| 2 | May repository or personal code run in a QuickJS realm, or only in a sandbox? | "The question makes no sense to me quickjs is a sandbox" | The trust tiers are rewritten in sandbox terms. The QuickJS realm is a sandbox, and repository and personal plugin and flow code runs there, hand-edited personal flows included (today they fail `FlowNeedsSandbox`). Containers are only for code that needs a machine. Sandboxed frames are for React apps. Nothing runs in the app's own realm unless it is compiled in. Fable's `RealmFlowHost` is adopted ([Flows](#flows)). |
| 3 | Is the queue a product feature for every person, or a maintainer tool? | "Everything in the maintainer tool is dogfooded and we will be adding it to the product itself after it's really high quality but yes I like this feature it will very likely end up as a workflow that can be ran on top of other workflows specifically ones that are doing coding work or some other type" | "A flow that runs over other flows" becomes a first-class capability ([Flows over flows](#flows-over-flows)), and the queue's product version is one: a flow over coding flows that collects their waits and asks the person. Slice 1 stays small: the queue as a view of waits, dogfooded until it is high quality. |

## Decision

1. **A small core; everything else is a plugin.** The app is a fixed list of primitives ([The core](#the-core)) plus plugins. Every other feature, Smithers' own included, is a plugin on the one public interface. The core lists its built-in plugins in one place, as webpack lists its internal plugins, and names no plugin anywhere else.
2. **One interface, in the SDK package we already have.** A plugin is a folder with a `plugin.json` manifest, decoded by `Plugin.Manifest`, an Effect Schema in `@smthrs/plugin`. The framework-free loader (decode, check, order, fold) and the host contract a plugin's UI reads through (`PluginHost`) live there too; the app keeps only its React adapters. No new package. The registry's `pack.json` moves onto the same manifest later, by a lossless migration (slice 7).
3. **The manifest is data.** The host reads, checks and shows a manifest without running plugin code. The trust tier is not a field: the loader sets it from where the plugin came from. Excess fields, an unknown `apiVersion`, an unsupported contribution point and an unresolvable schema reference refuse the plugin with a named reason.
4. **Behaviour is flows, and every dispatch carries who asked.** Every contribution that acts names a `Flow.make` flow. Every dispatch carries an invocation context the server mints and attenuates: the person, who acts for them (agent, flow, app), the plugin installation and revision, the repository, the caller chain and the effective ceiling ([Security](#security-and-authority)).
5. **Config binds; code composes.** The manifest binds flows to commands, keys, view events, slots, cards, settings, triggers and hooks. It never declares steps, branches or loops (no second graph model). A prompt flow is a code flow (M-56).
6. **Hooks are typed seams with declared semantics and failure rules.** A hook is `collect`, `select`, `narrow`, `guard` or `observe`; each says how taps combine and what a failure or timeout does. A `guard` fails closed. Every acting tap is a durable child run with a replay-stable id.
7. **Everything not compiled in runs in a sandbox.** Plugin and flow code from a repository, a person or the agent runs in the QuickJS realm; a React app runs in a sandboxed frame; code that needs a machine runs in a container. Only code compiled into the build runs in the app's realm, and it is trusted application code: import rules keep it tidy, but they don't contain it. Placement stays local first, remote by need (DUR-5).
8. **Four renderers.** *Blocks* (data the host draws) and *views* (TSX rendered in the QuickJS realm) for every plugin and the agent; *apps* (arbitrary React in a sandboxed frame with a typed bridge) for every plugin and the agent; *components* (React in the app's realm) only for plugins compiled into the build. Every plugin UI lives in the chat shell, inline or full screen (FE-9).
9. **Authority is an intersection, and person-only acts need a person.** A plugin's flow acts with the manifest's ceiling ∩ the flow's `capabilities` ∩ the invocation's ceiling ∩ the person's grants ∩ the tier's cap. Every run except a person's root dispatch of a person's flow gets a server-minted run credential whose `act` the server sets from the registry, so agents, flows and apps never use the person's session, and every route the registry marks person-only refuses them. A person-only action in any plugin UI is drawn and keyed by the host's action strip, never by plugin code.
10. **A merge activates; an Admin grants each secret to each plugin.** `plugin/refresh` activates an immutable installation snapshot at `main`'s new head. A secret or a network origin a plugin names needs an Admin's grant to that plugin installation; a merge never grants one, and another plugin's grant never carries over.
11. **Versions are checked, pinned and additive.** `requires.api` and `requires.plugins` use `Pack.compatible`'s stated range grammar over release-only versions. A run pins its installation snapshot. A hook changes only by addition.
12. **Flows can run over other flows.** A flow may observe other runs in its scope (start, wait, settle), read them, and start, cancel or retry runs it is granted. It never answers another run's question for a person. The product queue is such a flow.
13. **The decision queue proves it first, small.** Slice 1 is `needs-you`, a compiled plugin that shows the waits addressed to you and answers them with `run/answer`. It adds no table. It ships to production only after the run credential (slice 0).

## Why

**Will, 2026-10-20 14:40:** "The app should be declared via flow configs and custom uis into the app that mostly just supports primitives. It's very important that we similar to webpack try to treat everything like a plugin." Webpack's own words: "Webpack itself is built on the same plugin system that you use in your webpack configuration!" ([webpack concepts](https://webpack.js.org/concepts/plugins/)). A core that uses its own public interface can't let that interface rot.

**Today every feature is wired by hand into central lists** (checked 2026-10-20):

| Central list | Where | What it holds |
|---|---|---|
| The flow registry | `apps/mvp/src/flows/registry.ts:86-233` | 51 flows, each listed by hand, with 19 imports from `features/` (`:1-37`) |
| The declarations | `apps/mvp/src/flows/declarations.ts:47` | the same names again, with bodies |
| The engine registrations | `apps/mvp/src/flows/registrations.ts:65-84` | 17 feature layers in one `Layer.mergeAll` |
| The app layer | `apps/mvp/src/boot.ts:137` | every feature's stores and layers, ordered by hand |
| The providers | `apps/mvp/src/main.tsx:147-192` | 17 nested React providers |
| The router | `apps/mvp/src/router.tsx:41-51`, `:276` | one context field per feature and a fixed route tree |
| The header | `apps/mvp/src/screens/app/AppShell.tsx:18-30` | links and pills placed by hand |
| Telemetry | `apps/mvp/src/telemetry.ts:1-30` | 23 imports |
| Card kinds | `apps/mvp/src/features/views/contract.ts:18` | `["webpage", "link"]` |
| Remote flows | `apps/mvp/worker/ExecutionHost.ts:46`, `:62`, `:116` | each remote flow merged by hand |

None of these can be extended by a repository. M-47 already requires repositories to customize notifications, triage and issue transitions, so the seams are needed anyway, and a seam added after a feature exists means rewriting the feature.

**The parts already exist in the SDK, unconnected, and two need extending:**
- `@smthrs/plugin` is "a typed, bounded plugin kernel for Effect programs: Vite's plugin model, with hooks that are ordinary Effects" (its README), on every platform (`docs/libraries.md:191`). It has ordering, conditional inclusion, layers and typed hooks (`src/Plugin.ts:38-56`) and `Kernel.make`, which merges plugin layers in resolved order (`src/Kernel.ts:99-119`). Its hook kinds don't yet do what plugins need: `parallel` runs every handler and discards the results (`src/Plugins.ts:113-118`, `:152-164`), and `first` picks the first handler in order that answers. `collect` and explicit selection are SDK additions (Astra, finding 6).
- `@smthrs/registry`'s `Pack` has a manifest, a content digest and a range check (`packages/smithers/agent/registry/src/Pack.ts:113-119`, `:260`, `:429`). Its digest covers only name, version, flows, skills and `requires.smithers` (`:260-281`), and its range grammar is a stated subset of semver that strips prerelease suffixes (`:306-315`, `:410-433`). Both are reused with those limits stated.
- `Flow.make` declares `capabilities`, `effects` and `modelInvocable` as literals so a catalog reads a flow's authority without importing it (`packages/smithers/flows/flow/src/Flow/make.ts:46-86`), and `ModuleMetadata` projects a flow's schemas from source without running it.
- `.smithers/home.json` is UI as data (`packages/smithers/ui/views/src/Home.ts:247-256`), and `@smthrs/views` renders untrusted TSX in a bounded QuickJS realm (0004 §4-7).
- `apps/mvp/worker/github/Triage.ts:154` says: "A repository's own flow replaces this step, never the writes." That is a seam with a system boundary.
- `Actor` already has an `act` field for "an agent, flow or sandbox" acting for a person (`apps/mvp/worker/Actor.ts:20`), but sign-in never sets it, so the browser agent's calls carry the person's cookie and look like the person (the lead's trust note; `worker/Runs.ts:248-255` checks only the session and role). Slice 0 closes that gap.

**Lessons:**
- The old app had a plugin seam with the right rule, "every rail entry names a REGISTERED flow" (`apps/app/src/mainview/plugins/AppPlugin.ts:14-17`). Only its own test imports it, so it died. A plugin interface needs a real feature on it from day one.
- Obsidian: "Obsidian cannot reliably restrict plugins to specific permissions or access levels" ([plugin security](https://obsidian.md/help/plugin-security)). That is why nothing from outside the build runs in the app's realm.
- The old app found that a frame "can navigate itself" (`apps/app/src/mainview/cards/RunResult.tsx:17`). Apps in frames are now allowed (Will's answer 1), so the design bounds what a frame is given and stops a frame that navigates.

**The strongest case against:** "ship features hardcoded now and add a plugin API after the release." It is faster this week. It loses on three counts: each new feature already costs about ten central edits; M-47's seams must exist regardless; and an interface our own code doesn't use goes stale, as `AppPlugin` did. The cost here is paid in small steps at P2.

## The core

The core is what a plugin can't replace without breaking trust, consistency or boot.

| # | Primitive | What it owns | Today | Why it can't be a plugin |
|---|---|---|---|---|
| 1 | Plugin host | Decoding, checking, ordering and folding manifests; refusals; the built-in list; installation snapshots; disable and pause; `PluginHost` | new: `@smthrs/plugin`, `apps/mvp/src/plugins/` | Something has to load the loader |
| 2 | Flows and dispatch | `FlowDispatch`, the browser engine, `FlowExecution`, the QuickJS realm flow host, containers, placement, the invocation context | `src/flows/dispatch.ts:143`; `worker/ExecutionHost.ts`; `worker/Executions.ts` | Every plugin runs on it |
| 3 | The flow catalog | One catalog across plugins and its laws: agent parity, `userOnlyReason`, unique names, flow ownership | `src/flows/registry.ts`, `registry.test.ts`, `catalog.ts` | A plugin can't decide whether the agent may run another plugin's flow |
| 4 | Runs | The `runs` index, waits and the `waits` projection, `run/answer`, `run/deliver`, cancel, retry, resume, run events for flows over flows | 0009, 0015 (`src/features/status/flows.ts:167`) | Every plugin's runs and answers go through it |
| 5 | Identity | Sign-in, sessions, sign-out wipe, run credentials, confirmation receipts | `worker/SignIn.ts`, `worker/Actor.ts`, `src/wipe.ts`, 0008 | A plugin or the agent could impersonate the person |
| 6 | Access | Roles, `Access.decide`, `Authorize`, shape authorization, plugin grants | 0007 §3, `@smthrs/effect-electric`'s `ShapeProxy` (`worker/Chat.ts:155`) | A plugin could grant itself access |
| 7 | Sync and data | Electric, TanStack DB, the outbox, plugin records | `src/outbox.ts`, 0001, 0002 | One device store and one outbox per device |
| 8 | Shell, router and slots | TanStack Router, the `/app/*` and GitHub URL grammar (M-45), the chat shell, slot names, error boundaries, the recovery screen | `src/router.tsx`, `src/screens/app/AppShell.tsx` | Something owns the frame; a failed plugin must never block sign-out or disabling it |
| 9 | Commands and keys | The slash menu, the palette, the keymap, `when` clauses, conflicts | `src/features/commands/catalog.ts:27-45` | Two plugins binding one key need one judge |
| 10 | UI kit and sandboxes for UI | `@smthrs/ui`, the block renderer, the QuickJS presentation realm, the app frame runtime and its bridge | `packages/smithers/ui`, `ui/views/src/Home.ts`, `Bridge.ts` | Visual consistency and isolation |
| 11 | Attention | Notification rows, mandatory delivery, the one toast stack | `src/features/attention`, 0009 | One stack ("Instant chat"); policy is a hook |
| 12 | Models | `ModelStep`, `/api/model/<role>`, role routing, budgets, spend alerts | `worker/ModelEndpoint.ts`, `worker/ModelRoles.ts` | Keys and money |
| 13 | Secrets | The vault and the egress | `worker/secrets/`, 0005 §4 | Secret opacity (M-47) |
| 14 | System flows | Merge, members, settings, secrets, plugin grants, stack writes, `issue/ApplyTriage`, GitHub writes, auth, branch access grants, plugin activation | `worker/github/Triage.ts`, `worker/stack/Stack.ts`, M-30 | People merge; system flows can't be overridden |
| 15 | Telemetry | The relay, its content-free allowlist, per-plugin names | `src/telemetry.ts`, `src/flows/contract.ts:11` | Content must never leak (OBS-5) |
| 16 | Host services | Theme mode, `app/navigate`, the clipboard | `src/features/theme`, `src/features/navigation`, `src/clipboard.ts` | They are the platform the kit wraps |

**Every current feature, as a first-party plugin:**

| Plugin | Comes from | Contributes | Stays core |
|---|---|---|---|
| `agent` | `features/agent`, `features/chat` | `chat/Answer`, `chat/Close`, `chat/copy`, `chat/edit`; the conversation view; the default tap on `composer/submit`; model role `agent` | the composer and slash parsing |
| `repo` | `features/repo`, `@smthrs/repo-view` | `repo/*`; tree, blob and raw views; the default tap on `repo/home` | the URL grammar |
| `home` | `features/home` | taps `repo/home` with the sections in `.smithers/home.json`; Smithers' curated homes (`worker/home/curated/`, 2026-10-20) become first-party plugins' `repo/home` taps when the plugin host lands | the block renderer |
| `issues` | `features/issues` | `issue/create`, `issue/comment`; issue views; owns `issue/transition` | GitHub writes |
| `triage` | `features/issues` (triage), `worker/github/Triage.ts` (Decide) | `issue/triage`, `triage/*`; owns `triage/decide`, whose default is the Classifier | `issue/ApplyTriage` |
| `todos` | `features/todos`, `screens/stack` | `todo/draft`, `todo/commit`, `todo/drop`; the stack view; owns `todo/flow` | the stack's writer |
| `branch` | `features/branch`, `terminal`, `sandbox`, `presence`, `sharing` | `branch/track`, `terminal/open`, `sandbox/*`; the workspace view; `branch.pane` entries | `branch/share` |
| `flows` | `features/flows-ui`, `screens/flows` | `flow/*`; the flow views | the catalog |
| `runs` | `features/runs`, `screens/runs` | the run list and run views; Cancel, Retry, Resume as commands | the run index and acts |
| `web` | `features/web` | `app/web/open`; card kinds `web/page`, `web/link` | |
| `jev` | `features/jev` | `app/jev/*`; model role `judge` | |
| `notifications` | `features/attention` (watches) | `watch/set`; the feed view; watch settings | rows, delivery, toasts, ack |
| `spend` | `features/spend` | the usage view | budgets and alerts |
| `secrets` | the Secrets card | the card (names only) | `secret/Put`, `secret/Delete`, grants |
| `needs-you` | the maintainer queue | the queue view and its keys; later the queue flow over flows and the hook `needs-you/item-kind` | |
| `review-media`, `review-code` | the maintainer GIF and code-slice review | item kinds `evidence` and `code` | |
| `work` | the maintainer work board | a repository plugin in `smithersai/smithers`, config only | |
| *(implicit)* | `.smithers/flows/`, `.smithers/home.json` | the repository's unclaimed flows and its home | |

A repository needs no manifest to keep its flows or its home: `.smithers/flows/` and `.smithers/home.json` form its implicit plugin, which owns every flow no declared plugin claims. Sign-in, the launcher at `/` and the plugin settings page stay in the core.

**The deletion test.** It runs in CI and fails the build. It proves only what it says:
- **Per plugin:** delete a *whole* plugin's folder and its line in each built-in list; typecheck, `pnpm test` and every other plugin's e2e suite pass. It applies to a feature only once its conversion is complete, so a plugin that owns only some of its feature never claims it (Astra, finding 13).
- **All at once:** boot with `plugins: []` and with each slice's chosen set. The shell renders, sign-in and sign-out work, `/` and `/app` load, the plugin settings page lists what is loaded, the composer offers only core commands, and the catalog laws hold.
- **ImportRules:** no core file imports `plugins/**` except the built-in lists, and a compiled plugin imports only `@smthrs/*` roots, `react`, `@tanstack/react-db` (its live-query binding, `docs/state.md` rule 5) and its own folder. This is hygiene, not containment: compiled code runs with the app's full power, and its boundary is code review and the build.
- **No feature nouns in the core:** a core table, route or `switch` on a plugin's kind (`kind === "decision"`) fails review and a Jev rubric (Astra).
- **Parity:** the public interface is proved only when a feature a compiled plugin draws also runs from a plugin that isn't compiled in, through the frame bridge alone (slice 3's gate).

**What stays hardcoded, and why:**
- **Boot and the Effect boundary** (`src/boot.ts` `start`, `src/main.tsx`): one program boundary (SDK-7).
- **The built-in lists** (`src/plugins/builtin.ts` for the tab, `builtin.engine.ts` for the engine worker and the Worker): two lists because the tab never loads flow bodies (`src/flows/declarations.ts:40-44`). This is webpack's `WebpackOptionsApply`.
- **The shell's frame and its slot names:** a slot name is a promise to every plugin.
- **The person-only acts, the system flows and the confirmation surface:** no plugin changes them, and a protected confirmation draws only in host UI, never in plugin markup or a frame.

## The plugin interface

### Where it lives

- **`@smthrs/plugin` gains `Manifest.ts`, `Contribution.ts`, `Load.ts` and `Host.ts`.** They are framework-free and run in a browser, a Worker, Node and Bun. `Load` decodes, checks, orders and folds manifests into one `Contributions` value with typed refusals (Fable's fold, in the SDK so the TUI reuses it: ARCH-8, SDK-10). `Host.ts` declares `PluginHost`, the contract a plugin's UI reads and dispatches through. The kernel gains a result-preserving `collect` kind; explicit selection is resolved by `Load`, never by handler order.
- **The app's adapters live in `apps/mvp/src/plugins/`:** the built-in lists, the `PluginHost` implementation, `<Slot>`, the view host, the app frame host and the keymap wired into TanStack Router. React stays the view (FE-5).
- **`@smthrs/views` gains the app frame:** the frame document, its CSP, and the bridge host for apps (0004's frame, extended). `@smthrs/ui` supplies the frame's React and kit bundle, as it supplies the presentation bundle today.
- **The QuickJS realm flow host** (Fable's `RealmFlowHost`) is SDK work beside the presentation realm, platform-neutral, so the browser engine and the Worker both drive it.
- **Built-in plugins live in `apps/mvp/plugins/<id>/`.** **Repository plugins** live in `.smithers/plugins/<id>/`, and the flows they own in `.smithers/flows/<name>/` (M-49).

```
apps/mvp/plugins/needs-you/          a built-in plugin
  plugin.json                        the manifest: data, read without running code
  src/tab.ts                         exports `tab`: a Layer from PluginHost to { queries, actions }   (compiled in)
  src/components/*.tsx               React over { queries, actions }; imports the kit, @smthrs/ui, this folder
  e2e/needs-you.spec.ts

.smithers/plugins/work/              a repository plugin
  plugin.json   app/index.tsx (a React app for the frame)   views/*.tsx (realm views)
.smithers/flows/<name>/flow.ts       flows it owns, named in `owns` (M-49)
```

### The host contract

Astra found that the merged design had no public way for the queue to get its data or dispatch its answers (finding 5); Fable found that a sandboxed UI still couldn't perform the person-only act it exists for (finding 1). This is the contract that answers both, the minimum slice 1 needs:

```ts
// packages/smithers/agent/plugin/src/Host.ts: framework-free; the app implements it
export interface PluginHost {
  /** Rows of a query the contribution declared in `reads`, scoped by the host to the viewer and the plugin. */
  readonly query: <R>(name: QueryRef) => Effect.Effect<Live<R>, PluginRefused>
  /** The item the person is looking at: the host's action strip acts on it. Must be a row of the view's `reads`. */
  readonly select: (item: ItemRef) => Effect.Effect<void, PluginRefused>
  /** Prefill an event's fields in the action strip (a note, a chosen option). Nothing runs until the person presses. */
  readonly propose: (event: EventRef, fields: unknown) => Effect.Effect<void, PluginRefused>
  /** Run an event whose flow is not person-only: the host fills `$item` and `$event` and mints the invocation context. */
  readonly dispatch: (event: EventRef, fields: unknown) => Effect.Effect<Dispatched, PluginRefused>
  /** Open a view the manifest declares. */
  readonly open: (view: Qualified) => Effect.Effect<void>
}
```

**The host owns person-only actions** (Fable, finding 1). An event whose flow is person-only (its registry entry has a `userOnlyReason`, as `run/answer` does at `src/flows/registry.ts:137`) is never dispatched by plugin code, compiled or not:
- **The action strip.** The host draws it under the view, in host UI, from the view's person-only `events`: one button per event, and a text box for each string field in an event's payload schema. It owns those events' keys from the manifest's `keybindings`. The person's press or key on the strip is the person door: the session, no `act` (slice 0).
- **The view's part** is to show the item and choose it: it calls `select(item)` as the person moves, and `propose(event, fields)` to prefill the strip, such as an option it highlights or a suggested note. A proposal is shown in the strip and never sent without the person's press.
- **Focus stays in the host by default,** so the keys reach the strip. A click inside a framed app gives the frame focus; `Esc` gives it back. `i` focuses the strip's text box.
- **`dispatch`** is for the rest: an event whose flow isn't person-only runs under the plugin's invocation context (`act: app` from a frame), and `dispatch` of a person-only event is refused `person_only`.
- **`confirm` stays for protected acts only** (merging, approving a pull request, pre-approving, grants, roles), never per answer, because PROC-10 asks for an "extremely fast" queue.
- **The compiled Queue uses the same strip in slice 1,** so slice 3's framed port changes only the renderer and its parity gate is reachable.

- **A built-in's tab entry** exports `tab: Layer<PluginTab, never, PluginHost>`, giving `{ queries, actions }` (Fable's entry shape and `docs/state.md` rule 5). The host builds it in the plugin's scope on first use and closes the scope when the last of its views leaves. Components read `{ queries, actions }` through the React adapter and never import Effect.
- **A framed app** reaches the same operations through the bridge client `smithers:app` (below); a realm view through declared events.
- **The core adds a `waits` projection** (`core/waits`): the open waits addressed to the viewer, from the `runs` collection alone, with run id, version, execution, kind, prompt, options, deadline and `addressedTo`. Today a wait is addressed to the run's launcher, which is what `run/answer` checks (`worker/Runs.ts:220-223`); slice 2's external asks address another person, so `run/answer` checks `addressedTo` from then on (Fable, finding 9). Today's `needsQuery` joins chat messages and orders by conversation position (`src/features/status/queries.ts:15-62`), so it can't list waits from runs that aren't chat answers; `core/waits` replaces it as the one source, and the header's count reads it too.
- **No queue-specific branch in the host.** The host knows queries, events, keys and views, never items or decisions.

### The manifest

```ts
// packages/smithers/agent/plugin/src/Manifest.ts: framework-free; browser, Worker, Node, Bun
import { Schema } from "effect"

const bounded = <S extends Schema.Top>(item: S, max = 64) => Schema.Array(item).check(Schema.isMaxLength(max))
const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,39}$/))

/** A plugin's id, and the namespace of its views, commands, hooks, settings, queries and records. */
export const PluginId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,39}$/))
/** `<plugin>/<name>`: a view, slot entry, command, hook, setting, query or card kind in a plugin's namespace. */
export const Qualified = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,39}(\/[a-z0-9][a-z0-9.-]{0,63}){1,3}$/))
/** A flow's tag, as `Flow.make`'s first argument: `app/navigate`, `run/answer`, `notification-policy`. */
export const FlowTag = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(\/[A-Za-z0-9][A-Za-z0-9.-]*){0,3}$/))
/** Release versions only: `Pack.compatible` strips prerelease suffixes (Pack.ts:307), so a manifest never carries one. */
export const Version = Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+$/))
/** `Pack.compatible`'s grammar: `*`, hyphen ranges, and conjunctions of =, >=, >, <=, <, ^ and ~. No `||`, no `x`. */
export const Range = Schema.NonEmptyString.check(Schema.isMaxLength(64))
export const Minimum = Schema.Literals(["anyone", "guest", "member", "maintainer", "admin"])   // 0007 §1
export const Capability = Schema.NonEmptyString.check(Schema.isMaxLength(128))     // @smthrs/capability grammar
export const Title = Schema.NonEmptyString.check(Schema.isMaxLength(80))
export const Prose = Schema.NonEmptyString.check(Schema.isMaxLength(1024))
export const When = Schema.String.check(Schema.isMaxLength(256))                   // the closed when-grammar
export const RelativePath = Schema.NonEmptyString                                  // confined to the plugin root
/** A JSON Schema: a closed 2020-12 subset, `$ref` only to this manifest's `#/$defs/…`, never a URL; at most 16 KiB. */
export const JsonSchema = Schema.Json
/** A query a contribution may read: a core projection (`core/waits`) or one of this plugin's own. */
export const QueryRef = Schema.String.check(Schema.isPattern(/^(core|[a-z][a-z0-9-]{1,39})\/[a-z][a-z0-9-]{0,63}$/))
/**
 * Values the host fills, in a closed grammar: a JSON literal, or a reference rooted at `$item` (the selected row of the
 * view's `reads`), `$event` (the event's payload) or `$key` (the key pressed: `$key.index` is 0 for `1` … 8 for `9`),
 * followed by at most 4 `.<name>` or `[<n> | $event.<name>]` segments: `$item.options[$event.index]`. The loader
 * checks every reference against the `reads` row schema and the payload schema. Nothing else is evaluated.
 */
export const Args = Schema.Record(Schema.String, Schema.Json)

/** A view event: it runs a flow (with host-bound args) or stays inside the view (local state, never leaves it). */
export const Event = Schema.Union([
  Schema.Struct({ name: Name, payload: Schema.optional(JsonSchema), flow: FlowTag, args: Args }),
  Schema.Struct({ name: Name, local: Schema.Literal(true) }),
])

/** How a UI contribution draws. `component` only for a plugin compiled into the build. */
export const Render = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("blocks"), blocks: bounded(Schema.Json, 32) }),   // @smthrs/views Block
  Schema.Struct({ kind: Schema.Literal("view"), module: RelativePath }),                  // TSX, QuickJS presentation realm
  Schema.Struct({ kind: Schema.Literal("app"), module: RelativePath }),                   // React app, sandboxed frame
  Schema.Struct({ kind: Schema.Literal("component"), export: Schema.NonEmptyString }),    // React, the app's realm
])

export const View = Schema.Struct({
  id: Qualified, title: Title,
  scope: Schema.Literals(["app", "repository"]),      // /app/<plugin>/<path> or /<owner>/<repo>/-/<plugin>/<path>
  path: Schema.String.check(Schema.isMaxLength(128)),
  sizes: bounded(Schema.Literals(["inline", "full"]), 2),
  minimum: Minimum, render: Render,
  reads: Schema.optional(bounded(QueryRef, 16)),
  events: Schema.optional(bounded(Event, 32)),
})
export const Slot = Schema.Struct({
  slot: Schema.Literals(["shell.header", "shell.nav", "repo.tabs", "branch.pane", "item.pane"]),
  id: Qualified, order: Schema.optional(Schema.Int), when: Schema.optional(When), minimum: Minimum,
  render: Render, reads: Schema.optional(bounded(QueryRef, 16)),
})
export const Command = Schema.Struct({
  id: Qualified, flow: FlowTag, title: Title, minimum: Minimum,
  args: Schema.optional(Args),
  slash: Schema.optional(Schema.Struct({
    name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.-]{0,31}$/)),
    fields: Schema.optional(bounded(Schema.String, 16)),             // today's SlashDoor.fields (registry.ts:56-69)
    hidden: Schema.optional(bounded(Schema.String, 16)),             // today's SlashDoor.hints
  })),
  palette: Schema.optional(Schema.Boolean),
})
/**
 * Exactly one action: a command, or an event the `when` clause's view declares. `fields` fill the event's payload from
 * the key itself (`{ "index": "$key.index" }` for `digit`), in the `Args` grammar. A key whose event is person-only is
 * owned by the host's action strip, never delivered to plugin code.
 */
export const Keybinding = Schema.Union([
  Schema.Struct({ key: Schema.String.check(Schema.isMaxLength(32)), when: Schema.optional(When), command: Qualified }),
  Schema.Struct({ key: Schema.String.check(Schema.isMaxLength(32)), when: When, event: Name, fields: Schema.optional(Args) }),
])
export const Card = Schema.Struct({ kind: Qualified, payload: JsonSchema, sizes: View.fields.sizes, render: Render })
export const Setting = Schema.Struct({
  key: Qualified, title: Title, scope: Schema.Literals(["person", "repository"]),
  schema: JsonSchema, default: Schema.Json, minimum: Minimum,        // a secret field is refused
})
/** An event, cron, webhook or other runs' events (`run.started`, `run.waiting`, `run.settled` with `over`). */
export const Trigger = Schema.Struct({
  on: Schema.String.check(Schema.isMaxLength(128)), flow: FlowTag, title: Title,
  over: Schema.optional(bounded(FlowTag, 32)),                       // flows over flows: whose runs it observes
})
export const Hook = Schema.Struct({
  id: Qualified, title: Title,
  kind: Schema.Literals(["collect", "select", "narrow", "guard", "observe"]),
  input: JsonSchema, output: JsonSchema,
  taps: Schema.Literals(["built-in", "repository", "any"]),          // who may tap it
  deadline: Schema.optional(Schema.Int),                             // milliseconds per tap
})
/** Exactly one: a flow (any hook) or a value (`collect` hooks only). */
export const Tap = Schema.Union([
  Schema.Struct({ hook: Qualified, flow: FlowTag }),
  Schema.Struct({ hook: Qualified, value: Schema.Json }),
])
export const ModelRole = Schema.Struct({ role: Qualified, title: Title, default: Schema.Literals(["agent", "judge", "renderer"]) })
export const Records = Schema.Struct({ collection: Qualified, scope: Schema.Literals(["person", "repository"]), schema: JsonSchema })

export const Manifest = Schema.Struct({
  apiVersion: Schema.Literal(1),
  id: PluginId, version: Version, title: Title, description: Prose,
  requires: Schema.Struct({ api: Range, plugins: Schema.optional(Schema.Record(PluginId, Range)) }),
  capabilities: bounded(Capability),                                 // the ceiling
  uses: Schema.optional(bounded(FlowTag)),                           // flows it doesn't own that it may dispatch or call
  flows: Schema.optional(bounded(RelativePath, 16)),                 // built-ins and packs: directories inside the root
  skills: Schema.optional(bounded(RelativePath, 16)),                // packs: kept so their migration is lossless
  owns: Schema.optional(bounded(Name, 64)),                          // repository plugins: `.smithers/flows/<name>/`
  userOnly: Schema.optional(Schema.Record(FlowTag, Prose)),          // why the agent may not run a flow it owns
  $defs: Schema.optional(Schema.Record(Name, JsonSchema)),
  contributes: Schema.optional(Schema.Struct({
    views: Schema.optional(bounded(View)),        slots: Schema.optional(bounded(Slot)),
    commands: Schema.optional(bounded(Command)),  keybindings: Schema.optional(bounded(Keybinding)),
    cards: Schema.optional(bounded(Card)),        settings: Schema.optional(bounded(Setting)),
    triggers: Schema.optional(bounded(Trigger)),  hooks: Schema.optional(bounded(Hook)),
    taps: Schema.optional(bounded(Tap)),          modelRoles: Schema.optional(bounded(ModelRole, 8)),
    records: Schema.optional(bounded(Records, 16)),
  })),
})   // decoded with onExcessProperty "error": an unknown field, or a union member with both alternatives, refuses
```

**Checks beyond the schema** (`Manifest.check`, at build time for built-ins and in `plugin/refresh` for repositories):
- The file is at most 64 KiB, each point holds at most 64 entries, and each JSON Schema is at most 16 KiB. A `$ref` resolves only to this manifest's `$defs`; an unknown ref, a URL ref or an unsupported keyword refuses the plugin (`schema_unresolved`). No schema is fetched.
- Every contribution id starts with the plugin's id. A reserved first segment (`app`, `chat`, `repo`, `run`, `flow`, `ui`, `view`, `system`, `auth`, `secret`, `github`, `issue`, `plugin`, `core`) is refused outside the core's list. Duplicates across plugins are refused, never last-writer-wins.
- **Flow ownership** (Astra, finding 9): a built-in or a pack owns the flows in its `flows` directories, which stay confined to its root (`Pack.ts:436-475`). A repository plugin owns the `.smithers/flows/<name>/` entries it lists in `owns`, resolved by the host, never by a relative path. One owner per flow: two plugins owning one name is refused (`conflict`), and the implicit plugin owns only unclaimed flows. A plugin borrows any other flow through `uses`.
- Every flow a contribution names is owned by the plugin or listed in `uses`. Every owned *and every used* flow's `capabilities` are a subset of the ceiling, else `capability_exceeded` (Fable, finding 9: `run/answer` declares none, so the queue's empty ceiling holds by rule, not by accident). `userOnly` names exactly the owned flows that declare `modelInvocable: false`, so the declaration stays authoritative (Astra).
- Every keybinding's `event` is declared by the view its `when` names, and its `fields` fill exactly that event's payload. Every dispatching event's `args` refer only to `$item` fields of the view's `reads`, `$event` fields of its payload schema and `$key`; the result decodes against the flow's payload schema at load.
- A view's or slot's `minimum` is at least the minimum of every flow its events dispatch, else `minimum_below_flow`: a Guest never sees an action the server refuses them (`run/answer` refuses Guests, `worker/Runs.ts:251`).
- A view or app module that renders a password input or a credential `autocomplete` value (`current-password`, `new-password`, `one-time-code`) is refused at admission (`credential_input`); the frame runtime also tears down a frame that creates one at run time (Fable, finding 2).
- Every `tap.hook` exists and its owner allows this tier; a `value` tap names a `collect` hook. `on: "run.*"` triggers require `over` and the capability `run:observe`.
- The host advertises the points it implements. A point it doesn't implement yet refuses the plugin with `unsupported_point` (Sol). Slice 1's host implements only views, slots, commands, keybindings and view events.
- **The printed example below is a test fixture** that decodes, checks, loads and dispatches through the real loader (Astra, finding 11).

### Contribution points

| Point | What it declares | How the core uses it | Who may contribute | Lands in |
|---|---|---|---|---|
| `views` | A view in the chat shell, inline and/or full, with its `reads`, `events` and render | The view host mounts it at `/app/<plugin>/<path>` or `/<owner>/<repo>/-/<plugin>/<path>` | any | slice 1 |
| `slots` | An entry in a named place | `<Slot name>` draws entries by `order`, then id | any; the header takes at most 6 | slice 1 |
| `commands` | A flow, with fixed `args`, as a slash command, a palette entry or both | The slash menu and the palette read them, generalizing `commandsOf` (`catalog.ts:27`) | any | slice 1 |
| `keybindings` | A key and a `when`, running a command or sending a declared event | The core keymap; a flow runs with door `key` | any | slice 1 |
| `flows`, `owns` | The flows a plugin owns | `Discovery` reads them without running them; they join the one catalog | built-in, pack; repository via `owns` | slice 5 (repository), today's registry for built-ins |
| `cards` | A card kind in the conversation | Replaces `VIEW_TEMPLATES` (`views/contract.ts:18`) | any | slice 7 (`web`) |
| `settings` | A person or repository setting with a JSON Schema | The plugin settings page draws a `FlowFormView`; the core flow `plugin/setting` writes it | any | slice 5 |
| `triggers` | An event, cron, webhook, or other runs' events | `@smthrs/triggers`; run events from the runs index; remote by need | built-in, repository | slice 2 |
| `hooks`, `taps` | A seam a plugin owns; a flow or value on a hook | Run by its semantics below; each acting tap is a durable child run | by the hook's `taps` | slice 4 |
| `modelRoles` | A named model use | Admins map it; calls go through `ModelStep` within budgets | built-in, repository | slice 5 |
| `records` | Small JSON records only the plugin's flows write | `plugin_records`, synced by an authorized shape | any | slice 4 |

**Hook semantics and failure rules** (Astra, finding 4; Sol's explicit selection):

| Semantics | How taps combine | On a tap's failure, timeout or invalid output | SDK |
|---|---|---|---|
| `collect` | an ordered list of every tap's value or result, in dependency order, then id | that tap's entry is omitted and the omission recorded | new kernel kind; `parallel` discards results today |
| `select` | one provider: the repository's setting, else a sole repository tap, else the owner's default; two candidates with no setting is an activation error | a *decision* tap falls back to the default; a *work* tap (`todo/flow`, `repo/home`) is the run or page itself, so its failure is shown as that run's or page's failure, never silently replaced | resolved by `Load` and pinned; never `first` by order |
| `narrow` | the output is the intersection of every tap's output with the input; mandatory members (an addressed wait, a security notice) are restored | the default output (allowed only where the owner says so: `notification/route`, 0009 decision 6) | waterfall with a subset check |
| `guard` | allow only if every tap allows (conjunction); refusal reasons are the union | **refuse**, reason `policy_unavailable`; the person sees it and can retry | waterfall that fails closed |
| `observe` | taps see the event; nothing changes | nothing; the failure is recorded | `collect` with results ignored |

Every acting tap runs as a durable child run with the id `<execution>/hook/<hook>/<plugin>`, its result recorded in order in the parent's journal, with its own deadline and cancellation. The resolved tap set is pinned in the step's sealed input, so a replay never resolves taps again. Tests run the real SDK path with two successful taps, one failing tap, a timeout, malformed output and a crash and resume, for each semantics.

**The hooks this design defines:**

| Hook | Semantics | Owner | Taps take → return | Default | Boundary |
|---|---|---|---|---|---|
| `composer/submit` | select | core | text and conversation → handled or not | `agent` | slash parsing stays core |
| `repo/home` | select (work) | core | repository and commit → a render | `repo`'s tree; `home` taps it with `.smithers/home.json` | the tree stays reachable (M-45); arriving runs no flow (0014 §10) |
| `triage/decide` | select (decision) | `triage` | the issue as read → accept, reject or abstain, with a reason | the Classifier, role `judge` | `issue/ApplyTriage` is a system flow; deadline 60 s; abstain → default (0012 §5) |
| `notification/route` | narrow | core | identity and audience → at most 50 ids | the built-in audience | at most 10 s (0009 decision 6) |
| `issue/transition` | guard | `issues` | issue, from, to → allow, or deny with a reason | allow by role | fails closed (M-47) |
| `merge/rules` | guard | core | pull request and revision → reasons to refuse | none | fails closed; `@smthrs/access` vetoes agents and Guests (0007 §2) |
| `pr/checks` | collect | core | repository and head commit → flow runs | the repository's check flows | M-52 |
| `todo/flow` | select (work) | `todos` | the TODO → its run | the built-in TODO flow | Publish, Propose and Settle stay system steps (0016 decision 4, M-30) |
| `needs-you/item-kind` | collect | `needs-you` | → `{ kind, render, events }` | `ask` | slice 4, when review kinds give it a second consumer |

### Example: `needs-you`'s manifest (slice 1)

```json
{
  "apiVersion": 1,
  "id": "needs-you",
  "version": "0.1.0",
  "title": "Needs you",
  "description": "Everything that waits on you, one item at a time, full screen, by keyboard.",
  "requires": { "api": "^1.0.0" },
  "capabilities": [],
  "uses": ["run/answer", "app/navigate"],
  "$defs": {
    "Option": { "type": "object", "properties": { "index": { "type": "integer", "minimum": 0, "maximum": 8 } },
                "required": ["index"], "additionalProperties": false },
    "Note": { "type": "object", "properties": { "note": { "type": "string", "maxLength": 4000 } },
              "required": ["note"], "additionalProperties": false }
  },
  "contributes": {
    "views": [{
      "id": "needs-you/queue", "title": "Needs you", "scope": "app", "path": "",
      "sizes": ["inline", "full"], "minimum": "member",
      "reads": ["core/waits"],
      "render": { "kind": "component", "export": "Queue" },
      "events": [
        { "name": "option", "payload": { "$ref": "#/$defs/Option" }, "flow": "run/answer",
          "args": { "runId": "$item.runId", "version": "$item.version", "execution": "$item.execution",
                    "value": "$item.options[$event.index]" } },
        { "name": "approve", "payload": { "$ref": "#/$defs/Note" }, "flow": "run/answer",
          "args": { "runId": "$item.runId", "version": "$item.version", "execution": "$item.execution",
                    "value": { "approved": true, "note": "$event.note" } } },
        { "name": "changes", "payload": { "$ref": "#/$defs/Note" }, "flow": "run/answer",
          "args": { "runId": "$item.runId", "version": "$item.version", "execution": "$item.execution",
                    "value": { "approved": false, "note": "$event.note" } } },
        { "name": "reply", "payload": { "$ref": "#/$defs/Note" }, "flow": "run/answer",
          "args": { "runId": "$item.runId", "version": "$item.version", "execution": "$item.execution",
                    "value": "$event.note" } },
        { "name": "next", "local": true },
        { "name": "previous", "local": true }
      ]
    }],
    "slots": [{ "slot": "shell.nav", "id": "needs-you/nav", "order": 10, "minimum": "member",
                "reads": ["core/waits"], "render": { "kind": "component", "export": "NavCount" } }],
    "commands": [{ "id": "needs-you/open", "flow": "app/navigate", "args": { "to": "/app/needs-you" },
                   "title": "Needs you", "minimum": "member", "slash": { "name": "needs" }, "palette": true }],
    "keybindings": [
      { "key": "g n", "command": "needs-you/open" },
      { "key": "digit", "event": "option", "fields": { "index": "$key.index" },
        "when": "view == needs-you/queue && item.question && !focus.input" },
      { "key": "a", "event": "approve", "when": "view == needs-you/queue && item.approval && !focus.input" },
      { "key": "r", "event": "changes", "when": "view == needs-you/queue && item.approval && !focus.input" },
      { "key": "mod+enter", "event": "reply", "when": "view == needs-you/queue && item.question" },
      { "key": "j", "event": "next", "when": "view == needs-you/queue && !focus.input" },
      { "key": "k", "event": "previous", "when": "view == needs-you/queue && !focus.input" }
    ]
  }
}
```

The keys follow the maintainer queue's (`apps/maintainer-site/README.md`). Four events dispatch `run/answer`, which is person-only, so the host's action strip draws them and owns their keys: `2` fills `index` with 1 through `$key.index`, and `args` picks `$item.options[1]`; the strip's text box fills every `note`, and `i` focuses it. `next` and `previous` are local: the view moves and calls `select`. An approval's note rides with its answer, which needs `run/answer`'s value to accept `{ approved, note }` beside a string and a boolean, an additive change to `AnswerValue` (`src/features/status/schema.ts:40`). `capabilities` is empty because the plugin owns no flow; `run/answer` declares no capability, so the used-flow check passes, and it is person-only, which the run credential enforces (slice 0). Every `minimum` is `member`, because `run/answer` refuses Guests. Item kinds, the hook and the queue flow over flows arrive in slices 2 and 4.

### Lifecycle and activation

```
build   built-in manifests decode and check; a bad one fails the build, naming the field
boot    Load: built-in manifests ─ requires ─ topological order ─ fold ─▶ contributions (a local collection)
          ─ Kernel.make(built-ins) ─▶ one merged Layer. No component, view, app or flow body loads yet;
          the engine worker registers every built-in declaration, because a parked run may resume at any moment
use     a view opens · a slot draws · a key or command fires · a hook is called · a trigger fires
          built-in: lazy import of its chunk, its tab Layer built in its scope     any: blocks draw ·
          the realm renders · the frame mounts · a flow dispatches with its invocation context
repo    /<owner>/<repo> opens ─▶ plugin_installations shape (the active snapshot) ─▶ its manifests at that
          snapshot's commit (RepoApi blob, ImmutableCache) ─▶ Load ─▶ contributions scoped to the repository
leave   the plugin's scope closes; its runs go on, because they are durable
```

- **Activation is implied by contributions,** as in VS Code since 1.74 ([activation events](https://code.visualstudio.com/api/references/activation-events)): no `activateOn`, no start-up activation, no `*`.
- **Opening a page never starts a background job.** Work that changes durable state is a flow; a subscription is a declared trigger.
- **A failed plugin never blocks boot.** It is recorded as not active with a closed reason (`invalid`, `incompatible`, `range_unreadable`, `schema_unresolved`, `missing_dependency`, `cycle`, `undeclared_use`, `capability_exceeded`, `conflict`, `unsupported_point`, `stale_head`) and listed on the plugin settings page, where a Maintainer can pause it. A component sits in an error boundary per slot and view; a frame or realm failure shows one line naming the plugin and keeps the shell.

**Installation snapshots** (Astra, finding 12). `plugin/refresh { repo, sha }` builds one immutable snapshot of the repository's whole plugin set at a commit: every manifest, the flows each owns, its views and app modules, and its resolved dependencies, each content-addressed, with one digest over the lot. It activates the snapshot by compare-and-set on `plugin_installations.active`, and only when `sha` descends from the active snapshot's commit in the mirror's order; an older candidate is refused `stale_head`, so a delayed refresh can't resurrect a removed plugin. A plugin missing from the new snapshot gets a tombstone. Its triggers are added and removed in the same transaction. A snapshot that fails a check keeps the previous one active and shows `Merged · not active` with the reason.

### Versioning and compatibility

- `apiVersion` is the manifest's shape. `requires.api` is a range over the host's release-only `PLUGIN_API`, checked with `Pack.compatible` (`Pack.ts:429`) in its stated grammar; a range it can't read refuses the plugin `range_unreadable` instead of guessing. Plugin versions are release-only, so the prerelease stripping at `Pack.ts:307` can't make a prerelease satisfy a release range.
- A built-in plugin and the core ship in one bundle, so they never drift.
- **What a run pins** (Astra, finding 12). A repository or personal run pins its installation snapshot. Its artifacts are content-addressed and kept while any run references them, so a parked repository run resumes on exactly the code it started with, dependencies included. A built-in run can't do that, because a deploy replaces the bundle: a built-in run parked across a deploy that changed its plan is refused `plan_changed` (`src/flows/dispatch.ts:35`) and offers Retry, which starts the flow again on the current version. Retry repeats only the effects that aren't keyed by a stable operation id; sealed steps keyed that way (`RecordAnswer`, `src/features/status/flows.ts:146-151`) run once.
- Hooks and points change only by addition ("design for additions only", [Backstage](https://backstage.io/docs/backend-system/architecture/extension-points/)). A breaking change is a new id, such as `triage/decide.v2`.
- Records carry a `schemaVersion`; a plugin's data migration is a pinned flow over its own namespace. Disabling a plugin never erases its data.

### Typed dependencies between plugins

- `requires.plugins` names the plugins this one needs. Loading is topological; a cycle or a missing dependency refuses the plugin.
- `uses` is enforced at dispatch against the *calling* plugin in the invocation context, not only at load: a flow called from plugin A's context runs only if A owns it or lists it in `uses`, whatever the callee allows. Dependencies grant no authority transitively.
- A built-in may `import type` from a dependency's root entry. At run time, a tap's value and a hook's input and output decode against the owner's schemas.
- No plugin reads another plugin's records or stores. It calls the other plugin's flows or reads its declared queries.

### Distribution

| Source | Path | Tier | Activated by |
|---|---|---|---|
| This monorepo | `apps/mvp/plugins/<id>/` | built-in | the build |
| A repository | `.smithers/plugins/<id>/`; owned flows in `.smithers/flows/` (M-49) | repository | a person's merge, then `plugin/refresh`'s snapshot |
| The repository's own config | `.smithers/flows/` (unclaimed), `.smithers/home.json` | repository (implicit plugin) | the same |
| A person | Postgres `plugins` and `plugin_revisions`, synced to that person's devices | personal | Save; each run pins its revision |
| npm | `smthrs plugin add <pkg>@<version>` vendors it into `.smithers/plugins/<id>/` and its flows into `.smithers/flows/`, with a digest in `.smithers/plugins.lock` | repository | the pull request's merge |

Nothing is fetched from npm at run time and no install script runs. There is no storefront (#3402 needs Will's authorization) and no theme point (#3403).

## Flows

**Config is a list of bindings; code is the flow.**

| Config (the manifest) declares | Code (`Flow.make`) declares |
|---|---|
| which flows a plugin owns (`flows`, `owns`) | the payload, success and error schemas |
| their doors: commands, slash, keys, palette, view events, block buttons | the body: steps, waits, calls to other flows |
| where they show: views, slots, cards | `capabilities`, `effects`, `modelInvocable`, `budget`, deadlines |
| when they run: triggers, including other runs' events | placement (the `Flow.Placement` annotation) |
| what they decide: taps on hooks | |

Config never lists steps, branches or loops (root `AGENTS.md`: "Never add a second node or graph model"). A prompt flow is a code flow (M-56): a drafted flow is `Flow.make` source whose body is the system's own agent step (`src/features/flows-ui/source.ts:42-76`).

### Where code runs: three sandboxes and the app's realm

| Where | What runs there | Who | Limits |
|---|---|---|---|
| **The app's realm** (the tab, the engine worker, the Worker) | built-in plugins' code and the core | only code compiled into the build | none beyond review: it is trusted application code |
| **The QuickJS realm** (WebAssembly, on the browser engine or driven by the Worker) | today: the agent's cells (`@smthrs/agent` over `@smthrs/harness`'s `QuickJSSandbox`, `packages/smithers/agent/src/Agent.ts:53`, `docs/features/agent.md:46`) and views' render and `reduce` (0004); from slice 5: flow code from a repository plugin, a personal plugin or flow, hand-edited ones included | any plugin, the agent | no network, no files, no host objects; imports only the host's module set and the plugin's own files, checked before it runs; every `ctx.call` is a journaled child execution under the invocation context; the limits and determinism rules below |
| **The sandboxed frame** (on the views domain) | React apps | any plugin not compiled in, the agent | [below](#apps-react-in-a-sandboxed-frame): no network, data only through the bridge |
| **A container** (Cloudflare Containers, 0005) | code that needs a machine: files, processes, a checkout, `fs:*` or `proc:*` capabilities, imports outside the realm's set | any plugin, by need | the branch or job sandbox's limits; secrets only through the egress |

The QuickJS realm is a sandbox (Will's answer 2), so it is where untrusted flow code runs by default; it runs in WebAssembly inside a worker, it has no host function but the call bridge, and its escape tests are fuzzed and kept. A flow goes to a container only when it needs a machine. Placement stays local first: realm code runs on the browser engine unless it needs a server key or must run while every device is off, and then the Worker drives the same realm (DUR-5).

`FlowNeedsSandbox` (`docs/features/flows.md:162`) then applies only to code that needs a machine: a hand-edited personal flow that only calls flows and models runs in the realm.

**The realm flow host's rules** (Fable, finding 6). A flow body is `(payload) => Node` (`packages/smithers/flows/flow/src/Flow/Flow.ts:148`), and its closures run while the plan is interpreted, so the realm must replay the same way at every resume:
- **Determinism.** Before the module loads, the host removes `Date`, `Math.random`, `Proxy`, `WeakRef` and timers, as the presentation realm does (`packages/smithers/ui/views/src/PresentationRealm.ts:237-240`). Time and randomness exist only as journaled steps (`ctx.now`, `ctx.random`).
- **Limits.** The presentation realm's numbers (`PresentationRealm.ts:86-93`): 64 MiB memory, 128 KiB stack, 1 s and 2,000 interrupt steps per body evaluation; the plan a body returns is at most 256 KiB; calls per run come from the flow's `budget`. A body over a limit fails with its typed error.
- **Resume.** A resume rebuilds the realm from the snapshot's content-addressed module and replays the body; a fresh runtime costs about 47 ms (0004's spike).
- **Pinned host modules.** The host module set (`@smthrs/flow`, the agent's `ModelStep` facade, `effect`'s `Schema`) is versioned, and its versions are part of the installation snapshot's digest, so an upgrade never changes what a pinned body decodes.
- **Tests.** Escape and limit tests are fuzzed and kept, as the presentation realm's are.

**Templates.** A drafted prompt flow that is byte for byte what `renderSource` writes runs as the host's own agent step on the engine, as today (`placementOf`, `source.ts:97-109`). Any other module, one changed byte included, is code and runs in the realm. There are no typed "policy templates": a repository's triage decider or notification policy is a realm flow whose output decodes against the hook's schema (Astra, finding 10).

**A tap on a durable seam:**

```
triage/Run (remote, FlowExecution)
  Read
  Decide = hook triage/decide (select, pinned at the run's snapshot)
     ├─ the repository's tap: its flow ─▶ the QuickJS realm, driven by the Worker; ModelStep with role judge
     │     child id triage/Run…/hook/triage/decide/<plugin>; deadline 60 s;
     │     failure, timeout, invalid output or abstain ─▶ the default
     └─ default: the built-in Classifier, role judge
  Label, Comment = issue/ApplyTriage (system: never a tap)
```

### Flows over flows

Will: the queue "will very likely end up as a workflow that can be ran on top of other workflows specifically ones that are doing coding work". A flow over flows is a first-class capability:
- **It observes.** A trigger with `on: "run.started" | "run.waiting" | "run.settled"` and `over: [flow tags]` starts it for each such event of a run in its scope (the repository, or the person's own runs), once per `(run, event sequence)`. It needs the capability `run:observe`.
- **It reads.** `run/inspect` gives it a watched run's status, steps, waits and results, within the person's and the plugin's grants.
- **It acts on runs it is granted:** it starts, cancels or retries them, and it asks a person through its own waits.
- **It never answers another run's question for a person,** never approves and never merges. Those stay person-only.
- **Every event is durable.** The runs index emits run events from its journal facts; the trigger is keyed by run and sequence, so a crash replays the same deliveries and nothing is lost or doubled.
- **Its principal is the plugin installation** (Fable, finding 7). A triggered run has no person, so its credential's subject is `{ kind: "installation", id }` with `act: { kind: "flow", id: <run> }`: the tier's cap, no person-only act, model spend on the repository's budget, and `Access.rules` evaluated with no person, as 0012 §5's installation token already does for GitHub writes.

**The queue's product version is one.** `needs-you/curate` runs over coding flows (`todo` runs, check flows): when one waits or settles, it reads the context (the diff, the recording, the slice), ranks it, and raises an item to the person as its own wait, which `needs-you` shows. Until it is high quality, it is dogfooded on our own work and the maintainer queue (Will's answer 3).

## Custom UIs and trust tiers

**Four renderers:**

| Renderer | What it is | Who may use it | It can | It can't |
|---|---|---|---|---|
| Blocks | A closed union drawn natively by `@smthrs/ui` (`Home.ts:247-256`); new blocks (`code`, `media`, `board`) land with their first consumer | any plugin, the agent | show read flows' results; buttons that dispatch declared flows | run code, carry HTML |
| Views | TSX rendered to HTML in the QuickJS presentation realm, shown in an opaque frame (0004 §4-7) | any plugin, the agent | layout with `@smthrs/ui`; declared events; state through `reduce` | timers, network, DOM access |
| Apps | An arbitrary React app in a sandboxed frame with a typed bridge | any plugin, the agent | live JavaScript: timers, animation, canvas, games, editors; declared queries; declared events that run flows | reach the network, read the app's data, act as the person |
| Components | React in the app's realm | a plugin compiled into the build | everything a feature does today | nothing is withheld; review is the boundary |

### Apps: React in a sandboxed frame

Will: plugins "should be able to make arbitrary react based apps that are embedded in chat or can be full screened … just like how agent itself can directly do this."

- **The frame, inside a views-origin wrapper** (Fable, finding 3). The host mounts a wrapper document from the views origin, a registrable domain separate from the app's (0008: rendered views live on a separate registrable domain), whose own policy is `frame-src 'self'`. Inside it sits the app frame, `<iframe sandbox="allow-scripts">`: no same-origin, top navigation, popups, forms or downloads, so it is an opaque origin. The app frame's document is a views-origin URL (`/app/<digest>`) with a CSP of `default-src 'none'`, scripts only from the frame runtime and the plugin's module, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, and images only from `data:` and `blob:`. This departs from 0004 §5, which chose `srcdoc` and rejected a second site because "no generated script runs in the frame" (0004:138, :157). An app runs generated script, so two things now need a URL: the plugin's module, served by digest with its own header CSP, and the wrapper, whose `frame-src 'self'` is what refuses an off-origin navigation before the request leaves. Realm views keep 0004's `srcdoc` frame, because they still run no generated script.
- **The frame runtime** supplies React, `@smthrs/ui` and the bridge client `smithers:app` through an import map; a plugin's module imports only those and its own files, at most 2 MiB in all, pinned by digest. The runtime compiles TSX in the frame.
- **The bridge.** At mount the host transfers one `MessageChannel` port, so no other window can speak on it; each message carries the mount's nonce and generation and decodes against an Effect Schema. The app may `query` the view's declared `reads`, `select` the item it shows, `propose` fields for the action strip, `dispatch` events whose flow isn't person-only, `open` a declared view, ask the host to `confirm` a protected act, and forward keys it doesn't handle. The host sends rows, results, the theme and focus. Size and rate limits are 0004's (`Bridge.ts:34-82`).
- **Authority.** A frame's `dispatch` is `act: app` under the plugin's invocation context (or the agent run's), never the person's session, because the host can't tell a person's click inside a frame from code. A person-only act such as `run/answer` never runs from inside a frame: the host's action strip draws it, outside the frame, and the person's press there is the person door ([the host contract](#the-host-contract)).
- **Keys.** Focus stays in the host by default, so the strip's keys work; a click inside the frame gives it focus, and the frame runtime registers `⌘K` and `Esc` before plugin code loads and forwards them, so `Esc` always returns focus to the host.
- **Attribution the host draws** (Fable, finding 2). Every frame and realm view sits under a label the host owns: its title, tier and origin (`Needs you · repository plugin · smithersai/smithers`, or `Agent app`), as VS Code's webview title bar, Figma's plugin window and MCP Apps hosts do. A full-screen app keeps the host header. A frame can't draw outside its box, so the label can't be covered.
- **The host never asks for a credential inline.** No core UI asks for a password, a token or a secret inside the conversation; a secret is entered only on the core Secrets page. A module that renders a password input or a credential `autocomplete` value is refused at admission, and the runtime tears down a frame that creates one, so an inline credential prompt can't render. Text typed into a plugin's UI is that plugin's data, and it goes only where the manifest's events send it.
- **Navigation.** The wrapper's `frame-src 'self'` refuses a navigation to another origin before the request is sent; the views origin's server refuses unknown paths and logs no query string. The host still watches the frame's `load` events as depth: a second load tears the frame down, records `frame_navigated` and pauses the plugin installation until a Maintainer enables it again. Slice 3's acceptance proves it: Playwright counts requests to foreign origins from an app that navigates, in Chromium, Firefox and WebKit, and the count is zero. If a browser doesn't enforce `frame-src` on a frame's own navigation, the test says so before the design claims it.
- **The app page's own policy narrows.** Today `src/pwa.ts:34` sets `FRAME_POLICY = "frame-src https:"` for web-page cards, which would allow such a navigation from any frame mounted directly in the app. Before slice 3 it narrows to the views origin, and web-page cards move into a views-origin wrapper of their own whose policy is `frame-src https:` (an outside page gets no data from us).
- **The agent's apps.** `ui/app` (model-invocable) puts an app card in the conversation, labelled `Agent app`: the agent writes a TSX module, the same checks admit it, and it shows inline or full screen. Its bridge reaches only the conversation's data and the flows the agent's run may call, under the agent's run credential. A tic-tac-toe board works and is safe (SCOPE-6 #3).
- **The bridge's contract is the public interface.** A compiled plugin's components read the same `{ queries, actions }` and use the same action strip the bridge exposes, which is why slice 3 can prove parity.

### What each tier can do

| | Built-in | Repository | Personal |
|---|---|---|---|
| Comes from | this monorepo's build | `.smithers/plugins/` in an active snapshot | the person's saved revisions |
| UI | components, apps, views, blocks | apps (frame), views, blocks | the same as a repository plugin, on that person's screens only |
| Flow code runs in | the app's realm | the QuickJS realm; a container for machine work | the same as a repository plugin |
| Capability cap | any act that isn't person-only | Member-level `repo:*` acts plus `plugin:<id>:*` and `run:observe` | that person's grants |
| Hooks | owns hooks; taps any hook | taps hooks whose owner allows repository taps | taps nothing shared (`notification/route`, `triage/decide`, `merge/rules`); starts no unattended team work (Sol) |
| Secrets | by name, through the egress | by name, once an Admin grants them to this installation | none |
| Text you type into its UI | that plugin's data, going only where its events send it | the same | the same |

**Preview.** An unmerged plugin on a branch is a state, not a tier: the pull request card can show its views and apps over the branch's data with reads only, no secrets, no triggers and no taps (Sol, Astra). It arrives with slice 5.

**Consistency and speed.**
- **One look.** Every renderer draws with `@smthrs/ui` and its tokens, in the Paper palette, light and dark; an app gets the kit and the theme from the frame runtime. Minimal text (`ui.minimal-text`) applies to every plugin, and Jev checks it.
- **One placement.** Only the core defines slot names; the header holds at most 6 entries.
- **Budgets,** measured by `pnpm bench` locally and live: checking every built-in manifest adds at most 5 ms to `smithers_web_boot_ms` (`src/boot.ts:66`) at p50; a slot draws in one frame; the first realm view shows within 100 ms; a framed app's first paint within 300 ms; a built-in plugin's chunk is at most 150 KB gzipped.

**Keyboard.** The core owns one keymap. Precedence: core, then the focused view, then plugins in dependency order, then the person's own overrides. `when` is a closed grammar (`view == <id>`, `item.<flag>`, `focus.input`, `role >= <role>`, joined by `&&`, `||` and `!`). `⌘K` (FE-10), `Esc` and `?` are reserved; `?` lists every active binding. A conflicting binding is refused. A key that runs a flow dispatches with a new door, `key` (`src/flows/contract.ts:11`).

## Security and authority

### Run credentials: telling the person from the agent (slice 0)

Astra's P1 #1 and the lead's tracked gap: sign-in never sets `Actor.act`, so the browser agent's requests carry the person's cookie, and `POST /api/runs/<id>/answer` checks only that the session's person launched the run (`worker/Runs.ts:220-223`). A missing model-catalog entry (`userOnlyReason`, `registry.ts:137`) hides `run/answer` from the agent; it doesn't stop a request.

- **Which runs get a credential, and who sets `act`** (Fable, finding 4). A door doesn't decide it: the agent's whole run, `chat/Answer`, starts from the person's composer, yet everything inside it is the agent's. So each registry entry carries a mark beside `userOnlyReason`: `acts: "person" | "agent" | "flow"` (`chat/Answer` is `agent`; `run/answer`, `todo/commit` and `branch/share` are `person`). A run is the person's only when it is a *root* dispatch, from a person door, of a flow marked `person`. Every other run gets a credential, except the compiled branch-operation implementation described below.
- **Implementation correction, 2026-10-26 (GH-2).** A person's Publish/Update runs its compiled `branch/operation/start` / `branch/operation/program` implementation as a child. Minting that child a flow credential turned the person's GitHub write into the App's. Only these exact compiled parent/child pairs inherit a session, and only when the parent already uses a session. Agent, flow, frame and sandbox credentials never become sessions; unrelated children still mint narrowed credentials. Realm code cannot choose a parent, a credential or arbitrary host actions. `src/flows/credentials.test.ts` proves person presses retain the session and non-person or unrelated callers retain credentials. This fixes the implementation to honor GH-2; it adds no plugin authority.
- **The server sets `act`, never the request.** The engine asks `POST /api/runs/<id>/credential` when such a run starts; the server reads the run's flow from its own `runs` row and mints `act.kind` from that flow's mark and the run's parent: `agent` inside an agent run, `app` for a frame's dispatch, `flow` for a flow's own run or a trigger, `sandbox` for a container's. A remote run's host mints its own the same way. `Actor.act` gains the `app` kind beside `agent`, `flow` and `sandbox` (`worker/Actor.ts:20`).
- **The credential** is a signed bearer token bound to one run, holding the subject (the person, or the plugin installation for a trigger with no person), `act` with the run's id, the plugin installation and snapshot, the repository, the caller chain, the effective ceiling and an expiry of 15 minutes, renewed while the run lives.
- **No fallback to the cookie.** The engine sends every request of such a run with that token and `credentials: "omit"`, so the session cookie never rides along. The model, realm code and frames never hold the cookie or choose a credential; the engine, which is compiled-in application code, does.
- **One source for the person-only list** (Fable, finding 5). The server's person-only set is generated: every registry flow with a `userOnlyReason` (`src/flows/registry.ts`: `chat/Answer`, `chat/Close`, `chat/edit`, `run/answer`, `run/deliver`, `flow/answer`, `flow/run/prompt`, `branch/share`, `terminal/open`, the triage override, rerun, enable and pause, `todo/commit`, `todo/drop`, `notification/ack`), plus the server-only protected acts (merge, approve, pre-approve, members, roles, settings, secrets, plugin grants), listed once in `worker/Actor.ts` beside `act`. The server sets `Actor.act` from the token, and each of those routes refuses an actor with `act` (`403 person_only`). A hand-written list would drift: the earlier draft of this decision missed `branch/share`, `terminal/open`, `chat/edit` and `flow/answer`.
- **A person's act** comes from a person door (button, key, typed slash command, palette) in core UI or a compiled plugin's component, with the session cookie and no `act`. A protected act (merge, approve, pre-approve, a secret, a plugin grant, a role) also needs a confirmation receipt: single-use, 60 seconds, bound to the act, the person and the target revision, minted only when the person presses the host-drawn confirm control. No agent token can mint one.
- **The confirm dialog** (Fable, finding 8). Its text comes from the server's view of the target (the pull request's number, title and head SHA; the secret's name; the role), never from plugin strings, and it names the plugin asking. It ignores keys for 500 ms after it appears and any press whose pointer-down began inside a frame. A plugin gets at most 3 confirms a minute, and a `confirm` for an act outside its ceiling is refused before the dialog draws.
- **Tests:** `registry.test.ts`, which already proves the two flow lists match, gains one case per `userOnlyReason` flow: its route refuses an `act` token. Plus direct HTTP to every server-only protected route with an agent token, a forged token, an expired token and no token; `chat/Answer` dispatching `run/answer` nested, refused; a frame's dispatch of a person-only flow, refused; a replayed receipt, refused.

### The invocation context

Astra's P1 #2: `CapabilityCeiling` attenuates nested ceilings (`Flow/CapabilityCeiling.ts:36-37`), but nothing carried the originating plugin to the server. The run credential is the invocation context, and it travels with every dispatch:

```
what a dispatch may do  =  the calling plugin's manifest capabilities      (its ceiling)
                         ∩  the invocation context's ceiling                 (attenuated at every hop)
                         ∩  the callee's Flow.make capabilities
                         ∩  Access.rules(person, facts)                      (0007; decided in the write's transaction)
                         ∩  the tier's cap
                         −  person-only acts, unless a person's own door and, where protected, a receipt
```

- **A child flow** inherits an attenuated context: the ceiling narrows to the intersection, the caller chain grows by one, and `uses` is checked against the caller. A callee that is allowed doesn't lift a caller that isn't.
- **UI dispatch** from blocks, views and apps runs under the viewer ∩ the plugin's ceiling, not the viewer alone, so a small plugin can't reach a powerful flow through a button.
- **Remote admission** reads the context from the token, and each protected effect checks it again in its own transaction.
- **Compiled code is trusted application code.** It runs in the app's realm and can reach browser APIs without importing anything; ImportRules can't contain it. Its boundary is code review and the build, and the design says so rather than promising containment.
- **Test:** an adversarial nested call where the callee is authorized and the caller isn't is refused at the server.

### Review, activation and grants

- A repository plugin arrives as files under `.smithers/plugins/` and `.smithers/flows/` in a pull request. `plugin/check` runs statically, and the pull request card shows a plugin diff: capabilities widened, flows owned, secrets and origins named, hooks tapped, triggers added.
- Merging consents to the `repo:*`, `plugin:*` and `run:observe` acts inside the repository tier's cap. By default only Maintainers and up merge (BR-7).
- **Secrets and origins are granted per installation** (Astra's P1 #3). `plugin_grants` holds one row per plugin installation and secret or origin: hosts, methods, scope, grant version, the Admin who granted it, and when it was revoked. Granting is an Admin's protected act with a receipt. A plugin that names a secret stays `Merged · waiting for an Admin` until that plugin's grant exists; plugin A's grant on a secret never lets plugin B use it, and a wider update needs a new grant.
- **The egress narrows to the grant.** Today a guest's policy holds every secret of its repository, derived per repository, branch and generation (`worker/secrets/SandboxEgress.ts:22-50`). A plugin's policy becomes its manifest's names ∩ the flow's ceiling ∩ its installation's active grants, with placeholders derived in a scope that includes the installation, and revocation checked on every request. Two plugins with different grants never share a container (0005:208: "The sandbox is therefore the smallest unit of trust"). The realm has no network, so realm code never touches a secret.
- **This stays switched off** until three tests pass: B naming A's secret is refused; a widened update stays pending; a revocation during a run stops its next request.
- An agent may draft and propose a plugin, as `flow/new` drafts a flow. It never merges, activates, pauses or grants.
- A Maintainer's `plugin/pause` stops an installation without a revert. Each activation, pause, grant and refusal is a `plugin_events` row and a `plugin.activate` record.

### Data and threats

Built-in plugins keep their records in `plugin_records` like anyone else; a dedicated table needs a stated reason. Records hold at most 16 KiB each and 10,000 per collection per scope, are written only by the plugin's own flows through a core step that runs `Authorize` in the write's transaction, and are synced by a per-scope shape authorized on each request. Plugins never get SQL, an Electric URL or a database handle.

| Threat | Defense | What remains |
|---|---|---|
| The agent answers or merges as the person | the run credential; person-only routes refuse any `act`; protected acts need a receipt from host UI | none |
| A small plugin reaches a powerful flow | the invocation context; `uses` checked against the caller; viewer ∩ plugin ceiling for UI dispatch | misuse of a flow it was granted |
| A plugin uses another plugin's secret | per-installation grants; per-plugin egress policy and placeholders; revocation per request | a granted secret can be used against its own hosts (0005 §4) |
| A policy times out and lets a merge through | `guard` fails closed | a broken policy blocks merges until fixed, which is visible |
| A framed app sends out what it was shown | no network (`connect-src 'none'`); data only through declared `reads`; the views-origin wrapper's `frame-src 'self'` refuses an off-origin navigation before the request; `load` teardown as depth | none beyond the views origin, whose server refuses unknown paths and logs no query string; proved per browser by slice 3's zero-request test |
| A plugin's UI imitates host UI to harvest a password or token | a host-drawn label on every frame and realm view; the host never asks for a credential inline; password and credential inputs refused at admission and torn down at run time; person-only actions only in the host's strip | a person who types a secret into plugin UI anyway gives it to that plugin's flows |
| A forged frame message | one transferred port, nonce, generation, schema, size and rate limits | none |
| Realm code escapes QuickJS | WebAssembly inside a worker; no host functions but the call bridge; fuzzed escape tests | a QuickJS bug, patched as found |
| Compiled code misbehaves | code review and the build | it is trusted application code |
| A delayed refresh resurrects a removed plugin | ordered heads, tombstones, compare-and-set | none |
| A malicious update | merge is activation; the plugin diff on the PR; pinned snapshots; secrets need an Admin grant | a Maintainer can merge bad code, as with any code |
| npm supply chain | vendored by pull request with a digest; never fetched or installed at run time | the code is only as good as its review |
| Telemetry leaks content | content-free records | none |

## Migration of current features, in order

**Rules that keep the release unstalled:** this is P2; no conversion touches a file a release lane is editing, and none runs while a journey it touches is red. One feature per change, moved without rewriting: the same flows, tags, payloads, tests and e2e GIFs. Each conversion deletes that feature's lines from the central lists in the same change and makes the plugin whole, so its deletion test applies (SDK-11). Progress is the count of hand-written per-feature lines left in `registry.ts`, `declarations.ts`, `registrations.ts`, `boot.ts`, `main.tsx`, `router.tsx`, `AppShell.tsx` and `telemetry.ts`; the target is zero.

| Step | Plugin | Why here |
|---|---|---|
| 1 | `needs-you` (new) | proves the interface on a feature with no old wiring |
| 2 | `web` | the smallest real feature: 1 flow, 2 card kinds, 1 slash command; deletes `VIEW_TEMPLATES` |
| 3 | `jev` | proves model roles |
| 4 | `runs` | proves views with loaders; its nav link becomes a slot entry with the rest of it |
| 5 | `flows` | authoring; its nav link moves the same way |
| 6 | `repo`, `home` | `repo/home` becomes a select hook; the URL grammar stays core |
| 7 | `issues`, `triage` | owned hooks; Triage's Decide becomes `triage/decide` |
| 8 | `notifications`, `spend`, `secrets` | small, policy-adjacent |
| 9 | `todos` | the stack's writer stays core |
| 10 | `branch` family | the largest Worker side |
| 11 | `agent` | last: it touches everything |

The maintainer site keeps running until the app matches every feature in its README; then its pages are deleted one by one.

## Slices

### Slice 0: run credentials (core, a prerequisite)

The section [above](#run-credentials-telling-the-person-from-the-agent-slice-0): the registry's `acts` mark, the run credential with `act` set by the server (and `app` added to `Actor.act`), the generated person-only list, routes refusing any `act`, confirmation receipts and the host's confirm dialog, and the refusal tests, `chat/Answer` → `run/answer` among them. It is the lead's tracked P1 trust work, not plugin work, and it can start now. Slice 1 may land on `main` before it, but doesn't ship to production until it lands.

### Slice 1: the walking skeleton, on `needs-you`

**Goal.** Will answers the agent's questions full screen, by keyboard, in the hosted app, through a plugin whose only wiring is its manifest and the host contract. It is honestly a *compiled-plugin skeleton*: it proves the manifest, the loader, the host contract and the doors; slice 3's gate proves the public interface.

**What gets built, and nothing else:**
1. **`@smthrs/plugin`:** `Manifest` with the whole schema, `Manifest.check` and `Load`, with the host advertising only views, slots, commands, keybindings and view events (the rest refused `unsupported_point`); and `PluginHost`. 100% coverage, fuzzed decoding, kept counterexamples, docs and a library-catalog row.
2. **The core:** the `core/waits` projection over `runs`, replacing `needsQuery` as the header's source too; `run/answer` accepting `{ approved, note }`.
3. **The app's adapters, `apps/mvp/src/plugins/`:** `builtin.ts`, `builtin.engine.ts`, the contributions collection, the `PluginHost` implementation (`query`, `select`, `propose`, `dispatch`, `open`), the host's action strip, `<Slot>`, the keymap with `when` and the `$key` binding grammar, the view host for `/app/<plugin>/<path>` at inline and full sizes, and the `key` door.
4. **The `needs-you` plugin:** the manifest [above](#example-needs-yous-manifest-slice-1), the `Queue` view and the `NavCount` slot entry. The view draws the item (one fills the screen, oldest first) and calls `select` and `propose`; the host's action strip draws the options, Approve, Changes and the text box every item gets (PROC-10), and owns their keys. The Queue never dispatches `run/answer` itself, so slice 3 ports only its renderer (Fable, finding 1).
5. **Observability:** a `plugin.load` span per plugin (id, version, tier, outcome, reason), `smithers_plugin_loads`, `smithers_plugin_contributions` by point, and `flow.dispatch` with door `key`. No content.

**Not in slice 1:** Later (an ask's wait expires in 10 minutes, `src/features/status/contract.ts:30`, so a 24-hour snooze would silently drop it: Astra, finding 7), undo, hooks and item kinds, the Flows and Runs links (they move with their whole plugins), the `pack.json` conversion, apps, realm flows, repository and personal plugins, records.

**Acceptance.** Each item is a test that can fail:
- **e2e** on the real dev stack with the scripted agent: the agent asks three questions; `g n` opens the queue; the oldest fills the screen; `2` answers it from the host's strip; the asking run resumes and its card shows `Answered`; `j` moves on; the empty state shows. Keyboard only, both themes, with a GIF (TEST-3).
- **The strip is the person's:** the `Queue` component calling `dispatch` for `option` is refused `person_only`; a `propose`d note shows in the strip and isn't sent until the press.
- **Instant chat** (root `AGENTS.md`): with `run/answer`'s admission held unresolved, chat and navigation stay usable and the item shows Sending until the real result settles it; a failure stays visible and retryable.
- **Duplicates and staleness:** two presses record one answer; an answer to a question whose version moved shows `not_open` and never claims success.
- **Reload and offline:** a reload mid-send keeps the draft and the Sending state; an answer given offline goes through the outbox and lands on reconnect.
- **Two devices:** an answer on device B removes the item from device A's queue within one sync.
- **The deletion test:** CI removes `needs-you` from both lists and its folder, and boots with `plugins: []`; typecheck, `pnpm test` and every other e2e suite pass.
- **The fixture:** the printed manifest decodes, checks, loads and dispatches through the real loader, `option` from the `digit` key through `$key.index` included; a malformed manifest fails the build naming the field; an unsupported point, an unknown `$ref`, a keybinding with both `command` and `event`, a duplicate id and an undeclared `uses` each refuse with their reason.
- **Boot:** p50 of `smithers_web_boot_ms` grows by at most 5 ms, locally and live.
- **Production** (after slice 0): Will answers one real agent question in the hosted app's queue by keyboard. The receipt is the span and the GIF.

### Slice 2: durable asks and flows over flows

- **External asks.** `smthrs ask "<question>" --option … --priority 800 --deadline 3d` reaches `POST /api/asks`, which admits `ask/External` on `FlowExecution`: a wait addressed to the signed-in person with its own deadline, independent of any streaming answer. The lead and curator agents ask Will through Smithers. It needs the CLI's device-flow session (0008 §2, not built: `docs/features/sign-in.md:170`).
- **Later and undo, consistent with deadlines.** Later is offered only when the wait's remaining lifetime exceeds the snooze, and a snoozed item returns before its deadline. `u` undoes within a 5-second durable grace period before delivery. Tests cover Later across a deadline, reload and a second device.
- **Priority.** An ask carries a priority; the queue orders by it.
- **Flows over flows.** Run events from the runs index, `on: "run.*"` triggers with `over`, `run:observe`, and `run/inspect` for watchers. The first consumer is `needs-you/curate` over `todo` runs, dogfooded on our own work.

### Slice 3: apps in sandboxed frames, and the parity gate

**Gated: these land before slice 3 starts** (Fable, findings 2 and 3; they don't block slices 0 to 2):
- the host-drawn attribution label on every frame and realm view;
- the rule "the host never asks for a credential inline", in 0017 and 0008;
- password and credential-`autocomplete` inputs refused at admission and torn down at run time;
- the views-origin wrapper with `frame-src 'self'`, and a Playwright test that counts zero requests to foreign origins from a navigating app in Chromium, Firefox and WebKit;
- `src/pwa.ts:34`'s `FRAME_POLICY` narrowed from `frame-src https:` to the views origin, with web-page cards moved into their own views-origin wrapper.

**Built:**
- The app frame: the wrapper and app documents, their CSP, the frame runtime with React, the kit and `smithers:app`, the `MessageChannel` bridge with `select` and `propose`, navigation teardown, and `ui/app` for the agent.
- **The parity gate:** the `Queue` view also ships as a framed app from a personal plugin, using only the bridge, and passes slice 1's e2e. Until it does, extensibility is not claimed.
- Acceptance adds: an app with a timer and animation works inline and full screen; `fetch` from the frame fails; a navigation to another origin sends zero requests; an app with a password field fails admission; the label shows on every frame, full screen included; a forged message is dropped; a frame's `dispatch` of `run/answer` is refused, and `2` on the host's strip answers.

### Slice 4: review plugins, hooks and records

- The kernel's `collect` kind and `Load`'s explicit selection, tested on the real SDK path (two successful taps, one failing, a timeout, a crash and resume).
- **`review-media`:** a `media` block (GIF or video, a chapter timeline from `*.chapters.json`, the maintainer player's keys). Each recording to review is a wait the curator raises.
- **`review-code`:** `review-code/slice` on `github.push:main` cuts changed files into slices, each a wait with a `code` block. `plugin_records` lands with its first consumer: reviewed line intervals pinned to a commit, which changed lines invalidate. It is called review coverage, never "comprehensive" unless the inventory covers the source set (Sol, Astra).
- Both tap `needs-you/item-kind` and require `needs-you@^1`, which proves typed dependencies. The maintainer site's queue and GIF pages are deleted once every README feature is checked off.

### Slice 5: repository plugins and the realm flow host

- The QuickJS realm flow host on the browser engine and in the Worker: hand-edited personal flows run, and `FlowNeedsSandbox` remains only for code that needs a machine. It doesn't depend on the slices before it and can run in parallel with them.
- `plugin/refresh`, installation snapshots with ordered heads and tombstones, `owns`, `plugin_installations`, the plugin diff on the pull request card, and preview. These replace 0014's unbuilt `flow/refresh` and `flow_bindings` (`docs/features/flows.md:199`): one receipt for the repository's flows and plugins.
- `.smithers/home.json` becomes the implicit plugin's `repo/home` tap. The `work` board ships as `.smithers/plugins/work/` in `smithersai/smithers`.
- **Falsifier:** a pull request adds `.smithers/plugins/work/`; after the merge the Work tab appears with no app deploy; a broken manifest in a later merge leaves the previous snapshot active, showing `Merged · not active`; a removed plugin isn't revived by a delayed refresh.

### Slice 6: seams repositories can tap, and secret grants (M-47)

`triage/decide`, `notification/route`, `issue/transition` and `merge/rules` take repository taps, each with its algebra and failure rule, tested for failure, timeout, malformed output and replay. `plugin_grants` and the per-plugin egress, switched on only when their three tests pass. **Acceptance** is M-47's falsifier: "a repository flow changes who gets notified", and no secret value appears anywhere.

### Slice 7: the rest

Migration steps 2 to 11; the hand-written lists reach zero; personal plugins; `smthrs plugin add` and `update`; and the `pack.json` migration: lossless (skills and installed metadata kept), one runtime path, and a digest over every authority-bearing field (capabilities, `uses`, `owns`, contributions, `requires.plugins`, `userOnly`) and the whole file closure, with migration and digest-change tests (Astra, finding 8).

## Spec text

Write these now that Will has approved, after Fable's review.

**Root `AGENTS.md`:** replace the interim section "Everything is a plugin" (lines 63-80) with:

```md
## Everything is a plugin (Will, 2026-10-20, permanent)

Like webpack, Smithers is a small core plus plugins, and our own features are
plugins on the same public interface anyone uses. Everything a plugin does is a
flow, running locally or remotely in a sandbox (PLUGIN-1, M-55, decision 0017).

- **The core is primitives only:** the plugin host, flows and dispatch, runs,
  identity, access, sync, the shell and its slots, commands and keys, the UI
  kit and its sandboxes, attention, the model endpoint, secrets, system flows
  and telemetry. Everything else is a plugin.
- **One interface.** A plugin is a folder with a `plugin.json` manifest
  (`Plugin.Manifest` from `@smthrs/plugin`), its flows and its UI. First-party
  plugins get no private interface; if one needs something, the public
  interface gains it.
- **Config binds; code composes.** A manifest binds flows to commands, keys,
  views, slots, triggers and hooks. It never declares steps. Every flow is
  `Flow.make`; a prompt flow is a code flow; a flow can run over other flows.
- **Every plugin can ship a React app,** inline in chat or full screen, as the
  agent can. Only code compiled into the build runs in the app's realm.
  Everything else runs in a sandbox: plugin and flow code in the QuickJS realm,
  React apps in a sandboxed frame with a typed bridge to flows, and code that
  needs a machine in a container.
- **Never hardcode a feature into the shell.** Deleting a built-in plugin's
  folder and its line in the built-in list leaves an app that builds and passes
  every other test.
- **People act; plugins and agents don't act as them.** Agents, flows and apps
  run under a server-minted run credential and never the person's session. No
  plugin approves, merges or overrides a system flow. A person's merge
  activates a repository plugin; an Admin grants each secret to each plugin.
```

**`.specs/product/mvp.md`:**
- §2, a new rule 8: "**Everything is a plugin.** The app is a core of primitives plus plugins. Smithers' own features are plugins on the same public interface anyone uses to add flows and custom UIs, React apps included; a repository adds its own in `.smithers/plugins/<id>/` (M-55)."
- §3, a new vocabulary row: "**Plugin** | A folder with a `plugin.json` manifest, its flows and its UI, that adds to the app through declared contribution points: views, slots, commands, keys, cards, settings, triggers and hooks. Smithers' own features are plugins; a repository's live in `.smithers/plugins/<id>/`, and the flows they own in `.smithers/flows/` (M-49, M-55)."
- §7, **M-55**'s decision cell becomes (M-53 is taken, so this amends M-55):

> Everything is a plugin, like webpack. The app is a core of primitives: the plugin host, flows and dispatch, runs, identity, access, sync, the shell and its slots, commands and keys, the UI kit and its sandboxes, attention, the model endpoint, secrets, system flows and telemetry. Every other feature, Smithers' own included, is a plugin on one public interface: a `plugin.json` manifest (`Plugin.Manifest` in `@smthrs/plugin`) that binds `Flow.make` flows to views, slots, commands, keys, cards, settings, triggers and hooks. A plugin acts only through flows; a flow can run over other flows. Every plugin, like the agent, can ship an arbitrary React app shown inline in chat or full screen. Only code compiled into the build runs in the app's realm; plugin and flow code from a repository or a person runs in the QuickJS realm, React apps in a sandboxed frame with a typed bridge, and code that needs a machine in a container. A repository's plugins live in `.smithers/plugins/<id>/`, the flows they own in `.smithers/flows/` (M-49); a person's merge activates them, and an Admin grants each secret to each plugin. Agents, flows and apps act under a server-minted run credential, never the person's session; people merge, system flows stay non-overridable, and secrets stay opaque (rule 6, M-30, M-47). Design: `apps/mvp` decision 0017. Falsifier: deleting a built-in plugin's folder and its line in the built-in list leaves an app that builds and passes every other test; the app boots with no plugins; a repository adds a framed app and a notification policy by merging a plugin, with no app deploy; and the agent's credential can't answer a question meant for the person.

**`apps/mvp/docs/rulings.md`:** PLUGIN-1's and §0's "design pending" point to decision 0017. **Decision 0014:** `flow/refresh` and `flow_bindings` point to `plugin/refresh` and installation snapshots. **`docs/features/flows.md`:** `FlowNeedsSandbox` applies only to code that needs a machine, once slice 5 lands. **Decision 0008:** a new rule: host UI never asks for a credential inline; a secret or token is entered only on the core Secrets page or the sign-in flow (Fable, finding 2). **`apps/mvp/src/pwa.ts:34`:** `FRAME_POLICY` narrows to the views origin before slice 3.

## Review fixes (Astra and Fable, 2026-10-20)

### Astra

Astra's extra review found 4 P1s and 9 P2s. Each citation was checked against the code; all 13 hold, and none is rejected.

| # | Sev | Finding | Fix in this decision | Evidence checked |
|---|---|---|---|---|
| 1 | P1 | The person-only guarantee relied on catalog filtering; the server can't tell the agent from the person | Slice 0: a server-minted run credential with `act`, no cookie fallback, person-only routes refusing any `act`, confirmation receipts from host UI, refusal tests; slice 1 ships only after it | `worker/Actor.ts:20` has `act`; sign-in never sets it; `worker/Runs.ts:220-223, 248-255` checks only session, launcher and role; `registry.ts:137` only hides the flow from the model |
| 2 | P1 | The authority intersection had no enforcement contract; compiled code was presented as bounded | The invocation context in the run credential, attenuated per hop; `uses` checked against the caller at dispatch; UI dispatch under viewer ∩ plugin ceiling; compiled code stated as trusted; an adversarial nested-call test | `Flow/CapabilityCeiling.ts:14-37` attenuates but carries no origin; `worker/Actor.ts:14-26` has no plugin fields |
| 3 | P1 | Secret approval was repository-wide | `plugin_grants` per installation and secret or origin; egress policy from manifest ∩ ceiling ∩ grants; installation in placeholder scope; revocation per request; off until three tests pass | `worker/secrets/SandboxEgress.ts:22-50`: scope is repository, branch, generation; policy holds every repository secret |
| 4 | P1 | `narrow` wasn't a safe algebra, and fallbacks could bypass restrictions | Five semantics with combine and failure rules; `guard` for `issue/transition` and `merge/rules`, failing closed; audience narrowing restores mandatory members; selection pinned | `merge/rules` returns refusal reasons, `issue/transition` a decision, so a subset check fits neither |
| 5 | P2 | No public way for slice 1 to get data or dispatch | `PluginHost` (`query`, `dispatch`, `open`); the tab entry's `{ queries, actions }` Layer; `core/waits` over `runs`; view `reads` and `events` with host-bound `$item` and `$event` | `src/features/status/queries.ts:15-62` joins chat messages; `store.ts:40-88` is private |
| 6 | P2 | The kernel's `parallel` can't implement `collect`, and `first` isn't explicit selection | `collect` is a new kernel kind; `select` resolved and pinned by `Load`; durable child runs with replay-stable ids; tests on the real SDK path | `agent/plugin/src/Plugins.ts:113-118, 152-164`; `Hooks.ts:65-70` |
| 7 | P2 | A 24-hour snooze silently drops a 10-minute question | Later removed from slice 1; in slice 2 only for durable asks, offered only within the remaining lifetime | `src/features/status/contract.ts:30`: `ASK_WITHIN_MS` is 10 minutes; `flows.ts:129-140` falls back to unanswered |
| 8 | P2 | Replacing `Pack` dropped skills and kept a narrow digest and range grammar | Pack migration moved to slice 7, lossless, with a digest over every authority field and the file closure; `skills` kept; the range grammar stated; versions release-only | `registry/src/Pack.ts:113-119` (skills), `:260-281` (digest fields), `:307` (prerelease stripped), `:410-433` (grammar) |
| 9 | P2 | Repository flow ownership conflicted with Pack confinement | `owns` names `.smithers/flows/<name>/` entries resolved by the host; confinement kept for `flows`; one owner per flow; implicit plugin owns only unclaimed flows | `registry/src/Pack.ts:436-475` confines sources to the pack root |
| 10 | P2 | The typed policy templates the design relied on don't exist | Removed: repository taps are realm code with hook-schema output (Will's answer 2); byte-exact admission kept only for drafted prompt flows; one changed byte makes it realm code | `src/features/flows-ui/source.ts:42-76` (`input` string, `output` string, seat `agent`), `:97-109` |
| 11 | P2 | The example manifest couldn't validate its own contract | Bounded schemas with local `$defs` only; discriminated unions for keybindings, taps and events; events bound to flows with `$item` and `$event`; the printed example is a loader fixture | the old example's `#/$defs/ItemKind` had no definition |
| 12 | P2 | Activation and replay didn't pin enough | Immutable installation snapshots with dependency and flow closure, ordered heads (`stale_head`), tombstones, atomic triggers; runs pin snapshots; the built-in `plan_changed` and Retry contract stated with its dedup limit | `src/flows/dispatch.ts:35`; `src/features/status/flows.ts:146-151` (sealed, keyed answer) |
| 13 | P2 | The slice 1 deletion test proved less than claimed, and slice 1 was too broad | Slice 1 cut to five points, no Pack conversion, no hooks, no nav-only plugins; labeled a compiled-plugin skeleton; a parity gate in slice 3; acceptance adds pending admission, duplicates, staleness, reload, offline and two devices | root `AGENTS.md` "Instant chat"; `AppShell.tsx:26-27` |

### Fable

Fable reviewed the Astra-fixed decision: 3 P1s and 6 P2s, and a check of each Astra fix (all hold; fixes 1, 5, 11 and 13 had gaps that findings 1 and 4 close). Verdict: ready to build slices 0 and 1 once findings 1 and 4 are written in; findings 2 and 3 before slice 3. Each citation was checked; one sub-point of finding 9 is rejected.

| # | Sev | Finding | Fix in this decision | Evidence checked |
|---|---|---|---|---|
| 1 | P1 | A framed UI can't perform the person-only act it exists for, so slice 3's parity gate contradicted decision 9, and `digit` had no way to fill `option`'s payload | The host-owned action contract: person-only events drawn and keyed by the host's action strip; `select` and `propose` on the host contract and the bridge; focus stays in the host; the `$key` binding grammar and `keybindings[].fields`; `option`'s payload is `{ index }` and `args` picks `$item.options[$event.index]`; the compiled Queue uses the strip in slice 1; `confirm` only for protected acts | `src/flows/registry.ts:137` (`run/answer` is user-only); `src/features/status/flows.ts:167-169` (`modelInvocable: false`) |
| 2 | P1 | Nothing marks plugin pixels, so a plugin or the agent could imitate host UI and harvest a credential | A host-drawn label (title, tier, origin) on every frame and realm view; "the host never asks for a credential inline" (here and in 0008); password and credential-`autocomplete` inputs refused at admission and torn down at run time; typed text is the plugin's data; a threat row; gated before slice 3 | the brief's "unable to phish the person" had no answer |
| 3 | P1 | Self-navigation exfiltration was accepted, and the app page's policy allows it | A views-origin wrapper with `frame-src 'self'` refuses the navigation before the request; `load` teardown kept as depth; the residual becomes "none beyond the views origin"; `src/pwa.ts:34` narrows; a zero-foreign-request Playwright test per browser; gated before slice 3 | `src/pwa.ts:26-34` (`frame-ancestors 'none'` only; `FRAME_POLICY = "frame-src https:"`) |
| 4 | P2 | Slice 0 didn't say which runs get a credential or who sets `act` | The registry's `acts` mark; a person's run is only a root dispatch from a person door of a `person` flow; the server mints `act` from the run's own row; `app` added to `Actor.act`; a nested `chat/Answer` → `run/answer` test | `worker/Actor.ts:20` (`agent \| flow \| sandbox`) |
| 5 | P2 | The person-only list was hand-written and missed four user-only flows | Generated from the registry's `userOnlyReason` plus server-only acts listed once in `worker/Actor.ts`; `registry.test.ts` gains one refusal case per user-only flow | `src/flows/registry.ts:108-231` (16 `userOnlyReason` entries, `branch/share` at `:181`, `terminal/open` at `:185`) |
| 6 | P2 | The realm flow host stated no determinism or limits | `Date`, `Math.random`, `Proxy`, `WeakRef` and timers removed; time and randomness as journaled steps; the presentation realm's limits; plan at most 256 KiB; resume rebuilds and replays; host module versions in the snapshot digest | `ui/views/src/PresentationRealm.ts:86-93, 237-240`; `flows/flow/src/Flow/Flow.ts:148` |
| 7 | P2 | A triggered run has no person | Its principal is the plugin installation, `act: flow`, the tier cap, no person-only acts, the repository's model budget | 0012 §5 (installation token with no person present) |
| 8 | P2 | The confirm dialog could be spoofed or key-jacked | Server-sourced text naming the plugin; a 500 ms key delay; presses begun in a frame ignored; 3 confirms a minute; out-of-ceiling confirms refused before drawing | |
| 9 | P2 | Citation drifts and small contradictions | `registry.ts:121` → `:137`; `Actor.act` kinds stated (`agent`, `flow`, `sandbox`, plus `app`); `worker/ShapeProxy.ts` → `@smthrs/effect-electric`'s `ShapeProxy` (`worker/Chat.ts:155`); `flows.md:160` → `:162` and `:197` → `:199`; 0005's words quoted ("the smallest unit of trust", `0005:208`); the wrapper and `/app/<digest>` URL explained against 0004 §5's `srcdoc` (`0004:138, :157`); ImportRules allow `react` and `@tanstack/react-db`; every `minimum` is `member` with a `minimum_below_flow` check (`worker/Runs.ts:251`); a used flow's capabilities checked against the ceiling; `core/waits` carries `addressedTo` for slice 2 | each line read; see the next row for the one rejection |
| 9a | rejected | "Nothing in `apps/mvp/src` or `worker` uses QuickJS, so the agent's cells are design, not today" | Rejected: the app's agent runs its cells in `@smthrs/harness`'s `QuickJSSandbox` through `@smthrs/agent`, which the app uses; the row now cites it, and says plugin flow code in the realm is slice 5 | `packages/smithers/agent/src/Agent.ts:53`, `:1216`; `apps/mvp/docs/features/agent.md:46` |

## Differences and how they were resolved

All four panelists agreed on: a small core that enforces identity, access, secrets, system flows and durable execution; a declarative manifest read without running code; every action a `Flow.make` flow; no second graph model; prompt flows as code flows; local first, remote by need; untrusted code only in a sandbox; trust set by origin, never by the manifest; activation by merge with a pinned revision and last-known-good fallback; namespaced ids; no npm at run time and no marketplace; and the decision queue as the first proving plugin. They also agreed on no plugin JavaScript in a bridged frame, which Will's answer 1 overrode.

| # | Question | Opus | Fable | Sol | Astra | Resolved | Why |
|---|---|---|---|---|---|---|---|
| 1 | The package | extend `@smthrs/plugin`; drop `Pack.Manifest` | new `@smthrs/app-plugin` | extend `@smthrs/plugin` | new `@smthrs/plugins` | **Extend `@smthrs/plugin`** with Fable's fold; Pack migrates in slice 7 | `@smthrs/plugin` is public, on every platform (`docs/libraries.md:191`), with ordering and layer merging; `Pack` has a manifest, digest and range check. A new package would be a second manifest (SDK-11). |
| 2 | UI renderers | blocks, views, React for compiled-in | the same | realm views for all feature UI | the same as Sol | **Will's answer 1:** blocks, views, React apps in sandboxed frames for every plugin and the agent, components for compiled-in plugins | Will: "this is extremely important functionality just like how agent itself can directly do this". |
| 3 | Slice 1's queue | `needs-you` over waits and `run/answer` | full curated queue with tables and a remote curator | a repository-installed queue | the same, with records | **`needs-you` over waits** (Opus), cut further by Astra's review; the curator becomes a flow over flows in slice 2; the repository path is slice 5 | `run/answer` is built (`registry.ts:137`); the others need tables, a model-calling remote flow, or repository activation, none built. |
| 4 | Manifest format | `plugin.json` | `plugin.ts` for bundled | JSON | data | **`plugin.json` for every tier** | One file for us and everyone is what "no private interface" means. |
| 5 | Repository plugin flows | in the plugin folder | the same | `.smithers/flows/` | the same | **`.smithers/flows/`, claimed by `owns`** | M-49: discovered "there and nowhere else" (`.specs/product/mvp.md:549`). |
| 6 | Hook model | tapable kinds | extension points | typed refs, explicit selection | collect, select, narrow | **Five semantics with failure rules** | Sol's and Astra's semantics, Opus's kernel extended (Astra's finding 6). |
| 7 | Unknown point | refuse | skip and count | refuse | refuse | **Refuse `unsupported_point`** | Skipping half-loads a plugin silently. |
| 8 | Merge and grants | merge is consent | the same | explicit grant | pending until granted | **Merge grants repository acts; an Admin grants each secret and origin to each installation** | Maintainers merge by default (BR-7); Astra's P1 #3 makes grants per plugin. |
| 9 | Untrusted flow code | container only | QuickJS realm | container | container | **Will's answer 2: the QuickJS realm is a sandbox;** containers only for machine work | Will: "quickjs is a sandbox". Fable's `RealmFlowHost` is adopted. |
| 10 | Activation receipt | `plugin_bindings` | the same | an activation flow | an installation revision | **Installation snapshots**, replacing 0014's unbuilt `flow_bindings` | Astra's installation revision, hardened by finding 12. |
| 11 | Built-in plugin location | `apps/mvp/plugins/<id>/` | `src/plugins/<id>/` | packages | packages | **`apps/mvp/plugins/<id>/`** | A package per plugin adds publishing gates for code only this app runs. |
| 12 | The spec's id | new M-53 | new M-53 | unnumbered | at merge | **Amend M-55** | M-53 is taken (`.specs/product/mvp.md:553`). |
| 13 | The queue as product | yes, `needs-you` | maintainer queue | maintainer queue | maintainer queue | **Will's answer 3: yes, as a flow over flows, after dogfooding** | Will: "it will very likely end up as a workflow that can be ran on top of other workflows". |
| 14 | Preview | none | none | read-only | isolated | **A state, not a tier** (slice 5) | It adds no authority. |

## Prior art

| Source | What it does | What we take | What we leave |
|---|---|---|---|
| webpack and tapable ([concepts](https://webpack.js.org/concepts/plugins/), [plugin API](https://webpack.js.org/api/plugins/), [tapable](https://github.com/webpack/tapable)) | "Webpack itself is built on the same plugin system that you use"; Series, Parallel, Bail and Waterfall hooks; named taps | first-party features as plugins; one list of built-ins; hook kinds with declared semantics | in-process function taps for third parties (ours are flows) |
| VS Code ([contribution points](https://code.visualstudio.com/api/references/contribution-points), [activation events](https://code.visualstudio.com/api/references/activation-events), [webviews](https://code.visualstudio.com/api/extension-guides/webview)) | static `contributes`; implied activation; `engines.vscode`; webviews with a message bridge | a static manifest; implied activation; `requires.api`; `when` clauses; apps in a frame with a typed bridge | extensions as full-access code |
| Figma ([how plugins run](https://developers.figma.com/docs/plugins/how-plugins-run/)) | logic in a sandbox without browser APIs; UI in an iframe; message passing | flow code in the QuickJS realm; React apps in a frame; a typed bridge between them | logic calling a scene API (ours calls flows) |
| MCP Apps ([spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)) | interactive UI from a tool, in a sandboxed frame, talking to the host over a bridge | the agent's `ui/app` cards | |
| Backstage ([extension points](https://backstage.io/docs/backend-system/architecture/extension-points/), [frontend extensions](https://backstage.io/docs/frontend-system/architecture/extensions/)) | extensions attached by `attachTo`; "design for additions only"; `ExtensionBoundary` | slots; additions only; refuse a second claim; an error boundary per contribution | a deep extension tree |
| Obsidian ([security](https://obsidian.md/help/plugin-security)) | "cannot reliably restrict plugins" | nothing from outside the build in the app's realm | full-access plugins |
| Grafana ([plugin.json](https://grafana.com/developers/plugin-tools/reference/plugin-json)) | `includes` with `role`; actions prefixed by the plugin id; extension points | `minimum` per view; `plugin:<id>:*`; plugin-owned hooks | plugin backends as processes |
| Raycast ([manifest](https://developers.raycast.com/information/manifest)) | commands with arguments and preferences | commands as flows; settings | background interval commands |
| Vite ([plugin API](https://vite.dev/guide/api-plugin)) | `name`, `enforce`, `apply` | already in `@smthrs/plugin` | build-time hooks |
| Our own | `@smthrs/plugin`, `Pack`, `Flow.make`'s static fields, 0004's realm and frame, `placementOf`, `Actor.act`, the old `AppPlugin.ts` | every piece, joined into one interface | an interface with no consumer |
