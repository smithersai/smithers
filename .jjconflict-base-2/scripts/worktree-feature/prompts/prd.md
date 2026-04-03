# Worktree + MergeQueue PRD

This is the full PRD for the `<Worktree>` and `<MergeQueue>` feature. It is embedded in
the system prompt so all agents have full context. The original plan file lives at:
`/Users/williamcory/.claude/plans/wobbly-marinating-leaf.md`

Agents: read that file for the full PRD content. It contains all 5 parts:
1. Framework changes (types, components, extract, scheduler, engine, vcs/jj)
2. Tests (worktree, jj-workspace, merge-queue)
3. Documentation (worktree.mdx, merge-queue.mdx, parallel-worktrees example, vcs guide updates)
4. Workflow script changes (scripts/smithers-workflow/ updates)
5. Implementation details (CLI agent cwd, auto-snapshotting, static tasks, skipIf pattern, MergeQueue review)
