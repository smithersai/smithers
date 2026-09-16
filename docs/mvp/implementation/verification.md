# Frontend verification record

Recorded 2026-09-16 22:16 UTC against the shared MVP working copy on main `6b98e2d2968a`. Pending source changes are part of the tested candidate; this base SHA alone does not reproduce it. The release owner must attach the landed revision and deployed verification separately.

Commands below ran from `apps/app` unless stated otherwise. Log names refer to the local verification machine; this tracked record preserves their outcome without relying on the logs remaining in `/tmp`.

| Check | Recorded outcome | Local log |
| --- | --- | --- |
| Declared full app suite: `bun run test` | **4,301 pass, 7 skip, 3 fail**, 4,311 tests in 416 files, 356.81s. All failures were SearchSeam's default five-second timeouts. No suite errors. | `/tmp/smithers-mvp-frontend-release-clean.log` |
| Exact failing file: `bun test src/mainview/state/seams/SearchSeam.test.ts` | **21 pass, 0 fail**, 79 assertions, 2.55s, with unchanged code and timeouts after concurrent heavy checks finished. | `/tmp/smithers-mvp-search-idle-recheck.log` |
| App typecheck: `pnpm run check` | **Exit 0**. Covers the final frontend implementation; the later trial-label correction was checked by the focused card suite below. | `/tmp/smithers-mvp-frontend-final-check2.log` |
| Bundled Chromium setup matrix | **6 pass, 0 fail**, 24.6s. The [capture record](README.md) names the command, exercised paths and explicit response fixtures. | [browser-results.txt](browser-results.txt) |
| Setup controller, card, typed inputs and conformance | **83 pass, 0 fail**, 1,254 assertions across four files, 6.28s. | `/tmp/smithers-mvp-final-pr-binding.log` |
| Final trial-label correction: `bun test src/mainview/cards/RepositorySetupCard.test.tsx` | **16 pass, 0 fail**, 52 assertions, 535ms. Issues/review trials always say “Replies drafted,” including a retained automatic-reply candidate. | `/tmp/smithers-mvp-trial-copy-test.log` |
| Repeated real TopicSocket server tests | **270 pass, 0 fail**, 30 iterations, 12.25s after explicit loopback binding and unconditional client cleanup. | `/tmp/smithers-mvp-topic-bound-repeat.log` |
| Five real transport/daemon fixture files | **56 pass, 0 fail**, 9.81s. | `/tmp/smithers-mvp-loopback-fixtures.log` |

The three broad-suite failures were the SearchSeam path query, history/run filters, and empty-query/recents cases. That run overlapped a full agent coverage suite, lint/typecheck and backend compilation. The isolated recheck is evidence of passing behavior under reduced load; it does not erase the original failures or establish the cause with certainty. No timeout was widened and no search product change was made for these failures. A separately discovered search repository-identity repair was still owned by the canary agent and was not included in this record.

The seven skips are the opt-in actual-host cases in `src/bun/TargetGraph.integration.test.ts`. They require `SMITHERS_HOST_WORKSPACE_TESTS=1` and explicit read/run workspaces; this run did not enable them. Their behavior is not established by the passing count.

The socket fixture repair followed measured evidence: a test readiness probe received the existing local daemon's `native_local_session_required` response while its own fixture recorded no connection. Binding both listener and client to `127.0.0.1` removed that collision in 30 repeated runs. Teardown now closes every tracked client, preventing failed tests from leaving reconnecting clients in later suites. Product transport code was unchanged.

Browser screenshots exercise the actual app bundle, keyboard, SQLite persistence, shared command registry and deliberately unresolved/running backend responses. They do not prove native execution, issue publication, registration activation, model quality, or production deployment. Those release gates remain in [ENGINEERING.md](../ENGINEERING.md).
