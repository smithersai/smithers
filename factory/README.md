# factory/

Smithers' own coding factory. Target workflow:

```text
GitHub issue -> Smithers Cloud run -> checks/review -> main -> GitHub sync
                                                        -> wiki refresh
                                                        -> issue receipt
```

This is the operating target, not a claim that the Cloud loop is qualified.
Prioritize blockers to completing this loop before adding features. Local
Codex/Claude work is transitional bootstrap or repair; record each blocker in
an issue. GitHub remains synchronized; Cloud owns the coding and CI/CD work.

- `queue/` — legacy intake needing reconciliation with GitHub issues. Files do
  not prove that a job is registered or running. See [queue/README.md](queue/README.md).
- `flows/` — existing local factory tooling, not evidence of Cloud deployment.
  Canonical file flows use `flows/<name>/flow.ts` and the root AGENTS.md contract.
- `coding/project.ts` — repository coding checks and host configuration.
- `wiki/` — source catalog and engineering wiki recipe; reuse the existing app
  wiki workflows and preserve their source/review receipts.
- `reports/` — runtime reports and logs, not tracked.

Land and push on `main`; remove temporary worktrees after landing. Old `vibe`
integration branches and retelling `main` are not supported operating paths.
Close issues and refresh documentation from real completion evidence.

Tracking: [Cloud issue automation](https://github.com/smithersai/smithers/issues/1695),
[wiki refresh](https://github.com/smithersai/smithers/issues/1651), and
[backlog reconciliation](https://github.com/smithersai/smithers/issues/1708).
