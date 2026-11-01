# Landing

Development and maintenance of this repository land on append-only `main` with
jj, with no pull request ([AGENTS.md](AGENTS.md), "Commit and push to `main` with
jj"). Product TODOs in customer repositories still reach `main` through a pull
request a person merges.

1. Make a short-lived `jj workspace` from `main@origin` for one change. Never
   use the git CLI or a git worktree, and never edit another agent's files in a
   shared checkout.
2. Commit there with jj in the repository's message style.
3. Before pushing, run the changed packages' typecheck and tests, `pnpm
   docs:sync` and `pnpm docs:check` when docs changed, and scan the diff for
   secrets and private paths such as `/Users/...` (rulings HOST-10).
4. Fetch, rebase onto `main@origin`, point `main` at your commit, check that
   `main@origin..main` lists only your commits, and push `main`. Never rewrite
   `main`.
5. Remove the workspace.

## `apps/mvp` migrations

The migrator skips, for good, any migration numbered below the highest one
already applied. So a migration takes its number when it lands, not when it is
written: the next number above `main@origin`'s highest in
`apps/mvp/db/migrations`. On a clash, renumber the file, its registration in
`apps/mvp/db/Database.ts` and every reference. Never change a landed
migration's filename, number or bytes.

Deploying is separate from landing: see
[infrastructure](apps/mvp/docs/infrastructure.md#deploy).
