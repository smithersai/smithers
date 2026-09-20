# @smthrs/core

Release candidate scope, host requirements and compatibility review are defined in the [library support policy](https://github.com/smithersai/smithers/blob/main/RELEASE_SUPPORT.md).

This package declares `effect` as an exact
`4.0.0-rc.115` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://core.smithers.sh

Plan-time data model for flows. It defines Flow and Node declarations plus the graph, effect, placement, annotation, key-material, and Markdown projections consumed by the registry and execution layers above it.

JavaScript and TypeScript declarations and all planning callbacks must be trusted. `Graph.build` executes flow bodies, `Node.andThen` builders, `Node.catch` recovery callbacks, and an optional `resolveLayers` callback in the caller process with ambient process authority. Purity is a caller obligation, not an enforced boundary. Placement, capability, and effect metadata does not sandbox planning, including sandbox placement, empty capability grants, and sealed effects.

For agent-generated declarations, use a constrained data-only ingestion boundary that trusted code validates and translates into nodes, or load and plan untrusted code in an externally isolated environment with restricted permissions and resources. See [Plan time](https://core.smithers.sh/concepts/plan-time/#planning-requires-trusted-declarations). `TestRuntime` executes deferred callbacks for tests and also requires trusted code.

```sh
npm install @smthrs/core@next
```

The full API reference lives at [core.smithers.sh/reference/api](https://core.smithers.sh/reference/api/).

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/core/<Module>`.

| Module        | Public exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Description                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Annotations` | `empty`, `add`, `merge`, `getOption`, `Placement`, `Effects`, `Priority`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Builds and reads typed lexical annotations carried by plan nodes.                  |
| `Digest`      | `provideSync`, `digest`, `canonical`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Synchronous SHA-256 and canonical JSON for pure identity constructors.             |
| `Effects`     | `Declaration`, `MakeOptions`, `NarrowResult`, `make`, `covers`, `narrow`, `overlaps`, `sealed`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Normalizes effect declarations and checks path coverage, narrowing, and conflicts. |
| `Flow`        | `TypeId`, `Flow`, `Any`, `Reference`, `Seat`, `BodyDeclaration`, `Implementation`, `Input`, `Output`, `Error`, `FlowErrorCode`, `FlowError`, `MakeOptions`, `isFlow`, `make`, `agent`, `withCapabilities`, `within`, `annotate`, `annotateMerge`, `withFlows`, `withEffects`, `sealed`                                                                                                                                                                                                                                                                  | Declares callable, schema-described flows without executing them.                  |
| `Graph`       | `AnnotationsProjection`, `GraphNode`, `Edge`, `EdgeReason`, `Conflict`, `EffectEntry`, `PlacementEntry`, `LayerRequest`, `BuildOptions`, `GraphBuildErrorCode`, `GraphBuildError`, `isFatalDiagnostic`, `maximumGraphDepth`, `maximumPayloadDepth`, `maximumGraphNodes`, `maximumGraphEdges`, `maximumGraphConflicts`, `maximumPayloadMembers`, `maximumEffectPaths`, `maximumPlanEffectPaths`, `maximumEffectPathLength`, `maximumEffectGlobs`, `Graph`, `build`, `nodes`, `edges`, `effects`, `placements`, `conflicts`, `diagnostics`, `keyMaterial` | Builds and inspects closure-free graph topology and execution metadata.            |
| `KeyMaterial` | `InputRef`, `KeyMaterial`, `Entry`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Defines the stable key projection emitted from a built graph. Types only.          |
| `Markdown`    | `splitFrontmatter`, `MarkdownFrontmatter`, `SkillFrontmatter`, `SkillDocument`, `MarkdownErrorCode`, `MarkdownError`, `lowerMarkdown`, `validateSkillFrontmatter`, `parseSkill`, `lowerSkill`                                                                                                                                                                                                                                                                                                                                                           | Parses and lowers Markdown and Agent Skills declarations to core flows.            |
| `Node`        | `dynamic`, `functionIdentity`, `TypeId`, `Ast`, `Node`, `Any`, `Success`, `Error`, `DynamicOptions`, `NodeBuildErrorCode`, `NodeBuildError`, `CatchOptions`, `isNode`, `succeed`, `fail`, `all`, `capture`, `map`, `andThen`, `catch`, `within`, `priority`, `withEffects`                                                                                                                                                                                                                                                                              | Constructs the inert, pipeable plan AST.                                           |
| `Placement`   | `Options`, `Placement`, `local`, `client`, `sandbox`, `remote`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Creates serializable host-placement declarations.                                  |
| `TestRuntime` | `EvaluationErrorCode`, `EvaluationError`, `DynamicRequest`, `FlowCallRequest`, `Request`, `Resolver`, `evaluate`, `evaluateInline`                                                                                                                                                                                                                                                                                                                                                                                                                      | Evaluates in-memory node declarations in tests without host behavior.              |

```ts
import { Flow, Graph, Node, Placement } from "@smthrs/core"
import { Schema } from "effect"

const greeting = Flow.make({
  name: "greeting",
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.String,
  body: ({ name }) => Node.succeed(`Hello, ${name}`)
}).pipe(Flow.within(Placement.sandbox()))

const graph = Graph.build(greeting, { name: "world" })
```

`@smthrs/core/package.json` is also exported. `internal/*` and nested `*/index` subpaths are not public.

## Testing declarations

`TestRuntime.evaluate` executes the deferred maps, continuations, and recovery
arms stored in an in-memory Node AST. Dynamic nodes and flow-call leaves cross
one explicit deterministic resolver. `evaluateInline` also enters called flows
that carry an in-memory body. Both refuse malformed or excessively deep
declarations with `EvaluationError`.

This is not a substitute for the durable engine: it deliberately has no
capabilities, persistence, scheduling, retries, cache, concurrency, or output
schema enforcement. Use it for unit tests of node-building libraries, then use
engine integration tests for host semantics.

## Identity and caching

`Graph.keyMaterial` is the digest-free projection `@smthrs/plan` compiles into step keys, so two declarations with equal key material are the same step.

An unannotated mapper, continuation, or flow body receives a process-local `sha256-source-ephemeral/v4` identity, because JavaScript cannot inspect closure state: two processes give the same function two different digests. Only `Node.capture` produces the cross-process-stable `sha256-source-captures/v4` identity, by folding the canonicalized inert values a function closes over into its digest. A step whose result must survive a restart has to declare its captures.

```ts
const scaled = Node.capture({ factor: 3 }, (value: number) => value * 3)
```

Capture data must be finite, inert, plain data. Accessors, cycles, non-finite numbers, symbols, functions, and non-plain prototypes are rejected rather than hashed incompletely, and accepted capture data is copied and deeply frozen. A function expression reads the copy through its `this` receiver; the returned function keeps its ordinary arguments. Caller objects remain unchanged. Built-in brands and Proxies are refused, and object capture requires `structuredClone`. Captures are compared by structural value: two references to one shared object digest identically to two structurally equal copies, so aliasing is not identity.

## Failure behavior

Construction failures throw; declaration failures are recorded.

| Surface                                                                              | Failure                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Flow.make`, calling a flow, `Graph.build` on a bodyless flow                        | throws `FlowError` with code `missing_body`                                                                                                                                                                                                                                                                                       |
| `Node.all`, `Node.priority`, continuation elaboration, an unrepresentable plan value | throws `NodeBuildError` with code `invalid_all_member`, `invalid_continuation`, `invalid_priority`, or `unrepresentable_value`                                                                                                                                                                                                    |
| `Node.capture` on a non-function operation or non-inert capture data                 | throws `TypeError`; a capture-data failure names the offending path in its `Node.capture:`-prefixed message                                                                                                                                                                                                                       |
| `Markdown.parseSkill`, `Markdown.lowerSkill`, `Markdown.validateSkillFrontmatter`    | returns `Result.fail(MarkdownError)` with code `skill_missing_frontmatter`, `skill_invalid_frontmatter`, `skill_missing_name`, `skill_invalid_name`, `skill_missing_description`, `skill_invalid_description`, `skill_invalid_allowed_tools`, `skill_invalid_compatibility`, `skill_invalid_metadata`, or `skill_invalid_license` |
| `Graph.build` on an invalid declaration                                              | records `GraphBuildError` in `Graph.diagnostics` with code `effect_outside_envelope`, `effect_mode_widening`, `effect_tier_widening`, `write_conflict`, `capability_outside_grant`, `duplicate_node_id`, or `missing_key_material`                                                                                                |
| `Graph.build` on a malformed or oversized plan                                       | throws `GraphBuildError` with code `invalid_node`, `plan_too_deep`, `plan_too_large`, `payload_too_deep`, or `payload_too_large`                                                                                                                                                                                                  |
| `Graph.keyMaterial` on a graph carrying a fatal diagnostic                           | returns `Result.fail` with that diagnostic unchanged; `Graph.isFatalDiagnostic` reports which codes block it                                                                                                                                                                                                                      |

## Limits

`Graph.build` enforces documented bounds on the plan structure it walks. These bounds do not limit callback execution or make untrusted JavaScript or TypeScript safe to plan. `Graph.maximumGraphDepth` bounds nested node structure and `Graph.maximumPayloadDepth` bounds a reflected plan value; both refuse with `plan_too_deep` or `payload_too_deep`. `Graph.maximumGraphNodes`, `Graph.maximumGraphEdges`, and `Graph.maximumGraphConflicts` bound plan width, counting synthesized lane merges and the edges the write-conflict pass adds, and refuse with `plan_too_large` naming the node whose admission crossed the limit. `Graph.maximumPayloadMembers` bounds the members one plan value expands to across every level (object keys, array items and holes, map entries, set and chunk values, and bytes) and refuses with `payload_too_large` naming the offending value path; the effect paths of a flow placed inside a plan value count as its members. `Graph.maximumEffectPaths` bounds the read and write paths, summed, of one effect declaration, including a synthesized lane merge, and `Graph.maximumPlanEffectPaths` bounds the paths admitted across the plan, counting a declaration where it is declared and again at every work node that inherits it. Both refuse with `plan_too_large` naming the node that declared or inherited the paths, before a path is copied: declared and inherited envelopes are admitted while the plan is visited, before the write-conflict pass runs, and a lane merge as it is synthesized. Every limit is checked before the structure it guards is allocated: an array-backed declaration is refused by its lengths without reading a member, and a caller-assembled iterable is copied no further than the limit. `Graph.maximumEffectPathLength` bounds one effect path at 4096 UTF-16 code units, `PATH_MAX` on Linux, and `Graph.maximumEffectGlobs` bounds the patterns (entries ending in `*`) one read list or one write list may carry at 128. Both refuse with `plan_too_large` naming the node, or `payload_too_large` naming the value path for a flow placed inside a plan value, and both are read from the path's length or last character as it is admitted, before any character of it is scanned and before any pair is compared.

These limits bound the planner's structural analysis; they do not bound work performed by caller-supplied code. Each distinct path is scanned once for a dot segment and sorted once, so the character work of a build is at most `maximumPlanEffectPaths` paths of `maximumEffectPathLength` code units, plus the comparisons that sort them. A pattern's prefix is located once by binary search, patterns nested under another collapse into the outermost, and every match after that is an integer comparison, so `Effects.overlaps` costs the two declarations plus their matches however many patterns nest, and 16 writers of the widest nested declaration the limits admit build in well under a second. An envelope is prepared once and every node it encloses is checked against the prepared form, so `Effects.narrow` inside a build costs the envelope once plus one lookup and one binary search per enclosed path. The write-conflict pass marks candidate pairs from one index of every writer's paths; its pattern term is one step per path a pattern covers per writer holding that path, at most `maximumGraphNodes` times `maximumPlanEffectPaths` steps for a plan of universal writers, about two seconds on an idle developer machine (a loaded one takes two to three times longer; the bound, not the figure, is the contract). The widest shared-literal conflict set the limits admit, 362 writers sharing 181 paths under `onConflict: "fail"`, builds in about two seconds including its 65,341 diagnostics.

`Markdown.parseSkill` enforces the intrinsic rules of the Agent Skills specification: a `name` of 1 to 64 lowercase ASCII letters, digits, or single hyphens that does not start or end with a hyphen, a `description` of 1 to 1024 characters counted in code points, a scalar `allowed-tools`, a scalar `license`, a `compatibility` of 1 to 500 characters, and `metadata` mapping string keys to scalar values. `Markdown.validateSkillFrontmatter` applies the same rules to already-parsed frontmatter. The rule that `name` equals the skill directory name needs the file system and stays with `@smthrs/registry`.

## Mutability

A built graph is deeply frozen, so `Graph.nodes`, `Graph.edges`, `Graph.conflicts`, and `Graph.diagnostics` hand back the graph's own values and an observer cannot edit the plan it is reading.

Plan values are not copied. `Node.succeed`, `Node.fail`, and a flow call retain the caller's value by reference and read it when the graph is built, so mutating one between construction and `Graph.build` changes the recorded identity.

## Lanes

The `LaneMerge` node this package synthesizes when two conflicting writers declare `onConflict: "lane"` is plan-time vocabulary. No runtime in this release executes a lane, and the elaboration deliberately does not cross into `@smthrs/flow`. Treat a lane as a declaration a future scheduler may honor, not as a scheduling guarantee. Nothing declares a lane directly: `Node.lane` and `Annotations.Lane` were a second spelling of `onConflict: "lane"` with no caller, and the write-conflict pass is the only thing that assigns one.
