# Verified wiki before prompt planning

`PrepareWithWiki` is a private repository flow. It makes the existing wiki
workflow a durable upstream dependency of the existing `PreparePlan` flow.
Its input is the same `{ prompt, feedback }`; its success value is the existing
coding `Plan`, including any captured native head. A generated publication is
not a successful plan, implementation, vibed state or delivery receipt.

```ts
import { PrepareWithWiki, planningWikiLayers } from "./planning-wiki.ts"

const wiki = planningWikiLayers({
  repositoryPath,
  wikiOutput,
  pages: engineeringPageCatalog,
  reviewer: "configured-reviewer-policy"
})
// Compose this layer with the existing planning/memory/agent host layers.
const plan = yield* PrepareWithWiki.execute({ prompt, feedback: "" })
```

This adds no public package API, database, generator service or pointer store.
The host owns the page catalog, source and output paths, and reviewer identity.
That identity must describe the configured reviewer/model/route policy and change
when that policy changes; it is not a model-supplied label.
The caller also supplies the existing planning and memory layers, HumanTask,
`Interpreter.layer(PreparePlan)`, and `ReviewPage.layer` on `wiki/reviewer` with
the planning-authority helper. The reviewer inherits the parent's budget,
steering, seat routing and injected services. The old standalone wiki agent
runtime is not installed over that parent context. A prompt requesting no tools
is not a capability boundary; the host must apply the narrowing helper.

Each new request creates a real `coding/RefreshWiki` child. It captures its
operator configuration and asks the existing engine run catalog for one page
of at most twenty completed refreshes. A compatible refresh's native result is
only a hint to its earlier wiki child execution. The first generation invokes
`smithers/Wiki`; later compatible generations invoke `smithers/IncrementalWiki`.
Those existing flows collect exact source bytes and perform semantic review,
assessment and immutable publication through their ordinary actions.

The configured `coding/request` runs this dependency twice: before first
planning and again after the disposable POC. The latter refresh normally reuses
the unchanged reviewed pages. The host includes the selected wiki model and
owning gateway in the operator's reviewer identity, so changing those routes
invalidates reuse through this same protocol.

The configuration scope hashes the complete PageSpec catalog, reviewer identity,
canonical source root, configured output path, composition policy and lookup
limits. Source bytes are separately measured by the existing Collect action.
A different configuration falls back to ordinary first generation. A bounded
lookup miss also regenerates normally; it does not scan the remaining history
or trust a mutable publication pointer as a model receipt.

Existing reuse validation checks the terminal native run, committed attempt,
reviewer and policy identities, every page/source digest, section boundaries,
and the current exact-citation assessment. Unchanged pages do not call the
model again. Changed pages are reviewed again. The configured Smithers catalog
must include the four existing `policySources` files only when no trusted host fingerprint is supplied; that is an explicit
requirement of the current wiki recipe's reuse protocol, not a new generic
policy subsystem. Source files stay inside the configured public engineering
repository. Private Ops content is not an input.

The catalog admits at most thirty pages, 128 KiB of configuration JSON and
256 distinct source paths. Existing wiki file/page/section evidence limits
still apply. Prior-run inspection is bounded to 256 KiB per state record and
1 MiB across the one catalog page. No new retention or cache policy is added.

The internal refresh result is `{ scopeDigest, wikiRunId, receipt }`, recorded
as the ordinary native run result. It is not another ledger. The private
configuration and prior-selection actions are captured once per refresh
execution; resumed executions replay their existing decisions. A new request
recollects current source. The wiki writer checks source again before accepting
its publication; `PreparePlan` then performs its own normal gather and final
freshness checks, including after a human clarification wait.

Unsupported or uncertain semantic review fails the wiki child before planning
starts. The existing wiki writer retains its source-pinned `needs-changes`
artifact for inspection. The recipe does not relabel that draft as verified,
feed it to the planner, or infer correctness from matching hashes alone.

The native acceptance fixture runs on both Node and Bun with real JJ history,
SQLite, source collection, citation validation and immutable wiki artifacts.
It checks child ordering, restart replay, unchanged-page model reuse, targeted
source invalidation, reviewer-configuration invalidation, and refusal before
planning on unsupported prose. Semantic and planning decisions are scripted in
that fixture; it does not claim a live provider evaluation or deployed host.

The prior-review hint reads the latest 256 run IDs through the existing indexed
catalog, newest insertion first, and inspects at most 20 completed wiki-refresh
candidates within the existing 1 MiB state budget. The catalog's filtered
`listRuns` page is ascending and must not be mistaken for a recent page.
Collected parents or children are skipped. The window contains all flow kinds;
a large intervening workload can cause a normal cold-review miss. This is a
bounded optimization, never a guarantee that the newest refresh in all history
was found and never permission to reuse missing evidence.


The configured host reevaluates its external-output boundary during configuration,
child generation and immediately before publication after semantic review. The
writer uses that newly canonical destination with the explicitly supplied host
filesystem. A changed output ancestor cannot silently turn wiki publication into
an edit of the coding workspace. This is an option on the private wiki recipe;
it does not change the standalone wiki CLI's local artifact policy.

The configured coding host supplies its actual running reviewer fingerprint to
reuse policy. Such target repositories need only their own declared public page
inputs; they do not vendor Smithers' reviewer implementation. Standalone wiki
composition retains the older four-source policy when no host identity is
provided. The reviewer string also retains model, gateway and operator policy,
so a host upgrade cannot inherit a review under the old identity.

Required `checks/wiki` entries now run semantic review as ordinary asynchronous
backpressure after implementation and rewritten-source checks. They capture an
immutable native export and return owner findings without racing publication;
see `wiki-check.md` for the source, replay and catalog identity contracts.
