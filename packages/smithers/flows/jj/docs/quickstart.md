---
title: "Quickstart"
description: "Snapshot a real repository, diff two snapshots, and restore the working copy back out of one, in a single file against the jj CLI."
sidebar:
  order: 2
---

This quickstart runs the whole reversible-step cycle against a real repository:
take a snapshot, change a file, take another, read the diff between them, and
put the working copy back. By the end you will have seen the three operations
Smithers relies on to undo a step, and the commit id that pins each recorded tree. Each
step below is TypeScript; the [VibeLang tab](#the-same-walkthrough-in-vibelang)
runs the same steps as Effect code.

## Prerequisites

- Node.js 22.19.0 or later.
- `jj` on `PATH`. Check with `jj --version`; see
  [Installation](./installation.md) if it is missing.
- `@smthrs/jj` and its `effect` peer resolvable from the file you are about to
  write. [Installation](./installation.md) has the workspace form.

## Create a repository to work in

The layer operates on a repository; it never creates one. Make a throwaway:

```bash
jj git init ~/jj-quickstart
cd ~/jj-quickstart
```

## Write the program

Create `quickstart.ts` in that directory:

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Effect from "effect/Effect"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const repository = process.cwd()
const note = join(repository, "note.txt")

const program = Effect.gen(function*() {
  const jj = yield* Jj

  // Capture the working-copy tree without closing or describing its change.
  writeFileSync(note, "first\n")
  const first = yield* jj.snapshot("first note")

  // Do the work a step would do.
  writeFileSync(note, "second\n")
  const second = yield* jj.snapshot("second note")

  // Compare the two recorded trees, not `@-` (the working-copy parent).
  const diff = yield* jj.diff(first.commitId, second.commitId)
  console.log(diff)

  // Undo it. `restore` replaces the working copy with the recorded tree.
  yield* jj.restore(first.commitId)
  console.log(`note.txt is now: ${readFileSync(note, "utf8").trim()}`)
}).pipe(Effect.provide(NodeJj.layerAt(repository)))

Effect.runPromise(program)
```

`layerAt` binds jj to one absolute repository root, so a later change to
`process.cwd()` cannot redirect these operations into another checkout. Use
`NodeJj.layer` instead when the repository is genuinely whatever directory the
process is in.

## Run it

Run the file with your TypeScript runner, from the repository directory. It
prints the git-format diff between the two snapshots, then the content restore
recovered:

```text
diff --git a/note.txt b/note.txt
...
-first
+second

note.txt is now: first
```

## What just happened

On Node, Bun, and the browser, `snapshot("first note")` captured the
working-copy tree without describing or closing the change, and returned its
commit, change, and operation ids. The second snapshot captures another tree
in that same change.
The commit id is the durable handle: it names one tree forever, survives a
process restart, and is what Smithers stores in the journal. The change id is
a display name that follows later rewrites of the change.

`diff(from, to)` asked jj for a git-format unified diff between two revisions.
Both arguments go through jj's revision language, so `@`, `@-`, a commit id,
and a change id are accepted. Any other string, such as a revset, fails with
`invalid_ref` before jj runs, and an id that resolves to nothing fails with
`invalid_ref` rather than producing an empty diff. After native snapshots, `@-`
still names the working-copy parent; compare snapshot commit IDs to diff their
recorded trees.

`restore(commitId)` replaced the working copy with the tree recorded at that
commit. It is a replacement, not a merge: uncommitted edits are overwritten and
files created after the snapshot are removed. That is the property that makes a
step reversible, and the reason to reach for `revert` instead when you mean
"undo that one attempt and keep the rest".

## The same walkthrough in VibeLang

In [VibeLang](https://github.com/smithersai/vibelang) `snapshotDiffRestore` is
an `effect` function. A `.vibe` file has no `node:fs`, so it writes and reads
`note.txt` through Effect's `FileSystem` service, and it returns the diff and
the restored content instead of printing them. The caller provides
`jjAt(repository)` and a platform layer such as `NodeServices.layer`.

This is `examples/quickstart.vibe`. `test/quickstart.test.vibe` runs it, and
the package's docs check fails if this block and the file differ.

```vibe
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"

/** Binds jj to one absolute repository root, so a later working-directory change cannot redirect it. */
export const jjAt = (repository: string) => NodeJj.layerAt(repository)

/** Snapshots two versions of a file, diffs the recorded trees, and restores the first. */
export effect function snapshotDiffRestore(repository: string) {
  const fs = try FileSystem.FileSystem
  const path = try Path.Path
  const jj = try Jj
  const note = path.join(repository, "note.txt")

  // Capture the working-copy tree without closing or describing its change.
  try fs.writeFileString(note, "first\n")
  const first = try jj.snapshot("first note")

  // Do the work a step would do.
  try fs.writeFileString(note, "second\n")
  const second = try jj.snapshot("second note")

  // Compare the two recorded trees, not `@-` (the working-copy parent).
  const diff = try jj.diff(first.commitId, second.commitId)

  // Undo it. `restore` replaces the working copy with the recorded tree.
  try jj.restore(first.commitId)
  return { diff, restored: try fs.readFileString(note) }
}
```

## Next steps

- [Snapshot a working copy and put it back](./guides/snapshot-and-restore.md):
  the difference between `restore` and `revert`, and when each is right.
- [Give each parallel agent its own workspace lane](./guides/workspace-lanes.md):
  `workspaceAdd`, pinned revisions, and cleanup.
- [How a jj failure is reported](./concepts/failures.md): the seven codes and
  what each one means.
