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

## Persistence investigation — 2026-09-17 UTC

The saved production test profile lost its setup card across browser processes. Independent tests did **not** reproduce a setup-controller persistence defect:

| Probe | Actual result |
| --- | --- |
| Completed inspection, interrupted response, same-account reauthentication, and a held real SQLite commit during view changes | **4 pass**, 27 assertions, 2.94s. Cases, request identity and revision survive restart; reopening the same setup does not launch another inspection. |
| Full persistent Chromium close/relaunch on deployed `51ac0bd5dd5e5ec9090ca76f05888f2130d017b8`, with explicit API fixtures | **Passed**: one setup, two cases, revision 2 and the same completed request survived. The OPFS stream stayed `dbed380a-605c-4e4b-a2cd-0d1f1b08c910`; invoking the same setup again left the total inspection POST count at one. No final recovery-export/flush barrier preceded closure. This proves browser persistence with fixtures, not production execution. |
| Deliberate browser-level storage deletion in a separate, fresh persistent Chromium profile | **Reproduced the failure mechanism**: the directory became empty and cached file lookups returned `NotFoundError`, while a retained sync handle still wrote and flushed from 3 to 2,097,158 bytes. Reported filesystem usage grew to 3,145,728 bytes despite the empty directory. An ephemeral browser context invalidated its handle instead; that comparison was not representative. |

Local probe evidence is under `.artifacts/mvp-setup-persistence-review-20260916/`: `restart.log`, `browser-process-result.json`, `browser-recovery-summary.json`, and `opfs-unlink-persistent-result.json`. The deletion probe touched only its isolated fixture profile and origin.

The release owner's production captures independently show an actual `opfs` session, no unavailable recovery sources, an empty root in both page and storage worker, and `NotFoundError` for all three database files. Metadata-only inspection of the existing worker found a still-valid 483,328-byte sync handle. Its active stream was `5d4ec9ed-fa8f-46f6-91c9-35c1ba3a1712`, with no setup cards. OS metadata additionally placed Chrome's open QuotaManager under `Default/WebStorage-doomed-GYwuie`. Chromium's [storage-directory implementation](https://github.com/chromium/chromium/blob/main/storage/browser/quota/storage_directory.cc) moves retired storage into such directories. The deployed app worker uses the default OPFS directory, not a named bucket.

These observations support a live store retaining handles after its directory entries were removed. They do **not** identify the cause or actor. Production metadata is recorded in `production-profile-metadata-actual.json`, `production-profile-direct-files.json`, and `production-profile-worker-handles.json` under the release owner's local artifacts. No production reset, stored-card reconstruction or storage-code patch was performed for this investigation. The existing backend inspection/evaluation receipts remain separate evidence; they do not restore a missing local card.

The root console initially lacked the shared E2E profile lease; it acquired that lease at 00:09:55 UTC. **Controlled production restart passed at 00:26 UTC.** The lease remained held across normal browser closure/relaunch, with no reset, deletion or profile copying. Before fresh work, OS metadata confirmed QuotaManager under the ordinary `WebStorage/QuotaManager` path. Real repository inspection `eb298f77-af74-4584-b4bb-5f7d52a0038c` / `run-5` completed with two cases. A second full browser close/relaunch followed visible Evals and a screenshot, without a final recovery-export/flush barrier.

On reopened build `0f9a09764b589ddbab009bf1f674c7976e78ac92`, the OPFS files were discoverable and stream `c8b7e367-d7b4-4244-9b06-3a4d47266fb1`, the completed request, draft revision 2, both cases and the server-selected workspace survived. Repeating `/issues.setup` reused the same card; both reopening and repetition produced **zero additional inspection POSTs**. Evidence: `production-issues-inspect-leased-restart-proof.json`, `production-profile-setup-reopened.json` and `production-issues-inspect-leased-reopened.png` in the release owner's artifacts. This closes the controlled production inspection-persistence gate. It neither identifies the original deletion cause nor proves evaluation, trial, activation or other execution gates.
