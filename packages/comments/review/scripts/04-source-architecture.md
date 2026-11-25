# Smithers Comments — 3-Builder Synthesis & Final Architecture

## card: _Three-Builder Architecture_|Gemini, Claude Fable & Codex Astra -> Final From-Scratch

Three models built Smithers Comments independently from the exact same docs and test contract, with zero visibility into each other's code. Then we benchmarked and audited all three, and wrote the final implementation from scratch taking the strongest design from each.

## code: Head-to-head benchmark results · nyc-01

```text All four pass 0 type errors, 43/43 tests, 3,800 fuzz runs
Metric                  Gemini     Fable      Astra      Final src/
----------------------  ---------  ---------  ---------  -----------
Lexer (1.35 MB, 20k)    100.3 ms   124.1 ms   299.5 ms   60.5 ms
Lexer throughput        13.2 MB/s  10.6 MB/s  4.4 MB/s   21.8 MB/s
Cache cold -> warm      262->8.5   486->110   1542->218  317->11.3 ms
Cache warm speedup      30.8x      4.4x       7.1x       28.1x
VirtualTree (200/1k)    34.4 ms    19.8 ms    136.8 ms   22.8 ms
Footprint               13 / 37KB  19 / 187KB 15 / 96KB  17 / 158KB
```

```text Key CLI latency optimization in Final src/
vibelang/register   26 ms
Config + Effect    201 ms
@smthrs/engine   1,317 ms  -> lazy-imported only on check/fix!
External E2E test: 30.0s -> 9.5s (3.1x faster end-to-end)
```

The final from-scratch build beats every individual builder on lexing at sixty point five milliseconds, keeps near-instant twenty-two point eight millisecond virtual projection, and achieves twenty-eight point one times warm cache speedup while executing real Smithers Flow DAGs.

## compare: _Best-of-three design decisions_

```text What we synthesized from each builder
Gemini
  + Single-pass charCodeAt lexer (zero inner regex slicing)
  + O(1) warm-cache fast path bypassing engine startup

Claude Fable (claude-fable-5-2)
  + True @smthrs/plan DAG: Lookup -> Node.branch -> Check -> Store
  + Pure projectFileSync + safe */ and --> delimiter escaping
  + DocTags backtick filtering, restatesCode & reanchorSidecar
  + commandAgentLayer for live CLI model execution

Codex Astra (gpt-6-astra)
  + Rust raw strings r#"..."# & mid-line token-glue spacing
  + Comment-masked symbol extraction & bounded code regions
  + Arbitrary-depth backslash escaping in sidecars
  + confinedPath symlink guard, atomicWrite & extract rollback
```

```text Final src/ module layout (17 files, 4,627 LOC)
Core:     Config, Lexer, Anchor, Sidecar, VirtualFile, Extract
Runtime:  Cache, Validator, Agent, Flows, Targets, Cli, index
Internal: FsSafe, DocTags, Repair, Repository
```

Instead of patching one draft, every subsystem was written clean from scratch: Gemini's fast lexer and O-of-one warm cache path, Fable's declarative Smithers plan DAG and pure projection, and Astra's symlink confinement, atomic rollback, and comment-masked symbol anchoring.

## code: Declarative Smithers Flow DAG · src/Flows.ts

```ts src/Flows.ts · CheckFileFlow over FlowEngine
const verdictNode = (pending: PendingComment, readCache: boolean) =>
  LookupVerdictAction.call({ key: pending.cacheKey, read: readCache }).pipe(
    Node.branch({
      if: (found) => found.hit,
      then: (found) => Node.succeed(found),
      else: () =>
        CheckCommentAction.call(pending.request).pipe(
          Node.bindPlanned((response) => StoreVerdictAction.call({ key: pending.cacheKey, response }))
        )
    })
  )
```

```ts src/Targets.ts · Smithers Workspace Targets
export const targets = (options) => ({
  "comments:sources":  Smithers.Filegroup({ ... }),
  "comments:check":    Smithers.Shell.Test({ ... }),
  "comments:virtual":  Smithers.Generate({ ... }),
  "comments:view":     Smithers.Materialize({ ... })
})
```

Every layer composes cleanly with Effect services — `AgentValidator` and `CommentCacheStore` swap via layers, `CheckFileFlow` branches declaratively on cache hits, and `targets` plugs straight into any Smithers workspace.
