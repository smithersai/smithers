# Checks against immutable source

`checks.ts` is a private repository recipe. It registers `coding/CommandCheck`
with the existing executable catalog and `checkLayers(options)` with the
existing native action table. There is no additional executor or database.

## Pin a registered command

A project check is an ordinary discovered Markdown flow. Its verified body
contains the command declaration as its first nonempty line, for example:

```md
---
description: Verify the generated schema matches its declarations.
flows: ["coding/CommandCheck"]
capabilities: ["*"]
---
{"argv":["node","scripts/check-schema.mjs"],"cwd":".","timeoutMs":30000}
```

The plan names this flow and its existing `Descriptor.executionDigest`. Changing
the command changes that digest. The lowered Invocation carries the verified
body into the action payload, so the command also participates in its durable
step key. The implementation/check input and existing `checkInputDigest` bind the
result to the precise revision and check declaration.
The invocation also carries the registry's rendered resource context. Changes to
that context change the action payload; exact receipt matching still binds
validation to the recorded implementation and check input.
The registry appends a resource trailer and encoded arguments; the recipe reads
only that first JSON declaration line, so appended input cannot replace it.

## Export immutable source

The action asks Plue's `smithers-jj-export` to materialize the full commit ID in
a new temporary directory. It verifies the returned commit, tree and JJ change
IDs before running the command. The host must supply the intended read-only
exporter implementation; returned identity checks alone do not establish that an
arbitrary configured binary honors that contract. The command runs from its
exported source, while the acceptance fixture asserts
that the owning JJ operation remains unchanged. Arbitrary command confinement
still belongs to the host. Slow checks can read their original source while a
later atom is being edited. A new descendant revision gets a
different check input; an earlier receipt cannot validate it.
The recipe permits links that resolve inside the export, and refuses dangling
links or links into the live checkout or anywhere else outside it before a
checker starts. This prevents a committed dependency link from silently reading
mutable source. Commands still need the host's execution confinement.

## Run with explicit host policy

The command runs with literal argv, a contained relative working directory, a
bounded timeout, and a host-supplied build environment. It does not inherit the
gateway's environment by default. Dependency installation and runtime selection
belong to the project's declared command and existing toolchain; this recipe
does not borrow mutable `node_modules` from the editing checkout.
The example requires an explicit host `environment.PATH` containing `node`;
without a supplied PATH the command must name an absolute executable. Tools
that need HOME, a package cache or other build settings receive those explicitly.

## Retain measured receipts

Actual process exit zero produces a passing receipt. A nonzero exit produces a
failed receipt and finding for its current owning Change. Invalid exports,
missing executables, timeouts and unavailable cleanup fail execution instead of
inventing validation evidence. Output is drained and a bounded prefix is stored
in the existing receipt, with truncation disclosed.

## Close scratch after contained processes

The export directory and contained processes use Effect scopes. The recipe relies
on the injected runtime's scoped cleanup contract on success, failure and cancellation. It is a source snapshot, not a security
sandbox: the host must provide its existing process confinement when running
untrusted project commands. FileSystem, Path and ChildProcessSpawner are Effect
dependencies; the recipe does not select Node or Bun.

The private composition supplies its existing trusted `fs` as a service value,
captured before action workspace guards. Export lifecycle and validation of the exported tree use it; the
check process still runs through the action's permission-checked, contained
spawner. Temporary-directory permissions and process confinement are supplied
by the host; this recipe requests separate scoped scratch rather than writing
it into the editing checkout. Process evidence is nondeterministic for cache
purposes; a completed execution still replays its own recorded result.

New private structures are the JSON command declaration (`argv`, `cwd`,
`timeoutMs`) and `CheckHostOptions` (`repositoryPath`, existing host `fs`, optional `exporterPath`
and optional `environment`). The process result is converted into the existing
`Receipt` schema. No public package API or persisted table is added.
