# factory/queue/

The intake of the software factory. One markdown file per requested change;
presence is registration. The design is in the spec vault, a separate
repository: the "Software Factory" spec (process), the "Clean History" spec
(the `vibe`/`main` branch model), and the "Colocated Docs" spec (documentation
planes).

## Item format

```markdown
---
status: queued          # queued | in-progress | landed | retold | blocked
anchor: narrative       # narrative | head
priority: p1            # p0 | p1 | p2
---

The prompt: what to change and why, in plain prose.
```

- `anchor: narrative` bases the work lane on the commit in `main`'s retold
  series that owns the affected subsystem; the retell folds the change into
  that span. `anchor: head` bases on the tip and defers the fold.
- The item's digest keys its run. Editing an item re-keys exactly its own
  work; re-running a processed item is a cache hit.
- Processing order: docs → gate → implement → verify → land on `vibe` →
  retell into `main`. The docs phase holds writes to `docs/**` and package
  READMEs only; the implement phase holds code writes; the retell holds
  `vcs:write`.

## Operating it today

The only operator path is a factory flow: `bun factory/flows/<name>.ts` from
the repo root (see `../README.md`). No tracked flow consumes this queue yet;
item 0003 tracks the one that will. The earlier `queue-driver` workflow and
the `smithers workflow` verb are retired and are not an operator path.

Until item 0003 lands, an operator works an item by hand: flip its `status`
to `in-progress`, run docs → implement → verify in a short-lived worktree
lane based on `main`, land on `main`, then flip `status` to `landed` or
`blocked` in the same change. Only the operator of an active item edits its
`status` field.
