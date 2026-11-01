# Stranded commits: ~/smithers

Part of [stranded commits](stranded-commits.md): method, classes and the landing ledger are there.

## ~/smithers classification (since 2026-10-02)

Repository `/Users/williamcory/smithers`, main `6c9e4781c25b`, judged against main@origin `6c9e4781c25b` on 2026-11-01T22:35:31.103Z.

Candidates: `((((~::main@origin & ~empty() & ~::remote_bookmarks(remote=origin)) & committer_date(after:"2026-10-02")) ~ (::remote_bookmarks(remote=w12hold))) ~ (e092c5a2a4d96c3a4eedbd8ac063b021955e6a07 | 3b44c0a6380844240835b6112ea218c116ce7ca4 | 6f9b089faa321e703fb53db75643c3c8468ee216 | aa2bd008672f147840409cd8540e3f3e907c8ddf | d6531b2f13d360e4be67b12ad9a09e935de03018 | d6531b2f13d360e4be67b12ad9a09e935de03018 | 79ae50477db1bd1335e787178939ed2a0c0bc711)) ~ (158a9154ed0638eaddb4896aa76fcbe38bf9f2e4 | bc2a3d585828d8cfc3957b24cd15b725a607a30f)`.

| Class | Commits |
|---|---|
| EMPTY-ISH | 11 |
| ON-MAIN | 685 |
| PARTIAL | 940 |
| SCAFFOLD | 12 |
| STRANDED | 136 |
| SUPERSEDED | 1633 |

### Heads

Net: the head against its fork point with main: hunks on main / superseded / missing / partial, and missing lines.

| Head | Bookmark / working copy | Commits | Classes | Net on/superseded/missing/partial (lines) | Missing files |
|---|---|---|---|---|---|
| `2ece571644` |  | 3 | undefined 3 | 0/0/0/0 (0) |  |
| `5686bc4bfc` |  | 132 | PARTIAL 105, EMPTY-ISH 1, ON-MAIN 9, STRANDED 7, SUPERSEDED 10 | 47/1/3524/614 (45492) | .agents/skills/vibelang/SKILL.md (86), .gitignore (1), .prettierignore (1), .smithers/flows/bench/README.md (1) |
| `775f26b754` |  | 118 | PARTIAL 93, ON-MAIN 8, STRANDED 8, SUPERSEDED 9 | 41/1/3379/607 (44020) | .agents/skills/vibelang/SKILL.md (86), .gitignore (1), .prettierignore (1), .smithers/flows/bench/README.md (1) |
| `faf3ec5b89` |  | 93 | PARTIAL 82, ON-MAIN 2, STRANDED 6, SUPERSEDED 3 | 41/1/3043/581 (36541) | .agents/skills/vibelang/SKILL.md (86), .gitignore (1), .prettierignore (1), .smithers/flows/bench/README.md (1) |
| `d977f8f878` |  | 77 | PARTIAL 68, STRANDED 6, SUPERSEDED 3 | 41/1/2862/498 (32845) | .agents/skills/vibelang/SKILL.md (86), .gitignore (1), .prettierignore (1), .smithers/flows/bench/README.md (1) |
| `cda4f0dd87` |  | 2 | PARTIAL 1, ON-MAIN 1 | 43/7/0/0 (0) |  |
| `8372477664` |  | 68 | PARTIAL 60, STRANDED 5, SUPERSEDED 3 | 40/1/2783/473 (31079) | .agents/skills/vibelang/SKILL.md (86), .gitignore (1), .prettierignore (1), .smithers/flows/bench/README.md (1) |
| `fea394ac50` |  | 1 | STRANDED 1 | 0/0/1/0 (4) | apps/mvp/worker/TimelineSummaries.ts (4) |
| `bde074effb` |  | 1 | PARTIAL 1 | 0/0/4/1 (139) | apps/mvp/db/Database.ts (120), apps/mvp/docs/decisions/0133-timeline-phases.md (12), apps/mvp/src/features/timeline/store.test.ts (3), apps/mvp/worker/TimelineSummaries.ts (4) |
| `523f7daeb1` |  | 1 | STRANDED 1 | 0/0/3/0 (26) | apps/mvp/src/features/timeline/view.test.ts (7), packages/smithers/ui/src/chat/ChatTimeline.tsx (3), packages/smithers/ui/tests/timeline-entry-labels.test.tsx (16) |
| `9ccdbed588` |  | 11 | ON-MAIN 1, PARTIAL 7, SUPERSEDED 3 | 33/4/2/5 (49) | apps/mvp/docs/decisions/0133-timeline-phases.md (17), apps/mvp/src/features/timeline/notice.test.ts (10), apps/mvp/src/features/timeline/notice.ts (6), apps/mvp/src/features/timeline/phase-follower.in |
| `9f4603355d` |  | 4 | PARTIAL 3, SUPERSEDED 1 | 33/4/2/5 (49) | apps/mvp/docs/decisions/0133-timeline-phases.md (17), apps/mvp/src/features/timeline/notice.test.ts (10), apps/mvp/src/features/timeline/notice.ts (6), apps/mvp/src/features/timeline/phase-follower.in |
| `5c06bc2a31` |  | 4 | PARTIAL 3, SUPERSEDED 1 | 33/4/2/4 (42) | apps/mvp/docs/decisions/0133-timeline-phases.md (17), apps/mvp/src/features/timeline/notice.test.ts (9), apps/mvp/src/features/timeline/notice.ts (7), apps/mvp/src/features/timeline/phases.test.ts (1) |
| `27e3332cdd` |  | 7 | PARTIAL 6, SUPERSEDED 1 | 30/4/3/6 (56) | apps/mvp/docs/decisions/0133-timeline-phases.md (17), apps/mvp/docs/features/timeline.md (1), apps/mvp/src/features/timeline/notice.test.ts (12), apps/mvp/src/features/timeline/notice.ts (3) |
| `5f5c01367b` | builder/stack-flake | 12 | ON-MAIN 4, SUPERSEDED 8 | 0/0/0/0 (0) |  |
| `1de5e182cf` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `0db52eb270` | builder/stack-flake | 12 | ON-MAIN 4, SUPERSEDED 8 | 0/0/0/0 (0) |  |
| `866e2f8d10` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `4e42c3bae8` | builder/stack-flake builder/stack-flake builder/stack-flake | 11 | ON-MAIN 3, SUPERSEDED 5, PARTIAL 3 | 199/21/3/40 (71) | apps/mvp/db/migrations/0076_merge_flow.ts (1), apps/mvp/docs/decisions/0133-merge-flow.md (6), apps/mvp/docs/decisions/0134-independent-lanes.md (9), apps/mvp/docs/decisions/0135-external-agents-on-ru |
| `e7b5a39485` |  | 7 | PARTIAL 2, SUPERSEDED 4, SCAFFOLD 1 | 92/41/4/10 (71) | apps/mvp/db/Database.test.ts (12), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0075_timeline_phases.ts (7), apps/mvp/docs/decisions/0133-timeline-phases.md (12) |
| `b665026cf8` |  | 8 | PARTIAL 6, SUPERSEDED 1, SCAFFOLD 1 | 97/37/4/10 (64) | apps/mvp/db/Database.test.ts (12), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0075_timeline_phases.ts (7), apps/mvp/docs/decisions/0133-timeline-phases.md (8) |
| `78e0972cba` | builder/answers-fix | 2 | ON-MAIN 2 | 0/0/0/0 (0) |  |
| `86021e62c1` |  | 1 | PARTIAL 1 | 0/0/0/1 (38) | apps/mvp/e2e/toast-layout-shift.spec.ts (38) |
| `759b8ee64c` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c5bd6f21fd` | builder/s3-steer | 5 | SUPERSEDED 2, PARTIAL 1, ON-MAIN 2 | 285/10/7/46 (134) | apps/mvp/db/Database.ts (8), apps/mvp/db/migrations/0075_merge_flow.ts (2), apps/mvp/db/migrations/0077_agent_runners.ts (25), apps/mvp/db/migrations/0079_agent_stops.ts (2) |
| `2554588b75` | builder/s3-steer | 5 | SUPERSEDED 2, PARTIAL 1, ON-MAIN 2 | 285/10/7/46 (134) | apps/mvp/db/Database.ts (8), apps/mvp/db/migrations/0075_merge_flow.ts (2), apps/mvp/db/migrations/0077_agent_runners.ts (25), apps/mvp/db/migrations/0079_agent_stops.ts (2) |
| `fafb7b4b72` | builder/byok builder/byok | 4 | ON-MAIN 3, PARTIAL 1 | 54/4/0/1 (3) | apps/mvp/e2e/personal-model.spec.ts (3) |
| `32cd3a0296` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3e25393fcd` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d4b99ce31b` | builder/byok | 4 | ON-MAIN 3, PARTIAL 1 | 53/4/0/1 (3) | apps/mvp/e2e/personal-model.spec.ts (3) |
| `940f8a206a` |  | 3 | PARTIAL 1, ON-MAIN 2 | 268/12/7/51 (212) | .changeset/agent-steer-and-stop.md (3), apps/mvp/db/Database.test.ts (10), apps/mvp/db/Database.ts (8), apps/mvp/db/migrations/0075_merge_flow.ts (2) |
| `c32827324b` |  | 1 | PARTIAL 1 | 78/43/3/10 (43) | apps/mvp/db/Database.test.ts (2), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0075_timeline_phases.ts (8), apps/mvp/docs/decisions/0131-timeline-phases.md (12) |
| `ab6868b4a9` |  | 1 | PARTIAL 1 | 0/0/0/1 (35) | apps/mvp/e2e/toast-layout-shift.spec.ts (35) |
| `1e8eb7c87f` |  | 1 | PARTIAL 1 | 22/2/11/10 (83) | .changeset/toast-stack-anchored.md (1), apps/mvp/docs/decisions/0009-notifications-and-live-work.md (1), apps/mvp/docs/decisions/0015-agent-status.md (1), apps/mvp/docs/decisions/0036-toasts-reserve-p |
| `c32430ee25` |  | 3 | PARTIAL 1, ON-MAIN 2 | 268/12/7/51 (212) | .changeset/agent-steer-and-stop.md (3), apps/mvp/db/Database.test.ts (10), apps/mvp/db/Database.ts (8), apps/mvp/db/migrations/0075_merge_flow.ts (2) |
| `2115d4a452` |  | 3 | PARTIAL 1, ON-MAIN 2 | 268/12/7/51 (212) | .changeset/agent-steer-and-stop.md (3), apps/mvp/db/Database.test.ts (10), apps/mvp/db/Database.ts (8), apps/mvp/db/migrations/0075_merge_flow.ts (2) |
| `fe8a5d8f48` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `bceaf869a0` |  | 4 | PARTIAL 1, SUPERSEDED 1, ON-MAIN 2 | 273/12/7/46 (134) | apps/mvp/db/Database.ts (8), apps/mvp/db/migrations/0075_merge_flow.ts (2), apps/mvp/db/migrations/0077_agent_runners.ts (25), apps/mvp/db/migrations/0079_agent_stops.ts (2) |
| `f77f503af8` |  | 3 | PARTIAL 1, ON-MAIN 2 | 268/12/7/51 (212) | .changeset/agent-steer-and-stop.md (3), apps/mvp/db/Database.test.ts (10), apps/mvp/db/Database.ts (8), apps/mvp/db/migrations/0075_merge_flow.ts (2) |
| `b43032836f` |  | 1 | PARTIAL 1 | 252/19/10/48 (200) | apps/mvp/.s5-check.sh (4), apps/mvp/AGENTS.md (1), apps/mvp/db/Database.ts (10), apps/mvp/db/migrations/0075_merge_flow.ts (2) |
| `5c3d63613b` |  | 1 | PARTIAL 1 | 252/19/10/48 (200) | apps/mvp/.s5-check.sh (4), apps/mvp/AGENTS.md (1), apps/mvp/db/Database.ts (10), apps/mvp/db/migrations/0075_merge_flow.ts (2) |
| `0bd16f0c21` |  | 1 | PARTIAL 1 | 236/17/7/50 (143) | apps/mvp/db/Database.ts (8), apps/mvp/db/migrations/0075_merge_flow.ts (2), apps/mvp/db/migrations/0077_agent_runners.ts (25), apps/mvp/db/migrations/0078_agent_transcripts.ts (3) |
| `dbef79d353` |  | 17 | PARTIAL 13, STRANDED 3, SUPERSEDED 1 | 106/1/2013/135 (5013) | .agents/skills/vibelang/SKILL.md (86), .gitignore (1), .prettierignore (1), .smithers/flows/bench/README.md (1) |
| `53f3e4f254` | s1-runner@ | 7 | SUPERSEDED 4, PARTIAL 3 | 154/19/5/31 (94) | apps/mvp/db/Database.ts (4), apps/mvp/db/migrations/0077_agent_runners.ts (25), apps/mvp/docs/decisions/0132-independent-lanes.md (10), apps/mvp/docs/decisions/0133-external-agents-on-runners.md (11) |
| `0fe9b8d615` | builder/merge-flow merge-flow@ | 1 | PARTIAL 1 | 31/0/4/14 (26) | apps/mvp/db/Database.test.ts (2), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0075_merge_flow.ts (2), apps/mvp/docs/decisions/0131-merge-flow.md (7) |
| `5026a02787` | builder/alias-auth alias-auth@ | 14 | SUPERSEDED 14 | 0/0/0/0 (0) |  |
| `dca331d06f` |  | 2 | PARTIAL 2 | 0/0/19/2 (252) | apps/mvp/docs/work/mobile-w8.md (44), apps/mvp/e2e/README.md (8), apps/mvp/e2e/frames.test.ts (30), apps/mvp/e2e/frames.ts (10) |
| `982d7006d2` |  | 13 | PARTIAL 3, SUPERSEDED 5, ON-MAIN 5 | 63/2/92/17 (1201) | apps/mvp/docs/decisions/0121-operation-progress.md (10), apps/mvp/docs/features/issues.md (1), apps/mvp/docs/features/notifications.md (2), apps/mvp/docs/features/todos.md (5) |
| `bd36978696` |  | 22 | ON-MAIN 6, SUPERSEDED 12, PARTIAL 4 | 431/118/1/1 (3) | apps/mvp/src/features/commands/commands.test.ts (2), apps/mvp/worker/index.ts (1) |
| `bf0476b452` |  | 15 | PARTIAL 8, SUPERSEDED 4, ON-MAIN 3 | 398/33/8/5 (48) | apps/mvp/docs/features/issues.md (5), apps/mvp/docs/features/slash-commands.md (2), apps/mvp/docs/observability.md (3), apps/mvp/e2e/branch-publish.spec.ts (11) |
| `ccd8a24b03` |  | 1 | SCAFFOLD 1 | 0/0/0/0 (0) |  |
| `584d0000e6` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `ec33db8c91` |  | 4 | SUPERSEDED 2, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `a0a646589f` |  | 7 | SUPERSEDED 6, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `3d5fc96f1c` |  | 7 | SUPERSEDED 6, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `a02b3d420d` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `f88d5a9b47` |  | 6 | SUPERSEDED 4, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `817b66c45e` |  | 6 | SUPERSEDED 6 | 0/0/0/0 (0) |  |
| `46d74da7b6` |  | 6 | ON-MAIN 2, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `58a30dbc71` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `16410b139e` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `b499a383cc` |  | 1 | PARTIAL 1 | 58/7/0/2 (2) | apps/mvp/docs/decisions/0115-shape-payloads.md (1), apps/mvp/docs/work/big-shapes.md (1) |
| `0f24d3d3a3` | builder/electric-s5c | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `77972d9a1e` | builder/electric-s5b | 6 | PARTIAL 2, STRANDED 2, SUPERSEDED 2 | 8/1/7/4 (179) | apps/mvp/docs/work/electric-gateway-cache.md (7), apps/mvp/infra/ElectricCache.test.ts (27), apps/mvp/infra/ElectricCache.ts (26), apps/mvp/infra/ElectricDiagnostics.test.ts (47) |
| `a1ada1cb58` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `81a10938f8` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `380d7b2e82` |  | 4 | STRANDED 2, SUPERSEDED 1, PARTIAL 1 | 5/1/39/4 (206) | apps/mvp/bench/electric-load/report.ts (2), apps/mvp/bench/electric-load/run.ts (26), apps/mvp/bench/electric-load/stats.test.ts (9), apps/mvp/bench/electric-load/stats.ts (11) |
| `0578318252` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `34a5052973` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2c482772b1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `f775ac74e1` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `f23a59978f` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `9d9cca6e72` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `7897cc2847` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `95805eabbb` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ff05330075` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `0712915ee7` |  | 1 | PARTIAL 1 | 6/2/8/0 (13) | .changeset/mobile-home-announcement-target.md (2), apps/mvp/docs/features/notifications.md (1), apps/mvp/src/features/attention/detail.test.ts (2), apps/mvp/src/screens/issues/issues-screen.css (2) |
| `5d08f1c6b6` |  | 5 | SUPERSEDED 3, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `e4a8c2f4d1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `0e3a7c85c5` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `b03f4e82fb` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `f76c88ee90` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `47ecaf0948` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `802d2e3ff6` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `9e643e7a6e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `be9b5ceab1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d693d0e3d4` |  | 3 | ON-MAIN 1, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `1ceb6dfc59` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `82e7357ae5` |  | 1 | EMPTY-ISH 1 | 0/0/0/0 (0) |  |
| `4b37b4b97f` |  | 1 | PARTIAL 1 | 0/0/0/1 (1) | apps/mvp/worker/test/workerd/shapes.ts (1) |
| `34f0c5687b` |  | 1 | EMPTY-ISH 1 | 0/0/0/0 (0) |  |
| `7f67d7edde` |  | 6 | SUPERSEDED 4, PARTIAL 2 | 332/75/2/6 (62) | apps/mvp/e2e/vibelang-visitor.spec.ts (3), apps/mvp/src/features/issues/issues.ts (3), apps/mvp/src/features/issues/store.ts (6), apps/mvp/src/features/pulls/pulls.ts (2) |
| `4fb9c67761` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `20acd0d7f6` |  | 8 | ON-MAIN 3, PARTIAL 2, SUPERSEDED 3 | 446/34/1/5 (21) | apps/mvp/docs/decisions/0107-frontend-failures-recorded-once.md (6), apps/mvp/src/features/issues/writes.ts (1), apps/mvp/src/features/pulls/actions.ts (8), apps/mvp/src/features/timeline/store.test.t |
| `709a9b4085` |  | 1 | PARTIAL 1 | 6/0/0/2 (2) | apps/mvp/docs/decisions/0107-embed-full-screen-revision.md (1), apps/mvp/docs/work/embed-race.md (1) |
| `cf75af2bd1` |  | 4 | SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `819f48d117` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ff61538549` |  | 2 | ON-MAIN 2 | 0/0/0/0 (0) |  |
| `2adb786dc3` |  | 12 | SUPERSEDED 10, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `e796863977` |  | 12 | ON-MAIN 3, SUPERSEDED 9 | 0/0/0/0 (0) |  |
| `84810da5d9` |  | 4 | PARTIAL 2, SUPERSEDED 2 | 109/15/2/3 (16) | apps/mvp/db/Database.ts (4), apps/mvp/db/migrations/0063_bug_reports.ts (8), apps/mvp/db/migrations/0065_bug_report_errors.ts (2), apps/mvp/vitest.config.ts (2) |
| `7d062cf108` |  | 5 | SUPERSEDED 4, PARTIAL 1 | 211/121/7/11 (99) | apps/mvp/db/Database.test.ts (45), apps/mvp/docs/decisions/0104-model-tiers.md (10), apps/mvp/docs/features/jev.md (1), apps/mvp/docs/features/model-endpoint.md (2) |
| `c528165c0e` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `a7c024885e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3285d5e1f9` |  | 1 | PARTIAL 1 | 39/30/2/2 (7) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0064_timeline_summaries.ts (4), apps/mvp/vitest.config.ts (1) |
| `ea479e732a` |  | 5 | SUPERSEDED 4, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `5148360a59` |  | 7 | SUPERSEDED 4, ON-MAIN 3 | 0/0/0/0 (0) |  |
| `1ea9f8b41a` |  | 5 | SUPERSEDED 4, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `dd7765b429` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 62/9/1/2 (11) | apps/mvp/docs/benchmarks.md (4), apps/mvp/docs/decisions/0102-first-load.md (6), apps/mvp/docs/features/flows.md (1) |
| `baac407a47` |  | 2 | SUPERSEDED 1, PARTIAL 1 | 97/99/7/10 (29) | apps/mvp/db/Database.ts (2), apps/mvp/docs/decisions/0104-model-tiers.md (10), apps/mvp/docs/features/jev.md (1), apps/mvp/docs/features/model-endpoint.md (2) |
| `a508f47161` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ec80d9bc36` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `d2203e8b86` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `5f403ca906` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `fc21037c9b` |  | 12 | SUPERSEDED 9, ON-MAIN 3 | 0/0/0/0 (0) |  |
| `36692137ae` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c5f3064a14` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `d66d5c7b47` |  | 3 | ON-MAIN 1, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `bed27586b8` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `90cb745403` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `9972a50329` |  | 2 | ON-MAIN 2 | 0/0/0/0 (0) |  |
| `a3d42af1a1` |  | 3 | PARTIAL 1, SUPERSEDED 2 | 33/34/2/1 (8) | apps/mvp/src/features/attention/branch-page.test.ts (2), apps/mvp/src/features/home/components/HomeTabs.tsx (1), apps/mvp/src/screens/issues/IssuesScreen.tsx (5) |
| `a03ccd3ae2` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `a86869e604` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `f0361728cf` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `72ae7f367f` |  | 3 | ON-MAIN 2, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `7b5d0a2135` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `d92ac87502` |  | 3 | ON-MAIN 2, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `836eee8fc1` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `c198fd52ef` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `f86c26301f` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `0b52629593` |  | 2 | SUPERSEDED 1, PARTIAL 1 | 192/15/5/6 (19) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0057_sandbox_budgets.ts (6), apps/mvp/docs/decisions/0005-sandboxes-secrets-and-the-forge.md (2), apps/mvp/docs/decisions/0099-sandbox-budgets.md (4 |
| `f73f1f88b1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `957a64ce94` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3994db664f` |  | 1 | PARTIAL 1 | 19/0/1/2 (5) | apps/mvp/docs/decisions/0099-production-log-capture.md (3), apps/mvp/e2e/target.test.ts (1), apps/mvp/e2e/target.ts (1) |
| `881ea67f5a` |  | 4 | ON-MAIN 1, SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `7027d6f38f` |  | 1 | PARTIAL 1 | 60/4/2/2 (7) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0057_repo_about.ts (4), apps/mvp/vitest.config.ts (1) |
| `11a35a00fb` |  | 1 | PARTIAL 1 | 62/5/2/2 (6) | apps/mvp/db/Database.ts (2), apps/mvp/docs/decisions/0099-terminal-model-refusals.md (3), apps/mvp/vitest.config.ts (1) |
| `136945052a` |  | 1 | PARTIAL 1 | 31/31/3/3 (14) | apps/mvp/docs/decisions/0099-repository-page-boundaries.md (3), apps/mvp/docs/features/repo.md (1), apps/mvp/src/features/attention/branch-page.test.ts (1), apps/mvp/src/features/home/components/HomeT |
| `b152a4efed` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `0cbf100ade` |  | 1 | PARTIAL 1 | 36/9/0/1 (1) | apps/mvp/docs/decisions/0099-notification-backlog.md (1) |
| `1d2244ab90` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e52eeeb709` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `93cf6e0945` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e0cf8d3448` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `f30fbdac23` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c1cec07395` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `e3d2449249` |  | 1 | PARTIAL 1 | 19/31/2/4 (14) | apps/mvp/docs/decisions/0099-repository-page-boundaries.md (3), apps/mvp/docs/features/repo.md (1), apps/mvp/docs/work/repo-pages.md (1), apps/mvp/src/features/home/components/HomeTabs.tsx (1) |
| `ad792eea0e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `dcd6da80eb` |  | 4 | PARTIAL 1, SUPERSEDED 3 | 99/37/2/0 (5) | apps/mvp/docs/features/sign-in.md (3), apps/mvp/docs/features/timeline.md (2) |
| `68315c158f` |  | 3 | PARTIAL 1, SUPERSEDED 2 | 84/46/3/0 (6) | apps/mvp/docs/features/agent-status.md (1), apps/mvp/docs/features/sign-in.md (3), apps/mvp/docs/features/timeline.md (2) |
| `e98419b928` |  | 1 | PARTIAL 1 | 4173/75/342/58 (60517) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/attachments/new-branch/design.md (26), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0034_prototypes.ts |
| `901ac4b864` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6e719f421a` |  | 1 | PARTIAL 1 | 19/31/2/4 (14) | apps/mvp/docs/decisions/0099-repository-page-boundaries.md (3), apps/mvp/docs/features/repo.md (1), apps/mvp/docs/work/repo-pages.md (1), apps/mvp/src/features/home/components/HomeTabs.tsx (1) |
| `cbd9b8209c` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `ea2890560b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b6bd7e8988` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `2a64c493d2` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `52a82fd63c` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `52451867e6` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `4a2cb35524` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `cf0a8e43d4` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `96b46450a2` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `a94754bf0e` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `f4776e99c3` |  | 6 | ON-MAIN 3, PARTIAL 1, SUPERSEDED 2 | 7/7/7/0 (10) | apps/mvp/worker/branch/Forge.test.ts (3), apps/mvp/worker/branch/GitHubCreation.test.ts (3), apps/mvp/worker/test/fetch.ts (4) |
| `7e69a6ee2b` |  | 4 | STRANDED 1, SUPERSEDED 3 | 15/4/0/1 (3) | apps/mvp/docs/work/main-reds-0024e.md (3) |
| `68287c4345` |  | 3 | ON-MAIN 3 | 0/0/0/0 (0) |  |
| `fccdf564da` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `dd805e229d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d3928d2f04` |  | 3 | ON-MAIN 1, PARTIAL 1, SUPERSEDED 1 | 11/2/1/2 (7) | apps/mvp/evals/flowCases.test.ts (6), apps/mvp/evals/flowCases.ts (1) |
| `e3755de690` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `39f8cad1c3` |  | 5 | PARTIAL 2, SUPERSEDED 2, ON-MAIN 1 | 190/26/35/17 (292) | apps/mvp/db/Database.test.ts (5), apps/mvp/db/Database.ts (2), apps/mvp/docs/decisions/0012-git-end-to-end.md (1), apps/mvp/docs/decisions/0013-branch-workspace.md (1) |
| `40022a75e6` |  | 1 | PARTIAL 1 | 57/4/0/3 (4) | apps/mvp/docs/decisions/0087-pin-message.md (1), apps/mvp/docs/features/chat.md (1), apps/mvp/docs/work/pin-message.md (2) |
| `ecf78a276d` |  | 24 | STRANDED 1, ON-MAIN 15, PARTIAL 3, SUPERSEDED 5 | 79/0/78/8 (17535) | apps/mvp/docs/features/agent-evals.md (27), apps/mvp/docs/infrastructure.md (1), apps/mvp/docs/work/agent-ui-evals-fix.md (356), apps/mvp/evals/results/agent-2026-10-23T21-21-04-827Z.json (212) |
| `54239406d3` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `20858bc9a8` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `da2a7d8616` |  | 2 | ON-MAIN 2 | 0/0/0/0 (0) |  |
| `039dfc6ed8` |  | 2 | EMPTY-ISH 1, PARTIAL 1 | 57/4/0/3 (14) | apps/mvp/docs/decisions/0087-pin-message.md (1), apps/mvp/docs/features/chat.md (1), apps/mvp/docs/work/pin-message.md (12) |
| `9a588759db` |  | 1 | PARTIAL 1 | 57/4/0/3 (14) | apps/mvp/docs/decisions/0082-pin-message.md (1), apps/mvp/docs/features/chat.md (1), apps/mvp/docs/work/pin-message.md (12) |
| `20687ac7cb` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `ca3ccee5d9` |  | 6 | SUPERSEDED 4, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `559c7b6dd1` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `8597758a90` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `5041c806d8` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 51/5/12/10 (146) | apps/mvp/db/Database.test.ts (34), apps/mvp/db/Database.ts (3), apps/mvp/docs/decisions/0080-new-conversation-refusal.md (1), apps/mvp/docs/decisions/0086-new-conversation-ephemeral-refs.md (39) |
| `ad08687dd6` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `f7689eb189` |  | 1 | STRANDED 1 | 0/0/1/0 (42) | apps/mvp/docs/work/forms-and-views-live-evals.md (42) |
| `e4138ff4d0` |  | 1 | STRANDED 1 | 0/0/2/0 (3) | apps/mvp/src/device/migrations.test.ts (3) |
| `215ebf0803` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `550b4bec53` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `14177c08a8` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `56585870d2` |  | 41 | SUPERSEDED 30, ON-MAIN 11 | 0/0/0/0 (0) |  |
| `339099a805` |  | 1 | PARTIAL 1 | 17/3/0/1 (10) | apps/mvp/worker/github/Api.test.ts (10) |
| `ab8f62e371` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `9066432f71` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `a4b7a02775` |  | 6 | PARTIAL 2, ON-MAIN 2, SUPERSEDED 2 | 133/58/5/7 (21) | apps/mvp/AGENTS.md (1), apps/mvp/db/Database.ts (2), apps/mvp/docs/work/ci-parity-run-view.md (1), apps/mvp/src/device/migrations.test.ts (2) |
| `c8417db8d0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `397ac16d47` |  | 5 | SUPERSEDED 3, PARTIAL 1, ON-MAIN 1 | 176/17/1/0 (1) | apps/mvp/src/device/registry.ts (1) |
| `e74b0d3d03` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `474e9d5d24` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `4ad4c7908b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a7af3f6e26` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `96303ec936` |  | 27 | SUPERSEDED 9, ON-MAIN 16, PARTIAL 1, STRANDED 1 | 72/8/2/1 (7) | apps/mvp/src/features/repo/warm.test.ts (5), apps/mvp/src/features/status/status.test.ts (2) |
| `36a602fab9` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `2ee2c108ec` |  | 1 | PARTIAL 1 | 11/6/0/1 (4) | apps/mvp/docs/decisions/0077-new-conversation-refusal.md (4) |
| `a0628cfe62` |  | 6 | SUPERSEDED 4, ON-MAIN 1, PARTIAL 1 | 119/57/5/2 (19) | apps/mvp/db/Database.ts (6), apps/mvp/docs/decisions/0077-github-projection-ordering.md (2), apps/mvp/docs/features/issues.md (1), apps/mvp/docs/features/pulls.md (1) |
| `510f0dc709` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `02d8f60823` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3c0ea663e3` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `306bb9a2a9` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5fd8aa4174` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `0e8d7cc83b` |  | 5 | PARTIAL 4, STRANDED 1 | 2/0/10/4 (127) | apps/mvp/docs/work/platform-node-linux-reds.md (68), packages/smithers/flows/platform-node/docs/troubleshooting.md (15), packages/smithers/flows/platform-node/src/internal/ProcSnapshot.ts (5), package |
| `b03633a3c1` |  | 5 | PARTIAL 4, STRANDED 1 | 2/0/10/4 (127) | apps/mvp/docs/work/platform-node-linux-reds.md (68), packages/smithers/flows/platform-node/docs/troubleshooting.md (15), packages/smithers/flows/platform-node/src/internal/ProcSnapshot.ts (5), package |
| `373aa72a50` |  | 5 | PARTIAL 4, STRANDED 1 | 2/0/10/4 (127) | apps/mvp/docs/work/platform-node-linux-reds.md (68), packages/smithers/flows/platform-node/docs/troubleshooting.md (15), packages/smithers/flows/platform-node/src/internal/ProcSnapshot.ts (5), package |
| `6b14785300` |  | 8 | ON-MAIN 3, SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `dcd35527d1` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `2ebb0a730e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `0f5e96700e` |  | 3 | PARTIAL 1, SUPERSEDED 2 | 107/16/0/1 (1) | packages/smithers/flows/journal/src/SqlJournal.ts (1) |
| `775dd2d7c7` |  | 2 | SUPERSEDED 1, PARTIAL 1 | 94/16/4/3 (101) | .changeset/command-in-the-step.md (1), packages/smithers/flows/engine-store/docs/api.md (4), packages/smithers/flows/engine-store/src/EngineStore.ts (23), packages/smithers/flows/engine-store/test/Hos |
| `1197725423` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `bb8846cec1` |  | 3 | ON-MAIN 2, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `24337be84e` |  | 8 | PARTIAL 1, SUPERSEDED 6, ON-MAIN 1 | 79/38/17/2 (131) | .changeset/claim-log-owners.md (1), apps/mvp/src/test/agent.ts (9), apps/mvp/worker/flows/Todo.test.ts (26), apps/mvp/worker/test/flowHost.ts (27) |
| `9128d43fe1` |  | 6 | SUPERSEDED 2, ON-MAIN 4 | 0/0/0/0 (0) |  |
| `97b04fc0f6` |  | 5 | SUPERSEDED 3, ON-MAIN 1, PARTIAL 1 | 135/12/1/0 (5) | apps/mvp/src/flows/registrations.ts (5) |
| `384646b652` |  | 8 | SUPERSEDED 7, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `67917e16d7` |  | 10 | STRANDED 1, PARTIAL 4, SUPERSEDED 3, ON-MAIN 2 | 83/37/55/50 (1855) | .changeset/ci-job-step-log.md (5), apps/mvp/AGENTS.md (1), apps/mvp/db/Database.ts (2), apps/mvp/docs/features/actions.md (55) |
| `15098441d5` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `7e0ae698e6` |  | 8 | STRANDED 1, SUPERSEDED 6, ON-MAIN 1 | 79/38/17/0 (68) | apps/mvp/src/test/agent.ts (9), apps/mvp/worker/flows/Todo.test.ts (14), apps/mvp/worker/test/flowHost.ts (27), packages/smithers/flows/engine-store/src/internal/RunDriver.ts (18) |
| `08cb0cd99d` |  | 6 | ON-MAIN 2, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `e5760e837c` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 77/14/8/21 (69) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0043_github_repo_roles.ts (3), apps/mvp/docs/decisions/0065-roles-per-repository.md (10), apps/mvp/docs/features/issues.md (4) |
| `c150967dde` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `2ad00d3322` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `3a43ea31fa` |  | 7 | SUPERSEDED 6, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `91d70e9d68` |  | 4 | SUPERSEDED 1, PARTIAL 2, ON-MAIN 1 | 151/16/9/7 (37) | apps/mvp/AGENTS.md (1), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0044_agent_views.ts (9), apps/mvp/docs/features/agent-evals.md (1) |
| `47f1d1ffea` |  | 1 | PARTIAL 1 | 73/20/4/2 (8) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0043_conversation_people.ts (3), apps/mvp/docs/work/conversations-and-history.md (1), apps/mvp/src/flows/registry.test.ts (1) |
| `7db2d33fbd` |  | 6 | SUPERSEDED 4, ON-MAIN 1, PARTIAL 1 | 82/20/4/1 (8) | apps/mvp/src/features/repo/components/RepoHeader.tsx (3), apps/mvp/src/features/terminal/navigation.test.ts (1), apps/mvp/src/main.tsx (1), apps/mvp/src/screens/branch/offline.test.ts (3) |
| `be9b41b545` |  | 4 | PARTIAL 1, SUPERSEDED 3 | 31/4/1/5 (61) | apps/mvp/docs/work/todo-production-start-latency.md (37), packages/smithers/flows/docs/runtime-construction.md (8), packages/smithers/flows/src/Runtime.ts (5), packages/smithers/flows/src/internal/Run |
| `7c3b4033ae` |  | 14 | ON-MAIN 5, SUPERSEDED 9 | 0/0/0/0 (0) |  |
| `ff1eb39a91` |  | 2 | PARTIAL 1, ON-MAIN 1 | 89/11/8/2 (20) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0044_domains.ts (10), apps/mvp/docs/observability.md (1), apps/mvp/src/features/terminal/navigation.test.ts (1) |
| `cbd021c4c2` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `83b9d49672` |  | 6 | PARTIAL 3, SUPERSEDED 2, ON-MAIN 1 | 115/55/6/2 (50) | apps/mvp/db/Database.ts (6), apps/mvp/docs/decisions/0065-github-projection-ordering.md (3), apps/mvp/docs/features/issues.md (1), apps/mvp/docs/features/pulls.md (1) |
| `ae3d1d4e90` |  | 5 | SUPERSEDED 3, ON-MAIN 1, PARTIAL 1 | 122/13/1/0 (5) | apps/mvp/src/flows/registrations.ts (5) |
| `db2e3e783b` |  | 34 | ON-MAIN 31, SUPERSEDED 2, STRANDED 1 | 113/1/1/0 (2) | packages/smithers/test/EvaluationCli.test.ts (2) |
| `2bdf838be6` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `81490bf80b` |  | 4 | ON-MAIN 1, SUPERSEDED 2, PARTIAL 1 | 122/12/1/0 (5) | apps/mvp/src/flows/registrations.ts (5) |
| `39302f919c` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `5d05890579` |  | 4 | SUPERSEDED 1, PARTIAL 2, ON-MAIN 1 | 136/13/12/9 (80) | apps/mvp/AGENTS.md (1), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0043_agent_views.ts (9), apps/mvp/docs/features/agent-evals.md (3) |
| `adec00bc79` |  | 6 | SUPERSEDED 3, ON-MAIN 1, PARTIAL 2 | 62/12/8/9 (43) | .smithers/flows/release/fixtures/public-api-baseline.json (3), apps/mvp/src/boot.test.ts (2), apps/mvp/src/boot.ts (6), apps/mvp/src/features/repo/components/RepoHeader.tsx (3) |
| `c6db4254b1` |  | 2 | PARTIAL 2 | 68/6/15/16 (71) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0041_domains.ts (11), apps/mvp/docs/decisions/0007-roles-and-tags.md (1), apps/mvp/docs/decisions/0028-custom-domains.md (5) |
| `b238afaac2` |  | 6 | ON-MAIN 2, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `e84c047471` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 115/12/1/2 (7) | .changeset/electric-cache-realms.md (1), apps/mvp/src/flows/registrations.ts (5), packages/effect-electric/README.md (1) |
| `3436383373` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 114/12/2/2 (8) | .changeset/electric-cache-realms.md (1), apps/mvp/docs/features/flows.md (1), apps/mvp/src/flows/registrations.ts (5), packages/effect-electric/README.md (1) |
| `43891bdd98` |  | 6 | SUPERSEDED 6 | 0/0/0/0 (0) |  |
| `2fa3be8d79` |  | 2 | SUPERSEDED 1, PARTIAL 1 | 108/11/2/0 (6) | apps/mvp/docs/features/flows.md (1), apps/mvp/src/flows/registrations.ts (5) |
| `d139f1b0d5` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `efc4391769` |  | 6 | SUPERSEDED 6 | 0/0/0/0 (0) |  |
| `0a3545ebee` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c9d2ade518` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `11af05aba7` |  | 2 | PARTIAL 2 | 41/9/0/4 (15) | apps/mvp/docs/work/todo-stack-hold.md (3), apps/mvp/worker/flows/Todo.test.ts (1), apps/mvp/worker/stack/Stack.test.ts (7), apps/mvp/worker/stack/Stack.ts (4) |
| `e61fff0891` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `24a7bd8f79` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `d716562442` |  | 6 | PARTIAL 4, SUPERSEDED 2 | 226/19/30/12 (357) | apps/mvp/docs/work/journal-latency.md (9), apps/mvp/worker/Executions.ts (1), apps/site/public/llms-full.txt (59), apps/site/src/content/docs/docs/reference/api/database.mdx (39) |
| `2b7b365b7d` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a2b862d154` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c14cea2606` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `dd4e291db0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `403d17274d` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c16cc6d534` |  | 4 | ON-MAIN 1, SUPERSEDED 2, PARTIAL 1 | 81/13/0/2 (2) | .smithers/flows/release/fixtures/public-api-baseline.json (1), apps/mvp/worker/Executions.ts (1) |
| `31b691f900` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `7732ee9482` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `875a96f04d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2ae19368ff` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e457a8fef8` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `820c3b9ab4` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `6b2971b10f` |  | 6 | ON-MAIN 2, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `37c4036a58` |  | 2 | PARTIAL 2 | 106/10/5/0 (11) | apps/mvp/docs/features/flows.md (1), apps/mvp/src/features/auth/store.ts (1), apps/mvp/src/flows/registrations.ts (5), apps/mvp/src/test/e2e.ts (4) |
| `13182e1705` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `5a0fb2b622` |  | 6 | PARTIAL 4, SUPERSEDED 2 | 235/20/29/5 (150) | apps/mvp/docs/work/journal-latency.md (9), apps/site/public/llms-full.txt (45), apps/site/src/content/docs/docs/reference/api/database.mdx (35), apps/site/src/content/docs/docs/reference/api/engine-st |
| `1f91ef7a70` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `a607670a74` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `0a442931c6` |  | 6 | SUPERSEDED 4, ON-MAIN 1, PARTIAL 1 | 129/23/7/20 (132) | .changeset/database-writer-lock-timeout.md (6), .smithers/flows/release/fixtures/public-api-baseline.json (3), apps/mvp/worker/Executions.ts (1), apps/site/public/llms-full.txt (18) |
| `547cc3c09b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `cbbe63ed43` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `b3bd0d65ae` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `953d45f238` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `6243124341` |  | 1 | PARTIAL 1 | 3/0/9/2 (152) | .changeset/browser-resume-admission.md (10), packages/smithers/flows/platform-browser/docs/api.md (27), packages/smithers/flows/platform-browser/docs/concepts/durable-browser-engine.md (9), packages/s |
| `64266eb489` |  | 5 | ON-MAIN 1, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `ce3d049ead` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `ab07e25166` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `30107a6b8d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `f1908bc8d9` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `8f76343321` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8c681ea2b6` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `8633fdc66d` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `0a2759b8ed` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `9da5fee736` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `fae2972933` |  | 5 | SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `65d0c9b954` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3216e65c29` |  | 3 | SUPERSEDED 2, PARTIAL 1 | 25/6/7/18 (119) | .changeset/database-writer-lock-timeout.md (6), .smithers/flows/release/fixtures/public-api-baseline.json (3), apps/site/public/llms-full.txt (18), apps/site/src/content/docs/docs/reference/api/databa |
| `1cd360747c` |  | 7 | PARTIAL 5, SUPERSEDED 2 | 235/19/29/28 (394) | .changeset/database-writer-lock-timeout.md (6), apps/mvp/docs/work/journal-latency.md (9), apps/site/public/llms-full.txt (66), apps/site/src/content/docs/docs/reference/api/database.mdx (56) |
| `01117011e5` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `232ed3b05c` |  | 1 | PARTIAL 1 | 14/0/1/2 (52) | apps/mvp/docs/work/mini-harness-719499.md (47), packages/smithers/agent/harness/docs/concepts.md (3), packages/smithers/agent/harness/src/CellTurn.ts (2) |
| `69b56b184f` |  | 1 | PARTIAL 1 | 24/0/5/3 (40) | apps/mvp/docs/work/model-evaluator-regressions-721994.md (27), packages/smithers/agent/model/README.md (2), packages/smithers/agent/model/docs/api.md (3), packages/smithers/agent/model/src/Endpoint.ts |
| `ebde26fe07` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `acf8dae47b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6ae79dec66` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `d0c6aa7e2f` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `85b125e397` |  | 2 | PARTIAL 2 | 106/10/6/1 (19) | apps/mvp/docs/features/flows.md (1), apps/mvp/src/features/attention/store.ts (1), apps/mvp/src/features/auth/store.ts (1), apps/mvp/src/features/timeline/contract.ts (7) |
| `00994147f0` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c4e9b416c4` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `3458516e6a` |  | 6 | SUPERSEDED 4, ON-MAIN 1, PARTIAL 1 | 72/12/5/2 (15) | apps/mvp/src/features/repo/components/RepoHeader.tsx (3), apps/mvp/src/features/terminal/view.ts (4), apps/mvp/src/main.tsx (1), apps/mvp/src/screens/branch/offline.test.ts (3) |
| `3e36921290` |  | 3 | ON-MAIN 2, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `409f0386ed` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a676aa7357` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `3f81cf738f` |  | 1 | PARTIAL 1 | 28/0/1/1 (31) | apps/mvp/docs/work/harness-internal-findings.md (29), packages/smithers/agent/harness/PACKAGE.ts (2) |
| `829c3ee0c3` |  | 1 | PARTIAL 1 | 24/0/0/1 (15) | apps/mvp/docs/work/fix-model-host-352044.md (15) |
| `c02e30023c` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `555f1de067` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c5c1ec01dc` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `06799a9d9d` |  | 1 | PARTIAL 1 | 37/0/12/4 (92) | apps/mvp/docs/work/github-write-safety-342737.md (18), packages/smithers/agent/integrations/README.md (2), packages/smithers/agent/integrations/src/github/Actions.ts (1), packages/smithers/agent/integ |
| `c63dcc4693` |  | 9 | SUPERSEDED 7, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `e2d711da18` |  | 4 | SUPERSEDED 1, PARTIAL 2, ON-MAIN 1 | 141/14/8/7 (36) | apps/mvp/AGENTS.md (1), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0043_agent_views.ts (9), apps/mvp/docs/features/agent-evals.md (1) |
| `26da3c47fd` |  | 3 | PARTIAL 1, SUPERSEDED 2 | 58/8/18/0 (30) | apps/site/public/llms-full.txt (10), apps/site/src/content/docs/docs/reference/api/engine-store.mdx (2), apps/site/src/content/docs/docs/reference/api/platform-cloudflare.mdx (8), packages/smithers/fl |
| `afac32fc6f` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `fcbc2db3f3` |  | 3 | PARTIAL 3 | 176/11/11/6 (128) | apps/mvp/docs/work/journal-latency.md (9), apps/site/public/llms-full.txt (35), apps/site/src/content/docs/docs/reference/api/database.mdx (35), packages/smithers/flows/database/docs/api.md (35) |
| `87afc19dba` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `467ba8d3c1` |  | 1 | PARTIAL 1 | 41/0/1/1 (44) | apps/mvp/docs/work/mini-harness-regressions-216946.md (41), packages/smithers/agent/harness/PACKAGE.ts (3) |
| `0ae96a044a` |  | 1 | PARTIAL 1 | 30/4/1/2 (41) | apps/mvp/docs/work/mini-backend-449117.md (30), packages/smithers/src/internal/backend/Runs.ts (2), packages/smithers/test/BackendWorkspace.test.ts (9) |
| `a7403c46d5` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ddeca86fea` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `413997f7dd` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `afa18db821` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `cd19a53d1a` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `9f99ba3129` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `7791be2481` |  | 1 | PARTIAL 1 | 11/1/2/3 (29) | apps/mvp/docs/features/flows.md (1), apps/mvp/docs/work/theme-button-regressions-465050.md (3), apps/mvp/src/features/theme/store.ts (6), apps/mvp/src/features/theme/theme.test.ts (19) |
| `0b051dfe30` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `0e7adef4c3` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `9b62e33935` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `4debb68b67` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `e294a3c4ee` |  | 2 | PARTIAL 2 | 118/7/5/12 (122) | packages/smithers/flows/database/docs/api.md (35), packages/smithers/flows/database/src/Migrations.ts (7), packages/smithers/flows/database/src/internal/WriteTally.ts (3), packages/smithers/flows/data |
| `d36edc4400` |  | 2 | PARTIAL 2 | 125/7/5/9 (111) | packages/smithers/flows/database/docs/api.md (35), packages/smithers/flows/database/src/Migrations.ts (7), packages/smithers/flows/database/src/internal/WriteTally.ts (3), packages/smithers/flows/data |
| `c0046c5d2d` |  | 4 | SUPERSEDED 2, SCAFFOLD 1, PARTIAL 1 | 142/8/5/4 (63) | packages/smithers/flows/database/docs/api.md (35), packages/smithers/flows/database/src/test/SlowNetwork.ts (14), packages/smithers/flows/database/test/PostgresPooling.test.ts (1), packages/smithers/f |
| `b839008003` |  | 2 | PARTIAL 2 | 117/7/5/12 (122) | packages/smithers/flows/database/docs/api.md (35), packages/smithers/flows/database/src/Migrations.ts (7), packages/smithers/flows/database/src/internal/WriteTally.ts (3), packages/smithers/flows/data |
| `a5831dcfee` |  | 3 | SUPERSEDED 1, PARTIAL 2 | 144/8/5/3 (49) | packages/smithers/flows/database/docs/api.md (35), packages/smithers/flows/database/test/PostgresPooling.test.ts (1), packages/smithers/flows/platform-cloudflare/package.json (1), packages/smithers/fl |
| `4e6686686f` |  | 4 | PARTIAL 3, SUPERSEDED 1 | 144/8/5/3 (49) | packages/smithers/flows/database/docs/api.md (35), packages/smithers/flows/database/test/PostgresPooling.test.ts (1), packages/smithers/flows/platform-cloudflare/package.json (1), packages/smithers/fl |
| `f0fcc1f28a` |  | 7 | SUPERSEDED 2, ON-MAIN 1, PARTIAL 3, STRANDED 1 | 148/20/12/12 (123) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (1), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md ( |
| `84449e6ef6` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `d1c6a15702` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `f2cbad07ec` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `88a0326800` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8f76cf845e` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `89f373ae95` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ab300f4e44` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8e74b2cf91` |  | 2 | PARTIAL 2 | 80/9/9/7 (32) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0041_domains.ts (11), apps/mvp/docs/decisions/0007-roles-and-tags.md (1), apps/mvp/docs/decisions/0028-custom-domains.md (5) |
| `ec0ec5d54a` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `7c0b1fd1bf` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `9e72d4765d` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `8e2e192549` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `fbe8b0be4f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `dd0911cbdf` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `16af72e471` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `36aac6956a` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `6c36ef1791` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `271393ffa7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `597f487f83` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3992496c63` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `0d063218ac` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `7dfa2c8c7e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d847d43bdb` |  | 1 | PARTIAL 1 | 12/0/2/3 (29) | apps/mvp/docs/work/rework-be74787a.md (12), packages/smithers/flows/flow/docs/concepts/execution-identity.md (3), packages/smithers/flows/flow/src/Action/idempotencyKey.ts (6), packages/smithers/flows |
| `238e35feb7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8d811f68cb` |  | 6 | SUPERSEDED 5, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `02a3d5d58a` |  | 1 | PARTIAL 1 | 4/2/2/2 (7) | .smithers/flows/node_modules (1), .smithers/flows/review/seeded-bugs/node_modules (1), apps/mvp/src/features/terminal/terminal.test.ts (5) |
| `dc35965264` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `b0d527eee7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d5ebb2c9ec` |  | 1 | PARTIAL 1 | 16/0/15/5 (129) | apps/mvp/docs/work/mini-flow-confirmed-bugs.md (45), packages/smithers/flows/flow/PACKAGE.ts (7), packages/smithers/flows/flow/docs/api.md (6), packages/smithers/flows/flow/docs/reference/flow.md (4) |
| `4d87a1c820` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `bb5ee16706` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2928064a89` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ad1d4ef682` |  | 1 | PARTIAL 1 | 2/2/5/4 (121) | apps/mvp/docs/decisions/0028-terminal-session-deadline.md (4), apps/mvp/docs/features/sandbox-tools.md (1), apps/mvp/docs/work/terminal-session-deadline.md (11), apps/mvp/worker/BranchSandboxes.test.t |
| `77c9d62aff` |  | 1 | PARTIAL 1 | 8/0/1/1 (3) | apps/mvp/docs/work/mini-effect-electric-validation.md (2), packages/effect-electric/src/ElectricCollection.ts (1) |
| `0b93fc6d9a` |  | 25 | SUPERSEDED 17, ON-MAIN 7, PARTIAL 1 | 290/60/1/3 (29) | apps/mvp/docs/work/branch-page-regressions.md (22), apps/mvp/src/features/runs/actions.ts (5), apps/mvp/src/flows/requests.test.ts (1), apps/mvp/worker/RepoApi.ts (1) |
| `0bbf6b3fbd` |  | 20 | SUPERSEDED 16, ON-MAIN 4 | 0/0/0/0 (0) |  |
| `e8db41361c` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `cce3569189` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `5a397faae0` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `f477e44148` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `0aa846e9c2` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `fa8b8f89a7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `61f1ea1263` |  | 9 | SUPERSEDED 7, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `09e2b52cd0` |  | 1 | PARTIAL 1 | 9/0/1/1 (40) | apps/mvp/docs/work/model-proxy-wire-boundaries.md (29), packages/smithers/agent/model/test/ModelProxy.test.ts (11) |
| `72a73899be` |  | 29 | SUPERSEDED 20, ON-MAIN 9 | 0/0/0/0 (0) |  |
| `cff156d794` |  | 1 | PARTIAL 1 | 9/0/1/1 (40) | apps/mvp/docs/work/model-proxy-wire-boundaries.md (29), packages/smithers/agent/model/test/ModelProxy.test.ts (11) |
| `104a7b5e07` |  | 34 | ON-MAIN 12, SUPERSEDED 22 | 0/0/0/0 (0) |  |
| `331891126f` |  | 29 | SUPERSEDED 20, ON-MAIN 9 | 0/0/0/0 (0) |  |
| `b95118a69b` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `5d3efd101f` |  | 9 | SUPERSEDED 6, ON-MAIN 2, PARTIAL 1 | 108/21/3/1 (9) | apps/mvp/docs/features/agent.md (1), apps/mvp/docs/features/navigation.md (2), apps/mvp/worker/AlertChannels.test.ts (3), apps/mvp/worker/RemoteRuns.test.ts (3) |
| `1ea57261a4` |  | 13 | SUPERSEDED 10, ON-MAIN 3 | 0/0/0/0 (0) |  |
| `9ef520910f` |  | 34 | ON-MAIN 12, SUPERSEDED 22 | 0/0/0/0 (0) |  |
| `9316077424` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `3d6dac6fb7` |  | 14 | SUPERSEDED 10, ON-MAIN 4 | 0/0/0/0 (0) |  |
| `f1257d53d3` |  | 10 | SUPERSEDED 6, ON-MAIN 3, PARTIAL 1 | 116/21/3/1 (9) | apps/mvp/docs/features/agent.md (1), apps/mvp/docs/features/navigation.md (2), apps/mvp/worker/AlertChannels.test.ts (3), apps/mvp/worker/RemoteRuns.test.ts (3) |
| `bedd7ff582` |  | 1 | PARTIAL 1 | 16/0/0/1 (2) | apps/mvp/docs/work/flow-sibling-suspension-codec.md (2) |
| `eca4f0f7f4` |  | 14 | ON-MAIN 8, SUPERSEDED 5, PARTIAL 1 | 405/2/1/15 (112) | packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns/s |
| `6dd6277f0d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `97f2a041f0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d92a9c71ce` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3040e79cca` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d349d20f42` |  | 1 | PARTIAL 1 | 9/0/1/1 (30) | apps/mvp/docs/work/model-proxy-wire-boundaries.md (19), packages/smithers/agent/model/test/ModelProxy.test.ts (11) |
| `b98e2fc309` |  | 12 | SUPERSEDED 5, ON-MAIN 6, PARTIAL 1 | 342/3/1/15 (112) | packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns/s |
| `b8282bf27d` |  | 13 | ON-MAIN 7, SUPERSEDED 5, PARTIAL 1 | 375/2/1/15 (112) | packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns/s |
| `a3a6cac508` |  | 12 | PARTIAL 2, SUPERSEDED 4, ON-MAIN 6 | 342/3/1/15 (112) | packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns/s |
| `8adf84bd4d` |  | 14 | PARTIAL 2, ON-MAIN 7, SUPERSEDED 5 | 401/3/3/16 (200) | apps/site/public/llms-full.txt (88), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/patterns/src/Trellis.ts (16 |
| `1c53f993e8` |  | 12 | SUPERSEDED 5, ON-MAIN 6, PARTIAL 1 | 342/3/1/15 (112) | packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns/s |
| `a9dea10f10` |  | 12 | SUPERSEDED 5, ON-MAIN 6, PARTIAL 1 | 342/3/1/15 (112) | packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns/s |
| `73a8e215e1` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `52f97a5cb8` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 128/6/3/9 (79) | packages/smithers/flows/patterns/docs/teams.md (2), packages/smithers/flows/patterns/src/Intervene.ts (4), packages/smithers/flows/patterns/src/Runbook.ts (2), packages/smithers/flows/patterns/src/Tre |
| `2cf7a54bcd` |  | 3 | ON-MAIN 1, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `2849e27fb1` |  | 4 | STRANDED 1, SUPERSEDED 3 | 161/8/0/10 (136) | packages/smithers/flows/patterns/src/Runbook.ts (8), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns/src/index.ts (1), packages/smithers/flows/patterns/test/Dele |
| `1d09fe42d7` |  | 4 | PARTIAL 1, SUPERSEDED 3 | 246/7/2/7 (73) | packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Panel.ts (1), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns/src/in |
| `02def9611e` |  | 1 | PARTIAL 1 | 9/0/1/1 (28) | apps/mvp/docs/work/model-proxy-wire-boundaries.md (17), packages/smithers/agent/model/test/ModelProxy.test.ts (11) |
| `26d7a5b737` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c597088dc0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `1821a5f647` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `cc19e2287a` |  | 29 | SUPERSEDED 20, ON-MAIN 9 | 0/0/0/0 (0) |  |
| `1f1f31f298` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `66df7215b2` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `05f83d5b23` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `ff41e80e78` |  | 17 | ON-MAIN 8, SUPERSEDED 8, PARTIAL 1 | 494/3/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `d795dd0a40` |  | 15 | SUPERSEDED 8, ON-MAIN 6, PARTIAL 1 | 425/6/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `d718df9d62` |  | 16 | ON-MAIN 7, SUPERSEDED 8, PARTIAL 1 | 458/3/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `bd82b0173e` |  | 15 | SUPERSEDED 8, ON-MAIN 6, PARTIAL 1 | 425/6/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `5839b64855` |  | 15 | PARTIAL 2, SUPERSEDED 7, ON-MAIN 6 | 425/6/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `4c1840d5b0` |  | 15 | SUPERSEDED 8, ON-MAIN 6, PARTIAL 1 | 425/6/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `7e6e777b16` |  | 1 | PARTIAL 1 | 36/0/0/1 (1) | apps/mvp/docs/work/cli-cancellation-928301.md (1) |
| `d4373efcd8` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `6c2b618ad6` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `1ba967f11f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `0b4f992e84` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `f084f6127d` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c7e27fff9e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6076335982` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c93bc8c67d` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `fa8c951f97` |  | 17 | ON-MAIN 8, SUPERSEDED 8, PARTIAL 1 | 493/3/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `95c32710d0` |  | 16 | ON-MAIN 7, SUPERSEDED 8, PARTIAL 1 | 458/3/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `533f7969d9` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `d8e598bbe8` |  | 15 | SUPERSEDED 8, ON-MAIN 6, PARTIAL 1 | 425/6/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `d8e1053cd6` |  | 15 | PARTIAL 2, SUPERSEDED 7, ON-MAIN 6 | 425/6/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `41979c611c` |  | 15 | SUPERSEDED 8, ON-MAIN 6, PARTIAL 1 | 425/6/1/20 (125) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/MergeQueue.ts (1), packages/smithers/flows/patterns/src/Optimizer.ts (19), packages/smithers/flows/pat |
| `7e7e4920c4` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2ed42746aa` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a0a59015b7` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `edd0bcabef` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `2f88c3b72c` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `b1c7b94f54` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `a27a438a21` |  | 1 | PARTIAL 1 | 3/2/0/1 (1) | apps/mvp/docs/work/fix-repo-clone-installation-status.md (1) |
| `2f0bd0d362` |  | 4 | SUPERSEDED 3, PARTIAL 1 | 24/12/2/3 (10) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0039_coding_model_role.ts (1), apps/mvp/docs/decisions/0028-coding-model-role.md (4), apps/mvp/docs/work/coding-model-role.md (3) |
| `7b12317475` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 121/19/9/9 (55) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/features/flows.md (1), apps/mvp/src/boot.test.ts (3), apps/mvp/src/device/identity.ts (3) |
| `e62618e470` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 65/12/13/16 (803) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (19), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md (19), apps/mvp/e2e/sign-in.spec.ts (19) |
| `cf246cf515` |  | 1 | PARTIAL 1 | 2/0/17/13 (626) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (23), apps/mvp/e2e/sign-in.spec.ts (19), apps/mvp/src/device/identity.test.ts (259) |
| `b471b5956a` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 52/15/9/16 (382) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (25), apps/mvp/docs/observability.md (3), apps/mvp/e2e/sign-in.spec.ts (19) |
| `8720bcef3e` |  | 1 | PARTIAL 1 | 2/0/17/13 (626) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (23), apps/mvp/e2e/sign-in.spec.ts (19), apps/mvp/src/device/identity.test.ts (259) |
| `8431509fe5` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 59/20/1/2 (5) | apps/mvp/src/boot.test.ts (2), apps/mvp/src/features/attention/attention.test.ts (2), apps/mvp/src/features/attention/store.ts (1) |
| `6fa58ff236` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 66/12/13/17 (805) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (19), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md (19), apps/mvp/docs/observability.md (2) |
| `6cfff5d4ce` |  | 1 | PARTIAL 1 | 3/0/17/15 (629) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (23), apps/mvp/docs/observability.md (3), apps/mvp/e2e/sign-in.spec.ts (19) |
| `27f2343fbc` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 65/12/13/16 (803) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (19), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md (19), apps/mvp/e2e/sign-in.spec.ts (19) |
| `27308dff1b` |  | 1 | PARTIAL 1 | 6/1/20/17 (641) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (23), apps/mvp/docs/observability.md (3), apps/mvp/e2e/sign-in.spec.ts (19) |
| `16d9b67a8d` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 50/17/6/7 (334) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (11), apps/mvp/e2e/sign-in.spec.ts (2), apps/mvp/src/device/identity.ts (104) |
| `2d713d1c72` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ec49e966b6` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `4e8c91a71a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `76e8c11138` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `e5e2115b5e` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `51237f4a5a` |  | 4 | SUPERSEDED 3, PARTIAL 1 | 24/12/2/3 (10) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0039_coding_model_role.ts (1), apps/mvp/docs/decisions/0028-coding-model-role.md (4), apps/mvp/docs/work/coding-model-role.md (3) |
| `0b28a8c167` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `f9d1a2ab79` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `245fc53d61` |  | 23 | SUPERSEDED 17, ON-MAIN 6 | 0/0/0/0 (0) |  |
| `a2cc4468ea` |  | 20 | SUPERSEDED 13, PARTIAL 2, ON-MAIN 5 | 398/101/6/12 (58) | apps/mvp/docs/features/agent-evals.md (5), apps/mvp/docs/features/todos.md (11), apps/mvp/docs/work/flow-sibling-suspension-codec.md (1), apps/mvp/worker/BranchSandboxes.ts (1) |
| `ca2998bddf` |  | 3 | PARTIAL 1, SUPERSEDED 2 | 24/10/2/3 (10) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0039_coding_model_role.ts (1), apps/mvp/docs/decisions/0028-coding-model-role.md (4), apps/mvp/docs/work/coding-model-role.md (3) |
| `43007b0fd8` |  | 43 | SUPERSEDED 32, ON-MAIN 11 | 0/0/0/0 (0) |  |
| `4a47b426e6` |  | 21 | SUPERSEDED 14, PARTIAL 2, ON-MAIN 5 | 407/103/6/13 (63) | apps/mvp/docs/features/agent-evals.md (5), apps/mvp/docs/features/todos.md (11), apps/mvp/docs/work/flow-sibling-suspension-codec.md (1), apps/mvp/worker/BranchSandboxes.ts (1) |
| `b111fae417` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 17/0/15/6 (137) | .changeset/cloudflare-safe-failure-detail.md (5), .changeset/cloudflare-terminal-input-bounds.md (2), apps/mvp/docs/work/platform-cloudflare-review-fixes.md (15), packages/smithers/flows/platform-clou |
| `93af17ebd4` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `32e5a252c9` |  | 13 | SUPERSEDED 9, ON-MAIN 4 | 0/0/0/0 (0) |  |
| `4b4584af3b` |  | 20 | SUPERSEDED 14, PARTIAL 2, ON-MAIN 4 | 235/26/2/0 (5) | apps/mvp/src/features/views/views.test.ts (2), packages/smithers/ui/src/presentation/bundle.generated.ts (3) |
| `fcd2fd1cd5` |  | 15 | ON-MAIN 3, SUPERSEDED 12 | 0/0/0/0 (0) |  |
| `0bb36a57fb` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `664184311f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `88e17533b3` |  | 1 | PARTIAL 1 | 26/0/3/1 (49) | apps/mvp/docs/work/control-quiet-watch-and-rejection-replay.md (36), packages/smithers/control/src/ControlLive.ts (13) |
| `27d31edbd0` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `a61634dcaf` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `44c1e6b9b2` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c5461a44fa` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `be74787aa6` |  | 1 | PARTIAL 1 | 12/0/3/2 (42) | apps/mvp/docs/work/action-identity-once-regressions.md (24), packages/smithers/flows/flow/docs/concepts/execution-identity.md (4), packages/smithers/flows/flow/src/Action/idempotencyKey.ts (6), packag |
| `7aa011984a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c61d044373` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c04dfde0f1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8a067eb479` |  | 1 | PARTIAL 1 | 26/0/7/1 (35) | apps/mvp/docs/work/mini-product-api-request-bodies.md (25), packages/smithers/src/internal/backend/Client.ts (2), packages/smithers/src/internal/backend/ProductApi.ts (1), packages/smithers/test/Produ |
| `07c9441bae` |  | 1 | PARTIAL 1 | 10/0/10/4 (30) | apps/mvp/docs/work/notifications-response-access-fixes.md (5), packages/smithers/notifications/README.md (4), packages/smithers/notifications/src/Channels.ts (14), packages/smithers/notifications/src/ |
| `c87a5e86b4` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `e4fd2edc7e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3f0367fc91` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `dd60c8c5bf` |  | 10 | SUPERSEDED 8, ON-MAIN 1, PARTIAL 1 | 141/14/2/1 (36) | apps/mvp/docs/work/plan-confirmed-bugs-586345.md (24), packages/smithers/flows/plan/docs/concepts/authoring-ast.md (11), packages/smithers/flows/plan/src/FileSet.ts (1) |
| `9d7b44d389` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c09041d548` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `092f8d2167` |  | 1 | PARTIAL 1 | 10/10/1/2 (15) | apps/mvp/alchemy.run.ts (1), apps/mvp/src/pwa.test.ts (2), apps/mvp/src/pwa.ts (12) |
| `08d0af64a1` |  | 13 | SUPERSEDED 9, ON-MAIN 4 | 0/0/0/0 (0) |  |
| `cc7ca70283` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `43be91f65e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `01b2a5b732` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d809b10d69` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `21c4f2b3d8` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2f18041e12` |  | 2 | PARTIAL 1, ON-MAIN 1 | 26/3/9/1 (93) | apps/mvp/docs/work/flow-source-regressions-751129.md (45), packages/smithers/flows/flow/README.md (12), packages/smithers/flows/flow/docs/reference/flow.md (1), packages/smithers/flows/flow/src/Durabl |
| `5c5b0bfa9f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b2c8934ff8` |  | 14 | SUPERSEDED 12, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `2c53e7d3fb` |  | 1 | PARTIAL 1 | 5/1/3/2 (21) | apps/mvp/docs/features/issues.md (1), apps/mvp/docs/work/issues-credential-regressions.md (14), apps/mvp/src/features/issues/api.test.ts (2), apps/mvp/src/flows/bearer.test.ts (2) |
| `a2f7e9ecfd` |  | 1 | PARTIAL 1 | 5/1/3/2 (21) | apps/mvp/docs/features/issues.md (1), apps/mvp/docs/work/issues-credential-regressions.md (14), apps/mvp/src/features/issues/api.test.ts (2), apps/mvp/src/flows/bearer.test.ts (2) |
| `17e2945bbf` |  | 6 | SUPERSEDED 5, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `7868be5b9e` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `5e1367ab36` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `7cb5dc288a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `353f2e5d04` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b2273ae344` |  | 1 | PARTIAL 1 | 10/10/1/2 (15) | apps/mvp/alchemy.run.ts (1), apps/mvp/src/pwa.test.ts (2), apps/mvp/src/pwa.ts (12) |
| `c77b0a5f1b` |  | 1 | PARTIAL 1 | 20/5/2/0 (4) | apps/mvp/docs/features/agent.md (1), apps/mvp/worker/RemoteRuns.test.ts (3) |
| `21c0144bb6` |  | 1 | PARTIAL 1 | 20/5/2/0 (4) | apps/mvp/docs/features/agent.md (1), apps/mvp/worker/RemoteRuns.test.ts (3) |
| `3a7583d2a4` |  | 14 | SUPERSEDED 12, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `e590a58446` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `77ddb01b0b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5b98c350d1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e40338f43b` |  | 6 | SUPERSEDED 4, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `e3768f0bbb` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `ec7d7c6624` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3fc7fba833` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `203fe63ffe` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `70b8f50242` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c9e222ddfe` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `8a89c2b412` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d4bea2d48e` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `7c61791ef6` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `77324a93d1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6b0c3c7a73` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `877e38d8b9` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `41d3a29143` |  | 1 | PARTIAL 1 | 96/4/4/8 (39) | apps/mvp/docs/work/dprint-fix.md (8), apps/site/PACKAGE.ts (6), apps/site/scripts/built-site.test.mjs (24), apps/site/scripts/check-built-site.mjs (1) |
| `b4dddf3ab4` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `968a2cc56e` |  | 3 | ON-MAIN 1, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `4ab24343c4` |  | 8 | STRANDED 2, PARTIAL 5, ON-MAIN 1 | 111/52/13/3 (53) | apps/mvp/db/Database.ts (6), apps/mvp/db/migrations/0041_drop_merge_unknown.ts (1), apps/mvp/docs/decisions/0027-github-projection-ordering.md (3), apps/mvp/docs/features/issues.md (1) |
| `322f79a90b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `907b74aaa3` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `1de8c0a2fa` |  | 1 | PARTIAL 1 | 19/4/2/1 (6) | apps/mvp/docs/features/agent.md (1), apps/mvp/docs/work/fix-worker-590838.md (2), apps/mvp/worker/RemoteRuns.test.ts (3) |
| `dd9fb460f8` |  | 1 | PARTIAL 1 | 19/4/2/1 (6) | apps/mvp/docs/features/agent.md (1), apps/mvp/docs/work/fix-worker-590838.md (2), apps/mvp/worker/RemoteRuns.test.ts (3) |
| `3b36f1b2c6` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a57b7d5307` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `8bd9c74228` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5a907b6f1c` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d0433ae821` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `98cbe44f85` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 69/13/16/19 (817) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (19), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md (19), apps/mvp/docs/observability.md (2) |
| `ba625281be` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 59/20/1/2 (5) | apps/mvp/src/boot.test.ts (2), apps/mvp/src/features/attention/attention.test.ts (2), apps/mvp/src/features/attention/store.ts (1) |
| `a89f3e09e3` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 50/17/6/7 (334) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (11), apps/mvp/e2e/sign-in.spec.ts (2), apps/mvp/src/device/identity.ts (104) |
| `183bb84623` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 52/15/9/16 (382) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (25), apps/mvp/docs/observability.md (3), apps/mvp/e2e/sign-in.spec.ts (19) |
| `206af62995` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `79f6054a78` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `28e108b028` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `fa5176b235` |  | 19 | EMPTY-ISH 1, SUPERSEDED 13, ON-MAIN 5 | 0/0/0/0 (0) |  |
| `f8074e6564` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8d3f1bb804` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `62778583ba` |  | 25 | SCAFFOLD 1, PARTIAL 19, STRANDED 3, ON-MAIN 1, SUPERSEDED 1 | 51/10/113/17 (7498) | .changeset/agent-external-agent-flow-type.md (4), .changeset/agent-external-agent.md (31), .changeset/agent-harness-cli.md (30), .changeset/cli-runner.md (28) |
| `ce6d2ab3ae` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `71c9f6ae2f` |  | 1 | PARTIAL 1 | 2/0/2/1 (7) | apps/mvp/docs/features/home.md (1), apps/mvp/docs/work/home-action-navigation.md (2), apps/mvp/src/features/home/actions.ts (4) |
| `c4a38e7a0c` |  | 1 | PARTIAL 1 | 2/0/2/1 (7) | apps/mvp/docs/features/home.md (1), apps/mvp/docs/work/home-action-navigation.md (2), apps/mvp/src/features/home/actions.ts (4) |
| `88d3fd4cb9` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `cc384cd697` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `66491a2430` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 30/6/2/2 (14) | apps/mvp/docs/work/run-change-feed-progress.md (8), apps/mvp/src/features/runs/remote.test.ts (5), apps/mvp/src/test/chatApi.ts (1) |
| `1f61aefdd2` |  | 8 | STRANDED 2, PARTIAL 5, ON-MAIN 1 | 111/52/13/3 (53) | apps/mvp/db/Database.ts (6), apps/mvp/db/migrations/0041_drop_merge_unknown.ts (1), apps/mvp/docs/decisions/0027-github-projection-ordering.md (3), apps/mvp/docs/features/issues.md (1) |
| `911860abdb` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `15f0dbca51` |  | 1 | PARTIAL 1 | 0/0/6/2 (53) | apps/mvp/PACKAGE.test.ts (21), apps/mvp/dev/vite-fs.test.ts (17), apps/mvp/docs/work/fix-apps-mvp-023236.md (13), apps/mvp/package.json (1) |
| `32562de10e` |  | 1 | PARTIAL 1 | 0/0/6/2 (53) | apps/mvp/PACKAGE.test.ts (21), apps/mvp/dev/vite-fs.test.ts (17), apps/mvp/docs/work/fix-apps-mvp-023236.md (13), apps/mvp/package.json (1) |
| `73e68aed9e` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `9ea9fe32a2` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `0a3e757882` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `afee49fd47` |  | 5 | PARTIAL 1, SUPERSEDED 4 | 227/22/3/20 (123) | packages/smithers/flows/patterns/docs/teams.md (2), packages/smithers/flows/patterns/src/DelegationChain.ts (5), packages/smithers/flows/patterns/src/Intervene.ts (4), packages/smithers/flows/patterns |
| `4a771d7c8d` |  | 5 | ON-MAIN 1, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `0a20cc956d` |  | 7 | STRANDED 1, SUPERSEDED 6 | 246/16/0/20 (180) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/Runbook.ts (8), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns |
| `04ed73a6e6` |  | 6 | ON-MAIN 1, SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `1829e9d7ab` |  | 34 | SUPERSEDED 23, ON-MAIN 11 | 0/0/0/0 (0) |  |
| `8fd3572d81` |  | 34 | SUPERSEDED 23, ON-MAIN 11 | 0/0/0/0 (0) |  |
| `87dde44da6` |  | 34 | SUPERSEDED 23, ON-MAIN 11 | 0/0/0/0 (0) |  |
| `9a5507edcc` |  | 3 | PARTIAL 1, ON-MAIN 1, SUPERSEDED 1 | 14/6/0/1 (15) | apps/mvp/docs/work/branch-page-regressions.md (15) |
| `41fd5f06de` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 30/6/2/2 (25) | apps/mvp/docs/work/run-change-feed-progress.md (19), apps/mvp/src/features/runs/remote.test.ts (5), apps/mvp/src/test/chatApi.ts (1) |
| `8c9a5d26e3` |  | 3 | PARTIAL 1, ON-MAIN 1, SUPERSEDED 1 | 14/5/0/1 (15) | apps/mvp/docs/work/branch-page-regressions.md (15) |
| `b5dc8aa8ca` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c718c8d18f` |  | 5 | SUPERSEDED 4, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `182c15c7f8` |  | 6 | SUPERSEDED 5, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `b524eb7b22` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `563a400092` |  | 7 | PARTIAL 1, SUPERSEDED 6 | 249/16/0/17 (112) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns/src/index.ts (3), packages/smithers/flows/patterns/s |
| `b2604d9a24` |  | 4 | ON-MAIN 2, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `6d98f20152` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 50/17/6/7 (334) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (11), apps/mvp/e2e/sign-in.spec.ts (2), apps/mvp/src/device/identity.ts (104) |
| `0d169e9217` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 52/15/9/16 (382) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (14), apps/mvp/docs/features/sign-in.md (25), apps/mvp/docs/observability.md (3), apps/mvp/e2e/sign-in.spec.ts (19) |
| `e92fcf3e80` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `1d46172b03` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `75b80c768b` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 30/6/2/2 (21) | apps/mvp/docs/work/run-change-feed-progress.md (15), apps/mvp/src/features/runs/remote.test.ts (5), apps/mvp/src/test/chatApi.ts (1) |
| `1c02db0ba8` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `6477a5d540` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b8a154457f` |  | 1 | PARTIAL 1 | 0/0/7/2 (87) | apps/mvp/docs/work/fix-browser-filesystem-441211.md (13), packages/smithers/flows/platform-browser/docs/testing.md (4), packages/smithers/flows/platform-browser/src/BrowserFileSystem/fileInfo.ts (6),  |
| `f129e8e7ef` |  | 1 | PARTIAL 1 | 2/0/12/1 (108) | apps/mvp/docs/features/issues.md (6), apps/mvp/docs/work/fix-issues-completion-236531.md (15), apps/mvp/src/features/issues/actions.ts (17), apps/mvp/src/features/issues/issues.test.ts (63) |
| `0267262ad7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8770d3b357` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `ecea1e22e6` |  | 1 | PARTIAL 1 | 9/0/1/1 (2) | apps/mvp/docs/work/flow-sibling-suspension-codec.md (1), packages/smithers/flows/flow/docs/concepts/suspension-and-replay.md (1) |
| `a750cccd36` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ce6c44a649` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `0d2938e7df` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d16d5d5adc` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `cfb32e285e` |  | 5 | PARTIAL 1, ON-MAIN 3, SUPERSEDED 1 | 96/7/0/3 (98) | apps/mvp/docs/work/time-travel-generation-evidence.md (15), packages/smithers/flows/time-travel/src/SqlTimeTravelStore.ts (11), packages/smithers/flows/time-travel/test/RecoveryGenerationEvidence.test |
| `514c5839a7` |  | 1 | PARTIAL 1 | 2/0/20/6 (146) | apps/mvp/docs/features/chat.md (4), apps/mvp/docs/work/chat-regressions-212049.md (7), apps/mvp/src/features/chat/actions.ts (17), apps/mvp/src/features/chat/api.test.ts (7) |
| `834c49417b` |  | 5 | ON-MAIN 1, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `fe44e5949f` |  | 7 | PARTIAL 1, SUPERSEDED 6 | 248/16/0/18 (113) | packages/smithers/flows/patterns/src/DelegationChain.ts (2), packages/smithers/flows/patterns/src/Runbook.ts (1), packages/smithers/flows/patterns/src/Trellis.ts (16), packages/smithers/flows/patterns |
| `2f5b9204b2` |  | 5 | PARTIAL 4, ON-MAIN 1 | 90/37/7/0 (11) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/issues.md (1), apps/mvp/e2e/target.test.ts (1), apps/mvp/worker/ChatApiProgram.ts (3) |
| `aba350c47e` |  | 5 | PARTIAL 4, ON-MAIN 1 | 91/37/7/0 (11) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/issues.md (1), apps/mvp/e2e/target.test.ts (1), apps/mvp/worker/ChatApiProgram.ts (3) |
| `b1e0d86cb7` |  | 5 | ON-MAIN 4, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2bab452b78` |  | 5 | PARTIAL 1, ON-MAIN 3, SUPERSEDED 1 | 107/0/1/0 (27) | apps/mvp/docs/work/time-travel-renew-fork-reservation.md (27) |
| `62a5b476f6` |  | 6 | SUPERSEDED 5, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `997ce2d97f` |  | 5 | PARTIAL 1, ON-MAIN 3, SUPERSEDED 1 | 107/0/1/0 (27) | apps/mvp/docs/work/time-travel-renew-fork-reservation.md (27) |
| `1e6feffb1d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c34fffd1da` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `c0a47af784` |  | 2 | PARTIAL 1, ON-MAIN 1 | 43/8/1/1 (6) | apps/mvp/e2e/target.ts (4), apps/mvp/evals/session.ts (2) |
| `e277aa90b2` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `ca2049bfe8` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `98df062f2f` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `84d9ec003d` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `985aa1c5af` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `4400cde8bf` |  | 6 | SUPERSEDED 5, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `9690d66623` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `e18258be21` |  | 9 | PARTIAL 6, ON-MAIN 1, SUPERSEDED 1, STRANDED 1 | 40/9/43/4 (2186) | .changeset/agent-external-agent.md (31), .changeset/mcp-server.md (23), .smithers/flows/release/fixtures/public-api-baseline.json (7), apps/site/public/llms-full.txt (166) |
| `4e803f491a` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `50a8bb7c70` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d053c51c14` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d9f667dd21` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `23f5cee51b` |  | 5 | PARTIAL 1, ON-MAIN 3, SUPERSEDED 1 | 107/0/1/0 (23) | apps/mvp/docs/work/time-travel-renew-fork-reservation.md (23) |
| `4864de0363` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `36df16b6cd` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `3bfa24b71f` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 106/48/8/2 (38) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/stack/Stack.ts (10) |
| `44072e34e3` |  | 4 | ON-MAIN 2, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `44ae9f7030` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 134/24/9/6 (44) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md (1), apps/mvp/e2e/sign-in.spec.ts (3) |
| `cb85ebcf38` |  | 15 | PARTIAL 11, SUPERSEDED 1, EMPTY-ISH 1, ON-MAIN 1, STRANDED 1 | 25/4/64/11 (3836) | .changeset/agent-external-agent.md (31), .changeset/mcp-server.md (29), .smithers/flows/release/fixtures/public-api-baseline.json (7), apps/mvp/AGENTS.md (2) |
| `bc01f1205d` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 0/1/0/1 (16) | packages/smithers/flows/engine-store/test/RunChangeProgress.test.ts (16) |
| `ab8a05ee3e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `90b1d68b70` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 107/21/15/13 (519) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (15), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md  |
| `ab5f407304` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 2/1/3/3 (41) | apps/mvp/docs/work/run-change-feed-progress.md (16), apps/mvp/src/features/runs/remote.test.ts (5), apps/mvp/src/test/chatApi.ts (1), packages/smithers/flows/engine-store/test/RunChangeProgress.test.t |
| `3b3ffdc94c` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `ad0b6bbbbe` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `40d9433e74` |  | 1 | PARTIAL 1 | 227/152/247/5079 (65252) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11552), apps/maintainer-site/queue/queue.json (197), apps/mvp/db/Database.ts (2) |
| `250d68f731` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `fcb0f1f644` |  | 5 | PARTIAL 4, ON-MAIN 1 | 88/38/10/1 (25) | apps/mvp/PACKAGE.ts (9), apps/mvp/db/Database.ts (2), apps/mvp/docs/features/issues.md (1), apps/mvp/docs/rules.md (3) |
| `133177b7ce` |  | 1 | PARTIAL 1 | 227/152/247/5079 (65252) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11552), apps/maintainer-site/queue/queue.json (197), apps/mvp/db/Database.ts (2) |
| `e7737158b0` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `d92797640d` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `8e76e1670f` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 107/21/15/13 (519) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (15), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md  |
| `45d6da7d54` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `b541e7346c` |  | 3 | STRANDED 2, SUPERSEDED 1 | 8544/24/14/34 (940) | .github/actionlint.yaml (6), .github/scripts/ci/cloud.sh (3), .github/scripts/reference-host/job-started.sh (103), .github/scripts/reference-host/job-started.test.mjs (146) |
| `b8a380c99d` |  | 6 | ON-MAIN 2, SUPERSEDED 3, PARTIAL 1 | 136/30/1/0 (2) | apps/mvp/worker/ChatApi.ts (2) |
| `7886df0eb0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d3037136fb` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `caad251749` |  | 2 | ON-MAIN 2 | 0/0/0/0 (0) |  |
| `8b6cad2c35` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 107/21/15/13 (519) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (15), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md  |
| `d464438d7f` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 106/48/8/2 (38) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/stack/Stack.ts (10) |
| `c9b2102f21` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `bcb6e3124c` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `6a15b126a1` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 102/46/7/3 (172) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (79) |
| `44950d7853` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 103/48/5/2 (162) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/e2e/dogfood.spec.ts (143), apps/mvp/worker/BranchSandboxes.ts (3) |
| `04acef4549` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 104/48/8/2 (38) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/stack/Stack.ts (10) |
| `2cac886f0a` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 103/48/5/2 (162) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/e2e/dogfood.spec.ts (143), apps/mvp/worker/BranchSandboxes.ts (3) |
| `43205e918b` |  | 3 | STRANDED 2, SUPERSEDED 1 | 8544/24/14/34 (924) | .github/actionlint.yaml (6), .github/scripts/ci/cloud.sh (3), .github/scripts/reference-host/job-started.sh (103), .github/scripts/reference-host/job-started.test.mjs (146) |
| `55e13cd8b2` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 107/21/15/13 (519) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (15), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md  |
| `c318874875` |  | 4 | PARTIAL 3, SUPERSEDED 1 | 132/24/8/6 (37) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md (1), apps/mvp/e2e/sign-in.spec.ts (3) |
| `f74c52ee8d` |  | 5 | PARTIAL 1, SUPERSEDED 4 | 218/21/5/20 (119) | packages/smithers/agent/memory/docs/api.md (1), packages/smithers/agent/memory/src/MemoryTrellis.ts (1), packages/smithers/flows/patterns/docs/api.md (4), packages/smithers/flows/patterns/docs/teams.m |
| `f33dbdf019` |  | 5 | ON-MAIN 1, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `a30aac00cf` |  | 6 | SUPERSEDED 6 | 0/0/0/0 (0) |  |
| `8b0ce50021` |  | 5 | SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `5a74dadf64` |  | 5 | PARTIAL 1, SUPERSEDED 4 | 221/21/3/19 (106) | .changeset/patterns-trellis-durable-rounds.md (4), packages/smithers/flows/patterns/docs/teams.md (2), packages/smithers/flows/patterns/src/DelegationChain.ts (5), packages/smithers/flows/patterns/src |
| `4252137cd8` |  | 6 | ON-MAIN 1, SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `8295439dd9` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `5bf869dd55` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `5500254fa2` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `f17e71d70d` |  | 4 | ON-MAIN 3, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `1f66b87609` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `001b7bcf34` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `319fe4bb38` |  | 4 | PARTIAL 3, SUPERSEDED 1 | 124/27/6/3 (23) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/observability.md (2), apps/mvp/src/features/auth/store.ts (1) |
| `2b50710416` |  | 6 | ON-MAIN 2, SUPERSEDED 3, PARTIAL 1 | 136/30/1/0 (2) | apps/mvp/worker/ChatApi.ts (2) |
| `05686de888` |  | 5 | SUPERSEDED 4, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `65aa2e5ea1` |  | 4 | PARTIAL 3, SUPERSEDED 1 | 117/24/14/14 (489) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (15), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md  |
| `c8103ca98a` |  | 6 | ON-MAIN 1, SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `b9e043826b` |  | 6 | SUPERSEDED 6 | 0/0/0/0 (0) |  |
| `ac07bc9451` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 102/46/10/3 (100) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (48) |
| `8c47f86713` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 104/46/10/3 (100) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (48) |
| `6faf10f20f` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 104/46/10/3 (100) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (48) |
| `fed0124841` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 101/46/7/3 (224) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/e2e/dogfood.spec.ts (143), apps/mvp/worker/BranchSandboxes.ts (3) |
| `b20d32561c` |  | 6 | SUPERSEDED 5, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `3a92d94250` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `17a0b5addc` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `abe7287882` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 101/46/7/3 (224) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/e2e/dogfood.spec.ts (143), apps/mvp/worker/BranchSandboxes.ts (3) |
| `01f13eed0c` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `354a880329` |  | 3 | ON-MAIN 1, SUPERSEDED 1, PARTIAL 1 | 70/12/3/0 (81) | apps/site/public/llms-full.txt (27), apps/site/src/content/docs/docs/reference/api/platform-browser.mdx (27), packages/smithers/flows/platform-browser/docs/api.md (27) |
| `b544f92f59` |  | 5 | PARTIAL 1, SUPERSEDED 4 | 211/17/3/18 (102) | packages/smithers/flows/patterns/docs/teams.md (2), packages/smithers/flows/patterns/src/DelegationChain.ts (5), packages/smithers/flows/patterns/src/Intervene.ts (4), packages/smithers/flows/patterns |
| `6969bbcb4a` |  | 6 | ON-MAIN 1, SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `03949a34d5` |  | 5 | ON-MAIN 1, SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `c5622c9c0d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `01e3888243` |  | 5 | PARTIAL 1, SUPERSEDED 2, ON-MAIN 2 | 69/4/6/16 (171) | apps/mvp/docs/work/time-travel-generation-evidence.md (15), packages/smithers/flows/time-travel/docs/api.md (25), packages/smithers/flows/time-travel/docs/guides/provide-a-store.md (2), packages/smith |
| `b81df565e1` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 105/46/9/2 (35) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (10) |
| `3a369a27d1` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 105/46/9/2 (35) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (10) |
| `51aa8189b0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `bdbbf3bb25` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `924ae3954b` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `78a991ada8` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `e0366b830e` |  | 5 | SUPERSEDED 5 | 0/0/0/0 (0) |  |
| `0700de245e` |  | 5 | PARTIAL 1, SUPERSEDED 4 | 207/17/5/20 (119) | packages/smithers/agent/memory/docs/api.md (1), packages/smithers/agent/memory/src/MemoryTrellis.ts (1), packages/smithers/flows/patterns/docs/api.md (4), packages/smithers/flows/patterns/docs/teams.m |
| `947bdf378b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c9b1279c8b` |  | 1 | PARTIAL 1 | 23/14/3/1 (33) | apps/mvp/.sol-review-baseline.json (1), apps/mvp/.sol-review-red.mjs (7), apps/mvp/.sol-review-validate.mjs (7), apps/mvp/src/features/attention/branch-page.test.ts (18) |
| `e16546f509` |  | 3 | ON-MAIN 1, SUPERSEDED 1, PARTIAL 1 | 70/12/3/0 (3) | apps/site/public/llms-full.txt (1), apps/site/src/content/docs/docs/reference/api/platform-browser.mdx (1), packages/smithers/flows/platform-browser/docs/api.md (1) |
| `e268a29c73` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `9937f548f9` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `e045d2151d` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b7ee053aa8` |  | 3 | SUPERSEDED 1, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `2bb993d7cb` |  | 5 | PARTIAL 5 | 1/1/121/17 (1013) | .changeset/electric-collection-evict.md (10), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_session_role_verified.ts (7), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority. |
| `7ed39694df` |  | 5 | PARTIAL 5 | 1/1/121/17 (1013) | .changeset/electric-collection-evict.md (10), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_session_role_verified.ts (7), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority. |
| `dcd3dc5fb7` |  | 3 | SUPERSEDED 2, PARTIAL 1 | 67/13/4/0 (11) | apps/mvp/e2e/local-first-conflicts.spec.ts (8), apps/site/public/llms-full.txt (1), apps/site/src/content/docs/docs/reference/api/platform-browser.mdx (1), packages/smithers/flows/platform-browser/doc |
| `c539a4e7e0` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `0ecd648e5b` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `c558742b0f` |  | 3 | ON-MAIN 1, SUPERSEDED 1, PARTIAL 1 | 69/12/3/0 (3) | apps/site/public/llms-full.txt (1), apps/site/src/content/docs/docs/reference/api/platform-browser.mdx (1), packages/smithers/flows/platform-browser/docs/api.md (1) |
| `1340c277b5` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `29b4ce4166` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e141cdd55c` |  | 6 | SUPERSEDED 4, ON-MAIN 1, PARTIAL 1 | 134/30/1/0 (2) | apps/mvp/worker/ChatApi.ts (2) |
| `f987f4d487` |  | 1 | PARTIAL 1 | 15/2/8/19 (83) | .changeset/time-travel-fork-intent-reclamation.md (2), apps/mvp/docs/work/time-travel-fork-intent-reclamation.md (11), packages/smithers/flows/time-travel/docs/api.md (21), packages/smithers/flows/tim |
| `31778ff498` |  | 12 | PARTIAL 3, SUPERSEDED 7, EMPTY-ISH 1, ON-MAIN 1 | 570/113/6/3 (17) | .smithers/flows/release/fixtures/public-api-baseline.json (6), apps/mvp/docs/work/vibelang-package-migration.md (6), apps/site/astro.config.mjs (3), evals/docs/bunfig.toml (1) |
| `ad5cff7222` |  | 12 | PARTIAL 3, SUPERSEDED 7, EMPTY-ISH 1, ON-MAIN 1 | 570/113/6/3 (15) | .smithers/flows/release/fixtures/public-api-baseline.json (6), apps/mvp/docs/work/vibelang-package-migration.md (4), apps/site/astro.config.mjs (3), evals/docs/bunfig.toml (1) |
| `f99a272901` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `9f24605ced` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `2df6b4ce9d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `30c93e58e5` |  | 1 | PARTIAL 1 | 2/0/16/7 (182) | apps/mvp/docs/decisions/0028-chat-draft-and-delivery-isolation.md (7), apps/mvp/docs/features/chat.md (6), apps/mvp/docs/work/chat-regressions-683390.md (8), apps/mvp/src/features/chat/actions.ts (16) |
| `cbe8fe86e7` |  | 1 | PARTIAL 1 | 8/3/1/5 (77) | packages/smithers/flows/database/src/DatabaseMetrics.ts (1), packages/smithers/flows/database/src/postgres/PostgresDatabase.ts (1), packages/smithers/flows/platform-cloudflare/package.json (1), packag |
| `1cabd1f1c2` |  | 1 | PARTIAL 1 | 28/28/4/1 (12) | apps/mvp/db/Database.ts (2), apps/mvp/docs/decisions/0027-github-projection-ordering.md (3), apps/mvp/vitest.config.ts (1), apps/mvp/worker/github/Api.ts (6) |
| `f31eb50189` |  | 1 | PARTIAL 1 | 13/10/6/6 (51) | apps/mvp/.sol-review-baseline.json (1), apps/mvp/.sol-review-red.mjs (7), apps/mvp/src/features/attention/api.test.ts (3), apps/mvp/src/features/attention/api.ts (2) |
| `88f0d76616` |  | 1 | PARTIAL 1 | 2/0/15/8 (182) | apps/mvp/docs/decisions/0028-chat-draft-and-delivery-isolation.md (7), apps/mvp/docs/features/chat.md (6), apps/mvp/docs/work/chat-regressions-683390.md (8), apps/mvp/src/features/chat/actions.ts (16) |
| `b008dcea7c` |  | 23 | SUPERSEDED 13, ON-MAIN 6, PARTIAL 4 | 281/84/115/18 (955) | .changeset/electric-collection-evict.md (10), apps/mvp/db/Database.ts (4), apps/mvp/db/migrations/0038_session_role_verified.ts (7), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority. |
| `a9a0cca0a4` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `efb69411db` |  | 11 | SUPERSEDED 7, PARTIAL 1, ON-MAIN 3 | 54/30/0/2 (5) | apps/mvp/worker/flows/Todo.test.ts (5) |
| `65e5c1587b` |  | 9 | SUPERSEDED 5, PARTIAL 1, ON-MAIN 3 | 51/28/0/1 (1) | apps/mvp/worker/flows/Todo.test.ts (1) |
| `5ea747ed39` |  | 4 | PARTIAL 1, SUPERSEDED 2, ON-MAIN 1 | 10/17/0/0 (0) |  |
| `3a4c9409b0` |  | 25 | STRANDED 7, PARTIAL 8, SUPERSEDED 7, ON-MAIN 3 | 86/40/208/26 (3211) | .changeset/docs-home-url-string.md (2), .changeset/ui-page-pane.md (4), .changeset/views-docs.md (8), .gitignore (2) |
| `cd3478b0c2` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `ac93b8b123` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `4fbbbe9cd2` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 102/46/7/3 (174) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/e2e/dogfood.spec.ts (143), apps/mvp/worker/BranchSandboxes.ts (3) |
| `3443e5d126` |  | 6 | SUPERSEDED 5, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `29e6aa7cbb` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 103/46/9/2 (35) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (10) |
| `df704c1faa` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 102/46/7/3 (174) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/e2e/dogfood.spec.ts (143), apps/mvp/worker/BranchSandboxes.ts (3) |
| `2700fb6351` |  | 1 | PARTIAL 1 | 28/28/4/1 (12) | apps/mvp/db/Database.ts (2), apps/mvp/docs/decisions/0027-github-projection-ordering.md (3), apps/mvp/vitest.config.ts (1), apps/mvp/worker/github/Api.ts (6) |
| `06889e5501` |  | 13 | PARTIAL 4, ON-MAIN 4, SUPERSEDED 5 | 162/54/114/18 (1005) | .changeset/electric-collection-evict.md (10), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_session_role_verified.ts (7), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority. |
| `aec510490c` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `a997886458` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `7bc4b5408b` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 102/46/7/3 (174) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/e2e/dogfood.spec.ts (143), apps/mvp/worker/BranchSandboxes.ts (3) |
| `063cd73166` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 103/46/9/2 (35) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (10) |
| `f30888f5ce` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 102/46/7/3 (174) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/e2e/dogfood.spec.ts (143), apps/mvp/worker/BranchSandboxes.ts (3) |
| `f9da52c50b` |  | 20 | SUPERSEDED 4, ON-MAIN 4, STRANDED 6, PARTIAL 6 | 110/36/205/27 (3244) | .changeset/docs-home-url-string.md (2), .changeset/ui-page-pane.md (4), .changeset/views-docs.md (8), .gitignore (2) |
| `1b350c0982` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `9ff7f5bc65` |  | 13 | PARTIAL 4, ON-MAIN 4, SUPERSEDED 5 | 162/54/114/18 (1005) | .changeset/electric-collection-evict.md (10), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_session_role_verified.ts (7), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority. |
| `0cabd611c1` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 103/46/7/2 (31) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (10) |
| `10816fe72b` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `edc2e4c7a1` |  | 7 | PARTIAL 1, SUPERSEDED 4, ON-MAIN 2 | 103/46/9/2 (35) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/worker/BranchSandboxes.ts (3), apps/mvp/worker/flows/Todo.ts (10) |
| `7fd6439ba8` |  | 4 | SUPERSEDED 1, ON-MAIN 2, PARTIAL 1 | 109/24/0/2 (58) | apps/mvp/worker/ChatApi.ts (56), apps/mvp/worker/flows/Todo.test.ts (2) |
| `ef3d9b5979` |  | 4 | STRANDED 1, SUPERSEDED 2, ON-MAIN 1 | 14/10/0/1 (6) | apps/mvp/docs/work/repo-pages-header-and-locators.md (6) |
| `de3650a43e` |  | 1 | PARTIAL 1 | 10/1/1/1 (2) | apps/mvp/worker/ModelRoles.ts (2) |
| `2c3ed92c19` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `4e5a3f192b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c2a28622ce` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5901fa606c` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b12047308c` |  | 13 | SUPERSEDED 7, ON-MAIN 6 | 0/0/0/0 (0) |  |
| `a18ce6bbb6` |  | 1 | PARTIAL 1 | 21/0/0/2 (9) | apps/mvp/bench/follower-regressions.test.ts (7), apps/mvp/docs/work/bench-correctness.md (2) |
| `c35f6d9fb1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e1095b962f` |  | 7 | SUPERSEDED 5, PARTIAL 2 | 141/67/2/8 (90) | apps/mvp/docs/decisions/0024-watching-a-todo-run.md (7), apps/mvp/docs/features/runs.md (3), apps/mvp/src/features/runs/remote.test.ts (36), apps/mvp/src/features/runs/store.test.ts (9) |
| `fd43214bf2` |  | 1 | PARTIAL 1 | 19/6/0/2 (3) | apps/mvp/docs/work/platform-browser-internal-regressions.md (2), packages/smithers/flows/platform-browser/docs/guides/show-code-intelligence.md (1) |
| `ac996be8c8` |  | 17 | SUPERSEDED 11, ON-MAIN 6 | 0/0/0/0 (0) |  |
| `30cfc6ec61` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e7c2dfa26f` |  | 6 | PARTIAL 1, SUPERSEDED 3, ON-MAIN 2 | 14/16/1/0 (9) | .smithers/flows/release/fixtures/public-api-baseline.json (9) |
| `a5b0da83bb` |  | 13 | SUPERSEDED 9, ON-MAIN 4 | 0/0/0/0 (0) |  |
| `7c0c916980` |  | 11 | SUPERSEDED 7, ON-MAIN 4 | 0/0/0/0 (0) |  |
| `b582dd6f9e` |  | 27 | STRANDED 7, PARTIAL 7, SUPERSEDED 9, ON-MAIN 4 | 90/40/208/26 (3211) | .changeset/docs-home-url-string.md (2), .changeset/ui-page-pane.md (4), .changeset/views-docs.md (8), .gitignore (2) |
| `d88d0cf0df` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 86/40/2/8 (90) | apps/mvp/docs/decisions/0024-watching-a-todo-run.md (7), apps/mvp/docs/features/runs.md (3), apps/mvp/src/features/runs/remote.test.ts (36), apps/mvp/src/features/runs/store.test.ts (9) |
| `3d8110d1c5` |  | 1 | PARTIAL 1 | 2/0/14/8 (138) | apps/mvp/docs/work/time-travel-storage-regressions.md (19), packages/smithers/flows/time-travel/docs/guides/fork-a-run.md (8), packages/smithers/flows/time-travel/src/MemoryTimeTravelStore.ts (11), pa |
| `dd12f89340` |  | 18 | SUPERSEDED 12, ON-MAIN 6 | 0/0/0/0 (0) |  |
| `a573dd28f2` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5cb08384b1` |  | 22 | PARTIAL 1, SUPERSEDED 13, ON-MAIN 8 | 127/32/2/4 (20) | apps/mvp/worker/flows/Todo.test.ts (2), packages/smithers/flows/engine/src/FlowEngine/ActionKey.ts (7), packages/smithers/flows/engine/src/FlowEngine/Dispatch.ts (3), packages/smithers/flows/engine-st |
| `538b7b9572` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `531bfc5f56` |  | 20 | SUPERSEDED 4, ON-MAIN 4, STRANDED 6, PARTIAL 6 | 110/36/205/27 (3244) | .changeset/docs-home-url-string.md (2), .changeset/ui-page-pane.md (4), .changeset/views-docs.md (8), .gitignore (2) |
| `48208181b8` |  | 1 | PARTIAL 1 | 0/1/1/0 (1) | .smithers/flows/release/fixtures/public-api-baseline.json (1) |
| `37e0698c1d` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `3dd43987e7` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `a3b0e6cbce` |  | 1 | PARTIAL 1 | 2/0/13/7 (124) | apps/mvp/docs/work/time-travel-storage-regressions.md (7), packages/smithers/flows/time-travel/docs/guides/fork-a-run.md (8), packages/smithers/flows/time-travel/src/MemoryTimeTravelStore.ts (11), pac |
| `fcf850ee1d` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `4949a83285` |  | 1 | PARTIAL 1 | 52/81/4/2 (13) | apps/mvp/db/Database.ts (2), apps/mvp/docs/decisions/0027-github-projection-ordering.md (3), apps/mvp/docs/work/github-ordering-fixes.md (1), apps/mvp/vitest.config.ts (1) |
| `14cd4d44e8` |  | 1 | PARTIAL 1 | 0/1/1/0 (1) | .smithers/flows/release/fixtures/public-api-baseline.json (1) |
| `c9ccd9c40f` |  | 1 | PARTIAL 1 | 2/1/23/4 (158) | apps/mvp/db/Database.test.ts (19), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_flow_draft_receipts.ts (11), apps/mvp/docs/decisions/0038-draft-save-concurrency.md (6) |
| `7440233936` |  | 1 | PARTIAL 1 | 2/1/23/4 (163) | apps/mvp/db/Database.test.ts (19), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_flow_draft_receipts.ts (11), apps/mvp/docs/decisions/0038-draft-save-concurrency.md (6) |
| `850106b3a9` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `89a34240a7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `91cee7a477` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c659b0153c` |  | 1 | PARTIAL 1 | 16/0/3/1 (37) | apps/mvp/docs/work/plan-confirmed-bugs-586345.md (24), packages/smithers/flows/plan/docs/concepts/authoring-ast.md (11), packages/smithers/flows/plan/src/FileSet.ts (1), packages/smithers/flows/plan/s |
| `ab3cc44f15` |  | 8 | PARTIAL 6, EMPTY-ISH 1, ON-MAIN 1 | 7/0/56/9 (2820) | .changeset/mcp-server.md (29), .smithers/flows/release/fixtures/public-api-baseline.json (7), apps/mvp/AGENTS.md (2), apps/mvp/db/Database.ts (2) |
| `0ea193cb82` |  | 1 | PARTIAL 1 | 10/2/1/1 (30) | apps/mvp/docs/work/worker-953411.md (27), apps/mvp/worker/AlertChannels.test.ts (3) |
| `e2e332627a` |  | 1 | PARTIAL 1 | 10/2/1/1 (30) | apps/mvp/docs/work/worker-953411.md (27), apps/mvp/worker/AlertChannels.test.ts (3) |
| `183b6a9993` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `aafdad4fc2` |  | 1 | PARTIAL 1 | 15/1/0/4 (31) | apps/mvp/docs/work/time-travel-evidence-586651.md (2), packages/smithers/flows/time-travel/README.md (1), packages/smithers/flows/time-travel/src/EffectBoundary.ts (3), packages/smithers/flows/time-tr |
| `7db8f80fce` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a2f4b43226` |  | 9 | PARTIAL 7, EMPTY-ISH 1, ON-MAIN 1 | 7/0/56/9 (2820) | .changeset/mcp-server.md (29), .smithers/flows/release/fixtures/public-api-baseline.json (7), apps/mvp/AGENTS.md (2), apps/mvp/db/Database.ts (2) |
| `8d6d9f946c` |  | 1 | PARTIAL 1 | 1/1/1/0 (3) | .smithers/flows/release/fixtures/public-api-baseline.json (3) |
| `f10019f8ed` |  | 20 | SUPERSEDED 4, ON-MAIN 4, STRANDED 6, PARTIAL 6 | 110/39/206/26 (3192) | .changeset/docs-home-url-string.md (2), .changeset/ui-page-pane.md (4), .changeset/views-docs.md (8), .gitignore (2) |
| `c3be9c0f71` |  | 1 | PARTIAL 1 | 17/1/1/6 (14) | apps/mvp/docs/work/browser-platform-failure-regressions.md (1), packages/smithers/flows/platform-browser/src/BrowserLanguageServer.ts (2), packages/smithers/flows/platform-browser/test/BrowserEngine.t |
| `3276853346` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5268957e32` |  | 4 | SUPERSEDED 3, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `dcd274e4b1` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `35b00bcc5f` |  | 3 | SUPERSEDED 2, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `1ece3c2d19` |  | 2 | PARTIAL 1, ON-MAIN 1 | 43/8/1/1 (6) | apps/mvp/e2e/target.ts (4), apps/mvp/evals/session.ts (2) |
| `6b11187a07` |  | 3 | PARTIAL 2, STRANDED 1 | 1/0/20/2 (92) | .changeset/repo-view-pierre-diffs-1-5-2.md (7), .smithers/flows/package.json (1), .smithers/flows/review/tests/renderWalkthroughHtml.test.ts (2), apps/mvp/docs/work/pierre-diffs-upgrades.md (16) |
| `363f83c1c0` |  | 4 | PARTIAL 4 | 3/0/15/4 (2790) | .changeset/agent-harness-cli.md (30), .changeset/cli-runner.md (28), packages/smithers/agent/README.md (1), packages/smithers/agent/docs/README.md (1) |
| `c751c7cd0a` |  | 27 | SUPERSEDED 14, ON-MAIN 12, EMPTY-ISH 1 | 0/0/0/0 (0) |  |
| `a3b4795f09` |  | 22 | PARTIAL 1, SUPERSEDED 10, ON-MAIN 10, EMPTY-ISH 1 | 214/57/2/0 (14) | .smithers/flows/release/fixtures/public-api-baseline.json (9), packages/smithers/flows/engine-store/src/PlanScheduler.ts (5) |
| `9282a98a77` |  | 43 | STRANDED 7, PARTIAL 7, SUPERSEDED 16, ON-MAIN 12, EMPTY-ISH 1 | 284/81/205/30 (3216) | .changeset/docs-home-url-string.md (2), .changeset/ui-page-pane.md (4), .changeset/views-docs.md (8), .gitignore (2) |
| `701923c931` |  | 29 | SUPERSEDED 16, ON-MAIN 12, EMPTY-ISH 1 | 0/0/0/0 (0) |  |
| `cadf086bce` |  | 2 | PARTIAL 2 | 61/6/26/12 (307) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (9), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md ( |
| `5a4cd7d7dc` |  | 6 | SUPERSEDED 5, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `318e18d004` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `df9aecf75d` |  | 1 | PARTIAL 1 | 204/145/248/5207 (65399) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11639), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `ea9f72d317` |  | 3 | PARTIAL 2, STRANDED 1 | 0/0/19/3 (96) | .changeset/repo-view-pierre-diffs-1-5-2.md (7), .smithers/flows/package.json (1), .smithers/flows/review/tests/renderWalkthroughHtml.test.ts (2), apps/mvp/docs/proposals/pierre-oss-survey.md (20) |
| `cd216513f0` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 96/45/9/6 (202) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4), apps/mvp/e2e/dogfood.spec.ts (143), apps/mvp/worker/BranchSandboxes.ts (3) |
| `04db310802` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `02eea0709d` |  | 2 | PARTIAL 2 | 66/9/24/12 (273) | .changeset/browser-runtime-authorize-recheck.md (8), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (9), apps/mvp/docs/features/flows.md (1), apps/mvp/docs/features/sign-in.md ( |
| `0b9034bb1b` |  | 1 | PARTIAL 1 | 13/3/8/0 (47) | apps/mvp/docs/work/flow-source-regressions-751129.md (28), packages/smithers/flows/flow/README.md (10), packages/smithers/flows/flow/docs/reference/flow.md (1), packages/smithers/flows/flow/src/Durabl |
| `5f627a1f24` |  | 18 | PARTIAL 1, SUPERSEDED 8, ON-MAIN 8, EMPTY-ISH 1 | 210/58/1/0 (5) | packages/smithers/flows/engine-store/src/PlanScheduler.ts (5) |
| `702ffac454` |  | 1 | PARTIAL 1 | 202/138/249/5212 (65390) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11632), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `8976dd2d49` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `93a0a2e454` |  | 4 | PARTIAL 4 | 0/1/115/17 (939) | .changeset/electric-collection-evict.md (10), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_session_role_verified.ts (7), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority. |
| `e4453b6d10` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b752bc330e` |  | 4 | STRANDED 1, ON-MAIN 1, PARTIAL 1, SUPERSEDED 1 | 124/27/23/2 (654) | apps/mvp/e2e/agent.spec.ts (2), apps/mvp/e2e/answer-ordering.spec.ts (5), apps/mvp/e2e/deployment/sign-in.setup.ts (104), apps/mvp/e2e/devices.ts (6) |
| `8aa8312ce6` |  | 36 | SUPERSEDED 11, ON-MAIN 12, STRANDED 6, PARTIAL 6, EMPTY-ISH 1 | 304/77/202/31 (3249) | .changeset/docs-home-url-string.md (2), .changeset/ui-page-pane.md (4), .changeset/views-docs.md (8), .gitignore (2) |
| `c8f906cd4a` |  | 18 | SUPERSEDED 9, ON-MAIN 8, EMPTY-ISH 1 | 0/0/0/0 (0) |  |
| `b6d3a4ffb2` |  | 2 | PARTIAL 2 | 0/0/18/3 (95) | .changeset/repo-view-pierre-diffs-1-5-2.md (7), .smithers/flows/package.json (1), apps/mvp/docs/proposals/pierre-oss-survey.md (21), packages/smithers/ui/repo-view/docs/api.md (1) |
| `a244a7225b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `bfcb08d420` |  | 1 | PARTIAL 1 | 11/3/9/1 (29) | apps/mvp/docs/work/flow-source-regressions-751129.md (7), packages/smithers/flows/flow/README.md (10), packages/smithers/flows/flow/docs/reference/flow.md (1), packages/smithers/flows/flow/src/Durable |
| `45881b7777` |  | 8 | PARTIAL 6, EMPTY-ISH 1, ON-MAIN 1 | 7/0/56/9 (2801) | .changeset/mcp-server.md (29), .smithers/flows/release/fixtures/public-api-baseline.json (7), apps/mvp/AGENTS.md (2), apps/mvp/db/Database.ts (2) |
| `28873e59cd` |  | 1 | PARTIAL 1 | 22/8/2/3 (18) | apps/mvp/docs/work/github-ordering-fixes.md (1), apps/mvp/worker/github/Api.test.ts (9), apps/mvp/worker/github/Api.ts (6), apps/mvp/worker/github/Merge.ts (1) |
| `f50eeed6be` |  | 1 | PARTIAL 1 | 202/133/249/5217 (65372) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11614), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `aaf17365b7` |  | 1 | PARTIAL 1 | 8/2/8/4 (26) | apps/mvp/docs/work/flow-source-regressions-751129.md (7), packages/smithers/flows/flow/src/DurableDeferred.ts (1), packages/smithers/flows/flow/src/DurableQueue.ts (1), packages/smithers/flows/flow/sr |
| `3b17fe4b72` |  | 1 | PARTIAL 1 | 22/8/2/3 (18) | apps/mvp/docs/work/github-ordering-fixes.md (1), apps/mvp/worker/github/Api.test.ts (9), apps/mvp/worker/github/Api.ts (6), apps/mvp/worker/github/Merge.ts (1) |
| `01dde7d4f9` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b763b2c97b` |  | 2 | PARTIAL 2 | 0/0/17/3 (94) | .changeset/repo-view-pierre-diffs-1-5-2.md (7), apps/mvp/docs/proposals/pierre-oss-survey.md (21), packages/smithers/ui/repo-view/docs/api.md (1), packages/smithers/ui/repo-view/docs/guides/use-the-re |
| `25dff651a6` |  | 4 | STRANDED 1, ON-MAIN 1, PARTIAL 1, SUPERSEDED 1 | 124/28/23/2 (660) | apps/mvp/e2e/agent.spec.ts (2), apps/mvp/e2e/answer-ordering.spec.ts (5), apps/mvp/e2e/deployment/sign-in.setup.ts (104), apps/mvp/e2e/devices.ts (6) |
| `2051795044` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b9ee2951c4` |  | 21 | SUPERSEDED 13, ON-MAIN 8 | 0/0/0/0 (0) |  |
| `c3ab4ad244` |  | 1 | PARTIAL 1 | 2/1/24/4 (163) | apps/mvp/db/Database.test.ts (19), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_flow_draft_receipts.ts (11), apps/mvp/docs/decisions/0038-draft-save-concurrency.md (6) |
| `67736f4842` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `bcc82d0297` |  | 4 | SUPERSEDED 2, ON-MAIN 1, PARTIAL 1 | 128/29/1/0 (2) | apps/mvp/worker/ChatApi.ts (2) |
| `32bf658e5f` |  | 2 | PARTIAL 2 | 0/0/92/14 (611) | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (2), apps/mvp/docs/features/issues.md (8), apps/mvp/docs/features/notifications.md (5), apps/mvp/docs/features/sign-in.md (3) |
| `6a94dc267e` |  | 6 | SUPERSEDED 4, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `7ed8110efb` |  | 16 | PARTIAL 5, SUPERSEDED 8, ON-MAIN 3 | 110/48/5/20 (100) | .changeset/github-once-merge.md (2), apps/mvp/PACKAGE.ts (4), apps/mvp/docs/features/issues.md (2), apps/mvp/docs/features/pulls.md (4) |
| `cdb1160df9` |  | 15 | STRANDED 1, PARTIAL 1, SUPERSEDED 7, ON-MAIN 6 | 97/28/7/3 (42) | apps/mvp/db/Database.ts (2), apps/mvp/docs/features/spend-alerts.md (2), apps/mvp/docs/work/prod-flows.md (9), apps/mvp/src/features/spend/actions.ts (12) |
| `7759ae184b` |  | 1 | PARTIAL 1 | 200/126/248/5221 (65199) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11452), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `c870231485` |  | 4 | PARTIAL 4 | 0/1/106/16 (762) | .changeset/electric-collection-evict.md (10), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md (2), apps/mvp/docs/features/issues.md (11), apps/mvp/docs/features/notifications.md  |
| `040001c3ef` |  | 5 | STRANDED 1, PARTIAL 4 | 0/1/116/18 (858) | .changeset/electric-collection-evict.md (10), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_session_role_verified.ts (7), apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority. |
| `464b1cb892` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `fd1e672266` |  | 7 | SUPERSEDED 5, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `a5e2df4749` |  | 1 | STRANDED 1 | 0/0/1/0 (1) | packages/smithers/ui/repo-view/package.json (1) |
| `2a8e92a560` |  | 7 | STRANDED 1, SUPERSEDED 4, ON-MAIN 2 | 91/43/10/11 (222) | .smithers/checks/check.sh (2), .smithers/checks/lint.sh (3), apps/mvp/db/Database.ts (2), apps/mvp/docs/features/todos.md (4) |
| `5adf377d7d` |  | 3 | SUPERSEDED 2, PARTIAL 1 | 68/13/4/0 (4) | apps/mvp/e2e/local-first-conflicts.spec.ts (1), apps/site/public/llms-full.txt (1), apps/site/src/content/docs/docs/reference/api/platform-browser.mdx (1), packages/smithers/flows/platform-browser/doc |
| `8f2dc27a08` |  | 1 | PARTIAL 1 | 266/120/250/5161 (65064) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11317), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `fa854a7729` |  | 8 | PARTIAL 6, EMPTY-ISH 1, ON-MAIN 1 | 7/0/56/9 (2794) | .changeset/mcp-server.md (29), .smithers/flows/release/fixtures/public-api-baseline.json (7), apps/mvp/AGENTS.md (2), apps/mvp/db/Database.ts (2) |
| `5f7174e85a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `1cadd90544` |  | 14 | SUPERSEDED 10, ON-MAIN 4 | 0/0/0/0 (0) |  |
| `9ff3087d68` |  | 1 | PARTIAL 1 | 1/1/23/4 (154) | apps/mvp/db/Database.test.ts (19), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_flow_draft_receipts.ts (11), apps/mvp/docs/decisions/0038-draft-save-concurrency.md (6) |
| `f88f24cd65` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `4513685cc2` |  | 6 | EMPTY-ISH 2, PARTIAL 3, ON-MAIN 1 | 4/0/26/2 (1277) | .changeset/mcp-server.md (29), .smithers/flows/release/fixtures/public-api-baseline.json (7), docs/libraries.md (2), packages/smithers/agent/src/AgentRunner.ts (99) |
| `e8c922fe28` |  | 1 | PARTIAL 1 | 5/1/3/3 (33) | apps/mvp/docs/features/issues.md (1), apps/mvp/docs/work/issues-credential-regressions.md (22), apps/mvp/src/features/issues/api.test.ts (9), apps/mvp/src/features/issues/api.ts (1) |
| `2cdb7811eb` |  | 5 | PARTIAL 4, STRANDED 1 | 17/3/8/3 (840) | .changeset/agent-external-agent.md (29), docs/libraries.md (1), packages/smithers/agent/docs/README.md (2), packages/smithers/agent/docs/api.md (101) |
| `197cebb305` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 86/40/2/8 (90) | apps/mvp/docs/decisions/0024-watching-a-todo-run.md (7), apps/mvp/docs/features/runs.md (3), apps/mvp/src/features/runs/remote.test.ts (36), apps/mvp/src/features/runs/store.test.ts (9) |
| `95621d0845` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `35f594e16e` |  | 5 | PARTIAL 3, EMPTY-ISH 1, ON-MAIN 1 | 4/0/26/2 (1277) | .changeset/mcp-server.md (29), .smithers/flows/release/fixtures/public-api-baseline.json (7), docs/libraries.md (2), packages/smithers/agent/src/AgentRunner.ts (99) |
| `2eebe05718` |  | 22 | PARTIAL 1, SUPERSEDED 10, ON-MAIN 10, EMPTY-ISH 1 | 274/69/1/0 (5) | packages/smithers/flows/engine-store/src/PlanScheduler.ts (5) |
| `d74d3c69ef` |  | 1 | PARTIAL 1 | 264/119/250/5157 (64990) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11251), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `58004e350b` |  | 12 | SUPERSEDED 8, ON-MAIN 4 | 0/0/0/0 (0) |  |
| `537de2daf8` |  | 1 | PARTIAL 1 | 1/1/18/4 (141) | apps/mvp/db/Database.test.ts (19), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_flow_draft_receipts.ts (11), apps/mvp/docs/decisions/0038-draft-save-concurrency.md (6) |
| `faa02d0a79` |  | 1 | PARTIAL 1 | 5/1/3/3 (23) | apps/mvp/docs/features/issues.md (1), apps/mvp/docs/work/issues-credential-regressions.md (12), apps/mvp/src/features/issues/api.test.ts (9), apps/mvp/src/features/issues/api.ts (1) |
| `9aa491a333` |  | 1 | PARTIAL 1 | 264/117/250/5159 (64929) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11190), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `6afbc5206d` |  | 1 | PARTIAL 1 | 1/1/16/4 (139) | apps/mvp/db/Database.test.ts (19), apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_flow_draft_receipts.ts (11), apps/mvp/docs/decisions/0038-draft-save-concurrency.md (6) |
| `d00a00804b` |  | 1 | PARTIAL 1 | 264/113/250/5164 (64918) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11179), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `12c1e23387` |  | 1 | PARTIAL 1 | 5/1/2/4 (15) | apps/mvp/docs/features/issues.md (1), apps/mvp/docs/work/issues-credential-regressions.md (4), apps/mvp/src/features/issues/api.test.ts (9), apps/mvp/src/features/issues/api.ts (1) |
| `b661e1b0b1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8902f02f40` |  | 1 | PARTIAL 1 | 260/113/250/5165 (64888) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (11149), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `402d0c3661` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `aa5882d7a8` |  | 1 | PARTIAL 1 | 254/103/250/5176 (64592) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (10853), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `0fd28abddc` |  | 3 | ON-MAIN 2, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c24411430b` |  | 2 | PARTIAL 2 | 5/0/25/5 (1271) | apps/mvp/db/Database.ts (2), apps/mvp/db/migrations/0038_agent_runners.ts (50), apps/mvp/src/features/agent-backends/contract.ts (25), apps/mvp/vitest.config.ts (8) |
| `3da4bd89f2` |  | 2 | PARTIAL 2 | 3/0/25/2 (1098) | .changeset/mcp-server.md (23), .smithers/flows/release/fixtures/public-api-baseline.json (7), docs/libraries.md (2), packages/smithers/agent/src/AgentRunner.ts (99) |
| `ad3afb35e8` |  | 1 | PARTIAL 1 | 2/0/1/0 (7) | apps/mvp/docs/work/worker-953411.md (7) |
| `1c3b1ed942` |  | 9 | PARTIAL 1, SUPERSEDED 6, ON-MAIN 2 | 56/18/0/3 (4) | apps/mvp/worker/flows/Todo.test.ts (2), apps/site/public/llms-full.txt (2) |
| `d7e650d344` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `467e1e0ece` |  | 2 | STRANDED 2 | 0/0/1/0 (18) | apps/mvp/docs/work/land-and-deploy-mvp.md (18) |
| `17e95ec919` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3cb9124e12` |  | 35 | SUPERSEDED 10, ON-MAIN 12, STRANDED 6, PARTIAL 6, EMPTY-ISH 1 | 288/73/204/30 (3198) | .changeset/docs-home-url-string.md (2), .changeset/ui-page-pane.md (4), .changeset/views-docs.md (8), .gitignore (2) |
| `7ff8144985` |  | 5 | PARTIAL 1, SUPERSEDED 2, ON-MAIN 2 | 56/18/0/3 (4) | apps/mvp/worker/flows/Todo.test.ts (2), apps/site/public/llms-full.txt (2) |
| `4794064626` |  | 2 | STRANDED 1, PARTIAL 1 | 2/0/2/1 (131) | apps/mvp/docs/decisions/0027-coding-agent-backends.md (18), apps/mvp/docs/work/coding-agent-backends.md (14), packages/smithers/agent/src/AgentRunner.ts (99) |
| `869eaba965` |  | 1 | PARTIAL 1 | 252/98/250/5183 (64496) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (10756), apps/maintainer-site/queue/queue.json (235), apps/mvp/db/Database.ts (2) |
| `6817e4ecbd` |  | 4 | SUPERSEDED 2, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `4d35803d1f` |  | 1 | PARTIAL 1 | 18/4/0/1 (13) | apps/mvp/e2e/sandbox-lifecycle.spec.ts (13) |
| `df5ede0070` |  | 6 | STRANDED 5, PARTIAL 1 | 0/1/27/0 (119) | .gitignore (2), .specs/product/mvp.md (1), .specs/product/overview.md (1), CONTRIBUTING.md (9) |
| `871bacc02d` |  | 1 | PARTIAL 1 | 177/266/247/5161 (58761) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (5255), apps/maintainer-site/queue/queue.json (2), apps/mvp/db/Database.ts (2) |
| `c349c7bdf4` |  | 1 | PARTIAL 1 | 177/266/247/5161 (58761) | .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/coverage.json (5255), apps/maintainer-site/queue/queue.json (2), apps/mvp/db/Database.ts (2) |
| `bfcc6c1a3d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8d07068639` |  | 3 | PARTIAL 3 | 16/2/106/25 (2871) | .changeset/docs-home-url-string.md (2), .changeset/ui-page-pane.md (4), .changeset/views-docs.md (8), apps/mvp/AGENTS.md (1) |
| `e9f6d1e89e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `512f6e1ad3` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d048301dfc` |  | 9 | PARTIAL 3, SUPERSEDED 6 | 575/125/6/2 (11) | .smithers/flows/release/fixtures/public-api-baseline.json (6), apps/site/astro.config.mjs (3), evals/docs/bunfig.toml (1), packages/smithers/flows/flow/PACKAGE.ts (1) |
| `d39f412ec2` |  | 1 | PARTIAL 1 | 0/1/72/0 (194) | apps/mvp/docs/work/ssr-temp-cache-leak.md (19), apps/mvp/evals/vitest.config.ts (2), apps/mvp/vitest.config.ts (2), packages/effect-code-storage/vitest.config.ts (2) |
| `c578bb3b75` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `86723e22ad` |  | 1 | PARTIAL 1 | 28/20/15/5 (109) | .changeset/browser-runtime-authorize.md (11), apps/mvp/docs/decisions/0021-local-first-migrations.md (6), apps/mvp/docs/features/sign-in.md (8), apps/mvp/docs/observability.md (1) |
| `b5737baf44` |  | 5 | ON-MAIN 3, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `1cb5344e2c` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `08c498f459` |  | 2 | ON-MAIN 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c3f3d6782a` |  | 1 | PARTIAL 1 | 1915/1805/3946/67 (58793) | .changeset/attached-wait-reports-outcome.md (5), .changeset/shared-sqlite-receipt-fails-closed.md (3), .smithers/flows/release/fixtures/public-api-baseline.json (54), apps/maintainer-site/queue/before |
| `60fd111680` |  | 5 | SUPERSEDED 3, ON-MAIN 2 | 0/0/0/0 (0) |  |
| `0432886e45` |  | 1 | PARTIAL 1 | 2401/704/429/44 (55120) | .changeset/attached-wait-reports-outcome.md (5), .changeset/browser-failure-recovery.md (2), .changeset/cli-run-destination.md (2), .changeset/crypto-global-source-shape.md (2) |
| `39a13b08de` |  | 1 | STRANDED 1 | 0/0/1/0 (13) | apps/mvp/docs/infrastructure.md (13) |
| `62b9ef30ca` |  | 1 | PARTIAL 1 | 1646/5217/4/3 (34) | .land4-sdk.sh (18), apps/maintainer-site/queue/queue.json (6), apps/mvp/e2e/local-first.spec.ts (5), apps/mvp/worker/flows/RepoClone.test.ts (3) |
| `24747a3bf0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `7d1f83e264` |  | 1 | SCAFFOLD 1 | 0/0/0/0 (0) |  |
| `1ef9292cf0` |  | 1 | PARTIAL 1 | 1755/638/196/26 (54915) | .changeset/attached-wait-reports-outcome.md (5), .changeset/shared-sqlite-receipt-fails-closed.md (3), apps/maintainer-site/README.md (4), apps/maintainer-site/queue/queue.json (1782) |
| `b0d1a1148f` |  | 1 | SCAFFOLD 1 | 0/0/0/0 (0) |  |
| `354d59dda5` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `9335d5fa7d` |  | 1 | PARTIAL 1 | 239/0/34/91 (6806) | .specs/design/mock/build.mjs (5), .specs/design/mock/evals/mock-fidelity/REPORT.md (18), .specs/design/mock/evals/mock-fidelity/browser.test.ts (90), .specs/design/mock/evals/mock-fidelity/browser.ts  |
| `9f22b2e653` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `f2354423ff` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d6fa75217b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e99ce3e179` |  | 1 | PARTIAL 1 | 6/48/1/0 (16) | .smithers/factory.json (16) |
| `e058383e32` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c1ec763351` |  | 1 | PARTIAL 1 | 1/0/6/4 (79) | packages/smithers/agent/registry/src/Executable.ts (11), packages/smithers/agent/registry/test/Executable.test.ts (30), packages/smithers/src/internal/NativeControl.ts (16), packages/smithers/test/Nat |
| `cf1d3c7573` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `010fbc424a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5036067ccb` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 0/122/13/0 (265) | apps/site/astro.config.mjs (1), docs/api/openapi/sites.yaml (111), packages/rpc/PACKAGE.ts (2), packages/rpc/src/AppBootstrap.ts (1) |
| `941e831d17` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `28a10398f8` |  | 3 | PARTIAL 2, SUPERSEDED 1 | 2/32/6/2 (37) | .smithers/FACTORY.ts (4), .smithers/home.json (4), apps/site/scripts/built-site.test.mjs (7), apps/site/scripts/check-built-site.mjs (6) |
| `dbbd5a50bf` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `62148f367d` |  | 1 | PARTIAL 1 | 3/0/5/2 (61) | packages/smithers/agent/registry/src/Executable.ts (6), packages/smithers/src/internal/NativeControl.ts (21), packages/smithers/test/NativeControlPlan.test.ts (34) |
| `f38cf93a2a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ea32db90a5` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3836ba6a2e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2a944afbf3` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `e22fc1de59` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ea78e3e313` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `147ca67f07` |  | 2 | PARTIAL 1, ON-MAIN 1 | 9/14/179/4 (51814) | evals/swebench/fixtures/flows-cell-harness.mirror.json (7), evals/swebench/fixtures/patches/django__django-16612.patch (1), evals/swebench/fixtures/patches/pytest-dev__pytest-6197.patch (1), evals/swe |
| `1af7df96d6` |  | 2 | PARTIAL 1, ON-MAIN 1 | 9/13/179/4 (51814) | evals/swebench/fixtures/flows-cell-harness.mirror.json (7), evals/swebench/fixtures/patches/django__django-16612.patch (1), evals/swebench/fixtures/patches/pytest-dev__pytest-6197.patch (1), evals/swe |
| `ce197f0c02` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `257ede9a75` |  | 2 | PARTIAL 2 | 45/23/182/6 (51879) | evals/swebench/fixtures/flows-cell-harness.mirror.json (7), evals/swebench/fixtures/patches/django__django-16612.patch (1), evals/swebench/fixtures/patches/pytest-dev__pytest-6197.patch (1), evals/swe |
| `fa063ac1a5` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d3decdc90b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `92f53aa488` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `fcc907a9ef` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d491da2c37` | codex/root-notification-policy-source-86-20261016 | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `8f41a36ff3` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `3ce8d611be` | codex/root-issue-policy-source-73-20261016 | 4 | SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `a10b77a203` | codex/root-pr-review-source-77-20261016 | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `943bb4002e` | codex/root-notification-receipts-78-20261016 | 3 | PARTIAL 1, SUPERSEDED 2 | 3/40/1/0 (132) | ROOT-NOTE-notification-policy-review-78.md (132) |
| `11c9b6df10` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `f338fef026` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `1b32e9de14` | codex/root-integration-source-68-20261016 | 4 | SUPERSEDED 4 | 0/0/0/0 (0) |  |
| `84f6cc7a5e` | codex/root-integration-source-71-20261016 | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `ebb9dae648` | codex/root-integration-source-69-20261016 | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `21d0afd93a` |  | 1 | PARTIAL 1 | 0/0/162/115 (5540) | packages/smithers/flows/flow/dist/esm/Action/Action.d.ts (70), packages/smithers/flows/flow/dist/esm/Action/Action.d.ts.map (1), packages/smithers/flows/flow/dist/esm/Action/Action.js (6), packages/sm |
| `b4cfb09078` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `976869dc1d` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `a6b4ab51fb` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e3578de251` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `acde6366ab` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `46cb495b2d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `1e9ae7ea44` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `b12c788e1f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `501e378253` |  | 1 | PARTIAL 1 | 455/65/18/14 (96) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `a3d8c239a9` |  | 1 | PARTIAL 1 | 455/58/18/14 (96) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `bfd95be29f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ca705c5458` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ff428962db` |  | 1 | PARTIAL 1 | 528/68/18/14 (96) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `a6457278fb` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5f94accee7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `01ef4969e6` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5acaa6bede` |  | 2 | SUPERSEDED 1, ON-MAIN 1 | 0/0/0/0 (0) |  |
| `719985caf8` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `9b91c77ae4` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a36ebbf27f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2255b9c7dc` |  | 1 | PARTIAL 1 | 92/0/0/2 (2) | packages/smithers/agent/integrations/docs/quickstart.md (1), packages/smithers/migrate/docs/guides/embed-the-scanners.md (1) |
| `d31753ff73` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `80b70cc65b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `4ab28d362f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3e1317393d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `cb24c3c390` |  | 1 | PARTIAL 1 | 526/58/18/14 (96) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `8c6d53f2b8` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `db8f1ddd76` |  | 3 | ON-MAIN 1, SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `259eda1f88` |  | 1 | PARTIAL 1 | 543/58/18/14 (96) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `0f7df592ed` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `cef5d69b56` |  | 2 | PARTIAL 1, ON-MAIN 1 | 580/59/18/14 (96) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `4f0aed1fb7` |  | 2 | PARTIAL 1, ON-MAIN 1 | 580/59/18/14 (96) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `3bc718311f` |  | 2 | PARTIAL 1, ON-MAIN 1 | 586/64/18/15 (100) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `68ef8c428b` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `106e324965` |  | 2 | PARTIAL 1, ON-MAIN 1 | 595/64/18/15 (100) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `be0eae202f` |  | 2 | PARTIAL 1, ON-MAIN 1 | 598/67/19/15 (103) | apps/site/public/llms-full.txt (2), apps/site/src/content/docs/docs/reference/api/platform-bun.mdx (2), packages/repo-targets/scripts/build-library.mjs (5), packages/smithers/agent/memory/README.md (4 |
| `a63baaad78` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `fd1125dda7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2d6d27b8c8` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `edcd2f4cb5` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 573/57/15/34 (228) | apps/site/public/llms-full.txt (1), apps/site/src/content/docs/docs/reference/api/plugin.mdx (1), packages/smithers/agent/evals/test/Runner.test.ts (3), packages/smithers/agent/evals/test/Trials.test. |
| `45b7874a46` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 566/57/15/31 (245) | apps/site/public/llms-full.txt (1), apps/site/src/content/docs/docs/reference/api/plugin.mdx (1), packages/smithers/agent/evals/test/Runner.test.ts (3), packages/smithers/agent/evals/test/Trials.test. |
| `1ee38f3447` |  | 2 | PARTIAL 1, ON-MAIN 1 | 501/55/15/30 (167) | apps/site/public/llms-full.txt (1), apps/site/src/content/docs/docs/reference/api/plugin.mdx (1), packages/smithers/agent/memory/README.md (4), packages/smithers/agent/memory/docs/README.md (1) |
| `865abb05d4` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 351/43/16/23 (167) | packages/smithers/agent/harness/test/zz-probe-tmp.test.ts (23), packages/smithers/agent/harness/zz-probe.config.ts (1), packages/smithers/agent/memory/README.md (4), packages/smithers/agent/memory/doc |
| `1a00aac5c5` |  | 2 | PARTIAL 1, ON-MAIN 1 | 350/43/16/24 (174) | packages/repo-targets/rt-probe.tmp.ts (5), packages/smithers/agent/harness/test/zz-probe-tmp.test.ts (23), packages/smithers/agent/harness/zz-probe.config.ts (1), packages/smithers/agent/memory/README |
| `a16459a919` |  | 2 | PARTIAL 1, ON-MAIN 1 | 296/43/16/17 (156) | packages/repo-targets/vitest.tmp-effect404.config.ts (11), packages/smithers/agent/harness/test/zz-probe-tmp.test.ts (23), packages/smithers/agent/harness/zz-probe.config.ts (1), packages/smithers/age |
| `6a3210d440` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `2b48e94c16` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `8a8729e277` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `801f514d36` |  | 1 | PARTIAL 1 | 2/0/3/4 (32) | packages/testing/docs/api.md (4), packages/testing/src/Faults.ts (13), packages/testing/test/Faults.test.ts (15) |
| `c021bbbd49` |  | 2 | ON-MAIN 2 | 0/0/0/0 (0) |  |
| `6e7e29a2aa` |  | 2 | PARTIAL 1, ON-MAIN 1 | 57/19/1/2 (17) | packages/repo-targets/vitest.tmp-effect404.config.ts (11), packages/smithers/agent/fs/test/fixtures/hidden-runtime/flows/hidden/flow.ts (4), packages/smithers/agent/harness/.api-example-PbngiI/example |
| `e622e8856e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `06d4d315cc` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b3236fcb79` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e9e0a419ca` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `61e65dbee5` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `08c0b7944c` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `798e31e447` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `cc7646203d` |  | 1 | PARTIAL 1 | 5/0/33/0 (287) | apps/tui/README.md (6), apps/tui/src/app-view.tsx (14), apps/tui/src/inbox.ts (3), apps/tui/src/run-card-view.tsx (6) |
| `417e34ccc1` |  | 1 | STRANDED 1 | 0/0/6/0 (327) | apps/tui/docs/testing.md (45), apps/tui/e2e/denied-edit-fixture.tsx (54), apps/tui/e2e/denied-edit-judge.ts (41), apps/tui/e2e/denied-edit.test.ts (120) |
| `1b0c595a39` |  | 1 | PARTIAL 1 | 0/0/1/2 (161) | apps/tui/e2e/workspace-fixture.tsx (28), apps/tui/e2e/workspace-outcome.test.ts (133) |
| `a8a2e05e6d` |  | 1 | PARTIAL 1 | 9/0/1/0 (5) | apps/tui/src/app.tsx (5) |
| `b39ca4665b` |  | 1 | STRANDED 1 | 0/0/8/0 (184) | apps/tui/README.md (5), apps/tui/src/subagents.ts (14), apps/tui/test/command-receipts.test.tsx (156), apps/tui/test/run-card.test.ts (2) |
| `62f5ff7635` |  | 1 | PARTIAL 1 | 1/0/19/5 (426) | apps/tui/README.md (9), apps/tui/src/run-card-view.tsx (3), apps/tui/src/run-card.ts (2), apps/tui/src/session.ts (7) |
| `0429a5434c` |  | 1 | PARTIAL 1 | 2/0/2/1 (101) | apps/tui/e2e/steering-delivery.test.ts (61), apps/tui/e2e/tabs-fixture.tsx (1), apps/tui/test/worker-steer.test.ts (39) |
| `b1266b07a7` |  | 1 | PARTIAL 1 | 0/0/9/2 (162) | apps/tui/README.md (6), apps/tui/src/app.tsx (20), apps/tui/src/surfaces.ts (2), apps/tui/test/app-summary-focus.test.tsx (132) |
| `d9eacae175` |  | 1 | PARTIAL 1 | 1/0/1/0 (94) | packages/smithers/agent/model/test/FailureCopyBudget.test.ts (94) |
| `617ca48896` |  | 1 | PARTIAL 1 | 12/0/1/2 (25) | apps/tui/src/timeline.ts (5), apps/tui/src/transcript-view.ts (20) |
| `7c360bd2cd` |  | 1 | PARTIAL 1 | 0/0/2/2 (158) | packages/smithers/agent/model/src/FailureCopy.ts (24), packages/smithers/agent/model/test/FailureCopyInspection.test.ts (134) |
| `3c156cc6f0` |  | 1 | PARTIAL 1 | 1/0/3/1 (97) | apps/tui/src/transcript-view.ts (2), apps/tui/test/transcript-view.test.tsx (95) |
| `d3b36ac7a7` |  | 1 | STRANDED 1 | 0/0/3/0 (68) | packages/smithers/agent/model/src/FailureCopy.ts (6), packages/smithers/agent/model/test/FailureCopyLookup.test.ts (62) |
| `11929e3109` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `73a7a8697e` |  | 1 | PARTIAL 1 | 0/1/8/3 (209) | apps/tui/README.md (5), apps/tui/e2e/grep.test.ts (70), apps/tui/src/timeline.ts (9), apps/tui/src/transcript-view.ts (3) |
| `7bcf9a2535` |  | 1 | PARTIAL 1 | 0/0/8/3 (185) | apps/tui/README.md (3), apps/tui/e2e/asks-fixture.tsx (45), apps/tui/e2e/asks.test.ts (94), apps/tui/src/app.tsx (1) |
| `d81ce9b981` |  | 1 | STRANDED 1 | 0/0/6/0 (284) | apps/tui/e2e/answer-frames-fixture.tsx (44), apps/tui/e2e/answer-frames.test.ts (54), apps/tui/src/view.tsx (12), apps/tui/test/answer-frames.test.tsx (174) |
| `526ea677dd` |  | 1 | PARTIAL 1 | 0/0/14/1 (355) | apps/tui/README.md (4), apps/tui/e2e/cells-scroll-fixture.tsx (16), apps/tui/e2e/cells-scroll.test.ts (72), apps/tui/src/app.tsx (2) |
| `dd80756e3f` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `9a68f68b26` |  | 1 | SCAFFOLD 1 | 0/0/0/0 (0) |  |
| `31cf4a863a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `28c5a59925` |  | 1 | PARTIAL 1 | 0/0/10/3 (173) | apps/tui/e2e/input-ownership-preload.mjs (20), apps/tui/e2e/input-ownership.test.ts (46), apps/tui/src/host.ts (6), apps/tui/test/input-ownership.test.ts (51) |
| `4c6ec2c6d8` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `67ee1cb998` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `4db8ccba03` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `344a9adabd` |  | 1 | PARTIAL 1 | 1/22/1/0 (3) | .smithers/coding-project.json (3) |
| `7a0ddff884` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b10b061de9` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 20/318/3/3 (32) | apps/site/src/data/cli-commands.json (23), apps/site/src/data/help/diff.txt (7), apps/site/src/data/help/wiki/show.txt (2) |
| `d3747ac23f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `855eddfa2c` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 22/343/3/3 (32) | apps/site/src/data/cli-commands.json (23), apps/site/src/data/help/diff.txt (7), apps/site/src/data/help/wiki/show.txt (2) |
| `ac47472556` |  | 1 | PARTIAL 1 | 21/372/3/3 (32) | apps/site/src/data/cli-commands.json (23), apps/site/src/data/help/diff.txt (7), apps/site/src/data/help/wiki/show.txt (2) |
| `2180af77ce` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `96e251acbb` |  | 1 | ON-MAIN 1 | 0/0/0/0 (0) |  |
| `3db7927ac4` | col03r-close-3626 | 1 | PARTIAL 1 | 3/4/1/2 (26) | .github/workflows/ci.yml (2), PACKAGE.ts (24) |
| `4847fe3e63` |  | 1 | PARTIAL 1 | 2/3/1/2 (26) | .github/workflows/ci.yml (2), PACKAGE.ts (24) |
| `5015cf2b98` |  | 2 | PARTIAL 1, SUPERSEDED 1 | 3/11/1/2 (26) | .github/workflows/ci.yml (2), PACKAGE.ts (24) |
| `e83ac05054` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `2bddcd2e0d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c6c8853153` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `3728ae1387` |  | 2 | SCAFFOLD 1, SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `9710d8dc86` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8109a24833` |  | 1 | SCAFFOLD 1 | 0/0/0/0 (0) |  |
| `3e095a4944` |  | 1 | SCAFFOLD 1 | 0/0/0/0 (0) |  |
| `b977ba6c07` |  | 1 | SCAFFOLD 1 | 0/0/0/0 (0) |  |
| `c2e5bfcb65` |  | 1 | SCAFFOLD 1 | 0/0/0/0 (0) |  |
| `f44567f2d0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `88913494dd` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3d3d986a4c` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `65a09c20c7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `200019ef61` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ab24da5b23` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `d4574ed66d` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `57697dc67d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b940a307f9` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8d5d2d79ac` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ddee7aedb3` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `bf532ae920` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `801374522b` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e0ed222841` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e0e62db618` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6a5e9f04a4` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6316677a7d` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `9966915e90` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `6a48e8ecda` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `07540f910c` |  | 7 | SUPERSEDED 7 | 0/0/0/0 (0) |  |
| `e6e81fe1e8` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `952d9e6b27` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8060951735` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6b45b4a7e0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ccbecb9f36` |  | 6 | SUPERSEDED 6 | 0/0/0/0 (0) |  |
| `6db0626eb6` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `e516b02d76` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `56831d2983` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `8e21eba268` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `f753b6f481` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `68a7c09e8d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a951b1328b` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `b20afef2e9` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6486367560` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `3fde21bf65` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `53f2b1b1cb` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `283cdfc6de` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `8b2777edad` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c0ff4492df` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `a57a81137c` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `57232b061b` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `d2508e0a11` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `9c87e93866` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `fa5ac3fa7e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a11f3a28b1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6bcc9e2fba` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `24624cb600` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `0c6b3cc625` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `efdd883e00` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `efc38da898` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d0f61aeb99` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a0b8d752f5` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `47e2f4aaab` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a53c9d02fc` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `dcbf160de9` |  | 2 | PARTIAL 2 | 119/277/18/21 (116) | apps/site/public/llms-full.txt (19), apps/site/src/data/cli-commands.json (16), packages/rpc/README.md (1), packages/rpc/src/ApplicationAuth.ts (10) |
| `924ebf2104` |  | 1 | PARTIAL 1 | 18/211/66/12 (621) | .specs/product/actions.md (3), apps/tui/README.md (4), apps/tui/src/app.tsx (3), apps/tui/src/factory.ts (34) |
| `6abe4af91b` |  | 2 | SUPERSEDED 1, PARTIAL 1 | 12/26/11/5 (96) | .github/workflows/release.yml (2), .gitignore (3), packages/smithers/build/docs/reference/targets/tool-build.md (1), packages/smithers/build/targets/src/ToolBuild.ts (1) |
| `03a3694b3b` |  | 2 | SUPERSEDED 1, PARTIAL 1 | 499/435/2/4 (39) | packages/rpc/src/Cards.ts (39) |
| `a08cd8b05f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `fb80484220` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `7e2b7bd3df` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `23e1d4a846` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `0b9a072ac7` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `9af5010598` |  | 2 | PARTIAL 2 | 94/104/186/13 (500) | README.md (14), apps/site/PACKAGE.ts (1), apps/site/docs/UI-DOCS.md (1), apps/site/docs/installation.mdx (18) |
| `e7b3051550` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `cbf0d3930d` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `5e15e84174` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c185ee200a` |  | 1 | PARTIAL 1 | 68/41/35/1 (73) | README.md (2), apps/site/PACKAGE.ts (3), apps/site/docs/UI-DOCS.md (1), apps/site/prompts/DOCS-QUALITY-REVIEW.md (1) |
| `2a97a69e93` |  | 1 | PARTIAL 1 | 7/39/17/1 (286) | packages/smithers/flows/patterns/docs/burndown.md (34), packages/smithers/flows/patterns/src/Burndown.ts (107), packages/smithers/flows/patterns/test/BurndownRepeatSafety.test.ts (145) |
| `1a8b8222f1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `1f20522feb` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `1662612525` |  | 1 | PARTIAL 1 | 1/43/21/29 (936) | packages/rpc/PACKAGE.ts (6), packages/rpc/docs/card-view-models.md (52), packages/rpc/src/ActorChipCard.test.ts (5), packages/rpc/src/AgentCard.test.ts (4) |
| `da8a206db6` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `4e8593869f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `b5d487148e` |  | 1 | PARTIAL 1 | 1/43/21/29 (936) | packages/rpc/PACKAGE.ts (6), packages/rpc/docs/card-view-models.md (52), packages/rpc/src/ActorChipCard.test.ts (5), packages/rpc/src/AgentCard.test.ts (4) |
| `408fb26b52` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `4861667052` |  | 3 | SUPERSEDED 3 | 0/0/0/0 (0) |  |
| `80438d385b` |  | 2 | PARTIAL 2 | 5/81/17/2 (179) | apps/site/src/data/help/host.txt (2), apps/site/src/data/help/smthrs.txt (1), docs/api/openapi/host.yaml (65), packages/rpc/scripts/refresh-failure-codes.mjs (1) |
| `9d34c2542b` |  | 1 | PARTIAL 1 | 12/3/42/6 (270) | packages/smithers/build/build-cli/src/engine.ts (2), packages/smithers/src/Cli.ts (7), packages/smithers/src/NodeControl.ts (61), packages/smithers/src/cli/ControlBridge.ts (20) |
| `9e8d01e519` |  | 1 | PARTIAL 1 | 1/43/21/29 (936) | packages/rpc/PACKAGE.ts (6), packages/rpc/docs/card-view-models.md (52), packages/rpc/src/ActorChipCard.test.ts (5), packages/rpc/src/AgentCard.test.ts (4) |
| `8ed50795a0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6ef8a02b74` |  | 1 | PARTIAL 1 | 41/215/0/1 (55) | .specs/engineering/overview.md (55) |
| `8ff6743c2e` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ec4fb28baa` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `23830b2acb` |  | 1 | PARTIAL 1 | 39/283/1/0 (9) | packages/smithers/src/internal/backend/ProductApi.ts (9) |
| `3ba6237ede` |  | 1 | PARTIAL 1 | 4/70/13/2 (85) | apps/site/src/data/help/host.txt (2), apps/site/src/data/help/smthrs.txt (1), packages/rpc/scripts/refresh-failure-codes.mjs (1), packages/rpc/src/PlueFailureCodes.ts (6) |
| `6a3cd7ac07` |  | 1 | PARTIAL 1 | 39/283/1/0 (9) | packages/smithers/src/internal/backend/ProductApi.ts (9) |
| `9ad4699473` |  | 1 | PARTIAL 1 | 13/161/31/6 (394) | packages/rpc/src/Mythical.ts (4), packages/rpc/src/PlueFailureCodes.ts (4), packages/rpc/src/StackIssues.ts (7), packages/rpc/src/Todo.ts (108) |
| `ddf8ab9ba9` |  | 1 | PARTIAL 1 | 7/39/17/1 (191) | packages/smithers/flows/patterns/docs/burndown.md (22), packages/smithers/flows/patterns/src/Burndown.ts (100), packages/smithers/flows/patterns/test/BurndownRepeatSafety.test.ts (69) |
| `c279d1deb0` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `6851f25350` |  | 1 | PARTIAL 1 | 0/43/19/31 (845) | packages/rpc/PACKAGE.ts (7), packages/rpc/docs/card-view-models.md (52), packages/rpc/src/ActorChipCard.test.ts (5), packages/rpc/src/AgentCard.test.ts (4) |
| `f2231907b8` |  | 1 | PARTIAL 1 | 13/161/22/3 (315) | packages/rpc/src/Mythical.ts (4), packages/rpc/src/PlueFailureCodes.ts (4), packages/rpc/src/StackIssues.ts (7), packages/rpc/src/Todo.ts (108) |
| `8e2d288e32` |  | 1 | PARTIAL 1 | 11/3/37/5 (134) | packages/smithers/build/build-cli/src/engine.ts (2), packages/smithers/src/Cli.ts (7), packages/smithers/src/NodeControl.ts (61), packages/smithers/src/cli/ControlBridge.ts (20) |
| `6e3cbc98d2` |  | 1 | PARTIAL 1 | 13/161/22/3 (315) | packages/rpc/src/Mythical.ts (4), packages/rpc/src/PlueFailureCodes.ts (4), packages/rpc/src/StackIssues.ts (7), packages/rpc/src/Todo.ts (108) |
| `879b69e3c3` |  | 1 | PARTIAL 1 | 2/67/2/1 (48) | packages/smithers/src/internal/backend/Commands.ts (1), packages/smithers/src/internal/backend/Definitions.ts (1), packages/smithers/test/BackendHostStatus.test.ts (46) |
| `d69f001440` |  | 1 | PARTIAL 1 | 45/1552/31/0 (2350) | packages/rpc/PACKAGE.ts (8), packages/rpc/src/Cards.ts (5), packages/rpc/src/catalog/AppendixA.test.ts (137), packages/rpc/src/catalog/AppendixB.test.ts (116) |
| `9ae63fbdb1` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `9c5e89b94c` |  | 2 | PARTIAL 2 | 0/1/34/5 (744) | .agents/skills/smithers-agent-runtime/SKILL.md (1), packages/smithers/agent/std/README.md (34), packages/smithers/agent/std/docs/guides/pin-a-checkpoint.md (13), packages/smithers/agent/std/src/Checkp |
| `5a39eeb80a` |  | 1 | PARTIAL 1 | 24/220/1/0 (9) | packages/smithers/src/internal/backend/ProductApi.ts (9) |
| `4c1418c1dc` |  | 1 | PARTIAL 1 | 9/21/3/2 (25) | .github/workflows/release.yml (2), .gitignore (4), packages/smithers/build/docs/reference/targets/tool-build.md (1), packages/smithers/build/targets/src/ToolBuild.ts (1) |
| `e648b58958` |  | 1 | PARTIAL 1 | 24/220/1/0 (9) | packages/smithers/src/internal/backend/ProductApi.ts (9) |
| `254db52da3` |  | 1 | PARTIAL 1 | 9/21/3/2 (25) | .github/workflows/release.yml (2), .gitignore (4), packages/smithers/build/docs/reference/targets/tool-build.md (1), packages/smithers/build/targets/src/ToolBuild.ts (1) |
| `ea329ccaed` |  | 1 | PARTIAL 1 | 40/1534/31/0 (2319) | packages/rpc/PACKAGE.ts (8), packages/rpc/src/Cards.ts (5), packages/rpc/src/catalog/AppendixA.test.ts (109), packages/rpc/src/catalog/AppendixB.test.ts (116) |
| `1317075d06` |  | 2 | SUPERSEDED 1, PARTIAL 1 | 9/21/3/2 (25) | .github/workflows/release.yml (2), .gitignore (4), packages/smithers/build/docs/reference/targets/tool-build.md (1), packages/smithers/build/targets/src/ToolBuild.ts (1) |
| `665a7bba77` |  | 1 | PARTIAL 1 | 40/1534/31/0 (2319) | packages/rpc/PACKAGE.ts (8), packages/rpc/src/Cards.ts (5), packages/rpc/src/catalog/AppendixA.test.ts (109), packages/rpc/src/catalog/AppendixB.test.ts (116) |
| `4b3b64ca93` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `20783b49b9` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `a270a1098f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `9032b494a6` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `3999c4c0ea` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `ff0f4bb5e9` | smithers-sandbox/wtztlumutlntonkqposkvstplomzuypz | 1 | PARTIAL 1 | 25/0/2/1 (6) | packages/smithers/agent/registry/src/ExecutionSnapshot.ts (5), packages/smithers/agent/registry/test/ExecutionSnapshot.test.ts (1) |
| `5c99f2ce4f` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c71ff4ff02` |  | 1 | PARTIAL 1 | 39/1521/32/0 (2055) | packages/rpc/PACKAGE.ts (3), packages/rpc/src/Cards.ts (5), packages/rpc/src/catalog/AppendixA.test.ts (109), packages/rpc/src/catalog/AppendixB.test.ts (100) |
| `c7250d32c4` |  | 2 | SUPERSEDED 2 | 0/0/0/0 (0) |  |
| `2b466b2b6a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `f1facb2e9a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `c8e5326089` |  | 2 | PARTIAL 2 | 9/21/3/2 (25) | .github/workflows/release.yml (2), .gitignore (4), packages/smithers/build/docs/reference/targets/tool-build.md (1), packages/smithers/build/targets/src/ToolBuild.ts (1) |
| `230b43a5cc` |  | 1 | PARTIAL 1 | 6/1519/28/0 (1893) | packages/rpc/PACKAGE.ts (3), packages/rpc/src/Cards.ts (5), packages/rpc/src/catalog/AppendixA.test.ts (100), packages/rpc/src/catalog/AppendixB.test.ts (100) |
| `95b21f37c9` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `dafab3926a` |  | 1 | SUPERSEDED 1 | 0/0/0/0 (0) |  |
| `d09a8e1dcb` |  | 1 | PARTIAL 1 | 6/1509/28/0 (1861) | packages/rpc/PACKAGE.ts (3), packages/rpc/src/Cards.ts (5), packages/rpc/src/catalog/AppendixA.test.ts (100), packages/rpc/src/catalog/AppendixB.test.ts (78) |
| `3d82b68e64` |  | 1 | PARTIAL 1 | 446/300/4/5 (348) | packages/rpc/src/Cards.ts (40), packages/rpc/src/catalog/Cuts.test.ts (88), packages/rpc/src/catalog/cuts.json (220) |
| `cd09439a2c` |  | 1 | PARTIAL 1 | 3/7/23/2 (399) | packages/smithers/flows/patterns/src/Burndown.ts (100), packages/smithers/flows/patterns/test/BurndownRepeatSafety.test.ts (69), packages/smithers/test/BurndownReleasedRecovery.test.ts (173), packages |

### Live workspaces skipped

| Workspace | Directory | Why |
|---|---|---|
| default | `/Users/williamcory/smithers` | process cwd |
| deploy-mvp-1031b | `/Users/williamcory/smithers-deploy-mvp-1031b` | edited .smithers/flows/land/farm/mini-remote.sh |
| e2escratch | `/Users/williamcory/smithers-ws-e2escratch` | process cwd, edited .smithers/flows/land/farm/mini-remote.sh |
| latency | `/Users/williamcory/smithers-ws-latency` | edited .git-blame-ignore-revs |
| overflow3 | `/Users/williamcory/smithers-ws-overflow3` | edited .git-blame-ignore-revs |
| packcli | `/Users/williamcory/smithers-ws-packcli` | edited .git-blame-ignore-revs |
| realtodo | `/Users/williamcory/smithers-ws-realtodo` | edited .smithers/target-index.json |
| 2 commits | `` | committed in the last 6 hours |

### Commits

| Authored | Commit | Class | Hunks on/superseded/missing/partial | Stack | Subject | Evidence or gap |
|---|---|---|---|---|---|---|
| 2026-10-02 09:44 | `2016162c38` | PARTIAL | 0/1/4/1 | 9c5e89b94c | 🐛 fix(agent): bind intrinsic read-only checkpoints to contained host o | packages/smithers/src/internal/NativeCheckpoints.ts: /** The caller grants repository read |
| 2026-10-02 11:57 | `9c5e89b94c` | PARTIAL | 0/1/34/5 | 9c5e89b94c |  | .agents/skills/smithers-agent-runtime/SKILL.md: Native `ctx.checkpoint()` is intrinsic rea |
| 2026-10-02 13:32 | `d69f001440` | PARTIAL | 45/1552/31/0 | d69f001440 |  | packages/rpc/PACKAGE.ts: Smithers.file("//packages/rpc/src/catalog/catalog.mvp.json"),; pa |
| 2026-10-02 13:32 | `ea329ccaed` | PARTIAL | 40/1534/31/0 | ea329ccaed |  | packages/rpc/PACKAGE.ts: Smithers.file("//packages/rpc/src/catalog/catalog.mvp.json"),; pa |
| 2026-10-02 13:32 | `665a7bba77` | PARTIAL | 40/1534/31/0 | 665a7bba77 |  | packages/rpc/PACKAGE.ts: Smithers.file("//packages/rpc/src/catalog/catalog.mvp.json"),; pa |
| 2026-10-02 13:32 | `c71ff4ff02` | PARTIAL | 39/1521/32/0 | c71ff4ff02 |  | packages/rpc/PACKAGE.ts: const catalogInputs = [Smithers.file("//.specs/product/mvp.md"), |
| 2026-10-02 13:32 | `230b43a5cc` | PARTIAL | 6/1519/28/0 | 230b43a5cc |  | packages/rpc/PACKAGE.ts: const catalogInputs = [Smithers.file("//.specs/product/mvp.md"), |
| 2026-10-02 13:32 | `d09a8e1dcb` | PARTIAL | 6/1509/28/0 | d09a8e1dcb |  | packages/rpc/PACKAGE.ts: const catalogInputs = [Smithers.file("//.specs/product/mvp.md"), |
| 2026-10-02 13:36 | `3d82b68e64` | PARTIAL | 446/300/4/5 | 3d82b68e64 |  | packages/rpc/src/Cards.ts: /* The admin plugin's cards (Launch Checklist §E — registered o |
| 2026-10-02 13:42 | `95b21f37c9` | SUPERSEDED | 30/104/0/0 | 95b21f37c9 |  | apps/app/src/bun/NativeBackendProcess.test.ts: main deleted it in 82b5490dbe (🔥 chore(repo |
| 2026-10-02 13:44 | `59eb10efd4` | PARTIAL | 12/26/11/5 | 6abe4af91b | ✨ feat(app): assemble the relocatable Apple Silicon server bundle (#34 | .github/workflows/release.yml: # This job gates the web and local pairs with fresh Postgre |
| 2026-10-02 13:44 | `15237b9840` | SUPERSEDED | 0/3/0/0 | 1f20522feb | 🧪 test(spike): measure virtiofs member-home isolation (#3437) | scripts/spikes/mch-02-virtiofs-homes/run.sh: main deleted it in c0d449997b (🔬 feat(spike): |
| 2026-10-02 13:44 | `4c1418c1dc` | PARTIAL | 9/21/3/2 | 4c1418c1dc | ✨ feat(app): assemble the relocatable Apple Silicon server bundle (#34 | .github/workflows/release.yml: # This job gates the web and local pairs with fresh Postgre |
| 2026-10-02 13:44 | `254db52da3` | PARTIAL | 9/21/3/2 | 254db52da3 | ✨ feat(app): assemble the relocatable Apple Silicon server bundle (#34 | .github/workflows/release.yml: # This job gates the web and local pairs with fresh Postgre |
| 2026-10-02 13:44 | `98aa332efc` | PARTIAL | 9/21/3/2 | 1317075d06 | ✨ feat(app): assemble the relocatable Apple Silicon server bundle (#34 | .github/workflows/release.yml: # This job gates the web and local pairs with fresh Postgre |
| 2026-10-02 13:44 | `59e902456b` | SUPERSEDED | 0/3/0/0 | 9032b494a6 | 🧪 test(spike): measure virtiofs member-home isolation (#3437) | scripts/spikes/mch-02-virtiofs-homes/run.sh: main deleted it in c0d449997b (🔬 feat(spike): |
| 2026-10-02 13:44 | `676d7cb208` | SUPERSEDED | 0/3/0/0 | c7250d32c4 | 🧪 test(spike): measure virtiofs member-home isolation (#3437) | scripts/spikes/mch-02-virtiofs-homes/run.sh: main deleted it in c0d449997b (🔬 feat(spike): |
| 2026-10-02 13:44 | `4527355b48` | PARTIAL | 9/22/2/2 | c8e5326089 | ✨ feat(app): assemble the relocatable Apple Silicon server bundle (#34 | .github/workflows/release.yml: # This job gates the web and local pairs with fresh Postgre |
| 2026-10-02 13:45 | `408fb26b52` | SUPERSEDED | 0/67/0/0 | 408fb26b52 | ✨ feat(backend): detect repository machine recipes (#3439) | go.mod: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app, its Worker an |
| 2026-10-02 13:45 | `8ff6743c2e` | SUPERSEDED | 0/67/0/0 | 8ff6743c2e | ✨ feat(backend): detect repository machine recipes (#3439) | go.mod: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app, its Worker an |
| 2026-10-02 13:45 | `23830b2acb` | PARTIAL | 39/283/1/0 | 23830b2acb |  | packages/smithers/src/internal/backend/ProductApi.ts: export const postApiInstallSetupGith |
| 2026-10-02 13:45 | `6a3cd7ac07` | PARTIAL | 39/283/1/0 | 6a3cd7ac07 |  | packages/smithers/src/internal/backend/ProductApi.ts: export const postApiInstallSetupGith |
| 2026-10-02 13:45 | `5a39eeb80a` | PARTIAL | 24/220/1/0 | 5a39eeb80a |  | packages/smithers/src/internal/backend/ProductApi.ts: export const postApiInstallSetupGith |
| 2026-10-02 13:45 | `e648b58958` | PARTIAL | 24/220/1/0 | e648b58958 |  | packages/smithers/src/internal/backend/ProductApi.ts: export const postApiInstallSetupGith |
| 2026-10-02 13:45 | `f1facb2e9a` | SUPERSEDED | 0/52/0/0 | f1facb2e9a | ✨ feat(backend): detect repository machine recipes (#3439) | packages/backend/docs/machine-images.md: main deleted it in 82b5490dbe (🔥 chore(repo): rem |
| 2026-10-02 13:54 | `193f49212d` | PARTIAL | 126/208/11/7 | dcbf160de9 | ✨ feat(backend): claim the install with GitHub and delete password aut | apps/site/public/llms-full.txt: Read it with `docker logs smithers`. Open that URL and sig |
| 2026-10-02 13:54 | `c8e5326089` | PARTIAL | 0/2/1/0 | c8e5326089 |  | packages/smithers/build/docs/reference/targets/tool-build.md: \| `timeout` \| `Shell.Durat |
| 2026-10-02 13:57 | `8ed50795a0` | SUPERSEDED | 0/37/0/0 | 8ed50795a0 | 🧪 test(spike): measure relay and Yjs latency in microVMs (#3441) | scripts/spikes/col-01/.gitignore: main deleted it in 6a294a96e7 (🧪 test(spike): recover VM |
| 2026-10-02 13:57 | `ec4fb28baa` | SUPERSEDED | 0/37/0/0 | ec4fb28baa | 🧪 test(spike): measure relay and Yjs latency in microVMs (#3441) | scripts/spikes/col-01/.gitignore: main deleted it in 6a294a96e7 (🧪 test(spike): recover VM |
| 2026-10-02 13:57 | `9ae63fbdb1` | SUPERSEDED | 0/37/0/0 | 9ae63fbdb1 | 🧪 test(spike): measure relay and Yjs latency in microVMs (#3441) | scripts/spikes/col-01/.gitignore: main deleted it in 6a294a96e7 (🧪 test(spike): recover VM |
| 2026-10-02 13:57 | `4b3b64ca93` | SUPERSEDED | 0/31/0/0 | 4b3b64ca93 | 🧪 test(spike): measure relay and Yjs latency in microVMs (#3441) | scripts/spikes/col-01/.gitignore: main deleted it in 6a294a96e7 (🧪 test(spike): recover VM |
| 2026-10-02 13:57 | `a270a1098f` | SUPERSEDED | 0/31/0/0 | a270a1098f |  | scripts/spikes/col-01/.gitignore: main deleted it in 6a294a96e7 (🧪 test(spike): recover VM |
| 2026-10-02 13:57 | `3999c4c0ea` | SUPERSEDED | 0/31/0/0 | 3999c4c0ea |  | scripts/spikes/col-01/.gitignore: main deleted it in 6a294a96e7 (🧪 test(spike): recover VM |
| 2026-10-02 13:57 | `2b466b2b6a` | SUPERSEDED | 0/30/0/0 | 2b466b2b6a |  | scripts/spikes/col-01/.gitignore: main deleted it in 6a294a96e7 (🧪 test(spike): recover VM |
| 2026-10-02 13:57 | `dafab3926a` | SUPERSEDED | 0/449/0/0 | dafab3926a |  | scripts/spikes/col-01/browser.ts: main deleted it in 6a294a96e7 (🧪 test(spike): recover VM |
| 2026-10-02 14:10 | `924ebf2104` | PARTIAL | 18/211/66/12 | 924ebf2104 | ✨ feat(backend): add the TODO object, state machine, events and projec | .specs/product/actions.md: \| `todo` \| flow \| apps/app/src/mainview/flows/entries/todo.t |
| 2026-10-02 14:10 | `9ad4699473` | PARTIAL | 13/161/31/6 | 9ad4699473 |  | packages/rpc/src/Mythical.ts: /** `POST`: a maintainer files a TODO (`{ title, body }`); a |
| 2026-10-02 14:10 | `f2231907b8` | PARTIAL | 13/161/22/3 | f2231907b8 |  | packages/rpc/src/Mythical.ts: /** `POST`: a maintainer files a TODO (`{ title, body }`); a |
| 2026-10-02 14:10 | `6e3cbc98d2` | PARTIAL | 13/161/22/3 | 6e3cbc98d2 |  | packages/rpc/src/Mythical.ts: /** `POST`: a maintainer files a TODO (`{ title, body }`); a |
| 2026-10-02 14:11 | `1f20522feb` | SUPERSEDED | 0/20/0/0 | 1f20522feb | 🧪 test(spike): stress shared virtiofs member homes (#3437) | scripts/spikes/mch-02-virtiofs-homes/concurrent-worker.cjs: main deleted it in f0f56ce589 |
| 2026-10-02 14:11 | `7131281d9f` | SUPERSEDED | 0/4/0/0 | 4861667052 | 🧪 test(spike): stress shared virtiofs member homes (#3437) | scripts/spikes/mch-02-virtiofs-homes/concurrent-worker.cjs: main deleted it in f0f56ce589 |
| 2026-10-02 14:11 | `9032b494a6` | SUPERSEDED | 0/454/0/0 | 9032b494a6 |  | scripts/spikes/mch-02-virtiofs-homes/concurrent-worker.cjs: main deleted it in f0f56ce589 |
| 2026-10-02 14:11 | `c7250d32c4` | SUPERSEDED | 0/4/0/0 | c7250d32c4 |  | scripts/spikes/mch-02-virtiofs-homes/concurrent-worker.cjs: main deleted it in f0f56ce589 |
| 2026-10-02 14:13 | `5c99f2ce4f` | SUPERSEDED | 41/188/0/0 | 5c99f2ce4f |  | .specs/engineering/README.md: main carried then changed it: f138cc2d53 (📝 docs(specs): eng |
| 2026-10-02 14:15 | `11abbe16d7` | PARTIAL | 496/430/2/4 | 03a3694b3b | 🧹 refactor(app): delete Cut MVP surfaces (#3435) | packages/rpc/src/Cards.ts: import { AGENT_ROLES,  AgentRoleModelSchema } from "./AgentRole |
| 2026-10-02 14:29 | `e7b3051550` | SUPERSEDED | 0/18/0/0 | e7b3051550 |  | go.mod: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app, its Worker an |
| 2026-10-02 14:29 | `cbf0d3930d` | SUPERSEDED | 0/1/0/0 | cbf0d3930d |  | go.mod: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app, its Worker an |
| 2026-10-02 14:29 | `5e15e84174` | SUPERSEDED | 0/1/0/0 | 5e15e84174 |  | go.mod: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app, its Worker an |
| 2026-10-02 14:33 | `20783b49b9` | SUPERSEDED | 2/9/0/0 | 20783b49b9 |  | flows/issue-sweep/land.ts: main deleted it in 1884e6262b (🐛 fix(flows): register issue-swe |
| 2026-10-02 14:39 | `1317075d06` | SUPERSEDED | 0/3/0/0 | 1317075d06 |  | apps/app/PACKAGE.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app, |
| 2026-10-02 15:14 | `9d34c2542b` | PARTIAL | 12/3/42/6 | 9d34c2542b | 🐛 fix(cli): initialize required MCP without unrelated host services (# | packages/smithers/build/build-cli/src/engine.ts: import * as EffectNodePath from "@effect/ |
| 2026-10-02 15:14 | `8e2d288e32` | PARTIAL | 11/3/37/5 | 8e2d288e32 | 🐛 fix(cli): initialize required MCP without unrelated host services (# | packages/smithers/build/build-cli/src/engine.ts: import * as EffectNodePath from "@effect/ |
| 2026-10-02 15:17 | `2a97a69e93` | PARTIAL | 7/39/17/1 | 2a97a69e93 | 🐛 fix(factory): scope remote recovery ownership (#3413) | packages/smithers/flows/patterns/docs/burndown.md: Claim, landing and release keys also in |
| 2026-10-02 15:17 | `10ebdb6839` | PARTIAL | 4/75/12/2 | 80438d385b | ✨ feat(backend): derive machine limits from detected host capacity (#3 | apps/site/src/data/help/host.txt: status  Show the detected host profile and machine limit |
| 2026-10-02 15:17 | `3ba6237ede` | PARTIAL | 4/70/13/2 | 3ba6237ede |  | apps/site/src/data/help/host.txt: status  Show the detected host profile and machine limit |
| 2026-10-02 15:17 | `ddf8ab9ba9` | PARTIAL | 7/39/17/1 | ddf8ab9ba9 | 🐛 fix(factory): scope remote recovery ownership (#3413) | packages/smithers/flows/patterns/docs/burndown.md: `version` and explicit `true` attestati |
| 2026-10-02 15:17 | `879b69e3c3` | PARTIAL | 2/67/2/1 | 879b69e3c3 |  | packages/smithers/src/internal/backend/Commands.ts: "host status": (c) => c.request("GET", |
| 2026-10-02 15:18 | `b5d487148e` | PARTIAL | 1/43/21/29 | b5d487148e |  | packages/rpc/PACKAGE.ts: const cardFixtures = Smithers.glob("//apps/app/src/mainview/cards |
| 2026-10-02 15:18 | `9e8d01e519` | PARTIAL | 1/43/21/29 | 9e8d01e519 |  | packages/rpc/PACKAGE.ts: const cardFixtures = Smithers.glob("//apps/app/src/mainview/cards |
| 2026-10-02 15:18 | `6851f25350` | PARTIAL | 0/43/19/31 | 6851f25350 |  | packages/rpc/PACKAGE.ts: const cardFixtures = Smithers.glob("//apps/app/src/mainview/cards |
| 2026-10-02 15:20 | `da8a206db6` | SUPERSEDED | 0/6/0/0 | da8a206db6 |  | scripts/spikes/ins-03-brew-daemon/Formula/smithers-spike-msb.rb: main has no scripts (pack |
| 2026-10-02 15:20 | `c279d1deb0` | SUPERSEDED | 0/6/0/0 | c279d1deb0 |  | scripts/spikes/ins-03-brew-daemon/Formula/smithers-spike-msb.rb: main has no scripts (pack |
| 2026-10-02 15:25 | `6ef8a02b74` | PARTIAL | 41/215/0/1 | 6ef8a02b74 |  | .specs/engineering/overview.md: \| E-11 \| One admission queue with priority person > TODO |
| 2026-10-02 15:28 | `4861667052` | SUPERSEDED | 0/28/0/0 | 4861667052 |  | scripts/spikes/mch-02-virtiofs-homes/concurrent-worker.cjs: main deleted it in f0f56ce589 |
| 2026-10-02 15:28 | `80438d385b` | PARTIAL | 1/9/9/0 | 80438d385b |  | docs/api/openapi/host.yaml: required: [memory_bytes, perf_cores, physical_cores, disk_free |
| 2026-10-02 15:36 | `1a8b8222f1` | SUPERSEDED | 2/1/0/0 | 1a8b8222f1 |  | apps/server/scripts/deployDependencies.test.ts: main deleted it in 82b5490dbe (🔥 chore(rep |
| 2026-10-02 15:36 | `4e8593869f` | SUPERSEDED | 0/1/0/0 | 4e8593869f |  | apps/server/scripts/deployDependencies.test.ts: main deleted it in 82b5490dbe (🔥 chore(rep |
| 2026-10-02 15:42 | `a08cd8b05f` | SUPERSEDED | 14/94/0/0 | a08cd8b05f | ✨ feat(rpc): add card view-model contracts and action seam (#3474) | apps/app/src/mainview/Architecture.test.ts: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-02 15:42 | `1662612525` | PARTIAL | 1/43/21/29 | 1662612525 | ✨ feat(rpc): add card view-model contracts and action seam (#3474) | packages/rpc/PACKAGE.ts: const cardFixtures = Smithers.glob("//apps/app/src/mainview/cards |
| 2026-10-02 15:46 | `0b9a072ac7` | SUPERSEDED | 1/2/0/0 | 0b9a072ac7 | 🐛 fix(ci): drop deleted review workflows from actionlint (#3071) | .github/workflows/ci.yml: main carried then changed it: fb0ec43639 (✨ feat(ci): add the re |
| 2026-10-02 15:47 | `fb80484220` | SUPERSEDED | 1/2/0/0 | fb80484220 |  | apps/app/scripts/server-bundle-command.test.ts: main has no apps/app (package removed) |
| 2026-10-02 15:47 | `7e2b7bd3df` | SUPERSEDED | 1/2/0/0 | 7e2b7bd3df |  | apps/app/scripts/server-bundle-command.test.ts: main has no apps/app (package removed) |
| 2026-10-02 15:47 | `23e1d4a846` | SUPERSEDED | 1/2/0/0 | 23e1d4a846 |  | apps/app/scripts/server-bundle-command.test.ts: main has no apps/app (package removed) |
| 2026-10-02 15:54 | `af0d601a94` | PARTIAL | 96/46/34/10 | 9af5010598 | 🔥 docs(site): delete docs for cut surfaces, self-hosting and the five- | README.md: availability. Follow the [installation guide](https://smithers.sh/docs/installa |
| 2026-10-02 15:54 | `c185ee200a` | PARTIAL | 68/41/35/1 | c185ee200a |  | README.md: availability. Follow the [installation guide](https://smithers.sh/docs/installa |
| 2026-10-02 16:05 | `9af5010598` | PARTIAL | 2/61/159/1 | 9af5010598 |  | README.md: <!-- Generated from apps/site/src/data/project.json and apps/site/docs/installa |
| 2026-10-02 17:20 | `cd09439a2c` | PARTIAL | 3/7/23/2 | cd09439a2c | 🐛 fix(burndown): add audited repeat-safe dispatch identity (#3413) | packages/smithers/flows/patterns/src/Burndown.ts: const repeatSafetyOf = new WeakMap<objec |
| 2026-10-02 17:40 | `ff0f4bb5e9` | PARTIAL | 25/0/2/1 | smithers-sandbox/wtztlum | 🐛 fix(registry): preserve snapshot admission diagnostics (#3414, #3429 | packages/smithers/agent/registry/src/ExecutionSnapshot.ts: message: "Execution snapshot is |
| 2026-10-02 17:57 | `a53c9d02fc` | SUPERSEDED | 3/78/0/0 | a53c9d02fc | ✨ feat(backend): derive machine limits from the host profile (T-MCH-01 | apps/backend/isolation.go: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy |
| 2026-10-02 18:27 | `dcbf160de9` | PARTIAL | 4/180/11/13 | dcbf160de9 | 🔒 fix(backend): secure setup claims and owner upgrade recovery (T-ACC- | packages/rpc/src/ApplicationAuth.ts: /** Trades the one-time setup token for a setup sessi |
| 2026-10-02 18:41 | `6abe4af91b` | SUPERSEDED | 0/11/0/0 | 6abe4af91b |  | apps/app/PACKAGE.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app, |
| 2026-10-02 19:05 | `03a3694b3b` | SUPERSEDED | 5/19/0/0 | 03a3694b3b |  | apps/app/src/mainview/flows/FormCardsAgainstMain.test.ts: main deleted it in 82b5490dbe (🔥 |
| 2026-10-05 16:46 | `6bcc9e2fba` | SUPERSEDED | 0/22/0/0 | 6bcc9e2fba |  | packages/backend/PACKAGE.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove the lega |
| 2026-10-05 16:46 | `a0b8d752f5` | SUPERSEDED | 0/22/0/0 | a0b8d752f5 |  | packages/backend/PACKAGE.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove the lega |
| 2026-10-05 17:13 | `5a85f4656b` | SUPERSEDED | 2/26/0/0 | efdd883e00 | ✨ fix(commands): project help from the admitted registry (#3551) | apps/app/e2e/playwright/spec/C-UI-13.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:14 | `910b294af2` | SUPERSEDED | 0/10/0/0 | 57232b061b | 🎨 refactor(members): finish view selectors and browser proof (#3546) | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:15 | `d9a8bf5a6f` | SUPERSEDED | 1/59/0/0 | 3fde21bf65 | ✨ fix(app): finish toast and timeline shell proof (#3545) | apps/app/e2e/graph/flow-authoring.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo): r |
| 2026-10-05 17:16 | `cb9a2d21d7` | SUPERSEDED | 0/20/0/0 | a951b1328b | ✨ feat(todo): finish repair view and bind served wait controls (#3541) | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:16 | `28c38d0503` | SUPERSEDED | 0/20/0/0 | 283cdfc6de | ✨ feat(todo): finish repair view and bind served wait controls (#3541) | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:16 | `fa7ee0d04d` | SUPERSEDED | 0/20/0/0 | c0ff4492df | ✨ feat(todo): finish repair view and bind served wait controls (#3541) | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:16 | `687cdb7d3a` | SUPERSEDED | 0/20/0/0 | d2508e0a11 | ✨ feat(todo): finish repair view and bind served wait controls (#3541) | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:16 | `d0f61aeb99` | SUPERSEDED | 0/20/0/0 | d0f61aeb99 |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:19 | `8e21eba268` | SUPERSEDED | 0/2/0/0 | 8e21eba268 |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:19 | `c0601eaa74` | SUPERSEDED | 3/23/0/0 | 0c6b3cc625 | 🎨 refactor(ui): finish conversation shell styles (#3544) | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:19 | `efdd883e00` | SUPERSEDED | 0/1/0/0 | efdd883e00 |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:19 | `47e2f4aaab` | SUPERSEDED | 3/23/0/0 | 47e2f4aaab |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:26 | `f753b6f481` | SUPERSEDED | 0/54/0/0 | f753b6f481 |  | apps/app/e2e/playwright/home.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove |
| 2026-10-05 17:26 | `8b2777edad` | SUPERSEDED | 0/51/0/0 | 8b2777edad |  | apps/app/e2e/playwright/home.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove |
| 2026-10-05 17:26 | `a11f3a28b1` | SUPERSEDED | 0/45/0/0 | a11f3a28b1 |  | apps/app/e2e/playwright/home.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove |
| 2026-10-05 17:26 | `efc38da898` | SUPERSEDED | 0/38/0/0 | efc38da898 |  | apps/app/e2e/playwright/home.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove |
| 2026-10-05 17:27 | `b20afef2e9` | SUPERSEDED | 1/15/0/0 | b20afef2e9 |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:27 | `53f2b1b1cb` | SUPERSEDED | 1/15/0/0 | 53f2b1b1cb |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:28 | `6486367560` | SUPERSEDED | 1/9/0/0 | 6486367560 |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:28 | `9c87e93866` | SUPERSEDED | 1/9/0/0 | 9c87e93866 |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:28 | `24624cb600` | SUPERSEDED | 1/9/0/0 | 24624cb600 |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:30 | `68a7c09e8d` | SUPERSEDED | 0/1/0/0 | 68a7c09e8d |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:30 | `a951b1328b` | SUPERSEDED | 0/1/0/0 | a951b1328b |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:30 | `283cdfc6de` | SUPERSEDED | 0/1/0/0 | 283cdfc6de |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:30 | `c0ff4492df` | SUPERSEDED | 0/1/0/0 | c0ff4492df |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:30 | `d2508e0a11` | SUPERSEDED | 0/1/0/0 | d2508e0a11 |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:30 | `fa5ac3fa7e` | SUPERSEDED | 1/13/0/0 | fa5ac3fa7e |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:30 | `0c6b3cc625` | SUPERSEDED | 0/2/0/0 | 0c6b3cc625 |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:31 | `6db0626eb6` | SUPERSEDED | 0/2/0/0 | 6db0626eb6 |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-05 17:31 | `e516b02d76` | SUPERSEDED | 0/2/0/0 | e516b02d76 |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:31 | `56831d2983` | SUPERSEDED | 0/2/0/0 | 56831d2983 |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:31 | `3fde21bf65` | SUPERSEDED | 0/2/0/0 | 3fde21bf65 |  | apps/app/e2e/playwright/spec/COVERAGE.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-05 17:31 | `a57a81137c` | SUPERSEDED | 0/1/0/0 | a57a81137c |  | apps/app/src/mainview/cards/views/Views.test.tsx: main deleted it in 82b5490dbe (🔥 chore(r |
| 2026-10-05 17:31 | `57232b061b` | SUPERSEDED | 0/2/0/0 | 57232b061b |  | apps/app/e2e/playwright/spec/C-UI-12.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-06 02:27 | `813ab78a76` | SUPERSEDED | 0/12/0/0 | ccbecb9f36 | 🛡️ feat(migrations): gate landing and reserve table ownership (#3614) | LAND.md: main carried then changed it: a7d1b3cf1b (🛡️ feat(migrations): gate landing and r |
| 2026-10-06 02:35 | `b73c9432bd` | SUPERSEDED | 2/15/0/0 | ccbecb9f36 | ✅ fix(migrations): require drift targets and reproducible generation ( | packages/backend/db/product/migration_registry_test.go: main deleted it in 82b5490dbe (🔥 c |
| 2026-10-06 04:10 | `9c75a4a461` | SUPERSEDED | 5/7/0/0 | ccbecb9f36 | 🛡️ fix(migrations): restore isolated landing gate fixtures (#3614) | packages/backend/internal/db/models.go: main deleted it in 82b5490dbe (🔥 chore(repo): remo |
| 2026-10-06 05:24 | `78a0eefc4c` | SUPERSEDED | 0/3/0/0 | ccbecb9f36 | 🛠️ fix(db): restore migration ownership and sqlc parity (#3614) | packages/backend/db/ownership.csv: main deleted it in 82b5490dbe (🔥 chore(repo): remove th |
| 2026-10-06 09:14 | `91abec1daa` | SUPERSEDED | 7/15/0/0 | ccbecb9f36 | 🛠️ fix(migrations): reuse main history and current schema (#3614) | LAND.md: main carried then changed it: 263c41d3d8 (🔀 land the frontrun integration on main |
| 2026-10-06 09:16 | `ccbecb9f36` | SUPERSEDED | 6/7/0/0 | ccbecb9f36 | ✅ fix(migrations): preserve fixture toolchain cache (#3614) | scripts/migration-fixture.mjs: main deleted it in 3b61b49406 (♻️ refactor(repo-targets): o |
| 2026-10-06 09:17 | `6b45b4a7e0` | SUPERSEDED | 0/13/0/0 | 6b45b4a7e0 | ✂️ fix(backend): unmount cloud session audit on installs (#3509) | docs/api/openapi/repositories.yaml: main deleted it in 82b5490dbe (🔥 chore(repo): remove t |
| 2026-10-06 09:18 | `0cbba68741` | SUPERSEDED | 0/8/0/0 | 6316677a7d | 🔒 fix(access): preserve members on ambiguous GitHub permission replies | packages/backend/docs/members.md: main deleted it in 82b5490dbe (🔥 chore(repo): remove the |
| 2026-10-06 09:18 | `8060951735` | SUPERSEDED | 0/8/0/0 | 8060951735 | 🔒 fix(access): preserve members on ambiguous GitHub permission replies | packages/backend/docs/members.md: main deleted it in 82b5490dbe (🔥 chore(repo): remove the |
| 2026-10-06 09:54 | `952d9e6b27` | SUPERSEDED | 3/23/0/0 | 952d9e6b27 | 🔌 fix(live): validate frames and recover browser subscription cursors  | apps/app/e2e/live-channel.browser.test.ts: main deleted it in 249b9a75ea (🔌 fix(live): val |
| 2026-10-06 10:00 | `35a9b0709c` | SUPERSEDED | 16/47/0/0 | 07540f910c | 🐛 fix(stack): preserve author-bound issue snapshots (#3457) | apps/app/e2e/playwright/spec/C-J2-01.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-06 10:07 | `e6e81fe1e8` | SUPERSEDED | 2/38/0/0 | e6e81fe1e8 | ✨ feat(install): persist the owner ChatGPT pool setting (#3455) | apps/backend/install_restart_integration_test.go: main deleted it in 82b5490dbe (🔥 chore(r |
| 2026-10-06 10:07 | `9c8612cc2a` | SUPERSEDED | 17/6/0/0 | e6e81fe1e8 | ♻️ refactor(install): remove duplicate model key stores (#3455) | apps/app/PACKAGE.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app, |
| 2026-10-06 10:07 | `dd64088d79` | SUPERSEDED | 0/12/0/0 | e6e81fe1e8 | 🐛 fix(install): fence recovered machine readiness writes (#3455) | packages/backend/internal/compose/install_setup_integration_test.go: main deleted it in 82 |
| 2026-10-06 10:48 | `1ad4b65006` | SUPERSEDED | 2/23/0/0 | 07540f910c | 🔒 fix: refuse missing or stale issue TODO authorization (#3457) | apps/app/src/mainview/flows/entries/issue.test.ts: main deleted it in 82b5490dbe (🔥 chore( |
| 2026-10-06 10:48 | `604d7a4cae` | SUPERSEDED | 0/6/0/0 | 07540f910c | 🔒 fix: preserve active writer and App provenance checks (#3457) | packages/backend/internal/services/install_issues.go: main deleted it in 82b5490dbe (🔥 cho |
| 2026-10-06 10:59 | `96b1b48a24` | SUPERSEDED | 0/9/0/0 | 07540f910c | 🐛 fix: invalidate issue permissions on live continuity loss (#3457) | apps/app/src/mainview/runtime/LiveChannel.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-06 10:59 | `ef919ab62c` | SUPERSEDED | 0/7/0/0 | 07540f910c | 🐛 fix: distinguish install App issue text by numeric identity (#3457) | packages/backend/internal/services/install_issues.go: main deleted it in 82b5490dbe (🔥 cho |
| 2026-10-06 11:04 | `fd9af85733` | SUPERSEDED | 0/17/0/0 | 07540f910c | 🐛 fix: reauthorize issue TODOs before confirmation and drafting (#3457 | apps/app/src/mainview/flows/Commands.ts: main deleted it in 82b5490dbe (🔥 chore(repo): rem |
| 2026-10-06 11:21 | `07540f910c` | SUPERSEDED | 0/3/0/0 | 07540f910c | 🐛 Revalidate issue authorization after persistence (#3457) | apps/app/src/mainview/flows/entries/issue.test.ts: main deleted it in 82b5490dbe (🔥 chore( |
| 2026-10-06 12:10 | `6a48e8ecda` | SUPERSEDED | 4/7/0/0 | 6a48e8ecda | 🛡️ fix(checks): bind spike verdict closure to reviewed evidence (#3615 | scripts/check-evidence.mjs: main deleted it in 6fe01e9c16 (♻️ refactor(repo): move the las |
| 2026-10-06 12:34 | `30a9b9b433` | SUPERSEDED | 0/6/0/0 | 9966915e90 | 🔒 fix(backend): external.read is person-only (spec §8.7.2) | packages/backend/docs/members.md: main deleted it in 82b5490dbe (🔥 chore(repo): remove the |
| 2026-10-06 12:40 | `9966915e90` | SUPERSEDED | 0/27/0/0 | 9966915e90 | 🔒 fix(backend): the external-session reader follows no link beneath a  | packages/backend/internal/compose/external_sessions_integration_test.go: main deleted it i |
| 2026-10-06 14:15 | `905a3ed0c5` | SUPERSEDED | 0/36/0/0 | 6316677a7d | 🔒 fix(access): bind member rechecks to GitHub IDs (#3491) | packages/backend/docs/members.md: main deleted it in 82b5490dbe (🔥 chore(repo): remove the |
| 2026-10-06 14:43 | `6316677a7d` | SUPERSEDED | 0/30/0/0 | 6316677a7d | 🔒 Isolate roster failures and bind permission IDs (#3491) | packages/backend/internal/compose/main.go: main deleted it in 82b5490dbe (🔥 chore(repo): r |
| 2026-10-06 18:47 | `6a5e9f04a4` | SUPERSEDED | 0/8/0/0 | 6a5e9f04a4 | 🔒 fix(members): recheck permissions without metadata-sync qualificatio | packages/backend/internal/compose/github_sync_test.go: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-06 20:00 | `e0e62db618` | SUPERSEDED | 0/9/0/0 | e0e62db618 | ✨ feat(ci): add the reference-host runner workflow, guard hook and set | .github/actionlint.yaml: main carried then changed it: 39e5ceff5a (♻️ refactor(ci): keep t |
| 2026-10-06 21:33 | `ddee7aedb3` | SUPERSEDED | 0/6/0/0 | ddee7aedb3 | 🔒 fix(admin): require a person credential on admin routes | packages/backend/docs/run-credentials.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-06 21:33 | `e0ed222841` | SUPERSEDED | 0/6/0/0 | e0ed222841 | 🔒 fix(admin): require a person credential on admin routes | packages/backend/docs/run-credentials.md: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-06 21:34 | `801374522b` | SUPERSEDED | 22/5/0/0 | 801374522b | 🔒 fix(ci): give every drift SHA a verdict and keep the job token out o | PACKAGE.ts: main carried then changed it: c9c3d655c2 (🐛 fix(ci): bind trusted setup to its |
| 2026-10-06 21:54 | `8d5d2d79ac` | SUPERSEDED | 1/3/0/0 | 8d5d2d79ac | 🔒 fix(auth): verify owner settings through every adapter (#3706) | packages/backend/internal/db/install_repository.go: main deleted it in 82b5490dbe (🔥 chore |
| 2026-10-06 23:10 | `b940a307f9` | SUPERSEDED | 0/1/0/0 | b940a307f9 | wip | packages/backend/internal/compose/member_commands.go: main deleted it in 82b5490dbe (🔥 cho |
| 2026-10-06 23:14 | `57697dc67d` | SUPERSEDED | 0/14/0/0 | 57697dc67d | ✅ test(backend): run hostbackup and CSEC02 tests in CI's environment ( | packages/backend/internal/compose/flow_isolation_integration_test.go: main deleted it in 8 |
| 2026-10-06 23:25 | `3d3d986a4c` | SUPERSEDED | 1/8/0/0 | 3d3d986a4c | 🔒 fix(identity): fail closed when the owner querier cannot read settin | packages/backend/internal/identity/member_boundary.go: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-06 23:25 | `200019ef61` | SUPERSEDED | 1/8/0/0 | 200019ef61 | 🔒 fix(identity): fail closed when the owner querier cannot read settin | packages/backend/internal/identity/member_boundary.go: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-06 23:25 | `ab24da5b23` | SUPERSEDED | 1/8/0/0 | ab24da5b23 | 🔒 fix(identity): fail closed when the owner querier cannot read settin | packages/backend/internal/identity/member_boundary.go: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-06 23:25 | `d4574ed66d` | SUPERSEDED | 1/7/0/0 | d4574ed66d | 🔒 fix(identity): fail closed when the owner querier cannot read settin | packages/backend/internal/identity/member_boundary.go: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-06 23:25 | `ee48d12b3d` | SUPERSEDED | 0/7/0/0 | ab24da5b23 | 🔒 fix(access): keep external.read's never for delegated callers (#3492 | packages/backend/internal/compose/external_read_person_only_integration_test.go: main dele |
| 2026-10-07 02:40 | `65a09c20c7` | SUPERSEDED | 2/2/0/0 | 65a09c20c7 | ⏱️ fix(ci): give the Go backend suite room past go test's 10-minute de | PACKAGE.ts: main carried then changed it: 29f82321df (🔧 fix(ci): run access tests from dis |
| 2026-10-07 03:23 | `f44567f2d0` | SUPERSEDED | 0/12/0/0 | f44567f2d0 | 🔒 feat(ci): run the backend access-control tests on their own budget ( | .github/workflows/ci.yml: main carried then changed it: 851c5f9140 (done-workspace-targets |
| 2026-10-07 03:23 | `88913494dd` | SUPERSEDED | 0/12/0/0 | 88913494dd | 🔒 feat(ci): run the backend access-control tests on their own budget ( | .github/workflows/ci.yml: main carried then changed it: 851c5f9140 (done-workspace-targets |
| 2026-10-07 04:57 | `bf532ae920` | SUPERSEDED | 1/6/0/0 | bf532ae920 | 🔒 fix: isolate engineering gate authentication (#3613) | scripts/PACKAGE.ts: main deleted it in 6fe01e9c16 (♻️ refactor(repo): move the last of scr |
| 2026-10-07 06:42 | `8109a24833` | SCAFFOLD | 22/173/1/1 | 8109a24833 | wip col03r fixtures | docs/architecture/0004-machined-wire.md: `packages/backend/internal/compose/testdata/cocon |
| 2026-10-07 06:42 | `3e095a4944` | SCAFFOLD | 22/172/1/1 | 3e095a4944 | wip col03r fixtures | docs/architecture/0004-machined-wire.md: `packages/backend/internal/compose/testdata/cocon |
| 2026-10-07 06:42 | `b977ba6c07` | SCAFFOLD | 22/171/1/1 | b977ba6c07 | wip col03r fixtures | docs/architecture/0004-machined-wire.md: `packages/backend/internal/compose/testdata/cocon |
| 2026-10-07 06:42 | `c2e5bfcb65` | SCAFFOLD | 22/167/1/1 | c2e5bfcb65 | wip col03r fixtures | docs/architecture/0004-machined-wire.md: `packages/backend/internal/compose/testdata/cocon |
| 2026-10-07 07:09 | `9710d8dc86` | SUPERSEDED | 14/163/0/0 | 9710d8dc86 | wip col03r fixtures v2 | crates/smithers-machined/src/conn.rs: main deleted it in 2e68e23d14 (🛠️ fix(release): repa |
| 2026-10-07 07:25 | `033ffb0829` | SUPERSEDED | 0/207/0/0 | c6c8853153 | wip fixtures | crates/smithers-machined/src/transcript/wire.rs: main deleted it in 322ed84988 (🐛 fix(tran |
| 2026-10-07 07:25 | `e8b367efba` | SUPERSEDED | 0/203/0/0 | 3728ae1387 | wip fixtures | crates/smithers-machined/src/transcript/wire.rs: main deleted it in 322ed84988 (🐛 fix(tran |
| 2026-10-07 07:29 | `6778914616` | SUPERSEDED | 1/15/0/0 | c6c8853153 | wip codecs | crates/smithers-machined/src/conn.rs: main deleted it in 2e68e23d14 (🛠️ fix(release): repa |
| 2026-10-07 07:29 | `3728ae1387` | SCAFFOLD | 1/13/1/1 | 3728ae1387 | wip codecs | docs/architecture/0004-machined-wire.md: \| 17 \| `write_files` \| `1 changes: list<{1 pat |
| 2026-10-07 07:30 | `c6c8853153` | SUPERSEDED | 1/1/0/0 | c6c8853153 | wip adr | docs/architecture/0004-machined-wire.md: main carried then changed it: 13de9c59b7 (✅ test( |
| 2026-10-07 07:34 | `2bddcd2e0d` | SUPERSEDED | 2/221/0/0 | 2bddcd2e0d | ✅ test(machined): variant-5 transcript bounds and named stream bounds  | crates/smithers-machined/src/conn.rs: main deleted it in 2e68e23d14 (🛠️ fix(release): repa |
| 2026-10-07 07:55 | `e83ac05054` | SUPERSEDED | 0/36/0/0 | e83ac05054 | ✅ test(machined): pin record bounds, batch path refusals and local una | crates/smithers-machined/src/local.rs: main deleted it in 2e68e23d14 (🛠️ fix(release): rep |
| 2026-10-07 08:14 | `a4a20b86cd` | SUPERSEDED | 1/10/0/0 | 5015cf2b98 | 🐛 fix(cocontracts): give ev_moved_off_returned its own event_id and pi | docs/architecture/0004-machined-wire.md: main carried then changed it: 322ed84988 (🐛 fix(t |
| 2026-10-07 08:29 | `3db7927ac4` | PARTIAL | 3/4/1/2 | col03r-close-3626 | ✅ ci(machined): run T-COL-03r's ADR 0004 wire check C-COL-06 as //:mac | .github/workflows/ci.yml: run: "pnpm exec smthrs test '//:machinedWire' --known-red '.gith |
| 2026-10-07 08:29 | `4847fe3e63` | PARTIAL | 2/3/1/2 | 4847fe3e63 | ✅ ci(machined): run T-COL-03r's ADR 0004 wire slice as //:machinedWire | .github/workflows/ci.yml: run: "pnpm exec smthrs test '//:machinedWire' --known-red '.gith |
| 2026-10-07 08:29 | `5015cf2b98` | PARTIAL | 2/3/1/2 | 5015cf2b98 | ✅ ci(machined): run T-COL-03r's ADR 0004 wire slice as //:machinedWire | .github/workflows/ci.yml: run: "pnpm exec smthrs test '//:machinedWire' --known-red '.gith |
| 2026-10-07 10:44 | `96e251acbb` | ON-MAIN | 1/0/0/0 | 96e251acbb |  |  |
| 2026-10-07 18:48 | `ac47472556` | PARTIAL | 21/372/3/3 | ac47472556 |  | apps/site/src/data/cli-commands.json: "repo": {; apps/site/src/data/cli-commands.json: "op |
| 2026-10-07 18:49 | `2180af77ce` | SUPERSEDED | 0/3/0/0 | 2180af77ce |  | packages/backend/internal/compose/rehearsal_integration_test.go: main deleted it in 82b549 |
| 2026-10-07 19:07 | `725b0691c6` | SUPERSEDED | 0/1/0/0 | 855eddfa2c | 🧪 test(collaboration): refuse moved-off events and controls without pr | packages/backend/internal/compose/moved_off_providers_integration_test.go: main deleted it |
| 2026-10-07 19:08 | `d3747ac23f` | SUPERSEDED | 0/6/0/0 | d3747ac23f |  | packages/backend/internal/compose/branch_files_integration_test.go: main deleted it in 82b |
| 2026-10-07 19:08 | `855eddfa2c` | PARTIAL | 22/342/3/3 | 855eddfa2c |  | apps/site/src/data/cli-commands.json: "repo": {; apps/site/src/data/cli-commands.json: "op |
| 2026-10-07 19:15 | `b522fb3093` | SUPERSEDED | 0/1/0/0 | b10b061de9 | 🧪 test(presence): the Branch card names a TODO lane smithers/<slug> wi | packages/backend/internal/compose/presence_integration_test.go: main deleted it in 82b5490 |
| 2026-10-07 19:17 | `b10b061de9` | PARTIAL | 20/317/3/3 | b10b061de9 |  | apps/site/src/data/cli-commands.json: "repo": {; apps/site/src/data/cli-commands.json: "op |
| 2026-10-07 20:04 | `7a0ddff884` | SUPERSEDED | 0/4/0/0 | 7a0ddff884 |  | packages/backend/internal/compose/presence.go: main deleted it in 82b5490dbe (🔥 chore(repo |
| 2026-10-10 00:07 | `344a9adabd` | PARTIAL | 1/22/1/0 | 344a9adabd | fix(wiki): bound install pages to explicit source selections (#3787) | .smithers/coding-project.json: "excerpts": {; factory/wiki/README.md: main deleted it in 6 |
| 2026-10-10 00:53 | `4db8ccba03` | SUPERSEDED | 1/9/0/0 | 4db8ccba03 | 🐛 fix(agent): durably project completed coding replies into session tr | packages/backend/internal/routes/agent_flow_completion_integration_test.go: main deleted i |
| 2026-10-10 01:44 | `67ee1cb998` | SUPERSEDED | 0/2/0/0 | 67ee1cb998 | fix(terminal): refuse workflow background machines at admission (#3786 | packages/backend/internal/services/workspace_terminal_background_test.go: main has no pack |
| 2026-10-10 02:03 | `4c6ec2c6d8` | SUPERSEDED | 0/2/0/0 | 4c6ec2c6d8 | 🐛 fix(ssh): refuse background machines before branch reservation (#378 | packages/backend/internal/services/branch_ssh_background_test.go: main has no packages/bac |
| 2026-10-10 03:48 | `28c5a59925` | PARTIAL | 0/0/10/3 | 28c5a59925 | 🐛 fix(tui): leave stdin ownership to the renderer (#3702) | apps/tui/e2e/input-ownership-preload.mjs: process.on("warning", (warning) => warnings.push |
| 2026-10-10 04:22 | `31cf4a863a` | SUPERSEDED | 1/5/0/0 | 31cf4a863a | 🐛 fix(app): render supplied TODO merge actions (#3662) | apps/app/e2e/playwright/view-stories.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-10 08:32 | `9a68f68b26` | SCAFFOLD | 40/18/21/1 | 9a68f68b26 | fix(init): scaffold tagged runnable flow.ts (#3638) | apps/site/public/llms-full.txt: \| `migrationUrl`                \| `string` |
| 2026-10-10 09:06 | `dd80756e3f` | ON-MAIN | 5/0/0/0 | dd80756e3f | fix(tui): return typed approval preparation failures (#3671) |  |
| 2026-10-10 09:24 | `526ea677dd` | PARTIAL | 0/0/14/1 | 526ea677dd | fix(tui): preserve Chat position when toggling Cells (#3697) | apps/tui/README.md: reading where it was, and a reader at the live edge stays there. A pag |
| 2026-10-10 10:30 | `d81ce9b981` | STRANDED | 0/0/6/0 | d81ce9b981 | fix(tui): draw available answers before syntax highlighting (#3699) | apps/tui/e2e/answer-frames-fixture.tsx: createRoot(renderer).render(<App host={host} seat= |
| 2026-10-10 10:57 | `7bcf9a2535` | PARTIAL | 0/0/8/3 | 7bcf9a2535 | fix(tui): send Chat's a on Enter until answer selection (#3666) | apps/tui/README.md: unless you move the cursor; Enter in deliberately opened answer forms |
| 2026-10-10 11:15 | `73a7a8697e` | PARTIAL | 0/1/8/3 | 73a7a8697e | fix(tui): skip hidden programs in /grep (#3698) | apps/tui/README.md: `/grep <text>` keeps rows containing the text, skips hidden programs ( |
| 2026-10-10 11:37 | `11929e3109` | SUPERSEDED | 9/1/0/0 | 11929e3109 | fix(tui): show safe causes for remote flow failures (#3674) | apps/tui/test/fixtures/remote-failure-project/flows/failure/flow.ts: main deleted it in 51 |
| 2026-10-10 12:16 | `d3b36ac7a7` | STRANDED | 0/0/3/0 | d3b36ac7a7 | fix(model): ignore inherited failure copy entries (#3795) | packages/smithers/agent/model/src/FailureCopy.ts: const key = typeof value.code === "strin |
| 2026-10-10 12:29 | `3c156cc6f0` | PARTIAL | 1/0/3/1 | 3c156cc6f0 | 🐛 fix(tui): the chat row cache reuses its projection when the transcri | apps/tui/src/transcript-view.ts: const projectedChat = useMemo(() => RunCard.chat(transcri |
| 2026-10-10 12:43 | `7c360bd2cd` | PARTIAL | 0/0/2/2 | 7c360bd2cd | fix(model): safely inspect failure descriptions (#3796) | packages/smithers/agent/model/src/FailureCopy.ts: /** Snapshot only the copy's fields, so |
| 2026-10-10 12:59 | `617ca48896` | PARTIAL | 12/0/1/2 | 617ca48896 | 🐛 fix(tui): align /grep with non-program cell display (#3794) | apps/tui/src/timeline.ts: return [item.prose, item.source, item.printed, CellDisplay.text( |
| 2026-10-10 13:19 | `d9eacae175` | PARTIAL | 1/0/1/0 | d9eacae175 | fix(model): retain recognized budgets through malformed skipped causes | packages/smithers/agent/model/test/FailureCopyBudget.test.ts: expect(FailureCopy.describe( |
| 2026-10-10 13:28 | `b1266b07a7` | PARTIAL | 0/0/9/2 | b1266b07a7 | fix(tui): require explicit Summary row focus (#3682) | apps/tui/README.md: an empty composer focuses and moves. Row letters act only after that d |
| 2026-10-10 13:53 | `0429a5434c` | PARTIAL | 2/0/2/1 | 0429a5434c | fix(tui): report steering delivery in tabs fixture (#3683) | apps/tui/e2e/steering-delivery.test.ts: "removes the visible steering label at the real fi |
| 2026-10-10 14:12 | `62f5ff7635` | PARTIAL | 1/0/19/5 | 62f5ff7635 | fix(tui): show model replacements on worker cards (#3678) | apps/tui/README.md: line `↪ GPT-6.1 Sol has no credit · using Qwen 3.8` on its card and in |
| 2026-10-10 14:58 | `b39ca4665b` | STRANDED | 0/0/8/0 | b39ca4665b | fix(tui): retain pipeline checks and display multiline commands faithf | apps/tui/README.md: the preceding check in place; pipelines and uncertain commands keep th |
| 2026-10-10 15:18 | `a8a2e05e6d` | PARTIAL | 9/0/1/0 | a8a2e05e6d | 🐛 fix(tui): retain card focus when closing worker diffs (#3675) | apps/tui/src/app.tsx: if (reviewTab !== undefined && open === undefined && !key.ctrl && !k |
| 2026-10-10 15:54 | `1b0c595a39` | PARTIAL | 0/0/1/2 | 1b0c595a39 | fix(tui): project workspace fixture delegation outcomes (#3677) | apps/tui/e2e/workspace-fixture.tsx: let fixFrame = 0; apps/tui/e2e/workspace-fixture.tsx: |
| 2026-10-10 16:18 | `417e34ccc1` | STRANDED | 0/0/6/0 | 417e34ccc1 | 🛠️ fix(tui): stop the denied-edit replay after the denial (#3673) | apps/tui/docs/testing.md: with a failed `edit math.js` receipt whose summary starts `Denie |
| 2026-10-10 19:36 | `cc7646203d` | PARTIAL | 5/0/33/0 | cc7646203d | fix(tui): keep worker durations consistent and clock units whole (#367 | apps/tui/README.md: call, then the result, ending `ctrl+o program · 11.4s`; Ctrl+O reveals |
| 2026-10-13 05:31 | `798e31e447` | SUPERSEDED | 0/1/0/0 | 798e31e447 |  | apps/app/src/mainview/styles/cards.css: main deleted it in 82b5490dbe (🔥 chore(repo): remo |
| 2026-10-13 10:17 | `08c0b7944c` | SUPERSEDED | 0/9/0/0 | 08c0b7944c |  | docs/api/openapi/admin.yaml: main deleted it in 82b5490dbe (🔥 chore(repo): remove the lega |
| 2026-10-13 13:41 | `e9e0a419ca` | SUPERSEDED | 12/37/0/0 | e9e0a419ca |  | apps/app/e2e/playwright/flow-new-agent-form.spec.ts: main deleted it in 82b5490dbe (🔥 chor |
| 2026-10-13 14:58 | `61e65dbee5` | SUPERSEDED | 0/5/0/0 | 61e65dbee5 |  | apps/app/e2e/graph/flow-authoring.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo): r |
| 2026-10-13 16:58 | `b3236fcb79` | SUPERSEDED | 5/1/0/0 | b3236fcb79 |  | apps/site/src/content/docs/docs/reference/api/model.mdx: main carried then changed it: c9c |
| 2026-10-13 18:07 | `06d4d315cc` | SUPERSEDED | 0/1/0/0 | 06d4d315cc |  | packages/backend/cmd/chatdiag/main.go: main has no packages/backend (package removed) |
| 2026-10-14 05:29 | `e622e8856e` | SUPERSEDED | 0/6/0/0 | e622e8856e |  | packages/backend/internal/services/box_host.go: main deleted it in 82b5490dbe (🔥 chore(rep |
| 2026-10-14 09:09 | `6431936af9` | SUPERSEDED | 0/6/0/0 | db8f1ddd76 | 🐛 fix(app): a door this origin cannot serve is answered before the for | apps/app/src/mainview/flows/Commands.ts: main deleted it in 82b5490dbe (🔥 chore(repo): rem |
| 2026-10-14 09:09 | `92edbbc8ef` | SUPERSEDED | 0/6/0/0 | db8f1ddd76 | 🐛 fix(app): the Wiki door is the whole route family, not just Save to  | apps/app/scripts/unit-proof-selection.test.ts: main deleted it in 82b5490dbe (🔥 chore(repo |
| 2026-10-14 12:15 | `6e7e29a2aa` | PARTIAL | 55/19/1/2 | 6e7e29a2aa |  | packages/repo-targets/vitest.tmp-effect404.config.ts: if (id === "effect" \|\| id.startsWi |
| 2026-10-14 12:15 | `20b6252cd4` | ON-MAIN | 2/0/0/0 | 6e7e29a2aa | ✅ test(rpc): cover the History card's stack, lane, count and wiki proj |  |
| 2026-10-14 12:20 | `46cb495b2d` | SUPERSEDED | 0/19/0/0 | 46cb495b2d | 🔍 fix(app): bump APP_PROJECTOR_VERSION to 36 so a saved box list reope | apps/app/src/mainview/state/AppEventStream.ts: main deleted it in 82b5490dbe (🔥 chore(repo |
| 2026-10-14 12:20 | `719985caf8` | SUPERSEDED | 0/19/0/0 | 719985caf8 | 🔍 fix(app): bump APP_PROJECTOR_VERSION to 36 so a saved box list reope | apps/app/src/mainview/state/AppEventStream.ts: main deleted it in 82b5490dbe (🔥 chore(repo |
| 2026-10-14 12:20 | `c89f72b7d0` | ON-MAIN | 3/0/0/0 | c021bbbd49 | 🐛 fix(harness): keep each call ledger entry on one line |  |
| 2026-10-14 12:52 | `c021bbbd49` | ON-MAIN | 2/0/0/0 | c021bbbd49 | 🐛 fix(engine): render a NaN failure value as NaN, not negative infinit |  |
| 2026-10-14 14:48 | `801f514d36` | PARTIAL | 2/0/3/4 | 801f514d36 | 🐛 fix(testing): Faults waits ignore skewClock, and skewClock refuses n | packages/testing/docs/api.md: timeout runs on the real clock, so a live `skewClock` neithe |
| 2026-10-14 15:04 | `8a8729e277` | ON-MAIN | 3/0/0/0 | 8a8729e277 | 🐛 fix(run-store): release a pending steal claim when the stale owner s |  |
| 2026-10-14 15:10 | `2b48e94c16` | ON-MAIN | 9/0/0/0 | 2b48e94c16 | 🐛 fix(time-travel): refuse an empty fork workspaceRoot |  |
| 2026-10-14 15:25 | `6a3210d440` | ON-MAIN | 3/0/0/0 | 6a3210d440 | 🐛 fix(cli): download through a symlinked destination ancestor |  |
| 2026-10-14 17:32 | `a80c52be78` | ON-MAIN | 9/0/0/0 | a16459a919 | ✨ feat(engine): add a runnable quickstart example and package model re |  |
| 2026-10-14 17:33 | `a16459a919` | PARTIAL | 287/43/16/17 | a16459a919 |  | packages/repo-targets/vitest.tmp-effect404.config.ts: if (id === "effect" \|\| id.startsWi |
| 2026-10-14 17:39 | `2abd454040` | SUPERSEDED | 0/2/0/0 | 865abb05d4 | 🐛 fix(integrations): find a sticky comment after a github.com edit sav | packages/smithers/agent/integrations/src/github/Actions.ts: main carried then changed it: |
| 2026-10-14 17:39 | `5b56c1a847` | ON-MAIN | 6/0/0/0 | 1a00aac5c5 | ✅ test(run-store): add runnable quickstart and cancellation examples |  |
| 2026-10-14 17:40 | `865abb05d4` | PARTIAL | 351/41/16/23 | 865abb05d4 |  | packages/smithers/agent/harness/test/zz-probe-tmp.test.ts: it("probe", () => { for (const |
| 2026-10-14 17:40 | `1a00aac5c5` | PARTIAL | 344/43/16/24 | 1a00aac5c5 |  | packages/repo-targets/rt-probe.tmp.ts: try { ctx = JSON.stringify((ReviewDocsAgainstCode({ |
| 2026-10-14 17:44 | `838d73ade2` | ON-MAIN | 6/0/0/0 | 1ee38f3447 | ✅ test(capability): run the quickstart and grant guides as tested exam |  |
| 2026-10-14 17:47 | `1ee38f3447` | PARTIAL | 495/55/15/30 | 1ee38f3447 |  | apps/site/public/llms-full.txt: failure. Match on; apps/site/src/content/docs/docs/referen |
| 2026-10-14 17:49 | `dd5c741ce4` | SUPERSEDED | 0/2/0/0 | 45b7874a46 | ✅ test(backend): cover workspace source revision and session credentia | packages/backend/workspace/session_credential_test.go: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-14 17:52 | `69812b7de8` | SUPERSEDED | 0/2/0/0 | edcd2f4cb5 | ✅ test(backend): cover workspace source revision and session credentia | packages/backend/workspace/session_credential_test.go: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-14 17:52 | `45b7874a46` | PARTIAL | 566/55/15/31 | 45b7874a46 |  | apps/site/public/llms-full.txt: failure. Match on; apps/site/src/content/docs/docs/referen |
| 2026-10-14 17:53 | `edcd2f4cb5` | PARTIAL | 573/55/15/34 | edcd2f4cb5 |  | apps/site/public/llms-full.txt: failure. Match on; apps/site/src/content/docs/docs/referen |
| 2026-10-14 18:19 | `db8f1ddd76` | ON-MAIN | 1/0/0/0 | db8f1ddd76 | 🐛 fix(patterns): name the site reference page rather than globbing ano |  |
| 2026-10-14 18:50 | `2d6d27b8c8` | ON-MAIN | 4/0/0/0 | 2d6d27b8c8 | 🐛 fix(patterns): Debate.make hands members the round number |  |
| 2026-10-14 18:51 | `fd1125dda7` | SUPERSEDED | 9/1/0/0 | fd1125dda7 | 🐛 fix(registry): report same-pack duplicates and ignored model seats | packages/smithers/agent/registry/docs/guides/diagnose-a-missing-flow.md: main carried then |
| 2026-10-14 18:52 | `6527ca957f` | ON-MAIN | 8/0/0/0 | be0eae202f | ✅ test(harness): add tested examples and review targets |  |
| 2026-10-14 18:52 | `a63baaad78` | SUPERSEDED | 4/3/0/0 | a63baaad78 | ✅ test(patterns): runnable examples for the Effect forms | packages/smithers/flows/patterns/README.md: main carried then changed it: 7cca76b0ca (🔥 re |
| 2026-10-14 19:04 | `7da9390609` | ON-MAIN | 4/0/0/0 | 3bc718311f | 🐛 fix(testing): carry model retry and settle wire-timing fields throug |  |
| 2026-10-14 19:04 | `68ef8c428b` | ON-MAIN | 2/0/0/0 | 68ef8c428b | 🐛 fix(model): end open Anthropic text and thinking before the settle |  |
| 2026-10-14 19:04 | `106e324965` | PARTIAL | 579/64/18/15 | 106e324965 |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 19:04 | `3988b291bf` | ON-MAIN | 16/0/0/0 | 106e324965 | 🐛 fix(chain): snapshot caller arrays in Author.layerMock and Authorize |  |
| 2026-10-14 19:04 | `be0eae202f` | PARTIAL | 590/67/19/15 | be0eae202f |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 19:06 | `5820452f73` | ON-MAIN | 1/0/0/0 | cef5d69b56 | ✅ test(crypto): cover fragment Unicode and sparse boundaries |  |
| 2026-10-14 19:06 | `73ed4accc2` | ON-MAIN | 4/0/0/0 | 4f0aed1fb7 | 🐛 fix(time-travel): refuse two different records at one replay coordin |  |
| 2026-10-14 19:06 | `3bc718311f` | PARTIAL | 582/64/18/15 | 3bc718311f |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 19:07 | `cef5d69b56` | PARTIAL | 579/59/18/14 | cef5d69b56 |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 19:07 | `4f0aed1fb7` | PARTIAL | 576/59/18/14 | 4f0aed1fb7 |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 19:08 | `4ab28d362f` | SUPERSEDED | 13/5/0/0 | 4ab28d362f | 🐛 fix(engine-store): serve a reclaimed run's in-flight step from the s | packages/smithers/flows/engine-store/src/internal/ActionPersistence.ts: main carried then |
| 2026-10-14 19:19 | `0f7df592ed` | SUPERSEDED | 13/1/0/0 | 0f7df592ed |  | packages/smithers/agent/test/CellFlows.test.ts: main carried then changed it: 0fd9d0693d ( |
| 2026-10-14 19:20 | `8c6d53f2b8` | SUPERSEDED | 71/4/0/0 | 8c6d53f2b8 | wip: defect B (#3962) | apps/site/public/llms-full.txt: main carried then changed it: dbcd25efba (📝 docs: regenera |
| 2026-10-14 19:22 | `259eda1f88` | PARTIAL | 543/58/18/14 | 259eda1f88 |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 19:23 | `d31753ff73` | SUPERSEDED | 0/5/0/0 | d31753ff73 | 🐛 fix(services): a run log append without a transaction keeps its line | packages/backend/internal/services/agent.go: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-14 19:23 | `8de59770aa` | SUPERSEDED | 0/6/0/0 | d31753ff73 | 🔍 fix(workspace): a branch sleep that refuses names the step that did  | packages/backend/internal/services/workspace_sleep.go: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-14 19:23 | `2b59531dc0` | SUPERSEDED | 0/9/0/0 | d31753ff73 | 🔍 fix(workspace): a repository door on a vanished machine names the ma | packages/backend/internal/services/workspace_repository.go: main deleted it in 82b5490dbe |
| 2026-10-14 19:23 | `80b70cc65b` | SUPERSEDED | 0/20/0/0 | 80b70cc65b |  | packages/backend/internal/services/agent.go: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-14 19:29 | `cb24c3c390` | PARTIAL | 526/58/18/14 | cb24c3c390 |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 19:30 | `ff428962db` | PARTIAL | 528/68/18/14 | ff428962db |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 19:41 | `3e1317393d` | SUPERSEDED | 8/1/0/0 | 3e1317393d |  | packages/smithers/agent/model/src/HttpStatusClassifier.ts: main carried then changed it: b |
| 2026-10-14 19:57 | `bfd95be29f` | SUPERSEDED | 203/20/0/0 | bfd95be29f |  | apps/site/public/llms-full.txt: main carried then changed it: 3ed562a8ab (📝 docs(site): re |
| 2026-10-14 19:57 | `9b91c77ae4` | SUPERSEDED | 0/1/0/0 | 9b91c77ae4 |  | packages/smithers/test/ClaudeCode.test.ts: main carried then changed it: a796a67584 (✅ tes |
| 2026-10-14 19:57 | `a36ebbf27f` | SUPERSEDED | 0/1/0/0 | a36ebbf27f |  | packages/smithers/test/ClaudeCode.test.ts: main carried then changed it: a796a67584 (✅ tes |
| 2026-10-14 19:57 | `2255b9c7dc` | PARTIAL | 92/1/0/1 | 2255b9c7dc |  | packages/smithers/agent/integrations/docs/quickstart.md: npm install @smthrs/integrations@ |
| 2026-10-14 20:00 | `01ef4969e6` | SUPERSEDED | 9/4/0/0 | 01ef4969e6 |  | packages/smithers/agent/harness/test/CellPrompt.test.ts: main carried then changed it: 927 |
| 2026-10-14 20:08 | `5acaa6bede` | SUPERSEDED | 4/5/0/0 | 5acaa6bede | 🔍 fix(model-host): a proxied callback records no resolution it did not | packages/smithers/agent/CHANGELOG.md: main carried then changed it: 13c2ee43b9 (🔍 fix(mode |
| 2026-10-14 20:08 | `3119f0c91b` | ON-MAIN | 2/0/0/0 | 5acaa6bede | 🎨 style(agent): format the workspace observation test to the group's o |  |
| 2026-10-14 20:10 | `5f94accee7` | SUPERSEDED | 4/17/0/0 | 5f94accee7 | 🐛 fix(app): a search that refused presents its verdict, never paints r | apps/app/src/mainview/cards/SearchResultsCard.test.tsx: main deleted it in 82b5490dbe (🔥 c |
| 2026-10-14 20:13 | `ca705c5458` | SUPERSEDED | 8/1/0/0 | ca705c5458 |  | packages/smithers/agent/model/src/HttpStatusClassifier.ts: main carried then changed it: b |
| 2026-10-14 20:13 | `a6457278fb` | SUPERSEDED | 8/1/0/0 | a6457278fb |  | packages/smithers/agent/model/src/HttpStatusClassifier.ts: main carried then changed it: b |
| 2026-10-14 20:17 | `501e378253` | PARTIAL | 455/65/18/14 | 501e378253 |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 20:17 | `a3d8c239a9` | PARTIAL | 455/58/18/14 | a3d8c239a9 |  | apps/site/public/llms-full.txt: or contains NUL, the empty string included. It is thrown r |
| 2026-10-14 20:29 | `b12c788e1f` | SUPERSEDED | 0/3/0/0 | b12c788e1f |  | packages/backend/internal/services/workspace_sleep.go: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-14 20:30 | `1e9ae7ea44` | ON-MAIN | 3/0/0/0 | 1e9ae7ea44 |  |  |
| 2026-10-15 23:44 | `e3578de251` | SUPERSEDED | 0/20/0/0 | e3578de251 | fix(workspace): the failed-start cleanup deletes the guest the start c | packages/backend/db/product/queries/workspace.sql: main deleted it in 82b5490dbe (🔥 chore( |
| 2026-10-15 23:50 | `acde6366ab` | SUPERSEDED | 0/2/0/0 | acde6366ab |  | apps/app/src/mainview/ShellRail.test.tsx: main deleted it in 82b5490dbe (🔥 chore(repo): re |
| 2026-10-16 00:20 | `0d921a934e` | SUPERSEDED | 0/13/0/0 | codex/root-integration-s | ✨ feat(app): a GitHub URL Smithers doesn't have offers the step that e | apps/app/src/mainview/App.tsx: main deleted it in 82b5490dbe (🔥 chore(repo): remove the le |
| 2026-10-16 00:35 | `6f6ef1a529` | SUPERSEDED | 8/21/0/0 | codex/root-issue-policy- | 🐛 fix(app): an issue write says which tracker it means, so #6 is not t | apps/app/src/mainview/cards/IssueThread.tsx: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-16 00:50 | `4463c8aee1` | SUPERSEDED | 7/54/0/0 | codex/root-integration-s | ✨ feat(app): / launches repositories and real Smithers news; a reposit | apps/app/src/mainview/App.tsx: main deleted it in 82b5490dbe (🔥 chore(repo): remove the le |
| 2026-10-16 00:57 | `d057fe9e2b` | SUPERSEDED | 3/49/0/0 | codex/root-issue-policy- | 🐛 fix(app): the ordinary issue acts reach the repository's own GitHub  | apps/app/src/mainview/CloudIssueDoor.test.tsx: main deleted it in 82b5490dbe (🔥 chore(repo |
| 2026-10-16 01:28 | `8b25f986d2` | SUPERSEDED | 0/3/0/0 | 976869dc1d | 🐛 fix(backend): an interrupted release cannot write off a guest it nev | packages/backend/internal/services/workspace_reconcile.go: main deleted it in 82b5490dbe ( |
| 2026-10-16 01:43 | `976869dc1d` | SUPERSEDED | 0/5/0/0 | 976869dc1d | 🐛 fix(backend): a recovered release needs a positive stop receipt, not | packages/backend/internal/services/workspace_reconcile.go: main deleted it in 82b5490dbe ( |
| 2026-10-16 01:44 | `a6b4ab51fb` | SUPERSEDED | 7/3/0/0 | a6b4ab51fb |  | evals/harbor/README.md: main deleted it in 595b6abcbc (♻️ refactor(evals): move eval suite |
| 2026-10-16 02:23 | `8038921a9b` | SUPERSEDED | 4/42/0/0 | codex/root-integration-s | ✨ feat(repos): Create makes a real GitHub repository, and one URL asks | apps/app/src/mainview/RepoLink.test.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remo |
| 2026-10-16 02:23 | `3134171b0f` | SUPERSEDED | 1/29/0/0 | codex/root-integration-s | feat(monitor): serve a repository own run index so hosted monitoring r | apps/app/src/mainview/state/AppController.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-16 02:44 | `764b8b6ec8` | SUPERSEDED | 1/30/0/0 | codex/root-issue-policy- | 🐛 fix(app): the hosted origin writes the repository's own GitHub track | apps/app/src/mainview/state/seams/IssuesSeam.hostedGithubWriter.test.ts: main deleted it i |
| 2026-10-16 03:19 | `d0c930e0ee` | SUPERSEDED | 0/18/0/0 | codex/root-integration-s | 🐛 fix(app): /branches lists the connected repository's own branches on | apps/app/src/mainview/BranchNavigation.tsx: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-16 03:37 | `b4cfb09078` | SUPERSEDED | 0/5/0/0 | b4cfb09078 |  | apps/app/src/mainview/state/controller/cloud-wiki.selection.test.ts: main deleted it in 82 |
| 2026-10-16 03:56 | `1b32e9de14` | SUPERSEDED | 0/16/0/0 | codex/root-integration-s | 🐛 fix(repos): a create GitHub answered 201 is never pressed again, and | apps/app/src/mainview/state/seams/GitHubRepoCreateSeam.test.ts: main deleted it in 82b5490 |
| 2026-10-16 04:04 | `ebb9dae648` | SUPERSEDED | 0/5/0/0 | codex/root-integration-s | 🔒 fix(monitor): judge a repository's monitor reads by the install's ow | packages/backend/internal/compose/install_repository_run_monitor_policy_integration_test.g |
| 2026-10-16 04:09 | `84f6cc7a5e` | SUPERSEDED | 0/16/0/0 | codex/root-integration-s | 🐛 fix(app): fence the hosted branch read to one account generation and | apps/app/src/mainview/BranchNavigation.tsx: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-16 04:10 | `21d0afd93a` | PARTIAL | 0/0/162/115 | 21d0afd93a |  | packages/smithers/flows/flow/dist/esm/Action/Action.d.ts: export interface Declared<Tag ex |
| 2026-10-16 04:36 | `eddb3f7f3d` | SUPERSEDED | 3/17/0/0 | codex/root-notification- | ✨ feat(app): let a repository flow own notification policy (#4026) | .specs/product/mvp.md: main carried then changed it: 7df5f685fc (🚚 refactor(repo): move th |
| 2026-10-16 04:50 | `f338fef026` | SUPERSEDED | 0/37/0/0 | f338fef026 |  | apps/app/e2e/playwright/spec/C-J2-01.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-16 05:01 | `3ce8d611be` | SUPERSEDED | 21/59/0/0 | codex/root-issue-policy- | 🐛 fix(app): a repository flow moves its own issues on GitHub, and the  | apps/app/src/mainview/flows/SlashPayload.ts: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-16 05:17 | `8f41a36ff3` | ON-MAIN | 7/0/0/0 | 8f41a36ff3 |  |  |
| 2026-10-16 05:30 | `a10b77a203` | SUPERSEDED | 4/27/0/0 | codex/root-pr-review-sou | ✨ feat(app,backend): review the actual GitHub pull request, not the na | .specs/product/mvp.md: main carried then changed it: 316b77b1d5 (🔒 fix(backend,app): one G |
| 2026-10-16 05:37 | `11c9b6df10` | SUPERSEDED | 0/1/0/0 | 11c9b6df10 |  | apps/app/tsconfig.json: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy ap |
| 2026-10-16 05:40 | `943bb4002e` | PARTIAL | 0/19/1/0 | codex/root-notification- | 📝 docs(review): lane 78 receipts and handoff for the #4026 policy revi | ROOT-NOTE-notification-policy-review-78.md: \| `smithers-build target //:factoryProjection |
| 2026-10-16 05:40 | `e02c005dfe` | SUPERSEDED | 0/18/0/0 | codex/root-notification- | 🐛 fix(app): fence, bound and honour a repository notification policy ( | apps/app/src/mainview/ShellRail.tsx: main deleted it in 82b5490dbe (🔥 chore(repo): remove |
| 2026-10-16 06:16 | `d491da2c37` | SUPERSEDED | 2/12/0/0 | codex/root-notification- | 🐛 fix(app): bound the notification policy's declaration read and fence | apps/app/src/mainview/state/controller/notificationPolicy.ts: main deleted it in 82b5490db |
| 2026-10-16 06:32 | `fcc907a9ef` | SUPERSEDED | 2/4/0/0 | fcc907a9ef |  | scripts/fixtures/public-api-baseline.json: main deleted it in 9f95724ff8 (♻️ refactor(flow |
| 2026-10-16 07:29 | `92f53aa488` | SUPERSEDED | 2/4/0/0 | 92f53aa488 |  | scripts/fixtures/public-api-baseline.json: main deleted it in 9f95724ff8 (♻️ refactor(flow |
| 2026-10-16 10:37 | `d3decdc90b` | SUPERSEDED | 0/2/0/0 | d3decdc90b |  | apps/app/src/mainview/state/seams/RepositoryAuthority.test.ts: main deleted it in 82b5490d |
| 2026-10-16 14:43 | `fa063ac1a5` | SUPERSEDED | 1/2/0/0 | fa063ac1a5 |  | apps/app/src/mainview/RepositorySubjectRoute.test.tsx: main deleted it in 82b5490dbe (🔥 ch |
| 2026-10-16 20:14 | `2976bc75e0` | PARTIAL | 41/23/4/2 | 257ede9a75 |  | packages/rpc/src/RepositoryHome.ts: const markdown = z.object({ type: z.literal("markdown" |
| 2026-10-16 20:22 | `eb2940bb96` | ON-MAIN | 4/0/0/0 | 147ca67f07 | ✅ test(agent): exercise native E2BIG without supervisor startup races  |  |
| 2026-10-16 20:22 | `257ede9a75` | PARTIAL | 6/0/180/4 | 257ede9a75 |  | evals/swebench/fixtures/flows-cell-harness.mirror.json: "astropy__astropy-8707",; evals/sw |
| 2026-10-16 20:24 | `147ca67f07` | PARTIAL | 5/14/179/4 | 147ca67f07 |  | evals/swebench/fixtures/flows-cell-harness.mirror.json: "astropy__astropy-8707",; evals/sw |
| 2026-10-16 20:24 | `1af7df96d6` | PARTIAL | 5/13/179/4 | 1af7df96d6 |  | evals/swebench/fixtures/flows-cell-harness.mirror.json: "astropy__astropy-8707",; evals/sw |
| 2026-10-16 20:24 | `ce197f0c02` | ON-MAIN | 2/0/0/0 | ce197f0c02 |  |  |
| 2026-10-16 20:26 | `ea78e3e313` | SUPERSEDED | 0/1/0/0 | ea78e3e313 |  | apps/site/src/content/docs/docs/reference/api/patterns.mdx: main carried then changed it: |
| 2026-10-16 21:32 | `e22fc1de59` | SUPERSEDED | 0/7/0/0 | e22fc1de59 |  | packages/backend/internal/compose/install_quiesce.go: main deleted it in 82b5490dbe (🔥 cho |
| 2026-10-17 19:09 | `f3a623563d` | SUPERSEDED | 0/27/0/0 | 2a944afbf3 | ✨ feat(guest): reserve sponsored repository chat | packages/backend/db/ownership.csv: main deleted it in 82b5490dbe (🔥 chore(repo): remove th |
| 2026-10-17 19:28 | `2a944afbf3` | SUPERSEDED | 0/58/0/0 | 2a944afbf3 | ✨ feat(app): stream allowlisted guest repository chat | apps/app/e2e/playwright/guest-chat.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-17 19:44 | `5036067ccb` | PARTIAL | 0/36/6/0 | 5036067ccb | 🎛️ feat(sites): add owner controls and prebuilt publishing | packages/smithers/src/internal/backend/Commands.ts: import { sites } from "./Sites.ts"; pa |
| 2026-10-17 19:44 | `9166597e7f` | PARTIAL | 0/67/7/0 | 5036067ccb | 🌐 feat(sites): publish repository sites and bind verified domains | apps/site/astro.config.mjs: build: { assets: "__smithers" },; docs/api/openapi/sites.yaml: |
| 2026-10-17 19:44 | `12e5254c9a` | SUPERSEDED | 0/24/0/0 | 5036067ccb | 🔒 fix(auth): isolate OAuth browser binding cookies | apps/app/e2e/real/auth-permissions.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-17 19:45 | `3836ba6a2e` | SUPERSEDED | 53/3/0/0 | 3836ba6a2e | 🧪 feat(build): artifact tests report but never block | packages/smithers/build/build-cli/src/Cli.ts: main carried then changed it: 3757e67f8a (✨ |
| 2026-10-17 20:29 | `f38cf93a2a` | SUPERSEDED | 10/41/0/0 | f38cf93a2a | ✨ feat(front-door): choose a launcher lead for each visit | apps/app/PACKAGE.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app, |
| 2026-10-17 20:42 | `9335d5fa7d` | PARTIAL | 239/0/34/91 | 9335d5fa7d |  | .specs/design/mock/build.mjs: entryPoints: [SITE ? (existsSync(join(SITES, `${SITE}-main.t |
| 2026-10-17 20:48 | `59fd583817` | PARTIAL | 0/13/4/0 | 28a10398f8 | ✨ feat(site): make the visitor landing one static repository action | apps/site/scripts/built-site.test.mjs: assert.match(checkLandingActions(fixture(t, { "inde |
| 2026-10-17 20:48 | `dbbd5a50bf` | SUPERSEDED | 0/54/0/0 | dbbd5a50bf | ✨ feat(guest): run repository conversions with signed compiler receipt | apps/app/e2e/playwright/conversion.spec.ts: main deleted it in 82b5490dbe (🔥 chore(repo): |
| 2026-10-17 20:53 | `62148f367d` | PARTIAL | 3/0/5/2 | 62148f367d |  | packages/smithers/agent/registry/src/Executable.ts: * is one bounded line, never the stack |
| 2026-10-17 20:53 | `ea32db90a5` | SUPERSEDED | 1/1/0/0 | ea32db90a5 |  | packages/backend/egressrelay/opacity_test.go: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-17 20:56 | `ca6e3e6395` | SUPERSEDED | 1/11/0/0 | 28a10398f8 | 🐛 feat(app): open contextual bug drafts through three flow doors | apps/app/src/mainview/BugReport.ts: main deleted it in 82b5490dbe (🔥 chore(repo): remove t |
| 2026-10-17 20:57 | `28a10398f8` | PARTIAL | 1/8/2/2 | 28a10398f8 | ✨ feat(app): separate public repository home from member actions | .smithers/FACTORY.ts: { label: "Report a bug", url: "https://github.com/smithersai/smither |
| 2026-10-17 21:04 | `c1ec763351` | PARTIAL | 1/0/6/4 | c1ec763351 | 🐛 fix(cli): name what a flow body threw when it cannot load (#4253) | packages/smithers/agent/registry/src/Executable.ts: * all read "could not be loaded" (#425 |
| 2026-10-17 21:14 | `d6fa75217b` | SUPERSEDED | 1/75/0/0 | d6fa75217b | 🐛 fix(backend): leave a workspace claim its connections at the shipped | packages/backend/db/product/queries/workspace_provisioning.sql: main deleted it in 82b5490 |
| 2026-10-17 21:17 | `941e831d17` | SUPERSEDED | 0/21/0/0 | 941e831d17 | 🔒 fix(egressrelay): swap only whole placeholders and mask value runs ( | packages/backend/egressrelay/opacity_test.go: main deleted it in 82b5490dbe (🔥 chore(repo) |
| 2026-10-17 21:28 | `64848f4f3c` | SUPERSEDED | 0/10/0/0 | cf1d3c7573 | ✨ feat(egressrelay): sign with a given CA and forward through an upstr | packages/backend/egressrelay/relay.go: main deleted it in 82b5490dbe (🔥 chore(repo): remov |
| 2026-10-17 21:35 | `010fbc424a` | SUPERSEDED | 2/57/0/0 | 010fbc424a | 🐛 fix(backend): never wait out another replica's session advisory lock | packages/backend/flowhost/binding_lock_bound_integration_test.go: main deleted it in 82b54 |
| 2026-10-17 21:47 | `e058383e32` | SUPERSEDED | 5/13/0/0 | e058383e32 | 🐛 fix(flows): resume uncaptured callbacks after host restart | packages/smithers/flows/core/docs/troubleshooting.md: main carried then changed it: 8c69f3 |
| 2026-10-17 21:54 | `cf1d3c7573` | SUPERSEDED | 5/2/0/0 | cf1d3c7573 |  | packages/backend/ironproxy/config.go: main deleted it in 82b5490dbe (🔥 chore(repo): remove |
| 2026-10-17 23:15 | `e99ce3e179` | PARTIAL | 6/48/1/0 | e99ce3e179 | ⚡ fix(chat): refuse known capacity shortages and show turn stages | .smithers/factory.json: "description": "Import 26 UTC weeks of request lead time and sourc |
| 2026-10-17 23:58 | `9f22b2e653` | SUPERSEDED | 1/8/0/0 | 9f22b2e653 | wip: 4a regress fixes | packages/backend/internal/chat/context_callback_integration_test.go: main deleted it in 82 |
| 2026-10-18 00:06 | `f2354423ff` | SUPERSEDED | 0/2/0/0 | f2354423ff | wip: cookie proof chrome | apps/server/docs/host-cookie-isolation.md: main deleted it in 82b5490dbe (🔥 chore(repo): r |
| 2026-10-20 08:02 | `354d59dda5` | SUPERSEDED | 156/46/0/0 | 354d59dda5 |  | apps/mvp/worker/ExecutionHost.test.ts: main carried then changed it: b0399926ba (✨ feat(mv |
| 2026-10-20 13:04 | `1ef9292cf0` | PARTIAL | 1762/652/234/26 | 1ef9292cf0 |  | .changeset/attached-wait-reports-outcome.md: snapshot answers, and the driver waits about |
| 2026-10-20 17:14 | `b0d1a1148f` | SCAFFOLD | 84/23/2/12 | b0d1a1148f | ✨ feat(fs): @smthrs/fs on VibeLang (wip: land after vibelang is on npm | packages/smithers/agent/fs/package.json: "vibelang-runtime": "file:../../../../../../vibe/ |
| 2026-10-20 18:42 | `0432886e45` | PARTIAL | 2612/718/447/44 | 0432886e45 |  | .changeset/attached-wait-reports-outcome.md: snapshot answers, and the driver waits about |
| 2026-10-20 23:58 | `3a2cfc7c56` | ON-MAIN | 1/0/0/0 | efb69411db | 🧠 feat(agent): port Jev opening memory and skill selection |  |
| 2026-10-20 23:58 | `b1e87690f1` | ON-MAIN | 1/0/0/0 | e7c2dfa26f | 🧠 feat(agent): port Jev opening memory and skill selection |  |
| 2026-10-20 23:58 | `b146099057` | ON-MAIN | 1/0/0/0 | c751c7cd0a | 🧠 feat(agent): port Jev opening memory and skill selection |  |
| 2026-10-20 23:58 | `3a65c87065` | SUPERSEDED | 42/6/0/0 | c751c7cd0a | 🧠 feat(agent): port Jev opening memory and skill selection | apps/mvp/src/features/agent/memory.test.ts: main carried then changed it: 1b93e11552 (🐛 fi |
| 2026-10-20 23:58 | `c5aa42408f` | SUPERSEDED | 42/6/0/0 | 2eebe05718 | 🧠 feat(agent): port Jev opening memory and skill selection | apps/mvp/src/features/agent/memory.test.ts: main carried then changed it: 1b93e11552 (🐛 fi |
| 2026-10-20 23:58 | `4d548d3eeb` | SUPERSEDED | 41/7/0/0 | 3cb9124e12 | 🧠 feat(agent): port Jev opening memory and skill selection | apps/mvp/src/features/agent/host.ts: landed as 5d6c5efc06 (same author and time, committed |
| 2026-10-20 23:58 | `24747a3bf0` | SUPERSEDED | 34/8/0/0 | 24747a3bf0 | 🧠 feat(agent): port Jev opening memory and skill selection | apps/mvp/src/features/agent/host.ts: landed as 5d6c5efc06 (same author and time, committed |
| 2026-10-21 00:00 | `7d1f83e264` | SCAFFOLD | 56/18/2/0 | 7d1f83e264 | wip: 4c alone (registry adapted to main) - reference only | packages/smithers/flows/platform-browser/docs/api.md: \| `BrowserRuntime.run(options)` |
| 2026-10-21 00:15 | `62b9ef30ca` | PARTIAL | 1688/5217/4/3 | 62b9ef30ca | land4d: combined (to split) | .land4-sdk.sh: ( cd "$d" && pnpm run check ) > /tmp/land4-check.log 2>&1 \|\| { ok=0; echo |
| 2026-10-21 01:04 | `c3f3d6782a` | PARTIAL | 2086/1819/3962/67 | c3f3d6782a |  | .changeset/attached-wait-reports-outcome.md: snapshot answers, and the driver waits about |
| 2026-10-21 02:10 | `39a13b08de` | STRANDED | 0/0/1/0 | 39a13b08de | 📝 docs(mvp): record the round 4 production deploy and its smoke test | apps/mvp/docs/infrastructure.md: Also logged: the site Worker throws `Can't read from requ |
| 2026-10-21 02:59 | `5b0337ba95` | SUPERSEDED | 19/13/0/0 | c751c7cd0a | 🐛 fix(mvp): the timeline's summaries follow the window, so a long conv | apps/mvp/docs/features/timeline.md: main carried then changed it: 5032597657 (🐛 fix(mvp): |
| 2026-10-21 02:59 | `648d7a90cd` | SUPERSEDED | 19/13/0/0 | 2eebe05718 | 🐛 fix(mvp): the timeline's summaries follow the window, so a long conv | apps/mvp/docs/features/timeline.md: main carried then changed it: 5032597657 (🐛 fix(mvp): |
| 2026-10-21 02:59 | `f437a00c40` | SUPERSEDED | 19/13/0/0 | 3cb9124e12 | 🐛 fix(mvp): the timeline's summaries follow the window, so a long conv | apps/mvp/docs/features/timeline.md: main carried then changed it: 5032597657 (🐛 fix(mvp): |
| 2026-10-21 02:59 | `c578bb3b75` | SUPERSEDED | 18/13/0/0 | c578bb3b75 | 🐛 fix(mvp): the timeline's summaries follow the window, so a long conv | apps/mvp/docs/features/timeline.md: main carried then changed it: 5032597657 (🐛 fix(mvp): |
| 2026-10-21 03:05 | `837fb903fc` | SUPERSEDED | 22/7/0/0 | c751c7cd0a | 🧪 test(mvp): cover device identities, replay and unavailable reads | apps/mvp/src/boot.test.ts: main carried then changed it: 127a1c32af (test(mvp): finish the |
| 2026-10-21 03:05 | `7fce7af0b9` | SUPERSEDED | 22/7/0/0 | 2eebe05718 | 🧪 test(mvp): cover device identities, replay and unavailable reads | apps/mvp/src/boot.test.ts: main carried then changed it: 127a1c32af (test(mvp): finish the |
| 2026-10-21 03:05 | `f9d5358816` | SUPERSEDED | 22/7/0/0 | 3cb9124e12 | 🧪 test(mvp): cover device identities, replay and unavailable reads | apps/mvp/src/boot.test.ts: main carried then changed it: 127a1c32af (test(mvp): finish the |
| 2026-10-21 03:05 | `840605b3d5` | SUPERSEDED | 4/2/0/0 | e1095b962f | 🐛 fix(mvp): the todo run's agent runs its cells in QuickJS on workerd | apps/mvp/worker/AgentSandbox.ts: main carried then changed it: ccc71a0b2c (✨ feat(ci): pla |
| 2026-10-21 03:05 | `79d25147a7` | SUPERSEDED | 20/10/0/0 | 60fd111680 | 🧪 test(mvp): cover device identities, replay and unavailable reads | apps/mvp/src/boot.test.ts: main carried then changed it: 127a1c32af (test(mvp): finish the |
| 2026-10-21 03:08 | `a376c051eb` | ON-MAIN | 1/0/0/0 | c751c7cd0a | 🧪 test(mvp): scope navigation to the repository main header |  |
| 2026-10-21 03:08 | `864a649b19` | ON-MAIN | 1/0/0/0 | c751c7cd0a | 🧪 test(mvp): require notification counts in the bell name |  |
| 2026-10-21 03:08 | `c53ffc7a29` | ON-MAIN | 1/0/0/0 | 2eebe05718 | 🧪 test(mvp): scope navigation to the repository main header |  |
| 2026-10-21 03:08 | `d1af5829c1` | ON-MAIN | 1/0/0/0 | 2eebe05718 | 🧪 test(mvp): require notification counts in the bell name |  |
| 2026-10-21 03:08 | `0be6f06451` | ON-MAIN | 1/0/0/0 | 3cb9124e12 | 🧪 test(mvp): scope navigation to the repository main header |  |
| 2026-10-21 03:08 | `0241f5025b` | ON-MAIN | 1/0/0/0 | 3cb9124e12 | 🧪 test(mvp): require notification counts in the bell name |  |
| 2026-10-21 03:08 | `b193895188` | ON-MAIN | 1/0/0/0 | 60fd111680 | 🧪 test(mvp): scope navigation to the repository main header |  |
| 2026-10-21 03:08 | `2955fe61d1` | ON-MAIN | 1/0/0/0 | 60fd111680 | 🧪 test(mvp): require notification counts in the bell name |  |
| 2026-10-21 03:09 | `6f950c35a8` | ON-MAIN | 2/0/0/0 | c751c7cd0a | 🧪 test(mvp): seed the late joiner through the real chat API |  |
| 2026-10-21 03:09 | `7294fb0a36` | ON-MAIN | 2/0/0/0 | 2eebe05718 | 🧪 test(mvp): seed the late joiner through the real chat API |  |
| 2026-10-21 03:09 | `85075c7d3c` | ON-MAIN | 2/0/0/0 | 3cb9124e12 | 🧪 test(mvp): seed the late joiner through the real chat API |  |
| 2026-10-21 03:09 | `dc0b473cde` | SUPERSEDED | 0/2/0/0 | 60fd111680 | 🧪 test(mvp): seed the late joiner through the real chat API | apps/mvp/e2e/local-first.spec.ts: landed as 8b46e8f763 (same author and time, committed la |
| 2026-10-21 03:11 | `eb64a472c9` | SUPERSEDED | 0/1/0/0 | efb69411db | ♻️ refactor(mvp): inject the flow registry as an Effect service | apps/mvp/src/flows/registry.ts: changed later in its stack (head efb69411db, 65e5c1587b, 5 |
| 2026-10-21 03:11 | `99ceee795e` | SUPERSEDED | 0/1/0/0 | e7c2dfa26f | ♻️ refactor(mvp): inject the flow registry as an Effect service | apps/mvp/src/flows/registry.ts: changed later in its stack (head e7c2dfa26f, a5b0da83bb, 7 |
| 2026-10-21 03:11 | `07e9b02fb2` | SUPERSEDED | 0/1/0/0 | c751c7cd0a | ♻️ refactor(mvp): inject the flow registry as an Effect service | apps/mvp/src/flows/registry.ts: changed later in its stack (head c751c7cd0a, a3b4795f09, 9 |
| 2026-10-21 03:11 | `dc0268bd0a` | SUPERSEDED | 35/3/0/0 | c751c7cd0a | ♻️ refactor(mvp): inject the flow registry as an Effect service | apps/mvp/src/flows/catalog.ts: main carried then changed it: 63bc4f07fc (🐛 fix(mvp): descr |
| 2026-10-21 03:11 | `af025d57cd` | SUPERSEDED | 35/3/0/0 | 2eebe05718 | ♻️ refactor(mvp): inject the flow registry as an Effect service | apps/mvp/src/flows/catalog.ts: main carried then changed it: 63bc4f07fc (🐛 fix(mvp): descr |
| 2026-10-21 03:11 | `2abcd8e00a` | SUPERSEDED | 35/3/0/0 | 3cb9124e12 | ♻️ refactor(mvp): inject the flow registry as an Effect service | apps/mvp/src/flows/catalog.ts: main carried then changed it: 63bc4f07fc (🐛 fix(mvp): descr |
| 2026-10-21 03:11 | `60fd111680` | SUPERSEDED | 35/3/0/0 | 60fd111680 | ♻️ refactor(mvp): inject the flow registry as an Effect service | apps/mvp/src/flows/catalog.ts: main carried then changed it: 63bc4f07fc (🐛 fix(mvp): descr |
| 2026-10-21 03:19 | `21fc0a8f36` | PARTIAL | 8/5/103/25 | 3a4c9409b0 | ✨ feat(mvp): repository docs in panes, and the agent's docs/search (AG | .changeset/ui-page-pane.md: Adds `PagePane`, the web pages' pane on its own: a bar that na |
| 2026-10-21 03:19 | `59ba2d81fd` | PARTIAL | 8/5/102/26 | f9da52c50b | ✨ feat(mvp): repository docs in panes, and the agent's docs/search (AG | .changeset/ui-page-pane.md: Adds `PagePane`, the web pages' pane on its own: a bar that na |
| 2026-10-21 03:19 | `672708aeb6` | PARTIAL | 8/5/103/25 | b582dd6f9e | ✨ feat(mvp): repository docs in panes, and the agent's docs/search (AG | .changeset/ui-page-pane.md: Adds `PagePane`, the web pages' pane on its own: a bar that na |
| 2026-10-21 03:19 | `d6910807e1` | PARTIAL | 8/5/102/26 | 531bfc5f56 | ✨ feat(mvp): repository docs in panes, and the agent's docs/search (AG | .changeset/ui-page-pane.md: Adds `PagePane`, the web pages' pane on its own: a bar that na |
| 2026-10-21 03:19 | `e440665ffd` | PARTIAL | 8/5/103/25 | f10019f8ed | ✨ feat(mvp): repository docs in panes, and the agent's docs/search (AG | .changeset/ui-page-pane.md: Adds `PagePane`, the web pages' pane on its own: a bar that na |
| 2026-10-21 03:19 | `8ff7502c91` | PARTIAL | 8/5/103/25 | 9282a98a77 | ✨ feat(mvp): repository docs in panes, and the agent's docs/search (AG | .changeset/ui-page-pane.md: Adds `PagePane`, the web pages' pane on its own: a bar that na |
| 2026-10-21 03:19 | `99e0ec3f1b` | PARTIAL | 8/5/102/26 | 8aa8312ce6 | ✨ feat(mvp): repository docs in panes, and the agent's docs/search (AG | .changeset/ui-page-pane.md: Adds `PagePane`, the web pages' pane on its own: a bar that na |
| 2026-10-21 03:19 | `5f5f1675d9` | PARTIAL | 8/5/103/25 | 3cb9124e12 | ✨ feat(mvp): repository docs in panes, and the agent's docs/search (AG | .changeset/ui-page-pane.md: Adds `PagePane`, the web pages' pane on its own: a bar that na |
| 2026-10-21 03:19 | `969bb85025` | PARTIAL | 16/4/104/25 | 8d07068639 | ✨ feat(mvp): repository docs in panes, and the agent's docs/search (AG | .changeset/ui-page-pane.md: Adds `PagePane`, the web pages' pane on its own: a bar that na |
| 2026-10-21 03:20 | `129200d3db` | SUPERSEDED | 62/26/0/0 | e1095b962f | ✨ feat(mvp): the pull request pages are back, with GH-9's deploy warni | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 03:20 | `1cb5344e2c` | SUPERSEDED | 61/27/0/0 | 1cb5344e2c | ✨ feat(mvp): the pull request pages are back, with GH-9's deploy warni | apps/mvp/db/Database.ts: landed as 2ae1b8c5d6 (same author and time, committed later) |
| 2026-10-21 03:21 | `4e6e9d00f0` | PARTIAL | 70/45/0/1 | e1095b962f | ✨ feat(mvp): a running TODO blinks, links to its run, and its run is w | apps/mvp/docs/decisions/0024-watching-a-todo-run.md: 5. **No acts on a run on Cloudflare.* |
| 2026-10-21 03:21 | `ac7801a9c8` | PARTIAL | 78/44/0/1 | d88d0cf0df | ✨ feat(mvp): a running TODO blinks, links to its run, and its run is w | apps/mvp/docs/decisions/0024-watching-a-todo-run.md: 5. **No acts on a run on Cloudflare.* |
| 2026-10-21 03:32 | `4a4351adef` | SUPERSEDED | 6/3/0/0 | e1095b962f | ✨ feat(mvp): the coding factory runs TODOs, proven live to a mergeable | apps/mvp/docs/features/todos.md: main carried then changed it: d12b9cc772 (✅ test(mvp): th |
| 2026-10-21 03:33 | `97db750c13` | SUPERSEDED | 58/20/0/0 | b471b5956a | 🐛 fix(mvp): a device's data is its owner's, kept through the upgrade a | apps/mvp/docs/features/sign-in.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): |
| 2026-10-21 03:33 | `29b4ce4166` | SUPERSEDED | 58/20/0/0 | 29b4ce4166 | 🐛 fix(mvp): a device's data is its owner's, kept through the upgrade a | apps/mvp/docs/features/sign-in.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): |
| 2026-10-21 03:33 | `5f7174e85a` | SUPERSEDED | 75/24/0/0 | 5f7174e85a | 🐛 fix(mvp): a device's data is its owner's, kept through the upgrade a | apps/mvp/docs/features/sign-in.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): |
| 2026-10-21 03:33 | `86723e22ad` | PARTIAL | 28/34/5/1 | 86723e22ad | 🐛 fix(mvp): a device's data is its owner's, kept through the upgrade a | .changeset/browser-runtime-authorize.md: Adds `BrowserRuntime.run({ authorize })`: a check |
| 2026-10-21 03:34 | `8ba2696d25` | SUPERSEDED | 7/1/0/0 | c751c7cd0a | ♻️ refactor(engine-store): PlanScheduler as scheduler and run records  | packages/smithers/flows/engine-store/src/PlanScheduler.ts: landed as 82a2afc74c (same auth |
| 2026-10-21 03:34 | `e45fec440b` | ON-MAIN | 4/0/0/0 | c751c7cd0a | ♻️ refactor(engine-store): the run driver as one state record and name |  |
| 2026-10-21 03:34 | `9211fb252c` | SUPERSEDED | 7/1/0/0 | 2eebe05718 | ♻️ refactor(engine-store): PlanScheduler as scheduler and run records  | packages/smithers/flows/engine-store/src/PlanScheduler.ts: landed as 82a2afc74c (same auth |
| 2026-10-21 03:34 | `5fd65d6929` | ON-MAIN | 4/0/0/0 | 2eebe05718 | ♻️ refactor(engine-store): the run driver as one state record and name |  |
| 2026-10-21 03:34 | `53c6fe32f5` | SUPERSEDED | 7/1/0/0 | 3cb9124e12 | ♻️ refactor(engine-store): PlanScheduler as scheduler and run records  | packages/smithers/flows/engine-store/src/PlanScheduler.ts: landed as 82a2afc74c (same auth |
| 2026-10-21 03:34 | `3a1878e539` | ON-MAIN | 4/0/0/0 | 3cb9124e12 | ♻️ refactor(engine-store): the run driver as one state record and name |  |
| 2026-10-21 03:34 | `fdd2d50622` | SUPERSEDED | 7/1/0/0 | b5737baf44 | ♻️ refactor(engine-store): PlanScheduler as scheduler and run records  | packages/smithers/flows/engine-store/src/PlanScheduler.ts: landed as 82a2afc74c (same auth |
| 2026-10-21 03:34 | `8923842a05` | ON-MAIN | 4/0/0/0 | b5737baf44 | ♻️ refactor(engine-store): the run driver as one state record and name |  |
| 2026-10-21 03:47 | `8c2d8673c9` | ON-MAIN | 1/0/0/0 | c751c7cd0a | 🔧 chore(release): re-record the public API baseline for round 4c/4d |  |
| 2026-10-21 03:47 | `12cb847137` | ON-MAIN | 1/0/0/0 | 2eebe05718 | 🔧 chore(release): re-record the public API baseline for round 4c/4d |  |
| 2026-10-21 03:47 | `0c9b9b03f1` | ON-MAIN | 1/0/0/0 | 3cb9124e12 | 🔧 chore(release): re-record the public API baseline for round 4c/4d |  |
| 2026-10-21 03:47 | `590eeb2677` | SUPERSEDED | 8/15/0/0 | 08c498f459 | 🔧 chore(release): re-record the public API baseline for round 4c/4d | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: d |
| 2026-10-21 04:00 | `3ddd7436f4` | SUPERSEDED | 39/5/0/0 | c751c7cd0a | ♻️ refactor(engine-store): durable engine state as named operations ov | packages/smithers/flows/engine-store/src/DurableEngineState.ts: main carried then changed |
| 2026-10-21 04:00 | `39b3b30eea` | ON-MAIN | 3/0/0/0 | c751c7cd0a | ♻️ refactor(engine-store): ActionPersistence dispatch as a Dispatch re |  |
| 2026-10-21 04:00 | `ea8eacc3f4` | SUPERSEDED | 39/5/0/0 | 2eebe05718 | ♻️ refactor(engine-store): durable engine state as named operations ov | packages/smithers/flows/engine-store/src/DurableEngineState.ts: main carried then changed |
| 2026-10-21 04:00 | `a579bb2b39` | ON-MAIN | 3/0/0/0 | 2eebe05718 | ♻️ refactor(engine-store): ActionPersistence dispatch as a Dispatch re |  |
| 2026-10-21 04:00 | `02a73c6464` | SUPERSEDED | 39/5/0/0 | 3cb9124e12 | ♻️ refactor(engine-store): durable engine state as named operations ov | packages/smithers/flows/engine-store/src/DurableEngineState.ts: main carried then changed |
| 2026-10-21 04:00 | `ce566e8257` | ON-MAIN | 3/0/0/0 | 3cb9124e12 | ♻️ refactor(engine-store): ActionPersistence dispatch as a Dispatch re |  |
| 2026-10-21 04:00 | `e9d764e171` | SUPERSEDED | 39/5/0/0 | b5737baf44 | ♻️ refactor(engine-store): durable engine state as named operations ov | packages/smithers/flows/engine-store/src/DurableEngineState.ts: main carried then changed |
| 2026-10-21 04:00 | `d7cad69982` | ON-MAIN | 3/0/0/0 | b5737baf44 | ♻️ refactor(engine-store): ActionPersistence dispatch as a Dispatch re |  |
| 2026-10-21 04:04 | `de4524a770` | ON-MAIN | 13/0/0/0 | c751c7cd0a | 🐛 fix(maintainer-site): show queue code at its recorded commit |  |
| 2026-10-21 04:04 | `0ce489fa8d` | ON-MAIN | 13/0/0/0 | 2eebe05718 | 🐛 fix(maintainer-site): show queue code at its recorded commit |  |
| 2026-10-21 04:04 | `72101a8ca7` | ON-MAIN | 13/0/0/0 | 3cb9124e12 | 🐛 fix(maintainer-site): show queue code at its recorded commit |  |
| 2026-10-21 04:04 | `08c498f459` | ON-MAIN | 13/0/0/0 | 08c498f459 | 🐛 fix(maintainer-site): show queue code at its recorded commit |  |
| 2026-10-21 04:26 | `5a1a70ecae` | EMPTY-ISH | 0/0/0/0 | c751c7cd0a | 🔧 chore: lockfiles and the target index for the post-deploy round |  |
| 2026-10-21 04:26 | `cd02e6e3a6` | EMPTY-ISH | 0/0/0/0 | 2eebe05718 | 🔧 chore: lockfiles and the target index for the post-deploy round |  |
| 2026-10-21 04:26 | `6c7acb994b` | EMPTY-ISH | 0/0/0/0 | 3cb9124e12 | 🔧 chore: lockfiles and the target index for the post-deploy round |  |
| 2026-10-21 04:29 | `d689766762` | ON-MAIN | 1/0/0/0 | c751c7cd0a | ♻️ refactor(engine-store): the engine store's composition as a record  |  |
| 2026-10-21 04:29 | `a71e738b7d` | ON-MAIN | 1/0/0/0 | 2eebe05718 | ♻️ refactor(engine-store): the engine store's composition as a record  |  |
| 2026-10-21 04:29 | `9970752d32` | ON-MAIN | 1/0/0/0 | 3cb9124e12 | ♻️ refactor(engine-store): the engine store's composition as a record  |  |
| 2026-10-21 04:29 | `b5737baf44` | ON-MAIN | 1/0/0/0 | b5737baf44 | ♻️ refactor(engine-store): the engine store's composition as a record  |  |
| 2026-10-21 05:27 | `fd326b01ed` | SUPERSEDED | 10/1/0/0 | e1095b962f | 🐛 fix(gateway): a planned step reads Queued until it can start | packages/smithers/gateway/test/InspectionJournal.test.ts: main carried then changed it: 89 |
| 2026-10-21 05:27 | `af7c0dbaf0` | SUPERSEDED | 10/1/0/0 | d88d0cf0df | 🐛 fix(gateway): a planned step reads Queued until it can start | packages/smithers/gateway/test/InspectionJournal.test.ts: main carried then changed it: 89 |
| 2026-10-21 05:34 | `e1095b962f` | SUPERSEDED | 3/4/0/0 | e1095b962f | ✅ test(mvp): the coding factory's whole loop, recorded live with chapt | apps/mvp/docs/features/todos.md: main carried then changed it: 5772fdbffb (🐛 fix(mvp): a T |
| 2026-10-21 07:21 | `3c8e63e100` | SUPERSEDED | 23/15/0/0 | 31778ff498 | ♻️ refactor(fs): @smthrs/fs compiles with VibeLang 0.0.3 (D281, D282) | packages/smithers/agent/fs/package.json: main carried then changed it: 39ccbd83d1 (⬆️ chor |
| 2026-10-21 07:21 | `281f5a8ba8` | SUPERSEDED | 23/15/0/0 | d048301dfc | ♻️ refactor(fs): @smthrs/fs compiles with VibeLang 0.0.3 (D281, D282) | packages/smithers/agent/fs/package.json: main carried then changed it: 39ccbd83d1 (⬆️ chor |
| 2026-10-21 09:41 | `e98419b928` | PARTIAL | 4323/89/356/58 | e98419b928 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `40d9433e74` | PARTIAL | 377/166/261/5079 | 40d9433e74 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `133177b7ce` | PARTIAL | 377/166/261/5079 | 133177b7ce |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `df9aecf75d` | PARTIAL | 354/159/262/5207 | df9aecf75d |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `702ffac454` | PARTIAL | 352/152/263/5212 | 702ffac454 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `f50eeed6be` | PARTIAL | 352/147/263/5217 | f50eeed6be |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `7759ae184b` | PARTIAL | 350/140/262/5221 | 7759ae184b |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `8f2dc27a08` | PARTIAL | 416/134/264/5161 | 8f2dc27a08 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `d74d3c69ef` | PARTIAL | 414/133/264/5157 | d74d3c69ef |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `9aa491a333` | PARTIAL | 414/131/264/5159 | 9aa491a333 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `d00a00804b` | PARTIAL | 414/127/264/5164 | d00a00804b |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `8902f02f40` | PARTIAL | 410/127/264/5165 | 8902f02f40 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `aa5882d7a8` | PARTIAL | 404/117/264/5176 | aa5882d7a8 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `869eaba965` | PARTIAL | 402/112/264/5183 | 869eaba965 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `871bacc02d` | PARTIAL | 327/280/261/5161 | 871bacc02d |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:41 | `c349c7bdf4` | PARTIAL | 327/280/261/5161 | c349c7bdf4 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "internal/NodeControlHost.d.ts" |
| 2026-10-21 09:49 | `1b038435cd` | PARTIAL | 0/1/72/0 | 3a4c9409b0 | 🐛 fix(test): reuse Vitest module cache to stop SSR temp leaks | apps/mvp/docs/work/ssr-temp-cache-leak.md: Vitest 5 fork workers write transformed modules |
| 2026-10-21 09:49 | `df152a598a` | PARTIAL | 0/1/72/0 | f9da52c50b | 🐛 fix(test): reuse Vitest module cache to stop SSR temp leaks | apps/mvp/docs/work/ssr-temp-cache-leak.md: Vitest 5 fork workers write transformed modules |
| 2026-10-21 09:49 | `baa22829d6` | PARTIAL | 0/1/72/0 | b582dd6f9e | 🐛 fix(test): reuse Vitest module cache to stop SSR temp leaks | apps/mvp/docs/work/ssr-temp-cache-leak.md: Vitest 5 fork workers write transformed modules |
| 2026-10-21 09:49 | `59ae8d8605` | PARTIAL | 0/1/72/0 | 531bfc5f56 | 🐛 fix(test): reuse Vitest module cache to stop SSR temp leaks | apps/mvp/docs/work/ssr-temp-cache-leak.md: Vitest 5 fork workers write transformed modules |
| 2026-10-21 09:49 | `beb091119d` | PARTIAL | 0/1/72/0 | f10019f8ed | 🐛 fix(test): reuse Vitest module cache to stop SSR temp leaks | apps/mvp/docs/work/ssr-temp-cache-leak.md: Vitest 5 fork workers write transformed modules |
| 2026-10-21 09:49 | `5f04a4ef17` | PARTIAL | 0/1/72/0 | 9282a98a77 | 🐛 fix(test): reuse Vitest module cache to stop SSR temp leaks | apps/mvp/docs/work/ssr-temp-cache-leak.md: Vitest 5 fork workers write transformed modules |
| 2026-10-21 09:49 | `01d6ebe39a` | PARTIAL | 0/1/72/0 | 8aa8312ce6 | 🐛 fix(test): reuse Vitest module cache to stop SSR temp leaks | apps/mvp/docs/work/ssr-temp-cache-leak.md: Vitest 5 fork workers write transformed modules |
| 2026-10-21 09:49 | `c9a9c8cfb4` | PARTIAL | 0/1/72/0 | 3cb9124e12 | 🐛 fix(test): reuse Vitest module cache to stop SSR temp leaks | apps/mvp/docs/work/ssr-temp-cache-leak.md: Vitest 5 fork workers write transformed modules |
| 2026-10-21 09:49 | `bfcc6c1a3d` | SUPERSEDED | 52/10/0/0 | bfcc6c1a3d | fix(flows): install the engine's schema behind Hyperdrive, name a fail | apps/mvp/worker/github/Api.test.ts: main carried then changed it: 44658afdf0 (🐛 fix(github |
| 2026-10-21 09:49 | `e9f6d1e89e` | SUPERSEDED | 52/10/0/0 | e9f6d1e89e | fix(flows): install the engine's schema behind Hyperdrive, name a fail | apps/mvp/worker/github/Api.test.ts: main carried then changed it: 44658afdf0 (🐛 fix(github |
| 2026-10-21 09:49 | `512f6e1ad3` | SUPERSEDED | 52/10/0/0 | 512f6e1ad3 |  | apps/mvp/worker/github/Api.test.ts: main carried then changed it: 44658afdf0 (🐛 fix(github |
| 2026-10-21 09:49 | `d39f412ec2` | PARTIAL | 0/1/72/0 | d39f412ec2 | 🐛 fix(test): reuse Vitest module cache to stop SSR temp leaks | apps/mvp/docs/work/ssr-temp-cache-leak.md: Vitest 5 fork workers write transformed modules |
| 2026-10-21 09:53 | `776d74d1af` | SUPERSEDED | 10/17/0/0 | efb69411db | 🔧 chore(release): re-record the public API baseline and the target ind | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: d |
| 2026-10-21 09:53 | `1134db185c` | SUPERSEDED | 10/14/0/0 | f9da52c50b | 🔧 chore(release): re-record the public API baseline for the post-deplo | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: d |
| 2026-10-21 09:53 | `47c86ba1c2` | SUPERSEDED | 0/5/0/0 | e7c2dfa26f | 🔧 chore(release): re-record the public API baseline and the target ind | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: f |
| 2026-10-21 09:53 | `acca192e76` | SUPERSEDED | 10/14/0/0 | e7c2dfa26f | 🔧 chore(release): re-record the public API baseline for the post-deplo | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: d |
| 2026-10-21 09:53 | `606f28104f` | SUPERSEDED | 10/17/0/0 | f10019f8ed | 🔧 chore(release): re-record the public API baseline and the target ind | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: d |
| 2026-10-21 09:53 | `ac7ae8c968` | SUPERSEDED | 0/5/0/0 | c751c7cd0a | 🔧 chore(release): re-record the public API baseline and the target ind | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: f |
| 2026-10-21 09:53 | `eb2106eef2` | SUPERSEDED | 10/14/0/0 | c751c7cd0a | 🔧 chore(release): re-record the public API baseline for the post-deplo | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: d |
| 2026-10-21 09:53 | `871d8e9578` | SUPERSEDED | 10/17/0/0 | 5f627a1f24 | 🔧 chore(release): re-record the public API baseline and the target ind | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: d |
| 2026-10-21 09:53 | `b7055a5876` | SUPERSEDED | 10/17/0/0 | 2eebe05718 | 🔧 chore(release): re-record the public API baseline and the target ind | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: d |
| 2026-10-21 09:53 | `3fff3d4a0b` | SUPERSEDED | 10/17/0/0 | 3cb9124e12 | 🔧 chore(release): re-record the public API baseline and the target ind | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: d |
| 2026-10-21 10:04 | `30ecd3194b` | ON-MAIN | 30/0/0/0 | b008dcea7c | ✨ feat(harness,agent,notifications): a flow host steers the agent acti |  |
| 2026-10-21 10:04 | `b62d3ee5e7` | SUPERSEDED | 48/4/0/0 | b8a380c99d | ✨ feat(harness,agent,notifications): a flow host steers the agent acti | apps/site/public/llms-full.txt: main carried then changed it: 83534f8619 (🐛 fix(sandbox): |
| 2026-10-21 10:09 | `f867cd0a18` | PARTIAL | 25/5/2/0 | 354a880329 | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| Export |
| 2026-10-21 10:09 | `42cd79ba6f` | PARTIAL | 25/5/2/0 | e16546f509 | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `698985f2c6` | PARTIAL | 24/5/2/0 | dcd3dc5fb7 | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `fe51d4eff1` | PARTIAL | 24/5/2/0 | 3a4c9409b0 | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `27d396568b` | PARTIAL | 24/5/2/0 | f9da52c50b | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `40e62d8f42` | PARTIAL | 24/5/2/0 | b582dd6f9e | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `e174823fe1` | PARTIAL | 24/5/2/0 | 531bfc5f56 | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `2a8b9f4adb` | PARTIAL | 24/5/2/0 | f10019f8ed | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `61f7b387a7` | PARTIAL | 24/5/2/0 | 9282a98a77 | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `55f02df675` | PARTIAL | 24/5/2/0 | 8aa8312ce6 | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `cf54bb2fd6` | PARTIAL | 24/5/2/0 | 3cb9124e12 | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:09 | `757aa2e27d` | PARTIAL | 24/5/2/0 | 5adf377d7d | 🐛 fix(sdk): the outbox's leader asks the lock instead of a 100 ms time | apps/site/public/llms-full.txt: \| `WebLock.WebLock`, `make(locks)`, `layer` |
| 2026-10-21 10:19 | `271c36df06` | SUPERSEDED | 45/6/0/0 | 31778ff498 | ✨ feat(errors): @smthrs/errors is written in VibeLang | packages/errors/PACKAGE.ts: main carried then changed it: 7943033fa2 (🔧 chore(check): ever |
| 2026-10-21 10:19 | `0ff0677ca2` | SUPERSEDED | 45/6/0/0 | d048301dfc | ✨ feat(errors): @smthrs/errors is written in VibeLang | packages/errors/PACKAGE.ts: main carried then changed it: 7943033fa2 (🔧 chore(check): ever |
| 2026-10-21 10:21 | `e913a140f9` | SUPERSEDED | 133/13/0/0 | 31778ff498 | 🔧 chore(check): every package type-checks with vibelang | apps/app/package.json: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app |
| 2026-10-21 10:21 | `edf5450144` | SUPERSEDED | 133/13/0/0 | d048301dfc | 🔧 chore(check): every package type-checks with vibelang | apps/app/package.json: main deleted it in 82b5490dbe (🔥 chore(repo): remove the legacy app |
| 2026-10-21 10:24 | `e32daf153b` | PARTIAL | 0/4/12/0 | 3a4c9409b0 | 📚 fix(docs): use VibeLang published llms.txt source | apps/mvp/docs/work/docs-panes-and-search.md: updated: 2026-10-21 11:50 PDT; apps/mvp/e2e/d |
| 2026-10-21 10:24 | `8443ebe64a` | PARTIAL | 0/4/12/0 | f9da52c50b | 📚 fix(docs): use VibeLang published llms.txt source | apps/mvp/docs/work/docs-panes-and-search.md: updated: 2026-10-21 11:50 PDT; apps/mvp/e2e/d |
| 2026-10-21 10:24 | `25955130d8` | PARTIAL | 0/4/12/0 | b582dd6f9e | 📚 fix(docs): use VibeLang published llms.txt source | apps/mvp/docs/work/docs-panes-and-search.md: updated: 2026-10-21 11:50 PDT; apps/mvp/e2e/d |
| 2026-10-21 10:24 | `e367e099e1` | PARTIAL | 0/4/12/0 | 531bfc5f56 | 📚 fix(docs): use VibeLang published llms.txt source | apps/mvp/docs/work/docs-panes-and-search.md: updated: 2026-10-21 11:50 PDT; apps/mvp/e2e/d |
| 2026-10-21 10:24 | `7732522257` | PARTIAL | 0/4/12/0 | f10019f8ed | 📚 fix(docs): use VibeLang published llms.txt source | apps/mvp/docs/work/docs-panes-and-search.md: updated: 2026-10-21 11:50 PDT; apps/mvp/e2e/d |
| 2026-10-21 10:24 | `7be51336c5` | PARTIAL | 0/4/12/0 | 9282a98a77 | 📚 fix(docs): use VibeLang published llms.txt source | apps/mvp/docs/work/docs-panes-and-search.md: updated: 2026-10-21 11:50 PDT; apps/mvp/e2e/d |
| 2026-10-21 10:24 | `487a595d2e` | PARTIAL | 0/4/12/0 | 8aa8312ce6 | 📚 fix(docs): use VibeLang published llms.txt source | apps/mvp/docs/work/docs-panes-and-search.md: updated: 2026-10-21 11:50 PDT; apps/mvp/e2e/d |
| 2026-10-21 10:24 | `6abcf673e1` | PARTIAL | 0/4/12/0 | 3cb9124e12 | 📚 fix(docs): use VibeLang published llms.txt source | apps/mvp/docs/work/docs-panes-and-search.md: updated: 2026-10-21 11:50 PDT; apps/mvp/e2e/d |
| 2026-10-21 10:24 | `a7846fa5b8` | PARTIAL | 0/4/12/0 | 8d07068639 | 📚 fix(docs): use VibeLang published llms.txt source | apps/mvp/docs/work/docs-panes-and-search.md: updated: 2026-10-21 11:50 PDT; apps/mvp/e2e/d |
| 2026-10-21 10:26 | `76cf5ba86c` | SUPERSEDED | 74/13/0/0 | 31778ff498 | 🔧 chore(build): builds and bundlers compile VibeLang sources | .smithers/flows/release/pack-release.test.mjs: main carried then changed it: aee175c412 (🧪 |
| 2026-10-21 10:26 | `4176382d76` | SUPERSEDED | 74/13/0/0 | d048301dfc | 🔧 chore(build): builds and bundlers compile VibeLang sources | .smithers/flows/release/pack-release.test.mjs: main carried then changed it: aee175c412 (🧪 |
| 2026-10-21 10:30 | `988016f16b` | SUPERSEDED | 7/5/0/0 | cdb1160df9 | ✅ test(mvp): remote flows on the deployment, each proven by its own re | apps/mvp/docs/features/remote-flows.md: main carried then changed it: 5fbe4a56e8 (✅ test(m |
| 2026-10-21 10:31 | `cae7772992` | PARTIAL | 4/0/32/0 | 3a4c9409b0 | 🧹 fix(docs): read VibeLang docs from its home declaration | .changeset/docs-home-url-string.md: Accept an absolute HTTPS URL string in a repository ho |
| 2026-10-21 10:31 | `52f1d1b819` | PARTIAL | 4/0/32/0 | f9da52c50b | 🧹 fix(docs): read VibeLang docs from its home declaration | .changeset/docs-home-url-string.md: Accept an absolute HTTPS URL string in a repository ho |
| 2026-10-21 10:31 | `41763c8566` | PARTIAL | 4/0/32/0 | b582dd6f9e | 🧹 fix(docs): read VibeLang docs from its home declaration | .changeset/docs-home-url-string.md: Accept an absolute HTTPS URL string in a repository ho |
| 2026-10-21 10:31 | `9ea0cc9ff4` | PARTIAL | 121/67/0/1 | 31778ff498 | 🔧 chore(vitest): every test runner loads VibeLang sources | evals/docs/bunfig.toml: [test]; .smithers/flows/package.json: main carried then changed it |
| 2026-10-21 10:31 | `5cda0ba2e5` | PARTIAL | 4/0/32/0 | 531bfc5f56 | 🧹 fix(docs): read VibeLang docs from its home declaration | .changeset/docs-home-url-string.md: Accept an absolute HTTPS URL string in a repository ho |
| 2026-10-21 10:31 | `a7eeab3fa7` | PARTIAL | 4/0/32/0 | f10019f8ed | 🧹 fix(docs): read VibeLang docs from its home declaration | .changeset/docs-home-url-string.md: Accept an absolute HTTPS URL string in a repository ho |
| 2026-10-21 10:31 | `da6856f124` | PARTIAL | 4/0/32/0 | 9282a98a77 | 🧹 fix(docs): read VibeLang docs from its home declaration | .changeset/docs-home-url-string.md: Accept an absolute HTTPS URL string in a repository ho |
| 2026-10-21 10:31 | `f036a0d940` | PARTIAL | 4/0/32/0 | 8aa8312ce6 | 🧹 fix(docs): read VibeLang docs from its home declaration | .changeset/docs-home-url-string.md: Accept an absolute HTTPS URL string in a repository ho |
| 2026-10-21 10:31 | `b1e75204be` | PARTIAL | 4/0/32/0 | 3cb9124e12 | 🧹 fix(docs): read VibeLang docs from its home declaration | .changeset/docs-home-url-string.md: Accept an absolute HTTPS URL string in a repository ho |
| 2026-10-21 10:31 | `8d07068639` | PARTIAL | 4/0/32/0 | 8d07068639 | 🧹 fix(docs): read VibeLang docs from its home declaration | .changeset/docs-home-url-string.md: Accept an absolute HTTPS URL string in a repository ho |
| 2026-10-21 10:31 | `8280044476` | PARTIAL | 121/67/0/1 | d048301dfc | 🔧 chore(vitest): every test runner loads VibeLang sources | evals/docs/bunfig.toml: [test]; .smithers/flows/package.json: main carried then changed it |
| 2026-10-21 10:32 | `15809bf8f9` | ON-MAIN | 1/0/0/0 | cdb1160df9 | 📝 docs(mvp): the prod-flows work note: what breaks each remote flow in |  |
| 2026-10-21 10:33 | `1def44bf9b` | SUPERSEDED | 42/2/0/0 | 31778ff498 | 🔧 chore(build-cli): Node programs load VibeLang source through one loa | .agents/skills/smithers-maintenance/SKILL.md: main carried then changed it: 9662836059 (🐛 |
| 2026-10-21 10:33 | `9601233734` | SUPERSEDED | 42/2/0/0 | d048301dfc | 🔧 chore(build-cli): Node programs load VibeLang source through one loa | .agents/skills/smithers-maintenance/SKILL.md: main carried then changed it: 9662836059 (🐛 |
| 2026-10-21 10:34 | `97ebac1846` | SUPERSEDED | 187/2/0/0 | 31778ff498 | 🔧 chore(repo-targets): source scanners read .vibe as they read .ts | packages/repo-targets/README.md: main carried then changed it: 3b734cb691 (🧹 fix(lint): en |
| 2026-10-21 10:34 | `0c5c9bffc1` | SUPERSEDED | 187/2/0/0 | d048301dfc | 🔧 chore(repo-targets): source scanners read .vibe as they read .ts | packages/repo-targets/README.md: main carried then changed it: 3b734cb691 (🧹 fix(lint): en |
| 2026-10-21 10:35 | `91ca11e9a1` | ON-MAIN | 4/0/0/0 | cdb1160df9 | 🧪 test(mvp): the sign-out revocation test signs out as the device's pe |  |
| 2026-10-21 10:36 | `99b39baadc` | SUPERSEDED | 77/25/0/0 | b008dcea7c | ✨ feat(mvp): a Member steers a TODO's working agent from its run (TODO | apps/mvp/docs/decisions/0026-watching-a-todo-run.md: main carried then changed it: e3c8b6e |
| 2026-10-21 10:36 | `7c9dc7431f` | PARTIAL | 76/24/0/1 | 7fd6439ba8 | ✨ feat(mvp): a Member steers a TODO's working agent from its run (TODO | apps/mvp/worker/ChatApi.ts: +    // read of it, from the engine's schema, and its row of t |
| 2026-10-21 10:36 | `56f3a57321` | PARTIAL | 77/23/1/0 | b752bc330e | ✨ feat(mvp): a Member steers a TODO's working agent from its run (TODO | apps/mvp/worker/ChatApi.ts: // read of it, from the engine's schema, and its row of the en |
| 2026-10-21 10:36 | `613bfc81b3` | PARTIAL | 77/24/1/0 | b8a380c99d | ✨ feat(mvp): a Member steers a TODO's working agent from its run (TODO | apps/mvp/worker/ChatApi.ts: // read of it, from the engine's schema, and its row of the en |
| 2026-10-21 10:37 | `e5dc72621c` | ON-MAIN | 1/0/0/0 | b8a380c99d | ✅ test(mvp): steer a TODO's working agent on a live instance, and its  |  |
| 2026-10-21 10:37 | `c192af2459` | ON-MAIN | 1/0/0/0 | b008dcea7c | ✅ test(mvp): steer a TODO's working agent on a live instance, and its  |  |
| 2026-10-21 10:37 | `22ed031b67` | ON-MAIN | 1/0/0/0 | 7fd6439ba8 | ✅ test(mvp): steer a TODO's working agent on a live instance, and its  |  |
| 2026-10-21 10:37 | `b752bc330e` | STRANDED | 0/0/25/0 | b752bc330e |  | apps/mvp/e2e/agent.spec.ts: -  test.skip(!local, remoteReason); apps/mvp/e2e/answer-orderi |
| 2026-10-21 10:37 | `bcdbf28808` | ON-MAIN | 1/0/0/0 | b752bc330e | ✅ test(mvp): steer a TODO's working agent on a live instance, and its  |  |
| 2026-10-21 10:37 | `25dff651a6` | STRANDED | 0/0/26/0 | 25dff651a6 |  | apps/mvp/e2e/agent.spec.ts: -  test.skip(!local, remoteReason); apps/mvp/e2e/answer-orderi |
| 2026-10-21 10:37 | `1ae9704269` | ON-MAIN | 1/0/0/0 | 25dff651a6 | ✅ test(mvp): steer a TODO's working agent on a live instance, and its  |  |
| 2026-10-21 10:42 | `a3821ea4ef` | SUPERSEDED | 62/17/0/0 | 6817e4ecbd | 🔒 test(mvp): a deployment run asks only in its own conversation, and n | apps/mvp/e2e/agent.spec.ts: main carried then changed it: e660ee9e2d (🧪 test(mvp): run dep |
| 2026-10-21 10:52 | `c808637829` | SUPERSEDED | 19/6/0/0 | cdb1160df9 | 🐛 fix(mvp): a repository's About panel recovers from a moment's 503 wi | apps/mvp/docs/features/repo.md: main carried then changed it: bcbd38225a (fix(mvp): show a |
| 2026-10-21 10:52 | `2822599579` | ON-MAIN | 3/0/0/0 | cdb1160df9 | ✅ test(mvp): Astra's review of the remote-flow e2e: the sync test wait |  |
| 2026-10-21 10:55 | `6775bb8614` | ON-MAIN | 2/0/0/0 | cdb1160df9 | ✅ test(mvp): a TODO runs on the deployment to an open pull request, an |  |
| 2026-10-21 10:56 | `93ba48a3d5` | PARTIAL | 41/4/3/1 | f0fcc1f28a | 🐛 fix(mvp): a session check ChatApi couldn't answer asks again, as the | apps/mvp/docs/features/flows.md: The execution id is minted once per dispatch unless the c |
| 2026-10-21 10:56 | `b88ccd3267` | PARTIAL | 41/4/3/1 | 7b12317475 | 🐛 fix(mvp): a session check ChatApi couldn't answer asks again, as the | apps/mvp/docs/features/flows.md: The execution id is minted once per dispatch unless the c |
| 2026-10-21 10:56 | `6dab428213` | PARTIAL | 41/4/3/1 | 44ae9f7030 | 🐛 fix(mvp): a session check ChatApi couldn't answer asks again, as the | apps/mvp/docs/features/flows.md: The execution id is minted once per dispatch unless the c |
| 2026-10-21 10:56 | `d9acae8787` | STRANDED | 0/0/1/0 | 3a4c9409b0 | 🐛 fix(mvp): drop a branch machine's command records after a day | apps/mvp/docs/features/sandbox-tools.md: -- **At most once:** a command's fence, exit and |
| 2026-10-21 10:56 | `9acf13206c` | STRANDED | 0/0/1/0 | b582dd6f9e | 🐛 fix(mvp): drop a branch machine's command records after a day | apps/mvp/docs/features/sandbox-tools.md: -- **At most once:** a command's fence, exit and |
| 2026-10-21 10:56 | `5fe95931f5` | STRANDED | 0/0/1/0 | 9282a98a77 | 🐛 fix(mvp): drop a branch machine's command records after a day | apps/mvp/docs/features/sandbox-tools.md: -- **At most once:** a command's fence, exit and |
| 2026-10-21 10:56 | `8205ba2636` | PARTIAL | 38/4/5/3 | cadf086bce | 🐛 fix(mvp): a session check ChatApi couldn't answer asks again, as the | apps/mvp/docs/features/flows.md: The execution id is minted once per dispatch unless the c |
| 2026-10-21 10:56 | `402d0c3661` | SUPERSEDED | 27/4/0/0 | 402d0c3661 |  | apps/site/public/llms-full.txt: main carried then changed it: 83534f8619 (🐛 fix(sandbox): |
| 2026-10-21 10:56 | `4d35803d1f` | PARTIAL | 18/4/0/1 | 4d35803d1f |  | apps/mvp/e2e/sandbox-lifecycle.spec.ts: `cat t-${word}.txt after.txt; echo log-$(cat runs- |
| 2026-10-21 11:01 | `bbf6b5b14d` | STRANDED | 0/0/11/0 | 3a4c9409b0 | 📝 docs(mvp): bring the app's docs up to the rulings | .gitignore: # The app's open-work list is a tracked doc that other docs link to.; apps/mvp |
| 2026-10-21 11:01 | `dfa8543630` | STRANDED | 0/0/11/0 | f9da52c50b | 📝 docs(mvp): bring the app's docs up to the rulings | .gitignore: # The app's open-work list is a tracked doc that other docs link to.; apps/mvp |
| 2026-10-21 11:01 | `9ed0b6076e` | STRANDED | 0/0/11/0 | b582dd6f9e | 📝 docs(mvp): bring the app's docs up to the rulings | .gitignore: # The app's open-work list is a tracked doc that other docs link to.; apps/mvp |
| 2026-10-21 11:01 | `059d02c88a` | STRANDED | 0/0/11/0 | 531bfc5f56 | 📝 docs(mvp): bring the app's docs up to the rulings | .gitignore: # The app's open-work list is a tracked doc that other docs link to.; apps/mvp |
| 2026-10-21 11:01 | `31d2562139` | STRANDED | 0/0/11/0 | f10019f8ed | 📝 docs(mvp): bring the app's docs up to the rulings | .gitignore: # The app's open-work list is a tracked doc that other docs link to.; apps/mvp |
| 2026-10-21 11:01 | `7284174c30` | STRANDED | 0/0/11/0 | 9282a98a77 | 📝 docs(mvp): bring the app's docs up to the rulings | .gitignore: # The app's open-work list is a tracked doc that other docs link to.; apps/mvp |
| 2026-10-21 11:01 | `034afa6bf0` | STRANDED | 0/0/11/0 | 8aa8312ce6 | 📝 docs(mvp): bring the app's docs up to the rulings | .gitignore: # The app's open-work list is a tracked doc that other docs link to.; apps/mvp |
| 2026-10-21 11:01 | `edd392b6a4` | STRANDED | 0/0/11/0 | 3cb9124e12 | 📝 docs(mvp): bring the app's docs up to the rulings | .gitignore: # The app's open-work list is a tracked doc that other docs link to.; apps/mvp |
| 2026-10-21 11:01 | `f4f77c09aa` | STRANDED | 0/0/11/0 | df5ede0070 | 📝 docs(mvp): bring the app's docs up to the rulings | .gitignore: # The app's open-work list is a tracked doc that other docs link to.; apps/mvp |
| 2026-10-21 11:02 | `0d2938e7df` | SUPERSEDED | 8891/60/0/0 | 0d2938e7df | 🔥 chore(repo): remove the legacy app, its Worker and the Go backend | .github/workflows/ci.yml: main carried then changed it: e15cac4f2a (🧹 chore(ci): retire th |
| 2026-10-21 11:02 | `d053c51c14` | SUPERSEDED | 8891/60/0/0 | d053c51c14 | 🔥 chore(repo): remove the legacy app, its Worker and the Go backend | .github/workflows/ci.yml: main carried then changed it: e15cac4f2a (🧹 chore(ci): retire th |
| 2026-10-21 11:02 | `2012389cac` | SUPERSEDED | 8893/60/0/0 | b541e7346c | 🔥 chore(repo): remove the legacy app, its Worker and the Go backend | .github/workflows/ci.yml: main carried then changed it: e15cac4f2a (🧹 chore(ci): retire th |
| 2026-10-21 11:02 | `f2496d1ee8` | SUPERSEDED | 8890/61/0/0 | e045d2151d | 🔥 chore(repo): remove the legacy app, its Worker and the Go backend | .github/workflows/ci.yml: main carried then changed it: e15cac4f2a (🧹 chore(ci): retire th |
| 2026-10-21 11:02 | `e4453b6d10` | SUPERSEDED | 8891/60/0/0 | e4453b6d10 | 🔥 chore(repo): remove the legacy app, its Worker and the Go backend | .github/workflows/ci.yml: main carried then changed it: e15cac4f2a (🧹 chore(ci): retire th |
| 2026-10-21 11:02 | `01dde7d4f9` | SUPERSEDED | 8891/60/0/0 | 01dde7d4f9 | 🔥 chore(repo): remove the legacy app, its Worker and the Go backend | .github/workflows/ci.yml: main carried then changed it: e15cac4f2a (🧹 chore(ci): retire th |
| 2026-10-21 11:02 | `f88f24cd65` | SUPERSEDED | 8891/60/0/0 | f88f24cd65 |  | .github/workflows/ci.yml: main carried then changed it: e15cac4f2a (🧹 chore(ci): retire th |
| 2026-10-21 11:05 | `458cc7509e` | SUPERSEDED | 6/1/0/0 | efb69411db | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `88f2c12690` | ON-MAIN | 1/0/0/0 | efb69411db | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `9df3874aa7` | SUPERSEDED | 6/1/0/0 | 3a4c9409b0 | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `474f61bb09` | ON-MAIN | 1/0/0/0 | 3a4c9409b0 | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `5c2d1337f1` | SUPERSEDED | 6/1/0/0 | f9da52c50b | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `d7a6b7f84c` | ON-MAIN | 1/0/0/0 | f9da52c50b | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `05166ac8b8` | SUPERSEDED | 6/1/0/0 | a5b0da83bb | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `a852e54fa7` | ON-MAIN | 1/0/0/0 | a5b0da83bb | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `c625d928b9` | SUPERSEDED | 6/1/0/0 | b582dd6f9e | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `fb2daad9aa` | ON-MAIN | 1/0/0/0 | b582dd6f9e | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `a1cde3a5df` | SUPERSEDED | 6/1/0/0 | 531bfc5f56 | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `e6c7a801fc` | ON-MAIN | 1/0/0/0 | 531bfc5f56 | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `6b07bdaec1` | SUPERSEDED | 6/1/0/0 | f10019f8ed | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `49484f4817` | ON-MAIN | 1/0/0/0 | f10019f8ed | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `8e2141f579` | SUPERSEDED | 6/1/0/0 | c751c7cd0a | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `7bd9fcfe9b` | ON-MAIN | 1/0/0/0 | c751c7cd0a | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `51996e2295` | SUPERSEDED | 6/1/0/0 | 9282a98a77 | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `1a7e6bd591` | ON-MAIN | 1/0/0/0 | 9282a98a77 | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `4cbc6aae61` | SUPERSEDED | 6/1/0/0 | 8aa8312ce6 | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `7a116400a1` | ON-MAIN | 1/0/0/0 | 8aa8312ce6 | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `e74f85ed1b` | SUPERSEDED | 6/1/0/0 | 3cb9124e12 | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `9b5aa1a316` | ON-MAIN | 1/0/0/0 | 3cb9124e12 | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:05 | `567f6dba61` | SUPERSEDED | 6/1/0/0 | 5cb08384b1 | ✨ feat(flow): Action.once writes to another service once per dispatch  | packages/smithers/flows/flow/docs/reference/flow.md: main carried then changed it: 01460b1 |
| 2026-10-21 11:05 | `f3b240c8b4` | ON-MAIN | 1/0/0/0 | 5cb08384b1 | 📝 docs(mvp): the durable external effects proposal: one identity per w |  |
| 2026-10-21 11:06 | `f0c744272d` | STRANDED | 0/0/6/0 | 3a4c9409b0 | 📝 docs(repo): landing, contributing and the plugin spec line match the | .specs/product/overview.md: \| Plugins \| M-55: everything is a plugin ([decision 0017](.. |
| 2026-10-21 11:06 | `bf2c554cfc` | STRANDED | 0/0/1/0 | 3a4c9409b0 | docs(mvp): record the engine-schema deploy and the QuickJS blocker tha | apps/mvp/docs/work/land-and-deploy-mvp.md: Evidence: deploy log `r5-deploy-1.log`, the Wor |
| 2026-10-21 11:06 | `e35029d47e` | STRANDED | 0/0/6/0 | f9da52c50b | 📝 docs(repo): landing, contributing and the plugin spec line match the | .specs/product/overview.md: \| Plugins \| M-55: everything is a plugin ([decision 0017](.. |
| 2026-10-21 11:06 | `66635a3847` | STRANDED | 0/0/1/0 | f9da52c50b | docs(mvp): record the engine-schema deploy and the QuickJS blocker tha | apps/mvp/docs/work/land-and-deploy-mvp.md: Evidence: deploy log `r5-deploy-1.log`, the Wor |
| 2026-10-21 11:06 | `4d3b35e0f4` | STRANDED | 0/0/6/0 | b582dd6f9e | 📝 docs(repo): landing, contributing and the plugin spec line match the | .specs/product/overview.md: \| Plugins \| M-55: everything is a plugin ([decision 0017](.. |
| 2026-10-21 11:06 | `a712c830d7` | STRANDED | 0/0/1/0 | b582dd6f9e | docs(mvp): record the engine-schema deploy and the QuickJS blocker tha | apps/mvp/docs/work/land-and-deploy-mvp.md: Evidence: deploy log `r5-deploy-1.log`, the Wor |
| 2026-10-21 11:06 | `b4e2bb4103` | STRANDED | 0/0/6/0 | 531bfc5f56 | 📝 docs(repo): landing, contributing and the plugin spec line match the | .specs/product/overview.md: \| Plugins \| M-55: everything is a plugin ([decision 0017](.. |
| 2026-10-21 11:06 | `d5e7e8443a` | STRANDED | 0/0/1/0 | 531bfc5f56 | docs(mvp): record the engine-schema deploy and the QuickJS blocker tha | apps/mvp/docs/work/land-and-deploy-mvp.md: Evidence: deploy log `r5-deploy-1.log`, the Wor |
| 2026-10-21 11:06 | `cf994c522d` | STRANDED | 0/0/6/0 | f10019f8ed | 📝 docs(repo): landing, contributing and the plugin spec line match the | .specs/product/overview.md: \| Plugins \| M-55: everything is a plugin ([decision 0017](.. |
| 2026-10-21 11:06 | `897209f999` | STRANDED | 0/0/1/0 | f10019f8ed | docs(mvp): record the engine-schema deploy and the QuickJS blocker tha | apps/mvp/docs/work/land-and-deploy-mvp.md: Evidence: deploy log `r5-deploy-1.log`, the Wor |
| 2026-10-21 11:06 | `d3b924c717` | STRANDED | 0/0/6/0 | 9282a98a77 | 📝 docs(repo): landing, contributing and the plugin spec line match the | .specs/product/overview.md: \| Plugins \| M-55: everything is a plugin ([decision 0017](.. |
| 2026-10-21 11:06 | `53eabbcf28` | STRANDED | 0/0/1/0 | 9282a98a77 | docs(mvp): record the engine-schema deploy and the QuickJS blocker tha | apps/mvp/docs/work/land-and-deploy-mvp.md: Evidence: deploy log `r5-deploy-1.log`, the Wor |
| 2026-10-21 11:06 | `a906385740` | STRANDED | 0/0/6/0 | 8aa8312ce6 | 📝 docs(repo): landing, contributing and the plugin spec line match the | .specs/product/overview.md: \| Plugins \| M-55: everything is a plugin ([decision 0017](.. |
| 2026-10-21 11:06 | `a2670e26dc` | STRANDED | 0/0/1/0 | 8aa8312ce6 | docs(mvp): record the engine-schema deploy and the QuickJS blocker tha | apps/mvp/docs/work/land-and-deploy-mvp.md: Evidence: deploy log `r5-deploy-1.log`, the Wor |
| 2026-10-21 11:06 | `b2002896e3` | STRANDED | 0/0/6/0 | 3cb9124e12 | 📝 docs(repo): landing, contributing and the plugin spec line match the | .specs/product/overview.md: \| Plugins \| M-55: everything is a plugin ([decision 0017](.. |
| 2026-10-21 11:06 | `965810162f` | STRANDED | 0/0/1/0 | 3cb9124e12 | docs(mvp): record the engine-schema deploy and the QuickJS blocker tha | apps/mvp/docs/work/land-and-deploy-mvp.md: Evidence: deploy log `r5-deploy-1.log`, the Wor |
| 2026-10-21 11:06 | `2f0f54d843` | STRANDED | 0/0/1/0 | 467e1e0ece | docs(mvp): record the engine-schema deploy and the QuickJS blocker tha | apps/mvp/docs/work/land-and-deploy-mvp.md: Evidence: deploy log `r5-deploy-1.log`, the Wor |
| 2026-10-21 11:06 | `3f02584d05` | STRANDED | 0/0/6/0 | df5ede0070 | 📝 docs(repo): landing, contributing and the plugin spec line match the | .specs/product/overview.md: \| Plugins \| M-55: everything is a plugin ([decision 0017](.. |
| 2026-10-21 11:07 | `c8193637a1` | STRANDED | 0/0/6/0 | 3a4c9409b0 | 📝 docs(history): label the old MVP records as history and point them a | .specs/product/mvp.md: \| M-55 (Will, 2026-10-20 14:40; rulings PLUGIN-1, PLUGIN-2, PLUGIN |
| 2026-10-21 11:07 | `c8e42c8fb0` | PARTIAL | 0/0/1/1 | 3a4c9409b0 | 📝 docs(maintainer-site): say what the maintainer app is now, and where | apps/maintainer-site/README.md: It is the tool we dogfood, not the product. Its review que |
| 2026-10-21 11:07 | `ee64a6d44f` | STRANDED | 0/0/6/0 | f9da52c50b | 📝 docs(history): label the old MVP records as history and point them a | .specs/product/mvp.md: \| M-55 (Will, 2026-10-20 14:40; rulings PLUGIN-1, PLUGIN-2, PLUGIN |
| 2026-10-21 11:07 | `6b2942fc2c` | STRANDED | 0/0/2/0 | f9da52c50b | 📝 docs(maintainer-site): say what the maintainer app is now, and where | apps/maintainer-site/README.md: It is the tool we dogfood, not the product. Its review que |
| 2026-10-21 11:07 | `e3f7792b41` | STRANDED | 0/0/6/0 | b582dd6f9e | 📝 docs(history): label the old MVP records as history and point them a | .specs/product/mvp.md: \| M-55 (Will, 2026-10-20 14:40; rulings PLUGIN-1, PLUGIN-2, PLUGIN |
| 2026-10-21 11:07 | `da2762e1ea` | PARTIAL | 0/0/1/1 | b582dd6f9e | 📝 docs(maintainer-site): say what the maintainer app is now, and where | apps/maintainer-site/README.md: It is the tool we dogfood, not the product. Its review que |
| 2026-10-21 11:07 | `9a215b0bb1` | STRANDED | 0/0/6/0 | 531bfc5f56 | 📝 docs(history): label the old MVP records as history and point them a | .specs/product/mvp.md: \| M-55 (Will, 2026-10-20 14:40; rulings PLUGIN-1, PLUGIN-2, PLUGIN |
| 2026-10-21 11:07 | `57ad0712fb` | STRANDED | 0/0/2/0 | 531bfc5f56 | 📝 docs(maintainer-site): say what the maintainer app is now, and where | apps/maintainer-site/README.md: It is the tool we dogfood, not the product. Its review que |
| 2026-10-21 11:07 | `3d1e95a070` | STRANDED | 0/0/6/0 | f10019f8ed | 📝 docs(history): label the old MVP records as history and point them a | .specs/product/mvp.md: \| M-55 (Will, 2026-10-20 14:40; rulings PLUGIN-1, PLUGIN-2, PLUGIN |
| 2026-10-21 11:07 | `a39b61a707` | STRANDED | 0/0/2/0 | f10019f8ed | 📝 docs(maintainer-site): say what the maintainer app is now, and where | apps/maintainer-site/README.md: It is the tool we dogfood, not the product. Its review que |
| 2026-10-21 11:07 | `06c111e409` | STRANDED | 0/0/6/0 | 9282a98a77 | 📝 docs(history): label the old MVP records as history and point them a | .specs/product/mvp.md: \| M-55 (Will, 2026-10-20 14:40; rulings PLUGIN-1, PLUGIN-2, PLUGIN |
| 2026-10-21 11:07 | `bbe5f3def5` | PARTIAL | 0/0/1/1 | 9282a98a77 | 📝 docs(maintainer-site): say what the maintainer app is now, and where | apps/maintainer-site/README.md: It is the tool we dogfood, not the product. Its review que |
| 2026-10-21 11:07 | `187b949022` | STRANDED | 0/0/6/0 | 8aa8312ce6 | 📝 docs(history): label the old MVP records as history and point them a | .specs/product/mvp.md: \| M-55 (Will, 2026-10-20 14:40; rulings PLUGIN-1, PLUGIN-2, PLUGIN |
| 2026-10-21 11:07 | `cc0e03ff47` | STRANDED | 0/0/2/0 | 8aa8312ce6 | 📝 docs(maintainer-site): say what the maintainer app is now, and where | apps/maintainer-site/README.md: It is the tool we dogfood, not the product. Its review que |
| 2026-10-21 11:07 | `c906cbe685` | STRANDED | 0/0/6/0 | 3cb9124e12 | 📝 docs(history): label the old MVP records as history and point them a | .specs/product/mvp.md: \| M-55 (Will, 2026-10-20 14:40; rulings PLUGIN-1, PLUGIN-2, PLUGIN |
| 2026-10-21 11:07 | `934ab11978` | STRANDED | 0/0/2/0 | 3cb9124e12 | 📝 docs(maintainer-site): say what the maintainer app is now, and where | apps/maintainer-site/README.md: It is the tool we dogfood, not the product. Its review que |
| 2026-10-21 11:07 | `0aad65275f` | STRANDED | 0/0/6/0 | df5ede0070 | 📝 docs(history): label the old MVP records as history and point them a | .specs/product/mvp.md: \| M-55 (Will, 2026-10-20 14:40; rulings PLUGIN-1, PLUGIN-2, PLUGIN |
| 2026-10-21 11:07 | `b3f2eb8ba4` | STRANDED | 0/0/2/0 | df5ede0070 | 📝 docs(maintainer-site): say what the maintainer app is now, and where | apps/maintainer-site/README.md: It is the tool we dogfood, not the product. Its review que |
| 2026-10-21 11:08 | `2849ce9cec` | PARTIAL | 0/1/1/0 | 3a4c9409b0 | 📝 docs(apps): mark the old app's design spec and the old edge's upstre | apps/DESIGN.md: > History: the August 2026 design spec of the old app (`apps/app`), kept a |
| 2026-10-21 11:08 | `ad8a0ff5b2` | PARTIAL | 0/1/1/0 | f9da52c50b | 📝 docs(apps): mark the old app's design spec and the old edge's upstre | apps/DESIGN.md: > History: the August 2026 design spec of the old app (`apps/app`), kept a |
| 2026-10-21 11:08 | `f4d21133d4` | PARTIAL | 0/1/1/0 | b582dd6f9e | 📝 docs(apps): mark the old app's design spec and the old edge's upstre | apps/DESIGN.md: > History: the August 2026 design spec of the old app (`apps/app`), kept a |
| 2026-10-21 11:08 | `c69aa6080f` | PARTIAL | 0/1/1/0 | 531bfc5f56 | 📝 docs(apps): mark the old app's design spec and the old edge's upstre | apps/DESIGN.md: > History: the August 2026 design spec of the old app (`apps/app`), kept a |
| 2026-10-21 11:08 | `8ee5f6af45` | PARTIAL | 0/1/1/0 | f10019f8ed | 📝 docs(apps): mark the old app's design spec and the old edge's upstre | apps/DESIGN.md: > History: the August 2026 design spec of the old app (`apps/app`), kept a |
| 2026-10-21 11:08 | `33364b071b` | PARTIAL | 0/1/1/0 | 9282a98a77 | 📝 docs(apps): mark the old app's design spec and the old edge's upstre | apps/DESIGN.md: > History: the August 2026 design spec of the old app (`apps/app`), kept a |
| 2026-10-21 11:08 | `e799793e01` | PARTIAL | 0/1/1/0 | 8aa8312ce6 | 📝 docs(apps): mark the old app's design spec and the old edge's upstre | apps/DESIGN.md: > History: the August 2026 design spec of the old app (`apps/app`), kept a |
| 2026-10-21 11:08 | `a26c59648e` | PARTIAL | 0/1/1/0 | 3cb9124e12 | 📝 docs(apps): mark the old app's design spec and the old edge's upstre | apps/DESIGN.md: > History: the August 2026 design spec of the old app (`apps/app`), kept a |
| 2026-10-21 11:08 | `33d12ea774` | PARTIAL | 0/1/1/0 | df5ede0070 | 📝 docs(apps): mark the old app's design spec and the old edge's upstre | apps/DESIGN.md: > History: the August 2026 design spec of the old app (`apps/app`), kept a |
| 2026-10-21 11:12 | `d800510c9f` | SUPERSEDED | 52/10/0/0 | 354a880329 | 🐛 fix(sdk): one tab per device stores what a synced collection syncs,  | apps/mvp/docs/observability.md: main carried then changed it: 127885af31 (🔇 fix(effect-tan |
| 2026-10-21 11:12 | `43eb2d5a53` | SUPERSEDED | 52/10/0/0 | e16546f509 | 🐛 fix(sdk): one tab per device stores what a synced collection syncs,  | apps/mvp/docs/observability.md: main carried then changed it: 127885af31 (🔇 fix(effect-tan |
| 2026-10-21 11:12 | `9df20305da` | SUPERSEDED | 51/11/0/0 | dcd3dc5fb7 | 🐛 fix(sdk): one tab per device stores what a synced collection syncs,  | apps/mvp/docs/observability.md: main carried then changed it: 127885af31 (🔇 fix(effect-tan |
| 2026-10-21 11:12 | `01138e06b0` | SUPERSEDED | 52/10/0/0 | c558742b0f | 🐛 fix(sdk): one tab per device stores what a synced collection syncs,  | apps/mvp/docs/observability.md: main carried then changed it: 127885af31 (🔇 fix(effect-tan |
| 2026-10-21 11:12 | `5eacfed79e` | SUPERSEDED | 52/10/0/0 | 5adf377d7d | 🐛 fix(sdk): one tab per device stores what a synced collection syncs,  | apps/mvp/docs/observability.md: main carried then changed it: 127885af31 (🔇 fix(effect-tan |
| 2026-10-21 11:16 | `a9f1e58331` | ON-MAIN | 1/0/0/0 | efb69411db | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `3457de04f9` | ON-MAIN | 1/0/0/0 | 3a4c9409b0 | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `e4a0187187` | ON-MAIN | 1/0/0/0 | f9da52c50b | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `474a9cb9ca` | ON-MAIN | 1/0/0/0 | a5b0da83bb | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `9357dcb132` | ON-MAIN | 1/0/0/0 | b582dd6f9e | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `c17b9acd52` | ON-MAIN | 1/0/0/0 | 531bfc5f56 | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `ed93afabbc` | ON-MAIN | 1/0/0/0 | f10019f8ed | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `0532349010` | ON-MAIN | 1/0/0/0 | c751c7cd0a | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `eedffedddb` | ON-MAIN | 1/0/0/0 | 9282a98a77 | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `23312fe069` | ON-MAIN | 1/0/0/0 | 8aa8312ce6 | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `42b8843317` | ON-MAIN | 1/0/0/0 | 3cb9124e12 | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:16 | `a290d8a6a5` | ON-MAIN | 1/0/0/0 | 5cb08384b1 | ✅ test(engine-store): Action.once survives a crash before the write, a |  |
| 2026-10-21 11:21 | `2424df2ae6` | ON-MAIN | 1/0/0/0 | a2cc4468ea | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `df90b771e2` | ON-MAIN | 1/0/0/0 | 43007b0fd8 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `8f2a167ca7` | ON-MAIN | 1/0/0/0 | 4a47b426e6 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `210d4d75c7` | ON-MAIN | 1/0/0/0 | 32e5a252c9 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `1a61767c27` | ON-MAIN | 1/0/0/0 | 08d0af64a1 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `e26cd2b480` | ON-MAIN | 1/0/0/0 | 17e2945bbf | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `9137b8eefb` | ON-MAIN | 1/0/0/0 | fa5176b235 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `72497d0838` | ON-MAIN | 1/0/0/0 | 3bfa24b71f | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `57d2753a69` | ON-MAIN | 1/0/0/0 | b81df565e1 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `25a6365cbf` | ON-MAIN | 1/0/0/0 | f9da52c50b | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `8dae2d95c0` | ON-MAIN | 1/0/0/0 | b008dcea7c | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `461723b8e2` | ON-MAIN | 1/0/0/0 | 531bfc5f56 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `2f357c0453` | ON-MAIN | 1/0/0/0 | f10019f8ed | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `576353b1b7` | ON-MAIN | 1/0/0/0 | 8aa8312ce6 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `d9054951db` | ON-MAIN | 1/0/0/0 | aec510490c | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `95c7f567e6` | ON-MAIN | 1/0/0/0 | 6a94dc267e | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `6af739c83b` | ON-MAIN | 1/0/0/0 | 2eebe05718 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:21 | `727a5985c5` | ON-MAIN | 1/0/0/0 | 3cb9124e12 | 📝 docs(mvp): the dogfood loop's map: what blocks Smithers building Smi |  |
| 2026-10-21 11:24 | `7b21b5e8d2` | SUPERSEDED | 36/10/0/0 | a2cc4468ea | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `cf286e6299` | SUPERSEDED | 36/10/0/0 | 43007b0fd8 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `4d851c176b` | SUPERSEDED | 36/10/0/0 | 4a47b426e6 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `ad598d13b5` | SUPERSEDED | 36/10/0/0 | 32e5a252c9 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `1eb54d6765` | SUPERSEDED | 36/10/0/0 | 08d0af64a1 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `4687103614` | SUPERSEDED | 36/10/0/0 | 17e2945bbf | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `39e152f980` | SUPERSEDED | 36/10/0/0 | fa5176b235 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `df1d430798` | SUPERSEDED | 36/10/0/0 | 3bfa24b71f | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `07fc5e450a` | SUPERSEDED | 36/10/0/0 | b81df565e1 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `3a9e1ad439` | SUPERSEDED | 35/10/0/0 | f9da52c50b | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `3aeb582a08` | SUPERSEDED | 36/10/0/0 | b008dcea7c | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `7ba307d5e4` | SUPERSEDED | 35/10/0/0 | 531bfc5f56 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `84f09f3828` | SUPERSEDED | 35/10/0/0 | f10019f8ed | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `493265441a` | SUPERSEDED | 35/10/0/0 | 8aa8312ce6 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `f1f9c971b3` | SUPERSEDED | 36/10/0/0 | aec510490c | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `6fb102e551` | SUPERSEDED | 36/10/0/0 | 6a94dc267e | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `d642b6b4ab` | SUPERSEDED | 35/10/0/0 | 2eebe05718 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:24 | `c6bd26edcf` | SUPERSEDED | 35/10/0/0 | 3cb9124e12 | ✨ feat(integrations,mvp): Smithers checks report write-only smithers/< | apps/mvp/docs/features/pulls.md: main carried then changed it: d20a698bbe (📝 docs(mvp): Pu |
| 2026-10-21 11:25 | `c108eef1aa` | SUPERSEDED | 22/3/0/0 | efb69411db | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `7e7101e6fc` | SUPERSEDED | 22/3/0/0 | 3a4c9409b0 | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `f9da52c50b` | SUPERSEDED | 22/3/0/0 | f9da52c50b | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `6a35379bbb` | SUPERSEDED | 22/3/0/0 | a5b0da83bb | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `305db47cf2` | SUPERSEDED | 22/3/0/0 | b582dd6f9e | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `f070758144` | SUPERSEDED | 22/3/0/0 | dd12f89340 | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `531bfc5f56` | SUPERSEDED | 22/3/0/0 | 531bfc5f56 | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `f10019f8ed` | SUPERSEDED | 22/3/0/0 | f10019f8ed | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `a184463a93` | SUPERSEDED | 22/3/0/0 | c751c7cd0a | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `8758122f8d` | SUPERSEDED | 22/3/0/0 | 9282a98a77 | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `8aa8312ce6` | SUPERSEDED | 22/3/0/0 | 8aa8312ce6 | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `3cb9124e12` | SUPERSEDED | 22/3/0/0 | 3cb9124e12 | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:25 | `fbe3ce992d` | SUPERSEDED | 22/3/0/0 | 5cb08384b1 | ✨ feat(integrations): GitHub.Once writes a branch, commit, pull reques | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 11:30 | `3a4c9409b0` | STRANDED | 0/0/1/0 | 3a4c9409b0 | 📝 docs(work): record the 2026-10-21 docs truth pass | apps/mvp/docs/work/docs-truth-pass.md: owner: docs-truth agent (Claude Opus), started by t |
| 2026-10-21 11:30 | `1c6b08c5b2` | STRANDED | 0/0/1/0 | f9da52c50b | 📝 docs(work): record the 2026-10-21 docs truth pass | apps/mvp/docs/work/docs-truth-pass.md: owner: docs-truth agent (Claude Opus), started by t |
| 2026-10-21 11:30 | `b582dd6f9e` | STRANDED | 0/0/1/0 | b582dd6f9e | 📝 docs(work): record the 2026-10-21 docs truth pass | apps/mvp/docs/work/docs-truth-pass.md: owner: docs-truth agent (Claude Opus), started by t |
| 2026-10-21 11:30 | `e60a346d03` | STRANDED | 0/0/1/0 | 531bfc5f56 | 📝 docs(work): record the 2026-10-21 docs truth pass | apps/mvp/docs/work/docs-truth-pass.md: owner: docs-truth agent (Claude Opus), started by t |
| 2026-10-21 11:30 | `82bce526e9` | STRANDED | 0/0/1/0 | f10019f8ed | 📝 docs(work): record the 2026-10-21 docs truth pass | apps/mvp/docs/work/docs-truth-pass.md: owner: docs-truth agent (Claude Opus), started by t |
| 2026-10-21 11:30 | `9282a98a77` | STRANDED | 0/0/1/0 | 9282a98a77 | 📝 docs(work): record the 2026-10-21 docs truth pass | apps/mvp/docs/work/docs-truth-pass.md: owner: docs-truth agent (Claude Opus), started by t |
| 2026-10-21 11:30 | `5eb5bea4fe` | STRANDED | 0/0/1/0 | 8aa8312ce6 | 📝 docs(work): record the 2026-10-21 docs truth pass | apps/mvp/docs/work/docs-truth-pass.md: owner: docs-truth agent (Claude Opus), started by t |
| 2026-10-21 11:30 | `3e883f25f2` | STRANDED | 0/0/1/0 | 3cb9124e12 | 📝 docs(work): record the 2026-10-21 docs truth pass | apps/mvp/docs/work/docs-truth-pass.md: owner: docs-truth agent (Claude Opus), started by t |
| 2026-10-21 11:30 | `df5ede0070` | STRANDED | 0/0/1/0 | df5ede0070 | 📝 docs(work): record the 2026-10-21 docs truth pass | apps/mvp/docs/work/docs-truth-pass.md: owner: docs-truth agent (Claude Opus), started by t |
| 2026-10-21 11:34 | `1855167b08` | ON-MAIN | 3/0/0/0 | 6817e4ecbd | ✅ test(mvp): the factory spec declares its needs and runs on the store |  |
| 2026-10-21 11:36 | `8da626160e` | SUPERSEDED | 15/7/0/0 | c751c7cd0a | 🐛 fix(mvp): preserve wipe failures and start activation after prefligh | apps/mvp/docs/decisions/0025-startup-wipe-and-telemetry.md: main carried then changed it: |
| 2026-10-21 11:36 | `b64e5ce025` | SUPERSEDED | 15/7/0/0 | 2eebe05718 | 🐛 fix(mvp): preserve wipe failures and start activation after prefligh | apps/mvp/docs/decisions/0025-startup-wipe-and-telemetry.md: main carried then changed it: |
| 2026-10-21 11:36 | `d7e650d344` | SUPERSEDED | 15/7/0/0 | d7e650d344 | 🐛 fix(mvp): preserve wipe failures and start activation after prefligh | apps/mvp/docs/decisions/0025-startup-wipe-and-telemetry.md: main carried then changed it: |
| 2026-10-21 11:38 | `55364b3114` | SUPERSEDED | 24/2/0/0 | 2eebe05718 | 🐛 fix(agent): bound answer exchanges and release terminal progress | apps/mvp/src/features/agent/host.ts: main carried then changed it: 5d6c5efc06 (🧠 feat(agen |
| 2026-10-21 11:38 | `17e95ec919` | SUPERSEDED | 24/2/0/0 | 17e95ec919 | 🐛 fix(agent): bound answer exchanges and release terminal progress | apps/mvp/src/features/agent/host.ts: main carried then changed it: 5d6c5efc06 (🧠 feat(agen |
| 2026-10-21 11:40 | `4842248adc` | PARTIAL | 11/6/0/2 | efb69411db | 🐛 fix(mvp): the TODO run finds its own branch, commit and pull request | apps/mvp/worker/flows/Todo.test.ts: +import { Cause, ConfigProvider, Context, Effect, Exit |
| 2026-10-21 11:40 | `f9252ae5e4` | PARTIAL | 11/7/0/1 | 3a4c9409b0 | 🐛 fix(mvp): the TODO run finds its own branch, commit and pull request | apps/mvp/worker/flows/Todo.test.ts: expect(ctx.github.seen("POST", /\/git\/refs$/)).toHave |
| 2026-10-21 11:40 | `a220a34b47` | SUPERSEDED | 11/8/0/0 | ac996be8c8 | 🐛 fix(mvp): the TODO run finds its own branch, commit and pull request | apps/mvp/worker/flows/Todo.test.ts: landed as d598a9baf1 (same author and time, committed |
| 2026-10-21 11:40 | `c8eb871cff` | SUPERSEDED | 11/8/0/0 | a5b0da83bb | 🐛 fix(mvp): the TODO run finds its own branch, commit and pull request | apps/mvp/worker/flows/Todo.test.ts: landed as d598a9baf1 (same author and time, committed |
| 2026-10-21 11:40 | `b24bfa26d0` | SUPERSEDED | 11/8/0/0 | b582dd6f9e | 🐛 fix(mvp): the TODO run finds its own branch, commit and pull request | apps/mvp/worker/flows/Todo.test.ts: main carried then changed it: 890a410e19 (fix(mvp): wa |
| 2026-10-21 11:40 | `c602d2125d` | SUPERSEDED | 11/8/0/0 | dd12f89340 | 🐛 fix(mvp): the TODO run finds its own branch, commit and pull request | apps/mvp/worker/flows/Todo.test.ts: landed as d598a9baf1 (same author and time, committed |
| 2026-10-21 11:40 | `2d2d38025b` | SUPERSEDED | 11/8/0/0 | c751c7cd0a | 🐛 fix(mvp): the TODO run finds its own branch, commit and pull request | apps/mvp/worker/flows/Todo.test.ts: landed as d598a9baf1 (same author and time, committed |
| 2026-10-21 11:40 | `1694393017` | SUPERSEDED | 11/8/0/0 | 9282a98a77 | 🐛 fix(mvp): the TODO run finds its own branch, commit and pull request | apps/mvp/worker/flows/Todo.test.ts: main carried then changed it: 890a410e19 (fix(mvp): wa |
| 2026-10-21 11:40 | `74f34bb43d` | SUPERSEDED | 11/8/0/0 | 5cb08384b1 | 🐛 fix(mvp): the TODO run finds its own branch, commit and pull request | apps/mvp/worker/flows/Todo.test.ts: landed as d598a9baf1 (same author and time, committed |
| 2026-10-21 11:40 | `7ff8144985` | PARTIAL | 27/17/0/1 | 7ff8144985 |  | apps/site/public/llms-full.txt: - **Signature:** `once<A, E, R>(name: string, effect: Keye |
| 2026-10-21 11:41 | `6817e4ecbd` | SUPERSEDED | 0/2/0/0 | 6817e4ecbd | 📝 docs(mvp): the production e2e work note, with the first full run | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: ad64f9e107 (📝 docs(mvp): the |
| 2026-10-21 11:41 | `6797d2ccd2` | ON-MAIN | 1/0/0/0 | 6817e4ecbd | 🐛 test(mvp): the spend guard reads nothing while a deployment run can' |  |
| 2026-10-21 11:47 | `297312e5d7` | ON-MAIN | 4/0/0/0 | 31778ff498 | 🔧 chore: the target index, the llms files and the API baseline for Vib |  |
| 2026-10-21 11:47 | `666c20e88b` | PARTIAL | 9/0/4/0 | d048301dfc | 🔧 chore: the target index, the llms files and the API baseline for Vib | .smithers/flows/release/fixtures/public-api-baseline.json: "NodeControl.d.ts": "29a5ecdd54 |
| 2026-10-21 11:51 | `249db051ad` | PARTIAL | 2/0/0/1 | 62778583ba | ✨ feat(agent): the agent runner contract: backends, jobs, the runner p | packages/smithers/agent/src/AgentRunner.ts: readonly start: (task: Task, key: string, gene |
| 2026-10-21 11:51 | `7e1456b962` | PARTIAL | 2/0/0/1 | cb85ebcf38 | ✨ feat(agent): the agent runner contract: backends, jobs, the runner p | packages/smithers/agent/src/AgentRunner.ts: readonly start: (task: Task, key: string, gene |
| 2026-10-21 11:53 | `391620fd09` | ON-MAIN | 4/0/0/0 | a2cc4468ea | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `2b313e7ec0` | SUPERSEDED | 7/4/0/0 | a2cc4468ea | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `f495b28df4` | ON-MAIN | 4/0/0/0 | 4a47b426e6 | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `231c24668c` | ON-MAIN | 4/0/0/0 | 43007b0fd8 | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `e3f9a47865` | SUPERSEDED | 7/4/0/0 | 43007b0fd8 | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `8e0ef329df` | SUPERSEDED | 7/4/0/0 | 4a47b426e6 | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `c66c5fa8ff` | SUPERSEDED | 7/4/0/0 | 32e5a252c9 | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `72096a8e9d` | SUPERSEDED | 7/4/0/0 | 08d0af64a1 | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `f917acaeef` | SUPERSEDED | 7/4/0/0 | 17e2945bbf | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `7b899bf6f4` | ON-MAIN | 4/0/0/0 | fa5176b235 | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `302a1e8f4e` | SUPERSEDED | 7/4/0/0 | fa5176b235 | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `5d25be05ef` | ON-MAIN | 4/0/0/0 | 182c15c7f8 | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `8ae72037e5` | SUPERSEDED | 7/4/0/0 | 3bfa24b71f | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `1b8fb83d09` | ON-MAIN | 4/0/0/0 | e268a29c73 | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `e357e3ea2c` | ON-MAIN | 4/0/0/0 | b008dcea7c | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `b18ebb3bed` | SUPERSEDED | 7/4/0/0 | b81df565e1 | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `4592ad8639` | ON-MAIN | 4/0/0/0 | f9da52c50b | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `014116cadf` | SUPERSEDED | 7/4/0/0 | b008dcea7c | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `afcdb6a8f7` | ON-MAIN | 4/0/0/0 | e7c2dfa26f | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `1cd9f2d7e6` | ON-MAIN | 4/0/0/0 | f10019f8ed | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `0600216965` | ON-MAIN | 4/0/0/0 | 10816fe72b | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `c76f03e5e5` | ON-MAIN | 4/0/0/0 | c751c7cd0a | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `b286364935` | STRANDED | 0/0/2/0 | 62778583ba | 📝 docs(mvp): decision 0027, which agent does the coding, and its work  | apps/mvp/docs/decisions/0027-coding-agent-backends.md: - The `todo` flow gains a backend s |
| 2026-10-21 11:53 | `2d7d87656c` | SUPERSEDED | 7/4/0/0 | aec510490c | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `6b51469d7a` | SUPERSEDED | 7/4/0/0 | 6a94dc267e | ✨ feat(mvp): Make TODO stays on an open issue while its TODOs are open | apps/mvp/src/features/todos/todos.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix |
| 2026-10-21 11:53 | `7894ca3774` | ON-MAIN | 4/0/0/0 | 2eebe05718 | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `2d4232562c` | ON-MAIN | 4/0/0/0 | 3cb9124e12 | ✅ test(mvp): the factory spec waits on conditions, never a fixed sleep |  |
| 2026-10-21 11:53 | `4794064626` | STRANDED | 0/0/2/0 | 4794064626 | 📝 docs(mvp): decision 0027, which agent does the coding, and its work  | apps/mvp/docs/decisions/0027-coding-agent-backends.md: - The `todo` flow gains a backend s |
| 2026-10-21 11:54 | `1b350c0982` | SUPERSEDED | 0/5/0/0 | 1b350c0982 |  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: f |
| 2026-10-21 11:54 | `37e0698c1d` | SUPERSEDED | 0/5/0/0 | 37e0698c1d |  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: f |
| 2026-10-21 11:54 | `c8f906cd4a` | SUPERSEDED | 0/5/0/0 | c8f906cd4a |  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: f |
| 2026-10-21 12:05 | `03eb0005c6` | STRANDED | 0/0/1/0 | 3a4c9409b0 | docs(mvp): record remote flows running in production after the QuickJS | apps/mvp/docs/work/land-and-deploy-mvp.md: - Still running at 19:01 UTC, none retrying: `c |
| 2026-10-21 12:05 | `e6f94e1995` | STRANDED | 0/0/1/0 | b582dd6f9e | docs(mvp): record remote flows running in production after the QuickJS | apps/mvp/docs/work/land-and-deploy-mvp.md: - Still running at 19:01 UTC, none retrying: `c |
| 2026-10-21 12:05 | `e6068bb054` | STRANDED | 0/0/1/0 | 9282a98a77 | docs(mvp): record remote flows running in production after the QuickJS | apps/mvp/docs/work/land-and-deploy-mvp.md: - Still running at 19:01 UTC, none retrying: `c |
| 2026-10-21 12:05 | `97a87133ec` | SUPERSEDED | 2/5/0/0 | 0fd28abddc | ⚡ fix(mvp): ChatApi starts in about 100 ms, its program imported when  | apps/mvp/docs/infrastructure.md: main carried then changed it: 8a27d83180 (🧪 test(mvp): se |
| 2026-10-21 12:05 | `51d02af8b0` | SUPERSEDED | 2/5/0/0 | cdb1160df9 | ⚡ fix(mvp): ChatApi starts in about 100 ms, its program imported when  | apps/mvp/docs/infrastructure.md: main carried then changed it: 8a27d83180 (🧪 test(mvp): se |
| 2026-10-21 12:05 | `467e1e0ece` | STRANDED | 0/0/1/0 | 467e1e0ece | docs(mvp): record remote flows running in production after the QuickJS | apps/mvp/docs/work/land-and-deploy-mvp.md: - Still running at 19:01 UTC, none retrying: `c |
| 2026-10-21 12:06 | `bf0982cae2` | PARTIAL | 0/0/9/2 | 62778583ba | ✨ feat(agent): HarnessCli, the command line, environment and output re | .changeset/agent-harness-cli.md: - `HarnessCli.classify(text)` and `HarnessCli.resetAt(tex |
| 2026-10-21 12:06 | `4c9422b784` | PARTIAL | 0/0/9/2 | 363f83c1c0 | ✨ feat(agent): HarnessCli, the command line, environment and output re | .changeset/agent-harness-cli.md: - `HarnessCli.classify(text)` and `HarnessCli.resetAt(tex |
| 2026-10-21 12:07 | `0c1a2e6007` | ON-MAIN | 11/0/0/0 | 0fd28abddc | 🐛 fix(mvp): a model call larger than the whole daily budget is refused |  |
| 2026-10-21 12:07 | `a286fac643` | ON-MAIN | 11/0/0/0 | cdb1160df9 | 🐛 fix(mvp): a model call larger than the whole daily budget is refused |  |
| 2026-10-21 12:08 | `4467063249` | SUPERSEDED | 50/26/0/0 | a2cc4468ea | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 12:08 | `bd21c32348` | SUPERSEDED | 50/26/0/0 | 4a47b426e6 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 12:08 | `a7d420e0cd` | SUPERSEDED | 50/25/0/0 | 43007b0fd8 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 12:08 | `32e5a252c9` | SUPERSEDED | 50/25/0/0 | 32e5a252c9 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 12:08 | `08d0af64a1` | SUPERSEDED | 50/25/0/0 | 08d0af64a1 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 12:08 | `17e2945bbf` | SUPERSEDED | 50/25/0/0 | 17e2945bbf | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `e40338f43b` | SUPERSEDED | 50/25/0/0 | e40338f43b | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 12:08 | `f5c05d01d1` | SUPERSEDED | 50/25/0/0 | fa5176b235 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 12:08 | `caf4787f60` | SUPERSEDED | 50/25/0/0 | 3bfa24b71f | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `5e879089d6` | SUPERSEDED | 43/29/0/0 | b20d32561c | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `37ef86f7b2` | SUPERSEDED | 48/26/0/0 | ac07bc9451 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `36c630b662` | SUPERSEDED | 43/30/0/0 | 3443e5d126 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `39a2226c51` | SUPERSEDED | 49/26/0/0 | b81df565e1 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `caa4bc9c6a` | SUPERSEDED | 49/26/0/0 | aec510490c | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `891b71d7d3` | SUPERSEDED | 43/30/0/0 | 5a4cd7d7dc | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `e411572ffa` | SUPERSEDED | 43/30/0/0 | 0cabd611c1 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `6a94dc267e` | SUPERSEDED | 43/30/0/0 | 6a94dc267e | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:08 | `2e0faf713d` | SUPERSEDED | 43/30/0/0 | fd1e672266 | ✨ feat(integrations,mvp): the stack's TODOs become stacked pull reques | apps/mvp/db/Database.ts: landed as fc50b8a1c3 (same author and time, committed later) |
| 2026-10-21 12:11 | `b7c4d2a1b2` | STRANDED | 0/0/7/0 | 62778583ba | 📝 docs(agent): run a step on an agent CLI | .changeset/agent-external-agent.md: - `AgentRunner.Backend` names which agent does a role' |
| 2026-10-21 12:11 | `dab8c784da` | PARTIAL | 3/0/0/2 | 62778583ba | ✨ feat(agent): ExternalAgent, a durable step an agent CLI does on a ru | packages/smithers/agent/src/ExternalAgent.ts: return Object.assign(job, { toLayer }) as Om |
| 2026-10-21 12:11 | `43bf239281` | PARTIAL | 2/0/1/0 | 62778583ba | ✅ test(agent): the runner contract's schemas, and an unreachable job s | packages/smithers/agent/test/AgentRunner.test.ts: expect(decodes(AgentRunner.Backend, { ki |
| 2026-10-21 12:11 | `b79dc8634f` | STRANDED | 0/0/7/0 | cb85ebcf38 | 📝 docs(agent): run a step on an agent CLI | .changeset/agent-external-agent.md: - `AgentRunner.Backend` names which agent does a role' |
| 2026-10-21 12:11 | `a9d00b526d` | PARTIAL | 3/0/0/2 | cb85ebcf38 | ✨ feat(agent): ExternalAgent, a durable step an agent CLI does on a ru | packages/smithers/agent/src/ExternalAgent.ts: return Object.assign(job, { toLayer }) as Om |
| 2026-10-21 12:11 | `7bfe92a761` | PARTIAL | 2/0/1/0 | cb85ebcf38 | ✅ test(agent): the runner contract's schemas, and an unreachable job s | packages/smithers/agent/test/AgentRunner.test.ts: expect(decodes(AgentRunner.Backend, { ki |
| 2026-10-21 12:12 | `f90f6b19be` | PARTIAL | 2/0/7/0 | 62778583ba | ✨ feat(cli): smthrs runner, which claims a host's agent jobs and runs  | .changeset/cli-runner.md: - `smthrs runner serve --url <origin>` claims jobs over HTTPS fo |
| 2026-10-21 12:12 | `c25c696254` | ON-MAIN | 1/0/0/0 | 62778583ba | 🎨 style(mcp): the MCP tools example sorts its imports as dprint does |  |
| 2026-10-21 12:12 | `8d65f92f12` | PARTIAL | 2/0/7/0 | 363f83c1c0 | ✨ feat(cli): smthrs runner, which claims a host's agent jobs and runs  | .changeset/cli-runner.md: - `smthrs runner serve --url <origin>` claims jobs over HTTPS fo |
| 2026-10-21 12:12 | `966db29c25` | ON-MAIN | 1/0/0/0 | cb85ebcf38 | 🎨 style(mcp): the MCP tools example sorts its imports as dprint does |  |
| 2026-10-21 12:12 | `3da4bd89f2` | PARTIAL | 1/0/25/1 | 3da4bd89f2 |  | .changeset/mcp-server.md: server runs in a Cloudflare Worker, a browser, Node and Bun. It |
| 2026-10-21 12:16 | `efb69411db` | SUPERSEDED | 1/1/0/0 | efb69411db | 📝 docs(mvp): the durable external effects proposal as built: Write, Tr | apps/mvp/docs/proposals/durable-external-effects.md: main carried then changed it: 58bb605 |
| 2026-10-21 12:16 | `5c30c7c0ea` | SUPERSEDED | 1/2/0/0 | efb69411db | 🚨 chore(mvp): lint rule durable.external-writes-once | apps/mvp/PACKAGE.ts: main carried then changed it: 6e187f0cba (🚨 chore(mvp): durable.exter |
| 2026-10-21 12:16 | `e494d3f4a6` | SUPERSEDED | 2/1/0/0 | efb69411db | 🐛 fix(mvp): a rejected issue's triage comment is looked for in the who | apps/mvp/worker/github/Triage.ts: main carried then changed it: f65d5c6e2a (♻️ refactor(mv |
| 2026-10-21 12:16 | `939c6dc878` | SUPERSEDED | 1/1/0/0 | 3a4c9409b0 | 📝 docs(mvp): the durable external effects proposal as built: Write, Tr | apps/mvp/docs/proposals/durable-external-effects.md: main carried then changed it: 58bb605 |
| 2026-10-21 12:16 | `ab1abec387` | SUPERSEDED | 1/2/0/0 | 3a4c9409b0 | 🚨 chore(mvp): lint rule durable.external-writes-once | apps/mvp/PACKAGE.ts: main carried then changed it: 6e187f0cba (🚨 chore(mvp): durable.exter |
| 2026-10-21 12:16 | `a9cabfb5c8` | SUPERSEDED | 2/1/0/0 | 3a4c9409b0 | 🐛 fix(mvp): a rejected issue's triage comment is looked for in the who | apps/mvp/worker/github/Triage.ts: main carried then changed it: f65d5c6e2a (♻️ refactor(mv |
| 2026-10-21 12:16 | `ba82b96a7b` | SUPERSEDED | 2/3/0/0 | b12047308c | 📝 docs: regenerated site reference for Action.once and GitHub.Once | apps/site/src/content/docs/docs/reference/api/flow.mdx: main carried then changed it: 9870 |
| 2026-10-21 12:16 | `27bb09d159` | SUPERSEDED | 2/3/0/0 | ac996be8c8 | 📝 docs: regenerated site reference for Action.once and GitHub.Once | apps/site/src/content/docs/docs/reference/api/flow.mdx: main carried then changed it: 9870 |
| 2026-10-21 12:16 | `29ccc189b5` | SUPERSEDED | 1/1/0/0 | ac996be8c8 | 📝 docs(mvp): the durable external effects proposal as built: Write, Tr | apps/mvp/docs/proposals/durable-external-effects.md: main carried then changed it: 58bb605 |
| 2026-10-21 12:16 | `9bc1fd43d2` | SUPERSEDED | 1/2/0/0 | ac996be8c8 | 🚨 chore(mvp): lint rule durable.external-writes-once | apps/mvp/PACKAGE.ts: main carried then changed it: 6e187f0cba (🚨 chore(mvp): durable.exter |
| 2026-10-21 12:16 | `a396c6e6ba` | SUPERSEDED | 2/1/0/0 | ac996be8c8 | 🐛 fix(mvp): a rejected issue's triage comment is looked for in the who | apps/mvp/worker/github/Triage.ts: main carried then changed it: f65d5c6e2a (♻️ refactor(mv |
| 2026-10-21 12:16 | `a5b0da83bb` | SUPERSEDED | 1/1/0/0 | a5b0da83bb | 📝 docs(mvp): the durable external effects proposal as built: Write, Tr | apps/mvp/docs/proposals/durable-external-effects.md: main carried then changed it: 58bb605 |
| 2026-10-21 12:16 | `c34c9c7c8d` | SUPERSEDED | 1/2/0/0 | a5b0da83bb | 🚨 chore(mvp): lint rule durable.external-writes-once | apps/mvp/PACKAGE.ts: main carried then changed it: 6e187f0cba (🚨 chore(mvp): durable.exter |
| 2026-10-21 12:16 | `a137597efa` | SUPERSEDED | 2/1/0/0 | a5b0da83bb | 🐛 fix(mvp): a rejected issue's triage comment is looked for in the who | apps/mvp/worker/github/Triage.ts: main carried then changed it: f65d5c6e2a (♻️ refactor(mv |
| 2026-10-21 12:16 | `4a465da142` | SUPERSEDED | 1/1/0/0 | b582dd6f9e | 📝 docs(mvp): the durable external effects proposal as built: Write, Tr | apps/mvp/docs/proposals/durable-external-effects.md: main carried then changed it: 58bb605 |
| 2026-10-21 12:16 | `28ed8cbb83` | SUPERSEDED | 1/2/0/0 | b582dd6f9e | 🚨 chore(mvp): lint rule durable.external-writes-once | apps/mvp/PACKAGE.ts: main carried then changed it: 6e187f0cba (🚨 chore(mvp): durable.exter |
| 2026-10-21 12:16 | `4952f11e25` | SUPERSEDED | 2/1/0/0 | b582dd6f9e | 🐛 fix(mvp): a rejected issue's triage comment is looked for in the who | apps/mvp/worker/github/Triage.ts: main carried then changed it: f65d5c6e2a (♻️ refactor(mv |
| 2026-10-21 12:16 | `2d40f4700a` | SUPERSEDED | 2/3/0/0 | dd12f89340 | 📝 docs: regenerated site reference for Action.once and GitHub.Once | apps/site/src/content/docs/docs/reference/api/flow.mdx: main carried then changed it: 9870 |
| 2026-10-21 12:16 | `1e08c677db` | SUPERSEDED | 1/1/0/0 | dd12f89340 | 📝 docs(mvp): the durable external effects proposal as built: Write, Tr | apps/mvp/docs/proposals/durable-external-effects.md: main carried then changed it: 58bb605 |
| 2026-10-21 12:16 | `195b5d7417` | SUPERSEDED | 1/2/0/0 | dd12f89340 | 🚨 chore(mvp): lint rule durable.external-writes-once | apps/mvp/PACKAGE.ts: main carried then changed it: 6e187f0cba (🚨 chore(mvp): durable.exter |
| 2026-10-21 12:16 | `e8c2d11efc` | SUPERSEDED | 2/1/0/0 | dd12f89340 | 🐛 fix(mvp): a rejected issue's triage comment is looked for in the who | apps/mvp/worker/github/Triage.ts: main carried then changed it: f65d5c6e2a (♻️ refactor(mv |
| 2026-10-21 12:16 | `0ea193cb82` | PARTIAL | 10/2/1/1 | 0ea193cb82 | 🐛 fix(mvp): bind opaque runs exactly and use configured alert links | apps/mvp/docs/work/worker-953411.md: - Malformed conversation id: `ShapeProxy.test.ts` exp |
| 2026-10-21 12:16 | `e2e332627a` | PARTIAL | 10/2/1/1 | e2e332627a |  | apps/mvp/docs/work/worker-953411.md: - Malformed conversation id: `ShapeProxy.test.ts` exp |
| 2026-10-21 12:16 | `701923c931` | SUPERSEDED | 1/1/0/0 | 701923c931 | 📝 docs(mvp): the durable external effects proposal as built: Write, Tr | apps/mvp/docs/proposals/durable-external-effects.md: main carried then changed it: 58bb605 |
| 2026-10-21 12:16 | `14600b3ab3` | SUPERSEDED | 1/2/0/0 | 701923c931 | 🚨 chore(mvp): lint rule durable.external-writes-once | apps/mvp/PACKAGE.ts: main carried then changed it: 6e187f0cba (🚨 chore(mvp): durable.exter |
| 2026-10-21 12:16 | `8ead12a8d1` | SUPERSEDED | 2/1/0/0 | 701923c931 | 🐛 fix(mvp): a rejected issue's triage comment is looked for in the who | apps/mvp/worker/github/Triage.ts: main carried then changed it: f65d5c6e2a (♻️ refactor(mv |
| 2026-10-21 12:16 | `77c5f4aa22` | SUPERSEDED | 1/1/0/0 | 9282a98a77 | 📝 docs(mvp): the durable external effects proposal as built: Write, Tr | apps/mvp/docs/proposals/durable-external-effects.md: main carried then changed it: 58bb605 |
| 2026-10-21 12:16 | `3f871f31df` | SUPERSEDED | 1/2/0/0 | 9282a98a77 | 🚨 chore(mvp): lint rule durable.external-writes-once | apps/mvp/PACKAGE.ts: main carried then changed it: 6e187f0cba (🚨 chore(mvp): durable.exter |
| 2026-10-21 12:16 | `2bfd41f3ef` | SUPERSEDED | 2/1/0/0 | 9282a98a77 | 🐛 fix(mvp): a rejected issue's triage comment is looked for in the who | apps/mvp/worker/github/Triage.ts: main carried then changed it: f65d5c6e2a (♻️ refactor(mv |
| 2026-10-21 12:16 | `27b087381b` | SUPERSEDED | 2/3/0/0 | 5cb08384b1 | 📝 docs: regenerated site reference for Action.once and GitHub.Once | apps/site/src/content/docs/docs/reference/api/flow.mdx: main carried then changed it: 9870 |
| 2026-10-21 12:16 | `ad3afb35e8` | PARTIAL | 2/0/1/0 | ad3afb35e8 |  | apps/mvp/docs/work/worker-953411.md: Investigate worker findings using farm regression tes |
| 2026-10-21 12:16 | `1c3b1ed942` | PARTIAL | 12/5/0/1 | 1c3b1ed942 |  | apps/site/public/llms-full.txt: - **Signature:** `once<A, E, R>(name: string, effect: Keye |
| 2026-10-21 12:16 | `f0b55a2cbf` | SUPERSEDED | 1/1/0/0 | 5cb08384b1 | 📝 docs(mvp): the durable external effects proposal as built: Write, Tr | apps/mvp/docs/proposals/durable-external-effects.md: main carried then changed it: 58bb605 |
| 2026-10-21 12:16 | `01b15bf291` | SUPERSEDED | 1/2/0/0 | 5cb08384b1 | 🚨 chore(mvp): lint rule durable.external-writes-once | apps/mvp/PACKAGE.ts: main carried then changed it: 6e187f0cba (🚨 chore(mvp): durable.exter |
| 2026-10-21 12:16 | `f0397e6857` | SUPERSEDED | 2/1/0/0 | 5cb08384b1 | 🐛 fix(mvp): a rejected issue's triage comment is looked for in the who | apps/mvp/worker/github/Triage.ts: main carried then changed it: f65d5c6e2a (♻️ refactor(mv |
| 2026-10-21 12:19 | `9476aefd3b` | PARTIAL | 1/0/14/2 | 62778583ba | ✨ feat(mvp): the coding role's agent backend and the runner registry,  | apps/mvp/db/Database.ts: import agentRunners from "./migrations/0038_agent_runners.ts"; ap |
| 2026-10-21 12:19 | `80176d7b92` | PARTIAL | 1/0/14/2 | cb85ebcf38 | ✨ feat(mvp): the coding role's agent backend and the runner registry,  | apps/mvp/db/Database.ts: import agentRunners from "./migrations/0038_agent_runners.ts"; ap |
| 2026-10-21 12:19 | `0b2d49732a` | PARTIAL | 1/0/14/2 | a2f4b43226 | ✨ feat(mvp): the coding role's agent backend and the runner registry,  | apps/mvp/db/Database.ts: import agentRunners from "./migrations/0038_agent_runners.ts"; ap |
| 2026-10-21 12:19 | `c24411430b` | PARTIAL | 3/0/25/4 | c24411430b |  | apps/mvp/db/Database.ts: import agentRunners from "./migrations/0038_agent_runners.ts"; ap |
| 2026-10-21 12:27 | `48faf12125` | SUPERSEDED | 2/6/0/0 | 0b93fc6d9a | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `f3fcf79af0` | SUPERSEDED | 2/6/0/0 | 0bbf6b3fbd | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `aa02256a3c` | SUPERSEDED | 2/6/0/0 | 8d811f68cb | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `c71ab7d442` | SUPERSEDED | 2/6/0/0 | 72a73899be | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `1583b67018` | SUPERSEDED | 2/6/0/0 | 104a7b5e07 | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `001ca58231` | SUPERSEDED | 2/6/0/0 | 331891126f | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `e8108133ea` | SUPERSEDED | 2/6/0/0 | 9ef520910f | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `00191d0aaf` | SUPERSEDED | 2/6/0/0 | cc19e2287a | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `f89109215c` | SUPERSEDED | 2/6/0/0 | 245fc53d61 | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `936b01da4a` | SUPERSEDED | 2/6/0/0 | 43007b0fd8 | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `22b558bf69` | SUPERSEDED | 2/6/0/0 | b008dcea7c | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:27 | `0fd28abddc` | ON-MAIN | 1/0/0/0 | 0fd28abddc |  |  |
| 2026-10-21 12:27 | `12e1d9e91e` | SUPERSEDED | 2/6/0/0 | cdb1160df9 | 🔒 fix(mvp): only a Member's About read spends the deployment's GitHub  | apps/mvp/docs/features/repo.md: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visi |
| 2026-10-21 12:30 | `c6d814055c` | SUPERSEDED | 16/2/0/0 | 4b4584af3b | 🐛 fix(mvp): preserve model settings and notification access | apps/mvp/worker/Notifications.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): g |
| 2026-10-21 12:30 | `8112fcf830` | SUPERSEDED | 16/2/0/0 | dd60c8c5bf | 🐛 fix(mvp): preserve model settings and notification access | apps/mvp/worker/Notifications.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): g |
| 2026-10-21 12:30 | `2051795044` | SUPERSEDED | 16/2/0/0 | 2051795044 | 🐛 fix(mvp): preserve model settings and notification access | apps/mvp/worker/Notifications.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): g |
| 2026-10-21 12:30 | `95621d0845` | SUPERSEDED | 14/3/0/0 | 95621d0845 |  | apps/mvp/docs/features/notifications.md: landed as dd64ffd046 (same author and time, commi |
| 2026-10-21 12:30 | `b661e1b0b1` | SUPERSEDED | 10/3/0/0 | b661e1b0b1 |  | .worker-validation-backup/ModelRoles.ts: main has no .worker-validation-backup (package re |
| 2026-10-21 12:33 | `7006b8cd41` | ON-MAIN | 3/0/0/0 | 0b93fc6d9a | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `547191ab3b` | ON-MAIN | 3/0/0/0 | 0bbf6b3fbd | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `d5bb87ec1e` | ON-MAIN | 3/0/0/0 | 8d811f68cb | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `5b192390ad` | ON-MAIN | 3/0/0/0 | 72a73899be | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `facfe123d5` | ON-MAIN | 3/0/0/0 | 104a7b5e07 | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `0ec2aa60ad` | ON-MAIN | 3/0/0/0 | 331891126f | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `17c438e266` | ON-MAIN | 3/0/0/0 | 9ef520910f | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `13af28b981` | ON-MAIN | 3/0/0/0 | cc19e2287a | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `edd171d412` | ON-MAIN | 3/0/0/0 | 245fc53d61 | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `99f4a9c85c` | ON-MAIN | 3/0/0/0 | 43007b0fd8 | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `494f88ce98` | PARTIAL | 2/0/16/1 | 62778583ba | ✨ feat(mvp): an agent job's tools over MCP, each call one sandbox/Call | apps/mvp/AGENTS.md: - `ChatApi.ts` is Effect-native: it stores questions in Postgres, prox |
| 2026-10-21 12:33 | `8f0eaf307b` | PARTIAL | 1/0/4/3 | 62778583ba | ✨ feat(mvp): the runner routes and the agent job store on Postgres | apps/mvp/worker/AgentJobs.test.ts: test("a key cancelled before its start arrived ends can |
| 2026-10-21 12:33 | `18bda44727` | ON-MAIN | 3/0/0/0 | b008dcea7c | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:33 | `a340a0cbb4` | PARTIAL | 0/1/57/6 | b008dcea7c | 🔒 fix(mvp): an agent's issue write goes with its run's credential alon | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: ## Addendum, 2026-1 |
| 2026-10-21 12:33 | `ab3cc44f15` | PARTIAL | 2/0/16/1 | ab3cc44f15 |  | apps/mvp/AGENTS.md: - `ChatApi.ts` is Effect-native: it stores questions in Postgres, prox |
| 2026-10-21 12:33 | `d6ee4afdb2` | PARTIAL | 2/0/16/1 | cb85ebcf38 | ✨ feat(mvp): an agent job's tools over MCP, each call one sandbox/Call | apps/mvp/AGENTS.md: - `ChatApi.ts` is Effect-native: it stores questions in Postgres, prox |
| 2026-10-21 12:33 | `bd74719a1b` | PARTIAL | 1/0/4/3 | cb85ebcf38 | ✨ feat(mvp): the runner routes and the agent job store on Postgres | apps/mvp/worker/AgentJobs.test.ts: test("a key cancelled before its start arrived ends can |
| 2026-10-21 12:33 | `1319b89881` | PARTIAL | 2/0/16/1 | a2f4b43226 | ✨ feat(mvp): an agent job's tools over MCP, each call one sandbox/Call | apps/mvp/AGENTS.md: - `ChatApi.ts` is Effect-native: it stores questions in Postgres, prox |
| 2026-10-21 12:33 | `45881b7777` | PARTIAL | 2/0/16/1 | 45881b7777 |  | apps/mvp/AGENTS.md: - `ChatApi.ts` is Effect-native: it stores questions in Postgres, prox |
| 2026-10-21 12:33 | `438298d920` | PARTIAL | 1/0/4/3 | a2f4b43226 | ✨ feat(mvp): the runner routes and the agent job store on Postgres | apps/mvp/worker/AgentJobs.test.ts: test("queues one generation once, for its runner, with |
| 2026-10-21 12:33 | `bf3f74375d` | PARTIAL | 0/1/56/7 | 2bb993d7cb | 🔒 fix(mvp): an agent's issue write goes with its run's credential alon | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: ## Addendum, 2026-1 |
| 2026-10-21 12:33 | `2e39651439` | PARTIAL | 0/1/56/7 | c870231485 | 🔒 fix(mvp): an agent's issue write goes with its run's credential alon | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: ## Addendum, 2026-1 |
| 2026-10-21 12:33 | `fa854a7729` | PARTIAL | 2/0/16/1 | fa854a7729 |  | apps/mvp/AGENTS.md: - `ChatApi.ts` is Effect-native: it stores questions in Postgres, prox |
| 2026-10-21 12:33 | `204e265be0` | PARTIAL | 1/0/4/3 | fa854a7729 | ✨ feat(mvp): the runner routes and the agent job store on Postgres | apps/mvp/worker/AgentJobs.test.ts: test("queues one generation once, for its runner, with |
| 2026-10-21 12:33 | `3b9a6a0e4d` | ON-MAIN | 3/0/0/0 | cdb1160df9 | ✅ test(mvp): the remote-flow issue tests read the shape between polls  |  |
| 2026-10-21 12:34 | `0182dd8d5b` | PARTIAL | 0/0/24/3 | b008dcea7c | 🔒 fix(mvp): no run credential in device storage: the outbox holds a pe | apps/mvp/docs/features/issues.md: \| `writes.ts` \| `issue-sending` (the outbox's optimist |
| 2026-10-21 12:34 | `b4a0b66a74` | PARTIAL | 0/0/24/3 | 9ff7f5bc65 | 🔒 fix(mvp): no run credential in device storage: the outbox holds a pe | apps/mvp/docs/features/issues.md: \| `writes.ts` \| `issue-sending` (the outbox's optimist |
| 2026-10-21 12:34 | `a2ea16b98e` | PARTIAL | 0/1/24/3 | 2bb993d7cb | 🔒 fix(mvp): no run credential in device storage: the outbox holds a pe | apps/mvp/docs/features/issues.md: \| `writes.ts` \| `issue-sending` (the outbox's optimist |
| 2026-10-21 12:34 | `32bf658e5f` | PARTIAL | 0/0/46/7 | 32bf658e5f |  | apps/mvp/docs/features/issues.md: \| `writes.ts` \| `issue-sending` (the outbox's optimist |
| 2026-10-21 12:34 | `9e85137372` | PARTIAL | 0/1/24/3 | c870231485 | 🔒 fix(mvp): no run credential in device storage: the outbox holds a pe | apps/mvp/docs/features/issues.md: \| `writes.ts` \| `issue-sending` (the outbox's optimist |
| 2026-10-21 12:41 | `e8a39377e9` | PARTIAL | 0/0/28/4 | b008dcea7c | 🔒 fix(mvp): a refused person never sees issues the device still holds, | .changeset/electric-collection-evict.md: const notes = yield* ElectricCollection.make({ id |
| 2026-10-21 12:41 | `aac28cf1ed` | PARTIAL | 0/0/28/4 | 9ff7f5bc65 | 🔒 fix(mvp): a refused person never sees issues the device still holds, | .changeset/electric-collection-evict.md: const notes = yield* ElectricCollection.make({ id |
| 2026-10-21 12:41 | `67f7b7c8d3` | PARTIAL | 0/0/28/4 | 2bb993d7cb | 🔒 fix(mvp): a refused person never sees issues the device still holds, | .changeset/electric-collection-evict.md: const notes = yield* ElectricCollection.make({ id |
| 2026-10-21 12:41 | `5c2a97d0b8` | PARTIAL | 0/0/25/1 | 62778583ba | ✨ feat(mcp): McpServer serves typed tools to an MCP client over Stream | .changeset/mcp-server.md: server runs in a Cloudflare Worker, a browser, Node and Bun. It |
| 2026-10-21 12:41 | `e32851a7a8` | PARTIAL | 0/0/23/5 | c870231485 | 🔒 fix(mvp): a refused person never sees issues the device still holds, | .changeset/electric-collection-evict.md: const notes = yield* ElectricCollection.make({ id |
| 2026-10-21 12:41 | `a641394e8f` | PARTIAL | 0/0/29/5 | 040001c3ef | 🔒 fix(mvp): a refused person never sees issues the device still holds, | .changeset/electric-collection-evict.md: const notes = yield* ElectricCollection.make({ id |
| 2026-10-21 12:41 | `ae3fe39008` | EMPTY-ISH | 0/0/0/0 | cb85ebcf38 | 🔧 build(index): regenerate .smithers/target-index.json for McpServer a |  |
| 2026-10-21 12:41 | `992e8d642c` | PARTIAL | 0/0/25/1 | cb85ebcf38 | ✨ feat(mcp): McpServer serves typed tools to an MCP client over Stream | .changeset/mcp-server.md: server runs in a Cloudflare Worker, a browser, Node and Bun. It |
| 2026-10-21 12:44 | `65e5c1587b` | SUPERSEDED | 0/1/0/0 | 65e5c1587b |  | apps/mvp/worker/flows/Todo.test.ts: main carried then changed it: 890a410e19 (fix(mvp): wa |
| 2026-10-21 12:44 | `7c0c916980` | SUPERSEDED | 0/1/0/0 | 7c0c916980 |  | apps/mvp/worker/flows/Todo.test.ts: main carried then changed it: 890a410e19 (fix(mvp): wa |
| 2026-10-21 12:44 | `c751c7cd0a` | SUPERSEDED | 0/1/0/0 | c751c7cd0a |  | apps/mvp/worker/flows/Todo.test.ts: main carried then changed it: 890a410e19 (fix(mvp): wa |
| 2026-10-21 12:49 | `7f2e6f10a4` | ON-MAIN | 1/0/0/0 | 4ab24343c4 | 📝 docs(mvp): the GitHub write hardening design: the merge's base, a pe |  |
| 2026-10-21 12:49 | `81aeb62c69` | ON-MAIN | 1/0/0/0 | 2f5b9204b2 | 📝 docs(mvp): the GitHub write hardening design: the merge's base, a pe |  |
| 2026-10-21 12:49 | `547abe7d29` | ON-MAIN | 1/0/0/0 | fcb0f1f644 | 📝 docs(mvp): the GitHub write hardening design: the merge's base, a pe |  |
| 2026-10-21 12:49 | `3007cc3c0c` | PARTIAL | 0/0/0/1 | 7ed8110efb | 📝 docs(mvp): the GitHub write hardening design: the merge's base, a pe | apps/mvp/docs/work/github-write-hardening.md: is `base_moved`: nothing merges, and every o |
| 2026-10-21 12:53 | `59e962ef0a` | SUPERSEDED | 2/3/0/0 | 7ed8110efb | Merge main and the durable-effects stack (base for the GitHub write ha | apps/mvp/worker/flows/Todo.test.ts: main carried then changed it: 890a410e19 (fix(mvp): wa |
| 2026-10-21 12:54 | `031070e4d4` | ON-MAIN | 6/0/0/0 | b12047308c | 🐛 fix(cli): stack submit finds the pull request its change already ope |  |
| 2026-10-21 12:54 | `0903030d99` | ON-MAIN | 7/0/0/0 | b12047308c | ✨ feat(flow): Action.once takes a key recorded before the step, for wr |  |
| 2026-10-21 12:54 | `be03ee88b0` | ON-MAIN | 6/0/0/0 | ac996be8c8 | 🐛 fix(cli): stack submit finds the pull request its change already ope |  |
| 2026-10-21 12:54 | `fbf134c917` | ON-MAIN | 7/0/0/0 | ac996be8c8 | ✨ feat(flow): Action.once takes a key recorded before the step, for wr |  |
| 2026-10-21 12:54 | `e1c3908302` | ON-MAIN | 6/0/0/0 | dd12f89340 | 🐛 fix(cli): stack submit finds the pull request its change already ope |  |
| 2026-10-21 12:54 | `9327d8a401` | ON-MAIN | 7/0/0/0 | dd12f89340 | ✨ feat(flow): Action.once takes a key recorded before the step, for wr |  |
| 2026-10-21 12:54 | `0bde45a8e2` | ON-MAIN | 6/0/0/0 | 5cb08384b1 | 🐛 fix(cli): stack submit finds the pull request its change already ope |  |
| 2026-10-21 12:54 | `9de0cb90e0` | ON-MAIN | 7/0/0/0 | 5cb08384b1 | ✨ feat(flow): Action.once takes a key recorded before the step, for wr |  |
| 2026-10-21 12:55 | `c9ccd9c40f` | PARTIAL | 2/1/23/4 | c9ccd9c40f | 🐛 fix(mvp): serialize draft writes and fence admission | apps/mvp/db/Database.test.ts: for (const [name, time] of [["original", "2026-10-01"], ["un |
| 2026-10-21 12:55 | `7440233936` | PARTIAL | 2/1/23/4 | 7440233936 |  | apps/mvp/db/Database.test.ts: for (const [name, time] of [["original", "2026-10-01"], ["un |
| 2026-10-21 12:55 | `c3ab4ad244` | PARTIAL | 2/1/24/4 | c3ab4ad244 |  | apps/mvp/db/Database.test.ts: for (const [name, time] of [["original", "2026-10-01"], ["un |
| 2026-10-21 12:55 | `9ff3087d68` | PARTIAL | 1/1/23/4 | 9ff3087d68 |  | apps/mvp/db/Database.test.ts: for (const [name, time] of [["original", "2026-10-01"], ["un |
| 2026-10-21 12:55 | `537de2daf8` | PARTIAL | 1/1/18/4 | 537de2daf8 |  | apps/mvp/db/Database.test.ts: for (const [name, time] of [["original", "2026-10-01"], ["un |
| 2026-10-21 12:55 | `6afbc5206d` | PARTIAL | 1/1/16/4 | 6afbc5206d |  | apps/mvp/db/Database.test.ts: for (const [name, time] of [["original", "2026-10-01"], ["un |
| 2026-10-21 12:56 | `e8c922fe28` | PARTIAL | 5/1/3/3 | e8c922fe28 | 🐛 fix(issues): validate queued writes and retain failed persistence | apps/mvp/docs/features/issues.md: - **Queued writes survive refusal.** The outbox settles |
| 2026-10-21 12:56 | `faa02d0a79` | PARTIAL | 5/1/3/3 | faa02d0a79 |  | apps/mvp/docs/features/issues.md: - **Queued writes survive refusal.** The outbox settles |
| 2026-10-21 12:56 | `12c1e23387` | PARTIAL | 5/1/2/4 | 12c1e23387 |  | apps/mvp/docs/features/issues.md: - **Queued writes survive refusal.** The outbox settles |
| 2026-10-21 13:00 | `354a880329` | ON-MAIN | 5/0/0/0 | 354a880329 | ✅ test(mvp): the stale-tab conflict test runs unmarked: 18 of 20 runs  |  |
| 2026-10-21 13:00 | `e16546f509` | ON-MAIN | 5/0/0/0 | e16546f509 | ✅ test(mvp): the stale-tab conflict test runs unmarked: 18 of 20 runs  |  |
| 2026-10-21 13:00 | `dcd3dc5fb7` | SUPERSEDED | 1/1/0/0 | dcd3dc5fb7 |  | apps/mvp/e2e/local-first-conflicts.spec.ts: landed as f6c9575f3a (same author and time, co |
| 2026-10-21 13:00 | `c558742b0f` | ON-MAIN | 5/0/0/0 | c558742b0f | ✅ test(mvp): the stale-tab conflict test runs unmarked: 18 of 20 runs  |  |
| 2026-10-21 13:00 | `5ea747ed39` | PARTIAL | 0/1/1/0 | 5ea747ed39 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "github.d.ts": "92ebb1e6af92c89 |
| 2026-10-21 13:00 | `e7c2dfa26f` | PARTIAL | 0/1/1/0 | e7c2dfa26f |  | .smithers/flows/release/fixtures/public-api-baseline.json: -        "github.d.ts": "4b8d42 |
| 2026-10-21 13:00 | `48208181b8` | PARTIAL | 0/1/1/0 | 48208181b8 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "github.d.ts": "92ebb1e6af92c89 |
| 2026-10-21 13:00 | `14cd4d44e8` | PARTIAL | 0/1/1/0 | 14cd4d44e8 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "github.d.ts": "92ebb1e6af92c89 |
| 2026-10-21 13:00 | `8d6d9f946c` | PARTIAL | 1/1/1/0 | 8d6d9f946c |  | .smithers/flows/release/fixtures/public-api-baseline.json: -        "github.d.ts": "140580 |
| 2026-10-21 13:00 | `a3b4795f09` | PARTIAL | 0/1/1/0 | a3b4795f09 |  | .smithers/flows/release/fixtures/public-api-baseline.json: -        "github.d.ts": "4b8d42 |
| 2026-10-21 13:00 | `5f627a1f24` | PARTIAL | 0/1/1/0 | 5f627a1f24 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "github.d.ts": "92ebb1e6af92c89 |
| 2026-10-21 13:00 | `5adf377d7d` | SUPERSEDED | 2/1/0/0 | 5adf377d7d |  | apps/mvp/e2e/local-first-conflicts.spec.ts: landed as f6c9575f3a (same author and time, co |
| 2026-10-21 13:00 | `2eebe05718` | PARTIAL | 1/1/1/0 | 2eebe05718 |  | .smithers/flows/release/fixtures/public-api-baseline.json: "github.d.ts": "92ebb1e6af92c89 |
| 2026-10-21 13:07 | `b748e20476` | PARTIAL | 61/5/8/8 | f0fcc1f28a | 🐛 fix(mvp): a tab on a visitor's data takes the person who signs in in | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:07 | `7b12317475` | PARTIAL | 61/5/8/8 | 7b12317475 | 🐛 fix(mvp): a tab on a visitor's data takes the person who signs in in | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:07 | `44ae9f7030` | PARTIAL | 58/5/8/11 | 44ae9f7030 | 🐛 fix(mvp): a new device whose first session check failed takes its pe | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:07 | `90b1d68b70` | PARTIAL | 23/5/24/5 | 90b1d68b70 |  | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:07 | `8e76e1670f` | PARTIAL | 23/5/24/5 | 8e76e1670f |  | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:07 | `8b6cad2c35` | PARTIAL | 23/5/24/5 | 8b6cad2c35 |  | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:07 | `55e13cd8b2` | PARTIAL | 23/5/24/5 | 55e13cd8b2 |  | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:07 | `91ab75fa68` | PARTIAL | 32/9/21/4 | c318874875 | 🐛 fix(mvp): a new device whose first session check failed takes its pe | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:07 | `cadf086bce` | PARTIAL | 26/2/24/7 | cadf086bce |  | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:07 | `02eea0709d` | PARTIAL | 31/5/22/7 | 02eea0709d | 🐛 fix(mvp): a new device whose first session check failed takes its pe | .changeset/browser-runtime-authorize-recheck.md: authorize: (opened) => Effect.tap(checkOw |
| 2026-10-21 13:08 | `797b55f409` | PARTIAL | 1/0/21/3 | b008dcea7c | 🔒 fix(mvp): repository notifications reach only watchers who may read  | apps/mvp/db/Database.ts: import sessionRoleVerified from "./migrations/0038_session_role_v |
| 2026-10-21 13:08 | `06889e5501` | PARTIAL | 1/0/19/4 | 06889e5501 | 🔒 fix(mvp): repository notifications reach only watchers who may read  | apps/mvp/db/Database.ts: import sessionRoleVerified from "./migrations/0038_session_role_v |
| 2026-10-21 13:08 | `9ff7f5bc65` | PARTIAL | 1/0/19/4 | 9ff7f5bc65 | 🔒 fix(mvp): repository notifications reach only watchers who may read  | apps/mvp/db/Database.ts: import sessionRoleVerified from "./migrations/0038_session_role_v |
| 2026-10-21 13:08 | `6eac005aab` | PARTIAL | 1/0/21/3 | 2bb993d7cb | 🔒 fix(mvp): repository notifications reach only watchers who may read  | apps/mvp/db/Database.ts: import sessionRoleVerified from "./migrations/0038_session_role_v |
| 2026-10-21 13:08 | `93a0a2e454` | PARTIAL | 0/0/21/3 | 93a0a2e454 | 🔒 fix(mvp): repository notifications reach only watchers who may read  | apps/mvp/db/Database.ts: import sessionRoleVerified from "./migrations/0038_session_role_v |
| 2026-10-21 13:08 | `c870231485` | PARTIAL | 0/0/17/1 | c870231485 | 🔒 fix(mvp): repository notifications reach only watchers who may read  | apps/mvp/docs/features/notifications.md: \| `main:<repo id>` \| GitHub's `push` to the def |
| 2026-10-21 13:08 | `2081e0849b` | PARTIAL | 0/0/21/3 | 040001c3ef | 🔒 fix(mvp): repository notifications reach only watchers who may read  | apps/mvp/db/Database.ts: import sessionRoleVerified from "./migrations/0038_session_role_v |
| 2026-10-21 13:11 | `c86ee76680` | SUPERSEDED | 2/1/0/0 | b8a380c99d | 🐛 fix(mvp): a stack change's send settles only once its record is stor | apps/mvp/src/features/todos/writes.ts: main carried then changed it: e14f3bc21c (✨ feat(mv |
| 2026-10-21 13:11 | `f9b631beba` | SUPERSEDED | 2/1/0/0 | b008dcea7c | 🐛 fix(mvp): a stack change's send settles only once its record is stor | apps/mvp/src/features/todos/writes.ts: main carried then changed it: e14f3bc21c (✨ feat(mv |
| 2026-10-21 13:11 | `7fd6439ba8` | SUPERSEDED | 2/1/0/0 | 7fd6439ba8 | 🐛 fix(mvp): a stack change's send settles only once its record is stor | apps/mvp/src/features/todos/writes.ts: main carried then changed it: e14f3bc21c (✨ feat(mv |
| 2026-10-21 13:11 | `ab165cc61f` | SUPERSEDED | 6/4/0/0 | b12047308c | 🐛 fix(mvp): New branch refuses a name the forge already has with exist | apps/mvp/docs/features/branch-workspace.md: main carried then changed it: 52a5e776f9 (✨ fe |
| 2026-10-21 13:11 | `ade37eb70c` | SUPERSEDED | 6/4/0/0 | ac996be8c8 | 🐛 fix(mvp): New branch refuses a name the forge already has with exist | apps/mvp/docs/features/branch-workspace.md: main carried then changed it: 52a5e776f9 (✨ fe |
| 2026-10-21 13:11 | `3ac5cf4348` | SUPERSEDED | 6/4/0/0 | dd12f89340 | 🐛 fix(mvp): New branch refuses a name the forge already has with exist | apps/mvp/docs/features/branch-workspace.md: main carried then changed it: 52a5e776f9 (✨ fe |
| 2026-10-21 13:11 | `bcc82d0297` | SUPERSEDED | 2/1/0/0 | bcc82d0297 | 🐛 fix(mvp): a stack change's send settles only once its record is stor | apps/mvp/src/features/todos/writes.ts: main carried then changed it: e14f3bc21c (✨ feat(mv |
| 2026-10-21 13:11 | `5f81b0b125` | SUPERSEDED | 6/4/0/0 | 5cb08384b1 | 🐛 fix(mvp): New branch refuses a name the forge already has with exist | apps/mvp/docs/features/branch-workspace.md: main carried then changed it: 52a5e776f9 (✨ fe |
| 2026-10-21 13:11 | `58004e350b` | SUPERSEDED | 52/17/0/0 | 58004e350b |  | apps/mvp/PACKAGE.ts: main carried then changed it: 36ebd46a94 (🐛 fix(mvp): a person's tria |
| 2026-10-21 13:14 | `c59daf5ded` | PARTIAL | 4/0/32/0 | 62778583ba | 🔒 fix(mcp): McpServer withholds span failures, refuses foreign origins | .changeset/mcp-server.md: JSON object and arguments the schema rejects, which never reach |
| 2026-10-21 13:14 | `1548426564` | PARTIAL | 4/0/32/0 | cb85ebcf38 | 🔒 fix(mcp): McpServer withholds span failures, refuses foreign origins | .changeset/mcp-server.md: JSON object and arguments the schema rejects, which never reach |
| 2026-10-21 13:14 | `35f594e16e` | PARTIAL | 4/0/31/0 | 35f594e16e |  | .changeset/mcp-server.md: JSON object and arguments the schema rejects, which never reach |
| 2026-10-21 13:15 | `dfaecb7796` | SUPERSEDED | 18/18/0/0 | a2cc4468ea | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `dcd8737107` | SUPERSEDED | 18/18/0/0 | 43007b0fd8 | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `00fbc692e0` | SUPERSEDED | 18/18/0/0 | 4a47b426e6 | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `f82e32695d` | SUPERSEDED | 18/18/0/0 | 32e5a252c9 | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `5f7a459c21` | SUPERSEDED | 18/18/0/0 | 08d0af64a1 | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `68ce6d4a11` | SUPERSEDED | 18/18/0/0 | 17e2945bbf | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `e252d56f2b` | SUPERSEDED | 18/18/0/0 | fa5176b235 | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `44950d7853` | STRANDED | 0/0/1/0 | 44950d7853 |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `2cac886f0a` | STRANDED | 0/0/1/0 | 2cac886f0a |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `fed0124841` | STRANDED | 0/0/1/0 | fed0124841 |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `b14f39ae03` | SUPERSEDED | 7/22/0/0 | b20d32561c | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | .smithers/checks/check.sh: landed as 5cfacfa483 (same author and time, committed later) |
| 2026-10-21 13:15 | `abe7287882` | STRANDED | 0/0/1/0 | abe7287882 |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `9faa23bbd5` | SUPERSEDED | 18/18/0/0 | 3bfa24b71f | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `4fbbbe9cd2` | STRANDED | 0/0/1/0 | 4fbbbe9cd2 |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `8b1a57788c` | SUPERSEDED | 7/22/0/0 | 3443e5d126 | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | .smithers/checks/check.sh: landed as 5cfacfa483 (same author and time, committed later) |
| 2026-10-21 13:15 | `df704c1faa` | STRANDED | 0/0/1/0 | df704c1faa |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `c583d76c01` | SUPERSEDED | 18/18/0/0 | b81df565e1 | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `7bc4b5408b` | STRANDED | 0/0/1/0 | 7bc4b5408b |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `f30888f5ce` | STRANDED | 0/0/1/0 | f30888f5ce |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `f194680b85` | SUPERSEDED | 18/18/0/0 | b008dcea7c | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `7fe7b230fe` | SUPERSEDED | 7/22/0/0 | 5a4cd7d7dc | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | .smithers/checks/check.sh: landed as 5cfacfa483 (same author and time, committed later) |
| 2026-10-21 13:15 | `cd216513f0` | STRANDED | 0/0/1/0 | cd216513f0 |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `3bde4bb944` | SUPERSEDED | 18/18/0/0 | aec510490c | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `f7a3780ebd` | SUPERSEDED | 16/18/0/0 | 6a94dc267e | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | apps/mvp/docs/features/pulls.md: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-21 13:15 | `2a8e92a560` | STRANDED | 0/0/1/0 | 2a8e92a560 |  | apps/mvp/e2e/dogfood.spec.ts: +  annotation: { type: "summary", description: "Two TODOs be |
| 2026-10-21 13:15 | `cddffcc35b` | SUPERSEDED | 7/22/0/0 | fd1e672266 | ✨ feat(mvp): a pull request's checks run on a throwaway job machine th | .smithers/checks/check.sh: landed as 5cfacfa483 (same author and time, committed later) |
| 2026-10-21 13:20 | `5cb48e96f5` | ON-MAIN | 7/0/0/0 | a2cc4468ea | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `cddadfe2f2` | ON-MAIN | 7/0/0/0 | 4a47b426e6 | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `714ebc8b4b` | ON-MAIN | 7/0/0/0 | 43007b0fd8 | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `b4f5581758` | ON-MAIN | 7/0/0/0 | 32e5a252c9 | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `780c021825` | ON-MAIN | 7/0/0/0 | 08d0af64a1 | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `d16227b44c` | ON-MAIN | 7/0/0/0 | e40338f43b | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `135140b9e0` | SUPERSEDED | 6/1/0/0 | 17e2945bbf | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe | apps/mvp/e2e/target.test.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `607b793457` | ON-MAIN | 7/0/0/0 | fa5176b235 | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `c9b2102f21` | SUPERSEDED | 0/1/0/0 | c9b2102f21 |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `bcb6e3124c` | SUPERSEDED | 0/1/0/0 | bcb6e3124c |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `b20d32561c` | SUPERSEDED | 3/1/0/0 | b20d32561c |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `3a92d94250` | SUPERSEDED | 0/1/0/0 | 3a92d94250 |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `17a0b5addc` | SUPERSEDED | 0/1/0/0 | 17a0b5addc |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `67c1bc661f` | ON-MAIN | 7/0/0/0 | 3bfa24b71f | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `cd3478b0c2` | SUPERSEDED | 0/1/0/0 | cd3478b0c2 |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `ac93b8b123` | SUPERSEDED | 0/1/0/0 | ac93b8b123 |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `3443e5d126` | SUPERSEDED | 3/1/0/0 | 3443e5d126 |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `4a3b857a67` | ON-MAIN | 7/0/0/0 | b81df565e1 | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `aec510490c` | SUPERSEDED | 0/1/0/0 | aec510490c |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `a997886458` | SUPERSEDED | 0/1/0/0 | a997886458 |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `f6c369a553` | ON-MAIN | 7/0/0/0 | b008dcea7c | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `fb23abf0de` | PARTIAL | 1/0/10/1 | e1095b962f | 🐛 fix(mvp): a run on Cloudflare is read again only when its change fee | apps/mvp/docs/features/runs.md: - **Live, with no polling.** The engine keeps a change fee |
| 2026-10-21 13:20 | `d88d0cf0df` | PARTIAL | 1/0/10/1 | d88d0cf0df | 🐛 fix(mvp): a run on Cloudflare is read again only when its change fee | apps/mvp/docs/features/runs.md: - **Live, with no polling.** The engine keeps a change fee |
| 2026-10-21 13:20 | `5a4cd7d7dc` | SUPERSEDED | 3/1/0/0 | 5a4cd7d7dc |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `04db310802` | SUPERSEDED | 0/1/0/0 | 04db310802 |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `382989663b` | ON-MAIN | 7/0/0/0 | aec510490c | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `13bea63da1` | ON-MAIN | 7/0/0/0 | 6a94dc267e | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `fd1e672266` | SUPERSEDED | 0/1/0/0 | fd1e672266 |  | apps/mvp/e2e/dogfood.spec.ts: landed as 1e8e60737e (same author and time, committed later) |
| 2026-10-21 13:20 | `81506923f0` | ON-MAIN | 7/0/0/0 | fd1e672266 | ✅ test(mvp): the dogfood loop's e2e: a real issue on smithersai/smithe |  |
| 2026-10-21 13:20 | `197cebb305` | PARTIAL | 1/0/10/1 | 197cebb305 |  | apps/mvp/docs/features/runs.md: - **Live, with no polling.** The engine keeps a change fee |
| 2026-10-21 13:22 | `5f6597b393` | SUPERSEDED | 17/4/0/0 | 2f0bd0d362 | 🐛 fix(flow): ExternalJob abandons a key whose start never answered, an | packages/smithers/flows/flow/docs/api.md: main carried then changed it: 6bc0238ea3 (🐛 fix( |
| 2026-10-21 13:22 | `db7706a77c` | PARTIAL | 1/0/14/2 | 62778583ba | 🐛 fix(agent): ExternalAgent cancels a job by key when its start never  | .changeset/agent-external-agent.md: session), cancels its job on timeout or cancellation ( |
| 2026-10-21 13:22 | `27a8989df0` | SUPERSEDED | 17/4/0/0 | 62778583ba | 🐛 fix(flow): ExternalJob abandons a key whose start never answered, an | packages/smithers/flows/flow/docs/api.md: main carried then changed it: 6bc0238ea3 (🐛 fix( |
| 2026-10-21 13:22 | `49a0c2f3b2` | PARTIAL | 1/0/14/2 | cb85ebcf38 | 🐛 fix(agent): ExternalAgent cancels a job by key when its start never  | .changeset/agent-external-agent.md: session), cancels its job on timeout or cancellation ( |
| 2026-10-21 13:22 | `1d9ee04a93` | SUPERSEDED | 17/4/0/0 | cb85ebcf38 | 🐛 fix(flow): ExternalJob abandons a key whose start never answered, an | packages/smithers/flows/flow/docs/api.md: main carried then changed it: 6bc0238ea3 (🐛 fix( |
| 2026-10-21 13:22 | `2cdb7811eb` | PARTIAL | 15/3/6/2 | 2cdb7811eb |  | packages/smithers/agent/src/AgentRunner.ts: * `cancel` of a key not started yet ends it to |
| 2026-10-21 13:26 | `4513685cc2` | EMPTY-ISH | 0/0/0/0 | 4513685cc2 | 🔧 build(index): regenerate .smithers/target-index.json for the McpServ |  |
| 2026-10-21 13:27 | `a98f91e433` | SUPERSEDED | 0/1/0/0 | bdbbf3bb25 | 🔧 chore(mvp): give the branch sandbox image Node 26.5.0 and pnpm 11.25 | apps/mvp/infra/sandbox/Dockerfile: main carried then changed it: e3a4a95b63 (✨ feat(mvp): |
| 2026-10-21 13:37 | `a2a30cf4ff` | SUPERSEDED | 37/6/0/0 | a2cc4468ea | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `f650904f7e` | SUPERSEDED | 37/6/0/0 | 4a47b426e6 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `fdf013c26d` | SUPERSEDED | 37/6/0/0 | 43007b0fd8 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `9517f69023` | SUPERSEDED | 37/6/0/0 | fa5176b235 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `c0a47af784` | PARTIAL | 39/9/1/0 | c0a47af784 |  | apps/mvp/evals/session.ts: +  return { modelId: model.modelId, trial, cap }; apps/mvp/docs |
| 2026-10-21 13:37 | `e1647df8c8` | SUPERSEDED | 37/6/0/0 | 182c15c7f8 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `4725c2b4f9` | SUPERSEDED | 37/6/0/0 | ca2049bfe8 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `3994b5bb5e` | SUPERSEDED | 37/6/0/0 | 84d9ec003d | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `36a766840d` | SUPERSEDED | 37/6/0/0 | e277aa90b2 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `b6b7876f19` | SUPERSEDED | 37/6/0/0 | 9690d66623 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `487765883f` | SUPERSEDED | 37/6/0/0 | c34fffd1da | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `ed48349104` | SUPERSEDED | 37/6/0/0 | 98df062f2f | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `4db9d4d861` | SUPERSEDED | 37/6/0/0 | 985aa1c5af | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `b375db965a` | SUPERSEDED | 37/6/0/0 | e268a29c73 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `1283a1bcab` | SUPERSEDED | 37/6/0/0 | b008dcea7c | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `e8e86d7611` | SUPERSEDED | 37/6/0/0 | 10816fe72b | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `0c9ca85060` | ON-MAIN | 1/0/0/0 | b12047308c | ♻️ refactor(mvp): the head's review is written through Action.once, ke |  |
| 2026-10-21 13:37 | `0dc96a8851` | SUPERSEDED | 16/1/0/0 | b12047308c | 💥 feat(sandbox)!: SandboxMerge.apply requires a key; a landed change i | packages/smithers/test/CloudSandboxWork.test.ts: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 13:37 | `e680270fb2` | ON-MAIN | 1/0/0/0 | ac996be8c8 | ♻️ refactor(mvp): the head's review is written through Action.once, ke |  |
| 2026-10-21 13:37 | `697abc129c` | SUPERSEDED | 16/1/0/0 | ac996be8c8 | 💥 feat(sandbox)!: SandboxMerge.apply requires a key; a landed change i | packages/smithers/test/CloudSandboxWork.test.ts: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 13:37 | `287c4e5b7c` | ON-MAIN | 1/0/0/0 | dd12f89340 | ♻️ refactor(mvp): the head's review is written through Action.once, ke |  |
| 2026-10-21 13:37 | `241e6e7831` | SUPERSEDED | 16/1/0/0 | dd12f89340 | 💥 feat(sandbox)!: SandboxMerge.apply requires a key; a landed change i | packages/smithers/test/CloudSandboxWork.test.ts: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 13:37 | `505dbf8ba6` | SUPERSEDED | 37/6/0/0 | 3dd43987e7 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `0b415cd0aa` | SUPERSEDED | 37/6/0/0 | fcf850ee1d | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `699af8881a` | SUPERSEDED | 37/6/0/0 | dcd274e4b1 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `1ece3c2d19` | PARTIAL | 39/9/1/0 | 1ece3c2d19 |  | apps/mvp/evals/session.ts: +  return { modelId: model.modelId, trial, cap }; apps/mvp/docs |
| 2026-10-21 13:37 | `d499494ce0` | SUPERSEDED | 37/6/0/0 | 5268957e32 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `ccba41651c` | SUPERSEDED | 37/6/0/0 | 35b00bcc5f | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `62d981642a` | ON-MAIN | 1/0/0/0 | 5cb08384b1 | ♻️ refactor(mvp): the head's review is written through Action.once, ke |  |
| 2026-10-21 13:37 | `6f5f5abed4` | SUPERSEDED | 37/6/0/0 | 464b1cb892 | ✅ test(mvp): production remote flows run, so the remoteFlows mark goes | apps/mvp/docs/infrastructure.md: main carried then changed it: 3ecd07873e (✅ test(mvp): pr |
| 2026-10-21 13:37 | `1cadd90544` | SUPERSEDED | 29/12/0/0 | 1cadd90544 |  | apps/mvp/PACKAGE.ts: main carried then changed it: 36ebd46a94 (🐛 fix(mvp): a person's tria |
| 2026-10-21 13:37 | `59b3608307` | SUPERSEDED | 17/1/0/0 | 5cb08384b1 | 💥 feat(sandbox)!: SandboxMerge.apply requires a key; a landed change i | packages/smithers/test/CloudSandboxWork.test.ts: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 13:40 | `83e743ada5` | SUPERSEDED | 19/1/0/0 | 4e803f491a | 🔊 feat(sandbox): say which step of a sandbox tool failed | packages/smithers/flows/sandbox/src/SandboxTools/index.ts: main carried then changed it: 7 |
| 2026-10-21 13:40 | `924ae3954b` | SUPERSEDED | 20/1/0/0 | 924ae3954b |  | packages/smithers/flows/sandbox/src/SandboxTools/index.ts: main carried then changed it: 7 |
| 2026-10-21 13:40 | `78a991ada8` | SUPERSEDED | 20/1/0/0 | 78a991ada8 |  | packages/smithers/flows/sandbox/src/SandboxTools/index.ts: main carried then changed it: 7 |
| 2026-10-21 13:41 | `4d22fda458` | SUPERSEDED | 2/1/0/0 | 0b93fc6d9a | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `e27ed3567a` | SUPERSEDED | 39/5/0/0 | 0b93fc6d9a | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `dfed720479` | SUPERSEDED | 2/1/0/0 | 0bbf6b3fbd | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `3590c39c06` | SUPERSEDED | 39/5/0/0 | 0bbf6b3fbd | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `ffdf4e0a21` | SUPERSEDED | 2/1/0/0 | 8d811f68cb | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `aa429f8801` | SUPERSEDED | 39/5/0/0 | 8d811f68cb | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `3605f13d76` | SUPERSEDED | 2/1/0/0 | 72a73899be | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `64f1b3d081` | SUPERSEDED | 39/5/0/0 | 72a73899be | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `d4fdb6cb41` | SUPERSEDED | 2/1/0/0 | 104a7b5e07 | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `a1d5c1a3ed` | SUPERSEDED | 39/5/0/0 | 104a7b5e07 | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `ee798971ee` | SUPERSEDED | 2/1/0/0 | 331891126f | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `3c316377a0` | SUPERSEDED | 39/5/0/0 | 331891126f | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `750133cb7f` | SUPERSEDED | 2/1/0/0 | 9ef520910f | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `b2903cc6c4` | SUPERSEDED | 39/5/0/0 | 9ef520910f | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `4d7fa58548` | SUPERSEDED | 2/1/0/0 | cc19e2287a | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `ca552df9bf` | SUPERSEDED | 39/5/0/0 | cc19e2287a | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `495a54c36d` | SUPERSEDED | 2/1/0/0 | 245fc53d61 | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `af17d164c8` | SUPERSEDED | 39/5/0/0 | 245fc53d61 | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `fa6cfbba0c` | PARTIAL | 8/4/1/0 | a2cc4468ea | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/todos.md: \\\\\\\\\\\        to: nsyzkzuu f2aec3e9 "🐛 fix(mvp): an |
| 2026-10-21 13:41 | `14a5454ec3` | SUPERSEDED | 2/1/0/0 | 43007b0fd8 | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `45d00a1dcd` | SUPERSEDED | 39/5/0/0 | 43007b0fd8 | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `710cc37c1e` | PARTIAL | 8/4/1/0 | 4a47b426e6 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/todos.md: \\\\\\\\\\\        to: nsyzkzuu f2aec3e9 "🐛 fix(mvp): an |
| 2026-10-21 13:41 | `0906140bdb` | SUPERSEDED | 8/4/0/0 | 43007b0fd8 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: landed as 9f203eadfe (same author and time, committ |
| 2026-10-21 13:41 | `42648631b7` | SUPERSEDED | 9/3/0/0 | fa5176b235 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `c34fffd1da` | SUPERSEDED | 7/5/0/0 | c34fffd1da | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `e277aa90b2` | SUPERSEDED | 7/5/0/0 | e277aa90b2 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `ca2049bfe8` | SUPERSEDED | 7/5/0/0 | ca2049bfe8 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `98df062f2f` | SUPERSEDED | 7/5/0/0 | 98df062f2f | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `84d9ec003d` | SUPERSEDED | 7/5/0/0 | 84d9ec003d | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `985aa1c5af` | SUPERSEDED | 7/5/0/0 | 985aa1c5af | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `9690d66623` | SUPERSEDED | 7/5/0/0 | 9690d66623 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `49d26f1692` | SUPERSEDED | 9/3/0/0 | 182c15c7f8 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `e268a29c73` | SUPERSEDED | 7/5/0/0 | e268a29c73 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `3314ec3a48` | PARTIAL | 28/28/4/1 | 4ab24343c4 | 🐛 fix(github): fence projections and preserve merge outcomes | apps/mvp/db/Database.ts: import githubProjectionFences from "./migrations/0038_github_proj |
| 2026-10-21 13:41 | `1cabd1f1c2` | PARTIAL | 28/28/4/1 | 1cabd1f1c2 |  | apps/mvp/db/Database.ts: import githubProjectionFences from "./migrations/0038_github_proj |
| 2026-10-21 13:41 | `3f0c3c903e` | SUPERSEDED | 2/1/0/0 | b008dcea7c | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `ab4988d5f2` | SUPERSEDED | 39/5/0/0 | b008dcea7c | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:41 | `b11230d9fe` | SUPERSEDED | 9/3/0/0 | b008dcea7c | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `2700fb6351` | PARTIAL | 28/28/4/1 | 2700fb6351 |  | apps/mvp/db/Database.ts: import githubProjectionFences from "./migrations/0038_github_proj |
| 2026-10-21 13:41 | `10816fe72b` | SUPERSEDED | 7/5/0/0 | 10816fe72b | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `fdce0b53f1` | SUPERSEDED | 4/2/0/0 | b12047308c | 🐛 fix(mvp): a draft an agent or slash command starts is named by its e | apps/mvp/src/features/flows-ui/flows.test.ts: main carried then changed it: b120140226 (✨ |
| 2026-10-21 13:41 | `ad7ea6807c` | ON-MAIN | 7/0/0/0 | b12047308c | 🐛 fix(mvp): spend alert delivery is declared irreversible and at least |  |
| 2026-10-21 13:41 | `d3b18bd69a` | ON-MAIN | 2/0/0/0 | b12047308c | ♻️ refactor(mvp): triage's repro request and rejection comment are wri |  |
| 2026-10-21 13:41 | `11d8c9cf9b` | SUPERSEDED | 4/2/0/0 | ac996be8c8 | 🐛 fix(mvp): a draft an agent or slash command starts is named by its e | apps/mvp/src/features/flows-ui/flows.test.ts: main carried then changed it: b120140226 (✨ |
| 2026-10-21 13:41 | `8fb7bbb345` | ON-MAIN | 7/0/0/0 | ac996be8c8 | 🐛 fix(mvp): spend alert delivery is declared irreversible and at least |  |
| 2026-10-21 13:41 | `ff881f6d6f` | ON-MAIN | 2/0/0/0 | ac996be8c8 | ♻️ refactor(mvp): triage's repro request and rejection comment are wri |  |
| 2026-10-21 13:41 | `29c80464fb` | SUPERSEDED | 4/2/0/0 | dd12f89340 | 🐛 fix(mvp): a draft an agent or slash command starts is named by its e | apps/mvp/src/features/flows-ui/flows.test.ts: main carried then changed it: b120140226 (✨ |
| 2026-10-21 13:41 | `4b120700b1` | ON-MAIN | 7/0/0/0 | dd12f89340 | 🐛 fix(mvp): spend alert delivery is declared irreversible and at least |  |
| 2026-10-21 13:41 | `ad1e21a331` | ON-MAIN | 2/0/0/0 | dd12f89340 | ♻️ refactor(mvp): triage's repro request and rejection comment are wri |  |
| 2026-10-21 13:41 | `3dd43987e7` | SUPERSEDED | 7/5/0/0 | 3dd43987e7 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `fcf850ee1d` | SUPERSEDED | 7/5/0/0 | fcf850ee1d | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `4949a83285` | PARTIAL | 52/81/4/2 | 4949a83285 |  | apps/mvp/db/Database.ts: import githubProjectionFences from "./migrations/0038_github_proj |
| 2026-10-21 13:41 | `dcd274e4b1` | SUPERSEDED | 7/5/0/0 | dcd274e4b1 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `35b00bcc5f` | SUPERSEDED | 7/5/0/0 | 35b00bcc5f | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `0f4f5d6c01` | SUPERSEDED | 9/3/0/0 | 5268957e32 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `28873e59cd` | PARTIAL | 22/8/2/3 | 28873e59cd |  | apps/mvp/docs/work/github-ordering-fixes.md: status: in-progress; apps/mvp/worker/github/A |
| 2026-10-21 13:41 | `3b17fe4b72` | PARTIAL | 22/8/2/3 | 3b17fe4b72 |  | apps/mvp/docs/work/github-ordering-fixes.md: status: in-progress; apps/mvp/worker/github/A |
| 2026-10-21 13:41 | `6d227a6d45` | PARTIAL | 0/0/17/2 | 6b11187a07 | ⬆️ chore(repo-view): pin @pierre/diffs 1.5.2 and let pierre settle the | .changeset/repo-view-pierre-diffs-1-5-2.md: hands worker errors to the pool's `onWorkerErr |
| 2026-10-21 13:41 | `4e1d69c168` | SUPERSEDED | 4/2/0/0 | 5cb08384b1 | 🐛 fix(mvp): a draft an agent or slash command starts is named by its e | apps/mvp/src/features/flows-ui/flows.test.ts: main carried then changed it: b120140226 (✨ |
| 2026-10-21 13:41 | `01c93f08de` | ON-MAIN | 7/0/0/0 | 5cb08384b1 | 🐛 fix(mvp): spend alert delivery is declared irreversible and at least |  |
| 2026-10-21 13:41 | `7a2012ca17` | ON-MAIN | 2/0/0/0 | 5cb08384b1 | ♻️ refactor(mvp): triage's repro request and rejection comment are wri |  |
| 2026-10-21 13:41 | `464b1cb892` | SUPERSEDED | 7/5/0/0 | 464b1cb892 | 🐛 fix(mvp): an eval run fails when it spends past its token cap, the l | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 13:41 | `a5e2df4749` | STRANDED | 0/0/1/0 | a5e2df4749 |  | packages/smithers/ui/repo-view/package.json: "@pierre/diffs": "1.5.2", |
| 2026-10-21 13:41 | `71d5e4bfcc` | SUPERSEDED | 2/1/0/0 | cdb1160df9 | ✅ test(mvp): a new Cloudflare tail waits until it streams before a tes | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 13:41 | `eb967bc797` | SUPERSEDED | 39/5/0/0 | cdb1160df9 | 🐛 fix(mvp): a clone request is persisted and answered at once; the ask | apps/mvp/docs/features/repo.md: main carried then changed it: 402074942b (🐛 fix(mvp): sett |
| 2026-10-21 13:42 | `e18258be21` | PARTIAL | 19/5/11/0 | e18258be21 | 📝 docs: regenerate the site's API pages, llms files, redirect map and  | apps/site/public/llms-full.txt: `@smthrs/agent` exports thirty modules from its root entry |
| 2026-10-21 13:42 | `188091f36c` | SUPERSEDED | 15/8/0/0 | b12047308c | 🐛 fix(integrations): UpsertComment and CheckRun default their key to t | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 62c96995ba |
| 2026-10-21 13:42 | `f7c129cc54` | ON-MAIN | 1/0/0/0 | b12047308c | 📝 docs(mvp): the durable external effects proposal: the migration as d |  |
| 2026-10-21 13:42 | `b13c95ad11` | SUPERSEDED | 0/2/0/0 | b12047308c | 🚨 chore(mvp): durable.external-writes-once also forbids raw review wri | apps/mvp/PACKAGE.ts: main carried then changed it: 36ebd46a94 (🐛 fix(mvp): a person's tria |
| 2026-10-21 13:42 | `bec4a694a1` | SUPERSEDED | 15/8/0/0 | ac996be8c8 | 🐛 fix(integrations): UpsertComment and CheckRun default their key to t | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 62c96995ba |
| 2026-10-21 13:42 | `e2cb6a16a4` | ON-MAIN | 1/0/0/0 | ac996be8c8 | 📝 docs(mvp): the durable external effects proposal: the migration as d |  |
| 2026-10-21 13:42 | `b4766f753a` | SUPERSEDED | 0/2/0/0 | ac996be8c8 | 🚨 chore(mvp): durable.external-writes-once also forbids raw review wri | apps/mvp/PACKAGE.ts: main carried then changed it: 36ebd46a94 (🐛 fix(mvp): a person's tria |
| 2026-10-21 13:42 | `b33e08f40f` | SUPERSEDED | 15/8/0/0 | dd12f89340 | 🐛 fix(integrations): UpsertComment and CheckRun default their key to t | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 62c96995ba |
| 2026-10-21 13:42 | `8c4fb4518f` | ON-MAIN | 1/0/0/0 | dd12f89340 | 📝 docs(mvp): the durable external effects proposal: the migration as d |  |
| 2026-10-21 13:42 | `996b4b386e` | SUPERSEDED | 0/2/0/0 | dd12f89340 | 🚨 chore(mvp): durable.external-writes-once also forbids raw review wri | apps/mvp/PACKAGE.ts: main carried then changed it: 36ebd46a94 (🐛 fix(mvp): a person's tria |
| 2026-10-21 13:42 | `89606879c4` | SUPERSEDED | 15/8/0/0 | 5cb08384b1 | 🐛 fix(integrations): UpsertComment and CheckRun default their key to t | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 62c96995ba |
| 2026-10-21 13:42 | `905d44bb56` | PARTIAL | 19/5/11/0 | 62778583ba | 📝 docs: regenerate the site's API pages, llms files, redirect map and  | apps/site/public/llms-full.txt: `@smthrs/agent` exports thirty modules from its root entry |
| 2026-10-21 13:42 | `1d8038d962` | ON-MAIN | 1/0/0/0 | 5cb08384b1 | 📝 docs(mvp): the durable external effects proposal: the migration as d |  |
| 2026-10-21 13:42 | `076c6acd10` | SUPERSEDED | 0/2/0/0 | 5cb08384b1 | 🚨 chore(mvp): durable.external-writes-once also forbids raw review wri | apps/mvp/PACKAGE.ts: main carried then changed it: 36ebd46a94 (🐛 fix(mvp): a person's tria |
| 2026-10-21 13:44 | `040001c3ef` | STRANDED | 0/0/2/0 | 040001c3ef |  | apps/mvp/docs/work/issue-credentials-hardening.md: updated: 2026-10-21 13:15 PDT; apps/mvp |
| 2026-10-21 13:48 | `d763926195` | SUPERSEDED | 12/8/0/0 | 0b93fc6d9a | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `3d3d672a8b` | SUPERSEDED | 12/8/0/0 | 0bbf6b3fbd | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `2d03014b11` | SUPERSEDED | 12/8/0/0 | 8d811f68cb | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `1e5a6e989b` | SUPERSEDED | 12/8/0/0 | 72a73899be | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `da75910020` | SUPERSEDED | 12/8/0/0 | 104a7b5e07 | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `81c23d2ec5` | SUPERSEDED | 12/8/0/0 | 331891126f | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `1fe8c66f4d` | SUPERSEDED | 12/8/0/0 | 9ef520910f | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `cf1f188339` | SUPERSEDED | 12/8/0/0 | cc19e2287a | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `245fc53d61` | SUPERSEDED | 12/8/0/0 | 245fc53d61 | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `43007b0fd8` | SUPERSEDED | 12/8/0/0 | 43007b0fd8 | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 13:48 | `b008dcea7c` | SUPERSEDED | 11/9/0/0 | b008dcea7c | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: landed as dcde3214c5 (same author and time, committed later) |
| 2026-10-21 13:48 | `713f259c78` | SUPERSEDED | 11/9/0/0 | cdb1160df9 | 🐛 fix(mvp): a branch made while the default branch's head stays put sh | apps/mvp/db/Database.ts: landed as dcde3214c5 (same author and time, committed later) |
| 2026-10-21 13:51 | `b68eed23e3` | PARTIAL | 36/5/3/0 | 4ab24343c4 | 🐛 fix(mvp): a person's triage wins over the flow's whatever order the  | apps/mvp/db/Database.ts: import triageWriteClaims from "./migrations/0040_triage_write_cla |
| 2026-10-21 13:51 | `93b19b5bf5` | PARTIAL | 7/6/3/0 | 4ab24343c4 | ✨ feat(integrations): GitHub.Once.merge merges once and finds the merg | apps/site/public/llms-full.txt: \| `merge` \| `(owner, repo, number, { sha, method, commit |
| 2026-10-21 13:51 | `558ff6d73e` | PARTIAL | 16/24/2/0 | 4ab24343c4 | 🔒️ fix(mvp): a home counts a session's role only on the repository it  | apps/mvp/e2e/target.test.ts: expect(unmet).toEqual(["effectRoles", "webhookSecret", "alert |
| 2026-10-21 13:51 | `c1db2500fc` | PARTIAL | 34/5/3/0 | 2f5b9204b2 | 🐛 fix(mvp): a person's triage wins over the flow's whatever order the  | apps/mvp/db/Database.ts: +import triageWriteClaims from "./migrations/0038_triage_write_cl |
| 2026-10-21 13:51 | `00eafdb909` | PARTIAL | 35/5/3/0 | aba350c47e | 🐛 fix(mvp): a person's triage wins over the flow's whatever order the  | apps/mvp/db/Database.ts: import triageWriteClaims from "./migrations/0039_triage_write_cla |
| 2026-10-21 13:51 | `43aa0ebcdf` | PARTIAL | 7/2/1/0 | 2f5b9204b2 | ✨ feat(integrations): GitHub.Once.merge merges once and finds the merg | packages/smithers/agent/integrations/docs/api.md: \| `merge` \| `(owner, repo, number, { s |
| 2026-10-21 13:51 | `56f7842de0` | PARTIAL | 16/24/2/0 | 2f5b9204b2 | 🔒️ fix(mvp): a home counts a session's role only on the repository it  | apps/mvp/e2e/target.test.ts: expect(unmet).toEqual(["effectRoles", "webhookSecret", "alert |
| 2026-10-21 13:51 | `5ad1e61516` | PARTIAL | 34/5/3/0 | fcb0f1f644 | 🐛 fix(mvp): a person's triage wins over the flow's whatever order the  | apps/mvp/db/Database.ts: import triageWriteClaims from "./migrations/0038_triage_write_cla |
| 2026-10-21 13:51 | `5d6829da09` | PARTIAL | 7/3/3/0 | fcb0f1f644 | ✨ feat(integrations): GitHub.Once.merge merges once and finds the merg | apps/site/src/content/docs/docs/reference/api/integrations.mdx: \| `mergePull` |
| 2026-10-21 13:51 | `662ce2597c` | PARTIAL | 16/24/2/0 | fcb0f1f644 | 🔒️ fix(mvp): a home counts a session's role only on the repository it  | apps/mvp/e2e/target.test.ts: expect(unmet).toEqual(["effectRoles", "webhookSecret", "alert |
| 2026-10-21 13:51 | `63240e86bc` | PARTIAL | 21/5/1/8 | 7ed8110efb | 🐛 fix(mvp): a person's triage wins over the flow's whatever order the  | apps/mvp/docs/features/issues.md: - **A person supersedes the flow, whatever order the lab |
| 2026-10-21 13:51 | `31b27639d3` | PARTIAL | 0/0/5/1 | cdb1160df9 | 🐛 fix(mvp): a failed alert-channel save clears once another device sav | apps/mvp/docs/features/spend-alerts.md: - **Saving:** the Save button's flow runs at once |
| 2026-10-21 13:51 | `439390b66f` | PARTIAL | 4/1/2/3 | 7ed8110efb | ✨ feat(integrations): GitHub.Once.merge merges once and finds the merg | .changeset/github-once-merge.md: taken for the step's own. A rebase merge writes no messag |
| 2026-10-21 13:51 | `1a0a1cc98a` | PARTIAL | 16/24/2/0 | 7ed8110efb | 🔒️ fix(mvp): a home counts a session's role only on the repository it  | apps/mvp/e2e/target.test.ts: expect(unmet).toEqual(["effectRoles", "webhookSecret", "alert |
| 2026-10-21 13:52 | `cdb1160df9` | STRANDED | 0/0/2/0 | cdb1160df9 | 📝 docs(mvp): the prod-flows work note with production evidence as of 1 | apps/mvp/docs/work/prod-flows.md: updated: 2026-10-21 14:05 PDT; apps/mvp/docs/work/prod-f |
| 2026-10-21 13:53 | `78efa227e7` | PARTIAL | 42/8/6/1 | 4ab24343c4 | 🐛 fix(mvp): a merge rechecks the base branch's own head and merges onc | apps/mvp/db/Database.ts: import dropMergeUnknown from "./migrations/0041_drop_merge_unknow |
| 2026-10-21 13:53 | `2f5b9204b2` | PARTIAL | 32/8/1/0 | 2f5b9204b2 | 🐛 fix(mvp): a merge rechecks the base branch's own head and merges onc | apps/mvp/worker/github/test/scriptedGitHub.ts: * The base's commit GitHub reports as `base |
| 2026-10-21 13:53 | `aba350c47e` | PARTIAL | 32/8/1/0 | aba350c47e | 🐛 fix(mvp): a merge rechecks the base branch's own head and merges onc | apps/mvp/worker/github/test/scriptedGitHub.ts: * The base's commit GitHub reports as `base |
| 2026-10-21 13:53 | `fcb0f1f644` | PARTIAL | 30/8/3/0 | fcb0f1f644 | 🐛 fix(mvp): a merge rechecks the base branch's own head and merges onc | apps/mvp/PACKAGE.ts: -      "Action.once with a GitHub.Once adapter, which keys it by the |
| 2026-10-21 13:53 | `7ed8110efb` | PARTIAL | 23/7/4/7 | 7ed8110efb | 🐛 fix(mvp): a merge rechecks the base branch's own head and merges onc | apps/mvp/PACKAGE.ts: "through Action.once with a GitHub.Once adapter, which keys it by the |
| 2026-10-21 13:55 | `d3ee003701` | SUPERSEDED | 13/4/0/0 | 4b4584af3b | 🐛 fix(todos): preserve valid prompts and truthful stack state | apps/mvp/src/features/todos/store.ts: main carried then changed it: 959ed5fca8 (🐛 fix: lan |
| 2026-10-21 13:55 | `bdcc832b31` | SUPERSEDED | 13/4/0/0 | dd60c8c5bf | 🐛 fix(todos): preserve valid prompts and truthful stack state | apps/mvp/src/features/todos/store.ts: main carried then changed it: 959ed5fca8 (🐛 fix: lan |
| 2026-10-21 13:55 | `5c716b8a4e` | SUPERSEDED | 13/4/0/0 | b008dcea7c | 🐛 fix(todos): preserve valid prompts and truthful stack state | apps/mvp/src/features/todos/store.ts: main carried then changed it: 959ed5fca8 (🐛 fix: lan |
| 2026-10-21 13:55 | `3276853346` | SUPERSEDED | 13/4/0/0 | 3276853346 | 🐛 fix(todos): preserve valid prompts and truthful stack state | apps/mvp/src/features/todos/store.ts: main carried then changed it: 959ed5fca8 (🐛 fix: lan |
| 2026-10-21 13:55 | `318e18d004` | SUPERSEDED | 12/5/0/0 | 318e18d004 |  | apps/mvp/docs/work/todo-boundary-regressions.md: landed as cb3e557601 (same author and tim |
| 2026-10-21 13:55 | `a244a7225b` | SUPERSEDED | 7/3/0/0 | a244a7225b |  | apps/mvp/docs/work/todo-boundary-regressions.md: landed as cb3e557601 (same author and tim |
| 2026-10-21 13:56 | `b16224347f` | ON-MAIN | 12/0/0/0 | 2f18041e12 | 🐛 fix(flow): persist settlements before publication and contain join l |  |
| 2026-10-21 13:56 | `67736f4842` | SUPERSEDED | 5/1/0/0 | 67736f4842 |  | apps/mvp/e2e/logs.ts: main carried then changed it: 7e55daf25f (🔎 fix(mvp): validate produ |
| 2026-10-21 14:00 | `b12047308c` | SUPERSEDED | 15/2/0/0 | b12047308c | 🐛 fix(flow)!: a DurableQueue item runs as a durable execution; a recor | packages/smithers/flows/flow/src/DurableQueue.ts: main carried then changed it: ede7c1e0b6 |
| 2026-10-21 14:00 | `ac996be8c8` | SUPERSEDED | 15/2/0/0 | ac996be8c8 | 🐛 fix(flow)!: a DurableQueue item runs as a durable execution; a recor | packages/smithers/flows/flow/src/DurableQueue.ts: main carried then changed it: ede7c1e0b6 |
| 2026-10-21 14:00 | `dd12f89340` | SUPERSEDED | 15/2/0/0 | dd12f89340 | 🐛 fix(flow)!: a DurableQueue item runs as a durable execution; a recor | packages/smithers/flows/flow/src/DurableQueue.ts: main carried then changed it: ede7c1e0b6 |
| 2026-10-21 14:00 | `758ee373de` | SUPERSEDED | 15/2/0/0 | 5cb08384b1 | 🐛 fix(flow)!: a DurableQueue item runs as a durable execution; a recor | packages/smithers/flows/flow/src/DurableQueue.ts: main carried then changed it: ede7c1e0b6 |
| 2026-10-21 14:00 | `b9ee2951c4` | SUPERSEDED | 5/4/0/0 | b9ee2951c4 |  | packages/smithers/flows/flow/src/DurableQueue.ts: landed as a625d24531 (same author and ti |
| 2026-10-21 14:03 | `17779a87c9` | STRANDED | 0/0/2/0 | 6b11187a07 | ⬆️ chore(flows): pin @pierre/diffs 1.5.2 for the review flow's diff re | .smithers/flows/package.json: "@pierre/diffs": "1.5.2",; .smithers/flows/review/tests/rend |
| 2026-10-21 14:03 | `b6d3a4ffb2` | PARTIAL | 0/0/1/1 | b6d3a4ffb2 |  | .smithers/flows/package.json: "@pierre/diffs": "1.5.2",; apps/mvp/docs/proposals/pierre-os |
| 2026-10-21 14:03 | `b763b2c97b` | PARTIAL | 0/0/0/1 | b763b2c97b |  | apps/mvp/docs/proposals/pierre-oss-survey.md: - Docs: `docs/reference/contracts.md` and `d |
| 2026-10-21 14:07 | `0b9034bb1b` | PARTIAL | 13/3/8/0 | 0b9034bb1b | 🐛 fix(flow): preserve payload sources and safe durable replay | apps/mvp/docs/work/flow-source-regressions-751129.md: - `pnpm exec vitest run test/GraphRe |
| 2026-10-21 14:07 | `bfcb08d420` | PARTIAL | 11/3/9/1 | bfcb08d420 |  | apps/mvp/docs/work/flow-source-regressions-751129.md: title: Flow source regression fixes; |
| 2026-10-21 14:07 | `aaf17365b7` | PARTIAL | 8/2/8/4 | aaf17365b7 |  | apps/mvp/docs/work/flow-source-regressions-751129.md: title: Flow source regression fixes; |
| 2026-10-21 14:10 | `8976dd2d49` | ON-MAIN | 31/0/0/0 | 8976dd2d49 | 🐛 fix(engine): preserve cancellation authority and safe lineage admiss |  |
| 2026-10-21 14:17 | `6b11187a07` | PARTIAL | 1/0/1/0 | 6b11187a07 | 📝 docs(mvp): survey Pierre's open source for the code views, with benc | apps/mvp/docs/work/pierre-diffs-upgrades.md: **Why:** Will asked on 2026-10-21 what of Pie |
| 2026-10-21 14:17 | `ea9f72d317` | PARTIAL | 0/0/0/1 | ea9f72d317 |  | apps/mvp/docs/proposals/pierre-oss-survey.md: - Docs: `docs/reference/contracts.md` and `d |
| 2026-10-21 14:21 | `051a722892` | PARTIAL | 3/0/93/3 | 62778583ba | 🔒 fix(agent,cli): the runner resumes a started session, stops on a los | .changeset/agent-harness-cli.md: `HarnessCli.toolsAllowed` and `HarnessCli.onSubscription` |
| 2026-10-21 14:21 | `363f83c1c0` | PARTIAL | 3/0/93/3 | 363f83c1c0 | 🔒 fix(agent,cli): the runner resumes a started session, stops on a los | .changeset/agent-harness-cli.md: `HarnessCli.toolsAllowed` and `HarnessCli.onSubscription` |
| 2026-10-21 14:23 | `a42c8a7bfc` | SUPERSEDED | 1/2/0/0 | a2cc4468ea | 📝 docs(mvp): the production e2e work note after remote flows ran; them | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 86bd1f7cb3 (📝 docs(mvp): the |
| 2026-10-21 14:23 | `e39cc3f121` | SUPERSEDED | 1/2/0/0 | 43007b0fd8 | 📝 docs(mvp): the production e2e work note after remote flows ran; them | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 86bd1f7cb3 (📝 docs(mvp): the |
| 2026-10-21 14:23 | `40a7170de5` | SUPERSEDED | 1/2/0/0 | 4a47b426e6 | 📝 docs(mvp): the production e2e work note after remote flows ran; them | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 86bd1f7cb3 (📝 docs(mvp): the |
| 2026-10-21 14:23 | `961eb273f3` | SUPERSEDED | 1/2/0/0 | fa5176b235 | 📝 docs(mvp): the production e2e work note after remote flows ran; them | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 86bd1f7cb3 (📝 docs(mvp): the |
| 2026-10-21 14:23 | `3228b82a66` | SUPERSEDED | 1/2/0/0 | 182c15c7f8 | 📝 docs(mvp): the production e2e work note after remote flows ran; them | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 86bd1f7cb3 (📝 docs(mvp): the |
| 2026-10-21 14:23 | `21539b5496` | SUPERSEDED | 1/2/0/0 | b008dcea7c | 📝 docs(mvp): the production e2e work note after remote flows ran; them | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 86bd1f7cb3 (📝 docs(mvp): the |
| 2026-10-21 14:23 | `5268957e32` | SUPERSEDED | 1/2/0/0 | 5268957e32 | 📝 docs(mvp): the production e2e work note after remote flows ran; them | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 86bd1f7cb3 (📝 docs(mvp): the |
| 2026-10-21 14:27 | `850106b3a9` | SUPERSEDED | 32/3/0/0 | 850106b3a9 | 🐛 fix(platform-browser): preserve failure delivery and cancellation re | packages/smithers/flows/platform-browser/src/BrowserRuntime.ts: landed as 870122c885 (same |
| 2026-10-21 14:27 | `7db8f80fce` | SUPERSEDED | 20/10/0/0 | 7db8f80fce |  | apps/mvp/docs/work/browser-platform-failure-regressions.md: landed as 870122c885 (same aut |
| 2026-10-21 14:27 | `a2f4b43226` | PARTIAL | 1/0/13/4 | a2f4b43226 |  | apps/mvp/db/migrations/0038_agent_runners.ts: // the runner that claims the job, and never |
| 2026-10-21 14:27 | `c3be9c0f71` | PARTIAL | 17/1/1/6 | c3be9c0f71 |  | apps/mvp/docs/work/browser-platform-failure-regressions.md: status: in-progress; packages/ |
| 2026-10-21 14:31 | `aafdad4fc2` | PARTIAL | 15/1/0/4 | aafdad4fc2 |  | apps/mvp/docs/work/time-travel-evidence-586651.md: allocation and inclusive fork offsets. |
| 2026-10-21 14:32 | `4b4584af3b` | SUPERSEDED | 19/1/0/0 | 4b4584af3b | 🐛 fix(time-travel): preserve consistent boundary and frame evidence | packages/smithers/flows/time-travel/test/Documentation.test.ts: main carried then changed |
| 2026-10-21 14:32 | `89a34240a7` | SUPERSEDED | 17/4/0/0 | 89a34240a7 | 🐛 fix(time-travel): preserve consistent boundary and frame evidence | packages/smithers/flows/time-travel/README.md: landed as 3b02838605 (same author and time, |
| 2026-10-21 14:32 | `91cee7a477` | SUPERSEDED | 17/4/0/0 | 91cee7a477 |  | packages/smithers/flows/time-travel/README.md: landed as 3b02838605 (same author and time, |
| 2026-10-21 14:32 | `183b6a9993` | SUPERSEDED | 15/5/0/0 | 183b6a9993 |  | apps/mvp/docs/work/time-travel-evidence-586651.md: landed as 3b02838605 (same author and t |
| 2026-10-21 14:35 | `2812c0c583` | PARTIAL | 16/1/2/1 | dd60c8c5bf | 🐛 fix(plan): preserve historical scopes and validate safe immutable to | apps/mvp/docs/work/plan-confirmed-bugs-586345.md: Validation runs on Latitude, with failin |
| 2026-10-21 14:35 | `c659b0153c` | PARTIAL | 16/0/3/1 | c659b0153c | 🐛 fix(plan): preserve historical scopes and validate safe immutable to | apps/mvp/docs/work/plan-confirmed-bugs-586345.md: Validation runs on Latitude, with failin |
| 2026-10-21 14:44 | `fb6fa2c572` | SUPERSEDED | 15/1/0/0 | c63dcc4693 | 🐛 fix(sdk): a terminal socket redials on the flow engine's retry decis | packages/smithers/flows/platform-browser/README.md: main carried then changed it: b8f0ff24 |
| 2026-10-21 14:49 | `3d8110d1c5` | PARTIAL | 2/0/14/8 | 3d8110d1c5 | 🐛 fix(time-travel): preserve fork cleanup and historical child state | apps/mvp/docs/work/time-travel-storage-regressions.md: Reproduce and fix the eight reporte |
| 2026-10-21 14:49 | `a3b0e6cbce` | PARTIAL | 2/0/13/7 | a3b0e6cbce |  | apps/mvp/docs/work/time-travel-storage-regressions.md: Reproduce and fix the eight reporte |
| 2026-10-21 14:51 | `8b2455ab7a` | SUPERSEDED | 64/26/0/0 | a2cc4468ea | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:51 | `0d3f74007d` | SUPERSEDED | 64/26/0/0 | 43007b0fd8 | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:51 | `d607c103c6` | SUPERSEDED | 64/26/0/0 | 4a47b426e6 | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:51 | `c9f33ab9d2` | SUPERSEDED | 64/26/0/0 | 32e5a252c9 | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:51 | `dfab1f85cc` | SUPERSEDED | 19/1/0/0 | 4b4584af3b | 🐛 fix(plan): bound arm construction and preserve safe diagnostic attri | packages/smithers/flows/plan/src/Node.ts: main carried then changed it: 03aa079b28 (🐛 fix( |
| 2026-10-21 14:51 | `ad81997e86` | ON-MAIN | 20/0/0/0 | dd60c8c5bf | 🐛 fix(plan): bound arm construction and preserve safe diagnostic attri |  |
| 2026-10-21 14:51 | `cf6a9e2801` | SUPERSEDED | 64/26/0/0 | 08d0af64a1 | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:51 | `068b5293cc` | SUPERSEDED | 64/26/0/0 | fa5176b235 | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:51 | `7aab683d50` | SUPERSEDED | 64/26/0/0 | ff41e80e78 | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:51 | `4c7b9fa01c` | SUPERSEDED | 62/21/0/0 | c8103ca98a | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:51 | `d57a7bb05b` | SUPERSEDED | 61/21/0/0 | 834c49417b | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:51 | `a573dd28f2` | SUPERSEDED | 19/1/0/0 | a573dd28f2 | 🐛 fix(plan): bound arm construction and preserve safe diagnostic attri | packages/smithers/flows/plan/src/Node.ts: main carried then changed it: 03aa079b28 (🐛 fix( |
| 2026-10-21 14:51 | `5cb08384b1` | PARTIAL | 6/1/2/2 | 5cb08384b1 |  | packages/smithers/flows/engine/src/FlowEngine/ActionKey.ts: * own encoding in the key (`ke |
| 2026-10-21 14:51 | `538b7b9572` | SUPERSEDED | 18/2/0/0 | 538b7b9572 |  | apps/mvp/docs/work/plan-validation-175685.md: landed as b8f303640b (same author and time, |
| 2026-10-21 14:51 | `de1e77f10a` | SUPERSEDED | 60/22/0/0 | 2c3ed92c19 | 🔥 refactor(patterns)!: delete WithRetry; a retry is an action's RetryP | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: 68c5bb5dd0 ( |
| 2026-10-21 14:53 | `05183079a4` | SUPERSEDED | 6/3/0/0 | 0b93fc6d9a | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `13472af554` | SUPERSEDED | 6/3/0/0 | 0bbf6b3fbd | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `fdf9f12b6a` | SUPERSEDED | 6/3/0/0 | 72a73899be | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `8a22ffaa40` | SUPERSEDED | 6/3/0/0 | 104a7b5e07 | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `6db5569db8` | SUPERSEDED | 6/3/0/0 | 331891126f | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `0da2629152` | SUPERSEDED | 6/3/0/0 | 9ef520910f | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `fe8f6319ed` | SUPERSEDED | 6/3/0/0 | cc19e2287a | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `9286773f90` | SUPERSEDED | 6/3/0/0 | 9a5507edcc | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `7adf99fa22` | SUPERSEDED | 6/2/0/0 | 8c9a5d26e3 | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `c4ba26abf4` | SUPERSEDED | 6/2/0/0 | c718c8d18f | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `c2a28622ce` | SUPERSEDED | 6/2/0/0 | c2a28622ce | 🐛 fix(mvp): show connection status for the branch conversation | apps/mvp/src/features/chat/chat.ts: main carried then changed it: e700a96856 (✨ feat(mvp): |
| 2026-10-21 14:53 | `5901fa606c` | SUPERSEDED | 5/3/0/0 | 5901fa606c |  | apps/mvp/docs/work/branch-page-regressions.md: landed as aa5cbf5dd8 (same author and time, |
| 2026-10-21 14:53 | `30cfc6ec61` | SUPERSEDED | 3/1/0/0 | 30cfc6ec61 |  | apps/mvp/src/screens/branch/connection.test.ts: main carried then changed it: aa5cbf5dd8 ( |
| 2026-10-21 14:57 | `92b5df97fa` | ON-MAIN | 9/0/0/0 | f0fcc1f28a | ✅ test(mvp): assert visible HTML source in repository pages |  |
| 2026-10-21 14:57 | `9c908417c9` | ON-MAIN | 9/0/0/0 | ef3d9b5979 | ✅ test(mvp): assert visible HTML source in repository pages |  |
| 2026-10-21 14:59 | `f0fcc1f28a` | SUPERSEDED | 5/9/0/0 | f0fcc1f28a | 🐛 fix(mvp): show missing repository metadata in the header immediately | apps/mvp/docs/features/repo.md: main carried then changed it: bcbd38225a (fix(mvp): show a |
| 2026-10-21 14:59 | `236c0d0e44` | SUPERSEDED | 1/1/0/0 | ef3d9b5979 | ✅ test(mvp): distinguish opening absence from clone refusal in the fee | apps/mvp/e2e/repo.spec.ts: main carried then changed it: 9dac89c768 (🧪 test(mvp): distingu |
| 2026-10-21 14:59 | `451018e2c0` | SUPERSEDED | 5/9/0/0 | ef3d9b5979 | 🐛 fix(mvp): show missing repository metadata in the header immediately | apps/mvp/docs/features/repo.md: main carried then changed it: bcbd38225a (fix(mvp): show a |
| 2026-10-21 15:00 | `8640c9e3d5` | ON-MAIN | 31/0/0/0 | 0b93fc6d9a | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener |  |
| 2026-10-21 15:00 | `1bd95866a6` | ON-MAIN | 31/0/0/0 | 72a73899be | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener |  |
| 2026-10-21 15:00 | `54f4c4fa65` | ON-MAIN | 31/0/0/0 | 104a7b5e07 | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener |  |
| 2026-10-21 15:00 | `65cab35954` | ON-MAIN | 31/0/0/0 | 9ef520910f | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener |  |
| 2026-10-21 15:00 | `b463bdeb57` | SUPERSEDED | 30/1/0/0 | 245fc53d61 | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener | packages/smithers/flows/time-travel/test/Documentation.test.ts: landed as 600aa05cf6 (same |
| 2026-10-21 15:00 | `ea352ccb4d` | SUPERSEDED | 30/1/0/0 | 43007b0fd8 | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener | packages/smithers/flows/time-travel/test/Documentation.test.ts: landed as 600aa05cf6 (same |
| 2026-10-21 15:00 | `f008773362` | ON-MAIN | 31/0/0/0 | 1829e9d7ab | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener |  |
| 2026-10-21 15:00 | `2173dcdb8b` | ON-MAIN | 31/0/0/0 | cfb32e285e | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener |  |
| 2026-10-21 15:00 | `f17e71d70d` | ON-MAIN | 27/0/0/0 | f17e71d70d | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener |  |
| 2026-10-21 15:00 | `0646ecf0d0` | SUPERSEDED | 26/1/0/0 | 01e3888243 | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener | packages/smithers/flows/time-travel/docs/api.md: landed as 600aa05cf6 (same author and tim |
| 2026-10-21 15:00 | `b7ee053aa8` | SUPERSEDED | 26/1/0/0 | b7ee053aa8 | 🐛 fix(time-travel): bind rewind commit evidence to the truncated gener | packages/smithers/flows/time-travel/docs/api.md: landed as 600aa05cf6 (same author and tim |
| 2026-10-21 15:00 | `fd43214bf2` | PARTIAL | 19/6/0/2 | fd43214bf2 |  | apps/mvp/docs/work/platform-browser-internal-regressions.md: - Fixed code: `pnpm exec vite |
| 2026-10-21 15:01 | `29f40d0585` | SUPERSEDED | 21/6/0/0 | c63dcc4693 | 🐛 fix(platform-browser): preserve transaction outcomes and resumable c | packages/smithers/flows/platform-browser/docs/concepts/durable-browser-engine.md: main car |
| 2026-10-21 15:01 | `2df6b4ce9d` | SUPERSEDED | 22/6/0/0 | 2df6b4ce9d |  | packages/smithers/flows/platform-browser/docs/concepts/durable-browser-engine.md: main car |
| 2026-10-21 15:01 | `a18ce6bbb6` | PARTIAL | 21/0/0/2 | a18ce6bbb6 |  | apps/mvp/bench/follower-regressions.test.ts: assert.equal(await Promise.race([disconnected |
| 2026-10-21 15:01 | `c35f6d9fb1` | SUPERSEDED | 19/8/0/0 | c35f6d9fb1 |  | apps/mvp/docs/work/platform-browser-internal-regressions.md: landed as b61cf65bd3 (same au |
| 2026-10-21 15:03 | `d88ebfeb38` | ON-MAIN | 23/0/0/0 | 1ea57261a4 | 🐛 fix(mvp-bench): require complete observations and release acquired r |  |
| 2026-10-21 15:03 | `ed74bb2fca` | ON-MAIN | 23/0/0/0 | 5d3efd101f | 🐛 fix(mvp-bench): require complete observations and release acquired r |  |
| 2026-10-21 15:03 | `79103d2673` | ON-MAIN | 23/0/0/0 | 3d6dac6fb7 | 🐛 fix(mvp-bench): require complete observations and release acquired r |  |
| 2026-10-21 15:03 | `3af95efc22` | ON-MAIN | 23/0/0/0 | f1257d53d3 | 🐛 fix(mvp-bench): require complete observations and release acquired r |  |
| 2026-10-21 15:03 | `eca4913f5a` | SUPERSEDED | 37/20/0/0 | a2cc4468ea | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `3f075ae852` | SUPERSEDED | 37/20/0/0 | 43007b0fd8 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `0b5ab34ad7` | SUPERSEDED | 37/20/0/0 | 4a47b426e6 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `cd386561f1` | SUPERSEDED | 37/20/0/0 | 32e5a252c9 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `214ef1894e` | SUPERSEDED | 10/1/0/0 | 4b4584af3b | 🐛 fix(mvp): preserve authorization and replay ordering in worker write | apps/mvp/worker/Views.ts: main carried then changed it: cfb31c3981 (🐛 fix(mvp): preserve a |
| 2026-10-21 15:03 | `7a4645dadb` | SUPERSEDED | 10/1/0/0 | dd60c8c5bf | 🐛 fix(mvp): preserve authorization and replay ordering in worker write | apps/mvp/worker/Views.ts: main carried then changed it: cfb31c3981 (🐛 fix(mvp): preserve a |
| 2026-10-21 15:03 | `d605f7a459` | SUPERSEDED | 37/20/0/0 | 08d0af64a1 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `d809b10d69` | ON-MAIN | 23/0/0/0 | d809b10d69 | 🐛 fix(mvp-bench): require complete observations and release acquired r |  |
| 2026-10-21 15:03 | `a65f2cc732` | SUPERSEDED | 37/20/0/0 | fa5176b235 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `3b3ffdc94c` | SUPERSEDED | 33/17/0/0 | 3b3ffdc94c |  | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `45d6da7d54` | SUPERSEDED | 33/17/0/0 | 45d6da7d54 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `b582b16ba5` | SUPERSEDED | 37/20/0/0 | ff41e80e78 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `5bf869dd55` | SUPERSEDED | 33/17/0/0 | 5bf869dd55 |  | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `1f66b87609` | SUPERSEDED | 33/17/0/0 | 1f66b87609 |  | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `001b7bcf34` | SUPERSEDED | 33/17/0/0 | 001b7bcf34 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `1bf70cf71c` | SUPERSEDED | 33/17/0/0 | 5500254fa2 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `0484864f35` | SUPERSEDED | 33/17/0/0 | c8103ca98a | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `851014befc` | SUPERSEDED | 33/17/0/0 | 9937f548f9 | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `c539a4e7e0` | SUPERSEDED | 33/17/0/0 | c539a4e7e0 |  | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `0ecd648e5b` | SUPERSEDED | 33/17/0/0 | 0ecd648e5b | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `9f24605ced` | SUPERSEDED | 33/17/0/0 | 9f24605ced |  | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `80fea4baaa` | SUPERSEDED | 33/17/0/0 | 834c49417b | 🔥 refactor(patterns)!: delete WithCache; a cache policy is Action.with | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `de3650a43e` | PARTIAL | 10/1/1/1 | de3650a43e | 🐛 fix(mvp): preserve authorization and replay ordering in worker write | apps/mvp/worker/ModelRoles.ts: * so a replayed step leaves newer settings untouched and re |
| 2026-10-21 15:03 | `2c3ed92c19` | SUPERSEDED | 33/17/0/0 | 2c3ed92c19 |  | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: ac22532520 ( |
| 2026-10-21 15:03 | `4e5a3f192b` | SUPERSEDED | 21/2/0/0 | 4e5a3f192b |  | apps/mvp/bench/follower-regressions.test.ts: landed as f0dda22908 (same author and time, c |
| 2026-10-21 15:04 | `75c7949bb0` | ON-MAIN | 5/0/0/0 | 0b93fc6d9a | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `20fb492d05` | ON-MAIN | 5/0/0/0 | 0bbf6b3fbd | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `7f875e533d` | ON-MAIN | 5/0/0/0 | 72a73899be | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `b6f007d8f2` | ON-MAIN | 5/0/0/0 | 104a7b5e07 | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `e6f75101e3` | ON-MAIN | 5/0/0/0 | 331891126f | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `a39c79e682` | ON-MAIN | 5/0/0/0 | 9ef520910f | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `94fa7ddaa2` | ON-MAIN | 5/0/0/0 | cc19e2287a | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `7ac046f073` | ON-MAIN | 5/0/0/0 | 9a5507edcc | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `beccb9ea1c` | ON-MAIN | 5/0/0/0 | 8c9a5d26e3 | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `8516ae220d` | ON-MAIN | 5/0/0/0 | c718c8d18f | 🐛 fix(mvp): initialize the theme before any route opens |  |
| 2026-10-21 15:04 | `ef3d9b5979` | STRANDED | 0/0/1/0 | ef3d9b5979 | 📝 docs(mvp): reconcile the existing remote-flow harness repair | apps/mvp/docs/work/repo-pages-header-and-locators.md: ## Harness reconciliation (step 6) |
| 2026-10-21 15:05 | `fe873eb96b` | ON-MAIN | 8/0/0/0 | 72a73899be | 🐛 fix(time-travel): settle a guarded success whose record failed so th |  |
| 2026-10-21 15:05 | `a22901b853` | ON-MAIN | 8/0/0/0 | 9ef520910f | 🐛 fix(time-travel): settle a guarded success whose record failed so th |  |
| 2026-10-21 15:05 | `30a516789a` | ON-MAIN | 8/0/0/0 | 245fc53d61 | 🐛 fix(time-travel): settle a guarded success whose record failed so th |  |
| 2026-10-21 15:05 | `a7b39870b6` | ON-MAIN | 8/0/0/0 | 43007b0fd8 | 🐛 fix(time-travel): settle a guarded success whose record failed so th |  |
| 2026-10-21 15:05 | `81ccfb6554` | ON-MAIN | 8/0/0/0 | 1829e9d7ab | 🐛 fix(time-travel): settle a guarded success whose record failed so th |  |
| 2026-10-21 15:05 | `8d383d4f87` | ON-MAIN | 8/0/0/0 | cfb32e285e | 🐛 fix(time-travel): settle a guarded success whose record failed so th |  |
| 2026-10-21 15:08 | `04acef4549` | PARTIAL | 0/1/5/0 | 04acef4549 |  | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:08 | `ac07bc9451` | PARTIAL | 0/1/5/0 | ac07bc9451 |  | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:08 | `29e6aa7cbb` | STRANDED | 0/0/4/0 | 29e6aa7cbb |  | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:08 | `063cd73166` | STRANDED | 0/0/4/0 | 063cd73166 |  | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:08 | `0cabd611c1` | PARTIAL | 11/4/0/1 | 0cabd611c1 |  | apps/mvp/worker/flows/Todo.ts: body: GitHub.Issues.withWriteMarker(pullBodyOf(begun, close |
| 2026-10-21 15:08 | `edc2e4c7a1` | PARTIAL | 11/4/4/1 | edc2e4c7a1 |  | apps/mvp/worker/flows/Todo.ts: body: GitHub.Issues.withWriteMarker(pullBodyOf(begun, close |
| 2026-10-21 15:12 | `1821a5f647` | SUPERSEDED | 122/1/0/0 | 1821a5f647 | 🐛 fix(agent)!: model steps retry transient provider failures on the du | packages/smithers/agent/src/internal/ModelStep.ts: main carried then changed it: 0d2a9547c |
| 2026-10-21 15:13 | `d366553c69` | SUPERSEDED | 20/5/0/0 | c63dcc4693 | 🐛 fix(sdk): a leader whose preparation of the app's database failed fe | packages/smithers/flows/platform-browser/src/SharedSqlite.ts: main carried then changed it |
| 2026-10-21 15:13 | `4e1b0f08f1` | ON-MAIN | 15/0/0/0 | 72a73899be | 🐛 fix(time-travel): cut a fork's carried child by its own sequence, ne |  |
| 2026-10-21 15:13 | `f1fbb147a2` | ON-MAIN | 15/0/0/0 | 9ef520910f | 🐛 fix(time-travel): cut a fork's carried child by its own sequence, ne |  |
| 2026-10-21 15:13 | `d3a4ada475` | ON-MAIN | 15/0/0/0 | 245fc53d61 | 🐛 fix(time-travel): cut a fork's carried child by its own sequence, ne |  |
| 2026-10-21 15:13 | `bab3d559cc` | ON-MAIN | 15/0/0/0 | 43007b0fd8 | 🐛 fix(time-travel): cut a fork's carried child by its own sequence, ne |  |
| 2026-10-21 15:13 | `2493b11043` | ON-MAIN | 15/0/0/0 | 1829e9d7ab | 🐛 fix(time-travel): cut a fork's carried child by its own sequence, ne |  |
| 2026-10-21 15:13 | `94cd1d638b` | ON-MAIN | 15/0/0/0 | cfb32e285e | 🐛 fix(time-travel): cut a fork's carried child by its own sequence, ne |  |
| 2026-10-21 15:13 | `a9a0cca0a4` | SUPERSEDED | 5/9/0/0 | a9a0cca0a4 | 🐛 fix(time-travel): cut a fork's carried child by its own sequence, ne | .changeset/time-travel-carried-child-causal-cut.md: landed as 0d26fe49b6 (same author and |
| 2026-10-21 15:14 | `67b8312a76` | SUPERSEDED | 29/21/0/0 | dcd6da80eb | 🐛 fix(mvp): recover attention launches and refresh branch notices | apps/mvp/docs/features/notifications.md: main carried then changed it: 4a6932b47d (fix(mvp |
| 2026-10-21 15:14 | `758cccf697` | ON-MAIN | 15/0/0/0 | a2cc4468ea | 🐛 fix(core): Digest.canonical serializes without running an Effect |  |
| 2026-10-21 15:14 | `b757117805` | ON-MAIN | 15/0/0/0 | 43007b0fd8 | 🐛 fix(core): Digest.canonical serializes without running an Effect |  |
| 2026-10-21 15:14 | `b97d87a4e0` | ON-MAIN | 15/0/0/0 | 4a47b426e6 | 🐛 fix(core): Digest.canonical serializes without running an Effect |  |
| 2026-10-21 15:14 | `af11d25feb` | ON-MAIN | 15/0/0/0 | 32e5a252c9 | 🐛 fix(core): Digest.canonical serializes without running an Effect |  |
| 2026-10-21 15:14 | `480e6f6b26` | ON-MAIN | 15/0/0/0 | 08d0af64a1 | 🐛 fix(core): Digest.canonical serializes without running an Effect |  |
| 2026-10-21 15:14 | `45b20ff6e0` | ON-MAIN | 15/0/0/0 | fa5176b235 | 🐛 fix(core): Digest.canonical serializes without running an Effect |  |
| 2026-10-21 15:14 | `c718c8d18f` | SUPERSEDED | 24/15/0/0 | c718c8d18f | 🐛 fix(mvp): recover attention launches and refresh branch notices | apps/mvp/docs/features/notifications.md: main carried then changed it: 4a6932b47d (fix(mvp |
| 2026-10-21 15:14 | `fb37f6edff` | ON-MAIN | 15/0/0/0 | b2604d9a24 | 🐛 fix(core): Digest.canonical serializes without running an Effect |  |
| 2026-10-21 15:14 | `285b181362` | ON-MAIN | 15/0/0/0 | 44072e34e3 | 🐛 fix(core): Digest.canonical serializes without running an Effect |  |
| 2026-10-21 15:14 | `7605fcb6af` | ON-MAIN | 15/0/0/0 | 01f13eed0c | 🐛 fix(core): Digest.canonical serializes without running an Effect |  |
| 2026-10-21 15:14 | `c5622c9c0d` | SUPERSEDED | 23/15/0/0 | c5622c9c0d |  | apps/mvp/docs/features/notifications.md: main carried then changed it: 4a6932b47d (fix(mvp |
| 2026-10-21 15:14 | `c9b1279c8b` | PARTIAL | 23/15/3/0 | c9b1279c8b |  | apps/mvp/.sol-review-baseline.json: {"src/features/attention/api.ts": "import { Context, D |
| 2026-10-21 15:14 | `30c93e58e5` | PARTIAL | 2/0/16/7 | 30c93e58e5 |  | apps/mvp/docs/decisions/0028-chat-draft-and-delivery-isolation.md: An existing-question re |
| 2026-10-21 15:14 | `f31eb50189` | PARTIAL | 13/20/2/0 | f31eb50189 |  | apps/mvp/.sol-review-baseline.json: {"src/features/attention/api.ts": "import { Context, D |
| 2026-10-21 15:14 | `88f0d76616` | PARTIAL | 2/0/15/8 | 88f0d76616 |  | apps/mvp/docs/decisions/0028-chat-draft-and-delivery-isolation.md: An existing-question re |
| 2026-10-21 15:15 | `f647672cd9` | PARTIAL | 18/6/5/4 | 1cd360747c | ✨ feat(flows): each alarm logs its duration, journal entries, write tr | packages/smithers/flows/database/docs/api.md: \| `@smthrs/database/DatabaseMetrics` |
| 2026-10-21 15:15 | `cc2f507610` | PARTIAL | 19/7/4/2 | fcbc2db3f3 | ✨ feat(flows): each alarm logs its duration, journal entries, write tr | packages/smithers/flows/database/docs/api.md: \| `@smthrs/database/DatabaseMetrics` |
| 2026-10-21 15:15 | `cbe8fe86e7` | PARTIAL | 8/3/1/5 | cbe8fe86e7 |  | packages/smithers/flows/database/src/DatabaseMetrics.ts: import * as WriteTally from "./in |
| 2026-10-21 15:17 | `ed3b8b31fe` | SUPERSEDED | 29/13/0/0 | a2cc4468ea | 🔥 refactor(patterns)!: delete TryCatchFinally; recover with Node.catch | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `cf4eb4fb9e` | SUPERSEDED | 29/13/0/0 | 43007b0fd8 | 🔥 refactor(patterns)!: delete TryCatchFinally; recover with Node.catch | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `462fb642e0` | SUPERSEDED | 29/13/0/0 | 4a47b426e6 | 🔥 refactor(patterns)!: delete TryCatchFinally; recover with Node.catch | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `e7ef4f201a` | SUPERSEDED | 29/13/0/0 | 32e5a252c9 | 🔥 refactor(patterns)!: delete TryCatchFinally; recover with Node.catch | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `368be26c76` | SUPERSEDED | 29/13/0/0 | 08d0af64a1 | 🔥 refactor(patterns)!: delete TryCatchFinally; recover with Node.catch | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `2eafd04372` | SUPERSEDED | 29/13/0/0 | fa5176b235 | 🔥 refactor(patterns)!: delete TryCatchFinally; recover with Node.catch | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `2baa2b16ec` | SUPERSEDED | 29/13/0/0 | ff41e80e78 | 🔥 refactor(patterns)!: delete TryCatchFinally; recover with Node.catch | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `5500254fa2` | SUPERSEDED | 24/12/0/0 | 5500254fa2 |  | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `80a6f42063` | SUPERSEDED | 24/13/0/0 | c8103ca98a | 🔥 refactor(patterns)!: delete TryCatchFinally; recover with Node.catch | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `9937f548f9` | SUPERSEDED | 24/12/0/0 | 9937f548f9 |  | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `e6fcb71503` | SUPERSEDED | 23/13/0/0 | 834c49417b | 🔥 refactor(patterns)!: delete TryCatchFinally; recover with Node.catch | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:17 | `f99a272901` | SUPERSEDED | 23/13/0/0 | f99a272901 |  | .smithers/flows/create-flow/provision/flow.mdx: main carried then changed it: a1644998f1 ( |
| 2026-10-21 15:21 | `b0d527eee7` | SUPERSEDED | 9/2/0/0 | b0d527eee7 | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/src/features/branch/components/BranchHeader.tsx: main carried then changed it: d5 |
| 2026-10-21 15:21 | `0b93fc6d9a` | SUPERSEDED | 9/3/0/0 | 0b93fc6d9a | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/docs/work/branch-page-regressions.md: landed as 9b1435a866 (same author and time, |
| 2026-10-21 15:21 | `0bbf6b3fbd` | SUPERSEDED | 9/3/0/0 | 0bbf6b3fbd | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/docs/work/branch-page-regressions.md: landed as 9b1435a866 (same author and time, |
| 2026-10-21 15:21 | `72a73899be` | SUPERSEDED | 9/3/0/0 | 72a73899be | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/docs/work/branch-page-regressions.md: landed as 9b1435a866 (same author and time, |
| 2026-10-21 15:21 | `e0ecc0c025` | SUPERSEDED | 9/3/0/0 | 104a7b5e07 | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/docs/work/branch-page-regressions.md: landed as 9b1435a866 (same author and time, |
| 2026-10-21 15:21 | `331891126f` | SUPERSEDED | 9/3/0/0 | 331891126f | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/docs/work/branch-page-regressions.md: landed as 9b1435a866 (same author and time, |
| 2026-10-21 15:21 | `72273249b5` | SUPERSEDED | 9/3/0/0 | 9ef520910f | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/docs/work/branch-page-regressions.md: landed as 9b1435a866 (same author and time, |
| 2026-10-21 15:21 | `cc19e2287a` | SUPERSEDED | 9/3/0/0 | cc19e2287a | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/docs/work/branch-page-regressions.md: landed as 9b1435a866 (same author and time, |
| 2026-10-21 15:21 | `9a5507edcc` | PARTIAL | 7/3/1/0 | 9a5507edcc |  | apps/mvp/docs/work/branch-page-regressions.md: Theme (`6e0a00bdc51e`): the bootstrap only |
| 2026-10-21 15:21 | `8c9a5d26e3` | PARTIAL | 7/3/1/0 | 8c9a5d26e3 |  | apps/mvp/docs/work/branch-page-regressions.md: Theme (`6e0a00bdc51e`): the bootstrap only |
| 2026-10-21 15:21 | `b5dc8aa8ca` | SUPERSEDED | 7/4/0/0 | b5dc8aa8ca | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/docs/work/branch-page-regressions.md: landed as 9b1435a866 (same author and time, |
| 2026-10-21 15:21 | `2d6aec1ae8` | SUPERSEDED | 7/4/0/0 | c718c8d18f | 🐛 fix(mvp): show branch chrome while offline tracking waits | apps/mvp/docs/work/branch-page-regressions.md: landed as 9b1435a866 (same author and time, |
| 2026-10-21 15:21 | `cfb32e285e` | PARTIAL | 1/0/5/0 | cfb32e285e |  | apps/mvp/docs/work/time-travel-generation-evidence.md: status: in-progress; apps/mvp/docs/ |
| 2026-10-21 15:21 | `01e3888243` | PARTIAL | 1/0/5/0 | 01e3888243 |  | apps/mvp/docs/work/time-travel-generation-evidence.md: status: in-progress; apps/mvp/docs/ |
| 2026-10-21 15:22 | `b0d0bc405c` | SUPERSEDED | 48/7/0/0 | eca4f0f7f4 | 🐛 fix(patterns)!: a declared Trellis runs the authored plan, one durab | packages/smithers/flows/patterns/README.md: main carried then changed it: 37ccb84f89 (🐛 fi |
| 2026-10-21 15:22 | `641797fe09` | SUPERSEDED | 48/7/0/0 | ff41e80e78 | 🐛 fix(patterns)!: a declared Trellis runs the authored plan, one durab | packages/smithers/flows/patterns/README.md: main carried then changed it: 37ccb84f89 (🐛 fi |
| 2026-10-21 15:22 | `fc02f281da` | SUPERSEDED | 46/9/0/0 | afee49fd47 | 🐛 fix(patterns)!: a declared Trellis runs the authored plan, one durab | packages/smithers/flows/patterns/README.md: main carried then changed it: 37ccb84f89 (🐛 fi |
| 2026-10-21 15:22 | `d92797640d` | SUPERSEDED | 33/12/0/0 | d92797640d |  | packages/smithers/agent/memory/docs/api.md: landed as 3f9b64e07b (same author and time, co |
| 2026-10-21 15:22 | `08c769867e` | SUPERSEDED | 45/8/0/0 | 563a400092 | 🐛 fix(patterns)!: a declared Trellis runs the authored plan, one durab | .changeset/patterns-trellis-durable-rounds.md: landed as 3f9b64e07b (same author and time, |
| 2026-10-21 15:22 | `c5456d9e26` | SUPERSEDED | 39/7/0/0 | f33dbdf019 | 🐛 fix(patterns)!: a declared Trellis runs the authored plan, one durab | .changeset/patterns-trellis-durable-rounds.md: landed as 3f9b64e07b (same author and time, |
| 2026-10-21 15:22 | `1511b7d9a2` | SUPERSEDED | 36/10/0/0 | f74c52ee8d | 🐛 fix(patterns)!: a declared Trellis runs the authored plan, one durab | packages/smithers/agent/memory/docs/api.md: landed as 3f9b64e07b (same author and time, co |
| 2026-10-21 15:22 | `8295439dd9` | SUPERSEDED | 37/10/0/0 | 8295439dd9 |  | packages/smithers/agent/memory/docs/api.md: landed as 3f9b64e07b (same author and time, co |
| 2026-10-21 15:22 | `33ea025144` | SUPERSEDED | 39/7/0/0 | c8103ca98a | 🐛 fix(patterns)!: a declared Trellis runs the authored plan, one durab | .changeset/patterns-trellis-durable-rounds.md: landed as 3f9b64e07b (same author and time, |
| 2026-10-21 15:22 | `95a2cc87d4` | SUPERSEDED | 40/6/0/0 | 834c49417b | 🐛 fix(patterns)!: a declared Trellis runs the authored plan, one durab | packages/smithers/flows/patterns/src/Trellis.ts: landed as 3f9b64e07b (same author and tim |
| 2026-10-21 15:22 | `a03565d785` | SUPERSEDED | 36/10/0/0 | e0366b830e | 🐛 fix(patterns)!: a declared Trellis runs the authored plan, one durab | packages/smithers/agent/memory/docs/api.md: landed as 3f9b64e07b (same author and time, co |
| 2026-10-21 15:22 | `1340c277b5` | SUPERSEDED | 37/10/0/0 | 1340c277b5 |  | packages/smithers/agent/memory/docs/api.md: landed as 3f9b64e07b (same author and time, co |
| 2026-10-21 15:23 | `3ab554e5f3` | SUPERSEDED | 12/5/0/0 | b8a380c99d | ✨ feat(harness,mvp): a person's steer reads as a newer instruction, an | apps/mvp/docs/features/runs.md: main carried then changed it: 484ff27221 (🔒 fix(mvp): bran |
| 2026-10-21 15:23 | `cb92d320cb` | SUPERSEDED | 12/3/0/0 | e141cdd55c | ✨ feat(harness,mvp): a person's steer reads as a newer instruction, an | apps/mvp/docs/features/runs.md: main carried then changed it: 484ff27221 (🔒 fix(mvp): bran |
| 2026-10-21 15:25 | `56f12c5ddf` | ON-MAIN | 21/0/0/0 | 0b93fc6d9a | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `58fcdd9e8e` | SUPERSEDED | 3/2/0/0 | 0b93fc6d9a | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `4743f1cbe5` | SUPERSEDED | 7/2/0/0 | 0b93fc6d9a | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `98a00d7ea2` | ON-MAIN | 21/0/0/0 | 0bbf6b3fbd | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `343be32264` | SUPERSEDED | 3/2/0/0 | 0bbf6b3fbd | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `3657f83bca` | SUPERSEDED | 6/3/0/0 | 0bbf6b3fbd | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: landed as d3ba726ddb (same author and time, committed later) |
| 2026-10-21 15:25 | `47ab0a2740` | ON-MAIN | 21/0/0/0 | 72a73899be | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `489bdcdd5b` | SUPERSEDED | 3/2/0/0 | 72a73899be | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `5e7f42fc2e` | SUPERSEDED | 7/2/0/0 | 72a73899be | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `6f9879060a` | ON-MAIN | 21/0/0/0 | 104a7b5e07 | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `ec93118e06` | SUPERSEDED | 3/2/0/0 | 104a7b5e07 | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `be63cd70d1` | SUPERSEDED | 7/2/0/0 | 104a7b5e07 | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `d3bf40d06c` | ON-MAIN | 21/0/0/0 | 331891126f | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `7f074b1b6c` | SUPERSEDED | 3/2/0/0 | 331891126f | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `d713461588` | SUPERSEDED | 6/3/0/0 | 331891126f | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: landed as d3ba726ddb (same author and time, committed later) |
| 2026-10-21 15:25 | `5991b9d9ec` | SUPERSEDED | 49/7/0/0 | 72a73899be | 🐛 fix(time-travel): retry abandoned fork lanes until forgotten and ref | apps/site/public/llms-full.txt: main carried then changed it: b87a5b87e1 (🐛 fix(time-trave |
| 2026-10-21 15:25 | `2e11c653ab` | ON-MAIN | 21/0/0/0 | 9ef520910f | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `1525f9bbe1` | SUPERSEDED | 3/2/0/0 | 9ef520910f | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `aca6fbc3c1` | SUPERSEDED | 7/2/0/0 | 9ef520910f | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `c21b148e02` | ON-MAIN | 21/0/0/0 | cc19e2287a | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `2925b7d3ea` | SUPERSEDED | 3/2/0/0 | cc19e2287a | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `c6e5aaaba3` | SUPERSEDED | 6/3/0/0 | cc19e2287a | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: landed as d3ba726ddb (same author and time, committed later) |
| 2026-10-21 15:25 | `1d35816591` | SUPERSEDED | 49/7/0/0 | 9ef520910f | 🐛 fix(time-travel): retry abandoned fork lanes until forgotten and ref | apps/site/public/llms-full.txt: main carried then changed it: b87a5b87e1 (🐛 fix(time-trave |
| 2026-10-21 15:25 | `afc253dd57` | ON-MAIN | 21/0/0/0 | 245fc53d61 | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `49746d0b2c` | SUPERSEDED | 3/2/0/0 | 245fc53d61 | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `8095a5f39b` | SUPERSEDED | 7/2/0/0 | 245fc53d61 | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `a382b39365` | SUPERSEDED | 49/7/0/0 | 245fc53d61 | 🐛 fix(time-travel): retry abandoned fork lanes until forgotten and ref | apps/site/public/llms-full.txt: main carried then changed it: b87a5b87e1 (🐛 fix(time-trave |
| 2026-10-21 15:25 | `faaaeac917` | ON-MAIN | 21/0/0/0 | 43007b0fd8 | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `77f21cae6d` | SUPERSEDED | 3/2/0/0 | 43007b0fd8 | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `ca260abf1e` | SUPERSEDED | 7/2/0/0 | 43007b0fd8 | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `d1841c5db2` | SUPERSEDED | 49/7/0/0 | 43007b0fd8 | 🐛 fix(time-travel): retry abandoned fork lanes until forgotten and ref | apps/site/public/llms-full.txt: main carried then changed it: b87a5b87e1 (🐛 fix(time-trave |
| 2026-10-21 15:25 | `5514871674` | ON-MAIN | 21/0/0/0 | fcd2fd1cd5 | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `dd4954278c` | SUPERSEDED | 3/2/0/0 | fcd2fd1cd5 | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `6a794da1e1` | SUPERSEDED | 6/3/0/0 | fcd2fd1cd5 | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: landed as d3ba726ddb (same author and time, committed later) |
| 2026-10-21 15:25 | `8bb7203ab3` | ON-MAIN | 21/0/0/0 | 3a7583d2a4 | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `35b8703e98` | SUPERSEDED | 3/2/0/0 | 3a7583d2a4 | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `986753add4` | SUPERSEDED | 6/2/0/0 | 3a7583d2a4 | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `c71cebf829` | ON-MAIN | 21/0/0/0 | 1829e9d7ab | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `db553848dc` | SUPERSEDED | 3/2/0/0 | 1829e9d7ab | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `4403748e80` | SUPERSEDED | 7/2/0/0 | 1829e9d7ab | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `56f8b0e90c` | ON-MAIN | 21/0/0/0 | 8fd3572d81 | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `a8849cc5e0` | SUPERSEDED | 3/2/0/0 | 8fd3572d81 | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `075d5159e4` | SUPERSEDED | 6/2/0/0 | 8fd3572d81 | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `dcfa6818fb` | ON-MAIN | 21/0/0/0 | 87dde44da6 | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `7996e5f3f0` | SUPERSEDED | 3/2/0/0 | 87dde44da6 | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `c83679884d` | SUPERSEDED | 6/2/0/0 | 87dde44da6 | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:25 | `db32b6f4ee` | SUPERSEDED | 49/7/0/0 | 1829e9d7ab | 🐛 fix(time-travel): retry abandoned fork lanes until forgotten and ref | apps/site/public/llms-full.txt: main carried then changed it: b87a5b87e1 (🐛 fix(time-trave |
| 2026-10-21 15:25 | `a981a8ba70` | SUPERSEDED | 49/7/0/0 | cfb32e285e | 🐛 fix(time-travel): retry abandoned fork lanes until forgotten and ref | apps/site/public/llms-full.txt: main carried then changed it: b87a5b87e1 (🐛 fix(time-trave |
| 2026-10-21 15:25 | `95d69270a7` | SUPERSEDED | 45/5/0/0 | f17e71d70d | 🐛 fix(time-travel): retry abandoned fork lanes until forgotten and ref | packages/smithers/flows/time-travel/README.md: main carried then changed it: b87a5b87e1 (🐛 |
| 2026-10-21 15:25 | `3c99d5f88a` | SUPERSEDED | 24/23/0/0 | 01e3888243 | 🐛 fix(time-travel): retry abandoned fork lanes until forgotten and ref | packages/smithers/flows/time-travel/README.md: main carried then changed it: b87a5b87e1 (🐛 |
| 2026-10-21 15:25 | `51aa8189b0` | SUPERSEDED | 24/23/0/0 | 51aa8189b0 | 🐛 fix(time-travel): retry abandoned fork lanes until forgotten and ref | packages/smithers/flows/time-travel/README.md: main carried then changed it: b87a5b87e1 (🐛 |
| 2026-10-21 15:25 | `9637867fd4` | ON-MAIN | 21/0/0/0 | 05686de888 | 🐛 fix(mvp,ui): Answer accepts a blocking question's default, so Needs  |  |
| 2026-10-21 15:25 | `f987f4d487` | PARTIAL | 15/28/1/0 | f987f4d487 |  | apps/mvp/docs/work/time-travel-fork-intent-reclamation.md: links: [../../../../packages/sm |
| 2026-10-21 15:25 | `d32c5b3b13` | SUPERSEDED | 3/2/0/0 | 05686de888 | ✅ test(mvp): the flows e2e opens Flows by its address and reads the ru | apps/mvp/e2e/flows.spec.ts: main carried then changed it: b120140226 (✨ feat(mvp): run han |
| 2026-10-21 15:25 | `1e3dd2a894` | SUPERSEDED | 6/2/0/0 | 05686de888 | ✅ test(mvp): an e2e test that waits for the real model declares liveMo | apps/mvp/e2e/target.test.ts: main carried then changed it: 35f0b33717 (✨ feat(mvp): people |
| 2026-10-21 15:26 | `b8a380c99d` | ON-MAIN | 2/0/0/0 | b8a380c99d |  |  |
| 2026-10-21 15:26 | `2b50710416` | ON-MAIN | 2/0/0/0 | 2b50710416 | 🐛 fix(mvp): a run's page keeps what it read through a read that can't  |  |
| 2026-10-21 15:26 | `e141cdd55c` | SUPERSEDED | 0/2/0/0 | e141cdd55c |  | apps/site/public/llms-full.txt: main carried then changed it: 719148d634 (📝 docs: regenera |
| 2026-10-21 15:31 | `9198daa64d` | SUPERSEDED | 15/16/0/0 | c63dcc4693 | 🐛 fix(sdk): a leader handover never runs a committed write of the shar | .changeset/shared-sqlite-write-receipts.md: main carried then changed it: e66a003507 (🐛 fi |
| 2026-10-21 15:32 | `2bb993d7cb` | PARTIAL | 1/0/7/0 | 2bb993d7cb | ✅ test(mvp): in a real browser, a refusal hides the issue the device s | apps/mvp/docs/features/issues.md: \| `e2e/issue-refusal.spec.ts` \| in a real browser on a |
| 2026-10-21 15:32 | `7ed39694df` | PARTIAL | 1/0/7/0 | 7ed39694df |  | apps/mvp/docs/features/issues.md: \| `e2e/issue-refusal.spec.ts` \| in a real browser on a |
| 2026-10-21 15:35 | `91086227f8` | SUPERSEDED | 24/10/0/0 | a2cc4468ea | 🐛 fix(plan,engine-store): an appended writer waits for earlier generat | apps/site/public/llms-full.txt: main carried then changed it: 631bbbe2f2 (🐛 fix(engine): s |
| 2026-10-21 15:35 | `9f7c48b115` | SUPERSEDED | 39/9/0/0 | a2cc4468ea | 🐛 fix(plan,engine): a branded sealed declaration replays the outcome r | apps/site/src/content/docs/docs/reference/api/engine.mdx: main carried then changed it: 63 |
| 2026-10-21 15:35 | `43bd645588` | SUPERSEDED | 24/10/0/0 | 43007b0fd8 | 🐛 fix(plan,engine-store): an appended writer waits for earlier generat | apps/site/public/llms-full.txt: main carried then changed it: 631bbbe2f2 (🐛 fix(engine): s |
| 2026-10-21 15:35 | `4901c180be` | SUPERSEDED | 39/9/0/0 | 43007b0fd8 | 🐛 fix(plan,engine): a branded sealed declaration replays the outcome r | apps/site/src/content/docs/docs/reference/api/engine.mdx: main carried then changed it: 63 |
| 2026-10-21 15:35 | `48a282afd6` | SUPERSEDED | 24/10/0/0 | 4a47b426e6 | 🐛 fix(plan,engine-store): an appended writer waits for earlier generat | apps/site/public/llms-full.txt: main carried then changed it: 631bbbe2f2 (🐛 fix(engine): s |
| 2026-10-21 15:35 | `3135fd660d` | SUPERSEDED | 39/9/0/0 | 4a47b426e6 | 🐛 fix(plan,engine): a branded sealed declaration replays the outcome r | apps/site/src/content/docs/docs/reference/api/engine.mdx: main carried then changed it: 63 |
| 2026-10-21 15:35 | `a750aa5110` | SUPERSEDED | 34/15/0/0 | 968a2cc56e | 🐛 fix(plan,engine-store): an appended writer waits for earlier generat | apps/site/public/llms-full.txt: main carried then changed it: 631bbbe2f2 (🐛 fix(engine): s |
| 2026-10-21 15:35 | `e3309d575a` | SUPERSEDED | 39/9/0/0 | 968a2cc56e | 🐛 fix(plan,engine): a branded sealed declaration replays the outcome r | apps/site/src/content/docs/docs/reference/api/engine.mdx: main carried then changed it: 63 |
| 2026-10-21 15:35 | `8cac454eb3` | SUPERSEDED | 24/10/0/0 | b2604d9a24 | 🐛 fix(plan,engine-store): an appended writer waits for earlier generat | apps/site/public/llms-full.txt: main carried then changed it: 631bbbe2f2 (🐛 fix(engine): s |
| 2026-10-21 15:35 | `905607f07c` | SUPERSEDED | 39/9/0/0 | b2604d9a24 | 🐛 fix(plan,engine): a branded sealed declaration replays the outcome r | apps/site/src/content/docs/docs/reference/api/engine.mdx: main carried then changed it: 63 |
| 2026-10-21 15:35 | `45a6312fea` | SUPERSEDED | 34/15/0/0 | 44072e34e3 | 🐛 fix(plan,engine-store): an appended writer waits for earlier generat | apps/site/public/llms-full.txt: main carried then changed it: 631bbbe2f2 (🐛 fix(engine): s |
| 2026-10-21 15:35 | `6d3820a76a` | SUPERSEDED | 38/10/0/0 | 44072e34e3 | 🐛 fix(plan,engine): a branded sealed declaration replays the outcome r | apps/site/src/content/docs/docs/reference/api/engine.mdx: main carried then changed it: 63 |
| 2026-10-21 15:35 | `01f13eed0c` | SUPERSEDED | 17/20/0/0 | 01f13eed0c | 🐛 fix(plan,engine-store): an appended writer waits for earlier generat | apps/site/public/llms-full.txt: main carried then changed it: 631bbbe2f2 (🐛 fix(engine): s |
| 2026-10-21 15:35 | `4ead802bf1` | SUPERSEDED | 35/12/0/0 | 01f13eed0c | 🐛 fix(plan,engine): a branded sealed declaration replays the outcome r | apps/site/src/content/docs/docs/reference/api/engine.mdx: main carried then changed it: 63 |
| 2026-10-21 15:37 | `e045d2151d` | ON-MAIN | 3/0/0/0 | e045d2151d |  |  |
| 2026-10-21 15:41 | `2a9df0b578` | PARTIAL | 0/0/5/1 | 62778583ba | ✅ test(mvp): the coding role on a runner with the real Claude Code, op | apps/mvp/worker/runners/Coding.live.test.ts: test("a runner killed after the first tool ca |
| 2026-10-21 15:41 | `161df2072d` | PARTIAL | 0/0/5/1 | cb85ebcf38 | ✅ test(mvp): the coding role on a runner with the real Claude Code, op | apps/mvp/worker/runners/Coding.live.test.ts: test("a runner killed after the first tool ca |
| 2026-10-21 15:42 | `a9ac97fe5f` | SUPERSEDED | 37/19/0/0 | dcd6da80eb | 🐛 fix(mvp): a question asked in a branch shows there, and a person's o | apps/mvp/src/features/attention/actions.ts: main carried then changed it: d02050fcf0 (🐛 fi |
| 2026-10-21 15:42 | `c6476019cf` | SUPERSEDED | 37/19/0/0 | c718c8d18f | 🐛 fix(mvp): a question asked in a branch shows there, and a person's o | apps/mvp/src/features/attention/actions.ts: main carried then changed it: d02050fcf0 (🐛 fi |
| 2026-10-21 15:42 | `947bdf378b` | SUPERSEDED | 37/19/0/0 | 947bdf378b |  | apps/mvp/src/features/attention/actions.ts: main carried then changed it: d02050fcf0 (🐛 fi |
| 2026-10-21 15:43 | `43c8e070c8` | PARTIAL | 1/1/14/0 | 62778583ba | 📝 docs: regenerate the site's API pages, llms files, redirect map and  | apps/site/public/llms-full.txt: cancels by key while its `start` may still be in flight. ` |
| 2026-10-21 15:44 | `52f97a5cb8` | PARTIAL | 80/5/3/3 | 52f97a5cb8 |  | packages/smithers/flows/patterns/docs/teams.md: When `approval` is supplied, `make` sequen |
| 2026-10-21 15:44 | `20aa2c6fd3` | SUPERSEDED | 97/8/0/0 | eca4f0f7f4 | 🔥 refactor(patterns)!: delete WithApproval; ask a person with HumanTas | .smithers/flows/create-flow/design/flow.mdx: main carried then changed it: 8d4e1825eb (🔥 r |
| 2026-10-21 15:44 | `d1e00f1404` | SUPERSEDED | 97/8/0/0 | ff41e80e78 | 🔥 refactor(patterns)!: delete WithApproval; ask a person with HumanTas | .smithers/flows/create-flow/design/flow.mdx: main carried then changed it: 8d4e1825eb (🔥 r |
| 2026-10-21 15:44 | `afee49fd47` | PARTIAL | 80/5/3/3 | afee49fd47 |  | packages/smithers/flows/patterns/docs/teams.md: When `approval` is supplied, `make` sequen |
| 2026-10-21 15:44 | `47b46f23f8` | SUPERSEDED | 96/8/0/0 | 0a20cc956d | 🔥 refactor(patterns)!: delete WithApproval; ask a person with HumanTas | .smithers/flows/create-flow/design/flow.mdx: main carried then changed it: 8d4e1825eb (🔥 r |
| 2026-10-21 15:44 | `7659b96be9` | SUPERSEDED | 30/7/0/0 | 4864de0363 | 🐛 fix(sandbox): bound a branch machine's start, so a call settles | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 15:44 | `adb49d929d` | SUPERSEDED | 30/7/0/0 | 4e803f491a | 🐛 fix(sandbox): bound a branch machine's start, so a call settles | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 15:44 | `8f611f4bc2` | PARTIAL | 0/0/2/1 | 62778583ba | 🐛 fix(agent): an ExternalAgent step is still a Flow, so hosts can regi | .changeset/agent-external-agent-flow-type.md: `toLayer()` with no arguments still implemen |
| 2026-10-21 15:44 | `63ed753639` | SUPERSEDED | 87/12/0/0 | 563a400092 | 🔥 refactor(patterns)!: delete WithApproval; ask a person with HumanTas | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 15:44 | `f74c52ee8d` | PARTIAL | 80/5/3/3 | f74c52ee8d |  | packages/smithers/flows/patterns/docs/teams.md: When `approval` is supplied, `make` sequen |
| 2026-10-21 15:44 | `8b0ce50021` | SUPERSEDED | 80/11/0/0 | 8b0ce50021 | 🔥 refactor(patterns)!: delete WithApproval; ask a person with HumanTas | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 15:44 | `5a74dadf64` | PARTIAL | 80/5/3/3 | 5a74dadf64 |  | packages/smithers/flows/patterns/docs/teams.md: When `approval` is supplied, `make` sequen |
| 2026-10-21 15:44 | `55c70afa4e` | SUPERSEDED | 83/11/0/0 | a30aac00cf | 🔥 refactor(patterns)!: delete WithApproval; ask a person with HumanTas | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 15:44 | `f5d908173d` | SUPERSEDED | 80/11/0/0 | c8103ca98a | 🔥 refactor(patterns)!: delete WithApproval; ask a person with HumanTas | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 15:44 | `b544f92f59` | PARTIAL | 80/5/3/3 | b544f92f59 |  | packages/smithers/flows/patterns/docs/teams.md: When `approval` is supplied, `make` sequen |
| 2026-10-21 15:44 | `c8c0052e56` | SUPERSEDED | 80/11/0/0 | 6969bbcb4a | 🔥 refactor(patterns)!: delete WithApproval; ask a person with HumanTas | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 15:44 | `bdbbf3bb25` | ON-MAIN | 1/0/0/0 | bdbbf3bb25 |  |  |
| 2026-10-21 15:44 | `e0366b830e` | SUPERSEDED | 80/11/0/0 | e0366b830e | 🔥 refactor(patterns)!: delete WithApproval; ask a person with HumanTas | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 15:44 | `0700de245e` | PARTIAL | 80/5/3/3 | 0700de245e |  | packages/smithers/flows/patterns/docs/teams.md: When `approval` is supplied, `make` sequen |
| 2026-10-21 15:47 | `73a8e215e1` | ON-MAIN | 17/0/0/0 | 73a8e215e1 |  |  |
| 2026-10-21 15:47 | `2cf7a54bcd` | ON-MAIN | 18/0/0/0 | 2cf7a54bcd |  |  |
| 2026-10-21 15:47 | `dd75d7c619` | SUPERSEDED | 19/1/0/0 | eca4f0f7f4 | 🐛 fix(patterns)!: a declared DelegationChain runs the derisked plan, o | packages/smithers/flows/patterns/README.md: main carried then changed it: 37ccb84f89 (🐛 fi |
| 2026-10-21 15:47 | `1da5eb8d27` | SUPERSEDED | 19/1/0/0 | ff41e80e78 | 🐛 fix(patterns)!: a declared DelegationChain runs the derisked plan, o | packages/smithers/flows/patterns/README.md: main carried then changed it: 37ccb84f89 (🐛 fi |
| 2026-10-21 15:47 | `4a771d7c8d` | ON-MAIN | 17/0/0/0 | 4a771d7c8d |  |  |
| 2026-10-21 15:47 | `2a95f8f22b` | SUPERSEDED | 19/1/0/0 | 0a20cc956d | 🐛 fix(patterns)!: a declared DelegationChain runs the derisked plan, o | packages/smithers/flows/patterns/README.md: main carried then changed it: 37ccb84f89 (🐛 fi |
| 2026-10-21 15:47 | `04ed73a6e6` | ON-MAIN | 18/0/0/0 | 04ed73a6e6 |  |  |
| 2026-10-21 15:47 | `834c49417b` | ON-MAIN | 18/0/0/0 | 834c49417b |  |  |
| 2026-10-21 15:47 | `3bfa24b71f` | PARTIAL | 2/1/5/0 | 3bfa24b71f | 📝 docs: regenerated site reference and llms files for GitHub.Pulls.set | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:47 | `d464438d7f` | PARTIAL | 2/1/5/0 | d464438d7f |  | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:47 | `52c882da37` | SUPERSEDED | 18/2/0/0 | 563a400092 | 🐛 fix(patterns)!: a declared DelegationChain runs the derisked plan, o | .changeset/patterns-delegationchain-runs-plan.md: landed as 615a42e800 (same author and ti |
| 2026-10-21 15:47 | `f33dbdf019` | ON-MAIN | 17/0/0/0 | f33dbdf019 |  |  |
| 2026-10-21 15:47 | `a30aac00cf` | SUPERSEDED | 18/1/0/0 | a30aac00cf | 🐛 fix(patterns)!: a declared DelegationChain runs the derisked plan, o | .changeset/patterns-delegationchain-runs-plan.md: landed as 615a42e800 (same author and ti |
| 2026-10-21 15:47 | `4252137cd8` | ON-MAIN | 18/0/0/0 | 4252137cd8 |  |  |
| 2026-10-21 15:47 | `c8103ca98a` | ON-MAIN | 18/0/0/0 | c8103ca98a |  |  |
| 2026-10-21 15:47 | `b9e043826b` | SUPERSEDED | 18/1/0/0 | b9e043826b | 🐛 fix(patterns)!: a declared DelegationChain runs the derisked plan, o | .changeset/patterns-delegationchain-runs-plan.md: landed as 615a42e800 (same author and ti |
| 2026-10-21 15:47 | `8c47f86713` | PARTIAL | 2/1/5/0 | 8c47f86713 | 📝 docs: regenerated site reference and llms files for GitHub.Pulls.set | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:47 | `6faf10f20f` | PARTIAL | 2/1/5/0 | 6faf10f20f |  | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:47 | `6969bbcb4a` | ON-MAIN | 18/0/0/0 | 6969bbcb4a |  |  |
| 2026-10-21 15:47 | `03949a34d5` | ON-MAIN | 17/0/0/0 | 03949a34d5 |  |  |
| 2026-10-21 15:47 | `b81df565e1` | PARTIAL | 2/0/4/0 | b81df565e1 | 📝 docs: regenerated site reference and llms files for GitHub.Pulls.set | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:47 | `3a369a27d1` | PARTIAL | 2/0/4/0 | 3a369a27d1 |  | apps/site/public/llms-full.txt: \| `setBase` \| `(owner, repo, number, base) => Effect<Pul |
| 2026-10-21 15:56 | `616260c3c9` | SUPERSEDED | 41/3/0/0 | c63dcc4693 | 🐛 fix(sdk): a tab channel's subscriber holds a bounded backlog, and on | packages/smithers/flows/platform-browser/docs/api.md: main carried then changed it: 6bd378 |
| 2026-10-21 16:01 | `8431509fe5` | PARTIAL | 1/0/1/2 | 8431509fe5 |  | apps/mvp/src/boot.test.ts: // Three key bindings, chat connectivity (the device adopted in |
| 2026-10-21 16:01 | `ba625281be` | PARTIAL | 1/0/1/2 | ba625281be |  | apps/mvp/src/boot.test.ts: // Three key bindings, chat connectivity (the device adopted in |
| 2026-10-21 16:01 | `65aa2e5ea1` | PARTIAL | 1/0/1/2 | 65aa2e5ea1 |  | apps/mvp/src/boot.test.ts: // Three key bindings, chat connectivity (the device adopted in |
| 2026-10-21 16:03 | `dcd6da80eb` | PARTIAL | 27/9/2/0 | dcd6da80eb | 🧪 test(mvp): live attention on two devices with the real model, crash  | apps/mvp/docs/features/sign-in.md: -\| `src/flows/credentials.test.ts` \| on the Node engi |
| 2026-10-21 16:03 | `68315c158f` | PARTIAL | 27/8/3/0 | 68315c158f |  | apps/mvp/docs/features/agent-status.md: \| `POST /api/runs/<id>` `{ status, waiting?, wait |
| 2026-10-21 16:03 | `3d496b1dc8` | SUPERSEDED | 27/11/0/0 | fae2972933 | 🧪 test(mvp): live attention on two devices with the real model, crash  | apps/mvp/docs/features/agent-status.md: main carried then changed it: d9c04075bd (📝 docs(m |
| 2026-10-21 16:07 | `6b9a88ed78` | SUPERSEDED | 19/3/0/0 | 0b93fc6d9a | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `4ff5d15cf2` | SUPERSEDED | 7/1/0/0 | 0b93fc6d9a | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `599cd8a599` | SUPERSEDED | 19/3/0/0 | 0bbf6b3fbd | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `00c4b3be23` | SUPERSEDED | 7/1/0/0 | 0bbf6b3fbd | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `f521294d42` | SUPERSEDED | 19/3/0/0 | 72a73899be | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `2663adf2a4` | SUPERSEDED | 7/1/0/0 | 72a73899be | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `0349e208ff` | SUPERSEDED | 19/3/0/0 | 104a7b5e07 | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `0e0455f640` | SUPERSEDED | 7/1/0/0 | 104a7b5e07 | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `2ba74fcf34` | SUPERSEDED | 19/3/0/0 | 331891126f | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `516c2782d9` | SUPERSEDED | 7/1/0/0 | 331891126f | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `f508eed603` | SUPERSEDED | 19/3/0/0 | 9ef520910f | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `4ba0eba91e` | SUPERSEDED | 7/1/0/0 | 9ef520910f | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `e42d75fcfe` | SUPERSEDED | 19/3/0/0 | cc19e2287a | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `34fb62e02a` | SUPERSEDED | 7/1/0/0 | cc19e2287a | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `e62618e470` | PARTIAL | 0/1/11/14 | e62618e470 |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: -4. **Visitors' dat |
| 2026-10-21 16:07 | `cf246cf515` | PARTIAL | 2/0/17/13 | cf246cf515 |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: 4. **Visitors' data |
| 2026-10-21 16:07 | `b471b5956a` | PARTIAL | 6/5/17/16 | b471b5956a |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: 4. **Visitors' data |
| 2026-10-21 16:07 | `8720bcef3e` | PARTIAL | 2/0/17/13 | 8720bcef3e |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: 4. **Visitors' data |
| 2026-10-21 16:07 | `6fa58ff236` | PARTIAL | 1/1/11/15 | 6fa58ff236 |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: -4. **Visitors' dat |
| 2026-10-21 16:07 | `6cfff5d4ce` | PARTIAL | 3/0/17/15 | 6cfff5d4ce |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: 4. **Visitors' data |
| 2026-10-21 16:07 | `27f2343fbc` | PARTIAL | 0/1/11/14 | 27f2343fbc |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: -4. **Visitors' dat |
| 2026-10-21 16:07 | `27308dff1b` | PARTIAL | 6/1/20/17 | 27308dff1b |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: 4. **Visitors' data |
| 2026-10-21 16:07 | `16d9b67a8d` | PARTIAL | 0/5/15/3 | 16d9b67a8d |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: -## Adopting a fres |
| 2026-10-21 16:07 | `410cde479e` | SUPERSEDED | 19/3/0/0 | 245fc53d61 | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `19ed0df688` | SUPERSEDED | 7/1/0/0 | 245fc53d61 | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `71bc4d044e` | SUPERSEDED | 19/3/0/0 | 43007b0fd8 | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `834d02f871` | SUPERSEDED | 7/1/0/0 | 43007b0fd8 | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `ed127c4db1` | SUPERSEDED | 19/3/0/0 | fcd2fd1cd5 | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `a555acfbb0` | SUPERSEDED | 7/1/0/0 | fcd2fd1cd5 | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `6ed1ed6979` | SUPERSEDED | 19/3/0/0 | 3a7583d2a4 | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `f255783415` | SUPERSEDED | 7/1/0/0 | 3a7583d2a4 | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `98cbe44f85` | PARTIAL | 4/2/14/17 | 98cbe44f85 |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: -4. **Visitors' dat |
| 2026-10-21 16:07 | `a89f3e09e3` | PARTIAL | 0/5/15/3 | a89f3e09e3 |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: -## Adopting a fres |
| 2026-10-21 16:07 | `183bb84623` | PARTIAL | 6/5/17/16 | 183bb84623 |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: 4. **Visitors' data |
| 2026-10-21 16:07 | `e6539f8e67` | SUPERSEDED | 19/3/0/0 | 1829e9d7ab | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `f4258cfdc4` | SUPERSEDED | 7/1/0/0 | 1829e9d7ab | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `5c18b946c0` | SUPERSEDED | 19/3/0/0 | 8fd3572d81 | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `3fe3e4f6bc` | SUPERSEDED | 7/1/0/0 | 8fd3572d81 | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `b6ce0bd019` | SUPERSEDED | 19/3/0/0 | 87dde44da6 | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `4cc5872bf2` | SUPERSEDED | 7/1/0/0 | 87dde44da6 | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:07 | `6d98f20152` | PARTIAL | 0/5/15/3 | 6d98f20152 |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: -## Adopting a fres |
| 2026-10-21 16:07 | `0d169e9217` | PARTIAL | 6/5/17/16 | 0d169e9217 |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: 4. **Visitors' data |
| 2026-10-21 16:07 | `c318874875` | PARTIAL | 26/4/5/10 | c318874875 |  | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: 4. **Visitors' data |
| 2026-10-21 16:07 | `319fe4bb38` | PARTIAL | 17/5/1/3 | 319fe4bb38 |  | apps/mvp/e2e/sign-in.spec.ts: expect(await page.evaluate(() => (window as { e2eSamePage?: |
| 2026-10-21 16:07 | `05686de888` | SUPERSEDED | 19/3/0/0 | 05686de888 | 🐛 fix(mvp): a failed draft round says why, and a draft whose checks fa | apps/mvp/src/features/flows-ui/components/DraftCard.tsx: main carried then changed it: 4a6 |
| 2026-10-21 16:07 | `dccfdc90dd` | SUPERSEDED | 7/1/0/0 | 05686de888 | 🐛 fix(harness): a HarnessError keeps a provider's ModelError cause acr | packages/smithers/agent/harness/test/HarnessErrorCause.test.ts: main carried then changed |
| 2026-10-21 16:10 | `901fa4afe2` | STRANDED | 0/0/1/0 | f0fcc1f28a | 📝 docs(mvp): the design for a run's change feed that moves while an ac | apps/mvp/docs/work/run-change-feed-progress.md: +- **Same transaction as the attempt row,* |
| 2026-10-21 16:10 | `e7f547f6ed` | SUPERSEDED | 17/8/0/0 | 0b93fc6d9a | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `d45081eff1` | ON-MAIN | 2/0/0/0 | 0b93fc6d9a | 🐛 fix(mvp): the runs list fills its page with runs a person sees, past |  |
| 2026-10-21 16:10 | `c730670ee0` | PARTIAL | 5/0/1/0 | 0b93fc6d9a | 🐛 fix(mvp): a retry of a retried run keeps its requesting tab | apps/mvp/src/flows/requests.test.ts: expect(REMEMBERED).toBe(1_024) |
| 2026-10-21 16:10 | `202d126cd5` | SUPERSEDED | 4/3/0/0 | 0b93fc6d9a | 🐛 fix(mvp): a tab port's handlers live in its scope: stop and timeouts | apps/mvp/src/flows/tabPort.test.ts: main carried then changed it: 124fdc7e00 (🔍 chore(mvp) |
| 2026-10-21 16:10 | `8b5b8ce332` | SUPERSEDED | 17/8/0/0 | 0bbf6b3fbd | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `2a2a26c66b` | SUPERSEDED | 17/8/0/0 | 72a73899be | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `6f78c1d949` | ON-MAIN | 2/0/0/0 | 72a73899be | 🐛 fix(mvp): the runs list fills its page with runs a person sees, past |  |
| 2026-10-21 16:10 | `34bc644431` | SUPERSEDED | 5/1/0/0 | 72a73899be | 🐛 fix(mvp): a retry of a retried run keeps its requesting tab | apps/mvp/src/flows/requests.test.ts: landed as 37d79960c6 (same author and time, committed |
| 2026-10-21 16:10 | `afe080cfd9` | SUPERSEDED | 4/3/0/0 | 72a73899be | 🐛 fix(mvp): a tab port's handlers live in its scope: stop and timeouts | apps/mvp/src/flows/tabPort.test.ts: main carried then changed it: 124fdc7e00 (🔍 chore(mvp) |
| 2026-10-21 16:10 | `5d4fdbde99` | SUPERSEDED | 17/8/0/0 | 104a7b5e07 | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `ee9554df58` | SUPERSEDED | 17/8/0/0 | 331891126f | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `2c621f3447` | ON-MAIN | 2/0/0/0 | 104a7b5e07 | 🐛 fix(mvp): the runs list fills its page with runs a person sees, past |  |
| 2026-10-21 16:10 | `605a8b0a10` | SUPERSEDED | 5/1/0/0 | 104a7b5e07 | 🐛 fix(mvp): a retry of a retried run keeps its requesting tab | apps/mvp/src/flows/requests.test.ts: landed as 37d79960c6 (same author and time, committed |
| 2026-10-21 16:10 | `4c4805d86c` | SUPERSEDED | 4/3/0/0 | 104a7b5e07 | 🐛 fix(mvp): a tab port's handlers live in its scope: stop and timeouts | apps/mvp/src/flows/tabPort.test.ts: main carried then changed it: 124fdc7e00 (🔍 chore(mvp) |
| 2026-10-21 16:10 | `1a3517fe06` | SUPERSEDED | 17/8/0/0 | 9ef520910f | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `1b36cef4fc` | SUPERSEDED | 17/8/0/0 | cc19e2287a | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `c132ae6863` | ON-MAIN | 2/0/0/0 | 9ef520910f | 🐛 fix(mvp): the runs list fills its page with runs a person sees, past |  |
| 2026-10-21 16:10 | `441550c4c8` | SUPERSEDED | 5/1/0/0 | 9ef520910f | 🐛 fix(mvp): a retry of a retried run keeps its requesting tab | apps/mvp/src/flows/requests.test.ts: landed as 37d79960c6 (same author and time, committed |
| 2026-10-21 16:10 | `9ddb4ee002` | SUPERSEDED | 4/3/0/0 | 9ef520910f | 🐛 fix(mvp): a tab port's handlers live in its scope: stop and timeouts | apps/mvp/src/flows/tabPort.test.ts: main carried then changed it: 124fdc7e00 (🔍 chore(mvp) |
| 2026-10-21 16:10 | `5074e5e177` | SUPERSEDED | 13/8/0/0 | 245fc53d61 | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `9943a877b0` | ON-MAIN | 2/0/0/0 | 245fc53d61 | 🐛 fix(mvp): the runs list fills its page with runs a person sees, past |  |
| 2026-10-21 16:10 | `b0435f24c8` | SUPERSEDED | 5/1/0/0 | 245fc53d61 | 🐛 fix(mvp): a retry of a retried run keeps its requesting tab | apps/mvp/src/flows/requests.test.ts: landed as 37d79960c6 (same author and time, committed |
| 2026-10-21 16:10 | `216620abc4` | SUPERSEDED | 4/3/0/0 | 245fc53d61 | 🐛 fix(mvp): a tab port's handlers live in its scope: stop and timeouts | apps/mvp/src/flows/tabPort.test.ts: main carried then changed it: 124fdc7e00 (🔍 chore(mvp) |
| 2026-10-21 16:10 | `a5bf596f10` | SUPERSEDED | 1/1/0/0 | a2cc4468ea | 📝 docs(mvp): the production e2e work note: the asking specs answer, an | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 392244fbab (🐛 fix(mvp): prod |
| 2026-10-21 16:10 | `0d9fbb0cff` | SUPERSEDED | 13/8/0/0 | 43007b0fd8 | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `bd212b62d5` | ON-MAIN | 2/0/0/0 | 43007b0fd8 | 🐛 fix(mvp): the runs list fills its page with runs a person sees, past |  |
| 2026-10-21 16:10 | `078008315f` | SUPERSEDED | 5/1/0/0 | 43007b0fd8 | 🐛 fix(mvp): a retry of a retried run keeps its requesting tab | apps/mvp/src/flows/requests.test.ts: landed as 37d79960c6 (same author and time, committed |
| 2026-10-21 16:10 | `3b30d7dc26` | SUPERSEDED | 4/3/0/0 | 43007b0fd8 | 🐛 fix(mvp): a tab port's handlers live in its scope: stop and timeouts | apps/mvp/src/flows/tabPort.test.ts: main carried then changed it: 124fdc7e00 (🔍 chore(mvp) |
| 2026-10-21 16:10 | `527c82d302` | SUPERSEDED | 1/1/0/0 | 4a47b426e6 | 📝 docs(mvp): the production e2e work note: the asking specs answer, an | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 392244fbab (🐛 fix(mvp): prod |
| 2026-10-21 16:10 | `40bf86ef3c` | SUPERSEDED | 1/1/0/0 | 43007b0fd8 | 📝 docs(mvp): the production e2e work note: the asking specs answer, an | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 392244fbab (🐛 fix(mvp): prod |
| 2026-10-21 16:10 | `a6b7c14f1f` | SUPERSEDED | 17/8/0/0 | fcd2fd1cd5 | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `99b29aea17` | SUPERSEDED | 15/10/0/0 | 3a7583d2a4 | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `90ab0fdca2` | ON-MAIN | 2/0/0/0 | fcd2fd1cd5 | 🐛 fix(mvp): the runs list fills its page with runs a person sees, past |  |
| 2026-10-21 16:10 | `245429ef9f` | SUPERSEDED | 5/1/0/0 | fcd2fd1cd5 | 🐛 fix(mvp): a retry of a retried run keeps its requesting tab | apps/mvp/src/flows/requests.test.ts: landed as 37d79960c6 (same author and time, committed |
| 2026-10-21 16:10 | `66bd8220af` | SUPERSEDED | 4/3/0/0 | fcd2fd1cd5 | 🐛 fix(mvp): a tab port's handlers live in its scope: stop and timeouts | apps/mvp/src/flows/tabPort.test.ts: main carried then changed it: 124fdc7e00 (🔍 chore(mvp) |
| 2026-10-21 16:10 | `cb057608ef` | SUPERSEDED | 13/8/0/0 | 1829e9d7ab | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `66d796561c` | SUPERSEDED | 11/10/0/0 | 87dde44da6 | 🐛 fix(mvp): a run page's reads and acts can't overwrite newer state, a | apps/mvp/src/features/runs/actions.ts: main carried then changed it: 959ed5fca8 (🐛 fix: la |
| 2026-10-21 16:10 | `9173532cde` | ON-MAIN | 2/0/0/0 | 1829e9d7ab | 🐛 fix(mvp): the runs list fills its page with runs a person sees, past |  |
| 2026-10-21 16:10 | `396241d55f` | SUPERSEDED | 5/1/0/0 | 1829e9d7ab | 🐛 fix(mvp): a retry of a retried run keeps its requesting tab | apps/mvp/src/flows/requests.test.ts: landed as 37d79960c6 (same author and time, committed |
| 2026-10-21 16:10 | `4ac8866ff2` | SUPERSEDED | 4/3/0/0 | 1829e9d7ab | 🐛 fix(mvp): a tab port's handlers live in its scope: stop and timeouts | apps/mvp/src/flows/tabPort.test.ts: main carried then changed it: 124fdc7e00 (🔍 chore(mvp) |
| 2026-10-21 16:10 | `47dbe2126a` | SUPERSEDED | 1/1/0/0 | fa5176b235 | 📝 docs(mvp): the production e2e work note: the asking specs answer, an | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 392244fbab (🐛 fix(mvp): prod |
| 2026-10-21 16:10 | `a5399fa4aa` | SUPERSEDED | 1/1/0/0 | 182c15c7f8 | 📝 docs(mvp): the production e2e work note: the asking specs answer, an | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 392244fbab (🐛 fix(mvp): prod |
| 2026-10-21 16:10 | `155b51bc5c` | SUPERSEDED | 1/1/0/0 | 62a5b476f6 | 📝 docs(mvp): the production e2e work note: the asking specs answer, an | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 392244fbab (🐛 fix(mvp): prod |
| 2026-10-21 16:10 | `38fb55ac49` | SUPERSEDED | 1/1/0/0 | 4400cde8bf | 📝 docs(mvp): the production e2e work note: the asking specs answer, an | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: 392244fbab (🐛 fix(mvp): prod |
| 2026-10-21 16:10 | `123aac80af` | SUPERSEDED | 0/1/0/0 | 66491a2430 | 📝 docs(mvp): the design for a run's change feed that moves while an ac | apps/mvp/docs/work/run-change-feed-progress.md: main carried then changed it: e3c8b6ea5a ( |
| 2026-10-21 16:10 | `7eaa33a84d` | STRANDED | 0/0/1/0 | b541e7346c | 📝 docs(repo): record retained legacy binary callers | apps/mvp/docs/work/legacy-followups.md: The server item is stopped: the published `@smthrs |
| 2026-10-21 16:13 | `b541e7346c` | STRANDED | 0/0/14/0 | b541e7346c | 🔥 chore(repo): remove retired reference-host runner hooks | .github/actionlint.yaml: # Custom labels of this repository's self-hosted runners, so acti |
| 2026-10-21 16:13 | `6a15b126a1` | STRANDED | 0/0/4/0 | 6a15b126a1 |  | apps/mvp/worker/flows/Todo.ts: +        if (todo.branch !== null && todo.baseSha !== null) |
| 2026-10-21 16:13 | `43205e918b` | STRANDED | 0/0/13/0 | 43205e918b |  | .github/actionlint.yaml: # Custom labels of this repository's self-hosted runners, so acti |
| 2026-10-21 16:14 | `9dcd1d5ead` | SUPERSEDED | 17/1/0/0 | 93af17ebd4 | 🐛 fix(mvp): a file's Save says Saved on every editor's screen, not onl | apps/mvp/docs/features/coedit.md: main carried then changed it: 2cbc01259b (✨ feat(mvp): M |
| 2026-10-21 16:14 | `a558f715f8` | ON-MAIN | 11/0/0/0 | 93af17ebd4 | ✨ feat(sync): SharedText marks, small named values every replica agree |  |
| 2026-10-21 16:14 | `e6aaaf8865` | SUPERSEDED | 17/1/0/0 | c09041d548 | 🐛 fix(mvp): a file's Save says Saved on every editor's screen, not onl | apps/mvp/docs/features/coedit.md: main carried then changed it: 2cbc01259b (✨ feat(mvp): M |
| 2026-10-21 16:14 | `531214c776` | ON-MAIN | 11/0/0/0 | c09041d548 | ✨ feat(sync): SharedText marks, small named values every replica agree |  |
| 2026-10-21 16:14 | `d7f47c74d3` | SUPERSEDED | 17/1/0/0 | 36df16b6cd | 🐛 fix(mvp): a file's Save says Saved on every editor's screen, not onl | apps/mvp/docs/features/coedit.md: main carried then changed it: 2cbc01259b (✨ feat(mvp): M |
| 2026-10-21 16:14 | `caad251749` | ON-MAIN | 16/0/0/0 | caad251749 |  |  |
| 2026-10-21 16:14 | `dec3bbdaf6` | ON-MAIN | 11/0/0/0 | 36df16b6cd | ✨ feat(sync): SharedText marks, small named values every replica agree |  |
| 2026-10-21 16:19 | `56e5dc330c` | SUPERSEDED | 25/4/0/0 | dcd6da80eb | 🐛 fix(mvp): live attention review: a pressed act runs again after fail | apps/mvp/src/features/attention/attention.test.ts: main carried then changed it: 28461c7ab |
| 2026-10-21 16:19 | `e41d8b11e8` | SUPERSEDED | 9/3/0/0 | 43007b0fd8 | 🐛 fix(flow): preserve retry and timeout boundary semantics | packages/smithers/flows/flow/CHANGELOG.md: landed as c67b5201ef (same author and time, com |
| 2026-10-21 16:19 | `d3037136fb` | SUPERSEDED | 10/2/0/0 | d3037136fb | 🐛 fix(flow): preserve retry and timeout boundary semantics | packages/smithers/flows/flow/src/Deadline.ts: main carried then changed it: 89b4eef1d7 (🎨 |
| 2026-10-21 16:20 | `0610666e71` | SUPERSEDED | 11/1/0/0 | 4b4584af3b | 🐛 fix(branch): tracking fails closed and recovery preserves user data | apps/mvp/worker/branch/Branches.ts: main carried then changed it: 52a5e776f9 (✨ feat(mvp): |
| 2026-10-21 16:20 | `67acb5cf0c` | SUPERSEDED | 11/1/0/0 | dd60c8c5bf | 🐛 fix(branch): tracking fails closed and recovery preserves user data | apps/mvp/worker/branch/Branches.ts: main carried then changed it: 52a5e776f9 (✨ feat(mvp): |
| 2026-10-21 16:20 | `7886df0eb0` | SUPERSEDED | 11/1/0/0 | 7886df0eb0 | 🐛 fix(branch): tracking fails closed and recovery preserves user data | apps/mvp/worker/branch/Branches.ts: main carried then changed it: 52a5e776f9 (✨ feat(mvp): |
| 2026-10-21 16:21 | `2b07590da1` | SUPERSEDED | 41/3/0/0 | c63dcc4693 | 🐛 fix(sdk): close the holes two review rounds found in receipts and th | .changeset/shared-sqlite-write-receipts.md: main carried then changed it: 157036ac8e (🐛 fi |
| 2026-10-21 16:21 | `73356731af` | SUPERSEDED | 0/1/0/0 | 0b93fc6d9a | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `962c9d8139` | SUPERSEDED | 0/1/0/0 | 0bbf6b3fbd | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `90f8ab8b57` | SUPERSEDED | 0/1/0/0 | 72a73899be | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `73f7cb74e4` | SUPERSEDED | 0/1/0/0 | 104a7b5e07 | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `e58f1fcdc2` | SUPERSEDED | 0/1/0/0 | 331891126f | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `8ffbbfd341` | SUPERSEDED | 0/1/0/0 | 9ef520910f | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `0c95e7537a` | SUPERSEDED | 0/1/0/0 | cc19e2287a | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `60944f7ece` | SUPERSEDED | 0/1/0/0 | 245fc53d61 | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `adcf04d3a9` | SUPERSEDED | 0/1/0/0 | 43007b0fd8 | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `e693ae964e` | SUPERSEDED | 0/1/0/0 | fcd2fd1cd5 | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `22d626f915` | SUPERSEDED | 0/1/0/0 | 3a7583d2a4 | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `4ab24343c4` | STRANDED | 0/0/1/0 | 4ab24343c4 |  | apps/site/public/llms-full.txt: -\| `getPull` \| `(owner, repo, number) => Effect<PullRequ |
| 2026-10-21 16:21 | `1f61aefdd2` | STRANDED | 0/0/1/0 | 1f61aefdd2 |  | apps/site/public/llms-full.txt: -\| `getPull` \| `(owner, repo, number) => Effect<PullRequ |
| 2026-10-21 16:21 | `753f5617ce` | SUPERSEDED | 0/1/0/0 | 1829e9d7ab | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `7f8e3d3192` | SUPERSEDED | 0/1/0/0 | 8fd3572d81 | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:21 | `27edbc62ee` | SUPERSEDED | 0/1/0/0 | 87dde44da6 | 📝 docs(mvp): FLOW-2 records Will's 0017 answer: the QuickJS realm is a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 16:22 | `40b5955724` | STRANDED | 0/0/1/0 | 62778583ba | 🐛 test(cli): the runner's live test answers Claude Code's bodiless GET | packages/smithers/test/Runner.live.test.ts: // Claude Code also opens a GET stream and end |
| 2026-10-21 16:22 | `e7737158b0` | ON-MAIN | 11/0/0/0 | e7737158b0 |  |  |
| 2026-10-21 16:23 | `fae2972933` | SUPERSEDED | 6/1/0/0 | fae2972933 | 📝 docs(mvp): live attention docs follow the review fixes | apps/mvp/docs/features/agent-status.md: main carried then changed it: 11836d148c (✨ feat(m |
| 2026-10-21 16:23 | `ad0b6bbbbe` | SUPERSEDED | 0/2/0/0 | ad0b6bbbbe |  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: e |
| 2026-10-21 16:23 | `250d68f731` | ON-MAIN | 11/0/0/0 | 250d68f731 | 🐛 fix(views): preserve own props and refuse checker bypasses |  |
| 2026-10-21 16:24 | `ab8a05ee3e` | SUPERSEDED | 14/9/0/0 | ab8a05ee3e |  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: e |
| 2026-10-21 16:32 | `ab5f407304` | PARTIAL | 2/2/2/4 | ab5f407304 |  | apps/mvp/docs/work/run-change-feed-progress.md: **Libraries:** catalog entries `@smthrs/en |
| 2026-10-21 16:33 | `bbec28815c` | PARTIAL | 19/1/3/1 | f0fcc1f28a | 🐛 fix(run-store): advance the change feed during long actions | apps/mvp/docs/work/run-change-feed-progress.md: +1001–1005. `EngineStore.Migrations.sets` |
| 2026-10-21 16:33 | `66491a2430` | PARTIAL | 31/6/2/1 | 66491a2430 | 🐛 fix(run-store): advance the change feed during long actions | apps/mvp/src/features/runs/remote.test.ts: await Effect.runPromise(t.api.remote.start(runI |
| 2026-10-21 16:33 | `41fd5f06de` | PARTIAL | 30/6/2/2 | 41fd5f06de |  | apps/mvp/docs/work/run-change-feed-progress.md: two backends. All 2,174 SQLite engine-stor |
| 2026-10-21 16:33 | `75b80c768b` | PARTIAL | 30/6/2/2 | 75b80c768b |  | apps/mvp/docs/work/run-change-feed-progress.md: two backends. All 2,174 SQLite engine-stor |
| 2026-10-21 16:33 | `4e803f491a` | SUPERSEDED | 5/1/0/0 | 4e803f491a |  | apps/mvp/worker/branch/Machine.ts: main carried then changed it: 412d39f431 (🔎 fix(mvp): r |
| 2026-10-21 16:33 | `cb85ebcf38` | PARTIAL | 0/0/4/2 | cb85ebcf38 |  | apps/mvp/worker/runners/Api.test.ts: expect(await runtime.runPromise((await store()).statu |
| 2026-10-21 16:33 | `bc01f1205d` | PARTIAL | 0/0/0/1 | bc01f1205d |  | packages/smithers/flows/engine-store/test/RunChangeProgress.test.ts: const revision = () = |
| 2026-10-21 16:34 | `a2cc4468ea` | SUPERSEDED | 26/8/0/0 | a2cc4468ea | 🐛 fix(mvp): production e2e on the branch page: Runs warms on hover, dr | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: ca765e92e0 (📝 docs(mvp): the |
| 2026-10-21 16:34 | `a312d0d88f` | SUPERSEDED | 26/8/0/0 | 43007b0fd8 | 🐛 fix(mvp): production e2e on the branch page: Runs warms on hover, dr | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: ca765e92e0 (📝 docs(mvp): the |
| 2026-10-21 16:34 | `4a47b426e6` | SUPERSEDED | 26/8/0/0 | 4a47b426e6 | 🐛 fix(mvp): production e2e on the branch page: Runs warms on hover, dr | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: ca765e92e0 (📝 docs(mvp): the |
| 2026-10-21 16:34 | `7a0d7b4ab9` | SUPERSEDED | 26/8/0/0 | fa5176b235 | 🐛 fix(mvp): production e2e on the branch page: Runs warms on hover, dr | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: ca765e92e0 (📝 docs(mvp): the |
| 2026-10-21 16:34 | `182c15c7f8` | SUPERSEDED | 25/9/0/0 | 182c15c7f8 |  | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: ca765e92e0 (📝 docs(mvp): the |
| 2026-10-21 16:34 | `62a5b476f6` | SUPERSEDED | 25/9/0/0 | 62a5b476f6 |  | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: ca765e92e0 (📝 docs(mvp): the |
| 2026-10-21 16:34 | `4400cde8bf` | SUPERSEDED | 25/9/0/0 | 4400cde8bf | 🐛 fix(mvp): production e2e on the branch page: Runs warms on hover, dr | apps/mvp/docs/work/prod-e2e.md: main carried then changed it: ca765e92e0 (📝 docs(mvp): the |
| 2026-10-21 16:34 | `5efaccd151` | PARTIAL | 3/0/31/4 | 62778583ba | 🔒 fix(mvp): agent jobs fence every claim, bind the job to its person,  | apps/mvp/docs/features/agent-backends.md: \| `cancel(key)` \| sets `cancel_requested`; a q |
| 2026-10-21 16:34 | `780e271165` | PARTIAL | 8/0/2/1 | 62778583ba | 🐛 fix(flow,agent): a job's stop is retried until the store records it, | .changeset/flow-external-job-stop-retry.md: `AgentRunner.AgentJobs.cancel` may fail `Agent |
| 2026-10-21 16:37 | `bcd17fa517` | ON-MAIN | 31/0/0/0 | 0b93fc6d9a | 🐛 fix(time-travel): renew a fork's reservation before it provisions it |  |
| 2026-10-21 16:37 | `f948f32c2c` | ON-MAIN | 31/0/0/0 | 72a73899be | 🐛 fix(time-travel): renew a fork's reservation before it provisions it |  |
| 2026-10-21 16:37 | `7ffa7a5d91` | ON-MAIN | 31/0/0/0 | 104a7b5e07 | 🐛 fix(time-travel): renew a fork's reservation before it provisions it |  |
| 2026-10-21 16:37 | `1923ef0ef2` | ON-MAIN | 31/0/0/0 | 9ef520910f | 🐛 fix(time-travel): renew a fork's reservation before it provisions it |  |
| 2026-10-21 16:37 | `cea64bccd7` | ON-MAIN | 31/0/0/0 | 245fc53d61 | 🐛 fix(time-travel): renew a fork's reservation before it provisions it |  |
| 2026-10-21 16:37 | `0bdb0289ff` | ON-MAIN | 24/0/0/0 | a2cc4468ea | 🐛 fix(engine): sealed action keys name their encoding, and a run reads |  |
| 2026-10-21 16:37 | `726f238daa` | ON-MAIN | 31/0/0/0 | 43007b0fd8 | 🐛 fix(time-travel): renew a fork's reservation before it provisions it |  |
| 2026-10-21 16:37 | `3b239e82b2` | ON-MAIN | 24/0/0/0 | 43007b0fd8 | 🐛 fix(engine): sealed action keys name their encoding, and a run reads |  |
| 2026-10-21 16:37 | `ff5d526c00` | ON-MAIN | 24/0/0/0 | 4a47b426e6 | 🐛 fix(engine): sealed action keys name their encoding, and a run reads |  |
| 2026-10-21 16:37 | `968a2cc56e` | ON-MAIN | 18/0/0/0 | 968a2cc56e | 🐛 fix(engine): sealed action keys name their encoding, and a run reads |  |
| 2026-10-21 16:37 | `790049b8b7` | ON-MAIN | 31/0/0/0 | 1829e9d7ab | 🐛 fix(time-travel): renew a fork's reservation before it provisions it |  |
| 2026-10-21 16:37 | `b2604d9a24` | ON-MAIN | 24/0/0/0 | b2604d9a24 | 🐛 fix(engine): sealed action keys name their encoding, and a run reads |  |
| 2026-10-21 16:37 | `b1e0d86cb7` | ON-MAIN | 31/0/0/0 | b1e0d86cb7 | 🐛 fix(time-travel): renew a fork's reservation before it provisions it |  |
| 2026-10-21 16:37 | `2bab452b78` | PARTIAL | 31/0/1/0 | 2bab452b78 | 🐛 fix(time-travel): renew a fork's reservation before it provisions it | apps/mvp/docs/work/time-travel-renew-fork-reservation.md: and the SQLite/PostgreSQL covera |
| 2026-10-21 16:37 | `997ce2d97f` | PARTIAL | 31/0/1/0 | 997ce2d97f |  | apps/mvp/docs/work/time-travel-renew-fork-reservation.md: and the SQLite/PostgreSQL covera |
| 2026-10-21 16:37 | `23f5cee51b` | PARTIAL | 31/0/1/0 | 23f5cee51b |  | apps/mvp/docs/work/time-travel-renew-fork-reservation.md: and the SQLite/PostgreSQL covera |
| 2026-10-21 16:37 | `44072e34e3` | ON-MAIN | 18/0/0/0 | 44072e34e3 | 🐛 fix(engine): sealed action keys name their encoding, and a run reads |  |
| 2026-10-21 16:41 | `3f722a5b6a` | SUPERSEDED | 6/3/0/0 | 93af17ebd4 | 📈 feat(sandbox): a wake says how long it took, and which step was slow | apps/mvp/worker/BranchSandboxes.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp): |
| 2026-10-21 16:41 | `82d98c4be2` | SUPERSEDED | 6/3/0/0 | c09041d548 | 📈 feat(sandbox): a wake says how long it took, and which step was slow | apps/mvp/worker/BranchSandboxes.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp): |
| 2026-10-21 16:41 | `3010e70d0d` | SUPERSEDED | 5/1/0/0 | fa5176b235 | ✅ test(mvp): co-editing e2e runs on a deployment: two devices edit a f | apps/mvp/docs/work/branch-coediting.md: main carried then changed it: f05ef46fb7 (📝 docs(m |
| 2026-10-21 16:41 | `56d7847b58` | SUPERSEDED | 5/1/0/0 | 0a3e757882 | ✅ test(mvp): co-editing e2e runs on a deployment: two devices edit a f | apps/mvp/docs/work/branch-coediting.md: main carried then changed it: f05ef46fb7 (📝 docs(m |
| 2026-10-21 16:41 | `36df16b6cd` | SUPERSEDED | 2/2/0/0 | 36df16b6cd |  | apps/mvp/docs/work/branch-coediting.md: main carried then changed it: f05ef46fb7 (📝 docs(m |
| 2026-10-21 16:41 | `e19219bc20` | SUPERSEDED | 6/3/0/0 | 36df16b6cd | 📈 feat(sandbox): a wake says how long it took, and which step was slow | apps/mvp/worker/BranchSandboxes.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp): |
| 2026-10-21 16:43 | `4864de0363` | ON-MAIN | 6/0/0/0 | 4864de0363 |  |  |
| 2026-10-21 16:45 | `e434b4fc3e` | EMPTY-ISH | 0/0/0/0 | 31778ff498 | 🔧 chore: lockfiles and the target index for VibeLang 0.0.3 |  |
| 2026-10-21 16:45 | `d048301dfc` | PARTIAL | 8/15/0/1 | d048301dfc | 🔧 chore: lockfiles and the target index for VibeLang 0.0.3 | .smithers/flows/release/fixtures/public-api-baseline.json: "NodeTest.d.ts": "83418e2a7c009 |
| 2026-10-21 16:47 | `d9f667dd21` | ON-MAIN | 1/0/0/0 | d9f667dd21 | ✅ test(mvp): the late-lock admission test waits with Effect.sleep, not |  |
| 2026-10-21 16:50 | `1e6feffb1d` | SUPERSEDED | 8/1/0/0 | 1e6feffb1d | ✅ test(mvp): clear importRules timing violations | apps/mvp/src/features/runs/remote.test.ts: main carried then changed it: e3c8b6ea5a (🐛 fix |
| 2026-10-21 16:50 | `50a8bb7c70` | SUPERSEDED | 7/2/0/0 | 50a8bb7c70 |  | apps/mvp/docs/work/importrules-reds.md: landed as f3d1971652 (same author and time, commit |
| 2026-10-21 16:51 | `e294a3c4ee` | PARTIAL | 102/9/3/11 | e294a3c4ee |  | packages/smithers/flows/database/docs/api.md: interface WriteOptions {; packages/smithers/ |
| 2026-10-21 16:51 | `c816c9e732` | SUPERSEDED | 1/4/0/0 | 73e68aed9e | 🐛 fix(mvp): a zombie process no longer keeps a branch machine awake | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: 7162e3d55b (🐛 fix(m |
| 2026-10-21 16:51 | `b524eb7b22` | SUPERSEDED | 2/4/0/0 | b524eb7b22 |  | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: 7162e3d55b (🐛 fix(m |
| 2026-10-21 16:53 | `3cb9c48164` | PARTIAL | 113/10/3/4 | 1cd360747c | ⚡ perf(flows): runs write their journals and engine state side by side | packages/smithers/flows/database/docs/api.md: interface WriteOptions {; packages/smithers/ |
| 2026-10-21 16:53 | `d36edc4400` | PARTIAL | 109/9/3/8 | d36edc4400 |  | packages/smithers/flows/database/docs/api.md: interface WriteOptions {; packages/smithers/ |
| 2026-10-21 16:53 | `b839008003` | PARTIAL | 101/9/3/11 | b839008003 |  | packages/smithers/flows/database/docs/api.md: interface WriteOptions {; packages/smithers/ |
| 2026-10-21 16:53 | `46d017becd` | SCAFFOLD | 105/12/3/5 | c0046c5d2d | WIP(flows): run writer locks, not green, do not land | packages/smithers/flows/database/docs/api.md: interface WriteOptions {; packages/smithers/ |
| 2026-10-21 16:53 | `4c5edf7e75` | PARTIAL | 114/10/3/2 | fcbc2db3f3 | ⚡ perf(flows): runs write their journals and engine state side by side | packages/smithers/flows/database/docs/api.md: interface WriteOptions {; packages/smithers/ |
| 2026-10-21 16:58 | `97b21f6d7e` | PARTIAL | 3/0/13/1 | 62778583ba | ✨ feat(mvp): a TODO's coding goes to the coding role's agent: the loop | apps/mvp/worker/flows/Todo.test.ts: import { Agent, AgentRunner } from "@smthrs/agent"; ap |
| 2026-10-21 17:03 | `c3ffd23074` | SUPERSEDED | 50/22/0/0 | 0b93fc6d9a | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 17:03 | `cb1f62e93f` | SUPERSEDED | 50/22/0/0 | 0bbf6b3fbd | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: landed as 4656e2586b (same author and time, committed later) |
| 2026-10-21 17:03 | `2f034230bf` | SUPERSEDED | 50/22/0/0 | 72a73899be | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 17:03 | `b42a96dab9` | SUPERSEDED | 50/22/0/0 | 104a7b5e07 | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 17:03 | `37d8147c61` | SUPERSEDED | 50/22/0/0 | 331891126f | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: landed as 4656e2586b (same author and time, committed later) |
| 2026-10-21 17:03 | `91303dbb2a` | SUPERSEDED | 50/22/0/0 | 9ef520910f | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 17:03 | `b641def329` | SUPERSEDED | 50/22/0/0 | cc19e2287a | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: landed as 4656e2586b (same author and time, committed later) |
| 2026-10-21 17:03 | `ad1ed83b6f` | SUPERSEDED | 50/22/0/0 | 245fc53d61 | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 17:03 | `ba446d5f16` | SUPERSEDED | 50/22/0/0 | 43007b0fd8 | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 17:03 | `6ca2b288c0` | SUPERSEDED | 50/22/0/0 | fcd2fd1cd5 | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: landed as 4656e2586b (same author and time, committed later) |
| 2026-10-21 17:03 | `1781f52c2f` | SUPERSEDED | 50/22/0/0 | 3a7583d2a4 | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: landed as 4656e2586b (same author and time, committed later) |
| 2026-10-21 17:03 | `1829e9d7ab` | SUPERSEDED | 50/22/0/0 | 1829e9d7ab | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-21 17:03 | `8fd3572d81` | SUPERSEDED | 50/22/0/0 | 8fd3572d81 | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: landed as 4656e2586b (same author and time, committed later) |
| 2026-10-21 17:03 | `87dde44da6` | SUPERSEDED | 50/22/0/0 | 87dde44da6 | ✨ feat(mvp): a stuck or failed draft offers Draft again and Delete, an | apps/mvp/db/Database.ts: landed as 4656e2586b (same author and time, committed later) |
| 2026-10-21 17:09 | `2849e27fb1` | STRANDED | 0/0/4/0 | 2849e27fb1 |  | packages/smithers/flows/patterns/src/Runbook.ts: +    error: Failure.schemaFor([PatternErr |
| 2026-10-21 17:09 | `0a20cc956d` | STRANDED | 0/0/4/0 | 0a20cc956d |  | packages/smithers/flows/patterns/src/Runbook.ts: +    error: Failure.schemaFor([PatternErr |
| 2026-10-21 17:09 | `514c5839a7` | PARTIAL | 2/0/20/6 | 514c5839a7 |  | apps/mvp/docs/features/chat.md: - If Smithers can't answer, the answer says `Couldn't answ |
| 2026-10-21 17:09 | `fe44e5949f` | PARTIAL | 31/1/0/4 | fe44e5949f |  | packages/smithers/flows/patterns/src/Runbook.ts: error: Failure.schemaFor([PatternError], |
| 2026-10-21 17:10 | `5c54f61672` | ON-MAIN | 3/0/0/0 | fa5176b235 | ✅ test(mvp): the two known gaps of a shared Saved, as tests marked bro |  |
| 2026-10-21 17:10 | `cb2f611705` | ON-MAIN | 3/0/0/0 | 0a3e757882 | ✅ test(mvp): the two known gaps of a shared Saved, as tests marked bro |  |
| 2026-10-21 17:15 | `9c238a8466` | SUPERSEDED | 12/4/0/0 | 4b4584af3b | 🐛 fix(evals): preserve safe baselines and settle trial resources | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 17:15 | `d16d5d5adc` | SUPERSEDED | 12/4/0/0 | d16d5d5adc | 🐛 fix(evals): preserve safe baselines and settle trial resources | apps/mvp/docs/features/agent-evals.md: main carried then changed it: f3e8043de9 (✅ test(mv |
| 2026-10-21 17:16 | `7bdb8f6aa1` | SUPERSEDED | 16/1/0/0 | 4b4584af3b | 🐛 fix(flows-examples): preserve replay state and report transport outc | packages/smithers/flows/test/examples/10-telemetry-export.test.ts: main carried then chang |
| 2026-10-21 17:16 | `b5686afaff` | SUPERSEDED | 16/1/0/0 | dd60c8c5bf | 🐛 fix(flows-examples): preserve replay state and report transport outc | packages/smithers/flows/test/examples/10-telemetry-export.test.ts: main carried then chang |
| 2026-10-21 17:16 | `ce6c44a649` | SUPERSEDED | 16/1/0/0 | ce6c44a649 | 🐛 fix(flows-examples): preserve replay state and report transport outc | packages/smithers/flows/test/examples/10-telemetry-export.test.ts: main carried then chang |
| 2026-10-21 17:17 | `d85b1a9b27` | SUPERSEDED | 19/1/0/0 | 1ea57261a4 | 🐛 fix(code-intel): discard stale responses and preserve browser shortc | apps/mvp/src/features/code-intel/codeIntel.ts: main carried then changed it: e1a134f198 (🐛 |
| 2026-10-21 17:17 | `d51330821c` | SUPERSEDED | 19/1/0/0 | 5d3efd101f | 🐛 fix(code-intel): discard stale responses and preserve browser shortc | apps/mvp/src/features/code-intel/codeIntel.ts: main carried then changed it: e1a134f198 (🐛 |
| 2026-10-21 17:17 | `c442f6f930` | SUPERSEDED | 19/1/0/0 | f1257d53d3 | 🐛 fix(code-intel): discard stale responses and preserve browser shortc | apps/mvp/src/features/code-intel/codeIntel.ts: main carried then changed it: e1a134f198 (🐛 |
| 2026-10-21 17:17 | `910e4e0206` | SUPERSEDED | 19/1/0/0 | 3d6dac6fb7 | 🐛 fix(code-intel): discard stale responses and preserve browser shortc | apps/mvp/src/features/code-intel/codeIntel.ts: main carried then changed it: e1a134f198 (🐛 |
| 2026-10-21 17:17 | `f9496ead99` | SUPERSEDED | 19/1/0/0 | dd60c8c5bf | 🐛 fix(code-intel): discard stale responses and preserve browser shortc | apps/mvp/src/features/code-intel/codeIntel.ts: main carried then changed it: e1a134f198 (🐛 |
| 2026-10-21 17:17 | `01b2a5b732` | SUPERSEDED | 19/1/0/0 | 01b2a5b732 | 🐛 fix(code-intel): discard stale responses and preserve browser shortc | apps/mvp/src/features/code-intel/codeIntel.ts: main carried then changed it: e1a134f198 (🐛 |
| 2026-10-21 17:18 | `6cbcebadd4` | SUPERSEDED | 18/1/0/0 | 4b4584af3b | 🐛 fix(home): isolate actions and recover interrupted reads | apps/mvp/src/features/home/actions.ts: main carried then changed it: 584a409be1 (✨ feat(mv |
| 2026-10-21 17:18 | `2f1a54c73d` | SUPERSEDED | 18/1/0/0 | dd60c8c5bf | 🐛 fix(home): isolate actions and recover interrupted reads | apps/mvp/src/features/home/actions.ts: main carried then changed it: 584a409be1 (✨ feat(mv |
| 2026-10-21 17:18 | `a750cccd36` | SUPERSEDED | 18/1/0/0 | a750cccd36 | 🐛 fix(home): isolate actions and recover interrupted reads | apps/mvp/src/features/home/actions.ts: main carried then changed it: 584a409be1 (✨ feat(mv |
| 2026-10-21 17:23 | `d63b03522a` | PARTIAL | 9/0/1/1 | a2cc4468ea | 🐛 fix(flow): nested sibling suspensions settle and encoded codec types | apps/mvp/docs/work/flow-sibling-suspension-codec.md: Both regressions failed before their |
| 2026-10-21 17:23 | `20d0e42413` | PARTIAL | 9/0/1/1 | 4a47b426e6 | 🐛 fix(flow): nested sibling suspensions settle and encoded codec types | apps/mvp/docs/work/flow-sibling-suspension-codec.md: Both regressions failed before their |
| 2026-10-21 17:23 | `ecea1e22e6` | PARTIAL | 9/0/1/1 | ecea1e22e6 | 🐛 fix(flow): nested sibling suspensions settle and encoded codec types | apps/mvp/docs/work/flow-sibling-suspension-codec.md: Both regressions failed before their |
| 2026-10-21 17:25 | `ebd0c65938` | ON-MAIN | 18/0/0/0 | 4b4584af3b | 🐛 fix(mvp): join benchmark workers before finalizing evidence |  |
| 2026-10-21 17:25 | `b15718846b` | PARTIAL | 7/0/1/0 | 4b4584af3b | 🐛 fix(views): share first opens and preserve navigation order | apps/mvp/src/features/views/views.test.ts: * The app as `actor` (a Member unless `null`), |
| 2026-10-21 17:25 | `1d46172b03` | SUPERSEDED | 24/3/0/0 | 1d46172b03 | 🐛 fix(agent): keep diagnostics private and resolve seats lazily | packages/smithers/agent/README.md: main carried then changed it: 387adb691e (🐛 fix(agent): |
| 2026-10-21 17:25 | `0267262ad7` | SUPERSEDED | 7/1/0/0 | 0267262ad7 | 🐛 fix(views): share first opens and preserve navigation order | apps/mvp/src/features/views/views.test.ts: landed as 4dd1444fb3 (same author and time, com |
| 2026-10-21 17:25 | `8770d3b357` | ON-MAIN | 18/0/0/0 | 8770d3b357 | 🐛 fix(mvp): join benchmark workers before finalizing evidence |  |
| 2026-10-21 17:27 | `f129e8e7ef` | PARTIAL | 2/0/12/1 | f129e8e7ef | 🐛 fix(issues): preserve newer drafts and submission ownership | apps/mvp/docs/features/issues.md: Replacing a commitment removes only a matching local rec |
| 2026-10-21 17:30 | `6477a5d540` | SUPERSEDED | 10/3/0/0 | 6477a5d540 | 🐛 fix(effect-code-storage): bound error diagnostics and validate read  | packages/effect-code-storage/src/internal/bounded.ts: main carried then changed it: e8fc61 |
| 2026-10-21 17:30 | `b8a154457f` | PARTIAL | 0/0/7/2 | b8a154457f | 🐛 fix(platform-browser): validate stats and retain filesystem operatio | apps/mvp/docs/work/fix-browser-filesystem-441211.md: the fix, including the configured 100 |
| 2026-10-21 17:33 | `1c02db0ba8` | ON-MAIN | 5/0/0/0 | 1c02db0ba8 | 🐛 fix(harness): seal reentrant dispatch and bound sparse traversal |  |
| 2026-10-21 17:37 | `93af17ebd4` | SUPERSEDED | 10/2/0/0 | 93af17ebd4 |  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: e |
| 2026-10-21 17:37 | `c09041d548` | SUPERSEDED | 10/2/0/0 | c09041d548 |  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: e |
| 2026-10-21 17:38 | `e92fcf3e80` | SUPERSEDED | 3/2/0/0 | e92fcf3e80 | 🐛 fix(effect-tanstack-db): preserve own __proto__ stored fields | packages/effect-tanstack-db/src/internal/stored.ts: main carried then changed it: 89b4eef1 |
| 2026-10-21 20:28 | `c58d5f8887` | SUPERSEDED | 3/5/0/0 | 0b93fc6d9a | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `e348a085fd` | SUPERSEDED | 3/5/0/0 | 0bbf6b3fbd | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `fc07e1d82e` | SUPERSEDED | 3/5/0/0 | 72a73899be | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `28c3f613e2` | SUPERSEDED | 3/5/0/0 | 104a7b5e07 | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `623ffae0ca` | SUPERSEDED | 3/5/0/0 | 331891126f | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `983b602f03` | SUPERSEDED | 3/5/0/0 | 9ef520910f | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `7faa446440` | SUPERSEDED | 3/5/0/0 | cc19e2287a | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `af01600fdc` | SUPERSEDED | 3/5/0/0 | 245fc53d61 | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `04debd8b9d` | SUPERSEDED | 3/5/0/0 | 43007b0fd8 | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `f308db85df` | SUPERSEDED | 3/5/0/0 | fcd2fd1cd5 | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `9719d3efb7` | SUPERSEDED | 3/5/0/0 | 3a7583d2a4 | 📝 docs(mvp): flows: why a draft failed, Draft again, Delete a draft, o | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 20:28 | `563a400092` | PARTIAL | 34/1/0/2 | 563a400092 |  | packages/smithers/flows/patterns/src/internal/Failure.ts: if (schema === Schema.Unknown \ |
| 2026-10-21 20:29 | `f8e53326b2` | ON-MAIN | 1/0/0/0 | c63dcc4693 | ✅ test(sdk): the browser runtime's parked-run test waits for the run's |  |
| 2026-10-21 20:29 | `f3b22f1327` | STRANDED | 0/0/7/0 | 4ab24343c4 | Merge main and the curator's 3314ec3a (base for the GitHub write harde | apps/mvp/db/Database.test.ts: describe("0039_github_projection_fences", () => {; apps/mvp/ |
| 2026-10-21 20:33 | `dd09d6cd4e` | ON-MAIN | 1/0/0/0 | 104a7b5e07 | 🧪 test(mvp): a branch machine's whole life, end to end, locally and in |  |
| 2026-10-21 20:33 | `53b655c515` | ON-MAIN | 1/0/0/0 | b95118a69b | 🧪 test(mvp): a branch machine's whole life, end to end, locally and in |  |
| 2026-10-21 20:33 | `cfd53cbfe1` | ON-MAIN | 1/0/0/0 | 9ef520910f | 🧪 test(mvp): a branch machine's whole life, end to end, locally and in |  |
| 2026-10-21 20:33 | `0678fc0ffd` | ON-MAIN | 1/0/0/0 | 911860abdb | 🧪 test(mvp): a branch machine's whole life, end to end, locally and in |  |
| 2026-10-21 20:33 | `2722b1fb43` | ON-MAIN | 1/0/0/0 | 73e68aed9e | 🧪 test(mvp): a branch machine's whole life, end to end, locally and in |  |
| 2026-10-21 20:41 | `ed85812c06` | ON-MAIN | 10/0/0/0 | c63dcc4693 | 🐛 fix(sdk): the third review's receipt holes: a unique index, a writab |  |
| 2026-10-21 20:43 | `f755b0832d` | ON-MAIN | 15/0/0/0 | 4b4584af3b | 🐛 fix(dev): await HTTPS startup on shutdown and generate certificates  |  |
| 2026-10-21 20:43 | `7c61791ef6` | ON-MAIN | 15/0/0/0 | 7c61791ef6 | 🐛 fix(dev): await HTTPS startup on shutdown and generate certificates  |  |
| 2026-10-21 20:44 | `35ab77a1ee` | SUPERSEDED | 3/3/0/0 | 104a7b5e07 | 🐛 fix(mvp): a branch sandbox's PID 1 reaps orphans, and the image has  | apps/mvp/docs/work/sandboxes.md: main carried then changed it: 78edec1c09 (📝 docs(mvp): ru |
| 2026-10-21 20:44 | `b95118a69b` | SUPERSEDED | 3/3/0/0 | b95118a69b | 🐛 fix(mvp): a branch sandbox's PID 1 reaps orphans, and the image has  | apps/mvp/docs/work/sandboxes.md: main carried then changed it: 78edec1c09 (📝 docs(mvp): ru |
| 2026-10-21 20:44 | `8de24ad274` | SUPERSEDED | 3/3/0/0 | 9ef520910f | 🐛 fix(mvp): a branch sandbox's PID 1 reaps orphans, and the image has  | apps/mvp/docs/work/sandboxes.md: main carried then changed it: 78edec1c09 (📝 docs(mvp): ru |
| 2026-10-21 20:44 | `911860abdb` | SUPERSEDED | 3/3/0/0 | 911860abdb | 🐛 fix(mvp): a branch sandbox's PID 1 reaps orphans, and the image has  | apps/mvp/docs/work/sandboxes.md: main carried then changed it: 78edec1c09 (📝 docs(mvp): ru |
| 2026-10-21 20:44 | `73e68aed9e` | SUPERSEDED | 3/2/0/0 | 73e68aed9e | 🐛 fix(mvp): a branch sandbox's PID 1 reaps orphans, and the image has  | apps/mvp/infra/sandbox/Dockerfile: main carried then changed it: e3a4a95b63 (✨ feat(mvp): |
| 2026-10-21 20:44 | `9ea9fe32a2` | SUPERSEDED | 3/2/0/0 | 9ea9fe32a2 |  | apps/mvp/infra/sandbox/Dockerfile: main carried then changed it: e3a4a95b63 (✨ feat(mvp): |
| 2026-10-21 20:44 | `0a3e757882` | SUPERSEDED | 1/1/0/0 | 0a3e757882 | 📝 docs(mvp): co-editing saves pass in production; the work note's evid | apps/mvp/docs/work/branch-coediting.md: main carried then changed it: 78edec1c09 (📝 docs(m |
| 2026-10-21 20:46 | `15f0dbca51` | PARTIAL | 0/0/6/2 | 15f0dbca51 | 🐛 fix(mvp): restrict dev file serving and match Jev scopes faithfully | apps/mvp/PACKAGE.test.ts: * `matchesGlob` for import rules (ImportRulesCheck) and minimatc |
| 2026-10-21 20:46 | `32562de10e` | PARTIAL | 0/0/6/2 | 32562de10e |  | apps/mvp/PACKAGE.test.ts: * `matchesGlob` for import rules (ImportRulesCheck) and minimatc |
| 2026-10-21 20:48 | `6219c20372` | SUPERSEDED | 25/2/0/0 | c0046c5d2d | WIP(flows): Astra review fixes for run writer locks, not green yet | packages/smithers/flows/database/docs/decisions/0001-run-writer-locks.md: main carried the |
| 2026-10-21 20:49 | `daecd8e185` | ON-MAIN | 23/0/0/0 | 104a7b5e07 | 🐛 fix(platform-cloudflare): budget terminal input by bytes and clean u |  |
| 2026-10-21 20:49 | `aa3f1ffbb1` | ON-MAIN | 23/0/0/0 | 9ef520910f | 🐛 fix(platform-cloudflare): budget terminal input by bytes and clean u |  |
| 2026-10-21 20:49 | `be566dea20` | ON-MAIN | 23/0/0/0 | a57b7d5307 | 🐛 fix(platform-cloudflare): budget terminal input by bytes and clean u |  |
| 2026-10-21 20:49 | `ef68a20877` | SUPERSEDED | 17/5/0/0 | b111fae417 | 🐛 fix(platform-cloudflare): budget terminal input by bytes and clean u | .changeset/cloudflare-terminal-input-bounds.md: landed as 7c5cd5f1b5 (same author and time |
| 2026-10-21 20:49 | `3de65809d7` | SUPERSEDED | 17/5/0/0 | 8d3f1bb804 | 🐛 fix(platform-cloudflare): budget terminal input by bytes and clean u | .changeset/cloudflare-terminal-input-bounds.md: landed as 7c5cd5f1b5 (same author and time |
| 2026-10-21 20:51 | `092f8d2167` | PARTIAL | 10/10/1/2 | 092f8d2167 | ✨ feat(mvp): serve the app at its domain, with the docs site beside it | apps/mvp/alchemy.run.ts: ...(Option.isSome(domain) ? { domain: domain.value } : {}),; apps |
| 2026-10-21 20:51 | `b2273ae344` | PARTIAL | 10/10/1/2 | b2273ae344 | ✨ feat(mvp): serve the app at its domain, with the docs site beside it | apps/mvp/alchemy.run.ts: ...(Option.isSome(domain) ? { domain: domain.value } : {}),; apps |
| 2026-10-21 20:51 | `f8074e6564` | SUPERSEDED | 16/11/0/0 | f8074e6564 | ✨ feat(mvp): serve the app at its domain, with the docs site beside it | apps/mvp/alchemy.run.ts: main carried then changed it: f5fec2eb0d (✨ feat(mvp): redirect o |
| 2026-10-21 20:57 | `3ffd6cdd84` | SUPERSEDED | 2/1/0/0 | 104a7b5e07 | 🐛 fix(platform-cloudflare): guard a SQL reason beyond the diagnostic c | packages/smithers/flows/platform-cloudflare/src/internal/FailureDetail.ts: main carried th |
| 2026-10-21 20:57 | `dfca2b97ed` | SUPERSEDED | 2/1/0/0 | 9ef520910f | 🐛 fix(platform-cloudflare): guard a SQL reason beyond the diagnostic c | packages/smithers/flows/platform-cloudflare/src/internal/FailureDetail.ts: main carried th |
| 2026-10-21 20:57 | `b111fae417` | PARTIAL | 0/4/12/0 | b111fae417 | 🐛 fix(platform-cloudflare): keep migration diagnostics free of SQL con | apps/mvp/docs/work/platform-cloudflare-review-fixes.md: links: [../../../../packages/smith |
| 2026-10-21 20:57 | `a57b7d5307` | SUPERSEDED | 2/1/0/0 | a57b7d5307 | 🐛 fix(platform-cloudflare): guard a SQL reason beyond the diagnostic c | packages/smithers/flows/platform-cloudflare/src/internal/FailureDetail.ts: main carried th |
| 2026-10-21 20:57 | `28e108b028` | SUPERSEDED | 2/1/0/0 | 28e108b028 | 🐛 fix(platform-cloudflare): guard a SQL reason beyond the diagnostic c | packages/smithers/flows/platform-cloudflare/src/internal/FailureDetail.ts: main carried th |
| 2026-10-21 20:57 | `8d3f1bb804` | SUPERSEDED | 2/1/0/0 | 8d3f1bb804 | 🐛 fix(platform-cloudflare): keep migration diagnostics free of SQL con | packages/smithers/flows/platform-cloudflare/src/internal/FailureDetail.ts: landed as dc5dc |
| 2026-10-21 20:58 | `7a95f46340` | SUPERSEDED | 23/4/0/0 | 0b93fc6d9a | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `52b9defdea` | SUPERSEDED | 23/4/0/0 | 0bbf6b3fbd | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `4a27c46eee` | SUPERSEDED | 23/4/0/0 | 72a73899be | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `592eb2bf64` | SUPERSEDED | 23/4/0/0 | 104a7b5e07 | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `b2170b5e8a` | SUPERSEDED | 23/4/0/0 | 331891126f | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `1ac19eb86b` | SUPERSEDED | 23/4/0/0 | 9ef520910f | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `7cb2c8e68a` | SUPERSEDED | 23/4/0/0 | cc19e2287a | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `c68953d5c9` | SUPERSEDED | 23/4/0/0 | 245fc53d61 | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `e4afc1037e` | SUPERSEDED | 23/4/0/0 | 43007b0fd8 | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `cc8316508e` | SUPERSEDED | 23/4/0/0 | fcd2fd1cd5 | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `e71e20b5f1` | SUPERSEDED | 22/5/0/0 | 3a7583d2a4 | 🐛 fix(mvp): flows review: Save checks the draft it holds, Draft again  | apps/mvp/docs/features/flows.md: main carried then changed it: 8800f22acb (🔒 feat(mvp): gu |
| 2026-10-21 20:58 | `877e38d8b9` | ON-MAIN | 34/0/0/0 | 877e38d8b9 | 🐛 fix(jj): refuse implicit stale workspace recovery |  |
| 2026-10-21 20:58 | `907b74aaa3` | ON-MAIN | 6/0/0/0 | 907b74aaa3 | 🐛 fix(jev): reject blank inputs and reserve unsure for uncertainty |  |
| 2026-10-21 20:58 | `3b36f1b2c6` | SUPERSEDED | 28/1/0/0 | 3b36f1b2c6 | fix jj stale workspace safety | apps/mvp/docs/work/nodejj-stale.md: landed as b7970a5f8f (same author and time, committed |
| 2026-10-21 20:58 | `206af62995` | SUPERSEDED | 25/1/0/0 | 206af62995 | fix jj stale workspace safety | apps/mvp/docs/work/nodejj-stale.md: landed as b7970a5f8f (same author and time, committed |
| 2026-10-21 20:58 | `cc384cd697` | SUPERSEDED | 5/1/0/0 | cc384cd697 |  | apps/mvp/docs/work/fix-jev-payload-302989.md: landed as a4cf874231 (same author and time, |
| 2026-10-21 21:00 | `37da8c5be3` | SUPERSEDED | 8/6/0/0 | 1ea57261a4 | 🐛 fix(mvp): obsolete branch loads cannot restore workspace state | apps/mvp/docs/features/navigation.md: landed as 8a2865691e (same author and time, committe |
| 2026-10-21 21:00 | `eaf9530ca7` | SUPERSEDED | 8/6/0/0 | 5d3efd101f | 🐛 fix(mvp): obsolete branch loads cannot restore workspace state | apps/mvp/docs/features/navigation.md: landed as 8a2865691e (same author and time, committe |
| 2026-10-21 21:00 | `c9747ad2a5` | SUPERSEDED | 8/6/0/0 | f1257d53d3 | 🐛 fix(mvp): obsolete branch loads cannot restore workspace state | apps/mvp/docs/features/navigation.md: landed as 8a2865691e (same author and time, committe |
| 2026-10-21 21:00 | `d9c464ccc2` | SUPERSEDED | 8/6/0/0 | 3d6dac6fb7 | 🐛 fix(mvp): obsolete branch loads cannot restore workspace state | apps/mvp/docs/features/navigation.md: landed as 8a2865691e (same author and time, committe |
| 2026-10-21 21:00 | `9d7b44d389` | SUPERSEDED | 9/5/0/0 | 9d7b44d389 | 🐛 fix(mvp): obsolete branch loads cannot restore workspace state | apps/mvp/src/features/branch/branch.test.ts: main carried then changed it: e1a134f198 (🐛 f |
| 2026-10-21 21:00 | `cc7ca70283` | SUPERSEDED | 9/5/0/0 | cc7ca70283 |  | apps/mvp/src/features/branch/branch.test.ts: main carried then changed it: e1a134f198 (🐛 f |
| 2026-10-21 21:00 | `ce6d2ab3ae` | SUPERSEDED | 9/5/0/0 | ce6d2ab3ae |  | apps/mvp/src/features/branch/branch.test.ts: main carried then changed it: e1a134f198 (🐛 f |
| 2026-10-21 21:00 | `71c9f6ae2f` | PARTIAL | 2/0/2/1 | 71c9f6ae2f | 🐛 fix(home): keep repository selection when branch actions finish | apps/mvp/docs/features/home.md: A branch action finishing after another repository opens k |
| 2026-10-21 21:00 | `c4a38e7a0c` | PARTIAL | 2/0/2/1 | c4a38e7a0c |  | apps/mvp/docs/features/home.md: A branch action finishing after another repository opens k |
| 2026-10-21 21:00 | `88d3fd4cb9` | SUPERSEDED | 9/5/0/0 | 88d3fd4cb9 |  | apps/mvp/src/features/branch/branch.test.ts: main carried then changed it: e1a134f198 (🐛 f |
| 2026-10-21 21:01 | `7db2d33fbd` | SUPERSEDED | 4/1/0/0 | 7db2d33fbd | ✅ test(mvp): a box command uses a secret against its own host without  | apps/mvp/docs/features/secrets.md: main carried then changed it: e3a4a95b63 (✨ feat(mvp): |
| 2026-10-21 21:01 | `cb54814dc6` | ON-MAIN | 7/0/0/0 | 7db2d33fbd | 🐛 fix(secrets): a forwarded request is logged and counted where the ho |  |
| 2026-10-21 21:01 | `3779b1b551` | SUPERSEDED | 4/5/0/0 | 7db2d33fbd | 🐛 fix(secrets): a box's egress setup prints nothing, so a wake never w | apps/mvp/docs/features/secrets.md: main carried then changed it: e3a4a95b63 (✨ feat(mvp): |
| 2026-10-21 21:01 | `226a0c8a90` | PARTIAL | 49/12/4/1 | 7db2d33fbd | ✨ feat(mvp): a repository's Secrets page: add, list, rotate and delete | apps/mvp/src/features/repo/components/RepoHeader.tsx: // link in Clone's place for a signe |
| 2026-10-21 21:01 | `ae6592eba1` | SUPERSEDED | 4/1/0/0 | 7db2d33fbd | 🐛 fix(secrets): a box on a mixed-case repository gets that repository' | apps/mvp/worker/BranchSandboxes.ts: main carried then changed it: ffdb99e9d7 (🐛 fix(mvp): |
| 2026-10-21 21:01 | `adec00bc79` | SUPERSEDED | 3/1/0/0 | adec00bc79 | ✅ test(mvp): a box command uses a secret against its own host without  | apps/mvp/docs/features/secrets.md: main carried then changed it: e3a4a95b63 (✨ feat(mvp): |
| 2026-10-21 21:01 | `a858c99f48` | ON-MAIN | 7/0/0/0 | adec00bc79 | 🐛 fix(secrets): a forwarded request is logged and counted where the ho |  |
| 2026-10-21 21:01 | `2b4ff61779` | SUPERSEDED | 4/3/0/0 | adec00bc79 | 🐛 fix(secrets): a box's egress setup prints nothing, so a wake never w | apps/mvp/docs/features/secrets.md: main carried then changed it: e3a4a95b63 (✨ feat(mvp): |
| 2026-10-21 21:01 | `a7525c1fb7` | PARTIAL | 34/8/5/9 | adec00bc79 | ✨ feat(mvp): a repository's Secrets page: add, list, rotate and delete | apps/mvp/src/boot.test.ts: +import { PluginsUi } from "./plugins/ui"; apps/mvp/src/boot.te |
| 2026-10-21 21:01 | `9afda8c9c8` | SUPERSEDED | 4/1/0/0 | adec00bc79 | 🐛 fix(secrets): a box on a mixed-case repository gets that repository' | apps/mvp/worker/BranchSandboxes.ts: main carried then changed it: ffdb99e9d7 (🐛 fix(mvp): |
| 2026-10-21 21:01 | `3458516e6a` | SUPERSEDED | 3/1/0/0 | 3458516e6a | ✅ test(mvp): a box command uses a secret against its own host without  | apps/mvp/docs/features/secrets.md: main carried then changed it: e3a4a95b63 (✨ feat(mvp): |
| 2026-10-21 21:01 | `e0a9519e82` | ON-MAIN | 7/0/0/0 | 3458516e6a | 🐛 fix(secrets): a forwarded request is logged and counted where the ho |  |
| 2026-10-21 21:01 | `fd6729b5dc` | SUPERSEDED | 4/3/0/0 | 3458516e6a | 🐛 fix(secrets): a box's egress setup prints nothing, so a wake never w | apps/mvp/docs/features/secrets.md: main carried then changed it: e3a4a95b63 (✨ feat(mvp): |
| 2026-10-21 21:01 | `38c1114be1` | PARTIAL | 43/8/3/2 | 3458516e6a | ✨ feat(mvp): a repository's Secrets page: add, list, rotate and delete | apps/mvp/src/features/repo/components/RepoHeader.tsx: // link in Clone's place for a signe |
| 2026-10-21 21:01 | `59271fc059` | SUPERSEDED | 4/1/0/0 | 3458516e6a | 🐛 fix(secrets): a box on a mixed-case repository gets that repository' | apps/mvp/worker/BranchSandboxes.ts: main carried then changed it: ffdb99e9d7 (🐛 fix(mvp): |
| 2026-10-21 21:01 | `13f447cbea` | SUPERSEDED | 9/3/0/0 | 2f0bd0d362 | 🐛 fix(flow): ExternalJob retries a stop until its provider records it, | packages/smithers/flows/flow/docs/guides/run-an-external-job.md: main carried then changed |
| 2026-10-21 21:01 | `62778583ba` | SCAFFOLD | 0/3/9/1 | 62778583ba | wip(subscriptions): dropped by Will's 940 ruling; the Cloudflare routi | apps/mvp/worker/ExecutionHost.ts: import { type Implement, ImplementExternal } from "./flo |
| 2026-10-21 21:04 | `4636cb71c9` | SUPERSEDED | 30/9/0/0 | 7b12317475 | 🔒 fix(sdk,mvp): a queued write is sent only as the owner who queued it | apps/mvp/docs/decisions/0023-device-ownership-and-queued-authority.md: main carried then c |
| 2026-10-21 21:04 | `fa5176b235` | EMPTY-ISH | 0/0/0/0 | fa5176b235 |  |  |
| 2026-10-21 21:06 | `fe78938036` | ON-MAIN | 6/0/0/0 | 4b4584af3b | 🐛 fix(chat): existing questions require a valid receipt |  |
| 2026-10-21 21:06 | `70b8f50242` | ON-MAIN | 6/0/0/0 | 70b8f50242 | 🐛 fix(chat): existing questions require a valid receipt |  |
| 2026-10-21 21:06 | `c9e222ddfe` | ON-MAIN | 6/0/0/0 | c9e222ddfe |  |  |
| 2026-10-21 21:06 | `79f6054a78` | ON-MAIN | 6/0/0/0 | 79f6054a78 |  |  |
| 2026-10-21 21:07 | `61f1ea1263` | SUPERSEDED | 10/1/0/0 | 61f1ea1263 | 🐛 fix(navigation): await router completion and bound tab paths | apps/mvp/src/main.tsx: main carried then changed it: 2936562175 (🐛 fix(mvp): keep refused |
| 2026-10-21 21:07 | `1ba967f11f` | SUPERSEDED | 10/1/0/0 | 1ba967f11f | 🐛 fix(navigation): await router completion and bound tab paths | apps/mvp/src/main.tsx: main carried then changed it: 2936562175 (🐛 fix(mvp): keep refused |
| 2026-10-21 21:07 | `769946b39a` | SUPERSEDED | 2/1/0/0 | 4b4584af3b | 📝 docs(repo): SUPPORT.md lists only what the new app supports | apps/mvp/docs/work/public-support-promises.md: main carried then changed it: 78edec1c09 (📝 |
| 2026-10-21 21:07 | `77ddb01b0b` | SUPERSEDED | 2/1/0/0 | 77ddb01b0b | 📝 docs(repo): SUPPORT.md lists only what the new app supports | apps/mvp/docs/work/public-support-promises.md: main carried then changed it: 78edec1c09 (📝 |
| 2026-10-21 21:07 | `322f79a90b` | SUPERSEDED | 8/3/0/0 | 322f79a90b |  | apps/mvp/docs/work/navigation-completion-and-bounds.md: landed as 0d66db742e (same author |
| 2026-10-21 21:07 | `d0433ae821` | SUPERSEDED | 2/1/0/0 | d0433ae821 | 📝 docs(repo): SUPPORT.md lists only what the new app supports | apps/mvp/docs/work/public-support-promises.md: main carried then changed it: 78edec1c09 (📝 |
| 2026-10-21 21:08 | `8bd9c74228` | SUPERSEDED | 5/3/0/0 | 8bd9c74228 | 🐛 fix(agent): retain recalled memory during catalog outages | apps/mvp/src/features/agent/memory.test.ts: main carried then changed it: 25635c3b06 (test |
| 2026-10-21 21:08 | `5a907b6f1c` | SUPERSEDED | 5/3/0/0 | 5a907b6f1c |  | apps/mvp/src/features/agent/memory.test.ts: main carried then changed it: 25635c3b06 (test |
| 2026-10-21 21:10 | `472b6b0bae` | PARTIAL | 3/10/0/2 | 2f0bd0d362 | ✨ feat(mvp): the coding model role: the todo run's agent asks it, an A | apps/mvp/db/migrations/0039_coding_model_role.ts: // The `coding` model role, the `todo` r |
| 2026-10-21 21:10 | `ca2998bddf` | PARTIAL | 3/10/0/2 | ca2998bddf | ✨ feat(mvp): the coding model role: the todo run's agent asks it, an A | apps/mvp/db/migrations/0039_coding_model_role.ts: // The `coding` model role, the `todo` r |
| 2026-10-21 21:12 | `027189a326` | SUPERSEDED | 3/1/0/0 | 5d3efd101f | 🐛 fix(mvp): assert the rendered pull request layer at boot | apps/mvp/docs/work/boot-rendered-layers.md: main carried then changed it: ba61b66c29 (🐛 fi |
| 2026-10-21 21:12 | `a30f0710e9` | SUPERSEDED | 3/1/0/0 | 3d6dac6fb7 | 🐛 fix(mvp): assert the rendered pull request layer at boot | apps/mvp/docs/work/boot-rendered-layers.md: main carried then changed it: ba61b66c29 (🐛 fi |
| 2026-10-21 21:12 | `5de98d4834` | SUPERSEDED | 3/1/0/0 | 5e1367ab36 | 🐛 fix(mvp): assert the rendered pull request layer at boot | apps/mvp/docs/work/boot-rendered-layers.md: main carried then changed it: ba61b66c29 (🐛 fi |
| 2026-10-21 21:13 | `70fcbdbcfc` | SUPERSEDED | 20/6/0/0 | 1ea57261a4 | 🐛 fix(mvp): network keys and turn and steer admission stay consistent | apps/mvp/docs/decisions/0015-agent-status.md: main carried then changed it: 1cd019c79c (📝 |
| 2026-10-21 21:13 | `d6a9f8cced` | PARTIAL | 20/6/1/0 | 5d3efd101f | 🐛 fix(mvp): network keys and turn and steer admission stay consistent | apps/mvp/docs/features/agent.md: Turn admission, heartbeat and content writes serialize on |
| 2026-10-21 21:13 | `3fa14f93ae` | SUPERSEDED | 20/6/0/0 | 3d6dac6fb7 | 🐛 fix(mvp): network keys and turn and steer admission stay consistent | apps/mvp/docs/decisions/0015-agent-status.md: main carried then changed it: 1cd019c79c (📝 |
| 2026-10-21 21:13 | `87de9df5af` | PARTIAL | 20/6/1/0 | f1257d53d3 | 🐛 fix(mvp): network keys and turn and steer admission stay consistent | apps/mvp/docs/features/agent.md: Turn admission, heartbeat and content writes serialize on |
| 2026-10-21 21:13 | `0b4d058e28` | SUPERSEDED | 1/1/0/0 | 4b4584af3b | 📝 fix(site): include views in the support matrix | apps/site/docs/reference/support-matrix.md: main carried then changed it: 89b4eef1d7 (🎨 st |
| 2026-10-21 21:13 | `c77b0a5f1b` | PARTIAL | 20/6/1/0 | c77b0a5f1b | 🐛 fix(mvp): network keys and turn and steer admission stay consistent | apps/mvp/docs/features/agent.md: Turn admission, heartbeat and content writes serialize on |
| 2026-10-21 21:13 | `21c0144bb6` | PARTIAL | 20/6/1/0 | 21c0144bb6 |  | apps/mvp/docs/features/agent.md: Turn admission, heartbeat and content writes serialize on |
| 2026-10-21 21:13 | `5b98c350d1` | SUPERSEDED | 1/1/0/0 | 5b98c350d1 | 📝 fix(site): include views in the support matrix | apps/site/docs/reference/support-matrix.md: main carried then changed it: 89b4eef1d7 (🎨 st |
| 2026-10-21 21:13 | `41d3a29143` | PARTIAL | 96/4/4/8 | 41d3a29143 | 🎨 style: format files reported by repository dprint checks | apps/mvp/docs/work/dprint-fix.md: Formatted `RunUsageMetrics.test.ts` and 47 other files r |
| 2026-10-21 21:13 | `1de8c0a2fa` | PARTIAL | 19/6/1/0 | 1de8c0a2fa |  | apps/mvp/docs/features/agent.md: Turn admission, heartbeat and content writes serialize on |
| 2026-10-21 21:13 | `dd9fb460f8` | PARTIAL | 19/4/2/1 | dd9fb460f8 |  | apps/mvp/docs/features/agent.md: Turn admission, heartbeat and content writes serialize on |
| 2026-10-21 21:14 | `5d33f74f80` | ON-MAIN | 2/0/0/0 | ff1eb39a91 | 📝 docs(mvp): decision 0039, custom domains on Cloudflare for SaaS behi |  |
| 2026-10-21 21:14 | `57f59de10e` | PARTIAL | 0/1/0/1 | c6db4254b1 | 📝 docs(mvp): decision 0028, custom domains on Cloudflare for SaaS behi | apps/mvp/docs/decisions/0028-custom-domains.md: \| Option \| Why not \|; apps/mvp/docs/dec |
| 2026-10-21 21:14 | `1cd360747c` | PARTIAL | 56/5/6/3 | 1cd360747c | ⚡ perf(flows): a drive writes its node records in its other transactio | apps/mvp/docs/work/journal-latency.md: statement, branch, function and line coverage. Engi |
| 2026-10-21 21:14 | `fcbc2db3f3` | PARTIAL | 56/5/6/3 | fcbc2db3f3 | ⚡ perf(flows): a drive writes its node records in its other transactio | apps/mvp/docs/work/journal-latency.md: statement, branch, function and line coverage. Engi |
| 2026-10-21 21:14 | `c0046c5d2d` | SUPERSEDED | 24/2/0/0 | c0046c5d2d | ⚡ perf(flows): a drive writes its node records in its other transactio | packages/smithers/flows/engine-store/src/EngineStore.ts: main carried then changed it: eb5 |
| 2026-10-21 21:14 | `a5831dcfee` | SUPERSEDED | 24/2/0/0 | a5831dcfee |  | packages/smithers/flows/engine-store/src/EngineStore.ts: main carried then changed it: eb5 |
| 2026-10-21 21:14 | `9b82a3f72f` | SUPERSEDED | 24/2/0/0 | 4e6686686f | ⚡ perf(flows): a drive writes its node records in its other transactio | packages/smithers/flows/engine-store/src/EngineStore.ts: main carried then changed it: eb5 |
| 2026-10-21 21:14 | `529ac4fbed` | PARTIAL | 0/1/0/1 | 8e74b2cf91 | 📝 docs(mvp): decision 0028, custom domains on Cloudflare for SaaS behi | apps/mvp/docs/decisions/0028-custom-domains.md: \| Option \| Why not \|; apps/mvp/docs/dec |
| 2026-10-21 21:14 | `dad58f3afe` | SUPERSEDED | 4/3/0/0 | 4b4584af3b | 🐛 fix(flow): register missing effect-key fault | apps/site/public/llms-full.txt: main carried then changed it: 71ed412d47 (📝 docs: regenera |
| 2026-10-21 21:14 | `3f0367fc91` | ON-MAIN | 7/0/0/0 | 3f0367fc91 | 🐛 fix(ci): align inventory with browser suites and fresh host checks |  |
| 2026-10-21 21:14 | `dd60c8c5bf` | SUPERSEDED | 4/3/0/0 | dd60c8c5bf | 🐛 fix(flow): register missing effect-key fault | apps/site/public/llms-full.txt: main carried then changed it: 71ed412d47 (📝 docs: regenera |
| 2026-10-21 21:14 | `8a89c2b412` | SUPERSEDED | 4/3/0/0 | 8a89c2b412 | 🐛 fix(flow): register missing effect-key fault | apps/site/public/llms-full.txt: main carried then changed it: 71ed412d47 (📝 docs: regenera |
| 2026-10-21 21:14 | `b4dddf3ab4` | ON-MAIN | 4/0/0/0 | b4dddf3ab4 | 🐛 fix(ci): mirror the required coding host size gate in cloud runner |  |
| 2026-10-21 21:17 | `02f477389c` | ON-MAIN | 47/0/0/0 | d139f1b0d5 | ✨ feat(plugin): plugin manifests, the loader and PluginHost |  |
| 2026-10-21 21:17 | `3785f8de11` | ON-MAIN | 47/0/0/0 | 24a7bd8f79 | ✨ feat(plugin): plugin manifests, the loader and PluginHost |  |
| 2026-10-21 21:17 | `dd2daaff24` | ON-MAIN | 47/0/0/0 | 1f91ef7a70 | ✨ feat(plugin): plugin manifests, the loader and PluginHost |  |
| 2026-10-21 21:17 | `bf5ca45a39` | SUPERSEDED | 22/2/0/0 | f0fcc1f28a | fix: preserve queued-write authority across reload and maintenance | apps/mvp/src/features/chat/chat.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix: |
| 2026-10-21 21:17 | `5bb7469976` | ON-MAIN | 47/0/0/0 | cd19a53d1a | ✨ feat(plugin): plugin manifests, the loader and PluginHost |  |
| 2026-10-21 21:17 | `e3768f0bbb` | SUPERSEDED | 22/2/0/0 | e3768f0bbb | fix: preserve queued-write authority across reload and maintenance | apps/mvp/src/features/chat/chat.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix: |
| 2026-10-21 21:17 | `d4bea2d48e` | SUPERSEDED | 19/4/0/0 | d4bea2d48e |  | apps/mvp/src/device/identity.ts: landed as 470748d346 (same author and time, committed lat |
| 2026-10-21 21:18 | `0118fcbb78` | SUPERSEDED | 82/15/0/0 | 2ad00d3322 | ✨ feat(mvp): file tabs; the agent opens a file at lines through file/o | apps/mvp/docs/features/agent-evals.md: main carried then changed it: 86dc184039 (🧪 test(mv |
| 2026-10-21 21:18 | `c5415ccdde` | SUPERSEDED | 4/2/0/0 | 2ad00d3322 | ✨ feat(ui): FileTabs, a strip of open files with keyboard access | packages/smithers/ui/docs/api.md: main carried then changed it: 56a1a9f8e4 (📝 fix(ui): doc |
| 2026-10-21 21:18 | `286c9990cd` | SUPERSEDED | 54/24/0/0 | 39302f919c | ✨ feat(mvp): file tabs; the agent opens a file at lines through file/o | apps/mvp/docs/features/agent-evals.md: landed as 0549b2ea8e (same author and time, committ |
| 2026-10-21 21:18 | `3cd03a5b5c` | SUPERSEDED | 4/2/0/0 | 39302f919c | ✨ feat(ui): FileTabs, a strip of open files with keyboard access | packages/smithers/ui/docs/api.md: main carried then changed it: 56a1a9f8e4 (📝 fix(ui): doc |
| 2026-10-21 21:18 | `bf054de174` | PARTIAL | 15/0/1/0 | 4b4584af3b | 🐛 fix(ui): preserve safe navigation, button types and input handling | packages/smithers/ui/src/presentation/bundle.generated.ts: -export const presentationBundl |
| 2026-10-21 21:18 | `335b84ee5e` | SUPERSEDED | 65/13/0/0 | 0bb36a57fb | ✨ feat(mvp): file tabs; the agent opens a file at lines through file/o | apps/mvp/docs/features/agent-evals.md: landed as 0549b2ea8e (same author and time, committ |
| 2026-10-21 21:18 | `2ad0222527` | SUPERSEDED | 4/2/0/0 | 0bb36a57fb | ✨ feat(ui): FileTabs, a strip of open files with keyboard access | packages/smithers/ui/docs/api.md: main carried then changed it: 56a1a9f8e4 (📝 fix(ui): doc |
| 2026-10-21 21:18 | `c61d044373` | ON-MAIN | 3/0/0/0 | c61d044373 | 🧪 test(engine-store): cover SQL driver liveness faults |  |
| 2026-10-21 21:18 | `203fe63ffe` | SUPERSEDED | 15/1/0/0 | 203fe63ffe | 🐛 fix(ui): preserve safe navigation, button types and input handling | packages/smithers/ui/src/presentation/bundle.generated.ts: landed as dfd0d9636e (same auth |
| 2026-10-21 21:19 | `c8073b743d` | SUPERSEDED | 34/1/0/0 | 61f1ea1263 | 🐛 fix(control): preserve run identity, retries, and ordered watches | packages/smithers/control/src/ControlLive.ts: main carried then changed it: 367a9d918a (🐛 |
| 2026-10-21 21:19 | `20ce782deb` | SUPERSEDED | 43/1/0/0 | 61f1ea1263 | 🐛 fix(registry): discovery fails closed and bounds resource use | packages/smithers/agent/registry/docs/guides/load-packs.md: main carried then changed it: |
| 2026-10-21 21:19 | `76ba7cf28a` | ON-MAIN | 26/0/0/0 | 61f1ea1263 | 🐛 fix(cli): isolate control state and report failures safely |  |
| 2026-10-21 21:19 | `cbe616668a` | SUPERSEDED | 30/3/0/0 | 61f1ea1263 | 🐛 fix(harness): keep replay safe and final-frame parks answerable | packages/smithers/agent/harness/src/CellTurn.ts: main carried then changed it: aaa88c2b0f |
| 2026-10-21 21:19 | `b9ba90a92d` | SUPERSEDED | 7/7/0/0 | 61f1ea1263 | 🐛 fix(ui): guard read-only completions and stabilize timeline groups a | packages/smithers/ui/docs/chat-timeline.md: main carried then changed it: b65aa03472 (✨ fe |
| 2026-10-21 21:19 | `e7a5102639` | ON-MAIN | 11/0/0/0 | 61f1ea1263 | 🐛 fix(model): bound proxy lines and validate public requests |  |
| 2026-10-21 21:19 | `5d3efd101f` | SUPERSEDED | 7/7/0/0 | 5d3efd101f | 🐛 fix(ui): guard read-only completions and stabilize timeline groups a | packages/smithers/ui/docs/chat-timeline.md: main carried then changed it: b65aa03472 (✨ fe |
| 2026-10-21 21:19 | `1ea57261a4` | SUPERSEDED | 43/1/0/0 | 1ea57261a4 | 🐛 fix(registry): discovery fails closed and bounds resource use | packages/smithers/agent/registry/docs/guides/load-packs.md: main carried then changed it: |
| 2026-10-21 21:19 | `bd6ef8311a` | ON-MAIN | 26/0/0/0 | 1ea57261a4 | 🐛 fix(cli): isolate control state and report failures safely |  |
| 2026-10-21 21:19 | `8ed22cef90` | SUPERSEDED | 30/3/0/0 | 1ea57261a4 | 🐛 fix(harness): keep replay safe and final-frame parks answerable | packages/smithers/agent/harness/src/CellTurn.ts: main carried then changed it: aaa88c2b0f |
| 2026-10-21 21:19 | `aac63f11fa` | SUPERSEDED | 7/7/0/0 | 1ea57261a4 | 🐛 fix(ui): guard read-only completions and stabilize timeline groups a | packages/smithers/ui/docs/chat-timeline.md: main carried then changed it: b65aa03472 (✨ fe |
| 2026-10-21 21:19 | `3d6dac6fb7` | SUPERSEDED | 43/1/0/0 | 3d6dac6fb7 | 🐛 fix(registry): discovery fails closed and bounds resource use | packages/smithers/agent/registry/docs/guides/load-packs.md: main carried then changed it: |
| 2026-10-21 21:19 | `e44bda54ac` | ON-MAIN | 26/0/0/0 | 3d6dac6fb7 | 🐛 fix(cli): isolate control state and report failures safely |  |
| 2026-10-21 21:19 | `649031ac3c` | SUPERSEDED | 30/3/0/0 | 3d6dac6fb7 | 🐛 fix(harness): keep replay safe and final-frame parks answerable | packages/smithers/agent/harness/src/CellTurn.ts: main carried then changed it: aaa88c2b0f |
| 2026-10-21 21:19 | `8901d8694e` | SUPERSEDED | 7/7/0/0 | 3d6dac6fb7 | 🐛 fix(ui): guard read-only completions and stabilize timeline groups a | packages/smithers/ui/docs/chat-timeline.md: main carried then changed it: b65aa03472 (✨ fe |
| 2026-10-21 21:19 | `f1257d53d3` | SUPERSEDED | 7/7/0/0 | f1257d53d3 | 🐛 fix(ui): guard read-only completions and stabilize timeline groups a | packages/smithers/ui/docs/chat-timeline.md: main carried then changed it: b65aa03472 (✨ fe |
| 2026-10-21 21:19 | `c597088dc0` | SUPERSEDED | 34/1/0/0 | c597088dc0 | 🐛 fix(control): preserve run identity, retries, and ordered watches | packages/smithers/control/src/ControlLive.ts: main carried then changed it: 367a9d918a (🐛 |
| 2026-10-21 21:19 | `dbfe0a6491` | ON-MAIN | 12/0/0/0 | 4b4584af3b | 🐛 fix(integrations): keep URLs private and reconcile complete resource |  |
| 2026-10-21 21:19 | `7868be5b9e` | ON-MAIN | 26/0/0/0 | 7868be5b9e | 🐛 fix(cli): isolate control state and report failures safely |  |
| 2026-10-21 21:19 | `7cb5dc288a` | SUPERSEDED | 30/3/0/0 | 7cb5dc288a | 🐛 fix(harness): keep replay safe and final-frame parks answerable | packages/smithers/agent/harness/src/CellTurn.ts: main carried then changed it: aaa88c2b0f |
| 2026-10-21 21:19 | `353f2e5d04` | SUPERSEDED | 43/1/0/0 | 353f2e5d04 | 🐛 fix(registry): discovery fails closed and bounds resource use | packages/smithers/agent/registry/docs/guides/load-packs.md: main carried then changed it: |
| 2026-10-21 21:19 | `e590a58446` | ON-MAIN | 11/0/0/0 | e590a58446 | 🐛 fix(model): bound proxy lines and validate public requests |  |
| 2026-10-21 21:19 | `ec7d7c6624` | SUPERSEDED | 7/7/0/0 | ec7d7c6624 | 🐛 fix(ui): guard read-only completions and stabilize timeline groups a | packages/smithers/ui/docs/chat-timeline.md: main carried then changed it: b65aa03472 (✨ fe |
| 2026-10-21 21:19 | `6b0c3c7a73` | ON-MAIN | 12/0/0/0 | 6b0c3c7a73 | 🐛 fix(integrations): keep URLs private and reconcile complete resource |  |
| 2026-10-21 21:20 | `2071ae9209` | SUPERSEDED | 11/1/0/0 | 4b4584af3b | 🐛 fix(flow): queue diagnostics stay private and worker validation stay | packages/smithers/flows/flow/src/DurableQueue.ts: main carried then changed it: ede7c1e0b6 |
| 2026-10-21 21:20 | `77324a93d1` | SUPERSEDED | 11/1/0/0 | 77324a93d1 | 🐛 fix(flow): queue diagnostics stay private and worker validation stay | packages/smithers/flows/flow/src/DurableQueue.ts: main carried then changed it: ede7c1e0b6 |
| 2026-10-21 21:21 | `95865c8993` | SUPERSEDED | 48/4/0/0 | 61f1ea1263 | 🐛 fix(integrations): GitHub reconciliation preserves identity and edit | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 485e18a704 |
| 2026-10-21 21:21 | `d4c6a28f27` | SUPERSEDED | 48/4/0/0 | 1ea57261a4 | 🐛 fix(integrations): GitHub reconciliation preserves identity and edit | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 485e18a704 |
| 2026-10-21 21:21 | `772748ac3c` | SUPERSEDED | 48/4/0/0 | 3d6dac6fb7 | 🐛 fix(integrations): GitHub reconciliation preserves identity and edit | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 485e18a704 |
| 2026-10-21 21:21 | `21c4f2b3d8` | SUPERSEDED | 48/4/0/0 | 21c4f2b3d8 | 🐛 fix(integrations): GitHub reconciliation preserves identity and edit | packages/smithers/agent/integrations/docs/api.md: main carried then changed it: 485e18a704 |
| 2026-10-21 21:23 | `1bc8b863c3` | SUPERSEDED | 20/3/0/0 | 00994147f0 | ✅ test(mvp): an agent eval for every flow the agent may call, and the  | apps/mvp/evals/agent.eval.ts: main carried then changed it: 4d92b6f599 (✅ test(mvp): the f |
| 2026-10-21 21:25 | `9f9e0a89ab` | SUPERSEDED | 10/4/0/0 | 4b4584af3b | 🐛 fix(views): enforce input bounds and total framing validation | packages/smithers/ui/views/docs/api.md: main carried then changed it: 89b4eef1d7 (🎨 style: |
| 2026-10-21 21:25 | `3fc7fba833` | SUPERSEDED | 10/4/0/0 | 3fc7fba833 | 🐛 fix(views): enforce input bounds and total framing validation | packages/smithers/ui/views/docs/api.md: main carried then changed it: 89b4eef1d7 (🎨 style: |
| 2026-10-21 21:26 | `8720f9e5e8` | SUPERSEDED | 1/1/0/0 | 31778ff498 | 📝 docs: VibeLang is ours; the migration ruling OTHER-1a | apps/mvp/docs/rulings.md: main carried then changed it: 1b01d1a2a2 (📝 docs(mvp): rulings i |
| 2026-10-21 21:27 | `63db2187ed` | PARTIAL | 7/2/4/1 | 31778ff498 | 🔧 chore: lockfiles, target index and API baseline at the tip | .smithers/flows/release/fixtures/public-api-baseline.json: "NodeControl.d.ts": "29a5ecdd54 |
| 2026-10-21 21:30 | `713ecdb126` | ON-MAIN | 4/0/0/0 | 5d3efd101f | 🐛 fix(mvp): remove captured chat shortcuts on the Node host |  |
| 2026-10-21 21:30 | `8acec3f1e7` | ON-MAIN | 4/0/0/0 | 3d6dac6fb7 | 🐛 fix(mvp): remove captured chat shortcuts on the Node host |  |
| 2026-10-21 21:30 | `5e1367ab36` | ON-MAIN | 4/0/0/0 | 5e1367ab36 | 🐛 fix(mvp): remove captured chat shortcuts on the Node host |  |
| 2026-10-21 21:31 | `8cb5329980` | SUPERSEDED | 12/2/0/0 | eca4f0f7f4 | 📝 docs(patterns): the API reference and README describe the review fix | packages/smithers/flows/patterns/README.md: main carried then changed it: 37ccb84f89 (🐛 fi |
| 2026-10-21 21:31 | `1fa90fe5d9` | ON-MAIN | 6/0/0/0 | eca4f0f7f4 | 🐛 fix(patterns): Trellis.Plan rejects excess node keys the way validat |  |
| 2026-10-21 21:31 | `fde8d6c1c5` | ON-MAIN | 13/0/0/0 | eca4f0f7f4 | 📝 fix(patterns): Quarantine's since tags agree with the changelog, and |  |
| 2026-10-21 21:31 | `0a2d43defe` | PARTIAL | 13/0/1/0 | eca4f0f7f4 | 🐛 fix(patterns): MergeQueue hands members one payload in both forms an | packages/smithers/flows/patterns/src/MergeQueue.ts: readonly priority: number |
| 2026-10-21 21:31 | `e375721144` | ON-MAIN | 6/0/0/0 | eca4f0f7f4 | 🐛 fix(patterns): MapReduce's payload requires a shards array, and run  |  |
| 2026-10-21 21:31 | `15d51f2cb9` | ON-MAIN | 3/0/0/0 | eca4f0f7f4 | 🐛 fix(patterns): a panel's label names its roles and concurrency |  |
| 2026-10-21 21:31 | `8f1ed36b79` | ON-MAIN | 7/0/0/0 | eca4f0f7f4 | 🐛 fix(patterns): Pattern.decorate refuses a decorator with an incompat |  |
| 2026-10-21 21:31 | `c6870ac8eb` | ON-MAIN | 31/0/0/0 | eca4f0f7f4 | 🐛 fix(patterns): Bounded.all keeps its members' success, error and req |  |
| 2026-10-21 21:31 | `1d09fe42d7` | PARTIAL | 84/2/2/0 | 1d09fe42d7 |  | packages/smithers/flows/patterns/src/MergeQueue.ts: readonly priority: number; packages/sm |
| 2026-10-21 21:31 | `bdde176cf7` | SUPERSEDED | 12/2/0/0 | ff41e80e78 | 📝 docs(patterns): the API reference and README describe the review fix | packages/smithers/flows/patterns/README.md: main carried then changed it: 37ccb84f89 (🐛 fi |
| 2026-10-21 21:31 | `5bbc6573b9` | ON-MAIN | 6/0/0/0 | ff41e80e78 | 🐛 fix(patterns): Trellis.Plan rejects excess node keys the way validat |  |
| 2026-10-21 21:31 | `242543220d` | ON-MAIN | 13/0/0/0 | ff41e80e78 | 📝 fix(patterns): Quarantine's since tags agree with the changelog, and |  |
| 2026-10-21 21:31 | `246e0a527c` | PARTIAL | 13/0/1/0 | ff41e80e78 | 🐛 fix(patterns): MergeQueue hands members one payload in both forms an | packages/smithers/flows/patterns/src/MergeQueue.ts: readonly priority: number |
| 2026-10-21 21:31 | `fd9c71f191` | ON-MAIN | 6/0/0/0 | ff41e80e78 | 🐛 fix(patterns): MapReduce's payload requires a shards array, and run  |  |
| 2026-10-21 21:31 | `ce1aef52df` | ON-MAIN | 3/0/0/0 | ff41e80e78 | 🐛 fix(patterns): a panel's label names its roles and concurrency |  |
| 2026-10-21 21:31 | `9ae422ba7f` | SUPERSEDED | 12/2/0/0 | fa8c951f97 | 📝 docs(patterns): the API reference and README describe the review fix | packages/smithers/flows/patterns/README.md: main carried then changed it: 37ccb84f89 (🐛 fi |
| 2026-10-21 21:31 | `0ca2ecc5b5` | ON-MAIN | 6/0/0/0 | fa8c951f97 | 🐛 fix(patterns): Trellis.Plan rejects excess node keys the way validat |  |
| 2026-10-21 21:31 | `572e21420d` | ON-MAIN | 13/0/0/0 | fa8c951f97 | 📝 fix(patterns): Quarantine's since tags agree with the changelog, and |  |
| 2026-10-21 21:31 | `3b2618f35c` | PARTIAL | 13/0/1/0 | fa8c951f97 | 🐛 fix(patterns): MergeQueue hands members one payload in both forms an | packages/smithers/flows/patterns/src/MergeQueue.ts: readonly priority: number |
| 2026-10-21 21:31 | `eed5f492fd` | ON-MAIN | 6/0/0/0 | fa8c951f97 | 🐛 fix(patterns): MapReduce's payload requires a shards array, and run  |  |
| 2026-10-21 21:31 | `41f5780e89` | ON-MAIN | 3/0/0/0 | fa8c951f97 | 🐛 fix(patterns): a panel's label names its roles and concurrency |  |
| 2026-10-21 21:31 | `86a5c2b79a` | ON-MAIN | 7/0/0/0 | ff41e80e78 | 🐛 fix(patterns): Pattern.decorate refuses a decorator with an incompat |  |
| 2026-10-21 21:31 | `922107c7ad` | ON-MAIN | 31/0/0/0 | ff41e80e78 | 🐛 fix(patterns): Bounded.all keeps its members' success, error and req |  |
| 2026-10-21 21:32 | `2f6fe263e5` | SUPERSEDED | 19/4/0/0 | 0b93fc6d9a | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:32 | `27e0131465` | SUPERSEDED | 19/4/0/0 | 0bbf6b3fbd | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:32 | `b9ded8f6bc` | SUPERSEDED | 19/4/0/0 | 72a73899be | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:32 | `d31fcac9cf` | SUPERSEDED | 19/4/0/0 | 104a7b5e07 | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:32 | `61b8c6c564` | SUPERSEDED | 19/4/0/0 | 331891126f | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:32 | `4a5181b823` | SUPERSEDED | 19/4/0/0 | 9ef520910f | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:32 | `9b1bcdaf90` | SUPERSEDED | 19/4/0/0 | cc19e2287a | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:32 | `b2c8934ff8` | SUPERSEDED | 19/4/0/0 | b2c8934ff8 | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:32 | `0d7e889cd3` | SUPERSEDED | 19/4/0/0 | fcd2fd1cd5 | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:32 | `3a7583d2a4` | SUPERSEDED | 19/4/0/0 | 3a7583d2a4 | 🐛 fix(mvp): a pinned Retry of your flow reruns the revision and flow t | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-21 21:35 | `c63dcc4693` | SUPERSEDED | 6/2/0/0 | c63dcc4693 | 📝 docs(site): sync the API reference for RetryPolicy.schedule, Termina | apps/site/public/llms-full.txt: main carried then changed it: 5ef5b2218d (⚡ perf(mvp): sta |
| 2026-10-21 21:39 | `f9f0071aa8` | SUPERSEDED | 14/1/0/0 | 1ea57261a4 | 🐛 fix(agent): bound quota parks and preserve charge integrity | packages/smithers/agent/PACKAGE.ts: main carried then changed it: 42321b070d (🐛 fix(agent) |
| 2026-10-21 21:39 | `005ed00b62` | SUPERSEDED | 14/1/0/0 | 5d3efd101f | 🐛 fix(agent): bound quota parks and preserve charge integrity | packages/smithers/agent/PACKAGE.ts: main carried then changed it: 42321b070d (🐛 fix(agent) |
| 2026-10-21 21:39 | `932ca12b38` | SUPERSEDED | 14/1/0/0 | f1257d53d3 | 🐛 fix(agent): bound quota parks and preserve charge integrity | packages/smithers/agent/PACKAGE.ts: main carried then changed it: 42321b070d (🐛 fix(agent) |
| 2026-10-21 21:39 | `6e1862b452` | SUPERSEDED | 14/1/0/0 | 3d6dac6fb7 | 🐛 fix(agent): bound quota parks and preserve charge integrity | packages/smithers/agent/PACKAGE.ts: main carried then changed it: 42321b070d (🐛 fix(agent) |
| 2026-10-21 21:39 | `e4fd2edc7e` | SUPERSEDED | 28/2/0/0 | e4fd2edc7e | 🐛 fix(cli): secure exports and validate landing and API requests | packages/smithers/PACKAGE.ts: main carried then changed it: e941c9d9e8 (🐛 fix(backend): pr |
| 2026-10-21 21:39 | `5c5b0bfa9f` | SUPERSEDED | 14/1/0/0 | 5c5b0bfa9f | 🐛 fix(agent): bound quota parks and preserve charge integrity | packages/smithers/agent/PACKAGE.ts: main carried then changed it: 42321b070d (🐛 fix(agent) |
| 2026-10-21 21:39 | `2c53e7d3fb` | PARTIAL | 5/1/3/2 | 2c53e7d3fb | 🐛 fix(issues): validate queued writes and retain failed persistence | apps/mvp/docs/features/issues.md: - **Queued writes survive refusal.** The outbox settles |
| 2026-10-21 21:39 | `a2f7e9ecfd` | PARTIAL | 5/1/3/2 | a2f7e9ecfd |  | apps/mvp/docs/features/issues.md: - **Queued writes survive refusal.** The outbox settles |
| 2026-10-21 21:40 | `24e00fbc3d` | SUPERSEDED | 66/4/0/0 | d139f1b0d5 | ✨ feat(mvp): core/waits, approvals with a note, and the key door | apps/mvp/docs/features/flows.md: main carried then changed it: 2cb405b306 (🐛 fix(mvp): rec |
| 2026-10-21 21:40 | `a3bd0407ce` | SUPERSEDED | 62/3/0/0 | 24a7bd8f79 | ✨ feat(mvp): core/waits, approvals with a note, and the key door | apps/mvp/docs/features/flows.md: main carried then changed it: 2cb405b306 (🐛 fix(mvp): rec |
| 2026-10-21 21:40 | `b29e9f763d` | SUPERSEDED | 62/3/0/0 | 1f91ef7a70 | ✨ feat(mvp): core/waits, approvals with a note, and the key door | apps/mvp/docs/features/flows.md: main carried then changed it: 2cb405b306 (🐛 fix(mvp): rec |
| 2026-10-21 21:40 | `51ef385a7d` | SUPERSEDED | 44/13/0/0 | cd19a53d1a | ✨ feat(mvp): core/waits, approvals with a note, and the key door | apps/mvp/docs/features/agent-status.md: landed as 11836d148c (same author and time, commit |
| 2026-10-21 21:40 | `c04dfde0f1` | SUPERSEDED | 17/6/0/0 | c04dfde0f1 | 🐛 fix(cli): preserve product API inputs and results | packages/smithers/docs/product-api-contracts.md: main carried then changed it: e941c9d9e8 |
| 2026-10-21 21:40 | `2f18041e12` | PARTIAL | 14/3/9/1 | 2f18041e12 | 🐛 fix(flow): preserve payload sources and safe durable replay | apps/mvp/docs/work/flow-source-regressions-751129.md: - `pnpm exec vitest run test/GraphRe |
| 2026-10-21 21:42 | `fcb24de7a3` | SUPERSEDED | 7/6/0/0 | 72a73899be | ✨ feat(mvp): redirect other hostnames to the app's domain | apps/mvp/alchemy.run.ts: main carried then changed it: 4efa2e03c0 (✨ feat(mvp): APP_ALIASE |
| 2026-10-21 21:42 | `e5bddda1de` | SUPERSEDED | 7/6/0/0 | 9ef520910f | ✨ feat(mvp): redirect other hostnames to the app's domain | apps/mvp/alchemy.run.ts: main carried then changed it: 4efa2e03c0 (✨ feat(mvp): APP_ALIASE |
| 2026-10-21 21:42 | `43be91f65e` | SUPERSEDED | 7/6/0/0 | 43be91f65e | ✨ feat(mvp): redirect other hostnames to the app's domain | apps/mvp/alchemy.run.ts: main carried then changed it: 4efa2e03c0 (✨ feat(mvp): APP_ALIASE |
| 2026-10-21 21:44 | `fa8b8f89a7` | SUPERSEDED | 12/2/0/0 | fa8b8f89a7 | 🐛 fix(mvp): bind opaque runs exactly and use configured alert links | apps/mvp/worker/AlertChannels.test.ts: main carried then changed it: acbdc22dfb (🐛 fix(mvp |
| 2026-10-21 21:44 | `db31ef9f63` | SUPERSEDED | 11/3/0/0 | 1ea57261a4 | 🐛 fix(mvp): bind opaque runs exactly and use configured alert links | apps/mvp/worker/AlertChannels.test.ts: landed as df0456e999 (same author and time, committ |
| 2026-10-21 21:44 | `817d742f30` | SUPERSEDED | 11/3/0/0 | 5d3efd101f | 🐛 fix(mvp): bind opaque runs exactly and use configured alert links | apps/mvp/worker/AlertChannels.test.ts: landed as df0456e999 (same author and time, committ |
| 2026-10-21 21:44 | `40ef2fecbf` | SUPERSEDED | 11/3/0/0 | 3d6dac6fb7 | 🐛 fix(mvp): bind opaque runs exactly and use configured alert links | apps/mvp/worker/AlertChannels.test.ts: landed as df0456e999 (same author and time, committ |
| 2026-10-21 21:44 | `c9fb7f2fcc` | SUPERSEDED | 11/3/0/0 | f1257d53d3 | 🐛 fix(mvp): bind opaque runs exactly and use configured alert links | apps/mvp/worker/AlertChannels.test.ts: landed as df0456e999 (same author and time, committ |
| 2026-10-21 21:45 | `7aa011984a` | SUPERSEDED | 19/2/0/0 | 7aa011984a | 🐛 fix(agent): preserve budget controls and sanitize child failures | packages/smithers/agent/src/Budget.ts: landed as 6e1b58cd15 (same author and time, committ |
| 2026-10-21 21:46 | `ddeca86fea` | SUPERSEDED | 51/4/0/0 | ddeca86fea | 🐛 fix(agent): enforce child lifecycle, cache authority and publication | packages/smithers/agent/src/EngineChildren.ts: landed as 500acbbf07 (same author and time, |
| 2026-10-21 21:46 | `8a067eb479` | PARTIAL | 26/0/7/1 | 8a067eb479 | 🐛 fix(backend): preserve mutation bodies and cache upload bytes | apps/mvp/docs/work/mini-product-api-request-bodies.md: - `pnpm --filter @smthrs/cli exec v |
| 2026-10-21 21:48 | `07c9441bae` | PARTIAL | 10/0/10/4 | 07c9441bae | 🐛 fix(notifications): validate delivery evidence and notice access | apps/mvp/docs/work/notifications-response-access-fixes.md: Library catalog entries used: s |
| 2026-10-21 21:49 | `c87a5e86b4` | ON-MAIN | 31/0/0/0 | c87a5e86b4 | 🐛 fix(rpc): validate inputs and preserve recorded cards |  |
| 2026-10-21 21:51 | `a61634dcaf` | ON-MAIN | 41/0/0/0 | a61634dcaf | 🐛 fix(artifacts): lease loss stops protected work |  |
| 2026-10-21 21:52 | `e050385971` | SUPERSEDED | 40/15/0/0 | 08cb0cd99d | ✨ feat(mvp): a repository's own home before a clone, and View as to sw | apps/mvp/docs/features/home.md: main carried then changed it: e80ced7fea (✨ feat(mvp): a r |
| 2026-10-21 21:52 | `a647f0a9ba` | ON-MAIN | 27/0/0/0 | 08cb0cd99d | ✨ feat(views): Docs reads a docs site's llms.txt index, and a home nam |  |
| 2026-10-21 21:52 | `8313f3eb1b` | SUPERSEDED | 40/15/0/0 | b238afaac2 | ✨ feat(mvp): a repository's own home before a clone, and View as to sw | apps/mvp/docs/features/home.md: main carried then changed it: e80ced7fea (✨ feat(mvp): a r |
| 2026-10-21 21:52 | `fa8d163632` | ON-MAIN | 27/0/0/0 | b238afaac2 | ✨ feat(views): Docs reads a docs site's llms.txt index, and a home nam |  |
| 2026-10-21 21:52 | `fcad0ea10e` | SUPERSEDED | 40/15/0/0 | 6b2971b10f | ✨ feat(mvp): a repository's own home before a clone, and View as to sw | apps/mvp/docs/features/home.md: main carried then changed it: e80ced7fea (✨ feat(mvp): a r |
| 2026-10-21 21:52 | `9f526e02e3` | ON-MAIN | 33/0/0/0 | 6b2971b10f | ✨ feat(views): Docs reads a docs site's llms.txt index, and a home nam |  |
| 2026-10-21 21:52 | `664184311f` | SUPERSEDED | 25/1/0/0 | 664184311f | 🐛 fix(agent): confine calibrated memory and report flow discovery fail | packages/smithers/agent/src/MemoryCalibration.ts: landed as 42321b070d (same author and ti |
| 2026-10-21 21:52 | `27d31edbd0` | ON-MAIN | 45/0/0/0 | 27d31edbd0 | 🐛 fix(model-host): enforce diagnostic and tool boundaries |  |
| 2026-10-21 21:53 | `44c1e6b9b2` | ON-MAIN | 33/0/0/0 | 44c1e6b9b2 | 🐛 fix(platform-node): keep host failures typed and sandbox grants expl |  |
| 2026-10-21 21:54 | `be74787aa6` | PARTIAL | 12/0/3/2 | be74787aa6 | 🐛 fix(flow): preserve attempt identity and serialize private once writ | apps/mvp/docs/work/action-identity-once-regressions.md: Reproduce and repair allocation-sc |
| 2026-10-21 21:55 | `c5461a44fa` | ON-MAIN | 24/0/0/0 | c5461a44fa | 🐛 fix(ui): preserve pending prompt attachments and keyboard actions |  |
| 2026-10-21 21:56 | `2ad00d3322` | SUPERSEDED | 19/4/0/0 | 2ad00d3322 | ✨ feat(mvp): a file's page opens in its branch's workspace, the conver | apps/mvp/e2e/files.spec.ts: main carried then changed it: d2823b531d (🧪 fix(mvp): scope e2 |
| 2026-10-21 21:56 | `39302f919c` | SUPERSEDED | 15/6/0/0 | 39302f919c | ✨ feat(mvp): a file's page opens in its branch's workspace, the conver | apps/mvp/docs/features/branch-workspace.md: landed as 17acebf650 (same author and time, co |
| 2026-10-21 21:56 | `0bb36a57fb` | SUPERSEDED | 16/5/0/0 | 0bb36a57fb | ✨ feat(mvp): a file's page opens in its branch's workspace, the conver | apps/mvp/e2e/files.spec.ts: main carried then changed it: d2823b531d (🧪 fix(mvp): scope e2 |
| 2026-10-21 22:04 | `88e17533b3` | PARTIAL | 26/0/3/1 | 88e17533b3 | 🐛 fix(control): preserve watch tails and rejected outcomes | apps/mvp/docs/work/control-quiet-watch-and-rejection-replay.md: @smthrs/journal entries, e |
| 2026-10-21 22:12 | `589e6b37f7` | SUPERSEDED | 117/44/0/0 | 08cb0cd99d | ✨ feat(mvp): a repository's docs in the app: the Docs tab, app/docs/se | apps/mvp/AGENTS.md: main carried then changed it: 0b1f866da1 (✨ feat(mvp): the agent asks |
| 2026-10-21 22:12 | `ff0c4e220b` | SUPERSEDED | 18/1/0/0 | 08cb0cd99d | ✨ feat(ui): DocsPageView draws a docs page's Markdown with its site, a | packages/smithers/ui/src/presentation/bundle.generated.ts: main carried then changed it: 3 |
| 2026-10-21 22:12 | `3642624f3d` | SUPERSEDED | 107/54/0/0 | b238afaac2 | ✨ feat(mvp): a repository's docs in the app: the Docs tab, app/docs/se | apps/mvp/AGENTS.md: main carried then changed it: 0b1f866da1 (✨ feat(mvp): the agent asks |
| 2026-10-21 22:12 | `28b8971137` | SUPERSEDED | 18/1/0/0 | b238afaac2 | ✨ feat(ui): DocsPageView draws a docs page's Markdown with its site, a | packages/smithers/ui/src/presentation/bundle.generated.ts: main carried then changed it: 3 |
| 2026-10-21 22:12 | `312dac3332` | SUPERSEDED | 111/47/0/0 | 6b2971b10f | ✨ feat(mvp): a repository's docs in the app: the Docs tab, app/docs/se | apps/mvp/AGENTS.md: main carried then changed it: 0b1f866da1 (✨ feat(mvp): the agent asks |
| 2026-10-21 22:12 | `c1ee3e0ddd` | SUPERSEDED | 18/1/0/0 | 6b2971b10f | ✨ feat(ui): DocsPageView draws a docs page's Markdown with its site, a | packages/smithers/ui/src/presentation/bundle.generated.ts: main carried then changed it: 3 |
| 2026-10-21 22:14 | `91646f2334` | SUPERSEDED | 20/2/0/0 | 397ac16d47 | 🧪 test(mvp): agent evals for asking with a form and showing a board | apps/mvp/evals/checks.ts: main carried then changed it: f46ea917ee (✨ feat(mvp): a reposit |
| 2026-10-21 22:14 | `e16986baaf` | SUPERSEDED | 8/1/0/0 | 397ac16d47 | ✅ test(mvp): e2e for asking with a form and playing a generated tic-ta | apps/mvp/src/test/scriptedAgent.ts: main carried then changed it: f46ea917ee (✨ feat(mvp): |
| 2026-10-21 22:14 | `4d6e32800b` | PARTIAL | 133/20/1/0 | 397ac16d47 | ✨ feat(mvp): the agent asks with forms and shows views, inline and ful | apps/mvp/src/device/registry.ts: import { AskingV1, AuthConfirmedV1, ChatDraftV1, IssueSen |
| 2026-10-21 22:14 | `196438ee7f` | ON-MAIN | 2/0/0/0 | 397ac16d47 | 🐛 fix(ui): the clipboard fallback typechecks in a Worker |  |
| 2026-10-21 22:14 | `91d70e9d68` | SUPERSEDED | 19/3/0/0 | 91d70e9d68 | 🧪 test(mvp): agent evals for asking with a form and showing a board | apps/mvp/docs/features/agent-evals.md: landed as 86dc184039 (same author and time, committ |
| 2026-10-21 22:14 | `e4d08d2e60` | PARTIAL | 6/1/1/0 | 91d70e9d68 | ✅ test(mvp): e2e for asking with a form and playing a generated tic-ta | apps/mvp/src/flows/engine.worker.ts: else void Promise.all([import("../test/scriptedAgent" |
| 2026-10-21 22:14 | `7b77eb3e77` | PARTIAL | 124/13/7/7 | 91d70e9d68 | ✨ feat(mvp): the agent asks with forms and shows views, inline and ful | apps/mvp/AGENTS.md: - `ChatApi.ts` is Effect-native: it stores questions in Postgres, prox |
| 2026-10-21 22:14 | `285502b608` | ON-MAIN | 2/0/0/0 | 91d70e9d68 | 🐛 fix(ui): the clipboard fallback typechecks in a Worker |  |
| 2026-10-21 22:14 | `5d05890579` | SUPERSEDED | 13/3/0/0 | 5d05890579 | 🧪 test(mvp): agent evals for asking with a form and showing a board | apps/mvp/docs/features/agent-evals.md: landed as 86dc184039 (same author and time, committ |
| 2026-10-21 22:14 | `d02fe9e1c6` | PARTIAL | 5/0/2/1 | 5d05890579 | ✅ test(mvp): e2e for asking with a form and playing a generated tic-ta | apps/mvp/src/flows/engine.worker.ts: else void Promise.all([import("../test/scriptedAgent" |
| 2026-10-21 22:14 | `79025dcb10` | PARTIAL | 116/12/9/7 | 5d05890579 | ✨ feat(mvp): the agent asks with forms and shows views, inline and ful | apps/mvp/AGENTS.md: - `ChatApi.ts` is Effect-native: it stores questions in Postgres, prox |
| 2026-10-21 22:14 | `b69812928b` | ON-MAIN | 2/0/0/0 | 5d05890579 | 🐛 fix(ui): the clipboard fallback typechecks in a Worker |  |
| 2026-10-21 22:14 | `e2d711da18` | SUPERSEDED | 14/2/0/0 | e2d711da18 | 🧪 test(mvp): agent evals for asking with a form and showing a board | apps/mvp/docs/features/agent-evals.md: landed as 86dc184039 (same author and time, committ |
| 2026-10-21 22:14 | `9374b2595b` | PARTIAL | 5/0/1/1 | e2d711da18 | ✅ test(mvp): e2e for asking with a form and playing a generated tic-ta | apps/mvp/src/flows/engine.worker.ts: else void Promise.all([import("../test/scriptedAgent" |
| 2026-10-21 22:14 | `bffb8c8086` | PARTIAL | 120/13/6/6 | e2d711da18 | ✨ feat(mvp): the agent asks with forms and shows views, inline and ful | apps/mvp/AGENTS.md: - `ChatApi.ts` is Effect-native: it stores questions in Postgres, prox |
| 2026-10-21 22:14 | `39a983cb62` | ON-MAIN | 2/0/0/0 | e2d711da18 | 🐛 fix(ui): the clipboard fallback typechecks in a Worker |  |
| 2026-10-21 22:21 | `ff1eb39a91` | PARTIAL | 87/20/0/1 | ff1eb39a91 | ✨ feat(mvp): custom domains, Vercel-style, for Maintainers only | apps/mvp/db/migrations/0044_domains.ts: checked_at timestamptz,; apps/mvp/db/Database.ts: |
| 2026-10-21 22:21 | `c6db4254b1` | PARTIAL | 68/33/1/1 | c6db4254b1 | ✨ feat(mvp): custom domains, Vercel-style, for Maintainers only | apps/mvp/db/migrations/0041_domains.ts: // Custom domains (decision 0028, docs/features/do |
| 2026-10-21 22:21 | `8e74b2cf91` | PARTIAL | 80/22/0/1 | 8e74b2cf91 | ✨ feat(mvp): custom domains, Vercel-style, for Maintainers only | apps/mvp/db/migrations/0041_domains.ts: // Custom domains (decision 0028, docs/features/do |
| 2026-10-21 22:22 | `31778ff498` | PARTIAL | 0/0/0/1 | 31778ff498 | 📝 docs(mvp): the VibeLang package migration starts from 63db2187 | apps/mvp/docs/work/vibelang-package-migration.md: - The work happens on an integration lin |
| 2026-10-21 22:22 | `ad5cff7222` | PARTIAL | 0/0/0/1 | ad5cff7222 | 📝 docs(mvp): the VibeLang package migration starts from 63db2187 | apps/mvp/docs/work/vibelang-package-migration.md: owner: VibeLang migration lead (Claude s |
| 2026-10-21 22:27 | `00994147f0` | SUPERSEDED | 30/9/0/0 | 00994147f0 | ✅ test(mvp): the flows suite's first full run, and evals that say why  | apps/mvp/docs/features/agent-evals.md: main carried then changed it: 0549b2ea8e (✨ feat(mv |
| 2026-10-21 22:27 | `b39a7cec6a` | SUPERSEDED | 5/1/0/0 | 00994147f0 | 🐛 fix(model-host): a provider transport sends every request through it | packages/smithers/agent/model-host/src/ProviderTransport.ts: main carried then changed it: |
| 2026-10-21 22:27 | `0950b07141` | ON-MAIN | 3/0/0/0 | 00994147f0 | 🐛 fix(mvp): the test device says which door its press came through, so |  |
| 2026-10-21 22:35 | `4ad6fc575c` | ON-MAIN | 4/0/0/0 | 0b93fc6d9a | 📝 docs: regenerated site reference for the harness HarnessError's Mode |  |
| 2026-10-21 22:35 | `3b0973efbc` | ON-MAIN | 4/0/0/0 | 0bbf6b3fbd | 📝 docs: regenerated site reference for the harness HarnessError's Mode |  |
| 2026-10-21 22:35 | `7813124e24` | ON-MAIN | 4/0/0/0 | 72a73899be | 📝 docs: regenerated site reference for the harness HarnessError's Mode |  |
| 2026-10-21 22:35 | `75c29d914f` | ON-MAIN | 4/0/0/0 | 104a7b5e07 | 📝 docs: regenerated site reference for the harness HarnessError's Mode |  |
| 2026-10-21 22:35 | `701fc99a93` | ON-MAIN | 4/0/0/0 | 331891126f | 📝 docs: regenerated site reference for the harness HarnessError's Mode |  |
| 2026-10-21 22:35 | `dab02ba59f` | ON-MAIN | 4/0/0/0 | 9ef520910f | 📝 docs: regenerated site reference for the harness HarnessError's Mode |  |
| 2026-10-21 22:35 | `71007652ba` | ON-MAIN | 4/0/0/0 | cc19e2287a | 📝 docs: regenerated site reference for the harness HarnessError's Mode |  |
| 2026-10-21 22:35 | `fcd2fd1cd5` | ON-MAIN | 4/0/0/0 | fcd2fd1cd5 | 📝 docs: regenerated site reference for the harness HarnessError's Mode |  |
| 2026-10-21 22:37 | `b98e2fc309` | SUPERSEDED | 98/11/0/0 | b98e2fc309 |  | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `a3a6cac508` | PARTIAL | 98/3/0/8 | a3a6cac508 |  | packages/smithers/flows/patterns/src/Optimizer.ts: readonly onMaxReached?: OnMaxReached \ |
| 2026-10-21 22:37 | `8dc885320f` | SUPERSEDED | 100/11/0/0 | eca4f0f7f4 | 🔥 refactor(patterns)!: delete Loop, ScanFixVerify.run and Optimizer.ru | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `1c53f993e8` | SUPERSEDED | 98/11/0/0 | 1c53f993e8 |  | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `a9dea10f10` | SUPERSEDED | 98/11/0/0 | a9dea10f10 |  | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `d795dd0a40` | SUPERSEDED | 98/11/0/0 | d795dd0a40 |  | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `bd82b0173e` | SUPERSEDED | 98/11/0/0 | bd82b0173e |  | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `8567435755` | SUPERSEDED | 100/11/0/0 | ff41e80e78 | 🔥 refactor(patterns)!: delete Loop, ScanFixVerify.run and Optimizer.ru | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `5839b64855` | PARTIAL | 98/3/0/8 | 5839b64855 |  | packages/smithers/flows/patterns/src/Optimizer.ts: readonly onMaxReached?: OnMaxReached \ |
| 2026-10-21 22:37 | `4c1840d5b0` | SUPERSEDED | 98/11/0/0 | 4c1840d5b0 |  | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `6f07a37ad1` | SUPERSEDED | 100/11/0/0 | fa8c951f97 | 🔥 refactor(patterns)!: delete Loop, ScanFixVerify.run and Optimizer.ru | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `d8e598bbe8` | SUPERSEDED | 98/11/0/0 | d8e598bbe8 |  | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:37 | `d8e1053cd6` | PARTIAL | 98/3/0/8 | d8e1053cd6 |  | packages/smithers/flows/patterns/src/Optimizer.ts: readonly onMaxReached?: OnMaxReached \ |
| 2026-10-21 22:37 | `41979c611c` | SUPERSEDED | 98/11/0/0 | 41979c611c |  | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 22:38 | `84449e6ef6` | ON-MAIN | 19/0/0/0 | 84449e6ef6 | 🐛 fix(rpc): keep file identities unique and validate wire inputs |  |
| 2026-10-21 22:38 | `0b28a8c167` | ON-MAIN | 9/0/0/0 | 0b28a8c167 | 🐛 fix(ui): preserve composition, dispatch once, and require conditiona |  |
| 2026-10-21 22:40 | `e5e2115b5e` | ON-MAIN | 15/0/0/0 | e5e2115b5e | 🐛 fix(ui): announce copy failures and preserve native flow destination |  |
| 2026-10-21 22:41 | `f084f6127d` | ON-MAIN | 15/0/0/0 | f084f6127d | 🐛 fix(agent): keep quota parks finite and host failures opaque |  |
| 2026-10-21 22:41 | `c7e27fff9e` | SUPERSEDED | 29/3/0/0 | c7e27fff9e | 🐛 fix(cli): honor host authority and invocation boundaries | packages/smithers/src/cli/ControlBridge.ts: landed as 538b5500d4 (same author and time, co |
| 2026-10-21 22:41 | `6076335982` | ON-MAIN | 12/0/0/0 | 6076335982 | 🐛 fix(memory): contain reads and preserve complete catalog metadata |  |
| 2026-10-21 22:41 | `2f0bd0d362` | SUPERSEDED | 0/2/0/0 | 2f0bd0d362 | 📝 docs: regenerate llms-full, the views API page and the target index | apps/site/public/llms-full.txt: main carried then changed it: 0758e195c0 (📝 docs: regenera |
| 2026-10-21 22:41 | `ec49e966b6` | ON-MAIN | 7/0/0/0 | ec49e966b6 | 🐛 fix(spend): retry channel saves after HTTP 408 and 429 |  |
| 2026-10-21 22:41 | `76e8c11138` | ON-MAIN | 20/0/0/0 | 76e8c11138 | 🐛 fix(plan): preserve historical scopes and validate safe immutable to |  |
| 2026-10-21 22:41 | `51237f4a5a` | SUPERSEDED | 0/2/0/0 | 51237f4a5a |  | apps/site/public/llms-full.txt: main carried then changed it: 0758e195c0 (📝 docs: regenera |
| 2026-10-21 22:41 | `f9d1a2ab79` | SUPERSEDED | 6/1/0/0 | f9d1a2ab79 |  | apps/mvp/docs/features/spend-alerts.md: landed as fe6d72002f (same author and time, commit |
| 2026-10-21 22:42 | `ac73fde560` | SUPERSEDED | 18/2/0/0 | 7db2d33fbd | 🐛 fix(sandbox): a terminal opens once its owner's user is made, whatev | apps/mvp/src/features/terminal/view.ts: main carried then changed it: 8800f22acb (🔒 feat(m |
| 2026-10-21 22:42 | `4813b05ebd` | PARTIAL | 14/2/1/0 | adec00bc79 | 🐛 fix(sandbox): a terminal opens once its owner's user is made, whatev | .smithers/flows/release/fixtures/public-api-baseline.json: -        "SandboxObject.d.ts": |
| 2026-10-21 22:42 | `2c33df4cba` | SUPERSEDED | 15/2/0/0 | 3458516e6a | 🐛 fix(sandbox): a terminal opens once its owner's user is made, whatev | apps/mvp/src/features/terminal/view.ts: landed as 67d646b37c (same author and time, commit |
| 2026-10-21 22:42 | `533f7969d9` | ON-MAIN | 31/0/0/0 | 533f7969d9 | 🐛 fix(harness): preserve instruction provenance and emit run aborts |  |
| 2026-10-21 22:44 | `7dfa2c8c7e` | SUPERSEDED | 21/2/0/0 | 7dfa2c8c7e | 🐛 fix(theme): restore system following and preserve tab failures | apps/mvp/evals/session.ts: main carried then changed it: 5ef3636f6e (✅ test(mvp): an agent |
| 2026-10-21 22:44 | `0b4f992e84` | ON-MAIN | 26/0/0/0 | 0b4f992e84 | 🐛 fix(cli): preserve writer ownership and retained workspace leases |  |
| 2026-10-21 22:44 | `2d713d1c72` | SUPERSEDED | 21/3/0/0 | 2d713d1c72 |  | packages/smithers/flows/flow/README.md: main carried then changed it: 1d12521b25 (🐛 fix(fl |
| 2026-10-21 22:44 | `4e8c91a71a` | SUPERSEDED | 18/3/0/0 | 4e8c91a71a |  | apps/mvp/docs/work/fix-theme-085799.md: landed as b7f27fe8f6 (same author and time, commit |
| 2026-10-21 22:45 | `7e7e4920c4` | SUPERSEDED | 24/3/0/0 | 7e7e4920c4 | 🐛 fix(flow): preserve payload sources and safe durable replay | packages/smithers/flows/flow/README.md: main carried then changed it: 1d12521b25 (🐛 fix(fl |
| 2026-10-21 22:45 | `2ed42746aa` | SUPERSEDED | 24/3/0/0 | 2ed42746aa |  | packages/smithers/flows/flow/README.md: main carried then changed it: 1d12521b25 (🐛 fix(fl |
| 2026-10-21 22:45 | `a0a59015b7` | ON-MAIN | 6/0/0/0 | a0a59015b7 | 🐛 fix(repo): unknown App status cannot make clones reclaimable |  |
| 2026-10-21 22:45 | `a27a438a21` | PARTIAL | 3/2/0/1 | a27a438a21 |  | apps/mvp/docs/work/fix-repo-clone-installation-status.md: status: in-progress; apps/mvp/do |
| 2026-10-21 22:46 | `2f88c3b72c` | ON-MAIN | 4/0/0/0 | 2f88c3b72c | 🐛 fix(home): keep repository selection when branch actions finish |  |
| 2026-10-21 22:46 | `b1c7b94f54` | ON-MAIN | 4/0/0/0 | b1c7b94f54 |  |  |
| 2026-10-21 22:47 | `edd0bcabef` | ON-MAIN | 5/0/0/0 | edd0bcabef | 🐛 fix(web): invalid app origins cannot bypass URL policy |  |
| 2026-10-21 22:48 | `b8282bf27d` | ON-MAIN | 32/0/0/0 | b8282bf27d |  |  |
| 2026-10-21 22:48 | `8c3685ba47` | ON-MAIN | 38/0/0/0 | eca4f0f7f4 | 🐛 fix(patterns): Burndown keeps working deferred items, settles once,  |  |
| 2026-10-21 22:48 | `e42b69dcfd` | ON-MAIN | 38/0/0/0 | ff41e80e78 | 🐛 fix(patterns): Burndown keeps working deferred items, settles once,  |  |
| 2026-10-21 22:48 | `d718df9d62` | ON-MAIN | 32/0/0/0 | d718df9d62 |  |  |
| 2026-10-21 22:48 | `758ad1f5c7` | ON-MAIN | 37/0/0/0 | fa8c951f97 | 🐛 fix(patterns): Burndown keeps working deferred items, settles once,  |  |
| 2026-10-21 22:48 | `95c32710d0` | ON-MAIN | 32/0/0/0 | 95c32710d0 |  |  |
| 2026-10-21 22:51 | `eca4f0f7f4` | ON-MAIN | 24/0/0/0 | eca4f0f7f4 | 📝 docs(site): regenerate llms-full.txt after the patterns cleanup |  |
| 2026-10-21 22:51 | `8adf84bd4d` | PARTIAL | 20/1/2/1 | 8adf84bd4d | 📝 docs(site): regenerate llms-full.txt after the patterns cleanup | apps/site/public/llms-full.txt: -`WithRetry.retryEffect` snapshots when it is called. `Pat |
| 2026-10-21 22:51 | `ff41e80e78` | ON-MAIN | 30/0/0/0 | ff41e80e78 | 📝 docs(site): regenerate llms-full.txt after the patterns cleanup |  |
| 2026-10-21 22:51 | `fa8c951f97` | ON-MAIN | 30/0/0/0 | fa8c951f97 | 📝 docs(site): regenerate llms-full.txt after the patterns cleanup |  |
| 2026-10-21 22:52 | `c93bc8c67d` | ON-MAIN | 9/0/0/0 | c93bc8c67d | 🐛 fix(eval): reject reused IDs before execution and roundtrip JSON ide |  |
| 2026-10-21 22:53 | `d92a9c71ce` | SUPERSEDED | 4/11/0/0 | d92a9c71ce | 🐛 fix(timeline): isolate summary dispatch and remove deleted summaries | apps/mvp/docs/features/timeline.md: main carried then changed it: 5032597657 (🐛 fix(mvp): |
| 2026-10-21 22:53 | `3040e79cca` | SUPERSEDED | 3/12/0/0 | 3040e79cca |  | apps/mvp/docs/features/timeline.md: main carried then changed it: 5032597657 (🐛 fix(mvp): |
| 2026-10-21 22:53 | `26d7a5b737` | ON-MAIN | 20/0/0/0 | 26d7a5b737 | 🐛 fix(cli): keep run projections and usage accounting accurate |  |
| 2026-10-21 22:54 | `8f76cf845e` | SUPERSEDED | 9/5/0/0 | 8f76cf845e | 🐛 fix(mvp): a terminal whose open never finished offers Open terminal  | apps/mvp/docs/features/branch-workspace.md: main carried then changed it: cca07b3470 (✨ fe |
| 2026-10-21 22:55 | `66df7215b2` | ON-MAIN | 24/0/0/0 | 66df7215b2 | 🐛 fix(cli): protect diagnostics and bound command reads |  |
| 2026-10-21 22:57 | `690db8e7a0` | ON-MAIN | 8/0/0/0 | 3d6dac6fb7 | 🐛 fix(mvp): version bounded device home caches and preserve schema his |  |
| 2026-10-21 22:57 | `d4373efcd8` | ON-MAIN | 8/0/0/0 | d4373efcd8 | 🐛 fix(mvp): version bounded device home caches and preserve schema his |  |
| 2026-10-21 22:57 | `6c2b618ad6` | SUPERSEDED | 21/1/0/0 | 6c2b618ad6 |  | apps/mvp/src/features/theme/theme.test.ts: main carried then changed it: 9bba4661b2 (🐛 fix |
| 2026-10-21 22:59 | `7e6e777b16` | PARTIAL | 36/0/0/1 | 7e6e777b16 |  | apps/mvp/docs/work/cli-cancellation-928301.md: status: in-progress |
| 2026-10-21 23:00 | `05f83d5b23` | ON-MAIN | 37/0/0/0 | 05f83d5b23 | 🐛 fix(cli): bound admission scans and release cancelled interactions |  |
| 2026-10-21 23:01 | `bb2491e0a2` | SUPERSEDED | 12/1/0/0 | 61f1ea1263 | 🐛 fix(issues): validate queued writes and retain failed persistence | apps/mvp/src/features/issues/writes.ts: main carried then changed it: 124fdc7e00 (🔍 chore( |
| 2026-10-21 23:01 | `6dd6277f0d` | SUPERSEDED | 12/1/0/0 | 6dd6277f0d | 🐛 fix(issues): validate queued writes and retain failed persistence | apps/mvp/src/features/issues/writes.ts: main carried then changed it: 124fdc7e00 (🔍 chore( |
| 2026-10-21 23:01 | `97f2a041f0` | SUPERSEDED | 11/2/0/0 | 97f2a041f0 |  | apps/mvp/docs/work/issues-credential-regressions.md: landed as c40976dcbe (same author and |
| 2026-10-21 23:01 | `1f1f31f298` | SUPERSEDED | 11/2/0/0 | 1f1f31f298 |  | apps/mvp/docs/features/issues.md: landed as c40976dcbe (same author and time, committed la |
| 2026-10-21 23:02 | `c02e30023c` | SUPERSEDED | 27/10/0/0 | c02e30023c | 🐛 fix(mvp): a branch's page opened offline shows at once, and opens it | apps/mvp/docs/features/branch-workspace.md: main carried then changed it: fae3a9e2e8 (🐛 fi |
| 2026-10-21 23:02 | `87afc19dba` | SUPERSEDED | 24/10/0/0 | 87afc19dba | 🐛 fix(mvp): a branch's page opened offline shows at once, and opens it | apps/mvp/docs/features/branch-workspace.md: main carried then changed it: fae3a9e2e8 (🐛 fi |
| 2026-10-21 23:03 | `02def9611e` | PARTIAL | 9/0/1/1 | 02def9611e |  | apps/mvp/docs/work/model-proxy-wire-boundaries.md: data. Relative endpoint identity, blank |
| 2026-10-21 23:04 | `09e2b52cd0` | PARTIAL | 9/0/1/1 | 09e2b52cd0 | 🐛 fix(model): bound proxy lines and validate public requests | apps/mvp/docs/work/model-proxy-wire-boundaries.md: data. Relative endpoint identity, blank |
| 2026-10-21 23:04 | `cff156d794` | PARTIAL | 9/0/1/1 | cff156d794 |  | apps/mvp/docs/work/model-proxy-wire-boundaries.md: data. Relative endpoint identity, blank |
| 2026-10-21 23:04 | `d349d20f42` | PARTIAL | 9/0/1/1 | d349d20f42 |  | apps/mvp/docs/work/model-proxy-wire-boundaries.md: data. Relative endpoint identity, blank |
| 2026-10-21 23:07 | `bedd7ff582` | PARTIAL | 16/0/0/1 | bedd7ff582 |  | apps/mvp/docs/work/flow-sibling-suspension-codec.md: Reworked ecea1e22e6ab on e90cc1cf2f12 |
| 2026-10-21 23:08 | `104a7b5e07` | ON-MAIN | 17/0/0/0 | 104a7b5e07 | 🐛 fix(flow): nested sibling suspensions settle and encoded codec types |  |
| 2026-10-21 23:08 | `9ef520910f` | ON-MAIN | 17/0/0/0 | 9ef520910f | 🐛 fix(flow): nested sibling suspensions settle and encoded codec types |  |
| 2026-10-21 23:08 | `9316077424` | ON-MAIN | 17/0/0/0 | 9316077424 | 🐛 fix(flow): nested sibling suspensions settle and encoded codec types |  |
| 2026-10-21 23:15 | `5c62a9dd91` | SUPERSEDED | 66/23/0/0 | d139f1b0d5 | ✨ feat(mvp): the plugin host, and the queue as its first plugin | apps/mvp/docs/features/plugins.md: main carried then changed it: 300b3005dd (✨ feat(mvp): |
| 2026-10-21 23:15 | `c664fef949` | SUPERSEDED | 66/23/0/0 | 24a7bd8f79 | ✨ feat(mvp): the plugin host, and the queue as its first plugin | apps/mvp/docs/features/plugins.md: main carried then changed it: 300b3005dd (✨ feat(mvp): |
| 2026-10-21 23:15 | `fbca50ecc5` | SUPERSEDED | 66/23/0/0 | 1f91ef7a70 | ✨ feat(mvp): the plugin host, and the queue as its first plugin | apps/mvp/docs/features/plugins.md: main carried then changed it: 300b3005dd (✨ feat(mvp): |
| 2026-10-21 23:15 | `46738da98a` | SUPERSEDED | 63/22/0/0 | cd19a53d1a | ✨ feat(mvp): the plugin host, and the queue as its first plugin | apps/mvp/docs/features/plugins.md: main carried then changed it: 300b3005dd (✨ feat(mvp): |
| 2026-10-21 23:16 | `a2c7b533ed` | SUPERSEDED | 16/5/0/0 | 8f76cf845e | 🐛 fix(mvp): a branch's Terminal link shows the terminal at once, not a | apps/mvp/docs/features/branch-workspace.md: main carried then changed it: d4e58f4ed2 (🐛 fi |
| 2026-10-21 23:17 | `4e6686686f` | PARTIAL | 2/0/1/1 | 4e6686686f |  | packages/smithers/flows/journal/src/SqlJournal.ts: const kept = deferred.get(runId)!.filte |
| 2026-10-21 23:19 | `89f373ae95` | SUPERSEDED | 7/4/0/0 | 89f373ae95 | 🔊 fix(mvp): a terminal's session start names its stage, and a stuck on | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: cca07b3470 (✨ feat( |
| 2026-10-21 23:19 | `ad1d4ef682` | PARTIAL | 2/8/2/1 | ad1d4ef682 | 🔊 fix(mvp): a terminal's session start names its stage, and a stuck on | apps/mvp/docs/decisions/0028-terminal-session-deadline.md: Accepted, 2026-10-21 (Will's te |
| 2026-10-21 23:22 | `0d063218ac` | SUPERSEDED | 17/1/0/0 | 0d063218ac | 🐛 fix(history): isolate copies and reject incomplete verification | packages/smithers/test/StoreCopy.test.ts: main carried then changed it: 72ece084eb (🐛 fix( |
| 2026-10-21 23:22 | `e8db41361c` | ON-MAIN | 11/0/0/0 | e8db41361c | 🐛 fix(cli): preserve discovery warnings and honor TUI cancellation |  |
| 2026-10-21 23:23 | `4d87a1c820` | SUPERSEDED | 7/1/0/0 | 4d87a1c820 | 🐛 fix(spend): synced channel updates preserve unsaved destinations | apps/mvp/vitest.config.ts: main carried then changed it: 08abf6895a (🔧 chore(vitest): ever |
| 2026-10-21 23:24 | `77c9d62aff` | PARTIAL | 8/0/1/1 | 77c9d62aff | 🐛 fix(effect-electric): validate every batch member before advancing o | apps/mvp/docs/work/mini-effect-electric-validation.md: owner: mini/fix-packages-effect-ele |
| 2026-10-21 23:25 | `597f487f83` | SUPERSEDED | 22/1/0/0 | 597f487f83 | 🐛 fix(effect-tanstack-db): bound snapshots and type query construction | apps/mvp/src/test/repoDevice.ts: main carried then changed it: 0549b2ea8e (✨ feat(mvp): fi |
| 2026-10-21 23:26 | `0aa846e9c2` | ON-MAIN | 8/0/0/0 | 0aa846e9c2 | 🐛 fix(registry): project complete effect literals and decode string es |  |
| 2026-10-21 23:27 | `f477e44148` | ON-MAIN | 18/0/0/0 | f477e44148 | 🐛 fix(engine): publish ownership atomically and isolate action cancell |  |
| 2026-10-21 23:28 | `8d811f68cb` | SUPERSEDED | 12/1/0/0 | 8d811f68cb | fix(mvp): resync repository device cache at schema v4 | apps/mvp/src/device/migrations.test.ts: main carried then changed it: c129f7b85a (🐛 fix(mv |
| 2026-10-21 23:28 | `5a397faae0` | ON-MAIN | 21/0/0/0 | 5a397faae0 | 🐛 fix(flows): authenticate deployment and preserve typed action failur |  |
| 2026-10-21 23:29 | `d5ebb2c9ec` | PARTIAL | 16/0/15/5 | d5ebb2c9ec | 🐛 fix(flow): keep retries durable and graph identities sound | apps/mvp/docs/work/mini-flow-confirmed-bugs.md: - Node 26.5.0; frozen offline install pass |
| 2026-10-21 23:30 | `cce3569189` | ON-MAIN | 4/0/0/0 | cce3569189 | 🐛 fix(ui): hide unknown issue counts and preserve metadata link identi |  |
| 2026-10-21 23:32 | `2928064a89` | SUPERSEDED | 7/1/0/0 | 2928064a89 | 🐛 fix(ui): preserve generated item conversation attributes | packages/smithers/ui/src/item-conversation/ItemConversation.tsx: landed as a7a7c1222a (sam |
| 2026-10-21 23:33 | `dc35965264` | ON-MAIN | 1/0/0/0 | dc35965264 | 🧪 test(mvp): a branch machine's whole life, end to end, locally and in |  |
| 2026-10-21 23:34 | `238e35feb7` | SUPERSEDED | 52/5/0/0 | 238e35feb7 | 🐛 fix(cli): preserve session and credential ownership | packages/smithers/PACKAGE.ts: main carried then changed it: a8f8b32afd (🐛 fix(cli): honor |
| 2026-10-21 23:34 | `bb5ee16706` | SUPERSEDED | 9/1/0/0 | bb5ee16706 | 🐛 fix(exports): reconcile reviewed public APIs and publication maps | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-21 23:35 | `0b051dfe30` | ON-MAIN | 18/0/0/0 | 0b051dfe30 | ✅ test(agent): re-pin the sealed model and cell-call goldens, and prov |  |
| 2026-10-21 23:35 | `9b62e33935` | SUPERSEDED | 11/3/0/0 | 9b62e33935 | ✅ test(agent): re-pin the sealed model and cell-call goldens, and prov | packages/smithers/agent/test/StepKeyGolden.test.ts: landed as 7f16c87385 (same author and |
| 2026-10-21 23:38 | `02a3d5d58a` | PARTIAL | 4/2/2/2 | 02a3d5d58a |  | .smithers/flows/node_modules: /Users/williamcory/smithers-ws-terminal-opening/.smithers/fl |
| 2026-10-21 23:47 | `d847d43bdb` | PARTIAL | 12/0/2/3 | d847d43bdb | 🐛 fix(flow): preserve attempt identity and serialize private once writ | apps/mvp/docs/work/rework-be74787a.md: Latitude: engine-store `vitest run test/Once.test.t |
| 2026-10-21 23:48 | `3992496c63` | SUPERSEDED | 21/2/0/0 | 3992496c63 | 🐛 fix(notifications): validate delivery evidence and notice access | packages/smithers/notifications/src/Channels.ts: main carried then changed it: 89b4eef1d7 |
| 2026-10-21 23:54 | `fbe8b0be4f` | SUPERSEDED | 31/5/0/0 | fbe8b0be4f | 🐛 fix(backend): enforce RPC types, opaque secrets and safe lifecycle | packages/smithers/src/internal/backend/Definitions.ts: landed as 1103417d71 (same author a |
| 2026-10-21 23:56 | `dd0911cbdf` | ON-MAIN | 36/0/0/0 | dd0911cbdf | 🐛 fix(control): preserve cancellation causes and caller boundaries |  |
| 2026-10-21 23:56 | `36aac6956a` | ON-MAIN | 20/0/0/0 | 36aac6956a | 🐛 fix(operator): authorize stored credentials and preserve launch reco |  |
| 2026-10-21 23:58 | `d139f1b0d5` | SUPERSEDED | 20/6/0/0 | d139f1b0d5 | 🔒 feat(mvp): plugins' trust boundaries, checked at load and by the bui | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: 4 |
| 2026-10-21 23:58 | `24a7bd8f79` | SUPERSEDED | 20/6/0/0 | 24a7bd8f79 | 🔒 feat(mvp): plugins' trust boundaries, checked at load and by the bui | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: 4 |
| 2026-10-21 23:58 | `1f91ef7a70` | SUPERSEDED | 20/6/0/0 | 1f91ef7a70 | 🔒 feat(mvp): plugins' trust boundaries, checked at load and by the bui | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: 4 |
| 2026-10-21 23:58 | `cd19a53d1a` | SUPERSEDED | 11/4/0/0 | cd19a53d1a | 🔒 feat(mvp): plugins' trust boundaries, checked at load and by the bui | apps/mvp/PACKAGE.ts: main carried then changed it: 52a5e776f9 (✨ feat(mvp): create branche |
| 2026-10-21 23:59 | `88a0326800` | SUPERSEDED | 33/3/0/0 | 88a0326800 | 🐛 fix(cli): preserve journal evidence and safe host diagnostics | packages/smithers/src/internal/EngineJournalSupervisor.ts: main carried then changed it: 7 |
| 2026-10-21 23:59 | `6c36ef1791` | ON-MAIN | 19/0/0/0 | 6c36ef1791 | 🐛 fix(suggest): honor flow rulings and preserve check and lockfile ide |  |
| 2026-10-22 00:01 | `271393ffa7` | SUPERSEDED | 39/1/0/0 | 271393ffa7 | 🐛 fix(harness): memory admission stays within verified limits | packages/smithers/agent/harness/PACKAGE.ts: landed as dc14ec86ad (same author and time, co |
| 2026-10-22 00:07 | `16af72e471` | SUPERSEDED | 31/1/0/0 | 16af72e471 | 🐛 fix(control): preserve watch tails and rejected outcomes | packages/smithers/control/PACKAGE.ts: main carried then changed it: ba5cfef178 (🐛 fix(cont |
| 2026-10-22 00:12 | `8e2e192549` | SUPERSEDED | 20/1/0/0 | 8e2e192549 | 🐛 fix(evals): preserve identities and isolate untrusted scoring data | packages/smithers/agent/evals/src/Runner.ts: main carried then changed it: e79094809f (🐛 f |
| 2026-10-22 00:13 | `7c0b1fd1bf` | SUPERSEDED | 19/1/0/0 | 7c0b1fd1bf | 🐛 fix(control): preserve journal approvals and complete inventories | packages/smithers/control/src/ControlRpcs.ts: main carried then changed it: e4558ffa7f (🐛 |
| 2026-10-22 00:14 | `9e72d4765d` | ON-MAIN | 3/0/0/0 | 9e72d4765d | 🐛 fix(harness): narrow encoded JSON in cause test |  |
| 2026-10-22 00:16 | `ab300f4e44` | SUPERSEDED | 22/1/0/0 | ab300f4e44 | 🐛 fix(agent): preserve fallback and durable accounting limits | packages/smithers/agent/src/Budget.ts: landed as 387adb691e (same author and time, committ |
| 2026-10-22 00:16 | `ec0ec5d54a` | ON-MAIN | 10/0/0/0 | ec0ec5d54a | 🐛 fix(backend): bound process output and require one revision |  |
| 2026-10-22 00:29 | `1aa63307c9` | PARTIAL | 8/7/0/2 | 1cd360747c | 🔎 feat(flows): correlate remote run admission timing | packages/smithers/flows/platform-cloudflare/src/ExecutionObject.ts: +      yield* Effect.l |
| 2026-10-22 00:29 | `5604c29b24` | SUPERSEDED | 9/7/0/0 | 26da3c47fd | 🔎 feat(flows): correlate remote run admission timing | apps/mvp/docs/work/todo-run-start.md: main carried then changed it: 719b30408c (🐛 fix(mvp) |
| 2026-10-22 00:32 | `a1c820f281` | PARTIAL | 47/7/18/1 | 1cd360747c | 🐛 fix(mvp): cancel dropped TODO runs durably | apps/site/public/llms-full.txt: \| `Driver`                \| `Context.Service<{ admit, dr |
| 2026-10-22 00:32 | `dd33ebd480` | SUPERSEDED | 5/1/0/0 | 1cd360747c | 🐛 fix(platform-cloudflare): bound admission alarm delays | packages/smithers/flows/platform-cloudflare/test/AdmissionLatency.test.ts: main carried th |
| 2026-10-22 00:32 | `26da3c47fd` | PARTIAL | 47/7/18/1 | 26da3c47fd | 🐛 fix(mvp): cancel dropped TODO runs durably | apps/site/public/llms-full.txt: \| `Driver`                \| `Context.Service<{ admit, dr |
| 2026-10-22 00:32 | `c8001f766e` | SUPERSEDED | 5/1/0/0 | 26da3c47fd | 🐛 fix(platform-cloudflare): bound admission alarm delays | packages/smithers/flows/platform-cloudflare/test/AdmissionLatency.test.ts: main carried th |
| 2026-10-22 00:42 | `afa18db821` | ON-MAIN | 13/0/0/0 | afa18db821 | 🐛 fix(cli): honor auth selection and workspace path boundaries |  |
| 2026-10-22 00:42 | `4debb68b67` | ON-MAIN | 12/0/0/0 | 4debb68b67 | 🐛 fix(evals): malformed scorer results and snapshot getters fail safel |  |
| 2026-10-22 00:42 | `d1c6a15702` | ON-MAIN | 13/0/0/0 | d1c6a15702 | 🐛 fix(platform-browser): keep process errors free of command and excep |  |
| 2026-10-22 00:42 | `f2cbad07ec` | ON-MAIN | 4/0/0/0 | f2cbad07ec | 🐛 fix(ui): clickable agent status pills preserve host props |  |
| 2026-10-22 00:43 | `a7403c46d5` | SUPERSEDED | 43/3/0/0 | a7403c46d5 | 🐛 fix(control): enforce schema and RPC safety invariants | packages/smithers/PACKAGE.ts: main carried then changed it: a8f8b32afd (🐛 fix(cli): honor |
| 2026-10-22 00:45 | `7791be2481` | PARTIAL | 11/1/2/3 | 7791be2481 | 🐛 fix(theme): system changes update views and toggle contains defects | apps/mvp/docs/features/flows.md: The theme's transient `theme-display` collection publishe |
| 2026-10-22 00:46 | `0ae96a044a` | PARTIAL | 30/4/1/2 | 0ae96a044a | 🐛 fix(backend): preserve edits and enforce execution boundaries | apps/mvp/docs/work/mini-backend-449117.md: - `vitest run --coverage.enabled=false test/Bac |
| 2026-10-22 00:46 | `9f99ba3129` | SUPERSEDED | 14/2/0/0 | 9f99ba3129 | 🐛 fix(registry): validate sandbox limits and pack roots, bind lockfile | packages/smithers/agent/registry/src/Descriptor.ts: main carried then changed it: 3ed4cd57 |
| 2026-10-22 00:46 | `0e7adef4c3` | ON-MAIN | 4/0/0/0 | 0e7adef4c3 | 🐛 fix(terminal-frame): enforce shortcut allowlist and dimension bounds |  |
| 2026-10-22 00:53 | `413997f7dd` | SUPERSEDED | 15/2/0/0 | 413997f7dd | 🐛 fix(flow): escape token diagnostics and propagate queue take failure | packages/smithers/flows/flow/PACKAGE.ts: main carried then changed it: 89b4eef1d7 (🎨 style |
| 2026-10-22 00:59 | `467ba8d3c1` | PARTIAL | 41/0/1/1 | 467ba8d3c1 | 🐛 fix(harness): keep ledger evidence, cell boundaries and compaction t | apps/mvp/docs/work/mini-harness-regressions-216946.md: - `pnpm --filter @smthrs/harness ex |
| 2026-10-22 01:14 | `3196b681bf` | PARTIAL | 41/6/3/0 | 85b125e397 | 🐛 fix(mvp): a session check ChatApi couldn't answer asks again, as the | apps/mvp/docs/features/flows.md: The execution id is minted once per dispatch unless the c |
| 2026-10-22 01:14 | `3167b5b50c` | SUPERSEDED | 1/1/0/0 | 8633fdc66d | 📝 docs(mvp): flows: migration 0040, and the 2026-10-22 production run | apps/mvp/docs/features/flows.md: main carried then changed it: b120140226 (✨ feat(mvp): ru |
| 2026-10-22 01:14 | `f5a1298ccd` | SUPERSEDED | 2/3/0/0 | 8633fdc66d | 🐛 fix(mvp): the code page's Save sits by the file's name, where a toas | apps/mvp/src/features/flows-ui/components/FlowCodeCard.tsx: main carried then changed it: |
| 2026-10-22 01:15 | `508e81bbdf` | SUPERSEDED | 0/1/0/0 | d0c6aa7e2f | 📝 docs(mvp): the design for a run's change feed that moves while an ac | apps/mvp/docs/work/run-change-feed-progress.md: main carried then changed it: e3c8b6ea5a ( |
| 2026-10-22 01:16 | `d0c6aa7e2f` | SUPERSEDED | 26/5/0/0 | d0c6aa7e2f | 🐛 fix(run-store): advance the change feed during long actions | apps/mvp/src/features/runs/remote.test.ts: main carried then changed it: 95220a76de (🐛 fix |
| 2026-10-22 01:22 | `85b125e397` | PARTIAL | 69/5/3/1 | 85b125e397 | 🐛 fix(mvp): a tab on a visitor's data takes the person who signs in in | apps/mvp/src/features/attention/store.ts: // Marked before the dispatch forks, so a change |
| 2026-10-22 01:23 | `afac32fc6f` | ON-MAIN | 1/0/0/0 | afac32fc6f | 📝 docs(mvp): branch sandboxes work in production on the tini image, an |  |
| 2026-10-22 01:25 | `6a699e5e8b` | SUPERSEDED | 3/6/0/0 | 6ae79dec66 | 🐛 fix(mvp): reserve page space for live toasts | apps/mvp/docs/decisions/0034-toasts-reserve-page-space.md: main deleted it in dd7d1556b2 ( |
| 2026-10-22 01:25 | `c4e9b416c4` | ON-MAIN | 18/0/0/0 | c4e9b416c4 | 🐛 fix(flow): preserve attempt identity and serialize private once writ |  |
| 2026-10-22 01:25 | `c5c1ec01dc` | ON-MAIN | 18/0/0/0 | c5c1ec01dc | 🐛 fix(model): preserve finite costs, effort, signatures and classifier |  |
| 2026-10-22 01:27 | `3f81cf738f` | PARTIAL | 28/0/1/1 | 3f81cf738f | 🐛 fix(harness): preserve mutation and compaction evidence and guard co | apps/mvp/docs/work/harness-internal-findings.md: - `pnpm exec smithers-build test '//packa |
| 2026-10-22 01:27 | `555f1de067` | ON-MAIN | 10/0/0/0 | 555f1de067 | 🐛 fix(effect-electric): validate every batch member before advancing o |  |
| 2026-10-22 01:29 | `06799a9d9d` | PARTIAL | 37/0/12/4 | 06799a9d9d | 🐛 fix(github): preserve write outcomes and serialize keyed actions | apps/mvp/docs/work/github-write-safety-342737.md: - Pull-request links use GitHub's actual |
| 2026-10-22 01:33 | `409f0386ed` | SUPERSEDED | 39/1/0/0 | 409f0386ed | 🐛 fix(model): inject the wire trace host sink | packages/repo-targets/browser/browser-contract.mjs: landed as 9d77a9308b (same author and |
| 2026-10-22 01:33 | `829c3ee0c3` | PARTIAL | 24/0/0/1 | 829c3ee0c3 | 🐛 fix(model-host): fence callbacks and protect fallback credentials | apps/mvp/docs/work/fix-model-host-352044.md: Final package run: `pnpm --dir packages/smith |
| 2026-10-22 01:40 | `87340f58b1` | SUPERSEDED | 33/1/0/0 | 3e36921290 | 🐛 fix(core,registry): keep a Markdown flow's budget, deadline, sandbox | .changeset/registry-markdown-limits.md: main carried then changed it: fb12b45519 (🐛 fix(re |
| 2026-10-22 01:40 | `5bf97b1aaf` | ON-MAIN | 2/0/0/0 | 3e36921290 | 🎨 style(registry): format delegation concept doc and ModuleFlow test w |  |
| 2026-10-22 01:42 | `a676aa7357` | ON-MAIN | 50/0/0/0 | a676aa7357 | 🐛 fix(integrations): keep core events safe and polling durable |  |
| 2026-10-22 01:51 | `3e36921290` | ON-MAIN | 6/0/0/0 | 3e36921290 | 🐛 fix(registry): run a Markdown executable under its declared deadline |  |
| 2026-10-22 02:09 | `853b95377e` | SUPERSEDED | 19/5/0/0 | ca3ccee5d9 | ✨ feat(ci): run each CI job on its own machine at the requested commit | apps/mvp/docs/features/ci.md: main carried then changed it: e3a4a95b63 (✨ feat(mvp): every |
| 2026-10-22 02:09 | `5afcab6094` | ON-MAIN | 1/0/0/0 | ca3ccee5d9 | 🎨 style(sandbox): document terminal dimensions separately |  |
| 2026-10-22 02:09 | `3c8087025a` | SUPERSEDED | 19/5/0/0 | a4b7a02775 | ✨ feat(ci): run each CI job on its own machine at the requested commit | apps/mvp/docs/features/ci.md: main carried then changed it: e3a4a95b63 (✨ feat(mvp): every |
| 2026-10-22 02:09 | `7147fe57d8` | ON-MAIN | 1/0/0/0 | a4b7a02775 | 🎨 style(sandbox): document terminal dimensions separately |  |
| 2026-10-22 02:09 | `1c5d992d15` | SUPERSEDED | 14/10/0/0 | 67917e16d7 | ✨ feat(ci): ci/job runs a CI job on its own machine at exactly the com | apps/mvp/docs/features/ci.md: main carried then changed it: c0b1b3651d (✨ feat(ci): run ea |
| 2026-10-22 02:09 | `1389c84f28` | ON-MAIN | 14/0/0/0 | 67917e16d7 | 🎨 style(sandbox): one JSDoc per terminal bound, and the two tests dpri |  |
| 2026-10-22 02:13 | `365a6fc5eb` | SUPERSEDED | 14/1/0/0 | 13182e1705 | 🐛 fix(electric): correlate shape proxy outcomes | packages/effect-electric/src/ShapeProxy.ts: main carried then changed it: 11b7635fa1 (🎨 st |
| 2026-10-22 02:14 | `80f52bf8a5` | SUPERSEDED | 36/4/0/0 | c16cc6d534 | 🐛 fix(database,platform-cloudflare): writers let Hyperdrive's connecti | packages/smithers/flows/database/src/DatabaseMetrics.ts: main carried then changed it: f37 |
| 2026-10-22 02:14 | `2ae19368ff` | SUPERSEDED | 29/13/0/0 | 2ae19368ff | 🐛 fix(database,platform-cloudflare): writers let Hyperdrive's connecti | apps/site/public/llms-full.txt: landed as 5ded0f4b84 (same author and time, committed late |
| 2026-10-22 02:14 | `73a3997468` | SUPERSEDED | 17/26/0/0 | 0a442931c6 | 🐛 fix(database,platform-cloudflare): writers let Hyperdrive's connecti | .changeset/database-writer-lock-timeout.md: landed as 5ded0f4b84 (same author and time, co |
| 2026-10-22 02:14 | `1955a2eb6b` | SUPERSEDED | 16/26/0/0 | 3216e65c29 | 🐛 fix(database,platform-cloudflare): writers let Hyperdrive's connecti | .changeset/database-writer-lock-timeout.md: landed as 5ded0f4b84 (same author and time, co |
| 2026-10-22 02:17 | `a71b7cb190` | SUPERSEDED | 25/2/0/0 | 64266eb489 | ✨ feat(mvp): flow/drafts lists your drafts not saved yet, so the agent | apps/mvp/src/features/flows-ui/flows.test.ts: main carried then changed it: b120140226 (✨ |
| 2026-10-22 02:17 | `1fceb5a10b` | SUPERSEDED | 20/10/0/0 | 64266eb489 | 🐛 fix(mvp): the agent leaves the person's acts to them, stops when a f | apps/mvp/docs/features/agent.md: main carried then changed it: c4935cc4a5 (🐛 fix(mvp): an |
| 2026-10-22 02:25 | `0a2759b8ed` | ON-MAIN | 38/0/0/0 | 0a2759b8ed | 🐛 fix(backend): preserve mutation bodies and cache upload bytes |  |
| 2026-10-22 02:26 | `65d0c9b954` | SUPERSEDED | 41/1/0/0 | 65d0c9b954 | 🐛 fix(github): preserve write outcomes and serialize keyed actions | packages/smithers/agent/integrations/src/github/Actions.ts: landed as a7052c78fe (same aut |
| 2026-10-22 02:27 | `9da5fee736` | ON-MAIN | 71/0/0/0 | 9da5fee736 | 🐛 fix(flow): keep retries durable and graph identities sound |  |
| 2026-10-22 02:27 | `ebde26fe07` | ON-MAIN | 46/0/0/0 | ebde26fe07 | 🐛 fix(harness): keep ledger evidence, cell boundaries and compaction t |  |
| 2026-10-22 02:28 | `acf8dae47b` | SUPERSEDED | 36/5/0/0 | acf8dae47b | 🐛 fix(backend): preserve edits and enforce execution boundaries | packages/smithers/PACKAGE.ts: main carried then changed it: 89b4eef1d7 (🎨 style: format th |
| 2026-10-22 02:29 | `69b56b184f` | PARTIAL | 24/0/5/3 | 69b56b184f | 🐛 fix(model): secure endpoints and preserve evaluation accounting | apps/mvp/docs/work/model-evaluator-regressions-721994.md: - Astra review: no remaining fin |
| 2026-10-22 02:29 | `6ae79dec66` | SUPERSEDED | 28/6/0/0 | 6ae79dec66 | 🐛 fix(mvp): settle stale working notices from terminal receipts | apps/mvp/docs/decisions/0034-toasts-reserve-page-space.md: main deleted it in dd7d1556b2 ( |
| 2026-10-22 02:33 | `01117011e5` | SUPERSEDED | 20/1/0/0 | 01117011e5 | 🐛 fix(theme): system changes update views and toggle contains defects | apps/mvp/src/features/theme/theme.ts: main carried then changed it: 124fdc7e00 (🔍 chore(mv |
| 2026-10-22 02:33 | `232ed3b05c` | PARTIAL | 14/0/1/2 | 232ed3b05c | 🐛 fix(harness): preserve safe recovery and accurate turn evidence | apps/mvp/docs/work/mini-harness-719499.md: - Harness `vitest run --coverage.enabled=false |
| 2026-10-22 02:34 | `a607670a74` | SUPERSEDED | 107/3/0/0 | a607670a74 | 🐛 fix(scorers): move scoring into caller-owned durable actions | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-22 02:34 | `8f76343321` | SUPERSEDED | 106/4/0/0 | 8f76343321 | 🐛 fix(scorers): move scoring into caller-owned durable actions | apps/mvp/docs/work/scorers-durable.md: landed as 65877877e6 (same author and time, committ |
| 2026-10-22 02:41 | `5de795df60` | ON-MAIN | 20/0/0/0 | ab07e25166 | 🐛 fix(observability): split an OTLP batch under the collector's limits |  |
| 2026-10-22 02:44 | `b0ae147b9d` | PARTIAL | 0/0/2/1 | 3216e65c29 | 📝 docs: API baseline for @smthrs/database's writer-lock timeout, pool  | .smithers/flows/release/fixtures/public-api-baseline.json: "DatabaseMetrics.d.ts": "7cd5cb |
| 2026-10-22 02:45 | `3216e65c29` | SUPERSEDED | 9/2/0/0 | 3216e65c29 | ⚡ perf(mvp): create remote flow execution objects where the deployment | apps/mvp/docs/infrastructure.md: main carried then changed it: a1eb8b8c3d (📝 docs(mvp): pr |
| 2026-10-22 02:47 | `a1182bb514` | SUPERSEDED | 41/9/0/0 | c16cc6d534 | ✨ feat(mvp): ops/DatabaseLoad alerts Admins when Postgres connections  | apps/mvp/docs/features/spend-alerts.md: main carried then changed it: cca07b3470 (✨ feat(m |
| 2026-10-22 02:47 | `cd5f1d5b4d` | SUPERSEDED | 41/9/0/0 | 0a442931c6 | ✨ feat(mvp): ops/DatabaseLoad alerts Admins when Postgres connections  | apps/mvp/docs/features/spend-alerts.md: main carried then changed it: cca07b3470 (✨ feat(m |
| 2026-10-22 03:00 | `ab07e25166` | SUPERSEDED | 1/18/0/0 | ab07e25166 | 🐛 fix(mvp): a branch page's conversation shows with its chrome, not 25 | apps/mvp/docs/features/timeline.md: main carried then changed it: 29ae6de911 (🐛 fix(mvp): |
| 2026-10-22 03:00 | `deda8dc610` | SUPERSEDED | 14/3/0/0 | ab07e25166 | 📈 fix(mvp): browser telemetry reaches the relay whole, timeline record | apps/mvp/src/boot.ts: main carried then changed it: 51e98d98f3 (✨ feat(mvp): a bug report |
| 2026-10-22 03:09 | `d009de6375` | SUPERSEDED | 1/4/0/0 | 08cb0cd99d | ✅ test(mvp): VibeLang's visitor, contributor and maintainer journeys o | apps/mvp/docs/features/home.md: main carried then changed it: cb736313eb (✨ feat(mvp): a r |
| 2026-10-22 03:09 | `8fcdca85c4` | SUPERSEDED | 1/4/0/0 | b238afaac2 | ✅ test(mvp): VibeLang's visitor, contributor and maintainer journeys o | apps/mvp/docs/features/home.md: main carried then changed it: cb736313eb (✨ feat(mvp): a r |
| 2026-10-22 03:09 | `67da601d64` | SUPERSEDED | 1/4/0/0 | 6b2971b10f | ✅ test(mvp): VibeLang's visitor, contributor and maintainer journeys o | apps/mvp/docs/features/home.md: main carried then changed it: cb736313eb (✨ feat(mvp): a r |
| 2026-10-22 03:16 | `8633fdc66d` | SUPERSEDED | 0/1/0/0 | 8633fdc66d | 📝 docs(mvp): flow-authoring: all three flows tests pass in production  | apps/mvp/docs/work/flow-authoring.md: main carried then changed it: b120140226 (✨ feat(mvp |
| 2026-10-22 03:20 | `f1908bc8d9` | ON-MAIN | 33/0/0/0 | f1908bc8d9 | 🐛 fix(harness): preserve mutation and compaction evidence and guard co |  |
| 2026-10-22 03:20 | `8c681ea2b6` | ON-MAIN | 28/0/0/0 | 8c681ea2b6 | 🐛 fix(model-host): fence callbacks and protect fallback credentials |  |
| 2026-10-22 03:22 | `d88c3b83aa` | SUPERSEDED | 4/1/0/0 | 64266eb489 | ✅ test(mvp): the first agent eval suite's baseline, re-recorded from a | apps/mvp/docs/features/agent-evals.md: main carried then changed it: 457667247b (✅ test(mv |
| 2026-10-22 03:39 | `184402303f` | SUPERSEDED | 36/6/0/0 | e457a8fef8 | ✨ feat(engine-store): a hosted drive takes a budget and yields at a st | apps/site/public/llms-full.txt: main carried then changed it: d9e2c5af35 (🔧 chore: regener |
| 2026-10-22 03:39 | `428be8dd93` | SUPERSEDED | 36/6/0/0 | 0a442931c6 | ✨ feat(engine-store): a hosted drive takes a budget and yields at a st | apps/site/public/llms-full.txt: main carried then changed it: d9e2c5af35 (🔧 chore: regener |
| 2026-10-22 03:42 | `d6eb05b0bb` | SUPERSEDED | 17/3/0/0 | ca3ccee5d9 | ✨ feat(ci): plan repository flows in QuickJS and run their jobs durabl | apps/mvp/docs/features/ci.md: main carried then changed it: 9f6bbd1e9c (✨ feat(ci): dispat |
| 2026-10-22 03:42 | `1483658caf` | PARTIAL | 15/5/0/2 | a4b7a02775 | ✨ feat(ci): plan repository flows in QuickJS and run their jobs durabl | apps/mvp/worker/AgentSandbox.workerd.test.ts: ;({ worker, wasm } = await start("agent", EN |
| 2026-10-22 03:42 | `30080091a6` | PARTIAL | 14/5/0/2 | 67917e16d7 | ✨ feat(ci): a repository's own flow.ts runs on Smithers, planned in a  | apps/mvp/worker/AgentSandbox.workerd.test.ts: ;({ worker, wasm } = await start("agent", EN |
| 2026-10-22 03:45 | `344c597278` | SUPERSEDED | 11/3/0/0 | 64266eb489 | ✅ test(mvp): the flows suite's baseline, from a safe full run after th | apps/mvp/docs/features/agent-evals.md: main carried then changed it: 0549b2ea8e (✨ feat(mv |
| 2026-10-22 03:47 | `e457a8fef8` | SUPERSEDED | 39/6/0/0 | e457a8fef8 | ✨ feat(platform-cloudflare,mvp): an execution's alarm drives within a  | packages/smithers/flows/platform-cloudflare/docs/concepts/execution-lifecycle.md: main car |
| 2026-10-22 03:47 | `0a442931c6` | SUPERSEDED | 39/6/0/0 | 0a442931c6 | ✨ feat(platform-cloudflare,mvp): an execution's alarm drives within a  | packages/smithers/flows/platform-cloudflare/docs/concepts/execution-lifecycle.md: main car |
| 2026-10-22 03:48 | `f7a978a0dc` | SUPERSEDED | 20/10/0/0 | 43891bdd98 | ✨ feat(flows): each alarm logs its duration, journal entries, write tr | packages/smithers/flows/database/src/DatabaseMetrics.ts: main carried then changed it: f37 |
| 2026-10-22 03:48 | `5570be08d6` | SUPERSEDED | 50/8/0/0 | 43891bdd98 | 🐛 fix(mvp): cancel dropped TODO runs durably | apps/mvp/docs/features/todos.md: main carried then changed it: a412e0d5e8 (🐛 fix(mvp): a d |
| 2026-10-22 03:48 | `ee7e51c5e0` | SUPERSEDED | 5/1/0/0 | 43891bdd98 | 🐛 fix(platform-cloudflare): bound admission alarm delays | packages/smithers/flows/platform-cloudflare/test/AdmissionLatency.test.ts: main carried th |
| 2026-10-22 03:48 | `4ab3de692d` | SUPERSEDED | 9/7/0/0 | 43891bdd98 | 🔎 feat(flows): correlate remote run admission timing | apps/mvp/docs/work/todo-run-start.md: main carried then changed it: 719b30408c (🐛 fix(mvp) |
| 2026-10-22 03:48 | `fc717a49c9` | SUPERSEDED | 20/10/0/0 | efc4391769 | ✨ feat(flows): each alarm logs its duration, journal entries, write tr | packages/smithers/flows/database/src/DatabaseMetrics.ts: main carried then changed it: f37 |
| 2026-10-22 03:48 | `d8d13a5c20` | SUPERSEDED | 50/8/0/0 | efc4391769 | 🐛 fix(mvp): cancel dropped TODO runs durably | apps/mvp/docs/features/todos.md: main carried then changed it: a412e0d5e8 (🐛 fix(mvp): a d |
| 2026-10-22 03:48 | `30c8a01879` | SUPERSEDED | 5/1/0/0 | efc4391769 | 🐛 fix(platform-cloudflare): bound admission alarm delays | packages/smithers/flows/platform-cloudflare/test/AdmissionLatency.test.ts: main carried th |
| 2026-10-22 03:48 | `af757f5a92` | SUPERSEDED | 9/7/0/0 | efc4391769 | 🔎 feat(flows): correlate remote run admission timing | apps/mvp/docs/work/todo-run-start.md: main carried then changed it: 719b30408c (🐛 fix(mvp) |
| 2026-10-22 03:48 | `6049829e5f` | PARTIAL | 18/14/1/0 | d716562442 | ✨ feat(flows): each alarm logs its duration, journal entries, write tr | packages/smithers/flows/database/docs/api.md: \| `@smthrs/database/DatabaseMetrics` |
| 2026-10-22 03:48 | `75697adbfb` | PARTIAL | 44/11/18/0 | d716562442 | 🐛 fix(mvp): cancel dropped TODO runs durably | apps/site/public/llms-full.txt: \| `Driven`                \| `{ _tag: "Settled"; status } |
| 2026-10-22 03:48 | `3544a544e9` | SUPERSEDED | 5/1/0/0 | d716562442 | 🐛 fix(platform-cloudflare): bound admission alarm delays | packages/smithers/flows/platform-cloudflare/test/AdmissionLatency.test.ts: main carried th |
| 2026-10-22 03:48 | `23ef86e088` | SUPERSEDED | 10/7/0/0 | d716562442 | 🔎 feat(flows): correlate remote run admission timing | apps/mvp/docs/work/todo-run-start.md: main carried then changed it: 719b30408c (🐛 fix(mvp) |
| 2026-10-22 03:48 | `441e4c4c7d` | PARTIAL | 19/12/2/0 | 5a0fb2b622 | ✨ feat(flows): each alarm logs its duration, journal entries, write tr | packages/smithers/flows/database/docs/api.md: \| `@smthrs/database/DatabaseMetrics` |
| 2026-10-22 03:48 | `3ce3deab2f` | PARTIAL | 47/8/18/0 | 5a0fb2b622 | 🐛 fix(mvp): cancel dropped TODO runs durably | apps/site/public/llms-full.txt: \| `Driver`                \| `Context.Service<{ admit, dr |
| 2026-10-22 03:48 | `7ad8ec7fdd` | SUPERSEDED | 5/1/0/0 | 5a0fb2b622 | 🐛 fix(platform-cloudflare): bound admission alarm delays | packages/smithers/flows/platform-cloudflare/test/AdmissionLatency.test.ts: main carried th |
| 2026-10-22 03:48 | `b52bb87e5a` | SUPERSEDED | 9/7/0/0 | 5a0fb2b622 | 🔎 feat(flows): correlate remote run admission timing | apps/mvp/docs/work/todo-run-start.md: main carried then changed it: 719b30408c (🐛 fix(mvp) |
| 2026-10-22 03:49 | `43891bdd98` | SUPERSEDED | 53/5/0/0 | 43891bdd98 | ⚡ perf(flows): a drive writes its node records in its other transactio | apps/site/src/content/docs/docs/reference/api/platform-cloudflare.mdx: main carried then c |
| 2026-10-22 03:49 | `1f0ed4c732` | SUPERSEDED | 118/10/0/0 | 43891bdd98 | ⚡ perf(flows): runs write their journals and engine state side by side | packages/smithers/flows/database/src/DatabaseMetrics.ts: main carried then changed it: 7db |
| 2026-10-22 03:49 | `efc4391769` | SUPERSEDED | 53/5/0/0 | efc4391769 | ⚡ perf(flows): a drive writes its node records in its other transactio | apps/site/src/content/docs/docs/reference/api/platform-cloudflare.mdx: main carried then c |
| 2026-10-22 03:49 | `97aa4b79cb` | SUPERSEDED | 118/10/0/0 | efc4391769 | ⚡ perf(flows): runs write their journals and engine state side by side | packages/smithers/flows/database/src/DatabaseMetrics.ts: main carried then changed it: 7db |
| 2026-10-22 03:49 | `d716562442` | PARTIAL | 57/8/6/2 | d716562442 | ⚡ perf(flows): a drive writes its node records in its other transactio | apps/site/public/llms-full.txt: \| `@smthrs/database/DatabaseMetrics`           \| the wri |
| 2026-10-22 03:49 | `4674ab621f` | PARTIAL | 114/13/2/1 | d716562442 | ⚡ perf(flows): runs write their journals and engine state side by side | packages/smithers/flows/database/docs/api.md: interface WriteOptions {; packages/smithers/ |
| 2026-10-22 03:49 | `5a0fb2b622` | PARTIAL | 62/7/6/2 | 5a0fb2b622 | ⚡ perf(flows): a drive writes its node records in its other transactio | apps/site/public/llms-full.txt: \| `@smthrs/database/DatabaseMetrics`           \| the wri |
| 2026-10-22 03:49 | `64266eb489` | ON-MAIN | 9/0/0/0 | 64266eb489 | 🐛 fix(mvp): an answer's text streams only when nothing can make it unt |  |
| 2026-10-22 03:49 | `ef79f62954` | PARTIAL | 115/10/3/1 | 5a0fb2b622 | ⚡ perf(flows): runs write their journals and engine state side by side | packages/smithers/flows/database/docs/api.md: interface WriteOptions {; packages/smithers/ |
| 2026-10-22 03:54 | `30107a6b8d` | SUPERSEDED | 0/1/0/0 | 30107a6b8d | ✅ test(mvp): the ownerless offline activation proves its verified reop | apps/mvp/e2e/sign-in.spec.ts: main carried then changed it: b590c19559 (🐛 fix(mvp): adopt |
| 2026-10-22 03:55 | `ce3d049ead` | ON-MAIN | 19/0/0/0 | ce3d049ead | 🐛 fix(harness): preserve context and classify answer and tool output c |  |
| 2026-10-22 03:56 | `b3bd0d65ae` | ON-MAIN | 24/0/0/0 | b3bd0d65ae | 🐛 fix(harness): preserve safe recovery and accurate turn evidence |  |
| 2026-10-22 04:04 | `08cb0cd99d` | ON-MAIN | 2/0/0/0 | 08cb0cd99d | 📝 docs(mvp): work notes for VibeLang's journeys and View as |  |
| 2026-10-22 04:04 | `b238afaac2` | ON-MAIN | 2/0/0/0 | b238afaac2 | 📝 docs(mvp): work notes for VibeLang's journeys and View as |  |
| 2026-10-22 04:04 | `6b2971b10f` | ON-MAIN | 2/0/0/0 | 6b2971b10f | 📝 docs(mvp): work notes for VibeLang's journeys and View as |  |
| 2026-10-22 04:09 | `08a6d9a301` | PARTIAL | 41/7/2/0 | 2fa3be8d79 | 🐛 fix(mvp): a session check ChatApi couldn't answer asks again, as the | apps/mvp/docs/features/flows.md: The execution id is minted once per dispatch unless the c |
| 2026-10-22 04:09 | `f6d7f8dccf` | PARTIAL | 41/6/3/0 | 37c4036a58 | 🐛 fix(mvp): a session check ChatApi couldn't answer asks again, as the | apps/mvp/docs/features/flows.md: The execution id is minted once per dispatch unless the c |
| 2026-10-22 04:10 | `2fa3be8d79` | SUPERSEDED | 70/5/0/0 | 2fa3be8d79 | 🐛 fix(mvp): a tab on a visitor's data takes the person who signs in in | apps/mvp/e2e/devices.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): guide firs |
| 2026-10-22 04:10 | `37c4036a58` | PARTIAL | 68/5/2/0 | 37c4036a58 | 🐛 fix(mvp): a tab on a visitor's data takes the person who signs in in | apps/mvp/src/test/e2e.ts: import { AuthFaults, EngineFaults, type QuestionFault, QuestionF |
| 2026-10-22 04:10 | `7857e3979f` | ON-MAIN | 29/0/0/0 | a607670a74 | 🐛 fix(cli): retain redacted unexpected failure diagnostics |  |
| 2026-10-22 04:10 | `547cc3c09b` | SUPERSEDED | 18/1/0/0 | 547cc3c09b | 🐛 fix(backend): redact output, bound events, and recover host locks | apps/mvp/docs/decisions/0035-cli-host-service-lock.md: main deleted it in 36c889e07b (🐛 fi |
| 2026-10-22 04:12 | `7f10d336f0` | PARTIAL | 1/1/0/1 | c16cc6d534 | 📝 docs: API baseline for @smthrs/database's writer-lock timeout, pool- | .smithers/flows/release/fixtures/public-api-baseline.json: "ExecutionObject.d.ts": "dbdb13 |
| 2026-10-22 04:12 | `8932edec48` | PARTIAL | 0/0/2/1 | 0a442931c6 | 📝 docs: API baseline for @smthrs/database's writer-lock timeout, pool  | .smithers/flows/release/fixtures/public-api-baseline.json: "DatabaseMetrics.d.ts": "7cd5cb |
| 2026-10-22 04:14 | `92b6334c4d` | SUPERSEDED | 18/9/0/0 | ca3ccee5d9 | ✨ feat(ci): dispatch repository flows from GitHub push and pull reques | apps/mvp/docs/features/ci.md: main carried then changed it: cf1dbc8019 (🧪 test(mvp): run p |
| 2026-10-22 04:14 | `0b38317452` | SUPERSEDED | 17/10/0/0 | a4b7a02775 | ✨ feat(ci): dispatch repository flows from GitHub push and pull reques | apps/mvp/docs/features/ci.md: main carried then changed it: cf1dbc8019 (🧪 test(mvp): run p |
| 2026-10-22 04:14 | `70805a5f75` | SUPERSEDED | 16/10/0/0 | 67917e16d7 | ✨ feat(ci): GitHub's pushes and pull requests start a repository's flo | apps/mvp/docs/features/ci.md: main carried then changed it: cf1dbc8019 (🧪 test(mvp): run p |
| 2026-10-22 04:15 | `9b95aa1333` | SUPERSEDED | 22/5/0/0 | 7732ee9482 | ✨ feat(sandbox): SandboxCommand, a command that outlives any host as a | apps/site/public/llms-full.txt: main carried then changed it: 3e1eb154a6 (📝 docs: regenera |
| 2026-10-22 04:17 | `c16cc6d534` | ON-MAIN | 3/0/0/0 | c16cc6d534 | 📝 docs(mvp): production's measurement of execution objects placed besi |  |
| 2026-10-22 04:17 | `4e3a19a298` | ON-MAIN | 3/0/0/0 | 0a442931c6 | 📝 docs(mvp): production's measurement of execution objects placed besi |  |
| 2026-10-22 04:20 | `6243124341` | PARTIAL | 3/0/9/2 | 6243124341 | 🐛 fix(sdk): a new browser leader resumes a reload's cut-off runs two a | .changeset/browser-resume-admission.md: `BrowserRuntime.run` option, 2 by default), in the |
| 2026-10-22 04:22 | `953d45f238` | ON-MAIN | 2/0/0/0 | 953d45f238 | 🧪 test(mvp): the branch terminal reads the forge's branch, and the lif |  |
| 2026-10-22 04:23 | `cbbe63ed43` | ON-MAIN | 3/0/0/0 | cbbe63ed43 | 🧪 test(mvp): a tab is ready once its route finished loading, and live  |  |
| 2026-10-22 04:25 | `7732ee9482` | SUPERSEDED | 62/9/0/0 | 7732ee9482 | 🐛 fix(mvp): a sandbox command runs as its own sandbox/Command job, so  | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: c7db35ddd3 (🐛 fix(m |
| 2026-10-22 04:35 | `221246266e` | ON-MAIN | 6/0/0/0 | ca3ccee5d9 | 📝 docs(ci): regenerate sandbox API reference and llms text |  |
| 2026-10-22 04:35 | `f38e08743d` | ON-MAIN | 6/0/0/0 | a4b7a02775 | 📝 docs(ci): regenerate sandbox API reference and llms text |  |
| 2026-10-22 04:35 | `31e8e9eacc` | ON-MAIN | 6/0/0/0 | 67917e16d7 | 📝 docs: regenerated site reference and llms text for @smthrs/sandbox's |  |
| 2026-10-22 04:42 | `a353d38e34` | SUPERSEDED | 10/3/0/0 | 820c3b9ab4 | 🐛 fix(platform-browser): a run a tab starts after a reload goes ahead  | packages/smithers/flows/platform-browser/docs/testing.md: main carried then changed it: c7 |
| 2026-10-22 04:42 | `3ef0c7a1f5` | SUPERSEDED | 30/3/0/0 | 820c3b9ab4 | ✨ feat(engine-store): resumed runs wait their turn; a run someone star | packages/smithers/flows/engine-store/docs/api.md: main carried then changed it: 541e823190 |
| 2026-10-22 04:53 | `13182e1705` | SUPERSEDED | 57/17/0/0 | 13182e1705 | 🐛 fix(mvp): recover conversations and gate admin shape access | apps/mvp/docs/features/spend-alerts.md: main carried then changed it: ab8b7edba8 (🐛 fix(mv |
| 2026-10-22 04:53 | `4b7f1271b7` | SUPERSEDED | 30/2/0/0 | 13182e1705 | 🐛 fix(sync): certify installed shape recovery and preserve cancellatio | packages/effect-electric/docs/api.md: main carried then changed it: 16637103d4 (⚡ perf(mvp |
| 2026-10-22 06:05 | `820c3b9ab4` | SUPERSEDED | 2/1/0/0 | 820c3b9ab4 | 📝 docs: regenerated site reference for the engine's resume lane | apps/site/src/content/docs/docs/reference/api/engine-store.mdx: main carried then changed |
| 2026-10-22 06:41 | `875a96f04d` | SUPERSEDED | 4/6/0/0 | 875a96f04d | 🐛 fix(mvp): SUMMARY_MODEL is read when ChatApi builds, so the deploy b | apps/mvp/docs/features/model-endpoint.md: main carried then changed it: 1932fd57c6 (✨ feat |
| 2026-10-22 06:43 | `78b7841598` | SUPERSEDED | 4/1/0/0 | 24337be84e | ✅ test(mvp): e2e for a ten-minute command on the branch's machine, run | apps/mvp/src/test/scriptedAgent.ts: main carried then changed it: 0549b2ea8e (✨ feat(mvp): |
| 2026-10-22 06:43 | `ef9a510ae2` | SUPERSEDED | 4/1/0/0 | 3a43ea31fa | ✅ test(mvp): e2e for a ten-minute command on the branch's machine, run | apps/mvp/src/test/scriptedAgent.ts: landed as ec5a1f2e37 (same author and time, committed |
| 2026-10-22 06:43 | `403d17274d` | ON-MAIN | 38/0/0/0 | 403d17274d | 🐛 fix(model): secure endpoints and preserve evaluation accounting |  |
| 2026-10-22 06:43 | `31b691f900` | ON-MAIN | 22/0/0/0 | 31b691f900 | 🐛 fix(rpc): redact errors, preserve state keys and validate answers an |  |
| 2026-10-22 07:07 | `c14cea2606` | ON-MAIN | 4/0/0/0 | c14cea2606 | 🧪 test(mvp): a new device's branch conversation shows within 3 s of th |  |
| 2026-10-22 07:07 | `84ee843130` | SUPERSEDED | 2/7/0/0 | c14cea2606 | 🐛 fix(mvp): Electric keeps running between visits, so a first visit af | apps/mvp/docs/infrastructure.md: main carried then changed it: f08cbaeefd (⚡ fix(mvp): hol |
| 2026-10-22 07:09 | `dd4e291db0` | SUPERSEDED | 1/2/0/0 | dd4e291db0 | 🐛 fix(mvp): preserve host home paths in the machine test fixture | apps/mvp/worker/branch/Machine.test.ts: main carried then changed it: 854647988f (🐛 fix(mv |
| 2026-10-22 07:26 | `693704369d` | SUPERSEDED | 3/1/0/0 | 2b7b365b7d | 🐛 fix(repo-targets): register the reviewed WireTrace export | packages/repo-targets/contracts/public-export-maps.test.mjs: main carried then changed it: |
| 2026-10-22 07:28 | `2b7b365b7d` | ON-MAIN | 3/0/0/0 | 2b7b365b7d | 🐛 fix(cli): discover relocated shipped suites in a consumer fixture |  |
| 2026-10-22 07:31 | `5662201860` | SUPERSEDED | 8/15/0/0 | 24337be84e | ✨ feat(mvp): a pull request's check scripts run as sandbox/Command job | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: b8a9ee0cec (🐛 fix(m |
| 2026-10-22 07:31 | `2a9ff73780` | SUPERSEDED | 16/5/0/0 | 24337be84e | 🐛 fix(mvp): a command's start answers under alchemy dev: execs pipe no | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: 8800f22acb (🔒 feat( |
| 2026-10-22 07:31 | `82303c5ab1` | SUPERSEDED | 6/4/0/0 | 24337be84e | 🐛 fix(sandbox): the command scripts' review fixes: START waits by the  | packages/smithers/flows/sandbox/docs/api.md: main carried then changed it: 52f15934d5 (✨ f |
| 2026-10-22 07:31 | `fd5ef9d55f` | SUPERSEDED | 8/15/0/0 | 3a43ea31fa | ✨ feat(mvp): a pull request's check scripts run as sandbox/Command job | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: b8a9ee0cec (🐛 fix(m |
| 2026-10-22 07:31 | `c44cd11edb` | SUPERSEDED | 16/5/0/0 | 3a43ea31fa | 🐛 fix(mvp): a command's start answers under alchemy dev: execs pipe no | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: 8800f22acb (🔒 feat( |
| 2026-10-22 07:31 | `d19dd54ecb` | SUPERSEDED | 6/4/0/0 | 3a43ea31fa | 🐛 fix(sandbox): the command scripts' review fixes: START waits by the  | packages/smithers/flows/sandbox/docs/api.md: main carried then changed it: 52f15934d5 (✨ f |
| 2026-10-22 07:34 | `3374b45efa` | PARTIAL | 10/8/0/3 | 11af05aba7 | fix(mvp): hold TODOs behind failed or closed predecessors | apps/mvp/docs/work/todo-stack-hold.md: owner: Codex todo-stack-hold; apps/mvp/worker/flows |
| 2026-10-22 07:38 | `11af05aba7` | PARTIAL | 35/1/1/1 | 11af05aba7 | fix(mvp): wake TODO merge waits from durable webhook signals | apps/mvp/docs/work/todo-stack-hold.md: status: complete; apps/mvp/worker/stack/Stack.ts: C |
| 2026-10-22 07:50 | `0a3545ebee` | SUPERSEDED | 39/4/0/0 | 0a3545ebee | 🐛 fix(mvp): restore queued branch conversations after offline reload | apps/mvp/src/features/branch/actions.ts: main carried then changed it: 124fdc7e00 (🔍 chore |
| 2026-10-22 07:50 | `a2b862d154` | ON-MAIN | 3/0/0/0 | a2b862d154 | 🧪 test(mvp): distinguish repository refusal from connection status |  |
| 2026-10-22 07:54 | `2ebb0a730e` | SUPERSEDED | 55/33/0/0 | 2ebb0a730e | fix(mvp): retry failed TODOs in place | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-22 07:54 | `54653a8305` | SUPERSEDED | 55/33/0/0 | cbd021c4c2 | fix(mvp): retry failed TODOs in place | apps/mvp/db/Database.ts: landed as 013522aa9e (same author and time, committed later) |
| 2026-10-22 07:54 | `e61fff0891` | SUPERSEDED | 49/35/0/0 | e61fff0891 | fix(mvp): retry failed TODOs in place | apps/mvp/db/Database.ts: landed as 013522aa9e (same author and time, committed later) |
| 2026-10-22 07:57 | `10020f7d72` | ON-MAIN | 4/0/0/0 | db2e3e783b | fix(cli): render discovery warnings as plain public data |  |
| 2026-10-22 07:58 | `c9d2ade518` | ON-MAIN | 9/0/0/0 | c9d2ade518 | 🧪 test(mvp): wait for branch composer controls after navigation |  |
| 2026-10-22 08:18 | `47f1d1ffea` | PARTIAL | 73/25/0/1 | 47f1d1ffea | ✨ feat(mvp): your conversations: /new starts one on a new branch, Arch | apps/mvp/db/migrations/0043_conversation_people.ts: person_id text NOT NULL,; apps/mvp/db/ |
| 2026-10-22 08:20 | `ca3ccee5d9` | SUPERSEDED | 118/55/0/0 | ca3ccee5d9 | ✨ feat(mvp): watch repository CI runs with Stop and restrict rollout | apps/mvp/AGENTS.md: main carried then changed it: da8b72a5b7 (📝 docs(mvp): repository feed |
| 2026-10-22 08:20 | `a4b7a02775` | PARTIAL | 106/50/1/1 | a4b7a02775 | ✨ feat(mvp): watch repository CI runs on Cloudflare with Stop | apps/mvp/src/device/migrations.test.ts: [FileTabsStore, { key: "a/b@main:README.md", owner |
| 2026-10-22 08:20 | `a3c129e82f` | SUPERSEDED | 81/46/0/0 | 67917e16d7 | ✨ feat(mvp): a repository's runs at /$owner/$repo/actions, watched liv | apps/mvp/AGENTS.md: landed as 120aa96554 (same author and time, committed later) |
| 2026-10-22 08:28 | `7815f22e1b` | ON-MAIN | 4/0/0/0 | db2e3e783b | test(cli): update terminal, authority and durable fault fixtures |  |
| 2026-10-22 08:35 | `670fc3048e` | ON-MAIN | 3/0/0/0 | db2e3e783b | fix(cli): mount canonical MCP commands while preserving direct help an |  |
| 2026-10-22 08:35 | `d46e9c61ce` | ON-MAIN | 6/0/0/0 | db2e3e783b | test(cli): assert diagnostic receipts introduced by 4fe3f0724117 |  |
| 2026-10-22 08:35 | `7954e383f1` | ON-MAIN | 2/0/0/0 | db2e3e783b | fix(cli): preserve cancellation while recording terminal ordering gaps |  |
| 2026-10-22 08:40 | `ce2cd3552f` | ON-MAIN | 14/0/0/0 | db2e3e783b | fix(cli): order terminal evidence through detached children, rewinds a |  |
| 2026-10-22 08:40 | `b2a429b70e` | ON-MAIN | 11/0/0/0 | db2e3e783b | test(cli): scope application and recovery evidence apart from health d |  |
| 2026-10-22 08:40 | `de63de8643` | ON-MAIN | 1/0/0/0 | db2e3e783b | test(cli): discover pinned sources under the 7f0e0cd5aa37 flow directo |  |
| 2026-10-22 08:40 | `71ec3d88f9` | ON-MAIN | 3/0/0/0 | db2e3e783b | test(cli): honor fail-closed budget discovery from 35b985a420a1 |  |
| 2026-10-22 08:40 | `c92a25da6e` | ON-MAIN | 1/0/0/0 | db2e3e783b | fix(cli): restrict its existing private state directory |  |
| 2026-10-22 08:48 | `d310028b03` | ON-MAIN | 2/0/0/0 | 24337be84e | 📝 docs(mvp): the sandbox command job works in production |  |
| 2026-10-22 08:48 | `c21e9eb868` | ON-MAIN | 2/0/0/0 | 3a43ea31fa | 📝 docs(mvp): the sandbox command job works in production |  |
| 2026-10-22 09:01 | `bbd3416745` | SUPERSEDED | 14/2/0/0 | bb8846cec1 | 🐛 fix(mvp): the TODO agent checks only what it changed, paces itself a | apps/mvp/docs/features/todos.md: main carried then changed it: 5772fdbffb (🐛 fix(mvp): a T |
| 2026-10-22 09:01 | `93a4c53066` | ON-MAIN | 20/0/0/0 | bb8846cec1 | ✨ feat(agent): an agent with a deadline sees how long it has left |  |
| 2026-10-22 09:01 | `a4a78e48bc` | SUPERSEDED | 15/1/0/0 | 15098441d5 | 🐛 fix(mvp): the TODO agent checks only what it changed, paces itself a | apps/mvp/docs/features/todos.md: main carried then changed it: 5772fdbffb (🐛 fix(mvp): a T |
| 2026-10-22 09:01 | `ae15c11d0a` | ON-MAIN | 20/0/0/0 | 15098441d5 | ✨ feat(agent): an agent with a deadline sees how long it has left |  |
| 2026-10-22 09:01 | `2bdf838be6` | SUPERSEDED | 14/2/0/0 | 2bdf838be6 | 🐛 fix(mvp): the TODO agent checks only what it changed, paces itself a | apps/mvp/docs/features/todos.md: main carried then changed it: 5772fdbffb (🐛 fix(mvp): a T |
| 2026-10-22 09:01 | `2174e71263` | ON-MAIN | 20/0/0/0 | 2bdf838be6 | ✨ feat(agent): an agent with a deadline sees how long it has left |  |
| 2026-10-22 09:02 | `8b6dd374bd` | SUPERSEDED | 14/1/0/0 | 7c3b4033ae | fix(mvp): reclaim device test databases after each suite | apps/mvp/docs/work/test-temp-leaks.md: main carried then changed it: 3e924b9538 (chore(tes |
| 2026-10-22 09:05 | `3c754b5c38` | ON-MAIN | 6/0/0/0 | db2e3e783b | fix(cli): allow isolated replay verification with parked siblings |  |
| 2026-10-22 09:06 | `102e43f7fd` | SUPERSEDED | 6/1/0/0 | 7c3b4033ae | fix(test): reclaim Vitest root SSR transforms through the run lifecycl | packages/repo-targets/test/TempCleanup.test.ts: main carried then changed it: c4eee0aba0 ( |
| 2026-10-22 09:07 | `7409bc9c77` | ON-MAIN | 2/0/0/0 | db2e3e783b | test(cli): assert safe graph-planning diagnostics from c5f34c0eebc7 |  |
| 2026-10-22 09:07 | `a61858e80c` | ON-MAIN | 8/0/0/0 | db2e3e783b | test(cli): declare PostgreSQL needs for history integration cases |  |
| 2026-10-22 09:07 | `062ae75cd8` | SUPERSEDED | 0/1/0/0 | db2e3e783b | test(cli): require repository metadata for tracked-source assertions | packages/smithers/test/Project.test.ts: main carried then changed it: 49b0808124 (fix(cli) |
| 2026-10-22 09:07 | `bc78d545ab` | ON-MAIN | 3/0/0/0 | db2e3e783b | fix(cli): report detached admission limits as typed refusals |  |
| 2026-10-22 09:07 | `9271b26f27` | STRANDED | 0/0/1/0 | db2e3e783b | test(cli): stop listing retired root suites after 595b6abcbc6c | packages/smithers/test/EvaluationCli.test.ts: it("does not discover the retired repository |
| 2026-10-22 09:07 | `477d20eb49` | SUPERSEDED | 4/1/0/0 | db2e3e783b | docs(cli): align public exports, host peers and flow paths | packages/smithers/README.md: main carried then changed it: 9662836059 (🐛 fix: land W13 bro |
| 2026-10-22 09:07 | `ebfe685103` | ON-MAIN | 1/0/0/0 | db2e3e783b | test(cli): assert atomic assignee additions from 99846c61cd8a |  |
| 2026-10-22 09:07 | `b967a0e5e3` | ON-MAIN | 2/0/0/0 | db2e3e783b | test(cli): honor explicit API-key selection from a8f8b32afd0b |  |
| 2026-10-22 09:07 | `188f49ac77` | ON-MAIN | 1/0/0/0 | db2e3e783b | test(cli): follow MCP overview help routing from 03233c3f34ad |  |
| 2026-10-22 09:07 | `05fdbf442a` | ON-MAIN | 3/0/0/0 | db2e3e783b | test(cli): retain local coding discovery added by 9fe1217cdeb9 |  |
| 2026-10-22 09:07 | `f624e39c5d` | ON-MAIN | 3/0/0/0 | db2e3e783b | test(cli): retain only callable relevance candidates after ba537ddc570 |  |
| 2026-10-22 09:08 | `e33008c424` | SUPERSEDED | 13/2/0/0 | 7c3b4033ae | fix(mvp): keep media scratch under e2e output and finalize it | apps/mvp/e2e/gifs.mjs: main carried then changed it: 610fa41db4 (🐛 fix(mvp): a skipped e2e |
| 2026-10-22 09:08 | `94d4f6f1c9` | SUPERSEDED | 2/1/0/0 | 7c3b4033ae | fix(engine-store): scope cycle race database directory | packages/smithers/flows/engine-store/test/CycleDetectionSql.test.ts: main carried then cha |
| 2026-10-22 09:08 | `9628ad085e` | SUPERSEDED | 2/12/0/0 | 7c3b4033ae | fix(engine-store): scope production plan fixture directories | packages/smithers/flows/engine-store/test/PlanSchedulerProduction.test.ts: main carried th |
| 2026-10-22 09:08 | `95005e59c8` | SUPERSEDED | 2/2/0/0 | 7c3b4033ae | fix(engine-store): scope restore drill test directories | packages/smithers/flows/engine-store/test/RestoreDrill.test.ts: main carried then changed |
| 2026-10-22 09:08 | `be7845efe5` | SUPERSEDED | 4/28/0/0 | 7c3b4033ae | fix(engine-store): scope disaster recovery test scratch directories | packages/smithers/flows/engine-store/test/DisasterRecovery.test.ts: main carried then chan |
| 2026-10-22 09:09 | `1496ed356d` | ON-MAIN | 3/0/0/0 | db2e3e783b | fix(cli): enumerate startup tool bindings without repository authority |  |
| 2026-10-22 09:09 | `0074092d66` | ON-MAIN | 1/0/0/0 | db2e3e783b | test(cli): distinguish lifecycle observations from advancing journal r |  |
| 2026-10-22 09:10 | `e56b4c1611` | SUPERSEDED | 5/62/0/0 | 7c3b4033ae | fix(test): finalize per-process coverage scratch reports | apps/mvp/vitest.config.ts: changed later in its stack (head 7c3b4033ae) |
| 2026-10-22 09:11 | `e74b0d3d03` | SUPERSEDED | 96/22/0/0 | e74b0d3d03 | ✨ feat(mvp): issues and TODOs on any repository the App is installed o | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-22 09:11 | `28f1f4002d` | SUPERSEDED | 9/1/0/0 | e74b0d3d03 | ✨ feat(integrations): Collaborators.permission answers the account's i | packages/smithers/agent/integrations/test/Collaborators.test.ts: main carried then changed |
| 2026-10-22 09:11 | `e5760e837c` | PARTIAL | 68/40/0/2 | e5760e837c | ✨ feat(mvp): issues and TODOs on any repository the App is installed o | apps/mvp/db/migrations/0043_github_repo_roles.ts: // A person's role on a repository other |
| 2026-10-22 09:11 | `2b3a236815` | SUPERSEDED | 9/1/0/0 | e5760e837c | ✨ feat(integrations): Collaborators.permission answers the account's i | packages/smithers/agent/integrations/test/Collaborators.test.ts: main carried then changed |
| 2026-10-22 09:11 | `d434da1a42` | ON-MAIN | 3/0/0/0 | db2e3e783b | test(cli): discover authoring metadata with the host layer from 54e0ca |  |
| 2026-10-22 09:13 | `6ae6f9c738` | SUPERSEDED | 102/22/0/0 | 7c3b4033ae | fix(test): scope subprocess temporary files and compiler caches | apps/mvp/src/test/chatApi.ts: main carried then changed it: c703fada76 (✨ feat(mvp): a rep |
| 2026-10-22 09:15 | `ff56e964e6` | ON-MAIN | 4/0/0/0 | 7c3b4033ae | fix(engine-store): scope run catalog catch-up databases |  |
| 2026-10-22 09:19 | `28dc82c29f` | ON-MAIN | 4/0/0/0 | db2e3e783b | test(cli): separate health status observations from peer execution evi |  |
| 2026-10-22 09:19 | `0338e7c2e0` | ON-MAIN | 5/0/0/0 | db2e3e783b | test(cli): drive cleanup after observing cancellation from ba5cfef1781 |  |
| 2026-10-22 09:19 | `26048e3942` | ON-MAIN | 1/0/0/0 | db2e3e783b | test(cli): request human gateway progress after 538b5500d413 |  |
| 2026-10-22 09:19 | `77b1572de1` | ON-MAIN | 1/0/0/0 | db2e3e783b | test(cli): preserve the runner Node warning policy in clean TUI enviro |  |
| 2026-10-22 09:19 | `267e35c807` | ON-MAIN | 3/0/0/0 | db2e3e783b | test(cli): await the complete operator token file added by 08881fc8cb5 |  |
| 2026-10-22 09:26 | `0767cd78dd` | ON-MAIN | 11/0/0/0 | 7c3b4033ae | fix(cli-tests): preserve owned scratch in isolated child environments |  |
| 2026-10-22 09:26 | `28480d1815` | ON-MAIN | 6/0/0/0 | 7c3b4033ae | fix(database): keep matrix scratch and merged coverage in owned direct |  |
| 2026-10-22 09:29 | `f68301ef2d` | ON-MAIN | 6/0/0/0 | db2e3e783b | fix(cli): recognize current project metadata and provide exact source  |  |
| 2026-10-22 09:34 | `7b63dc116a` | ON-MAIN | 6/0/0/0 | 7c3b4033ae | fix(cli-tests): scope shard scratch, merged reports and blob directori |  |
| 2026-10-22 09:48 | `011a999965` | ON-MAIN | 2/0/0/0 | db2e3e783b | test(cli): run the full API type contract outside the instrumented wor |  |
| 2026-10-22 09:49 | `aececc473c` | SUPERSEDED | 70/5/0/0 | e84c047471 | 🐛 fix(mvp): adopt visitor data in place without widening queued author | apps/mvp/e2e/devices.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): guide firs |
| 2026-10-22 09:49 | `cf5a9aaf54` | PARTIAL | 42/7/1/0 | e84c047471 | 🐛 fix(mvp): recover unavailable sessions through durable auth refresh | apps/mvp/src/flows/registrations.ts: * Every client flow, registered with its steps: sign- |
| 2026-10-22 09:49 | `bdce2fc577` | SUPERSEDED | 70/5/0/0 | 3436383373 | fix(mvp): adopt visitor data in place without widening queued authorit | apps/mvp/e2e/devices.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): guide firs |
| 2026-10-22 09:49 | `36f26a1294` | PARTIAL | 41/7/2/0 | 3436383373 | fix(mvp): recover unavailable sessions through durable auth refresh | apps/mvp/docs/features/flows.md: The execution id is minted once per dispatch unless the c |
| 2026-10-22 09:50 | `e84c047471` | PARTIAL | 8/1/0/2 | e84c047471 | 🐛 fix(electric): isolate replay caches for simulated browser realms | .changeset/electric-cache-realms.md: Allow a ShapeSource cache namespace so independent ho |
| 2026-10-22 09:50 | `3436383373` | PARTIAL | 8/1/0/2 | 3436383373 | fix(electric): isolate replay caches for simulated browser realms | .changeset/electric-cache-realms.md: Allow a ShapeSource cache namespace so independent ho |
| 2026-10-22 10:02 | `10814a5fe4` | PARTIAL | 7/4/4/0 | 67917e16d7 | 🔀 base: the CI spine (builder/ci-spine) under this stack; not for land | apps/mvp/worker/Executions.ts: ), BranchSandboxes.machinesLayer(sandboxObjects, keep)); ap |
| 2026-10-22 10:10 | `8434a5a995` | ON-MAIN | 6/0/0/0 | db2e3e783b | fix(cli): refuse malformed backend JSON without retaining response exc |  |
| 2026-10-22 10:21 | `5015eb4cad` | ON-MAIN | 9/0/0/0 | 97b04fc0f6 | 🐛 fix(electric): retain refused shape sources and cache isolation |  |
| 2026-10-22 10:21 | `8bb66133f1` | SUPERSEDED | 8/3/0/0 | 97b04fc0f6 | 🐛 fix(electric): isolate replay caches for simulated browser realms | .changeset/electric-cache-realms.md: changed later in its stack (head 97b04fc0f6) |
| 2026-10-22 10:21 | `452029ae37` | SUPERSEDED | 70/5/0/0 | 97b04fc0f6 | 🐛 fix(mvp): adopt visitor data in place without widening queued author | apps/mvp/e2e/devices.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): guide firs |
| 2026-10-22 10:21 | `97ad83d745` | PARTIAL | 42/7/1/0 | 97b04fc0f6 | 🐛 fix(mvp): recover unavailable sessions through durable auth refresh | apps/mvp/src/flows/registrations.ts: * Every client flow, registered with its steps: sign- |
| 2026-10-22 10:21 | `03006756e8` | ON-MAIN | 9/0/0/0 | ae3d1d4e90 | 🐛 fix(electric): retain refused shape sources and cache isolation |  |
| 2026-10-22 10:21 | `6bdc0af68f` | SUPERSEDED | 8/3/0/0 | ae3d1d4e90 | 🐛 fix(electric): isolate replay caches for simulated browser realms | .changeset/electric-cache-realms.md: changed later in its stack (head ae3d1d4e90) |
| 2026-10-22 10:21 | `7e0a04a6da` | SUPERSEDED | 70/5/0/0 | ae3d1d4e90 | 🐛 fix(mvp): adopt visitor data in place without widening queued author | apps/mvp/e2e/devices.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): guide firs |
| 2026-10-22 10:21 | `970601b84e` | PARTIAL | 42/7/1/0 | ae3d1d4e90 | 🐛 fix(mvp): recover unavailable sessions through durable auth refresh | apps/mvp/src/flows/registrations.ts: * Every client flow, registered with its steps: sign- |
| 2026-10-22 10:21 | `81490bf80b` | ON-MAIN | 9/0/0/0 | 81490bf80b | 🐛 fix(electric): retain refused shape sources and cache isolation |  |
| 2026-10-22 10:21 | `276619f691` | SUPERSEDED | 8/3/0/0 | 81490bf80b | 🐛 fix(electric): isolate replay caches for simulated browser realms | .changeset/electric-cache-realms.md: changed later in its stack (head 81490bf80b) |
| 2026-10-22 10:21 | `ffb4782d20` | SUPERSEDED | 70/5/0/0 | 81490bf80b | 🐛 fix(mvp): adopt visitor data in place without widening queued author | apps/mvp/e2e/devices.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): guide firs |
| 2026-10-22 10:21 | `11bd3668a3` | PARTIAL | 42/7/1/0 | 81490bf80b | 🐛 fix(mvp): recover unavailable sessions through durable auth refresh | apps/mvp/src/flows/registrations.ts: * Every client flow, registered with its steps: sign- |
| 2026-10-22 10:29 | `9d745cc0e3` | SUPERSEDED | 20/1/0/0 | 24337be84e | ✨ feat(sandbox): a SandboxCommand job runs commands of up to an hour | packages/smithers/flows/sandbox/test/SandboxCommand.test.ts: main carried then changed it: |
| 2026-10-22 10:29 | `120c18ac78` | SUPERSEDED | 20/1/0/0 | 3a43ea31fa | ✨ feat(sandbox): a SandboxCommand job runs commands of up to an hour | packages/smithers/flows/sandbox/test/SandboxCommand.test.ts: main carried then changed it: |
| 2026-10-22 10:30 | `a97b3e7fc2` | SUPERSEDED | 47/2/0/0 | 5fd8aa4174 | fix(mvp): wake TODO merge waits from durable webhook signals | apps/mvp/worker/ExecutionHost.ts: main carried then changed it: 120aa96554 (✨ feat(mvp): w |
| 2026-10-22 10:30 | `cbd021c4c2` | SUPERSEDED | 36/4/0/0 | cbd021c4c2 | fix(mvp): wake TODO merge waits from durable webhook signals | apps/mvp/docs/work/todo-stack-hold.md: landed as 890a410e19 (same author and time, committ |
| 2026-10-22 10:30 | `ef2190efdd` | SUPERSEDED | 13/9/0/0 | cbd021c4c2 | fix(mvp): hold TODOs behind failed or closed predecessors | apps/mvp/docs/decisions/0016-todos-and-the-stack.md: main carried then changed it: 2ba6a0f |
| 2026-10-22 10:32 | `dc49985ef9` | SUPERSEDED | 8/6/0/0 | 83b9d49672 | ✨ feat(integrations): GitHub.Once.merge merges once and finds the merg | apps/site/public/llms-full.txt: main carried then changed it: 4df6121e91 (🔧 chore: regener |
| 2026-10-22 10:32 | `fb85927862` | SUPERSEDED | 16/26/0/0 | 83b9d49672 | 🔒️ fix(mvp): a home counts a session's role only on the repository it  | apps/mvp/docs/features/home.md: main carried then changed it: cb736313eb (✨ feat(mvp): a r |
| 2026-10-22 10:32 | `eaebb12e61` | ON-MAIN | 1/0/0/0 | 83b9d49672 | 📝 docs(mvp): the GitHub write hardening design: the merge's base, a pe |  |
| 2026-10-22 10:32 | `8caad81ec8` | PARTIAL | 28/30/4/0 | 83b9d49672 | 🐛 fix(github): fence projections and preserve merge outcomes | apps/mvp/db/Database.ts: import githubProjectionFences from "./migrations/0045_github_proj |
| 2026-10-22 10:33 | `83b9d49672` | PARTIAL | 48/8/8/1 | 83b9d49672 | 🐛 fix(mvp): a merge rechecks the base branch's own head and merges onc | apps/mvp/db/Database.test.ts: expect((await on(through("0046"))).map(([id, name]) => `${id |
| 2026-10-22 10:33 | `9a9a7b4b0b` | PARTIAL | 36/5/5/0 | 83b9d49672 | 🐛 fix(mvp): a person's triage wins over the flow's whatever order the  | apps/mvp/db/Database.ts: import triageWriteClaims from "./migrations/0046_triage_write_cla |
| 2026-10-22 10:33 | `78dfa9994c` | SUPERSEDED | 0/1/0/0 | be9b41b545 | obs(engine-store): record flow registration recovery duration | packages/smithers/flows/engine-store/src/EngineStore.ts: main carried then changed it: 415 |
| 2026-10-22 10:34 | `3234e910b1` | SUPERSEDED | 13/4/0/0 | be9b41b545 | perf(engine-store): recover only the hosted intent flow during registr | packages/smithers/flows/engine-store/docs/hosted-registration.md: main carried then change |
| 2026-10-22 10:42 | `97b04fc0f6` | SUPERSEDED | 17/1/0/0 | 97b04fc0f6 | 🐛 fix(mvp): retain live session authority and relay lifecycle diagnost | apps/mvp/docs/features/spend-alerts.md: main carried then changed it: ab8b7edba8 (🐛 fix(mv |
| 2026-10-22 10:47 | `db2e3e783b` | ON-MAIN | 2/0/0/0 | db2e3e783b | docs: record CLI red-suite receipts and remaining final coverage valid |  |
| 2026-10-22 10:49 | `7e45ecad43` | SUPERSEDED | 14/1/0/0 | be9b41b545 | obs(database): distinguish longest writer acquisition from cumulative  | packages/smithers/flows/platform-cloudflare/docs/troubleshooting.md: main carried then cha |
| 2026-10-22 10:49 | `ae3d1d4e90` | SUPERSEDED | 0/1/0/0 | ae3d1d4e90 |  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: 8 |
| 2026-10-22 10:51 | `7c3b4033ae` | ON-MAIN | 1/0/0/0 | 7c3b4033ae | chore(test): refresh cleanup target inputs and validation receipts |  |
| 2026-10-22 11:05 | `1197725423` | SUPERSEDED | 11/1/0/0 | 1197725423 | fix(runtime): preserve host tracing context while timing construction  | packages/smithers/flows/test/Runtime.test.ts: landed as 240f220936 (same author and time, |
| 2026-10-22 11:05 | `be9b41b545` | PARTIAL | 8/4/4/0 | be9b41b545 | obs(runtime): time construction phases using the host telemetry log le | apps/mvp/docs/work/todo-production-start-latency.md: links: [engine-writer-lock.md, journa |
| 2026-10-22 11:19 | `272f7bdb9e` | SUPERSEDED | 27/20/0/0 | 24337be84e | ✨ feat(mvp): a command runs up to SANDBOX_COMMAND_MAX_SECONDS, an hour | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: b8a9ee0cec (🐛 fix(m |
| 2026-10-22 11:19 | `3a43ea31fa` | SUPERSEDED | 27/20/0/0 | 3a43ea31fa | ✨ feat(mvp): a command runs up to SANDBOX_COMMAND_MAX_SECONDS, an hour | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: b8a9ee0cec (🐛 fix(m |
| 2026-10-22 11:58 | `c150967dde` | ON-MAIN | 7/0/0/0 | c150967dde | fix(mvp): let crashed test engines refuse shutdown writes |  |
| 2026-10-22 11:59 | `67917e16d7` | STRANDED | 0/0/2/0 | 67917e16d7 | 📝 docs: regenerated site reference and llms text for CiJob's step log | apps/site/public/llms-full.txt: \| Name                    \| What it is |
| 2026-10-22 11:59 | `d8e24d5fbe` | PARTIAL | 3/0/112/15 | 67917e16d7 | ✨ feat(mvp): run a repository's flow by hand from its form, Retry and  | apps/mvp/docs/features/actions.md: DO alarm finds a repo/Run settled ─ settled ─▶ repo/Set |
| 2026-10-22 11:59 | `645410aad8` | PARTIAL | 0/0/7/4 | 67917e16d7 | ✨ feat(sandbox): a CI step's result keeps the end of its log | .changeset/ci-job-step-log.md: `CiJob`'s step result keeps the end of what its command pri |
| 2026-10-22 12:10 | `15098441d5` | SUPERSEDED | 2/1/0/0 | 15098441d5 | 📝 docs: regenerated site reference and API baseline for the hour-long  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: 6 |
| 2026-10-22 12:33 | `7e0ae698e6` | STRANDED | 0/0/17/0 | 7e0ae698e6 |  | apps/mvp/src/test/agent.ts: /** Kills the engine as a killed tab's dies (`Engine.crash` in |
| 2026-10-22 12:35 | `834bbeb9d4` | SUPERSEDED | 24/2/0/0 | 6b14785300 | 🐛 fix(mvp): a run past the deployment's limit is refused with the limi | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: e3a4a95b63 (✨ feat( |
| 2026-10-22 12:35 | `cda67bb823` | SUPERSEDED | 73/14/0/0 | 6b14785300 | ⚡ perf: a sandbox command answers the step that asked it in 0.1 s, not | apps/mvp/worker/ExecutionHost.ts: main carried then changed it: 2611507e89 (📈 feat(mvp): t |
| 2026-10-22 12:35 | `775dd2d7c7` | SUPERSEDED | 24/2/0/0 | 775dd2d7c7 | 🐛 fix(mvp): a run past the deployment's limit is refused with the limi | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: e3a4a95b63 (✨ feat( |
| 2026-10-22 12:35 | `3b45c91151` | PARTIAL | 70/14/4/3 | 775dd2d7c7 | ⚡ perf: a sandbox command answers the step that asked it in 0.1 s, not | .changeset/command-in-the-step.md: A sandbox command that exits at once answers the step t |
| 2026-10-22 12:35 | `384646b652` | SUPERSEDED | 11/1/0/0 | 384646b652 | 🐛 fix(harness): a sandbox command's call is not cut at its own timeout | apps/mvp/src/features/agent/agent.test.ts: main carried then changed it: 6509ca42cc (✨ fea |
| 2026-10-22 12:43 | `24337be84e` | PARTIAL | 0/0/17/2 | 24337be84e |  | .changeset/claim-log-owners.md: The `flow.run.claimed` log line names who took the run: `o |
| 2026-10-22 13:03 | `bb8846cec1` | ON-MAIN | 2/0/0/0 | bb8846cec1 | 🐛 fix(harness): the realm stack test finds the host overflowing inside |  |
| 2026-10-22 13:07 | `812520275c` | SUPERSEDED | 4/1/0/0 | 9128d43fe1 | fix(flows): keep the public barrel inventory complete and publishable | apps/mvp/docs/work/flows-reds.md: main carried then changed it: fe25ce0a8c (test(flows): c |
| 2026-10-22 13:08 | `1ea2bd5b45` | ON-MAIN | 2/0/0/0 | 9128d43fe1 | fix(flows): keep host registration logs out of the PID protocol |  |
| 2026-10-22 13:11 | `86b2416c9b` | ON-MAIN | 10/0/0/0 | 9128d43fe1 | fix(artifacts): tag lease ownership loss and heartbeat expiry |  |
| 2026-10-22 13:11 | `540b12159d` | ON-MAIN | 1/0/0/0 | 9128d43fe1 | test(flows): install retry cleanup before announcing the interruption  |  |
| 2026-10-22 13:13 | `4be043e4cc` | ON-MAIN | 8/0/0/0 | 9128d43fe1 | fix(sync): tag presence argument defects without changing their failur |  |
| 2026-10-22 13:15 | `9128d43fe1` | SUPERSEDED | 4/1/0/0 | 9128d43fe1 | test(flows): cover configured placement through hosted execution metri | packages/smithers/flows/test/Runtime.test.ts: main carried then changed it: 240f220936 (fi |
| 2026-10-22 14:37 | `0dd6a2cf26` | SUPERSEDED | 26/5/0/0 | 6b14785300 | ⚡ perf: a step waits on its command as long as its drive's budget allo | apps/mvp/docs/features/sandbox-tools.md: main carried then changed it: 2611507e89 (📈 feat( |
| 2026-10-22 14:40 | `0295b473f7` | ON-MAIN | 6/0/0/0 | 6b14785300 | ✨ feat(run-store): AttemptStore.listRun reads every attempt of a run i |  |
| 2026-10-22 14:40 | `0f5e96700e` | PARTIAL | 10/0/0/1 | 0f5e96700e |  | packages/smithers/flows/journal/src/SqlJournal.ts: const cached = state.sourceEvents.get(s |
| 2026-10-22 15:06 | `059197585e` | SUPERSEDED | 25/2/0/0 | 6b14785300 | 📈 feat(mvp): the step's wait on a command is a setting, and its time i | apps/mvp/worker/Executions.ts: main carried then changed it: 9156a26fbe (✨ feat(mvp): answ |
| 2026-10-22 15:11 | `8d87946a54` | SUPERSEDED | 39/2/0/0 | 6b14785300 | ⚡ perf(engine-store): a resumed run replays its recorded steps without | apps/site/src/content/docs/docs/reference/api/engine-store.mdx: main carried then changed |
| 2026-10-22 15:11 | `21a5cdc8ab` | ON-MAIN | 10/0/0/0 | 6b14785300 | ✨ feat(journal): recall and recorded answer a run's re-emissions witho |  |
| 2026-10-22 15:19 | `dcd35527d1` | ON-MAIN | 4/0/0/0 | dcd35527d1 | test(platform-node): expose cancellation failures and exercise shared  |  |
| 2026-10-22 15:29 | `50190558c7` | PARTIAL | 0/0/3/1 | 0e8d7cc83b | test(platform-node): distinguish semantic restart edits from comments | apps/mvp/docs/work/platform-node-linux-reds.md: Catalog: `@smthrs/platform-node` for Node |
| 2026-10-22 15:29 | `11731ba350` | PARTIAL | 0/0/3/1 | b03633a3c1 | test(platform-node): distinguish semantic restart edits from comments | apps/mvp/docs/work/platform-node-linux-reds.md: Catalog: `@smthrs/platform-node` for Node |
| 2026-10-22 15:29 | `d5b6c31b41` | PARTIAL | 0/0/3/1 | 373aa72a50 | test(platform-node): distinguish semantic restart edits from comments | apps/mvp/docs/work/platform-node-linux-reds.md: Catalog: `@smthrs/platform-node` for Node |
| 2026-10-22 15:30 | `0300eb6b70` | PARTIAL | 1/0/4/1 | 0e8d7cc83b | test(platform-node): wait for fixture receipts before signalling hosts | apps/mvp/docs/work/platform-node-linux-reds.md: suppressing Node's experimental Web Storag |
| 2026-10-22 15:30 | `9b6d10d569` | PARTIAL | 1/0/4/1 | b03633a3c1 | test(platform-node): wait for fixture receipts before signalling hosts | apps/mvp/docs/work/platform-node-linux-reds.md: suppressing Node's experimental Web Storag |
| 2026-10-22 15:30 | `0faf7850b6` | PARTIAL | 1/0/4/1 | 373aa72a50 | test(platform-node): wait for fixture receipts before signalling hosts | apps/mvp/docs/work/platform-node-linux-reds.md: suppressing Node's experimental Web Storag |
| 2026-10-22 15:30 | `6b14785300` | ON-MAIN | 1/0/0/0 | 6b14785300 | ✅ test(engine-store): the held drive's test moves the clock only once  |  |
| 2026-10-22 15:33 | `c24074824e` | STRANDED | 0/0/2/0 | 0e8d7cc83b | test(platform-node): cover explicit read denials and optional resolver | packages/smithers/flows/platform-node/test/ProcessSandbox.test.ts: NodeFs.writeFileSync(No |
| 2026-10-22 15:33 | `a91faca27b` | STRANDED | 0/0/2/0 | b03633a3c1 | test(platform-node): cover explicit read denials and optional resolver | packages/smithers/flows/platform-node/test/ProcessSandbox.test.ts: NodeFs.writeFileSync(No |
| 2026-10-22 15:33 | `63b88e9796` | STRANDED | 0/0/2/0 | 373aa72a50 | test(platform-node): cover explicit read denials and optional resolver | packages/smithers/flows/platform-node/test/ProcessSandbox.test.ts: NodeFs.writeFileSync(No |
| 2026-10-22 15:34 | `3ed609cbe1` | PARTIAL | 1/0/1/0 | 0e8d7cc83b | refactor(platform-node): remove obsolete write-widening guard | apps/mvp/docs/work/platform-node-linux-reds.md: First full coverage run: 1,299 passed / 11 |
| 2026-10-22 15:34 | `20d415154e` | PARTIAL | 1/0/1/0 | b03633a3c1 | refactor(platform-node): remove obsolete write-widening guard | apps/mvp/docs/work/platform-node-linux-reds.md: First full coverage run: 1,299 passed / 11 |
| 2026-10-22 15:34 | `63f281a428` | PARTIAL | 1/0/1/0 | 373aa72a50 | refactor(platform-node): remove obsolete write-widening guard | apps/mvp/docs/work/platform-node-linux-reds.md: First full coverage run: 1,299 passed / 11 |
| 2026-10-22 15:35 | `5fd8aa4174` | SUPERSEDED | 31/18/0/0 | 5fd8aa4174 | fix(mvp): stop TODO descendants when their base closes | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-22 15:37 | `0e8d7cc83b` | PARTIAL | 0/0/5/2 | 0e8d7cc83b | fix(platform-node): recognize exited proc inodes as gone on Linux | apps/mvp/docs/work/platform-node-linux-reds.md: status: completed; apps/mvp/docs/work/plat |
| 2026-10-22 15:37 | `b03633a3c1` | PARTIAL | 0/0/5/2 | b03633a3c1 | fix(platform-node): recognize exited proc inodes as gone on Linux | apps/mvp/docs/work/platform-node-linux-reds.md: status: completed; apps/mvp/docs/work/plat |
| 2026-10-22 15:37 | `373aa72a50` | PARTIAL | 0/0/5/2 | 373aa72a50 | fix(platform-node): recognize exited proc inodes as gone on Linux | apps/mvp/docs/work/platform-node-linux-reds.md: status: completed; apps/mvp/docs/work/plat |
| 2026-10-23 00:25 | `306bb9a2a9` | SUPERSEDED | 0/1/0/0 | 306bb9a2a9 | 📝 docs(mvp): the branch sandboxes handoff: what works in production an | apps/mvp/docs/work/sandboxes.md: main carried then changed it: e3a4a95b63 (✨ feat(mvp): ev |
| 2026-10-23 00:28 | `510f0dc709` | SUPERSEDED | 11/1/0/0 | 510f0dc709 | fix(mvp): publish agent commits relative to the TODO base | apps/mvp/worker/flows/Todo.ts: main carried then changed it: d535d7fa6d (✨ feat(mvp): Publ |
| 2026-10-23 00:28 | `3c0ea663e3` | SUPERSEDED | 11/1/0/0 | 3c0ea663e3 | fix(mvp): publish agent commits relative to the TODO base | apps/mvp/worker/flows/Todo.ts: main carried then changed it: d535d7fa6d (✨ feat(mvp): Publ |
| 2026-10-23 00:30 | `474e9d5d24` | SUPERSEDED | 22/22/0/0 | 474e9d5d24 | 🐛 fix(mvp): name timeline objects and cover every timeline branch | apps/mvp/docs/features/timeline.md: main carried then changed it: 0d2a9547c5 (🐛 fix(agent, |
| 2026-10-23 00:30 | `02d8f60823` | SUPERSEDED | 17/17/0/0 | 02d8f60823 | fix(mvp): name recorded objects and outcomes in the timeline | apps/mvp/docs/features/timeline.md: main carried then changed it: 0d2a9547c5 (🐛 fix(agent, |
| 2026-10-23 00:36 | `9cb95cbd2b` | STRANDED | 0/0/1/0 | 96303ec936 | test(mvp/status): wait for each device before answering a question | apps/mvp/src/features/status/status.test.ts: for (const device of [a, b]) await until(() = |
| 2026-10-23 00:36 | `9a3ff7e602` | ON-MAIN | 4/0/0/0 | 96303ec936 | test(mvp/runs): cover frontend leave ownership and corrupt retry histo |  |
| 2026-10-23 00:36 | `ab7344dcb4` | SUPERSEDED | 2/1/0/0 | 96303ec936 | test(mvp/agent): cover durable memory selection, save receipts and sou | apps/mvp/src/features/agent/memory.test.ts: main carried then changed it: ef103d8481 (🐛 fi |
| 2026-10-23 00:36 | `c520d2740b` | SUPERSEDED | 4/1/0/0 | 96303ec936 | test(mvp/device): cover frozen validators, stored identities and TODO  | apps/mvp/docs/work/coverage-main.md: main carried then changed it: 127a1c32af (test(mvp): |
| 2026-10-23 00:42 | `7791e49b29` | SUPERSEDED | 1/2/0/0 | 56585870d2 | 🐛 fix(mvp): wrap mobile home chrome and enlarge navigation targets | apps/mvp/src/screens/app/app-shell.css: main carried then changed it: cbb40294a0 (🎨 style( |
| 2026-10-23 00:42 | `1af9a989ab` | SUPERSEDED | 0/2/0/0 | 56585870d2 | ✅ test(mvp): add responsive route and control audit | apps/mvp/docs/work/mobile-responsiveness-sweep.md: main carried then changed it: f09e37597 |
| 2026-10-23 00:43 | `89dd395f5e` | SUPERSEDED | 0/2/0/0 | 56585870d2 | 🐛 fix(ui): give narrow-screen buttons and timeline 32px targets | packages/smithers/ui/src/chat/chatTimelineCss.ts: main carried then changed it: 4f2bd38d7c |
| 2026-10-23 00:44 | `250aa64c0c` | SUPERSEDED | 2/2/0/0 | 56585870d2 | 🐛 fix(ui): make mobile breadcrumbs and issue filters tappable | packages/smithers/ui/src/issues-view/issuesViewCss.ts: main carried then changed it: 4f2bd |
| 2026-10-23 00:44 | `8834ef4e8d` | SUPERSEDED | 0/2/0/0 | 56585870d2 | 🐛 fix(repo-view): enlarge mobile README and contributor links | packages/smithers/ui/repo-view/src/styles.tsx: main carried then changed it: 4f2bd38d7c (🐛 |
| 2026-10-23 00:45 | `c4728cb4f8` | ON-MAIN | 2/0/0/0 | 56585870d2 | 🐛 fix(repo-view): keep mobile document links reachable when wrapped |  |
| 2026-10-23 00:45 | `810930b119` | SUPERSEDED | 0/3/0/0 | 56585870d2 | 🐛 fix(mvp): enlarge narrow-screen return navigation targets | apps/mvp/src/screens/flows/flows-screen.css: main carried then changed it: 18c3cc4fef (🎨 s |
| 2026-10-23 00:46 | `567ca9d3b5` | SUPERSEDED | 0/2/0/0 | 56585870d2 | 🐛 fix(mvp): enlarge the mobile plugin return link | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 46a9716fed (🐛 fix(ui): fit time |
| 2026-10-23 00:46 | `72b2173f21` | ON-MAIN | 2/0/0/0 | 56585870d2 | 🐛 fix(mvp): make mobile documentation index links tappable |  |
| 2026-10-23 00:50 | `7cea5f6314` | SUPERSEDED | 0/4/0/0 | 56585870d2 | 🐛 fix(ui): keep mobile run controls reachable and clear of the graph | packages/smithers/ui/src/action-menu/actionMenuCss.ts: main carried then changed it: 4f2bd |
| 2026-10-23 00:50 | `8401c5bcc8` | SUPERSEDED | 0/1/0/0 | 56585870d2 | 🐛 fix(ui): wrap mobile notice text and preserve bell width | packages/smithers/ui/src/agent-status/agentStatusCss.ts: main carried then changed it: 4f2 |
| 2026-10-23 00:50 | `631f960e9b` | SUPERSEDED | 0/2/0/0 | 56585870d2 | 🐛 fix(ui): enlarge mobile presence and composer targets | packages/smithers/ui/src/sharingCss.ts: main carried then changed it: 4f2bd38d7c (🐛 fix(ui |
| 2026-10-23 00:51 | `12e962a1b8` | ON-MAIN | 1/0/0/0 | 56585870d2 | ✅ test(mvp): audit live notices on a page outside their conversation |  |
| 2026-10-23 00:52 | `93f3c08855` | SUPERSEDED | 1/1/0/0 | 56585870d2 | ✅ test(mvp): cover flow editors and require populated issue and PR det | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 03b7cefaed (✅ test(mvp): cover |
| 2026-10-23 00:53 | `c82679e908` | ON-MAIN | 1/0/0/0 | 56585870d2 | 🐛 fix(ui): tokenize the mobile action menu height |  |
| 2026-10-23 00:53 | `acda392928` | SUPERSEDED | 12/1/0/0 | 56585870d2 | 🐛 fix(ui): use the shared control-height token for mobile targets | packages/smithers/ui/src/action-menu/actionMenuCss.ts: main carried then changed it: f8e91 |
| 2026-10-23 00:53 | `da09f2377c` | SUPERSEDED | 0/1/0/0 | 56585870d2 | ✅ test(mvp): prepare real file fixtures and wait for branch content | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 6009f0c7b0 (✅ test(mvp): prepar |
| 2026-10-23 00:55 | `572e9497bf` | SUPERSEDED | 0/2/0/0 | 56585870d2 | ✅ test(mvp): preserve native-size recordings for every viewport | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 3ec6e434bd (✅ test(mvp): share |
| 2026-10-23 01:00 | `c10a0c117b` | SUPERSEDED | 0/2/0/0 | 56585870d2 | ✅ test(mvp): verify session identity and signed-out terminal access | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 46a9716fed (🐛 fix(ui): fit time |
| 2026-10-23 01:01 | `5e3a1c7edf` | SUPERSEDED | 0/1/0/0 | 96303ec936 | test(mvp/boot): cover explicit shortcut platform option | apps/mvp/src/boot.test.ts: main carried then changed it: 3253f42230 (⚡ perf(mvp): render a |
| 2026-10-23 01:08 | `1447fc905b` | SUPERSEDED | 1/1/0/0 | 56585870d2 | ✅ test(mvp): share an independent viewport option with the recorder | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 7a3b35b06b (🧪 test(mvp): await |
| 2026-10-23 01:11 | `405f55a4c0` | SUPERSEDED | 0/1/0/0 | 56585870d2 | ✅ test(mvp): retain clone prerequisite refusal details | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 93ac577865 (🧪 test(mvp): declar |
| 2026-10-23 01:11 | `4bffea7c07` | ON-MAIN | 2/0/0/0 | 56585870d2 | 🐛 fix(ui): enlarge mobile Markdown links and code-block controls |  |
| 2026-10-23 01:12 | `597e70d118` | ON-MAIN | 1/0/0/0 | 56585870d2 | 🐛 fix(ui): enlarge mobile run-list links |  |
| 2026-10-23 01:14 | `c4b4cbfa68` | SUPERSEDED | 0/1/0/0 | 56585870d2 | ✅ test(mvp): retain draft readiness failures while checking the code e | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 98bd3487ed (🧪 test(mvp): distin |
| 2026-10-23 01:16 | `9f2da15a92` | ON-MAIN | 1/0/0/0 | 56585870d2 | 🐛 fix(mvp): keep wrapped mobile flow links tappable |  |
| 2026-10-23 01:16 | `2002a09736` | ON-MAIN | 1/0/0/0 | 56585870d2 | 🐛 fix(ui): keep mobile notification counts inside their tap target |  |
| 2026-10-23 01:17 | `c0d847b65a` | SUPERSEDED | 0/1/0/0 | 56585870d2 | 🐛 fix(mvp): avoid overlapping notification bells on narrow docs pages | apps/mvp/src/screens/root/root.css: main carried then changed it: 46a9716fed (🐛 fix(ui): f |
| 2026-10-23 01:19 | `d6fdf1b888` | SUPERSEDED | 0/2/0/0 | 56585870d2 | ✅ test(mvp): capture unavailable file routes before reporting clone fa | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 93ac577865 (🧪 test(mvp): declar |
| 2026-10-23 01:19 | `a0628cfe62` | SUPERSEDED | 49/15/0/0 | a0628cfe62 | 🐛 fix(mvp): a merge rechecks the base branch's own head and merges onc | apps/mvp/db/Database.test.ts: landed as e0367e6fb5 (same author and time, committed later) |
| 2026-10-23 01:19 | `5009dc108e` | SUPERSEDED | 36/10/0/0 | a0628cfe62 | 🐛 fix(mvp): a person's triage wins over the flow's whatever order the  | apps/mvp/PACKAGE.ts: main carried then changed it: e0367e6fb5 (🐛 fix(mvp): a merge recheck |
| 2026-10-23 01:19 | `a8deffa911` | SUPERSEDED | 8/6/0/0 | a0628cfe62 | ✨ feat(integrations): GitHub.Once.merge merges once and finds the merg | apps/site/public/llms-full.txt: main carried then changed it: 4df6121e91 (🔧 chore: regener |
| 2026-10-23 01:19 | `b8270b19ca` | SUPERSEDED | 19/28/0/0 | a0628cfe62 | 🔒️ fix(mvp): a home counts a session's role only on the repository it  | apps/mvp/docs/features/home.md: main carried then changed it: cb736313eb (✨ feat(mvp): a r |
| 2026-10-23 01:19 | `2f6b582c84` | ON-MAIN | 1/0/0/0 | a0628cfe62 | 📝 docs(mvp): the GitHub write hardening design: the merge's base, a pe |  |
| 2026-10-23 01:19 | `b054e9bc0f` | PARTIAL | 28/30/4/0 | a0628cfe62 | 🐛 fix(github): fence projections and preserve merge outcomes | apps/mvp/db/Database.ts: import githubProjectionFences from "./migrations/0046_github_proj |
| 2026-10-23 01:20 | `a3eff78eb6` | ON-MAIN | 8/0/0/0 | 96303ec936 | test(mvp/coedit): await corrupt-update rejection, ordered marks and hi |  |
| 2026-10-23 01:20 | `b50fd9924e` | SUPERSEDED | 4/1/0/0 | 96303ec936 | fix(mvp/telemetry): relay engine lifecycle records and replay seed cou | apps/mvp/docs/observability.md: main carried then changed it: 4151397073 (🔇 fix(engine-sto |
| 2026-10-23 01:20 | `54b76c6878` | ON-MAIN | 5/0/0/0 | 96303ec936 | test(mvp/stack): verify cancelled receipts; delete unreachable missing |  |
| 2026-10-23 01:20 | `ed27415331` | ON-MAIN | 1/0/0/0 | 96303ec936 | test(mvp/issues): retry rejection comments and refuse unresolved commi |  |
| 2026-10-23 01:20 | `83a6243b78` | ON-MAIN | 3/0/0/0 | 96303ec936 | test(mvp/checks): cover retryable review faults and repeated settlemen |  |
| 2026-10-23 01:20 | `0b3dda1670` | ON-MAIN | 2/0/0/0 | 96303ec936 | test(mvp/branches): refuse deleted branches and missing default refs |  |
| 2026-10-23 01:20 | `89ae75c177` | SUPERSEDED | 0/1/0/0 | 96303ec936 | fix(mvp/views): delete unreachable docs identity fallbacks | apps/mvp/worker/Views.ts: main carried then changed it: 0b1f866da1 (✨ feat(mvp): the agent |
| 2026-10-23 01:20 | `bb5c2e6e60` | ON-MAIN | 1/0/0/0 | 96303ec936 | test(mvp/auth): refuse sessionless credentials and forged sign-out coo |  |
| 2026-10-23 01:20 | `f9d974cc0a` | ON-MAIN | 1/0/0/0 | 96303ec936 | test(mvp/repo-api): refuse unreadable launch sessions and bodies |  |
| 2026-10-23 01:20 | `3cb3207d09` | ON-MAIN | 2/0/0/0 | 96303ec936 | test(mvp/model): cover explicit server spend alert policy |  |
| 2026-10-23 01:20 | `4a80db7243` | ON-MAIN | 2/0/0/0 | 96303ec936 | test(mvp/todos): exercise Retry through public actions and outbox |  |
| 2026-10-23 01:20 | `05fc7677f2` | ON-MAIN | 2/0/0/0 | 96303ec936 | test(mvp/timeline): refuse non-provider model-step failures safely |  |
| 2026-10-23 01:20 | `2344bde44c` | PARTIAL | 1/0/1/1 | 96303ec936 | test(mvp/repo): cover launch transport faults and hold cloning during  | apps/mvp/src/features/repo/warm.test.ts: import { Deferred, type Duration, Effect, Layer } |
| 2026-10-23 01:20 | `256ceac676` | ON-MAIN | 1/0/0/0 | 96303ec936 | test(mvp/code-intel): retain new page after stale symbol lookup |  |
| 2026-10-23 01:20 | `de3ee16910` | SUPERSEDED | 5/1/0/0 | 96303ec936 | test(mvp/flows): cover unchanged answers and unavailable rounds | apps/mvp/src/features/flows-ui/faults.test.ts: main carried then changed it: 4a6932b47d (f |
| 2026-10-23 01:20 | `b3593e5166` | ON-MAIN | 2/0/0/0 | 96303ec936 | test(mvp/dev): close HTTPS before listening |  |
| 2026-10-23 01:20 | `edfd7ae637` | ON-MAIN | 8/0/0/0 | 96303ec936 | fix(mvp/home): keep clone selection over delayed previews; test warm r |  |
| 2026-10-23 01:21 | `c05a16c3b8` | ON-MAIN | 1/0/0/0 | 56585870d2 | 🐛 fix(ui): keep single-line mobile issue and TODO links tappable |  |
| 2026-10-23 01:21 | `e624cbe417` | ON-MAIN | 2/0/0/0 | 96303ec936 | test(mvp/attention): restore toast after acknowledgement flow failure |  |
| 2026-10-23 01:22 | `a7254f1bf2` | SUPERSEDED | 0/1/0/0 | 56585870d2 | ✅ test(mvp): wait for TODO cleanup before closing the device | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 7a3b35b06b (🧪 test(mvp): await |
| 2026-10-23 01:31 | `ba5aed5c46` | SUPERSEDED | 0/1/0/0 | 56585870d2 | ✅ test(mvp): measure controls still visible after scrolling | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 4fdaaa36a7 (🐛 fix(mvp): gate cl |
| 2026-10-23 01:33 | `8c6456d8ef` | SUPERSEDED | 3/1/0/0 | 96303ec936 | refactor(mvp/credentials): resolve silent-door policy with one return | apps/mvp/src/flows/credentials.ts: main carried then changed it: 41bbf0f328 (refactor(mvp/ |
| 2026-10-23 01:37 | `47e1acc4b1` | ON-MAIN | 1/0/0/0 | 56585870d2 | 🐛 fix(ui): enlarge the mobile flow draft file disclosure |  |
| 2026-10-23 01:39 | `81e5310609` | ON-MAIN | 1/0/0/0 | 56585870d2 | ✅ test(mvp): point mobile media at the retained Playwright recording |  |
| 2026-10-23 01:41 | `2c82046b3c` | SUPERSEDED | 1/1/0/0 | 56585870d2 | 📝 docs(mvp): record mobile sweep evidence and remaining blockers | apps/mvp/docs/work/mobile-responsiveness-sweep.md: main carried then changed it: f09e37597 |
| 2026-10-23 01:44 | `d74d127e5a` | SUPERSEDED | 11/6/0/0 | 56585870d2 | ✅ test(mvp): declare mobile prerequisites and compare desktop layout a | apps/mvp/docs/work/mobile-responsiveness-sweep.md: main carried then changed it: 46a9716fe |
| 2026-10-23 01:46 | `e556a3cbb8` | SUPERSEDED | 7/1/0/0 | 96303ec936 | test(mvp/chat): use real reload engines and verify redelivery identiti | apps/mvp/src/features/chat/controls.test.ts: main carried then changed it: 959ed5fca8 (🐛 f |
| 2026-10-23 02:07 | `837943cad6` | SUPERSEDED | 0/1/0/0 | 56585870d2 | 📝 docs(mvp): record rebased mobile results and farm quota evidence | apps/mvp/docs/work/mobile-responsiveness-sweep.md: main carried then changed it: f09e37597 |
| 2026-10-23 02:11 | `e476be9c47` | SUPERSEDED | 5/9/0/0 | 56585870d2 | 🐛 fix(mvp): cover new mobile screens and keep their controls reachable | apps/mvp/e2e/mobile-baseline.ts: main carried then changed it: e8f596b215 (🐛 fix(mvp): kee |
| 2026-10-23 02:13 | `bea6c340b8` | ON-MAIN | 1/0/0/0 | 96303ec936 | test(mvp/shapes): restart retired Electric handles before reading rows |  |
| 2026-10-23 02:17 | `2ee2c108ec` | PARTIAL | 11/6/0/1 | 2ee2c108ec | 🐛 fix(mvp): surface refused new conversations in the composer | apps/mvp/docs/decisions/0077-new-conversation-refusal.md: Code Storage needs an existing m |
| 2026-10-23 02:20 | `36a602fab9` | ON-MAIN | 14/0/0/0 | 36a602fab9 | 🐛 fix(mvp): persist file tab changes before navigation |  |
| 2026-10-23 02:25 | `a2c4408ab1` | SUPERSEDED | 2/2/0/0 | 56585870d2 | ✅ test(mvp): honor deployment roles in mobile route fixtures | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 93ac577865 (🧪 test(mvp): declar |
| 2026-10-23 02:31 | `96303ec936` | SUPERSEDED | 2/1/0/0 | 96303ec936 | test(mvp/coverage): expose failed-run reports; record the 100% Latitud | apps/mvp/docs/work/coverage-main.md: main carried then changed it: 127a1c32af (test(mvp): |
| 2026-10-23 02:32 | `0d459d8175` | SUPERSEDED | 0/1/0/0 | 56585870d2 | 📝 docs(mvp): record final mobile receipts and desktop blockers | apps/mvp/docs/work/mobile-responsiveness-sweep.md: main carried then changed it: 46a9716fe |
| 2026-10-23 03:07 | `a7af3f6e26` | SUPERSEDED | 10/7/0/0 | a7af3f6e26 | 🐛 fix(mvp): retain file tab focus through navigation | apps/mvp/docs/decisions/0081-keyboard-focus-through-file-navigation.md: landed as 4e8c78ff |
| 2026-10-23 10:59 | `86e1fb8869` | SUPERSEDED | 0/7/0/0 | 56585870d2 | 🐛 fix(mvp): keep desktop bells and README content reachable | apps/mvp/docs/work/mobile-responsiveness-sweep.md: main carried then changed it: 46a9716fe |
| 2026-10-23 11:02 | `397ac16d47` | SUPERSEDED | 22/3/0/0 | 397ac16d47 | 🐛 fix(mvp): preserve merged views and prove form submission recovery | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-23 11:11 | `4ad4c7908b` | SUPERSEDED | 12/2/0/0 | 4ad4c7908b | 🖼️ fix(mvp): serve origin-aware social preview cards | apps/mvp/worker/index.ts: main carried then changed it: 4efa2e03c0 (✨ feat(mvp): APP_ALIAS |
| 2026-10-23 11:21 | `339099a805` | PARTIAL | 17/3/0/1 | 339099a805 | test(mvp): finish the 100% coverage gate | apps/mvp/worker/github/Api.test.ts: test("default HTTP metadata reads use the configured b |
| 2026-10-23 11:24 | `56585870d2` | SUPERSEDED | 10/20/0/0 | 56585870d2 | 🐛 fix(ui): fit timeline labels and remove duplicate docs bells | apps/mvp/docs/features/timeline.md: main carried then changed it: 5ca2098804 (📝 docs(mvp): |
| 2026-10-23 12:14 | `1f4b94be7a` | SUPERSEDED | 12/3/0/0 | 9066432f71 | 🐛 fix(mvp): stop retrying denied forge branch writes | apps/mvp/docs/work/prod-new-branch.md: main carried then changed it: 52a5e776f9 (✨ feat(mv |
| 2026-10-23 12:27 | `c8417db8d0` | SUPERSEDED | 4/4/0/0 | c8417db8d0 | 🧪 test(mvp): prove timeline objects with a live-model journey | apps/mvp/docs/features/timeline.md: main carried then changed it: d9240f088e (🐛 fix(timeli |
| 2026-10-23 12:38 | `9066432f71` | SUPERSEDED | 1/2/0/0 | 9066432f71 | 📝 docs(mvp): research where new conversation refs should live | apps/mvp/docs/work/prod-new-branch.md: main carried then changed it: 52a5e776f9 (✨ feat(mv |
| 2026-10-23 12:40 | `ad08687dd6` | SUPERSEDED | 20/1/0/0 | ad08687dd6 | ✨ feat(effect-code-storage): add repository deletion | packages/effect-code-storage/src/internal/bounded.ts: main carried then changed it: a60cc8 |
| 2026-10-23 12:40 | `550b4bec53` | SUPERSEDED | 18/1/0/0 | 550b4bec53 | ✨ feat(effect-code-storage): add repository deletion | packages/effect-code-storage/src/internal/bounded.ts: main carried then changed it: a60cc8 |
| 2026-10-23 12:40 | `ab8f62e371` | SUPERSEDED | 18/1/0/0 | ab8f62e371 | ✨ feat(effect-code-storage): add repository deletion | packages/effect-code-storage/src/internal/bounded.ts: main carried then changed it: a60cc8 |
| 2026-10-23 12:54 | `14177c08a8` | SUPERSEDED | 17/5/0/0 | 14177c08a8 | 🐛 fix(mvp): settle unsynced issue lists and authenticate e2e reads | apps/mvp/docs/decisions/0079-roles-per-repository.md: main carried then changed it: 4944e3 |
| 2026-10-23 13:18 | `e4138ff4d0` | STRANDED | 0/0/2/0 | e4138ff4d0 |  | apps/mvp/src/device/migrations.test.ts: ConversationPendingStore,; apps/mvp/src/device/mig |
| 2026-10-23 13:38 | `215ebf0803` | SUPERSEDED | 3/1/0/0 | 215ebf0803 | 🧪 test(mvp): wait for the timeline reply before following its link | apps/mvp/docs/features/timeline.md: main carried then changed it: 0d2a9547c5 (🐛 fix(agent, |
| 2026-10-23 14:15 | `09f1b5b9f3` | SUPERSEDED | 19/1/0/0 | 39f8cad1c3 | ✨ feat(code-storage): support explicit ref namespaces | packages/effect-code-storage/src/CodeStorage.ts: main carried then changed it: ec00f628dd |
| 2026-10-23 14:15 | `991982f24e` | SUPERSEDED | 20/1/0/0 | 5041c806d8 | ✨ feat(code-storage): support explicit ref namespaces | packages/effect-code-storage/src/CodeStorage.ts: main carried then changed it: ec00f628dd |
| 2026-10-23 14:18 | `559c7b6dd1` | ON-MAIN | 7/0/0/0 | 559c7b6dd1 | 🧪 test(mvp): inject opening judge retry timings |  |
| 2026-10-23 14:18 | `f7689eb189` | STRANDED | 0/0/1/0 | f7689eb189 | 📝 docs(mvp): record forms and views live eval blockers | apps/mvp/docs/work/forms-and-views-live-evals.md: `EVAL_ONLY=form-ask,form-clone-no-url,bo |
| 2026-10-23 14:24 | `b13bb55a1f` | ON-MAIN | 8/0/0/0 | ecf78a276d | 🔍 test(mvp): retain live eval model transcripts for renderer failures |  |
| 2026-10-23 14:28 | `8d31f611cf` | SUPERSEDED | 4/1/0/0 | ecf78a276d | 🐛 fix(mvp): ask for missing input with a visible form | apps/mvp/src/features/agent/instructions.ts: main carried then changed it: 8407925743 (🐛 f |
| 2026-10-23 14:32 | `9823226b3f` | PARTIAL | 114/16/11/4 | 39f8cad1c3 | ✨ feat(mvp): create conversation branches through repository flows | apps/mvp/db/Database.test.ts: test("preserves existing branches, conversations and shares, |
| 2026-10-23 14:32 | `5041c806d8` | PARTIAL | 31/4/12/10 | 5041c806d8 | 🚧 chore(mvp): retain blocked ephemeral branch integration draft | apps/mvp/db/Database.test.ts: +      const on = <A, E>(effect: Effect.Effect<A, E, SqlClie |
| 2026-10-23 14:33 | `a81e44ebae` | SUPERSEDED | 5/5/0/0 | ecf78a276d | 🐛 fix(mvp): ground live UI judgments in shown views | apps/mvp/evals/judge.test.ts: main carried then changed it: 44bca0e800 (🐛 fix(mvp): judge |
| 2026-10-23 14:33 | `ae86dd9166` | ON-MAIN | 6/0/0/0 | ecf78a276d | 🐛 fix(mvp): supply the renderer token allowance through its seat |  |
| 2026-10-23 14:39 | `74b6cd222a` | PARTIAL | 6/0/1/0 | ecf78a276d | 🐛 test(mvp): use the selected compose database and Electric everywhere | apps/mvp/worker/test/repos.ts: const provider = ConfigProvider.fromUnknown({ ELECTRIC_URL: |
| 2026-10-23 14:41 | `40022a75e6` | PARTIAL | 57/6/0/1 | 40022a75e6 | ✨ feat(mvp): keep personal messages pinned above conversations | apps/mvp/docs/decisions/0087-pin-message.md: # 0087 — A personal pinned message; apps/mvp/ |
| 2026-10-23 14:41 | `3fd6771a55` | PARTIAL | 57/6/0/1 | 039dfc6ed8 | ✨ feat(mvp): keep personal messages pinned above conversations | apps/mvp/docs/decisions/0087-pin-message.md: # 0087 — A personal pinned message; apps/mvp/ |
| 2026-10-23 14:41 | `9a588759db` | PARTIAL | 57/6/0/1 | 9a588759db | ✨ feat(mvp): keep personal messages pinned above conversations | apps/mvp/docs/decisions/0082-pin-message.md: # 0082 — A personal pinned message; apps/mvp/ |
| 2026-10-23 14:49 | `39f8cad1c3` | PARTIAL | 35/6/24/12 | 39f8cad1c3 | 🧪 test(mvp): isolate real services and synchronize fixtures | apps/mvp/src/features/agent/memory.test.ts: import { Cause, Clock, ConfigProvider, Context |
| 2026-10-23 14:49 | `fdf5f28852` | SUPERSEDED | 12/4/0/0 | 39f8cad1c3 | ✨ feat(harness): execute pinned flow modules in isolated realms | packages/smithers/agent/harness/README.md: main carried then changed it: f04d30a6d6 (✨ fea |
| 2026-10-23 14:49 | `8ea5310fe4` | ON-MAIN | 13/0/0/0 | 39f8cad1c3 | ✨ feat(code-storage): scope sandbox Git fetches to one branch |  |
| 2026-10-23 14:50 | `7445178a7b` | ON-MAIN | 15/0/0/0 | 8597758a90 | 🐛 fix(ui): keep mobile repository and conversation controls readable |  |
| 2026-10-23 14:56 | `8597758a90` | SUPERSEDED | 7/4/0/0 | 8597758a90 | 🧪 test(mvp): declare production mobile data prerequisites | apps/mvp/docs/infrastructure.md: main carried then changed it: 98bd3487ed (🧪 test(mvp): di |
| 2026-10-23 15:02 | `6ed23d2813` | SUPERSEDED | 1/1/0/0 | ecf78a276d | 🐛 fix(mvp): open file tabs when the person asks to see lines | apps/mvp/src/features/agent/instructions.ts: main carried then changed it: 5a03636791 (🐛 f |
| 2026-10-23 15:05 | `d205cdcae8` | ON-MAIN | 3/0/0/0 | ecf78a276d | 🐛 test(mvp): route conversation archives through the real API |  |
| 2026-10-23 15:18 | `ac298a82cb` | ON-MAIN | 2/0/0/0 | ecf78a276d | 🐛 fix(mvp): keep example calls out of executable agent cells |  |
| 2026-10-23 15:18 | `74c4e61b83` | SUPERSEDED | 3/1/0/0 | ecf78a276d | 🐛 fix(mvp): stop dependent agent actions on structured refusals | apps/mvp/src/features/agent/instructions.ts: main carried then changed it: dae42340c1 (🐛 f |
| 2026-10-23 15:26 | `0159bc13a8` | ON-MAIN | 1/0/0/0 | ecf78a276d | 🔍 test(mvp): retain synthetic memory model transcripts |  |
| 2026-10-23 15:28 | `96177b8f24` | ON-MAIN | 2/0/0/0 | ecf78a276d | 🐛 fix(mvp): inspect effect receipts and finish refused agent calls |  |
| 2026-10-23 15:28 | `8d4ebc1699` | SUPERSEDED | 0/1/0/0 | ecf78a276d | 🐛 fix(mvp): finish created drafts with their ready receipt | apps/mvp/src/features/agent/instructions.ts: main carried then changed it: dae42340c1 (🐛 f |
| 2026-10-23 15:42 | `7e22a3ccbf` | ON-MAIN | 17/0/0/0 | ecf78a276d | 🐛 test(mvp): keep remote shapes and health probes on the selected stac |  |
| 2026-10-23 15:42 | `cb0cc54c09` | ON-MAIN | 15/0/0/0 | ecf78a276d | 🐛 fix(mvp): judge draft receipts and person-only actions from evidence |  |
| 2026-10-23 15:42 | `0cee059627` | ON-MAIN | 5/0/0/0 | ecf78a276d | 🐛 fix(mvp): describe approval owned by catalog flows |  |
| 2026-10-23 15:42 | `8ecc8f1f42` | ON-MAIN | 1/0/0/0 | ecf78a276d | 🐛 fix(mvp): name the literal form receipt in its tool contract |  |
| 2026-10-23 15:45 | `27e15c26bc` | PARTIAL | 1/0/0/2 | ecf78a276d | 🐛 test(mvp): bind stack branch and secrets fixtures to selected Electr | apps/mvp/worker/secrets/test/harness.ts: const provider = ConfigProvider.fromUnknown({ ELE |
| 2026-10-23 16:05 | `3518848272` | PARTIAL | 1/0/3/5 | ecf78a276d | 🧪 test(mvp): drive default retry exhaustion with a real-host test cloc | apps/mvp/src/features/agent/memory.test.ts: import { Cause, ConfigProvider, Context, Effec |
| 2026-10-23 16:19 | `4c41f2d651` | SUPERSEDED | 1/6/0/0 | 20687ac7cb | 🐛 fix(mvp): bind pull visits to their repository sync | apps/mvp/docs/features/pulls.md: main carried then changed it: ee30d46e1c (🐛 fix(mvp): kee |
| 2026-10-23 16:24 | `3b93a3df3d` | SUPERSEDED | 6/1/0/0 | 20687ac7cb | 🧪 test(mvp): verify mobile projections on persisted devices | apps/mvp/worker/test/repos.ts: main carried then changed it: 97174ab133 (🧪 test(mvp): reta |
| 2026-10-23 16:25 | `201a35f16a` | ON-MAIN | 6/0/0/0 | da2a7d8616 | 🧪 test(mvp): inject timeline retry timings |  |
| 2026-10-23 16:28 | `da2a7d8616` | ON-MAIN | 14/0/0/0 | da2a7d8616 | 🧪 test(mvp): separate startup structure from its timing budget |  |
| 2026-10-23 16:31 | `79ca0d4bc5` | SUPERSEDED | 12/1/0/0 | 54239406d3 | 🧪 test(mvp): run production CI as the App installation | apps/mvp/docs/work/prod-ci.md: main carried then changed it: ffdb99e9d7 (🐛 fix(mvp): captu |
| 2026-10-23 16:37 | `20687ac7cb` | SUPERSEDED | 15/4/0/0 | 20687ac7cb | 🧪 test(mvp): distinguish mobile data receipts from layout | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: f600e1a61a (🐛 fix(mvp): contain |
| 2026-10-23 16:54 | `54239406d3` | SUPERSEDED | 45/13/0/0 | 54239406d3 | 🐛 fix(mvp): capture worker configuration before dispatch | apps/mvp/src/test/chatApi.ts: main carried then changed it: 45e326dc6b (🐛 fix(mvp): visito |
| 2026-10-23 17:03 | `3ad8eec981` | ON-MAIN | 6/0/0/0 | ecf78a276d | 🧪 test(mvp): advance expiry fixtures across database and host clocks |  |
| 2026-10-23 17:03 | `d937458542` | ON-MAIN | 3/0/0/0 | ecf78a276d | 🐛 fix(mvp): clear landed secret forms after a lost acknowledgment |  |
| 2026-10-23 17:03 | `7e5b48a56d` | ON-MAIN | 1/0/0/0 | ecf78a276d | 🐛 test(mvp): construct the domains API with selected Electric configur |  |
| 2026-10-23 17:08 | `039dfc6ed8` | EMPTY-ISH | 0/0/0/0 | 039dfc6ed8 |  |  |
| 2026-10-23 17:36 | `073c14f0e3` | SUPERSEDED | 9/5/0/0 | 20858bc9a8 | 🐛 fix(mvp): settle pull lists and enlarge mobile sidebar links | apps/mvp/src/features/pulls/pulls.test.ts: main carried then changed it: c4954e045c (✨ fea |
| 2026-10-23 17:41 | `20858bc9a8` | ON-MAIN | 6/0/0/0 | 20858bc9a8 | 🧪 test(mvp): await settled mobile lists and own TODO cleanup |  |
| 2026-10-23 17:55 | `869474222d` | ON-MAIN | 2/0/0/0 | ecf78a276d | 🔍 test(mvp): retain stalled device handoff diagnostics |  |
| 2026-10-23 18:12 | `9dec033c06` | ON-MAIN | 5/0/0/0 | ecf78a276d | 🧪 test(mvp): wait for agent completion between plugin scenarios |  |
| 2026-10-23 19:17 | `ecf78a276d` | STRANDED | 0/0/76/0 | ecf78a276d | 📝 docs(mvp): retain agent UI eval repair evidence and blocked proof | apps/mvp/docs/features/agent-evals.md: Twenty-six, each one behavior the app ships today; |
| 2026-10-23 22:18 | `e3755de690` | SUPERSEDED | 21/8/0/0 | e3755de690 | 🧪 test(mvp): retain missing fixture isolation and synchronization | apps/mvp/db/TestDatabase.ts: main carried then changed it: 72ece084eb (🐛 fix(test): reap e |
| 2026-10-23 23:11 | `dd805e229d` | SUPERSEDED | 134/28/0/0 | dd805e229d | ✨ feat(mvp): create branches through repository flows | apps/mvp/PACKAGE.test.ts: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 produc |
| 2026-10-24 00:07 | `69ae4dde36` | SUPERSEDED | 0/2/0/0 | d3928d2f04 | 🧪 test(mvp): synchronize concurrent read-token mints on provider entry | apps/mvp/worker/github/ReadToken.test.ts: main carried then changed it: 637979ce01 (🐛 fix( |
| 2026-10-24 00:13 | `d3928d2f04` | ON-MAIN | 10/0/0/0 | d3928d2f04 | 🐛 fix(mvp): retain authenticated transport for durable TODO inspection |  |
| 2026-10-24 00:13 | `b0a5326d3d` | PARTIAL | 1/0/1/2 | d3928d2f04 | 🧪 test(mvp): calibrate TODO inspection and its tool telemetry | apps/mvp/evals/flowCases.test.ts: bad: { calls: [call("run/list")], text: "No runs on this |
| 2026-10-24 00:22 | `fccdf564da` | SUPERSEDED | 5/2/0/0 | fccdf564da | ✅ test(mvp): close Runs and About coverage gaps | apps/mvp/worker/RepoApi.test.ts: main carried then changed it: 45e326dc6b (🐛 fix(mvp): vis |
| 2026-10-24 01:47 | `c17be25bf5` | ON-MAIN | 3/0/0/0 | f4776e99c3 | 🧪 test(mvp): follow remote run changes after an empty snapshot |  |
| 2026-10-24 01:51 | `2c1c1cb1f0` | ON-MAIN | 2/0/0/0 | 68287c4345 | 🐛 fix(mvp): close TODO status route branch gaps |  |
| 2026-10-24 01:54 | `5e5a22a177` | ON-MAIN | 1/0/0/0 | 68287c4345 | ✅ test(mvp): assert retained code on refused rereads |  |
| 2026-10-24 01:55 | `15f5ad3b84` | SUPERSEDED | 2/5/0/0 | f4776e99c3 | 🧹 fix(mvp): remove unreachable installed-receipt alternatives | apps/mvp/src/features/issues/store.ts: main carried then changed it: 7c481b16c7 (🐛 fix(mvp |
| 2026-10-24 01:55 | `68287c4345` | ON-MAIN | 3/0/0/0 | 68287c4345 | ✅ test(mvp): resolve PWA registration through app Vite config |  |
| 2026-10-24 02:05 | `e26100d228` | SUPERSEDED | 1/2/0/0 | f4776e99c3 | 🧪 test(mvp): cover exhausted public About reads and recovery | apps/mvp/src/features/repo/repo.test.ts: main carried then changed it: 45e326dc6b (🐛 fix(m |
| 2026-10-24 02:21 | `779b93904c` | PARTIAL | 0/0/7/1 | f4776e99c3 | 🧪 fix(mvp): preserve fetch capabilities in new branch fixtures | apps/mvp/docs/work/main-reds-0024c.md: Forge/GitHubCreation have 46 passing tests and two |
| 2026-10-24 03:37 | `0e9fc1bb76` | ON-MAIN | 2/0/0/0 | f4776e99c3 | 🧪 test(mvp): assert the queued TODO card failure field |  |
| 2026-10-24 03:38 | `0cf9bb3b2b` | SUPERSEDED | 14/3/0/0 | 7e69a6ee2b | ✅ test(mvp): cover flow editor recovery and delayed actions | apps/mvp/src/features/flows-ui/store.ts: main carried then changed it: 3253f42230 (⚡ perf( |
| 2026-10-24 03:38 | `5815c0d77f` | SUPERSEDED | 2/1/0/0 | 7e69a6ee2b | 🐛 fix(mvp): skip empty answer cleanup after draft admission | apps/mvp/docs/features/flows.md: main carried then changed it: 3253f42230 (⚡ perf(mvp): re |
| 2026-10-24 03:45 | `f4776e99c3` | ON-MAIN | 4/0/0/0 | f4776e99c3 | 🧪 test(mvp): await the real FileTabs persistence receipt |  |
| 2026-10-24 04:57 | `a76a8e5ff0` | SUPERSEDED | 1/1/0/0 | 7e69a6ee2b | ♻️ refactor(mvp): unify answer restore fallback | apps/mvp/src/features/flows-ui/store.ts: main carried then changed it: 3253f42230 (⚡ perf( |
| 2026-10-24 05:44 | `7e69a6ee2b` | STRANDED | 0/0/2/0 | 7e69a6ee2b | 📝 docs(mvp): record main-red validation receipts and blockers | apps/mvp/docs/work/main-reds-0024e.md: status: blocked; apps/mvp/docs/work/main-reds-0024e |
| 2026-10-24 10:44 | `53461bc3a7` | SUPERSEDED | 98/61/0/0 | 4a2cb35524 | ✨ feat(mvp): answer a person with their own model (bring your own key) | apps/mvp/AGENTS.md: main carried then changed it: d2942b1ea7 (✨ feat(mvp): model connectio |
| 2026-10-24 12:58 | `a94754bf0e` | ON-MAIN | 3/0/0/0 | a94754bf0e | 🧪 test(mvp): force both personal draft delete interleavings |  |
| 2026-10-24 21:36 | `38c2589820` | SUPERSEDED | 6/1/0/0 | cf0a8e43d4 | 🧪 test(mvp): guard conversations list data and rendering | apps/mvp/docs/work/prod-conversations-list.md: main carried then changed it: 1fa9dfd3f0 (🔍 |
| 2026-10-24 21:49 | `96b46450a2` | ON-MAIN | 3/0/0/0 | 96b46450a2 | 🧪 test(mvp): add production message pin journey |  |
| 2026-10-24 21:56 | `cf0a8e43d4` | ON-MAIN | 13/0/0/0 | cf0a8e43d4 | 🔍 chore(mvp): trace conversation list loading |  |
| 2026-10-24 22:08 | `52451867e6` | SUPERSEDED | 26/12/0/0 | 52451867e6 | 🐛 fix(mvp): scope repository runs to the viewed repository | apps/mvp/docs/decisions/0096-repository-run-scope.md: main deleted it in 95220a76de (🐛 fix |
| 2026-10-24 22:22 | `4a2cb35524` | SUPERSEDED | 23/17/0/0 | 4a2cb35524 | 🐛 fix(mvp): a demoted person removes their own model; stale and rate-l | apps/mvp/docs/features/personal-model.md: main carried then changed it: 6509ca42cc (✨ feat |
| 2026-10-25 00:59 | `8230819d61` | SUPERSEDED | 17/5/0/0 | 52a82fd63c | 🔍 chore(mvp): record content-free run route stage timings | apps/mvp/docs/features/runs.md: main carried then changed it: db603485cb (⚡ fix(mvp): rend |
| 2026-10-25 01:02 | `52a82fd63c` | SUPERSEDED | 37/7/0/0 | 52a82fd63c | ⚡ fix(mvp): render run pages before remote inspection completes | apps/mvp/docs/features/runs.md: main carried then changed it: b481761299 (🐛 fix(mvp): a re |
| 2026-10-25 03:58 | `2a64c493d2` | SUPERSEDED | 4/16/0/0 | 2a64c493d2 | ♻️ refactor(mvp): timeline summaries stay on the deployment's model wh | apps/mvp/docs/decisions/0096-personal-models.md: main carried then changed it: 35f0b33717 |
| 2026-10-25 05:37 | `b6bd7e8988` | ON-MAIN | 6/0/0/0 | b6bd7e8988 | 🧪 test(mvp): cover forms and generated views with a live model |  |
| 2026-10-25 12:48 | `f30fbdac23` | SUPERSEDED | 23/8/0/0 | f30fbdac23 | 🧪 test(mvp): make e2e repository contracts and reply assertions truthf | apps/mvp/docs/features/timeline.md: landed as ec2364e689 (same author and time, committed |
| 2026-10-25 12:48 | `cbd9b8209c` | ON-MAIN | 14/0/0/0 | cbd9b8209c | 🐛 fix(repo-view): refresh pinned VibeLang grammar and highlighting reg |  |
| 2026-10-25 12:49 | `68c0b1bc4e` | SUPERSEDED | 32/36/0/0 | a3d42af1a1 | 🐛 fix(mvp): retain repository navigation and fence deployment-only pag | apps/mvp/docs/decisions/0102-repository-page-boundaries.md: main carried then changed it: |
| 2026-10-25 12:49 | `136945052a` | PARTIAL | 31/36/0/1 | 136945052a | 🐛 fix(mvp): retain repository navigation and fence deployment-only pag | apps/mvp/docs/decisions/0099-repository-page-boundaries.md: # 0099: Repository pages retai |
| 2026-10-25 12:49 | `0cbf100ade` | PARTIAL | 36/9/0/1 | 0cbf100ade | 🐛 fix(mvp): keep notification history and spend alerts in the bell | apps/mvp/docs/decisions/0099-notification-backlog.md: # 0099: Notification backlog stays i |
| 2026-10-25 12:49 | `e3d2449249` | PARTIAL | 19/36/0/1 | e3d2449249 | 🐛 fix(mvp): retain repository navigation and fence deployment-only pag | apps/mvp/docs/decisions/0099-repository-page-boundaries.md: # 0099: Repository pages retai |
| 2026-10-25 12:49 | `6e719f421a` | PARTIAL | 19/36/0/1 | 6e719f421a |  | apps/mvp/docs/decisions/0099-repository-page-boundaries.md: # 0099: Repository pages retai |
| 2026-10-25 12:51 | `ea2890560b` | SUPERSEDED | 0/1/0/0 | ea2890560b | 🔎 docs(mvp): diagnose visitor blob loading dependency | apps/mvp/docs/work/visitor-blob-loading.md: main carried then changed it: 26e61bc9b1 (🐛 fi |
| 2026-10-25 12:53 | `11a35a00fb` | PARTIAL | 62/8/0/1 | 11a35a00fb | 🐛 fix(mvp): fail chat promptly on model quota and credit refusals | apps/mvp/docs/decisions/0099-terminal-model-refusals.md: # 0099: Model quota and credit re |
| 2026-10-25 12:53 | `ad792eea0e` | SUPERSEDED | 14/5/0/0 | ad792eea0e | 🐛 fix(mvp): contain visitor layouts and audit every mobile route | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 7236973a0d (✅ test(mvp): fail e |
| 2026-10-25 13:02 | `901ac4b864` | SUPERSEDED | 5208/48/0/0 | 901ac4b864 | 🗃️ chore(maintainer-site): Will's queue answers through 10-23 and the  | apps/maintainer-site/queue/coverage.json: landed as 0c6f850dca (same author and time, comm |
| 2026-10-25 13:05 | `f9c826bfb2` | SUPERSEDED | 15/8/0/0 | 881ea67f5a | 🐛 fix(agent,mvp): a model refusal no wait clears is asked once, and st | apps/mvp/docs/features/timeline.md: main carried then changed it: 0d2a9547c5 (🐛 fix(agent, |
| 2026-10-25 13:16 | `90ddd80c4b` | SUPERSEDED | 8/6/0/0 | c1cec07395 | 📝 docs(mvp): rulings in force on 2026-10-25, from Will's prompts throu | apps/mvp/docs/rulings.md: main carried then changed it: 236dfbe849 (📝 docs(mvp): ruling AR |
| 2026-10-25 13:20 | `e52eeeb709` | SUPERSEDED | 7/2/0/0 | e52eeeb709 | 🐛 fix(mvp): preserve VibeLang plugins through local Worker RPC | patches/vibelang@0.0.3.patch: main deleted it in fcac3830c0 (🐛 fix(mvp): preserve VibeLang |
| 2026-10-25 13:20 | `fcef966cd2` | SUPERSEDED | 27/12/0/0 | c1cec07395 | 📝 docs(mvp): feature docs and decisions say what is true on main, per  | apps/mvp/docs/decisions/0005-sandboxes-secrets-and-the-forge.md: main carried then changed |
| 2026-10-25 13:22 | `e0cf8d3448` | SUPERSEDED | 5/1/0/0 | e0cf8d3448 | 🧪 test(mvp): add deployment proofs for notifications memory status and | apps/mvp/e2e/files.spec.ts: main carried then changed it: f7697a4cc6 (🐛 fix(mvp): preserve |
| 2026-10-25 13:27 | `3994db664f` | PARTIAL | 19/1/1/1 | 3994db664f | 🔎 fix(mvp): validate production telemetry capture integrity | apps/mvp/docs/decisions/0099-production-log-capture.md: # 0099: Production log captures ne |
| 2026-10-25 13:27 | `1d2244ab90` | SUPERSEDED | 35/1/0/0 | 1d2244ab90 | 🧪 fix(mvp): scope e2e message locators to transcript bubbles | apps/mvp/e2e/sandbox-tools.spec.ts: main carried then changed it: ac162cec8a (🐛 fix(ui): r |
| 2026-10-25 13:28 | `b152a4efed` | ON-MAIN | 7/0/0/0 | b152a4efed | 🐛 fix(repo-view): preserve token hovers across parent renders |  |
| 2026-10-25 13:30 | `255f7aab3f` | SUPERSEDED | 39/10/0/0 | 881ea67f5a | ✨ feat(model,rpc,mvp): a role's model carries routing preferences and  | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-25 13:31 | `93cf6e0945` | SUPERSEDED | 50/6/0/0 | 93cf6e0945 | 🧪 test(mvp): run deployment answers with the account personal model | apps/mvp/e2e/agent.spec.ts: main carried then changed it: 0ad076e5e2 (✅ test(mvp): specs t |
| 2026-10-25 13:31 | `c1cec07395` | SUPERSEDED | 5/2/0/0 | c1cec07395 | 📝 docs(mvp): ruling ARCH-20, bring your own key at release; hosted inf | apps/mvp/docs/rulings.md: main carried then changed it: 35f0b33717 (✨ feat(mvp): people's |
| 2026-10-25 13:40 | `7027d6f38f` | PARTIAL | 60/7/0/1 | 7027d6f38f | 🐛 fix(mvp): visitors read a repository's About with the App's quota, k | apps/mvp/db/migrations/0057_repo_about.ts: fresh_until timestamptz,; apps/mvp/db/Database. |
| 2026-10-25 13:42 | `f86c26301f` | SUPERSEDED | 25/1/0/0 | f86c26301f | ✨ feat(mvp): show a step's logs like a CI log | apps/mvp/docs/observability.md: main carried then changed it: 4151397073 (🔇 fix(engine-sto |
| 2026-10-25 13:42 | `9cb95ecf7b` | ON-MAIN | 48/0/0/0 | f86c26301f | ✨ feat(engine-store): journal each action attempt's logs to its step |  |
| 2026-10-25 13:44 | `03ed62831e` | ON-MAIN | 19/0/0/0 | d92ac87502 | ✨ feat(harness): run agent steps in RealmFlow and name its refusals |  |
| 2026-10-25 13:50 | `103c5f4782` | SUPERSEDED | 56/58/0/0 | 881ea67f5a | ✨ feat(mvp): people's own models answer everything they cause; hosted  | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-25 13:52 | `881ea67f5a` | ON-MAIN | 4/0/0/0 | 881ea67f5a | 🐛 fix(mvp): a provider refusing for credit or quota no longer reads "M |  |
| 2026-10-25 13:58 | `836eee8fc1` | SUPERSEDED | 20/10/0/0 | 836eee8fc1 | 🐛 fix(mvp): signed-out pages send no branch tracking or run credential | apps/mvp/docs/features/branch-workspace.md: main carried then changed it: e1a134f198 (🐛 fi |
| 2026-10-25 13:58 | `f07447e638` | SUPERSEDED | 4/2/0/0 | 836eee8fc1 | 🐛 fix(mvp): repository tabs mark only the page's own tab current | apps/mvp/docs/features/home.md: main carried then changed it: 2f76cd1ebc (🐛 fix(mvp): auth |
| 2026-10-25 13:58 | `62d03e5552` | SUPERSEDED | 41/13/0/0 | 836eee8fc1 | 🐛 fix(mvp): a visitor's file page reads its head from RepoApi's refs,  | apps/mvp/docs/features/repo.md: main carried then changed it: a35b513380 (🐛 fix(mvp): shar |
| 2026-10-25 14:03 | `5811dc95c5` | SUPERSEDED | 65/1/0/0 | fc21037c9b | ✨ feat(mvp): every sandbox reaches the package registries, and its ima | apps/mvp/worker/BranchSandboxes.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp): |
| 2026-10-25 14:03 | `0b52629593` | SUPERSEDED | 65/1/0/0 | 0b52629593 | ✨ feat(mvp): every sandbox reaches the package registries, and its ima | apps/mvp/worker/BranchSandboxes.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp): |
| 2026-10-25 14:07 | `f88ce68d08` | SUPERSEDED | 83/1/0/0 | fc21037c9b | ✨ feat(flow): retry a settled run from one of its steps | packages/smithers/flows/flow/src/Flow/internal.ts: main carried then changed it: 3b734cb69 |
| 2026-10-25 14:07 | `486cfc1b72` | SUPERSEDED | 83/1/0/0 | ec80d9bc36 | ✨ feat(flow): retry a settled run from one of its steps | packages/smithers/flows/flow/src/Flow/internal.ts: main carried then changed it: 3b734cb69 |
| 2026-10-25 14:10 | `7b238a02c8` | PARTIAL | 132/22/0/2 | 0b52629593 | ✨ feat(mvp): sandbox budgets: awake caps, Waiting for a sandbox, and a | apps/mvp/db/migrations/0057_sandbox_budgets.ts: // Sandbox budgets (ruling AUTH-5, decisio |
| 2026-10-25 15:24 | `957a64ce94` | SUPERSEDED | 9/2/0/0 | 957a64ce94 | 🐛 fix(mvp): check open tabs for service worker releases | apps/mvp/src/main.tsx: main carried then changed it: 6843293914 (🔍 chore(mvp): record ever |
| 2026-10-25 15:25 | `a7221e50d3` | ON-MAIN | 11/0/0/0 | 72ae7f367f | 🐛 fix(mvp): a memory judge that can't answer opens the turn with no me |  |
| 2026-10-25 15:27 | `20bbb173f4` | ON-MAIN | 29/0/0/0 | 2adb786dc3 | ✨ feat(integrations): update a pull request's branch, merge into a bra |  |
| 2026-10-25 15:27 | `29ea968abc` | ON-MAIN | 29/0/0/0 | ea479e732a | ✨ feat(integrations): update a pull request's branch, merge into a bra |  |
| 2026-10-25 15:28 | `ef3e03c931` | SUPERSEDED | 106/32/0/0 | 2adb786dc3 | ✨ feat(mvp): Publish a Smithers-only branch to GitHub, Update branch,  | apps/mvp/db/Database.ts: landed as d535d7fa6d (same author and time, committed later) |
| 2026-10-25 15:28 | `1f4d6fd19e` | SUPERSEDED | 52/3/0/0 | 2adb786dc3 | 🐛 fix(mvp): a TODO's GitHub branch is made at Publish, so an attempt t | apps/mvp/docs/features/todos.md: main carried then changed it: 4e6fd708aa (✨ feat(mvp): in |
| 2026-10-25 15:28 | `9587b0616b` | SUPERSEDED | 104/34/0/0 | ea479e732a | ✨ feat(mvp): Publish a Smithers-only branch to GitHub, Update branch,  | apps/mvp/db/Database.ts: landed as d535d7fa6d (same author and time, committed later) |
| 2026-10-25 15:28 | `34f6b6dcae` | SUPERSEDED | 52/3/0/0 | ea479e732a | 🐛 fix(mvp): a TODO's GitHub branch is made at Publish, so an attempt t | apps/mvp/docs/features/todos.md: main carried then changed it: 4e6fd708aa (✨ feat(mvp): in |
| 2026-10-25 15:29 | `a508f47161` | SUPERSEDED | 42/4/0/0 | a508f47161 | 🐛 fix(mvp): refresh GitHub mirrors through durable flows | apps/mvp/src/features/repo/components/RepoPage.tsx: main carried then changed it: 8ea3e0ce |
| 2026-10-25 15:29 | `f73f1f88b1` | SUPERSEDED | 39/5/0/0 | f73f1f88b1 | 🐛 fix(mvp): refresh GitHub mirrors through durable flows | apps/mvp/docs/work/mirror-freshness.md: landed as 5cef0eb1f8 (same author and time, commit |
| 2026-10-25 15:31 | `78812ca4fb` | SUPERSEDED | 1/1/0/0 | a3d42af1a1 | 🧪 test(mvp): mark VibeLang highlighting broken on production until its | apps/mvp/e2e/vibelang-highlighting.spec.ts: main carried then changed it: 5cef0eb1f8 (🐛 fi |
| 2026-10-25 15:38 | `768bfcdc09` | SUPERSEDED | 69/8/0/0 | d92ac87502 | ✨ feat(mvp): run hand-edited personal flows in the QuickJS realm | apps/mvp/db/Database.ts: landed as b120140226 (same author and time, committed later) |
| 2026-10-25 15:49 | `c198fd52ef` | ON-MAIN | 2/0/0/0 | c198fd52ef | 🐛 fix(agent): make abandoned child startup regression deterministic |  |
| 2026-10-25 15:49 | `0f4031bfb4` | SUPERSEDED | 1/2/0/0 | 72ae7f367f | 🧪 test(mvp): byok-first reads the shared model settings and leaves the | apps/mvp/e2e/byok-first.spec.ts: main carried then changed it: 6509ca42cc (✨ feat(mvp): mo |
| 2026-10-25 15:53 | `acc4bd2767` | PARTIAL | 151/27/1/0 | 7f67d7edde | 🔒 fix(mvp): branches, TODO runs and the page's buttons follow the role | apps/mvp/worker/test/repos.ts: // Without the App, a person has a role only on the deploym |
| 2026-10-25 15:53 | `123462b447` | SUPERSEDED | 151/28/0/0 | cf75af2bd1 | 🔒 fix(mvp): branches, TODO runs and the page's buttons follow the role | apps/mvp/docs/features/issues.md: main carried then changed it: b1e28c1e5c (✨ feat(mvp): t |
| 2026-10-25 16:00 | `ec80d9bc36` | SUPERSEDED | 51/1/0/0 | ec80d9bc36 | ✨ feat(mvp): Retry from here on a run's step | apps/mvp/src/features/runs/components/RunPageView.tsx: main carried then changed it: 553d7 |
| 2026-10-25 16:00 | `dd01c82b9f` | SUPERSEDED | 48/1/0/0 | fc21037c9b | ✨ feat(mvp): Retry from here on a run's step | apps/mvp/src/features/runs/components/RunPageView.tsx: main carried then changed it: 553d7 |
| 2026-10-25 16:01 | `6a7e72acd2` | SUPERSEDED | 106/11/0/0 | fc21037c9b | ✨ feat(mvp): runs read like GitHub Actions, with Cloud runs beside thi | apps/mvp/docs/features/runs.md: main carried then changed it: 6855753cba (✨ feat(mvp): sto |
| 2026-10-25 16:01 | `2408fbc7b9` | SUPERSEDED | 106/11/0/0 | ec80d9bc36 | ✨ feat(mvp): runs read like GitHub Actions, with Cloud runs beside thi | apps/mvp/docs/features/runs.md: main carried then changed it: 6855753cba (✨ feat(mvp): sto |
| 2026-10-25 16:01 | `b79eddb780` | SUPERSEDED | 3/3/0/0 | 7b5d0a2135 | ⚡ fix(mvp): hold Electric's container once per object, and record each | apps/mvp/docs/infrastructure.md: main carried then changed it: cb80f2e0e5 (🔍 fix(mvp): the |
| 2026-10-25 16:05 | `a86869e604` | ON-MAIN | 7/0/0/0 | a86869e604 | 🐛 fix(test): pin cell console examples and scope quickstart workspaces |  |
| 2026-10-25 16:08 | `0f0c11e2db` | PARTIAL | 12/6/0/1 | 7f67d7edde | ✨ feat(mvp): the issues' and pull requests' shapes, the webhook and Re | apps/mvp/worker/github/Api.test.ts: const h = await githubHarness(runtime, { own: OWN, act |
| 2026-10-25 16:08 | `cf75af2bd1` | SUPERSEDED | 13/6/0/0 | cf75af2bd1 | ✨ feat(mvp): the issues' and pull requests' shapes, the webhook and Re | apps/mvp/docs/decisions/0079-roles-per-repository.md: main carried then changed it: b1e28c |
| 2026-10-25 16:08 | `f57845b9e8` | SUPERSEDED | 12/7/0/0 | 2adb786dc3 | ✨ feat(mvp): the issues' and pull requests' shapes, the webhook and Re | apps/mvp/docs/decisions/0079-roles-per-repository.md: main carried then changed it: b1e28c |
| 2026-10-25 16:10 | `3cb5972dce` | SUPERSEDED | 25/9/0/0 | 7f67d7edde | ♻️ refactor(mvp): one answer says whether a repository is the deployme | apps/mvp/docs/decisions/0102-repository-page-boundaries.md: main carried then changed it: |
| 2026-10-25 16:10 | `2578574efb` | SUPERSEDED | 25/9/0/0 | cf75af2bd1 | ♻️ refactor(mvp): one answer says whether a repository is the deployme | apps/mvp/docs/decisions/0102-repository-page-boundaries.md: main carried then changed it: |
| 2026-10-25 16:14 | `7b5d0a2135` | SUPERSEDED | 13/6/0/0 | 7b5d0a2135 | 🐛 fix(mvp): a repository's Runs says it has none only once its runs ha | apps/mvp/src/features/runs/components/RepoRunsView.tsx: main carried then changed it: 3edb |
| 2026-10-25 16:15 | `d92ac87502` | ON-MAIN | 1/0/0/0 | d92ac87502 | 📝 docs(mvp): record that FLOW-2's QuickJS realm host is applied |  |
| 2026-10-25 16:16 | `e4a8c2f4d1` | SUPERSEDED | 161/22/0/0 | e4a8c2f4d1 | ✨ feat(mvp): a repository's issues and pull requests sync per reposito | apps/mvp/docs/features/pulls.md: main carried then changed it: 16637103d4 (⚡ perf(mvp): a |
| 2026-10-25 16:16 | `7f67d7edde` | SUPERSEDED | 123/21/0/0 | 7f67d7edde |  | apps/mvp/docs/features/pulls.md: main carried then changed it: 16637103d4 (⚡ perf(mvp): a |
| 2026-10-25 16:29 | `086bc55155` | SUPERSEDED | 35/4/0/0 | fc21037c9b | ✨ feat(mvp): Markdown is an editable WYSIWYG in the repository view fo | apps/mvp/src/features/branch/branch.ts: main carried then changed it: 124fdc7e00 (🔍 chore( |
| 2026-10-25 16:29 | `a3d42af1a1` | PARTIAL | 5/0/2/0 | a3d42af1a1 | 🐛 fix(mvp): provide spend alerts in repository page regression | apps/mvp/docs/work/repo-pages.md: Second bounce: reproduced empty static HTML on the merge |
| 2026-10-25 16:29 | `0248f7382b` | SUPERSEDED | 35/4/0/0 | d66d5c7b47 | ✨ feat(mvp): Markdown is an editable WYSIWYG in the repository view fo | apps/mvp/src/features/branch/branch.ts: main carried then changed it: 124fdc7e00 (🔍 chore( |
| 2026-10-25 16:30 | `063279d162` | SUPERSEDED | 118/29/0/0 | fc21037c9b | ✨ feat(mvp): a repository and its issues live in the chat shell: ui/re | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-25 16:30 | `78fe15b9e5` | SUPERSEDED | 118/29/0/0 | d66d5c7b47 | ✨ feat(mvp): a repository and its issues live in the chat shell: ui/re | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-25 16:32 | `f0361728cf` | SUPERSEDED | 7/5/0/0 | f0361728cf | 🐛 fix(ui): repair model form layout and isolate sweep fixtures | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: 56f2b8e408 (🐛 fix: restore mobi |
| 2026-10-25 16:35 | `c5f3064a14` | ON-MAIN | 60/0/0/0 | c5f3064a14 | 🐛 fix: repair SDK validation reds without relaxing checks |  |
| 2026-10-25 16:35 | `a03ccd3ae2` | ON-MAIN | 10/0/0/0 | a03ccd3ae2 | 🔎 fix(mvp): record why branch machines stay awake |  |
| 2026-10-25 16:35 | `72ae7f367f` | ON-MAIN | 3/0/0/0 | 72ae7f367f | 🧪 test(mvp): byok-first opens Chat before looking for Add your model |  |
| 2026-10-25 16:40 | `a2700f408f` | ON-MAIN | 2/0/0/0 | fc21037c9b | 🐛 fix(mvp): the show-repo and show-issues scripted agents read the rep |  |
| 2026-10-25 16:40 | `d66d5c7b47` | ON-MAIN | 2/0/0/0 | d66d5c7b47 | 🐛 fix(mvp): the show-repo and show-issues scripted agents read the rep |  |
| 2026-10-25 16:56 | `90cb745403` | SUPERSEDED | 9/2/0/0 | 90cb745403 | 🐛 fix(mvp): settle permanent clone launch refusals and await retry out | apps/mvp/e2e/repo-browse.spec.ts: main carried then changed it: 402074942b (🐛 fix(mvp): se |
| 2026-10-25 17:10 | `34846fb31b` | SUPERSEDED | 7/2/0/0 | fc21037c9b | 🔍 fix(mvp): the Electric gateway's records reach Workers Logs as one J | apps/mvp/infra/ElectricAwake.test.ts: main carried then changed it: f352f2f654 (⚡ perf(mvp |
| 2026-10-25 17:10 | `bed27586b8` | SUPERSEDED | 7/2/0/0 | bed27586b8 | 🔍 fix(mvp): the Electric gateway's records reach Workers Logs as one J | apps/mvp/infra/ElectricAwake.test.ts: main carried then changed it: f352f2f654 (⚡ perf(mvp |
| 2026-10-25 17:11 | `d311f0edee` | ON-MAIN | 18/0/0/0 | 4fb9c67761 | 🐛 fix(mvp): preserve complete graph results and notification navigatio |  |
| 2026-10-25 17:11 | `c528165c0e` | ON-MAIN | 18/0/0/0 | c528165c0e | 🐛 fix(mvp): preserve complete graph results and notification navigatio |  |
| 2026-10-25 17:11 | `36692137ae` | SUPERSEDED | 14/3/0/0 | 36692137ae | 🐛 fix(mvp): open notification answers and preserve debug evidence | apps/mvp/docs/features/runs.md: landed as f7697a4cc6 (same author and time, committed late |
| 2026-10-25 17:11 | `916f76218a` | ON-MAIN | 15/0/0/0 | fc21037c9b | 🔍 fix(mvp): the agent's cell records, whole browser log lines, and the |  |
| 2026-10-25 17:11 | `5ab70758aa` | ON-MAIN | 8/0/0/0 | fc21037c9b | 🐛 fix(harness): a successful ctx.call's object result answers .ok as t |  |
| 2026-10-25 17:11 | `9972a50329` | ON-MAIN | 15/0/0/0 | 9972a50329 | 🔍 fix(mvp): the agent's cell records, whole browser log lines, and the |  |
| 2026-10-25 17:11 | `14486ff424` | ON-MAIN | 8/0/0/0 | 9972a50329 | 🐛 fix(harness): a successful ctx.call's object result answers .ok as t |  |
| 2026-10-25 17:20 | `075fb988d7` | SUPERSEDED | 7/2/0/0 | 2adb786dc3 | 📝 docs(mvp): Publish and Update branch; Opening a PR from a branch was | apps/mvp/docs/features/branch-publish.md: main carried then changed it: f4a418347f (✨ feat |
| 2026-10-25 17:20 | `538cd6fa50` | SUPERSEDED | 7/2/0/0 | ea479e732a | 📝 docs(mvp): Publish and Update branch; Opening a PR from a branch was | apps/mvp/docs/features/branch-publish.md: main carried then changed it: f4a418347f (✨ feat |
| 2026-10-25 17:20 | `6cefbec5de` | SUPERSEDED | 21/3/0/0 | fc21037c9b | 🐛 fix(mvp): a crowd of About requests never resumes on another request | apps/mvp/worker/RepoAbout.ts: main carried then changed it: c7b0cc3c95 (🐛 fix(mvp): scope |
| 2026-10-25 17:20 | `4dceac5135` | SUPERSEDED | 21/3/0/0 | 5f403ca906 | 🐛 fix(mvp): a crowd of About requests never resumes on another request | apps/mvp/worker/RepoAbout.ts: main carried then changed it: c7b0cc3c95 (🐛 fix(mvp): scope |
| 2026-10-25 17:25 | `dd7765b429` | PARTIAL | 48/10/0/1 | dd7765b429 | ⚡ perf(mvp): render a cold first load without waiting on the flow edit | apps/mvp/docs/decisions/0102-first-load.md: # 0102: First load waits for nothing it doesn' |
| 2026-10-25 17:25 | `505bb7c76d` | SUPERSEDED | 14/1/0/0 | dd7765b429 | ⚡ perf(platform-browser): keep the access-handle pool's databases in a | packages/smithers/flows/platform-browser/docs/api.md: main carried then changed it: 6bd378 |
| 2026-10-25 17:34 | `fc21037c9b` | SUPERSEDED | 10/6/0/0 | fc21037c9b | 🔧 chore: regenerate the device schema lock (views v5), the public API  | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: 5 |
| 2026-10-25 17:38 | `5f403ca906` | SUPERSEDED | 10/2/0/0 | 5f403ca906 | 🛡️ fix(mvp): guard Worker request-owned I/O and prove cold About concu | apps/mvp/PACKAGE.ts: main carried then changed it: a00cb4f967 (🔧 chore(mvp): lint rule fro |
| 2026-10-25 17:53 | `d2203e8b86` | ON-MAIN | 8/0/0/0 | d2203e8b86 | 🧪 test(mvp): derive docs journeys from the live index |  |
| 2026-10-25 18:07 | `ee9ebb1b60` | SUPERSEDED | 41/32/0/0 | 7f67d7edde | 🐛 fix(mvp): summarize each finished answer once for every tab and devi | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-25 18:07 | `819f48d117` | SUPERSEDED | 41/32/0/0 | 819f48d117 | 🐛 fix(mvp): summarize each finished answer once for every tab and devi | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-25 18:07 | `3285d5e1f9` | PARTIAL | 39/33/0/1 | 3285d5e1f9 | 🐛 fix(mvp): summarize each finished answer once for every tab and devi | apps/mvp/db/migrations/0064_timeline_summaries.ts: person_id text NOT NULL,; apps/mvp/db/D |
| 2026-10-25 18:26 | `bbdc1ccf1f` | PARTIAL | 86/122/0/1 | 7d062cf108 | ✨ feat(mvp): model tiers (fast, implement, hard) across a person's own | apps/mvp/docs/decisions/0104-model-tiers.md: answering in conversation. The model package |
| 2026-10-25 18:26 | `63d01c960b` | SUPERSEDED | 102/107/0/0 | 2adb786dc3 | ✨ feat(mvp): model tiers (fast, implement, hard) across a person's own | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-25 18:26 | `7876a05eca` | PARTIAL | 87/121/0/1 | baac407a47 | ✨ feat(mvp): model tiers (fast, implement, hard) across a person's own | apps/mvp/docs/decisions/0104-model-tiers.md: answering in conversation. The model package |
| 2026-10-25 18:32 | `f2878117a5` | SUPERSEDED | 89/18/0/0 | 7d062cf108 | ✨ feat(mvp): report a bug from the app with /bug, the header or the ag | apps/mvp/db/Database.test.ts: landed as 6e2a7c27ec (same author and time, committed later) |
| 2026-10-25 18:32 | `db8111ef1c` | SUPERSEDED | 88/17/0/0 | 2adb786dc3 | ✨ feat(mvp): report a bug from the app with /bug, the header or the ag | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-25 18:32 | `b88367bfbe` | PARTIAL | 87/17/0/1 | 84810da5d9 | ✨ feat(mvp): report a bug from the app with /bug, the header or the ag | apps/mvp/db/migrations/0063_bug_reports.ts: viewport text NOT NULL,; apps/mvp/db/Database. |
| 2026-10-25 18:45 | `7d062cf108` | SUPERSEDED | 16/3/0/0 | 7d062cf108 | 🐛 fix(mvp): send a role's reasoning effort only to models that take on | apps/mvp/docs/features/jev.md: main carried then changed it: d2942b1ea7 (✨ feat(mvp): mode |
| 2026-10-25 18:45 | `b33f0ffa24` | SUPERSEDED | 17/3/0/0 | 2adb786dc3 | 🐛 fix(mvp): send a role's reasoning effort only to models that take on | apps/mvp/docs/features/jev.md: main carried then changed it: d2942b1ea7 (✨ feat(mvp): mode |
| 2026-10-25 18:45 | `baac407a47` | SUPERSEDED | 16/3/0/0 | baac407a47 | 🐛 fix(mvp): send a role's reasoning effort only to models that take on | apps/mvp/docs/features/jev.md: main carried then changed it: d2942b1ea7 (✨ feat(mvp): mode |
| 2026-10-25 18:48 | `ea479e732a` | SUPERSEDED | 136/9/0/0 | ea479e732a |  | apps/mvp/db/Database.ts: landed as f4a418347f (same author and time, committed later) |
| 2026-10-25 18:48 | `5148360a59` | SUPERSEDED | 124/9/0/0 | 5148360a59 | ✨ feat(mvp): Resync brings a published branch's Smithers branch and wo | apps/mvp/db/Database.ts: landed as f4a418347f (same author and time, committed later) |
| 2026-10-25 18:48 | `1ea9f8b41a` | SUPERSEDED | 136/9/0/0 | 1ea9f8b41a |  | apps/mvp/db/Database.ts: landed as f4a418347f (same author and time, committed later) |
| 2026-10-25 18:48 | `1e4b5aa69a` | ON-MAIN | 8/0/0/0 | 5148360a59 | ✨ feat(effect-code-storage): createBranch moves a branch that exists w |  |
| 2026-10-25 18:48 | `ed50229dcb` | ON-MAIN | 4/0/0/0 | 5148360a59 | ✨ feat(sandbox): plan, then apply, a working copy's move onto a fetche |  |
| 2026-10-25 18:53 | `7b0db4127e` | SUPERSEDED | 26/5/0/0 | 7d062cf108 | 🐛 fix(mvp): a bug report that isn't sent says why and offers Retry, ne | apps/mvp/docs/features/bugs.md: main carried then changed it: 9662836059 (🐛 fix: land W13 |
| 2026-10-25 18:53 | `23ea9d767e` | SUPERSEDED | 26/5/0/0 | 2adb786dc3 | 🐛 fix(mvp): a bug report that isn't sent says why and offers Retry, ne | apps/mvp/docs/features/bugs.md: main carried then changed it: 9662836059 (🐛 fix: land W13 |
| 2026-10-25 18:53 | `3aa22b5f6d` | SUPERSEDED | 26/5/0/0 | 84810da5d9 | 🐛 fix(mvp): a bug report that isn't sent says why and offers Retry, ne | apps/mvp/docs/features/bugs.md: main carried then changed it: 9662836059 (🐛 fix: land W13 |
| 2026-10-25 19:09 | `d28e27bef3` | SUPERSEDED | 6/3/0/0 | 2adb786dc3 | 🔧 chore: regenerate the device schema lock (bug reports, notifications | .smithers/flows/release/fixtures/public-api-baseline.json: main carried then changed it: b |
| 2026-10-25 19:12 | `ff61538549` | ON-MAIN | 23/0/0/0 | ff61538549 | 🐛 fix(mvp): a GitHub shape read never waits on another request's read- |  |
| 2026-10-25 19:12 | `a336eca951` | ON-MAIN | 3/0/0/0 | ff61538549 | ✅ test(mvp): read each workerd test response body as it arrives |  |
| 2026-10-25 19:15 | `2049112845` | ON-MAIN | 4/0/0/0 | 2adb786dc3 | 🧪 test(mvp): GitHub route tests provide BranchRoles, which Publish and |  |
| 2026-10-25 19:16 | `4fb9c67761` | SUPERSEDED | 8/2/0/0 | 4fb9c67761 | 🐛 fix(auth): skip signed-out run credential minting and renewal | apps/mvp/docs/features/sign-in.md: main carried then changed it: 124ec0320f (🐛 fix(mvp): k |
| 2026-10-25 19:16 | `a7c024885e` | SUPERSEDED | 8/2/0/0 | a7c024885e | 🐛 fix(auth): skip signed-out run credential minting and renewal | apps/mvp/docs/features/sign-in.md: main carried then changed it: 124ec0320f (🐛 fix(mvp): k |
| 2026-10-25 19:29 | `47a14d9bf9` | SUPERSEDED | 1/1/0/0 | 7f67d7edde | 🧪 test(mvp): the run page's loading test routes with the repository, a | apps/mvp/tests/RunPage.loading.test.ts: main carried then changed it: 2c02d5f116 (🐛 fix(ru |
| 2026-10-25 19:29 | `07d1ba1f95` | SUPERSEDED | 1/1/0/0 | cf75af2bd1 | 🧪 test(mvp): the run page's loading test routes with the repository, a | apps/mvp/tests/RunPage.loading.test.ts: main carried then changed it: 2c02d5f116 (🐛 fix(ru |
| 2026-10-25 19:46 | `20acd0d7f6` | ON-MAIN | 8/0/0/0 | 20acd0d7f6 | 🔧 chore(mvp): lint rule frontend/failure-observed |  |
| 2026-10-25 19:46 | `310642630e` | PARTIAL | 313/16/1/4 | 20acd0d7f6 | 🔍 chore(mvp): log each feature's failures once, with a code | apps/mvp/src/features/issues/writes.ts: }).pipe(Effect.mapError(() => new Outbox.Retry({}) |
| 2026-10-25 19:46 | `5c0eba5bda` | PARTIAL | 59/4/0/1 | 20acd0d7f6 | 🔍 chore(mvp): record every frontend error: failed requests, uncaught e | apps/mvp/docs/decisions/0107-frontend-failures-recorded-once.md: # 0107 — Every frontend f |
| 2026-10-25 19:46 | `a756b55975` | SUPERSEDED | 9/2/0/0 | 20acd0d7f6 | 🔍 chore(platform-browser): log a worker's uncaught errors and its stop | packages/smithers/flows/platform-browser/docs/api.md: main carried then changed it: 6bd378 |
| 2026-10-25 19:46 | `5f4743a386` | SUPERSEDED | 6/1/0/0 | 20acd0d7f6 | 🔍 chore(effect-electric): log and count a stopped shape | packages/effect-electric/test/ElectricCollection.test.ts: main carried then changed it: 3b |
| 2026-10-25 19:46 | `ee1de5cc4a` | SUPERSEDED | 28/11/0/0 | 20acd0d7f6 | 🔍 chore(effect-tanstack-db): log outbox retries, refusals, parked writ | packages/effect-tanstack-db/docs/api.md: main carried then changed it: 9662836059 (🐛 fix: |
| 2026-10-25 19:46 | `99e1abaafb` | ON-MAIN | 7/0/0/0 | 20acd0d7f6 | 🔍 chore(flow): log and count each failed step attempt by its code |  |
| 2026-10-25 19:46 | `57c9e04676` | ON-MAIN | 16/0/0/0 | 20acd0d7f6 | ✨ feat(observability): count logged failures and record failed request |  |
| 2026-10-25 19:46 | `c644830e64` | SUPERSEDED | 4/1/0/0 | 84810da5d9 | ✅ test(mvp): agent eval cases for the bug flows, and the plugins' slas | apps/mvp/src/features/commands/commands.test.ts: main carried then changed it: b75c419f1d |
| 2026-10-25 19:50 | `001ee3d1f0` | SUPERSEDED | 62/4/0/0 | 4fb9c67761 | ✨ feat(mvp): a bug report carries the tab's latest error records | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-25 19:50 | `84810da5d9` | PARTIAL | 57/8/0/1 | 84810da5d9 | ✨ feat(mvp): a bug report carries the tab's latest error records | apps/mvp/db/migrations/0065_bug_report_errors.ts: ALTER TABLE bug_reports; apps/mvp/db/Dat |
| 2026-10-25 20:06 | `84439cb431` | SUPERSEDED | 25/8/0/0 | d693d0e3d4 | 🔇 fix(engine-store): log registration recovery once per engine start | apps/mvp/docs/observability.md: main carried then changed it: 541e823190 (⚡ perf(engine-st |
| 2026-10-25 20:07 | `f726f3b6cc` | SUPERSEDED | 33/4/0/0 | d693d0e3d4 | ✅ test(mvp): fail every e2e test on server, console and page errors | apps/mvp/docs/infrastructure.md: main carried then changed it: f0fab7e22a (✅ fix(mvp): e2e |
| 2026-10-25 20:13 | `2adb786dc3` | SUPERSEDED | 6/4/0/0 | 2adb786dc3 | 🧪 test(mvp): complete branch publish eval and coverage gates | apps/mvp/docs/features/agent-evals.md: landed as 88a5f6c837 (same author and time, committ |
| 2026-10-25 20:13 | `e796863977` | ON-MAIN | 6/0/0/0 | e796863977 | wip |  |
| 2026-10-25 20:15 | `d693d0e3d4` | ON-MAIN | 19/0/0/0 | d693d0e3d4 | 🔇 fix(effect-tanstack-db): log a tab's persisted sync roles once |  |
| 2026-10-25 21:24 | `709a9b4085` | PARTIAL | 6/1/0/1 | 709a9b4085 | 🐛 fix(mvp): keep repository Full screen at its displayed revision | apps/mvp/docs/decisions/0107-embed-full-screen-revision.md: # 0107: Full screen preserves |
| 2026-10-25 21:35 | `1ceb6dfc59` | ON-MAIN | 7/0/0/0 | 1ceb6dfc59 | 🧪 fix(e2e): locate the exported Vite config token uniquely |  |
| 2026-10-25 21:37 | `82e7357ae5` | EMPTY-ISH | 0/0/0/0 | 82e7357ae5 |  |  |
| 2026-10-25 21:37 | `4b37b4b97f` | PARTIAL | 0/0/0/1 | 4b37b4b97f |  | apps/mvp/worker/test/workerd/shapes.ts: // Branch routes the GitHub routes reach (Publish, |
| 2026-10-25 21:51 | `34f0c5687b` | EMPTY-ISH | 0/0/0/0 | 34f0c5687b |  |  |
| 2026-10-25 22:24 | `be9b5ceab1` | SUPERSEDED | 27/2/0/0 | be9b5ceab1 | 🐛 fix(github): bound stale issue reconcile admission | apps/mvp/docs/features/issues.md: main carried then changed it: b1e28c1e5c (✨ feat(mvp): t |
| 2026-10-25 22:33 | `5d08f1c6b6` | SUPERSEDED | 25/3/0/0 | 5d08f1c6b6 | 🧪 test(mvp): local specs settle what they left waiting, take turns in  | apps/mvp/e2e/loading.ts: main carried then changed it: 024272d7f8 (💄 fix(mvp,ui): toasts o |
| 2026-10-25 22:33 | `97a14668c4` | SUPERSEDED | 3/1/0/0 | 5d08f1c6b6 | 🐛 fix(mvp): a chat page's Full screen and the issues or pull requests  | apps/mvp/src/screens/issues/issues-screen.css: main carried then changed it: cf9b8a0d72 (🎨 |
| 2026-10-25 22:33 | `f0b7809234` | SUPERSEDED | 7/4/0/0 | 5d08f1c6b6 | 🐛 fix(mvp): phone tap targets on repository pages, the bell in every r | apps/mvp/src/features/attention/contract.ts: main carried then changed it: 31cf6df796 (🐛 f |
| 2026-10-25 22:33 | `91f159eade` | ON-MAIN | 3/0/0/0 | 5d08f1c6b6 | 🧪 test(mvp): wait out a full page load on a busy dev server; Effect's  |  |
| 2026-10-25 22:33 | `0254ca2fb2` | ON-MAIN | 39/0/0/0 | 5d08f1c6b6 | ✅ test(mvp): specs that wait for a real model's answer declare liveMod |  |
| 2026-10-25 22:36 | `9e643e7a6e` | SUPERSEDED | 34/20/0/0 | 9e643e7a6e | 🐛 fix(mvp): authorize repository shapes before requesting them | apps/mvp/docs/features/issues.md: main carried then changed it: c4954e045c (✨ feat(mvp): a |
| 2026-10-25 23:46 | `3fe0e8dc59` | SUPERSEDED | 4/1/0/0 | 802d2e3ff6 | 🐛 fix(mvp): keep signed-out person flows anonymous | apps/mvp/docs/work/w3-followups.md: main carried then changed it: 788ea6bf89 (🐛 fix(mvp): |
| 2026-10-25 23:49 | `802d2e3ff6` | SUPERSEDED | 6/2/0/0 | 802d2e3ff6 | 🐛 fix(mvp): complete taken timeline summaries without errors | apps/mvp/docs/features/timeline.md: main carried then changed it: b65aa03472 (✨ feat(timel |
| 2026-10-25 23:49 | `93214f4f76` | SUPERSEDED | 2/2/0/0 | 802d2e3ff6 | 🧪 test(mvp): assert repository-scoped contribute prompts | apps/mvp/e2e/vibelang-contributor.spec.ts: main carried then changed it: cee32948f8 (🧪 tes |
| 2026-10-26 03:44 | `0e3a7c85c5` | ON-MAIN | 134/0/0/0 | 0e3a7c85c5 | ⬆️ chore(deps): VibeLang 0.0.8 |  |
| 2026-10-26 04:36 | `6cfc84bf97` | SUPERSEDED | 6/2/0/0 | f76c88ee90 | 🐛 fix: read absent repository homes without failed requests | apps/mvp/src/features/repo/api.ts: main carried then changed it: b3cef5df53 (🐛 fix(mvp): r |
| 2026-10-26 04:36 | `47ecaf0948` | SUPERSEDED | 13/3/0/0 | 47ecaf0948 | 🐛 fix: restore mobile control hit areas and settings audit | apps/mvp/e2e/mobile.spec.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp): model |
| 2026-10-26 04:38 | `b03f4e82fb` | ON-MAIN | 5/0/0/0 | b03f4e82fb | 🧪 test(mvp): identify repository chat views by their write receipts |  |
| 2026-10-26 04:38 | `f76c88ee90` | ON-MAIN | 1/0/0/0 | f76c88ee90 | 🧪 test: open chat before publishing a new branch |  |
| 2026-10-26 07:04 | `9d9cca6e72` | ON-MAIN | 8/0/0/0 | 9d9cca6e72 | 🧪 test(mvp): isolate home fixtures and preserve upstream branch refs |  |
| 2026-10-26 07:41 | `ff05330075` | ON-MAIN | 5/0/0/0 | ff05330075 | 🐛 fix(mvp): the live editor opens a path with nothing at it as a new,  |  |
| 2026-10-26 07:44 | `0712915ee7` | PARTIAL | 6/3/7/0 | 0712915ee7 | 🐛 fix(mvp): keep mobile controls reachable and branch tabs unclipped | .changeset/mobile-home-announcement-target.md: Give repository home announcement links the |
| 2026-10-26 08:32 | `7897cc2847` | SUPERSEDED | 19/10/0/0 | 7897cc2847 | ⚡ perf(mvp): Electric's object returns responses untouched; overload a | apps/mvp/docs/infrastructure.md: main carried then changed it: 86c73b0883 (⚡ feat(mvp): ca |
| 2026-10-26 08:32 | `95805eabbb` | SUPERSEDED | 31/6/0/0 | 95805eabbb | ⚡ perf(mvp): a tab requests only the shapes its person and page read | apps/mvp/docs/features/pulls.md: landed as 16637103d4 (same author and time, committed lat |
| 2026-10-26 08:33 | `cf3efa4272` | SUPERSEDED | 16/1/0/0 | f23a59978f | ✨ feat(effect-electric): ShapeProxy sends a canonical upstream URL and | packages/effect-electric/src/ShapeProxy.ts: main carried then changed it: a93d2152f8 (🐛 fi |
| 2026-10-26 09:19 | `f23a59978f` | SUPERSEDED | 21/2/0/0 | f23a59978f | 🔒 feat(mvp): ChatApi reaches Electric's gateway by service binding; ga | apps/mvp/infra/ElectricGateway.ts: main carried then changed it: f352f2f654 (⚡ perf(mvp): |
| 2026-10-26 10:04 | `f1c5aa3fa3` | SUPERSEDED | 5/4/0/0 | f775ac74e1 | 🔎 fix(mvp): diagnose GitHub visibility metadata refusals | apps/mvp/docs/features/issues.md: main carried then changed it: 2a79af05cf (⚡ fix(mvp): ca |
| 2026-10-26 10:07 | `f775ac74e1` | ON-MAIN | 18/0/0/0 | f775ac74e1 | ⚡ fix(mvp): cache completed repository visibility for 60 seconds |  |
| 2026-10-26 10:31 | `2c482772b1` | SUPERSEDED | 12/2/0/0 | 2c482772b1 | 🐛 fix(mvp): distinguish unimported refs and assert permitted home bloc | apps/mvp/docs/decisions/0112-unimported-repository-refs.md: main deleted it in 1ac04f617b |
| 2026-10-26 10:32 | `34a5052973` | SUPERSEDED | 12/8/0/0 | 34a5052973 | 🐛 fix(mvp): preserve the person through Publish subflows | apps/mvp/docs/features/branch-publish.md: main carried then changed it: 18a9d5a9fa (🐛 fix( |
| 2026-10-26 11:34 | `09bef4c277` | PARTIAL | 0/0/38/4 | 380d7b2e82 | ⚡ feat(mvp): stage Electric gateway cache on non-live items | apps/mvp/bench/electric-load/report.ts: if (r.aborted > 0 \|\| records.some((record) => re |
| 2026-10-26 12:14 | `0578318252` | SUPERSEDED | 7/2/0/0 | 0578318252 | 🐛 fix(mvp): keep cold pull lists usable without a spinner | apps/mvp/docs/features/pulls.md: main carried then changed it: d3985028c7 (✨ feat(pulls): |
| 2026-10-26 12:40 | `09330a9ef9` | STRANDED | 0/0/3/0 | 380d7b2e82 | ⚡ feat(mvp): trial live Electric request collapsing | apps/mvp/docs/infrastructure.md: The S5 non-live `items`-only trial deployed successfully |
| 2026-10-26 12:46 | `3c00fb3fe3` | SUPERSEDED | 5/1/0/0 | 380d7b2e82 | 🔒 fix(mvp): strip legacy credentials before private Electric binding | apps/mvp/infra/ElectricUpstream.test.ts: main carried then changed it: 86c73b0883 (⚡ feat( |
| 2026-10-26 12:49 | `380d7b2e82` | STRANDED | 0/0/2/0 | 380d7b2e82 | 🧪 perf(mvp): measure standard-1 Electric capacity with cache | apps/mvp/infra/ElectricGateway.ts: instanceType: "standard-1",; apps/mvp/infra/ElectricGat |
| 2026-10-26 13:01 | `93a8535b90` | SUPERSEDED | 7/2/0/0 | builder/electric-s5b | 🔒 fix(mvp): keep legacy credentials out of private Electric requests | apps/mvp/docs/work/electric-gateway-cache.md: main carried then changed it: 86c73b0883 (⚡ |
| 2026-10-26 13:36 | `b93385eea5` | STRANDED | 0/0/7/0 | builder/electric-s5b | 🔬 perf(mvp): sample private Electric metrics for readiness diagnosis | apps/mvp/docs/work/electric-gateway-cache.md: status: in-progress; apps/mvp/infra/Electric |
| 2026-10-26 14:06 | `a1ada1cb58` | ON-MAIN | 23/0/0/0 | a1ada1cb58 | 🐛 fix(mvp): retain person authority across publish continuations |  |
| 2026-10-26 14:07 | `81a10938f8` | ON-MAIN | 12/0/0/0 | 81a10938f8 | 🐛 fix(mvp): authenticate curated public About reads |  |
| 2026-10-26 14:19 | `7e1be9feac` | PARTIAL | 1/0/5/4 | builder/electric-s5b | 🔬 perf(mvp): measure keyed live Electric cache and failure stages | apps/mvp/infra/ElectricCache.test.ts: expect(cachePolicy(HttpServerResponse.empty({ status |
| 2026-10-26 15:06 | `66125346d8` | SUPERSEDED | 0/1/0/0 | builder/electric-s5b | 🧪 test(mvp): isolate one-second Electric live hold from its five-secon | apps/mvp/infra/ElectricGateway.ts: changed later in its stack (head 77972d9a1e, 5161fb86b1 |
| 2026-10-26 15:18 | `ed5d4dc00a` | STRANDED | 0/0/1/0 | builder/electric-s5b | 🧪 test(mvp): isolate ten-second Electric polling below observed collap | apps/mvp/infra/ElectricGateway.ts: env: { ELECTRIC_INSECURE: "true", ELECTRIC_DB_POOL_SIZE |
| 2026-10-26 15:37 | `77972d9a1e` | PARTIAL | 1/0/1/0 | builder/electric-s5b | 🧪 test(mvp): retain S5b live-collapse proof and unresolved freshness b | apps/mvp/docs/work/electric-gateway-cache.md: S5b proved five 100-caller live cases with a |
| 2026-10-26 16:07 | `b499a383cc` | PARTIAL | 58/8/0/1 | b499a383cc | ⚡️ perf(mvp): defer repository text shapes until detail demand | apps/mvp/docs/decisions/0115-shape-payloads.md: # 0115: Lists sync facts; detail pages syn |
| 2026-10-26 16:07 | `0f24d3d3a3` | SUPERSEDED | 16/8/0/0 | builder/electric-s5c | ⚡ feat(mvp): cache private Electric reads and collapse live polls | apps/mvp/docs/infrastructure.md: landed as 86c73b0883 (same author and time, committed lat |
| 2026-10-26 17:39 | `16410b139e` | ON-MAIN | 4/0/0/0 | 16410b139e | 🧪 fix(mvp): append a paragraph in the Markdown publish journey |  |
| 2026-10-26 17:51 | `bca288d2b7` | SUPERSEDED | 20/1/0/0 | 58a30dbc71 | 🔒 fix(mvp): gate repository actions on member authority | apps/mvp/src/features/runs/store.ts: main carried then changed it: 9defdffd30 (🐛 fix(runs) |
| 2026-10-26 17:53 | `58a30dbc71` | SUPERSEDED | 20/2/0/0 | 58a30dbc71 | 🐛 fix(mvp): scope cached About refusals to their quota | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-26 19:21 | `584d0000e6` | ON-MAIN | 12/0/0/0 | 584d0000e6 | ⚡ perf(flow): format a declaration's stack only when its site is read |  |
| 2026-10-26 19:21 | `ec33db8c91` | SUPERSEDED | 20/1/0/0 | ec33db8c91 | ⚡ perf(mvp): start the engine worker's session read first; record the  | apps/mvp/src/flows/engine.worker.ts: landed as 5ef5b2218d (same author and time, committed |
| 2026-10-26 19:21 | `d04f17300a` | SUPERSEDED | 12/1/0/0 | ec33db8c91 | ⚡ perf(platform-browser): dispatch worker fibers over a MessageChannel | packages/smithers/flows/platform-browser/src/BrowserLanguageServer.ts: main carried then c |
| 2026-10-26 19:21 | `44fbf9b0fd` | ON-MAIN | 41/0/0/0 | ec33db8c91 | ⚡ perf(engine-store): recover a runtime's registrations once, in its r |  |
| 2026-10-26 19:21 | `f6f9ea6890` | ON-MAIN | 12/0/0/0 | ec33db8c91 | ⚡ perf(flow): format a declaration's stack only when its site is read |  |
| 2026-10-26 19:25 | `0aec455ca8` | SUPERSEDED | 8/2/0/0 | 3d5fc96f1c | 🐛 fix(mvp): honor GitHub file line fragments | apps/mvp/docs/work/code-bugbash-1026.md: main carried then changed it: 8ea3e0ce46 (🐛 fix(m |
| 2026-10-26 19:29 | `8fff34e9af` | SUPERSEDED | 2/2/0/0 | 817b66c45e | 🐛 fix(mvp): show sign-in on repository runs for visitors | apps/mvp/src/screens/actions/ActionsScreen.tsx: main carried then changed it: cf9b8a0d72 ( |
| 2026-10-26 19:29 | `215be04bed` | SUPERSEDED | 1/2/0/0 | a0a646589f | 🐛 fix(mvp): offer sign-in on public issue conversations | apps/mvp/e2e/issue-visitor.spec.ts: main carried then changed it: 7bb154d7ee (🐛 fix(mvp): |
| 2026-10-26 19:29 | `32f8550fdd` | SUPERSEDED | 4/1/0/0 | 817b66c45e | 🐛 fix(mvp): offer sign-in on personal flows for visitors | apps/mvp/src/screens/flows/FlowsScreen.tsx: main carried then changed it: 18c3cc4fef (🎨 st |
| 2026-10-26 19:29 | `e47ba8c06b` | SUPERSEDED | 2/8/0/0 | a0a646589f | 🐛 fix(mvp): retain issue and pull request navigation | apps/mvp/docs/work/bugbash-issues-1026.md: main carried then changed it: a2ea2ddc5c (🐛 fix |
| 2026-10-26 19:30 | `d026743e3c` | SUPERSEDED | 8/2/0/0 | a0a646589f | 🐛 fix(mvp): hide actions for confirmed missing repositories | apps/mvp/e2e/missing-repository.spec.ts: main carried then changed it: 959ed5fca8 (🐛 fix: |
| 2026-10-26 19:30 | `b0da9cb6a2` | SUPERSEDED | 19/4/0/0 | a02b3d420d | 🐛 fix(mvp): require the repository in /new | apps/mvp/docs/features/slash-commands.md: main carried then changed it: fd997dfd4a (📝 fix( |
| 2026-10-26 19:30 | `f23b4d7960` | SUPERSEDED | 3/6/0/0 | f88d5a9b47 | 💄 fix(mvp): keep navigation themed and phone chrome compact | apps/mvp/docs/work/bugbash-chrome.md: main carried then changed it: 37bb5c7ffc (💄 fix(ui): |
| 2026-10-26 19:30 | `babdff2e97` | SUPERSEDED | 2/2/0/0 | a0a646589f | 🐛 fix(mvp): show cold issue and pull list sync feedback | apps/mvp/src/screens/issues/IssuesScreen.tsx: main carried then changed it: e2dcee91a0 (🐛 |
| 2026-10-26 19:31 | `9dfe040585` | SUPERSEDED | 13/3/0/0 | 817b66c45e | 🐛 fix(runs): close active steps when their run stops | apps/mvp/src/features/runs/graph.ts: main carried then changed it: 416120a2c8 (🐛 fix(runs) |
| 2026-10-26 19:31 | `2f9975d36d` | SUPERSEDED | 8/7/0/0 | f88d5a9b47 | 🔔 fix(mvp): keep repository bells in their headers | apps/mvp/e2e/chrome-issues.spec.ts: main carried then changed it: 0b0fbc91c4 (🎨 style(mvp) |
| 2026-10-26 19:31 | `a2dc4f1bc7` | SUPERSEDED | 4/4/0/0 | f88d5a9b47 | 🧹 fix(mvp): render one issues Back to chat action | apps/mvp/src/features/repo/components/RepoHeader.tsx: main carried then changed it: 024272 |
| 2026-10-26 19:31 | `5a6d840383` | SUPERSEDED | 3/1/0/0 | 817b66c45e | 🐛 fix(mvp): redirect the short flows address | apps/mvp/src/router.tsx: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 product |
| 2026-10-26 19:32 | `f07eda55d3` | ON-MAIN | 4/0/0/0 | a0a646589f | 🐛 fix(mvp): avoid invented requester attribution on issues |  |
| 2026-10-26 19:33 | `602731a335` | ON-MAIN | 3/0/0/0 | f88d5a9b47 | 🧹 fix(mvp): keep one visitor sign-in action in chat |  |
| 2026-10-26 19:34 | `f3c74fe2ec` | ON-MAIN | 7/0/0/0 | f88d5a9b47 | 💄 fix(ui): keep install commands intact on phones |  |
| 2026-10-26 19:34 | `e956fa9670` | SUPERSEDED | 15/1/0/0 | 3d5fc96f1c | 🐛 fix(mvp): keep reader workspace denials out of failed HTTP requests | apps/mvp/src/features/branch/api.ts: main carried then changed it: 8ea3e0ce46 (🐛 fix(mvp): |
| 2026-10-26 19:35 | `baf7f6355c` | SUPERSEDED | 36/3/0/0 | a0a646589f | ⚡ fix(mvp): scope issue and pull detail shapes to one item | apps/mvp/e2e/item-shape-payload.spec.ts: main carried then changed it: 7bb154d7ee (🐛 fix(m |
| 2026-10-26 19:36 | `09a2e0f246` | ON-MAIN | 6/0/0/0 | 46d74da7b6 | 🐛 fix(mvp): restore the empty notification panel |  |
| 2026-10-26 19:36 | `1cead38c7b` | SUPERSEDED | 2/2/0/0 | 46d74da7b6 | 🐛 fix(mvp): label model fallback placeholders | apps/mvp/e2e/personal-model.spec.ts: main carried then changed it: d2942b1ea7 (✨ feat(mvp) |
| 2026-10-26 19:36 | `47f9abb8ac` | SUPERSEDED | 5/3/0/0 | 46d74da7b6 | 🐛 fix(mvp): show the repository settings empty state | apps/mvp/src/screens/repo-settings/RepoSettingsScreen.tsx: main carried then changed it: 1 |
| 2026-10-26 19:36 | `3582e9021a` | SUPERSEDED | 4/1/0/0 | 46d74da7b6 | 🐛 fix(mvp): name the app on signed-in home | apps/mvp/docs/work/bugbash-shell-1026.md: main carried then changed it: 77fdf14dbb (🐛 fix( |
| 2026-10-26 19:37 | `bc7315bf8e` | SUPERSEDED | 21/2/0/0 | a02b3d420d | 🐛 fix(mvp): shorten slash menus and prioritize new conversations | apps/mvp/src/flows/registry.ts: main carried then changed it: 8800f22acb (🔒 feat(mvp): gui |
| 2026-10-26 19:37 | `a539031ea4` | ON-MAIN | 6/0/0/0 | a02b3d420d | 🐛 fix(mvp): accept late answer heartbeats without HTTP errors |  |
| 2026-10-26 19:38 | `25a8ad9a37` | SUPERSEDED | 5/2/0/0 | 817b66c45e | 🐛 fix(mvp): show run content loading before inspection arrives | apps/mvp/src/features/runs/components/RunPageView.tsx: main carried then changed it: 175ff |
| 2026-10-26 19:38 | `1c289ba126` | SUPERSEDED | 10/1/0/0 | 3d5fc96f1c | 🐛 fix(mvp): recover from missing files without failed browser reads | apps/mvp/e2e/missing-file.spec.ts: main carried then changed it: 7bb154d7ee (🐛 fix(mvp): s |
| 2026-10-26 19:39 | `817b66c45e` | SUPERSEDED | 5/2/0/0 | 817b66c45e | 🐛 fix(mvp): retain repository context and flow names on runs | apps/mvp/src/screens/actions/ActionRunScreen.tsx: main carried then changed it: 903a316c94 |
| 2026-10-26 19:39 | `46d74da7b6` | ON-MAIN | 6/0/0/0 | 46d74da7b6 | 🐛 fix(site): hide repeated search title sub-results |  |
| 2026-10-26 19:39 | `f90f085713` | SUPERSEDED | 7/2/0/0 | 46d74da7b6 | 🐛 fix(mvp): keep every bug-report door in the app | apps/mvp/src/router.tsx: main carried then changed it: 959ed5fca8 (🐛 fix: land W14 product |
| 2026-10-26 19:41 | `f88d5a9b47` | SUPERSEDED | 5/7/0/0 | f88d5a9b47 | 💄 fix(ui): contain timeline labels and previews | apps/mvp/e2e/timeline.spec.ts: main carried then changed it: b65aa03472 (✨ feat(timeline): |
| 2026-10-26 19:43 | `9b056503a3` | SUPERSEDED | 5/3/0/0 | 3d5fc96f1c | 🐛 fix(mvp): serve the repository branches URL | apps/mvp/src/features/attention/detail.test.ts: landed as 3eee7dfa9a (same author and time |
| 2026-10-26 19:45 | `a0a646589f` | SUPERSEDED | 15/6/0/0 | a0a646589f | 🐛 fix(mvp): follow issue creation to its numbered page | apps/mvp/docs/features/issues.md: main carried then changed it: 9662836059 (🐛 fix: land W1 |
| 2026-10-26 19:45 | `7e7677ef57` | SUPERSEDED | 4/2/0/0 | 3d5fc96f1c | 🐛 fix(mvp): link branch counts to the branch list | apps/mvp/src/features/repo/components/RepoPage.tsx: main carried then changed it: a445f8f3 |
| 2026-10-26 19:46 | `9a4c771665` | ON-MAIN | 10/0/0/0 | 3d5fc96f1c | 🐛 fix(mvp): return preview metadata for oversized files |  |
| 2026-10-26 19:46 | `a02b3d420d` | SUPERSEDED | 22/15/0/0 | a02b3d420d | 🐛 fix(mvp): keep model failures on their relevant surfaces | apps/mvp/docs/features/personal-model.md: main carried then changed it: d2942b1ea7 (✨ feat |
| 2026-10-26 19:55 | `3d5fc96f1c` | SUPERSEDED | 12/1/0/0 | 3d5fc96f1c | 🐛 fix(mvp): distinguish missing branches from unsynced mirrors | apps/mvp/src/features/repo/components/RepoPage.tsx: main carried then changed it: fb8d7fcf |
| 2026-10-26 21:13 | `119ffa9a91` | PARTIAL | 0/0/20/1 | dca331d06f | 🐛 fix(mvp): keep screenshot captures out of edited mobile recordings | apps/mvp/docs/work/mobile-w8.md: the old media path; the saved production measurements ret |
| 2026-10-27 02:21 | `a0ab8dfa8e` | SUPERSEDED | 0/11/0/0 | bf0476b452 | 🐛 fix(mvp): durably admit issue creation before returning | apps/mvp/docs/features/issues.md: changed later in its stack (head bf0476b452) |
| 2026-10-27 02:33 | `0683738f81` | SUPERSEDED | 0/4/0/0 | bf0476b452 | 🐛 fix(mvp): label queued issue creation Requested | apps/mvp/docs/features/issues.md: changed later in its stack (head bf0476b452) |
| 2026-10-27 02:37 | `09c8c364ef` | SUPERSEDED | 3/2/0/0 | bf0476b452 | 🐛 fix(mvp): recover unavailable issue write URLs | apps/mvp/docs/features/issues.md: changed later in its stack (head bf0476b452) |
| 2026-10-27 02:42 | `7ecbe6096a` | PARTIAL | 6/1/1/0 | bf0476b452 | 🐛 fix(mvp): retain failed comment admission feedback | apps/mvp/docs/features/issues.md: +A Comment whose flow or engine cannot admit it retains |
| 2026-10-27 03:02 | `6772c09044` | PARTIAL | 1/0/4/0 | bf0476b452 | 🐛 fix(mvp): follow branch writes in the shared toast lifecycle | apps/mvp/docs/observability.md: +`github.write.notice` traces and logs admission and settl |
| 2026-10-27 04:41 | `7d015f8602` | SUPERSEDED | 4/3/0/0 | bd36978696 | 🐛 fix(cli): forward TUI daily cap and workspace flags | apps/mvp/docs/work/bugbash4-cli-docs.md: changed later in its stack (head bd36978696) |
| 2026-10-27 04:42 | `4a1972b5db` | PARTIAL | 40/4/0/1 | bd36978696 | 🐛 fix(mvp): return 404 for unsupported app documents | apps/mvp/worker/index.ts: const status = isAppRoute(url.pathname) ? 200 : 404; apps/mvp/do |
| 2026-10-27 04:42 | `1adf2c360f` | PARTIAL | 40/4/0/1 | bf0476b452 | 🐛 fix(mvp): return 404 for unsupported app documents | apps/mvp/worker/index.ts: const status = isAppRoute(url.pathname) ? 200 : 404; apps/mvp/do |
| 2026-10-27 04:43 | `110f5840ce` | SUPERSEDED | 1/2/0/0 | bd36978696 | 📝 fix(docs): reference deferred clock and native fact namespaces | packages/smithers/flows/engine-store/docs/api.md: main carried then changed it: 3b734cb691 |
| 2026-10-27 04:43 | `928e1f46e8` | SUPERSEDED | 3/2/0/0 | bd36978696 | 📝 fix(engine): identify the owner and failure channel of identity conf | apps/site/package.json: changed later in its stack (head bd36978696) |
| 2026-10-27 04:43 | `1fc4913ad5` | ON-MAIN | 2/0/0/0 | bd36978696 | 📝 fix(cli): describe the actual TUI token cap default |  |
| 2026-10-27 04:44 | `be29d8143d` | SUPERSEDED | 5/1/0/0 | bd36978696 | 🐛 fix(cli): avoid loading browser sync through the native runtime barr | apps/mvp/docs/work/bugbash4-cli-docs.md: changed later in its stack (head bd36978696) |
| 2026-10-27 04:46 | `5bc22bb91f` | SUPERSEDED | 1/45/0/0 | bd36978696 | 📝 fix(docs): document verified public flow API members | apps/site/src/content/docs/docs/reference/api/canonical.mdx: main carried then changed it: |
| 2026-10-27 04:47 | `e25fd6dcdb` | SUPERSEDED | 1/6/0/0 | bd36978696 | 📝 fix(build): reference public install and manifest helpers | apps/site/src/content/docs/docs/reference/api/build.mdx: main carried then changed it: 3b7 |
| 2026-10-27 04:47 | `82690fd9b2` | SUPERSEDED | 4/2/0/0 | bd36978696 | 📝 fix(harness): index lifecycle and fresh realm public modules | apps/site/src/content/docs/docs/reference/api/harness.mdx: main carried then changed it: 3 |
| 2026-10-27 04:47 | `eeafc62716` | SUPERSEDED | 1/2/0/0 | bd36978696 | 📝 fix(agent): state the one-hour default quota park ceiling | apps/site/src/content/docs/docs/reference/api/agent.mdx: main carried then changed it: 3b7 |
| 2026-10-27 04:47 | `95b2700e4b` | ON-MAIN | 1/0/0/0 | bf0476b452 | 🔀 chore(mvp): integrate pending write-admission prerequisite |  |
| 2026-10-27 04:48 | `2038f246c7` | SUPERSEDED | 15/27/0/0 | bd36978696 | 📝 fix(site): explain the private UI contributor reference | apps/site/docs/reference/api/index.mdx: main carried then changed it: 1c1d58de23 (📝 fix(si |
| 2026-10-27 04:48 | `a3ca242238` | ON-MAIN | 3/0/0/0 | bd36978696 | 📝 fix(site): list published build targets and views references |  |
| 2026-10-27 04:51 | `5e9b43e2f1` | ON-MAIN | 14/0/0/0 | bd36978696 | 🐛 fix(tanstack-db): keep repository identities out of diagnostics |  |
| 2026-10-27 04:51 | `b3da1d7f21` | ON-MAIN | 14/0/0/0 | bf0476b452 | 🐛 fix(tanstack-db): keep repository identities out of diagnostics |  |
| 2026-10-27 05:18 | `4035e66bed` | SUPERSEDED | 4/1/0/0 | bd36978696 | 🐛 fix(site): omit the noindex bug redirect from the sitemap | apps/site/package.json: changed later in its stack (head bd36978696) |
| 2026-10-27 05:18 | `6a5ae8112b` | PARTIAL | 4/0/1/0 | bf0476b452 | 🐛 fix(site): omit the noindex bug redirect from the sitemap | apps/site/package.json: -    "test": "node --test --test-concurrency=1 scripts/record-tape |
| 2026-10-27 05:19 | `84d9f02003` | SUPERSEDED | 19/1/0/0 | bd36978696 | 🐛 fix(mvp): redact repository paths before browser telemetry leaves | apps/mvp/src/boot.ts: changed later in its stack (head bd36978696) |
| 2026-10-27 05:19 | `c4d96b132c` | PARTIAL | 18/1/1/0 | bf0476b452 | 🐛 fix(mvp): redact repository paths before browser telemetry leaves | apps/mvp/src/boot.ts: +import { telemetryExport } from "./telemetryExport"; apps/mvp/docs/ |
| 2026-10-27 05:40 | `e61c5c27f4` | ON-MAIN | 10/0/0/0 | bd36978696 | 🐛 fix(mvp): settle visitor issue counts from public snapshots |  |
| 2026-10-27 05:40 | `40761bdbc3` | PARTIAL | 9/1/0/1 | bf0476b452 | 🐛 fix(mvp): settle visitor issue counts from public snapshots | apps/mvp/docs/features/issues.md: A known pending issue write says **Requested**, includin |
| 2026-10-27 05:42 | `e44ad89b7c` | SUPERSEDED | 17/4/0/0 | bd36978696 | 🐛 fix(mvp): explain unavailable repository issue lists | apps/mvp/src/features/repo/actions.ts: main carried then changed it: 8800f22acb (🔒 feat(mv |
| 2026-10-27 05:42 | `29857aabd8` | SUPERSEDED | 17/4/0/0 | bf0476b452 | 🐛 fix(mvp): explain unavailable repository issue lists | apps/mvp/src/features/repo/actions.ts: main carried then changed it: 8800f22acb (🔒 feat(mv |
| 2026-10-27 05:51 | `23ced576b0` | PARTIAL | 237/19/1/1 | bd36978696 | 🐛 fix(mvp): durably admit every device write before returning | apps/mvp/src/features/commands/commands.test.ts: Commands \| Chat \| ChatStore \| Commands |
| 2026-10-27 05:51 | `bf0476b452` | PARTIAL | 238/15/3/2 | bf0476b452 | 🐛 fix(mvp): durably admit every device write before returning | apps/mvp/docs/features/slash-commands.md: +Composer write actions return promises that res |
| 2026-10-27 06:22 | `d5ca0487dc` | PARTIAL | 62/15/2/1 | bd36978696 | 🐛 fix(mvp): repair W12 production followups | apps/mvp/src/features/commands/commands.test.ts: import { choose as chooseCommand, submit |
| 2026-10-27 06:22 | `ccd8a24b03` | SCAFFOLD | 453/41/55/24 | ccd8a24b03 | 🧪 wip: retain rejected W13 progress recovery investigation | apps/mvp/docs/features/notifications.md: ## Background dispatch progress; apps/mvp/docs/fe |
| 2026-10-27 10:26 | `8302d9cb3f` | SUPERSEDED | 19/1/0/0 | 982d7006d2 | 🐛 fix(memory): retain message timestamps on idempotent retries | apps/mvp/docs/work/package-bugbash4-cli.md: main carried then changed it: 3b6b30a14d (🐛 fi |
| 2026-10-27 10:47 | `bdec5b3bf4` | ON-MAIN | 3/0/0/0 | bd36978696 | 🔀 chore(mvp): integrate W14 followups |  |
| 2026-10-27 10:48 | `bd36978696` | ON-MAIN | 2/0/0/0 | bd36978696 | 🔀 chore: integrate W14 CLI and references |  |
| 2026-10-27 10:48 | `a838664294` | PARTIAL | 6/1/1/0 | bd36978696 | 🔀 chore(mvp): resolve W14 integration | apps/mvp/src/features/commands/commands.test.ts: import { Deferred, Effect, Logger, type M |
| 2026-10-27 10:52 | `515363c380` | PARTIAL | 0/5/38/4 | 982d7006d2 | 🐛 fix(mvp): keep branch launch progress through completion | apps/mvp/docs/decisions/0121-operation-progress.md: 2026-10-27. Implements the existing in |
| 2026-10-27 10:56 | `ee03ac2bc5` | PARTIAL | 3/2/13/5 | 982d7006d2 | 🐛 fix(mvp): project shared issue progress from admission receipts | apps/mvp/docs/features/issues.md: Create issue also appears in the shared toast stack. Pro |
| 2026-10-27 10:58 | `982d7006d2` | PARTIAL | 4/0/58/9 | 982d7006d2 | 🐛 fix(mvp): keep shared TODO progress through its real receipt | apps/mvp/docs/decisions/0121-operation-progress.md: Retry resolves the exact retained iden |
| 2026-10-27 11:03 | `8000231a73` | ON-MAIN | 5/0/0/0 | 982d7006d2 | 🐛 fix(cli): classify trigger declaration errors as user input |  |
| 2026-10-27 11:03 | `7ee5a77bdd` | SUPERSEDED | 3/1/0/0 | 982d7006d2 | 🐛 fix(cli): report a missing host installation clearly | packages/smithers/docs/guides/wire-the-mcp-server.md: main carried then changed it: 5bcd94 |
| 2026-10-27 11:03 | `cf2fc2d25a` | ON-MAIN | 4/0/0/0 | 982d7006d2 | 📝 fix(cli): align MCP tool examples with discovery |  |
| 2026-10-27 11:03 | `8e878d9850` | ON-MAIN | 6/0/0/0 | 982d7006d2 | 📝 fix(cli): describe memory namespaces tags and time units |  |
| 2026-10-27 11:03 | `882bc5ae4e` | ON-MAIN | 7/0/0/0 | 982d7006d2 | 🐛 fix(cli): keep evaluation JSON output free of logs |  |
| 2026-10-27 11:04 | `0ee3f7a771` | SUPERSEDED | 6/1/0/0 | 982d7006d2 | 🐛 fix(build-cli): cache successful Filegroup results | apps/mvp/docs/work/package-bugbash4-cli.md: main carried then changed it: 892bbbf763 (🐛 fi |
| 2026-10-27 11:04 | `14fb389c3d` | ON-MAIN | 3/0/0/0 | 982d7006d2 | 📝 fix(cli): document the MCP doctor command |  |
| 2026-10-27 11:04 | `7ba7eb347d` | SUPERSEDED | 7/2/0/0 | 982d7006d2 | 🐛 fix(cli): answer malformed MCP JSON without losing later requests | packages/smithers/src/Cli.ts: landed as 5bcd94cba3 (same author and time, committed later) |
| 2026-10-27 11:04 | `d69b471e15` | SUPERSEDED | 7/1/0/0 | 982d7006d2 | 🐛 fix(build-cli): resolve absolute owner paths within the workspace | packages/smithers/build/build-cli/src/Owners.ts: main carried then changed it: 417af8c017 |
| 2026-10-27 18:00 | `dca331d06f` | PARTIAL | 0/0/1/1 | dca331d06f |  | apps/mvp/tests/MobileLayout.browser.test.ts: -for (const width of [390, 768, 1280]) test(` |
| 2026-10-30 00:02 | `90c06bb911` | SUPERSEDED | 0/2/0/0 | builder/alias-auth | 📝 docs(mvp): decide repository feeds for the factory on Smithers (0126 | apps/mvp/docs/decisions/0126-repository-feeds.md: main deleted it in e1398aab09 (📝 docs(mv |
| 2026-10-30 00:10 | `b3c7e67613` | SUPERSEDED | 15/2/0/0 | builder/alias-auth | ✨ feat(mvp): APP_ALIASES serve the app at more hostnames, each opening | apps/mvp/docs/infrastructure.md: main carried then changed it: e38b0ba57c (📝 docs(mvp): re |
| 2026-10-30 00:16 | `dd7c44d528` | SUPERSEDED | 22/11/0/0 | builder/alias-auth | ✨ feat(mvp): the factory plugin: a repository's factory over its feeds | apps/mvp/docs/features/factory.md: main carried then changed it: e1398aab09 (📝 docs(mvp): |
| 2026-10-30 00:16 | `1111f56d74` | SUPERSEDED | 37/5/0/0 | builder/alias-auth | ✨ feat(mvp): show repository-scoped plugin views on the repository's p | apps/mvp/docs/features/plugins.md: main carried then changed it: 5830d6cbca (🐛 fix(mvp): g |
| 2026-10-30 00:43 | `3c2f2b61d1` | SUPERSEDED | 70/6/0/0 | builder/alias-auth | ✨ feat(pulls): review on request for any open pull request (0127) | apps/mvp/docs/decisions/0127-review-on-request.md: main deleted it in d3985028c7 (✨ feat(p |
| 2026-10-30 00:43 | `5e5b3cb01a` | SUPERSEDED | 28/4/0/0 | builder/alias-auth | ✨ feat(mvp): repository feeds: collector writes, answers and the feeds | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-30 00:48 | `3c92ceb70a` | SUPERSEDED | 21/8/0/0 | builder/alias-auth | ✨ feat(mvp): core/feeds and core/feed for plugins; PluginHost.query ta | apps/mvp/src/boot.ts: main carried then changed it: e2903e2bf9 (✨ feat(mvp): core/feed-ite |
| 2026-10-30 01:10 | `cd71f5cb36` | SUPERSEDED | 13/2/0/0 | builder/alias-auth | ♻️ refactor(mvp): factory ages tick on RelativeTime; durations count t | apps/mvp/docs/features/factory.md: main carried then changed it: e38b0ba57c (📝 docs(mvp): |
| 2026-10-30 01:38 | `6e9cb2bf29` | SUPERSEDED | 7/4/0/0 | builder/alias-auth | 📝 docs(mvp): repository feeds: feature doc, observability, FEED_KEYS;  | apps/mvp/docs/features/plugins.md: main carried then changed it: e1398aab09 (📝 docs(mvp): |
| 2026-10-30 01:53 | `dafeb9816c` | SUPERSEDED | 11/2/0/0 | builder/alias-auth | 📝 docs(mvp): core/feed-items, answering from For you, the development  | apps/mvp/docs/decisions/0126-repository-feeds.md: main deleted it in e1398aab09 (📝 docs(mv |
| 2026-10-30 01:53 | `f2927c3e9c` | SUPERSEDED | 28/1/0/0 | builder/alias-auth | ✨ feat(mvp): alchemy dev accepts a development feed key; the factory e | apps/mvp/e2e/target.ts: main carried then changed it: e38b0ba57c (📝 docs(mvp): renumber th |
| 2026-10-30 01:53 | `25eca9d729` | SUPERSEDED | 33/3/0/0 | builder/alias-auth | ✨ feat(mvp): core/feed-items; the factory's For you answers through th | apps/mvp/plugins/factory/src/feeds.ts: main carried then changed it: 02461910a2 (✨ feat(mv |
| 2026-10-30 01:53 | `3691d2bc73` | SUPERSEDED | 4/1/0/0 | builder/alias-auth | ✅ test(mvp): the factory stack's tests agree with each other: feed/ans | apps/mvp/src/plugins/plugins.test.ts: main carried then changed it: 02461910a2 (✨ feat(mvp |
| 2026-10-30 20:41 | `5026a02787` | SUPERSEDED | 29/15/0/0 | builder/alias-auth | ✨ feat(mvp): sign in at aliases and custom domains through APP_DOMAIN' | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-31 08:49 | `10eccf2de9` | PARTIAL | 16/16/1754/94 | faf3ec5b89 | migrate(vibelang): upgrade Effect to 4.1.0 and VibeLang to 0.0.11 | .gitignore: .vibelang-toolchain/; .smithers/flows/bench/README.md: per node on `scheduler- |
| 2026-10-31 10:22 | `ed4350d2e8` | PARTIAL | 76/2/138/2 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | .agents/skills/vibelang/SKILL.md: \| `Effect.all([Effect.exit(a()), Effect.exit(b())], { c |
| 2026-10-31 10:22 | `fb63aa7eeb` | PARTIAL | 76/2/138/2 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | .agents/skills/vibelang/SKILL.md: \| `Effect.all([Effect.exit(a()), Effect.exit(b())], { c |
| 2026-10-31 10:22 | `7f3e5d7d6e` | PARTIAL | 76/2/138/2 | faf3ec5b89 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | .agents/skills/vibelang/SKILL.md: \| `Effect.all([Effect.exit(a()), Effect.exit(b())], { c |
| 2026-10-31 10:24 | `ffbfb3fc30` | PARTIAL | 0/0/24/15 | 5686bc4bfc | migrate(vibelang): format the existing .vibe files with VibeLang's for | packages/smithers/agent/fs/src/Command.vibe: ): Effect<unknown, FsError, infer R> {; packa |
| 2026-10-31 10:24 | `3aaafe9b71` | PARTIAL | 0/0/24/15 | 775f26b754 | migrate(vibelang): format the existing .vibe files with VibeLang's for | packages/smithers/agent/fs/src/Command.vibe: ): Effect<unknown, FsError, infer R> {; packa |
| 2026-10-31 10:24 | `516202c2c9` | PARTIAL | 0/1/24/14 | faf3ec5b89 | migrate(vibelang): format the existing .vibe files with VibeLang's for | packages/smithers/agent/fs/src/Command.vibe: ): Effect<unknown, FsError, infer R> {; packa |
| 2026-10-31 10:27 | `4fda548b3a` | SUPERSEDED | 2/8/0/0 | 5686bc4bfc | migrate(vibelang): batch 01: Canonical.vibe | packages/smithers/flows/canonical/PACKAGE.ts: changed later in its stack (head 5686bc4bfc) |
| 2026-10-31 10:27 | `273c0ffd1d` | PARTIAL | 2/1/6/1 | 775f26b754 | migrate(vibelang): batch 01: Canonical.vibe | packages/smithers/flows/canonical/PACKAGE.ts: paths: ["src/internal/canonicalize.ts", "src |
| 2026-10-31 10:27 | `e542f36159` | PARTIAL | 2/0/7/1 | faf3ec5b89 | migrate(vibelang): batch 01: Canonical.vibe | packages/smithers/flows/canonical/PACKAGE.ts: paths: ["src/internal/canonicalize.ts", "src |
| 2026-10-31 10:33 | `e1c4e9912d` | PARTIAL | 2/25/1/1 | 5686bc4bfc | migrate(vibelang): batch 03: Crypto.vibe, Uuid.vibe | packages/smithers/flows/crypto/src/Uuid.vibe: if (!isUuid(namespace)) return Effect.die(ne |
| 2026-10-31 10:33 | `ad9fd64654` | PARTIAL | 2/25/1/1 | 775f26b754 | migrate(vibelang): batch 03: Crypto.vibe, Uuid.vibe | packages/smithers/flows/crypto/src/Uuid.vibe: if (!isUuid(namespace)) return Effect.die(ne |
| 2026-10-31 10:33 | `d805b1c23a` | PARTIAL | 2/2/22/3 | faf3ec5b89 | migrate(vibelang): batch 03: Crypto.vibe, Uuid.vibe | packages/smithers/flows/crypto/package.json: "./Crypto": "./src/Crypto.vibe",; packages/sm |
| 2026-10-31 10:39 | `aefa1caa58` | PARTIAL | 0/1/4/2 | 5686bc4bfc | migrate(vibelang): batch 05: Binding.vibe, Scrub.vibe | packages/smithers/flows/secrets/src/Binding.d.vibe.ts: readonly methods: Schema.optional<S |
| 2026-10-31 10:39 | `67b33c1724` | PARTIAL | 0/1/4/2 | 775f26b754 | migrate(vibelang): batch 05: Binding.vibe, Scrub.vibe | packages/smithers/flows/secrets/src/Binding.d.vibe.ts: readonly methods: Schema.optional<S |
| 2026-10-31 10:39 | `b07927d3aa` | PARTIAL | 0/0/5/2 | faf3ec5b89 | migrate(vibelang): batch 05: Binding.vibe, Scrub.vibe | packages/smithers/flows/secrets/src/Binding.d.vibe.ts: readonly methods: Schema.optional<S |
| 2026-10-31 10:45 | `0b70f70db9` | SUPERSEDED | 47/2/0/0 | builder/stack-flake | ✨ feat(mvp): a repository's merge flow chooses GitHub's merge or its o | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-31 10:45 | `23b9181fb3` | SUPERSEDED | 47/2/0/0 | builder/stack-flake | ✨ feat(mvp): a repository's merge flow chooses GitHub's merge or its o | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-31 10:45 | `1457e0b8b8` | PARTIAL | 33/15/0/1 | builder/stack-flake | ✨ feat(mvp): a repository's merge flow chooses GitHub's merge or its o | apps/mvp/docs/decisions/0133-merge-flow.md: # 0133: The merge flow: a repository chooses h |
| 2026-10-31 10:45 | `0fe9b8d615` | PARTIAL | 31/16/0/2 | builder/merge-flow | ✨ feat(mvp): a repository's merge flow chooses GitHub's merge or its o | apps/mvp/db/migrations/0075_merge_flow.ts: // How a merge landed its pull request (ruling |
| 2026-10-31 10:47 | `444c2e5465` | PARTIAL | 1/0/6/2 | 5686bc4bfc | migrate(vibelang): batch 06: Egress.vibe | packages/smithers/flows/secrets/src/Egress.d.vibe.ts: export declare const forward: (reque |
| 2026-10-31 10:47 | `f69bcbcd89` | PARTIAL | 1/0/6/2 | 775f26b754 | migrate(vibelang): batch 06: Egress.vibe | packages/smithers/flows/secrets/src/Egress.d.vibe.ts: export declare const forward: (reque |
| 2026-10-31 10:47 | `6631997aa2` | PARTIAL | 1/0/6/2 | faf3ec5b89 | migrate(vibelang): batch 06: Egress.vibe | packages/smithers/flows/secrets/src/Egress.d.vibe.ts: export declare const forward: (reque |
| 2026-10-31 10:53 | `a7508b33db` | STRANDED | 0/0/6/0 | 5686bc4bfc | migrate(vibelang): name the migrated secrets modules in its targets | packages/smithers/flows/secrets/PACKAGE.ts: sources: Input.glob("src/**/*.{ts,vibe}"),; pa |
| 2026-10-31 10:53 | `8a15a59aea` | STRANDED | 0/0/6/0 | 775f26b754 | migrate(vibelang): name the migrated secrets modules in its targets | packages/smithers/flows/secrets/PACKAGE.ts: sources: Input.glob("src/**/*.{ts,vibe}"),; pa |
| 2026-10-31 10:53 | `9c7d9e99f9` | STRANDED | 0/0/6/0 | faf3ec5b89 | migrate(vibelang): name the migrated secrets modules in its targets | packages/smithers/flows/secrets/PACKAGE.ts: sources: Input.glob("src/**/*.{ts,vibe}"),; pa |
| 2026-10-31 11:10 | `36e89feda8` | SUPERSEDED | 118/9/0/0 | builder/stack-flake | ✨ feat(mvp): independent lanes: up to 64 TODOs at once, stacked only b | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-31 11:10 | `ac09b95a75` | SUPERSEDED | 118/9/0/0 | builder/stack-flake | ✨ feat(mvp): independent lanes: up to 64 TODOs at once, stacked only b | apps/mvp/db/Database.ts: main carried then changed it: 1d5f008b71 (🔧 fix(devx): rebuild mi |
| 2026-10-31 11:10 | `7d4ffa6696` | PARTIAL | 96/30/0/1 | builder/stack-flake | ✨ feat(mvp): independent lanes: up to 64 TODOs at once, stacked only b | apps/mvp/docs/decisions/0134-independent-lanes.md: # 0134: Independent lanes: a repository |
| 2026-10-31 11:10 | `6714423850` | PARTIAL | 94/32/0/1 | 53f3e4f254 | ✨ feat(mvp): independent lanes: up to 64 TODOs at once, stacked only b | apps/mvp/docs/decisions/0132-independent-lanes.md: - Migration `0076_independent_lanes` gi |
| 2026-10-31 11:15 | `7978863edd` | SUPERSEDED | 46/12/0/0 | builder/stack-flake | ✨ feat(mvp): a repository's TODOs can be coded by a named external age | apps/mvp/AGENTS.md: main carried then changed it: da1302263b (✨ feat(mvp): watch an extern |
| 2026-10-31 11:15 | `d51bfd4ba9` | SUPERSEDED | 13/3/0/0 | builder/stack-flake | ✨ feat(cli): smthrs runner, which claims a repository's agent jobs and | packages/smithers/src/runner/Scrub.ts: main deleted it in f1684204b3 (✨ feat(cli): smthrs |
| 2026-10-31 11:15 | `2c7f5ff09b` | SUPERSEDED | 14/2/0/0 | builder/stack-flake | ✨ feat(agent): external agents on runners: the vendor-neutral runner c | packages/smithers/agent/docs/api.md: main carried then changed it: 7c9416aa24 (✨ feat(agen |
| 2026-10-31 11:15 | `ced2702331` | SUPERSEDED | 46/12/0/0 | builder/stack-flake | ✨ feat(mvp): a repository's TODOs can be coded by a named external age | apps/mvp/AGENTS.md: main carried then changed it: da1302263b (✨ feat(mvp): watch an extern |
| 2026-10-31 11:15 | `8be8614383` | SUPERSEDED | 13/3/0/0 | builder/stack-flake | ✨ feat(cli): smthrs runner, which claims a repository's agent jobs and | packages/smithers/src/runner/Scrub.ts: main deleted it in f1684204b3 (✨ feat(cli): smthrs |
| 2026-10-31 11:15 | `cc23683da0` | SUPERSEDED | 14/2/0/0 | builder/stack-flake | ✨ feat(agent): external agents on runners: the vendor-neutral runner c | packages/smithers/agent/docs/api.md: main carried then changed it: 7c9416aa24 (✨ feat(agen |
| 2026-10-31 11:15 | `6ea18a6d67` | PARTIAL | 40/17/0/1 | builder/stack-flake | ✨ feat(mvp): a repository's TODOs can be coded by a named external age | apps/mvp/docs/decisions/0135-external-agents-on-runners.md: # 0135: External agents on run |
| 2026-10-31 11:15 | `8a182b8659` | SUPERSEDED | 13/3/0/0 | builder/stack-flake | ✨ feat(cli): smthrs runner, which claims a repository's agent jobs and | packages/smithers/src/runner/Scrub.ts: main deleted it in f1684204b3 (✨ feat(cli): smthrs |
| 2026-10-31 11:15 | `5503639c26` | SUPERSEDED | 14/2/0/0 | builder/stack-flake | ✨ feat(agent): external agents on runners: the vendor-neutral runner c | packages/smithers/agent/docs/api.md: main carried then changed it: 7c9416aa24 (✨ feat(agen |
| 2026-10-31 11:15 | `3620d4c0bd` | PARTIAL | 31/19/0/2 | 53f3e4f254 | ✨ feat(mvp): a repository's TODOs can be coded by a named external age | apps/mvp/db/migrations/0077_agent_runners.ts: // External agents on runner machines (decis |
| 2026-10-31 11:15 | `ff5c3771fd` | SUPERSEDED | 13/3/0/0 | 53f3e4f254 | ✨ feat(cli): smthrs runner, which claims a repository's agent jobs and | packages/smithers/src/runner/Scrub.ts: main deleted it in f1684204b3 (✨ feat(cli): smthrs |
| 2026-10-31 11:15 | `ca92818288` | SUPERSEDED | 14/2/0/0 | 53f3e4f254 | ✨ feat(agent): external agents on runners: the vendor-neutral runner c | packages/smithers/agent/docs/api.md: main carried then changed it: 7c9416aa24 (✨ feat(agen |
| 2026-10-31 12:04 | `874b360a16` | PARTIAL | 3/0/2/1 | 53f3e4f254 | 🔀 merge(mvp): S1 external agents beside S4 independent lanes (migratio | apps/mvp/db/Database.ts: import agentRunners from "./migrations/0077_agent_runners.ts"; ap |
| 2026-10-31 12:06 | `85af26ade2` | SUPERSEDED | 13/2/0/0 | builder/stack-flake | ✨ feat(mvp): a TODO on an external agent reads Waiting for a runner un | apps/mvp/worker/ChatApiProgram.ts: main carried then changed it: 6855753cba (✨ feat(mvp): |
| 2026-10-31 12:06 | `f5553da9c1` | SUPERSEDED | 13/2/0/0 | builder/stack-flake | ✨ feat(mvp): a TODO on an external agent reads Waiting for a runner un | apps/mvp/worker/ChatApiProgram.ts: main carried then changed it: 6855753cba (✨ feat(mvp): |
| 2026-10-31 12:06 | `7482b6e680` | SUPERSEDED | 11/4/0/0 | builder/stack-flake | ✨ feat(mvp): a TODO on an external agent reads Waiting for a runner un | apps/mvp/docs/features/agent-runners.md: landed as 3ae57ca7b1 (same author and time, commi |
| 2026-10-31 12:06 | `53f3e4f254` | SUPERSEDED | 11/4/0/0 | 53f3e4f254 | ✨ feat(mvp): a TODO on an external agent reads Waiting for a runner un | apps/mvp/docs/features/agent-runners.md: landed as 3ae57ca7b1 (same author and time, commi |
| 2026-10-31 12:51 | `1a1ee479dc` | SUPERSEDED | 4/2/0/0 | builder/stack-flake | 📝 docs: regenerate the site's agent API page, llms file and redirect m | apps/site/public/llms-full.txt: main carried then changed it: 719148d634 (📝 docs: regenera |
| 2026-10-31 12:51 | `a69f282bd6` | SUPERSEDED | 4/2/0/0 | builder/stack-flake | 📝 docs: regenerate the site's agent API page, llms file and redirect m | apps/site/public/llms-full.txt: main carried then changed it: 719148d634 (📝 docs: regenera |
| 2026-10-31 12:51 | `c9c9e8df1a` | SUPERSEDED | 4/2/0/0 | builder/stack-flake | 📝 docs: regenerate the site's agent API page, llms file and redirect m | apps/site/public/llms-full.txt: main carried then changed it: 719148d634 (📝 docs: regenera |
| 2026-10-31 12:51 | `29d1587251` | SUPERSEDED | 4/2/0/0 | 53f3e4f254 | 📝 docs: regenerate the site's agent API page, llms file and redirect m | apps/site/public/llms-full.txt: main carried then changed it: 719148d634 (📝 docs: regenera |
| 2026-10-31 13:00 | `0bd16f0c21` | PARTIAL | 115/9/1/14 | 0bd16f0c21 |  | apps/mvp/docs/decisions/0134-agent-transcripts.md: - The transcript's lag is the runner's |
| 2026-10-31 13:20 | `b43032836f` | PARTIAL | 111/24/4/8 | b43032836f |  | apps/mvp/.s5-check.sh: grep -E "×\|FAIL\|AssertionError\|Error:\|expected\|❯ .*:[0-9]+\|Te |
| 2026-10-31 13:20 | `5c3d63613b` | PARTIAL | 110/24/4/9 | 5c3d63613b |  | apps/mvp/.s5-check.sh: grep -E "×\|FAIL\|AssertionError\|Error:\|expected\|❯ .*:[0-9]+\|Te |
| 2026-10-31 13:44 | `0ba04acecb` | ON-MAIN | 30/0/0/0 | builder/s3-steer | ✨ feat(flow): cancelling a parked ExternalJob stops its work durably,  |  |
| 2026-10-31 14:02 | `940f8a206a` | PARTIAL | 100/18/4/11 | 940f8a206a |  | apps/mvp/db/Database.test.ts: SELECT pg_get_constraintdef(oid) AS definition FROM pg_const |
| 2026-10-31 14:02 | `c32430ee25` | PARTIAL | 101/17/4/11 | c32430ee25 |  | apps/mvp/db/Database.test.ts: SELECT pg_get_constraintdef(oid) AS definition FROM pg_const |
| 2026-10-31 14:02 | `2115d4a452` | PARTIAL | 100/18/4/11 | 2115d4a452 |  | apps/mvp/db/Database.test.ts: SELECT pg_get_constraintdef(oid) AS definition FROM pg_const |
| 2026-10-31 14:02 | `87d70da83d` | SUPERSEDED | 60/4/0/0 | builder/s3-steer | ✨ feat(agent): steer and stop an external agent on a runner, and see i | packages/smithers/agent/docs/api.md: main carried then changed it: adab8bbabc (✨ feat(cli) |
| 2026-10-31 14:02 | `f77f503af8` | PARTIAL | 100/18/4/11 | f77f503af8 |  | apps/mvp/db/Database.test.ts: SELECT pg_get_constraintdef(oid) AS definition FROM pg_const |
| 2026-10-31 14:02 | `35d55814bc` | ON-MAIN | 13/0/0/0 | builder/s3-steer | ✨ feat(notifications): a consumer that confirms each steer drains exac |  |
| 2026-10-31 14:36 | `79a8684d97` | ON-MAIN | 38/0/0/0 | builder/byok | ✨ feat(mvp): triage judges on its enabler's own model, so triage works |  |
| 2026-10-31 14:36 | `35864cadae` | PARTIAL | 3/4/0/1 | builder/byok | 🐛 fix(mvp): BYOK e2e specs wait for the saved model before removing it | apps/mvp/e2e/personal-model.spec.ts: await expect(section).toBeVisible({ timeout: 30_000 } |
| 2026-10-31 15:10 | `c93c130be5` | PARTIAL | 53/14/2/2 | builder/s3-steer | ✨ feat(mvp): stop and steer a TODO's external agent from its run's pag | apps/mvp/db/Database.ts: import agentStops from "./migrations/0079_agent_stops.ts"; apps/m |
| 2026-10-31 15:10 | `fea6166d01` | PARTIAL | 53/14/2/2 | builder/s3-steer | ✨ feat(mvp): stop and steer a TODO's external agent from its run's pag | apps/mvp/db/Database.ts: import agentStops from "./migrations/0079_agent_stops.ts"; apps/m |
| 2026-10-31 15:10 | `bceaf869a0` | PARTIAL | 53/14/2/2 | bceaf869a0 |  | apps/mvp/db/Database.ts: import agentStops from "./migrations/0079_agent_stops.ts"; apps/m |
| 2026-10-31 15:11 | `ab185d871a` | PARTIAL | 78/54/0/2 | e7b5a39485 | ✨ feat(timeline): rebuild the rail to the mock, with logical phases | apps/mvp/db/migrations/0075_timeline_phases.ts: // The rail's phases and arcs (ruling FE-1 |
| 2026-10-31 15:11 | `c32827324b` | PARTIAL | 78/54/0/2 | c32827324b |  | apps/mvp/db/migrations/0075_timeline_phases.ts: // The rail's phases and arcs (ruling FE-1 |
| 2026-10-31 15:13 | `fe8a5d8f48` | ON-MAIN | 2/0/0/0 | fe8a5d8f48 |  |  |
| 2026-10-31 15:16 | `fca6ab2e0c` | ON-MAIN | 9/0/0/0 | builder/byok | 🐛 fix(mvp): a person's OpenAI key reaches gpt-6 models through the Res |  |
| 2026-10-31 15:19 | `fafb7b4b72` | ON-MAIN | 4/0/0/0 | builder/byok | 🐛 fix(mvp): todo-steer checks the run page's heading, declares Watch's |  |
| 2026-10-31 15:19 | `d4b99ce31b` | ON-MAIN | 3/0/0/0 | builder/byok | 🐛 fix(mvp): todo-steer checks the run page's heading, which replaced i |  |
| 2026-10-31 15:19 | `ab6868b4a9` | PARTIAL | 0/0/0/1 | ab6868b4a9 |  | apps/mvp/e2e/toast-layout-shift.spec.ts: await expect(ann.page.locator(".repo-page").or(an |
| 2026-10-31 15:19 | `1e8eb7c87f` | PARTIAL | 22/2/11/10 | 1e8eb7c87f |  | .changeset/toast-stack-anchored.md: `ToastStack` overlays the page in every placement. `pl |
| 2026-10-31 15:24 | `32cd3a0296` | SUPERSEDED | 13/3/0/0 | 32cd3a0296 |  | apps/mvp/src/router.tsx: main carried then changed it: 9578ac28b3 (🐛 fix(mvp): bind branch |
| 2026-10-31 15:24 | `3e25393fcd` | SUPERSEDED | 13/3/0/0 | 3e25393fcd |  | apps/mvp/src/router.tsx: main carried then changed it: 9578ac28b3 (🐛 fix(mvp): bind branch |
| 2026-10-31 15:37 | `c5bd6f21fd` | SUPERSEDED | 14/2/0/0 | builder/s3-steer | 📝 docs: regenerate the site's agent, flow, harness and notifications A | apps/site/public/llms-full.txt: main carried then changed it: adab8bbabc (✨ feat(cli): a r |
| 2026-10-31 15:37 | `2554588b75` | SUPERSEDED | 14/2/0/0 | builder/s3-steer | 📝 docs: regenerate the site's agent, flow, harness and notifications A | apps/site/public/llms-full.txt: main carried then changed it: adab8bbabc (✨ feat(cli): a r |
| 2026-10-31 15:45 | `4d9a81dfbd` | ON-MAIN | 2/0/0/0 | builder/stack-flake | ✅ test(mvp): record device epoch 103 and read issue-writes' version fr |  |
| 2026-10-31 15:45 | `ead2a1683e` | ON-MAIN | 2/0/0/0 | builder/stack-flake | ✅ test(mvp): record device epoch 103 and read issue-writes' version fr |  |
| 2026-10-31 15:45 | `4a3076766a` | ON-MAIN | 2/0/0/0 | builder/stack-flake | ✅ test(mvp): record device epoch 103 and read issue-writes' version fr |  |
| 2026-10-31 15:45 | `759b8ee64c` | ON-MAIN | 2/0/0/0 | 759b8ee64c | ✅ test(mvp): record device epoch 102 and read issue-writes' version fr |  |
| 2026-10-31 16:25 | `8a700fa755` | SUPERSEDED | 0/80/0/0 | 5686bc4bfc | migrate(vibelang): switch to the toolchain of VibeLang 523fd77f8a1e | .smithers/flows/package.json: changed later in its stack (head 5686bc4bfc) |
| 2026-10-31 16:25 | `f75f236f2c` | SUPERSEDED | 0/80/0/0 | 775f26b754 | migrate(vibelang): switch to the toolchain of VibeLang 523fd77f8a1e | .smithers/flows/package.json: changed later in its stack (head 775f26b754) |
| 2026-10-31 16:25 | `4d9d63fc47` | SUPERSEDED | 0/80/0/0 | faf3ec5b89 | migrate(vibelang): switch to the toolchain of VibeLang 523fd77f8a1e | .smithers/flows/package.json: changed later in its stack (head faf3ec5b89, d977f8f878, 837 |
| 2026-10-31 16:29 | `59a4730c6c` | PARTIAL | 0/2/2/0 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/flows/capability/tsconfig.json: "vibelang": { "declarationSidecars": tru |
| 2026-10-31 16:29 | `3872ca4e8c` | PARTIAL | 0/2/2/0 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/flows/capability/tsconfig.json: "vibelang": { "declarationSidecars": tru |
| 2026-10-31 16:29 | `5f5c01367b` | ON-MAIN | 4/0/0/0 | builder/stack-flake | 🐛 fix(mvp): a stack starts its ready TODOs oldest first, whatever orde |  |
| 2026-10-31 16:29 | `0db52eb270` | ON-MAIN | 4/0/0/0 | builder/stack-flake | 🐛 fix(mvp): a stack starts its ready TODOs oldest first, whatever orde |  |
| 2026-10-31 16:29 | `4e42c3bae8` | ON-MAIN | 4/0/0/0 | builder/stack-flake | 🐛 fix(mvp): a stack starts its ready TODOs oldest first, whatever orde |  |
| 2026-10-31 16:29 | `673f6e8e10` | PARTIAL | 0/2/2/0 | faf3ec5b89 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/flows/capability/tsconfig.json: "vibelang": { "declarationSidecars": tru |
| 2026-10-31 16:31 | `0659b55e20` | PARTIAL | 2/0/9/1 | 5686bc4bfc | migrate(vibelang): batch 01: PatternResource.vibe | packages/smithers/flows/capability/PACKAGE.ts: "src/internal/PatternResource.vibe"; packag |
| 2026-10-31 16:31 | `f3815c9f8b` | PARTIAL | 2/0/9/1 | 775f26b754 | migrate(vibelang): batch 01: PatternResource.vibe | packages/smithers/flows/capability/PACKAGE.ts: "src/internal/PatternResource.vibe"; packag |
| 2026-10-31 16:31 | `f6ac6c3257` | PARTIAL | 2/0/9/1 | faf3ec5b89 | migrate(vibelang): batch 01: PatternResource.vibe | packages/smithers/flows/capability/PACKAGE.ts: "src/internal/PatternResource.vibe"; packag |
| 2026-10-31 16:38 | `dc8e519e65` | SCAFFOLD | 25/13/9/3 | e7b5a39485 | wip: review fixes | apps/mvp/db/migrations/0075_timeline_phases.ts: // The rail's phases and arcs (ruling FE-1 |
| 2026-10-31 16:45 | `86021e62c1` | PARTIAL | 0/0/0/1 | 86021e62c1 |  | apps/mvp/e2e/toast-layout-shift.spec.ts: expect(toastBox.y, "the toast sits right under th |
| 2026-10-31 16:49 | `866e2f8d10` | SUPERSEDED | 27/1/0/0 | 866e2f8d10 |  | apps/mvp/docs/work/refs-dedupe.md: landed as a35b513380 (same author and time, committed l |
| 2026-10-31 16:53 | `2121da0e86` | SUPERSEDED | 0/82/0/0 | 5686bc4bfc | migrate(vibelang): switch to the toolchain of VibeLang 773bddb1d57f | .smithers/flows/package.json: changed later in its stack (head 5686bc4bfc) |
| 2026-10-31 16:53 | `03f0110cd0` | SUPERSEDED | 0/82/0/0 | 775f26b754 | migrate(vibelang): switch to the toolchain of VibeLang 773bddb1d57f | .smithers/flows/package.json: changed later in its stack (head 775f26b754) |
| 2026-10-31 16:53 | `22dd31bb8c` | PARTIAL | 0/71/11/0 | faf3ec5b89 | migrate(vibelang): switch to the toolchain of VibeLang 773bddb1d57f | packages/errors/package.json: "vibelang-runtime": "file:../../.vibelang-toolchain/vibelang |
| 2026-10-31 16:54 | `6fa87461ec` | PARTIAL | 20/148/234/12 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | .smithers/flows/dprint.json: "review/seeded-bugs",; .smithers/flows/eslint.config.js: { ig |
| 2026-10-31 16:54 | `e9e5159acf` | PARTIAL | 20/146/237/11 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | .smithers/flows/dprint.json: "review/seeded-bugs",; .smithers/flows/eslint.config.js: { ig |
| 2026-10-31 16:54 | `674603c1ef` | PARTIAL | 20/0/334/60 | faf3ec5b89 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | .smithers/flows/dprint.json: "review/seeded-bugs",; .smithers/flows/eslint.config.js: { ig |
| 2026-10-31 17:02 | `413a5be0f2` | ON-MAIN | 12/0/0/0 | builder/answers-fix | 🐛 fix(ui): a RelativeTime re-renders only when its label changes, so a |  |
| 2026-10-31 17:04 | `79bf20dc9f` | SUPERSEDED | 0/6/0/0 | 5686bc4bfc | migrate(vibelang): drop the obsolete declarationSidecars setting | packages/smithers/flows/canonical/tsconfig.json: changed later in its stack (head 5686bc4b |
| 2026-10-31 17:04 | `7ebc92017a` | SUPERSEDED | 0/6/0/0 | 775f26b754 | migrate(vibelang): drop the obsolete declarationSidecars setting | packages/smithers/flows/canonical/tsconfig.json: changed later in its stack (head 775f26b7 |
| 2026-10-31 17:04 | `94e6d1de2d` | STRANDED | 0/0/6/0 | faf3ec5b89 | migrate(vibelang): drop the obsolete declarationSidecars setting | packages/smithers/flows/canonical/tsconfig.json: "vibelang": {}; packages/smithers/flows/c |
| 2026-10-31 17:19 | `bee02c8db3` | SUPERSEDED | 5/1/0/0 | 9ccdbed588 | 🐛 fix(timeline): restrict rail entries to questions and answers | apps/mvp/src/features/timeline/view.ts: changed later in its stack (head 142da7756c, 028f0 |
| 2026-10-31 17:19 | `01edcbabe8` | SUPERSEDED | 5/1/0/0 | b665026cf8 | 🐛 fix(timeline): restrict rail entries to questions and answers | apps/mvp/src/features/timeline/view.ts: changed later in its stack (head e9ad232873) |
| 2026-10-31 17:20 | `44aa4f3d45` | PARTIAL | 9/0/0/3 | 9f4603355d | 🐛 fix(timeline): notify every summary preventing failure | apps/mvp/src/features/timeline/notice.test.ts: +test("a conversation that can't be read le |
| 2026-10-31 17:20 | `19ad673c5c` | PARTIAL | 9/0/0/2 | 5c06bc2a31 | 🐛 fix(timeline): notify every summary preventing failure | apps/mvp/src/features/timeline/notice.test.ts: +test("a conversation that can't be read le |
| 2026-10-31 17:20 | `2e0e371f1e` | PARTIAL | 9/0/1/2 | 9ccdbed588 | 🐛 fix(timeline): notify every summary preventing failure | apps/mvp/src/features/timeline/notice.test.ts: const messages = await Effect.runPromise(Sc |
| 2026-10-31 17:20 | `31da3f197b` | PARTIAL | 9/0/1/2 | b665026cf8 | 🐛 fix(timeline): notify every summary preventing failure | apps/mvp/src/features/timeline/notice.test.ts: const messages = await Effect.runPromise(Sc |
| 2026-10-31 17:20 | `af9f186bc1` | SUPERSEDED | 3/3/0/0 | e7b5a39485 | 🐛 fix(ui): invalidate timeline windows when the rail resizes | packages/smithers/ui/src/chat/timelineDriver.ts: main carried then changed it: 74c53a0117 |
| 2026-10-31 17:20 | `7a27f24d4a` | SUPERSEDED | 11/2/0/0 | e7b5a39485 | 🐛 fix(ui): preserve timeline summary coverage endpoints | apps/mvp/docs/work/timeline-geometry.md: main carried then changed it: 01725f96aa (💄 fix(u |
| 2026-10-31 17:22 | `d847209232` | PARTIAL | 7/3/0/2 | 9f4603355d | 🐛 fix(timeline): keep semantic phases open with rolling summaries | apps/mvp/docs/decisions/0133-timeline-phases.md: -A closed span is never read again, so th |
| 2026-10-31 17:22 | `b2b15216cc` | PARTIAL | 7/3/0/2 | 5c06bc2a31 | 🐛 fix(timeline): keep semantic phases open with rolling summaries | apps/mvp/docs/decisions/0133-timeline-phases.md: -A closed span is never read again, so th |
| 2026-10-31 17:22 | `e087749194` | PARTIAL | 6/3/0/2 | 9ccdbed588 | 🐛 fix(timeline): keep semantic phases open with rolling summaries | apps/mvp/docs/decisions/0133-timeline-phases.md: -A closed span is never read again, so th |
| 2026-10-31 17:22 | `c76a300fd2` | PARTIAL | 8/3/0/1 | b665026cf8 | 🐛 fix(timeline): keep semantic phases open with rolling summaries | apps/mvp/docs/decisions/0133-timeline-phases.md: 8. **Stops say so.** A failure every late |
| 2026-10-31 17:22 | `21ff395d76` | SUPERSEDED | 5/6/0/0 | e7b5a39485 | 🐛 fix(ui): load lens drag targets before restoring their position | packages/smithers/ui/docs/chat-timeline.md: main carried then changed it: 01725f96aa (💄 fi |
| 2026-10-31 17:24 | `523f7daeb1` | STRANDED | 0/0/3/0 | 523f7daeb1 | 🐛 fix(timeline): show each message’s own model summary | apps/mvp/src/features/timeline/view.test.ts: +  expect(railMarkers([{ ...row, status: "uns |
| 2026-10-31 17:24 | `9f4603355d` | PARTIAL | 18/1/2/0 | 9f4603355d | 🐛 fix(timeline): show each message’s own model summary | apps/mvp/src/features/timeline/view.test.ts: +  expect(railMarkers([{ ...row, status: "uns |
| 2026-10-31 17:24 | `5c06bc2a31` | PARTIAL | 18/1/2/0 | 5c06bc2a31 | 🐛 fix(timeline): show each message’s own model summary | apps/mvp/src/features/timeline/view.test.ts: +  expect(railMarkers([{ ...row, status: "uns |
| 2026-10-31 17:24 | `ba9d54389c` | PARTIAL | 8/0/1/0 | 9ccdbed588 | 🐛 fix(timeline): show each message’s own model summary | apps/mvp/src/features/timeline/view.test.ts: +  expect(railMarkers([{ ...row, status: "uns |
| 2026-10-31 17:24 | `9c09a4cdc2` | PARTIAL | 9/0/0/1 | b665026cf8 | 🐛 fix(timeline): show each message’s own model summary | apps/mvp/src/features/timeline/view.test.ts: expect(railMarkers([{ ...row, status: "unsent |
| 2026-10-31 17:24 | `d718788ed4` | SUPERSEDED | 16/14/0/0 | e7b5a39485 | 🐛 fix(ui): extend semantic timeline levels with bounded windows | packages/smithers/ui/docs/chat-timeline.md: main carried then changed it: 21b6e888d4 (✨ fe |
| 2026-10-31 17:28 | `e7b5a39485` | PARTIAL | 5/0/12/5 | e7b5a39485 |  | apps/mvp/docs/decisions/0134-timeline-covered-windows.md: 2026-10-31 · Implements FE-16 an |
| 2026-10-31 17:30 | `5b5b43d753` | PARTIAL | 2/0/1/0 | 9ccdbed588 | 🐛 fix(ui): retain distinct pending timeline labels | packages/smithers/ui/src/chat/ChatTimeline.tsx: const label = entry.summary ?? entry.label |
| 2026-10-31 17:30 | `b876153036` | PARTIAL | 2/0/1/0 | b665026cf8 | 🐛 fix(ui): retain distinct pending timeline labels | packages/smithers/ui/src/chat/ChatTimeline.tsx: const label = entry.summary ?? entry.label |
| 2026-10-31 17:33 | `78e0972cba` | ON-MAIN | 4/0/0/0 | builder/answers-fix | 🐛 fix(mvp): a drop starts its pull request's cleanup even when the run |  |
| 2026-10-31 17:40 | `3299c2e944` | PARTIAL | 3/0/0/1 | 9ccdbed588 | ✅ test(timeline): exercise phase following through real persistence | apps/mvp/src/features/timeline/phase-follower.integration.test.ts: tab = openTab(api, { ho |
| 2026-10-31 17:40 | `b665026cf8` | PARTIAL | 3/0/0/1 | b665026cf8 | ✅ test(timeline): exercise phase following through real persistence | apps/mvp/src/features/timeline/phase-follower.integration.test.ts: tab = openTab(api, { ho |
| 2026-10-31 17:46 | `e41e5776db` | SUPERSEDED | 0/75/0/0 | 5686bc4bfc | migrate(vibelang): switch to the toolchain of VibeLang 2e2630ccff5c | .smithers/flows/package.json: changed later in its stack (head 5686bc4bfc) |
| 2026-10-31 17:46 | `81a9d964a2` | SUPERSEDED | 0/75/0/0 | 775f26b754 | migrate(vibelang): switch to the toolchain of VibeLang 2e2630ccff5c | .smithers/flows/package.json: changed later in its stack (head 775f26b754) |
| 2026-10-31 17:46 | `c8d6ea4841` | STRANDED | 0/0/75/0 | faf3ec5b89 | migrate(vibelang): switch to the toolchain of VibeLang 2e2630ccff5c | .smithers/flows/package.json: "vibelang": "file:../../.vibelang-toolchain/vibelang-0.0.11- |
| 2026-10-31 17:48 | `7917820992` | SUPERSEDED | 6/2/0/0 | 9ccdbed588 | 📝 docs(timeline): document semantic phases and per-message labels | apps/mvp/docs/features/timeline.md: changed later in its stack (head 0281f88637) |
| 2026-10-31 17:48 | `27e3332cdd` | PARTIAL | 6/1/0/1 | 27e3332cdd |  | apps/mvp/docs/features/timeline.md: The app says so; it never falls back silently (FE-19). |
| 2026-10-31 17:52 | `e5c1a1951b` | PARTIAL | 1/0/0/1 | 9ccdbed588 | ✅ test(timeline): preserve durable rolling payload compatibility | apps/mvp/src/features/timeline/phases.test.ts: +import { SEGMENT_PROMPT } from "./steps" |
| 2026-10-31 17:52 | `01328ab675` | SUPERSEDED | 0/1/0/0 | builder/stack-flake | 🐛 fix(mvp): record /api/me/model/codex and /api/me/model/jev by their  | apps/mvp/src/apiRoutes.ts: main carried then changed it: 02461910a2 (✨ feat(mvp): the flee |
| 2026-10-31 17:52 | `e39339cd69` | SUPERSEDED | 0/1/0/0 | builder/stack-flake | 🐛 fix(mvp): record /api/me/model/codex and /api/me/model/jev by their  | apps/mvp/src/apiRoutes.ts: main carried then changed it: 02461910a2 (✨ feat(mvp): the flee |
| 2026-10-31 17:52 | `83cf637eaf` | SUPERSEDED | 0/1/0/0 | builder/stack-flake | 🐛 fix(mvp): record /api/me/model/codex and /api/me/model/jev by their  | apps/mvp/src/apiRoutes.ts: main carried then changed it: 02461910a2 (✨ feat(mvp): the flee |
| 2026-10-31 17:53 | `4cd23e331d` | SUPERSEDED | 3/1/0/0 | 9ccdbed588 | 🐛 fix(timeline): satisfy strict notice and integration contracts | apps/mvp/src/features/timeline/notice.ts: changed later in its stack (head 0281f88637) |
| 2026-10-31 17:53 | `4c86000df8` | ON-MAIN | 1/0/0/0 | builder/stack-flake | ✅ test(mvp): the deployed flows include model/CodexLink, as worker/Exe |  |
| 2026-10-31 17:53 | `5811d8101e` | ON-MAIN | 1/0/0/0 | builder/stack-flake | ✅ test(mvp): the deployed flows include model/CodexLink, as worker/Exe |  |
| 2026-10-31 17:53 | `6126f24308` | ON-MAIN | 1/0/0/0 | builder/stack-flake | ✅ test(mvp): the deployed flows include model/CodexLink, as worker/Exe |  |
| 2026-10-31 17:56 | `5aed6d8799` | PARTIAL | 4/0/1/1 | 9ccdbed588 | 🐛 fix(timeline): keep entry failures out of global rail availability | apps/mvp/src/features/timeline/notice.test.ts: expect(await Effect.runPromise(state.toArra |
| 2026-10-31 17:57 | `9ccdbed588` | ON-MAIN | 1/0/0/0 | 9ccdbed588 | ✅ test(ui): keep supplied failure labels visible |  |
| 2026-10-31 18:07 | `fea394ac50` | STRANDED | 0/0/1/0 | fea394ac50 |  | apps/mvp/worker/TimelineSummaries.ts: export const dailyCap = Config.schema(Schema.Int.che |
| 2026-10-31 18:07 | `bde074effb` | PARTIAL | 0/0/4/1 | bde074effb |  | apps/mvp/db/Database.ts: import branchWriteNotices from "./migrations/0071_branch_write_no |
| 2026-10-31 18:26 | `13f0281a2f` | ON-MAIN | 4/0/0/0 | builder/stack-flake | 📝 docs(mvp): the personal model code cites decision 0132, model connec |  |
| 2026-10-31 18:26 | `07f9a17ffa` | ON-MAIN | 4/0/0/0 | builder/stack-flake | 📝 docs(mvp): the personal model code cites decision 0132, model connec |  |
| 2026-10-31 18:37 | `1de5e182cf` | SUPERSEDED | 39/10/0/0 | 1de5e182cf |  | apps/mvp/src/features/first-run/components/first-run.css: main carried then changed it: e3 |
| 2026-10-31 20:04 | `6e01efc2e6` | ON-MAIN | 9/0/0/0 | cda4f0dd87 | 🐛 fix(mvp): a skipped e2e test gets no video or GIF, so its blank reco |  |
| 2026-10-31 20:06 | `cda4f0dd87` | PARTIAL | 34/7/1/0 | cda4f0dd87 | ✅ test(mvp): production e2e runs TODOs, independent lanes and an exter | apps/mvp/stack.png (binary); apps/mvp/docs/infrastructure.md: main carried then changed it |
| 2026-10-31 20:51 | `8ecf2957e4` | PARTIAL | 1/1/4/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/canonical: 1 of 2 modules t | packages/smithers/flows/canonical/PACKAGE.ts: const sources = Input.glob("{src,examples}/* |
| 2026-10-31 20:51 | `5f5eeb4f54` | PARTIAL | 1/1/4/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/canonical: 1 of 2 modules t | packages/smithers/flows/canonical/PACKAGE.ts: const sources = Input.glob("{src,examples}/* |
| 2026-10-31 20:51 | `62badf998e` | PARTIAL | 1/0/4/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/canonical: 1 of 2 modules t | packages/smithers/flows/canonical/PACKAGE.ts: const sources = Input.glob("{src,examples}/* |
| 2026-10-31 21:27 | `1f8b169cbe` | PARTIAL | 0/1/2/0 | faf3ec5b89 | migrate(vibelang): patch @effect/platform-node-shared 4.1.0 to pass an | patches/@effect__platform-node-shared@4.1.0.patch: +    // A null prototype keeps every ke |
| 2026-10-31 21:32 | `aeddd3ae7c` | PARTIAL | 0/0/5/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/capability: 1 of 24 modules | packages/smithers/flows/capability/examples/grant.d.vibe.ts: import { Capability } from "@ |
| 2026-10-31 21:32 | `3d72f5b733` | PARTIAL | 0/0/5/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/capability: 1 of 24 modules | packages/smithers/flows/capability/examples/grant.d.vibe.ts: import { Capability } from "@ |
| 2026-10-31 21:32 | `2674bee08b` | PARTIAL | 0/0/5/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/capability: 1 of 24 modules | packages/smithers/flows/capability/examples/grant.d.vibe.ts: import { Capability } from "@ |
| 2026-10-31 21:32 | `dbef79d353` | PARTIAL | 0/0/5/1 | dbef79d353 | migrate(vibelang): packages/smithers/flows/capability: 1 of 24 modules | packages/smithers/flows/capability/examples/grant.d.vibe.ts: import { Capability } from "@ |
| 2026-10-31 23:26 | `10be073ccc` | PARTIAL | 0/66/73/0 | 5686bc4bfc | migrate(vibelang): switch to the toolchain of VibeLang d75b90ff280c | .smithers/flows/package.json: "vibelang-runtime": "file:../../.vibelang-toolchain/vibelang |
| 2026-10-31 23:26 | `6420d28461` | PARTIAL | 0/66/73/0 | 775f26b754 | migrate(vibelang): switch to the toolchain of VibeLang d75b90ff280c | .smithers/flows/package.json: "vibelang-runtime": "file:../../.vibelang-toolchain/vibelang |
| 2026-10-31 23:26 | `cab7e1b8ae` | PARTIAL | 0/8/131/0 | faf3ec5b89 | migrate(vibelang): switch to the toolchain of VibeLang d75b90ff280c | .smithers/flows/package.json: "vibelang-runtime": "file:../../.vibelang-toolchain/vibelang |
| 2026-10-31 23:39 | `4e39876dbd` | PARTIAL | 0/62/73/0 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | apps/bug-worker/tsconfig.json: "moduleSuffixes": ["",".d.vibe"],; apps/mvp/bench/tsconfig. |
| 2026-10-31 23:39 | `5e4226aa4d` | PARTIAL | 0/62/73/0 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | apps/bug-worker/tsconfig.json: "moduleSuffixes": ["",".d.vibe"],; apps/mvp/bench/tsconfig. |
| 2026-10-31 23:39 | `9d39959a3e` | PARTIAL | 0/1/134/0 | faf3ec5b89 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | apps/bug-worker/tsconfig.json: "moduleSuffixes": ["",".d.vibe"],; apps/mvp/bench/tsconfig. |
| 2026-11-01 00:34 | `acd751b4a0` | PARTIAL | 1/0/6/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/std: 1 of 44 modules to .vi | packages/smithers/agent/std/src/RemoteSearch.ts: import * as RemoteTree from "./internal/R |
| 2026-11-01 00:34 | `d0a15f1234` | PARTIAL | 1/0/6/1 | 775f26b754 | migrate(vibelang): packages/smithers/agent/std: 1 of 44 modules to .vi | packages/smithers/agent/std/src/RemoteSearch.ts: import * as RemoteTree from "./internal/R |
| 2026-11-01 00:34 | `bfd5c941c7` | PARTIAL | 1/0/6/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/std: 1 of 44 modules to .vi | packages/smithers/agent/std/src/RemoteSearch.ts: import * as RemoteTree from "./internal/R |
| 2026-11-01 01:33 | `113581c854` | PARTIAL | 1/0/3/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/engine: 1 of 20 modules to  | packages/smithers/flows/engine/src/FlowEngine/Dispatch.ts: import { toJsonExit } from "../ |
| 2026-11-01 01:33 | `08dfbef368` | PARTIAL | 1/0/3/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/engine: 1 of 20 modules to  | packages/smithers/flows/engine/src/FlowEngine/Dispatch.ts: import { toJsonExit } from "../ |
| 2026-11-01 01:33 | `48c3084b64` | PARTIAL | 1/0/3/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/engine: 1 of 20 modules to  | packages/smithers/flows/engine/src/FlowEngine/Dispatch.ts: import { toJsonExit } from "../ |
| 2026-11-01 01:36 | `37300723e1` | PARTIAL | 0/0/4/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/time-travel: 1 of 29 module | packages/smithers/flows/time-travel/src/internal/LineageMetadata.d.vibe.ts: export declare |
| 2026-11-01 01:36 | `468d746180` | PARTIAL | 0/0/4/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/time-travel: 1 of 29 module | packages/smithers/flows/time-travel/src/internal/LineageMetadata.d.vibe.ts: export declare |
| 2026-11-01 01:36 | `3d33317adc` | PARTIAL | 0/0/4/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/time-travel: 1 of 29 module | packages/smithers/flows/time-travel/src/internal/LineageMetadata.d.vibe.ts: export declare |
| 2026-11-01 01:37 | `990fc0e956` | PARTIAL | 1/0/6/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/patterns: 1 of 31 modules t | packages/smithers/flows/patterns/src/DelegationChain.ts: import * as FailureSchema from ". |
| 2026-11-01 01:37 | `fe620b2460` | PARTIAL | 1/0/6/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/patterns: 1 of 31 modules t | packages/smithers/flows/patterns/src/DelegationChain.ts: import * as FailureSchema from ". |
| 2026-11-01 01:37 | `5dacc646e7` | PARTIAL | 1/0/6/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/patterns: 1 of 31 modules t | packages/smithers/flows/patterns/src/DelegationChain.ts: import * as FailureSchema from ". |
| 2026-11-01 01:38 | `62c6099572` | PARTIAL | 1/0/2/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/control: 1 of 36 modules to .vibe | packages/smithers/control/src/SqlControlRuntime.ts: import * as ActiveFibers from "./inter |
| 2026-11-01 01:38 | `8fd5acb140` | PARTIAL | 1/0/2/1 | 775f26b754 | migrate(vibelang): packages/smithers/control: 1 of 36 modules to .vibe | packages/smithers/control/src/SqlControlRuntime.ts: import * as ActiveFibers from "./inter |
| 2026-11-01 01:38 | `e3e1034286` | PARTIAL | 1/0/2/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/control: 1 of 36 modules to .vibe | packages/smithers/control/src/SqlControlRuntime.ts: import * as ActiveFibers from "./inter |
| 2026-11-01 02:00 | `df9c6656aa` | PARTIAL | 0/0/101/45 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent: 36 of 116 modules to .vibe | packages/smithers/agent/examples/use-cases/alert-suppressor.d.vibe.ts: export declare cons |
| 2026-11-01 02:00 | `3e01ea7761` | PARTIAL | 0/0/101/45 | 775f26b754 | migrate(vibelang): packages/smithers/agent: 36 of 116 modules to .vibe | packages/smithers/agent/examples/use-cases/alert-suppressor.d.vibe.ts: export declare cons |
| 2026-11-01 02:00 | `d7cee7a508` | PARTIAL | 0/0/101/45 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent: 36 of 116 modules to .vibe | packages/smithers/agent/examples/use-cases/alert-suppressor.d.vibe.ts: export declare cons |
| 2026-11-01 02:02 | `99375c169d` | PARTIAL | 1/0/16/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/platform-browser: 2 of 36 m | packages/smithers/flows/platform-browser/src/BrowserEngine.ts: import * as RunReads from " |
| 2026-11-01 02:02 | `d5772871b3` | PARTIAL | 1/0/16/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/platform-browser: 2 of 36 m | packages/smithers/flows/platform-browser/src/BrowserEngine.ts: import * as RunReads from " |
| 2026-11-01 02:02 | `895d55d44b` | PARTIAL | 1/0/16/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/platform-browser: 2 of 36 m | packages/smithers/flows/platform-browser/src/BrowserEngine.ts: import * as RunReads from " |
| 2026-11-01 02:04 | `8f0283f976` | PARTIAL | 0/1/5/0 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/registry: 1 of 18 modules t | packages/smithers/agent/registry/src/Executable.ts: import * as Declared from "./internal/ |
| 2026-11-01 02:04 | `e2e631b8b5` | PARTIAL | 0/1/5/0 | 775f26b754 | migrate(vibelang): packages/smithers/agent/registry: 1 of 18 modules t | packages/smithers/agent/registry/src/Executable.ts: import * as Declared from "./internal/ |
| 2026-11-01 02:04 | `1137b83beb` | PARTIAL | 0/1/5/0 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/registry: 1 of 18 modules t | packages/smithers/agent/registry/src/Executable.ts: import * as Declared from "./internal/ |
| 2026-11-01 02:06 | `4f052c7b94` | PARTIAL | 5/0/13/3 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/platform-node: 3 of 22 modu | packages/smithers/flows/platform-node/src/internal/AtomicFileSystemProtocol.ts: import { a |
| 2026-11-01 02:06 | `025b3c928c` | PARTIAL | 5/0/13/3 | 775f26b754 | migrate(vibelang): packages/smithers/flows/platform-node: 3 of 22 modu | packages/smithers/flows/platform-node/src/internal/AtomicFileSystemProtocol.ts: import { a |
| 2026-11-01 02:06 | `107c1c0222` | PARTIAL | 5/0/13/3 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/platform-node: 3 of 22 modu | packages/smithers/flows/platform-node/src/internal/AtomicFileSystemProtocol.ts: import { a |
| 2026-11-01 02:08 | `e15cd46093` | PARTIAL | 2/0/2/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/ui/views: 1 of 9 modules to .vibe | packages/smithers/ui/views/examples/render-a-view.d.vibe.ts: }, PresentationRealm.RealmErr |
| 2026-11-01 02:08 | `ff58e9b718` | PARTIAL | 2/0/2/1 | 775f26b754 | migrate(vibelang): packages/smithers/ui/views: 1 of 9 modules to .vibe | packages/smithers/ui/views/examples/render-a-view.d.vibe.ts: }, PresentationRealm.RealmErr |
| 2026-11-01 02:08 | `e7818e18bc` | PARTIAL | 2/0/2/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/ui/views: 1 of 9 modules to .vibe | packages/smithers/ui/views/examples/render-a-view.d.vibe.ts: }, PresentationRealm.RealmErr |
| 2026-11-01 02:10 | `410885666e` | PARTIAL | 1/0/8/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/gateway: 1 of 18 modules to .vibe | packages/smithers/gateway/PACKAGE.ts: testSources: Input.glob("{test,examples}/**/*.{ts,vi |
| 2026-11-01 02:10 | `e0d8b852d5` | PARTIAL | 1/0/8/1 | 775f26b754 | migrate(vibelang): packages/smithers/gateway: 1 of 18 modules to .vibe | packages/smithers/gateway/PACKAGE.ts: testSources: Input.glob("{test,examples}/**/*.{ts,vi |
| 2026-11-01 02:10 | `1457cadf34` | PARTIAL | 1/0/8/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/gateway: 1 of 18 modules to .vibe | packages/smithers/gateway/PACKAGE.ts: testSources: Input.glob("{test,examples}/**/*.{ts,vi |
| 2026-11-01 02:24 | `6a44a06851` | PARTIAL | 1/1/4/0 | 5686bc4bfc | migrate(vibelang): packages/smithers/migrate: 1 of 28 modules to .vibe | packages/smithers/migrate/PACKAGE.ts: "src/flow/Repair.vibe",; packages/smithers/migrate/s |
| 2026-11-01 02:24 | `a7ed8524ea` | PARTIAL | 1/1/4/0 | 775f26b754 | migrate(vibelang): packages/smithers/migrate: 1 of 28 modules to .vibe | packages/smithers/migrate/PACKAGE.ts: "src/flow/Repair.vibe",; packages/smithers/migrate/s |
| 2026-11-01 02:24 | `8864d8d462` | PARTIAL | 1/0/4/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/migrate: 1 of 28 modules to .vibe | packages/smithers/migrate/PACKAGE.ts: "src/flow/Repair.vibe",; packages/smithers/migrate/p |
| 2026-11-01 02:25 | `9c0eed8baf` | PARTIAL | 3/2/27/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/chain: 3 of 21 modules to . | packages/smithers/agent/chain/PACKAGE.ts: "src/CallKey.vibe",; packages/smithers/agent/cha |
| 2026-11-01 02:25 | `3279441c20` | PARTIAL | 3/2/27/2 | 775f26b754 | migrate(vibelang): packages/smithers/agent/chain: 3 of 21 modules to . | packages/smithers/agent/chain/PACKAGE.ts: "src/CallKey.vibe",; packages/smithers/agent/cha |
| 2026-11-01 02:25 | `da1aff3060` | PARTIAL | 3/0/29/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/chain: 3 of 21 modules to . | packages/smithers/agent/chain/PACKAGE.ts: "src/CallKey.vibe",; packages/smithers/agent/cha |
| 2026-11-01 02:32 | `4fa68fe63f` | SUPERSEDED | 0/75/0/0 | 5686bc4bfc | migrate(vibelang): switch to the toolchain of VibeLang 36b35811ee1e | .smithers/flows/package.json: changed later in its stack (head 5686bc4bfc) |
| 2026-11-01 02:32 | `eca999442f` | SUPERSEDED | 0/75/0/0 | 775f26b754 | migrate(vibelang): switch to the toolchain of VibeLang 36b35811ee1e | .smithers/flows/package.json: changed later in its stack (head 775f26b754) |
| 2026-11-01 02:32 | `d5ac0380eb` | SUPERSEDED | 0/75/0/0 | faf3ec5b89 | migrate(vibelang): switch to the toolchain of VibeLang 36b35811ee1e | .smithers/flows/package.json: changed later in its stack (head faf3ec5b89, d977f8f878, 837 |
| 2026-11-01 02:33 | `3b90f5a164` | PARTIAL | 0/4/60/0 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | apps/bug-worker/tsconfig.json: "include": ["src/**/*", "tests/**/*", "alchemy.run.ts", "al |
| 2026-11-01 02:33 | `3860d08783` | PARTIAL | 0/1/63/0 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | apps/bug-worker/tsconfig.json: "include": ["src/**/*", "tests/**/*", "alchemy.run.ts", "al |
| 2026-11-01 02:33 | `80745237b8` | STRANDED | 0/0/64/0 | faf3ec5b89 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | apps/bug-worker/tsconfig.json: "include": ["src/**/*", "tests/**/*", "alchemy.run.ts", "al |
| 2026-11-01 02:46 | `7e1562de09` | PARTIAL | 0/2/1/0 | 5686bc4bfc | agent/fs: name Effect's FileSystem in scan's contract (VIP-14) | packages/smithers/agent/fs/src/FileRouter.vibe: export effect function scan(config: ScanCo |
| 2026-11-01 02:46 | `e2396114c9` | PARTIAL | 0/2/1/0 | 775f26b754 | agent/fs: name Effect's FileSystem in scan's contract (VIP-14) | packages/smithers/agent/fs/src/FileRouter.vibe: export effect function scan(config: ScanCo |
| 2026-11-01 02:46 | `26063e8372` | PARTIAL | 0/2/1/0 | faf3ec5b89 | agent/fs: name Effect's FileSystem in scan's contract (VIP-14) | packages/smithers/agent/fs/src/FileRouter.vibe: export effect function scan(config: ScanCo |
| 2026-11-01 03:19 | `66b4fe0ac7` | PARTIAL | 1/0/4/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/engine: 1 of 20 modules to  | packages/smithers/flows/engine/src/FlowEngine/FlowInstance.d.vibe.ts: export declare const |
| 2026-11-01 03:19 | `e3a6a0b5f2` | PARTIAL | 1/0/4/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/engine: 1 of 20 modules to  | packages/smithers/flows/engine/src/FlowEngine/FlowInstance.d.vibe.ts: export declare const |
| 2026-11-01 03:19 | `b1c9f168b9` | PARTIAL | 1/0/4/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/engine: 1 of 20 modules to  | packages/smithers/flows/engine/src/FlowEngine/FlowInstance.d.vibe.ts: export declare const |
| 2026-11-01 03:20 | `d967c14ae4` | PARTIAL | 4/7/38/3 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/memory: 3 of 32 modules to  | .smithers/flows/wrapped/flow.ts: import * as MemorySnapshot from "../../../packages/smithe |
| 2026-11-01 03:20 | `a5f1a1c539` | PARTIAL | 0/2/9/0 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/canonical: 1 of 2 modules t | packages/repo-targets/browser/browser-contract.mjs: { name: "@smthrs/canonical", entry: "p |
| 2026-11-01 03:20 | `85b4357ccd` | PARTIAL | 7/3/59/5 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/integrations: 6 of 38 modul | packages/smithers/agent/integrations/PACKAGE.ts: "src/github/Payload.vibe"; packages/smith |
| 2026-11-01 03:20 | `c2e23188c2` | PARTIAL | 4/7/38/3 | 775f26b754 | migrate(vibelang): packages/smithers/agent/memory: 3 of 32 modules to  | .smithers/flows/wrapped/flow.ts: import * as MemorySnapshot from "../../../packages/smithe |
| 2026-11-01 03:20 | `1fcb253cd3` | PARTIAL | 0/1/9/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/canonical: 1 of 2 modules t | packages/repo-targets/browser/browser-contract.mjs: { name: "@smthrs/canonical", entry: "p |
| 2026-11-01 03:20 | `71141fc8a8` | PARTIAL | 7/3/59/5 | 775f26b754 | migrate(vibelang): packages/smithers/agent/integrations: 6 of 38 modul | packages/smithers/agent/integrations/PACKAGE.ts: "src/github/Payload.vibe"; packages/smith |
| 2026-11-01 03:20 | `b2bf5e4d36` | PARTIAL | 4/0/43/5 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/memory: 3 of 32 modules to  | .smithers/flows/wrapped/flow.ts: import * as MemorySnapshot from "../../../packages/smithe |
| 2026-11-01 03:20 | `4fe9753266` | PARTIAL | 0/0/9/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/canonical: 1 of 2 modules t | packages/repo-targets/browser/browser-contract.mjs: { name: "@smthrs/canonical", entry: "p |
| 2026-11-01 03:20 | `7c8ca9c4ab` | PARTIAL | 7/0/60/7 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/integrations: 6 of 38 modul | packages/smithers/agent/integrations/PACKAGE.ts: "src/github/Payload.vibe"; packages/smith |
| 2026-11-01 03:21 | `56546fa346` | PARTIAL | 2/0/15/4 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/platform-cloudflare: 3 of 1 | packages/smithers/flows/platform-cloudflare/PACKAGE.ts: paths: ["src/CloudflareHost.vibe", |
| 2026-11-01 03:21 | `77c834d062` | PARTIAL | 2/11/41/6 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/plugin: 8 of 19 modules to  | packages/smithers/agent/plugin/PACKAGE.ts: paths: ["src/internal/snapshotCacheEnvironment. |
| 2026-11-01 03:21 | `6e09271e9e` | PARTIAL | 1/1/47/3 | 5686bc4bfc | migrate(vibelang): packages/testing: 3 of 36 modules to .vibe | packages/testing/PACKAGE.ts: "src/JournalAssertions.vibe",; packages/testing/src/Conforman |
| 2026-11-01 03:21 | `bd34cad7e9` | PARTIAL | 2/0/15/4 | 775f26b754 | migrate(vibelang): packages/smithers/flows/platform-cloudflare: 3 of 1 | packages/smithers/flows/platform-cloudflare/PACKAGE.ts: paths: ["src/CloudflareHost.vibe", |
| 2026-11-01 03:21 | `0240fc2b49` | PARTIAL | 2/11/48/7 | 775f26b754 | migrate(vibelang): packages/smithers/agent/plugin: 8 of 19 modules to  | packages/smithers/agent/plugin/PACKAGE.ts: paths: ["src/internal/snapshotCacheEnvironment. |
| 2026-11-01 03:21 | `1e2ccbc361` | PARTIAL | 1/1/47/3 | 775f26b754 | migrate(vibelang): packages/testing: 3 of 36 modules to .vibe | packages/testing/PACKAGE.ts: "src/JournalAssertions.vibe",; packages/testing/src/Conforman |
| 2026-11-01 03:21 | `2e7de68139` | PARTIAL | 2/0/15/4 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/platform-cloudflare: 3 of 1 | packages/smithers/flows/platform-cloudflare/PACKAGE.ts: paths: ["src/CloudflareHost.vibe", |
| 2026-11-01 03:21 | `84474d1456` | PARTIAL | 2/0/57/9 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/plugin: 8 of 19 modules to  | packages/smithers/agent/plugin/PACKAGE.ts: paths: ["src/Resolve.ts", "src/Hooks.vibe", "sr |
| 2026-11-01 03:21 | `76b183d202` | PARTIAL | 1/0/47/4 | faf3ec5b89 | migrate(vibelang): packages/testing: 3 of 36 modules to .vibe | packages/testing/PACKAGE.ts: "src/JournalAssertions.vibe",; packages/testing/package.json: |
| 2026-11-01 03:22 | `f656a07281` | PARTIAL | 0/0/65/4 | 5686bc4bfc | migrate(vibelang): packages/smithers/ui/views: 4 of 9 modules to .vibe | packages/smithers/ui/views/PACKAGE.ts: paths: ["src/ViewCsp.vibe"]; packages/smithers/ui/v |
| 2026-11-01 03:22 | `d8923d1713` | PARTIAL | 6/12/124/23 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/harness: 13 of 42 modules t | packages/smithers/agent/harness/PACKAGE.ts: paths: ["src/QuickJSSandbox.ts", "src/Sandbox. |
| 2026-11-01 03:22 | `294afe45c6` | PARTIAL | 0/0/65/4 | 775f26b754 | migrate(vibelang): packages/smithers/ui/views: 4 of 9 modules to .vibe | packages/smithers/ui/views/PACKAGE.ts: paths: ["src/ViewCsp.vibe"]; packages/smithers/ui/v |
| 2026-11-01 03:22 | `becc90a4a7` | PARTIAL | 6/13/124/22 | 775f26b754 | migrate(vibelang): packages/smithers/agent/harness: 13 of 42 modules t | packages/smithers/agent/harness/PACKAGE.ts: paths: ["src/QuickJSSandbox.ts", "src/Sandbox. |
| 2026-11-01 03:22 | `5b668a4e69` | PARTIAL | 0/0/65/4 | faf3ec5b89 | migrate(vibelang): packages/smithers/ui/views: 4 of 9 modules to .vibe | packages/smithers/ui/views/PACKAGE.ts: paths: ["src/ViewCsp.vibe"]; packages/smithers/ui/v |
| 2026-11-01 03:22 | `99bd76d172` | PARTIAL | 6/0/132/27 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/harness: 13 of 42 modules t | packages/smithers/agent/harness/PACKAGE.ts: paths: ["src/QuickJSSandbox.ts", "src/Sandbox. |
| 2026-11-01 03:23 | `162b4918cd` | PARTIAL | 2/2/42/4 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/std: 3 of 44 modules to .vi | packages/smithers/agent/std/PACKAGE.ts: paths: ["src/Checkpoints.ts", "src/internal/GitWor |
| 2026-11-01 03:23 | `fc6a1c6c27` | PARTIAL | 2/2/42/4 | 775f26b754 | migrate(vibelang): packages/smithers/agent/std: 3 of 44 modules to .vi | packages/smithers/agent/std/PACKAGE.ts: paths: ["src/Checkpoints.ts", "src/internal/GitWor |
| 2026-11-01 03:23 | `acbdadbfdc` | PARTIAL | 2/0/42/6 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/std: 3 of 44 modules to .vi | packages/smithers/agent/std/PACKAGE.ts: paths: ["src/Checkpoints.ts", "src/internal/GitWor |
| 2026-11-01 03:41 | `5147486a36` | PARTIAL | 16/41/1822/116 | 775f26b754 | migrate(vibelang): upgrade Effect to 4.1.0 and VibeLang to 0.0.11 | .gitignore: .vibelang-toolchain/; .smithers/flows/bench/README.md: per node on `scheduler- |
| 2026-11-01 03:45 | `7c7b81ee51` | SUPERSEDED | 0/75/0/0 | 5686bc4bfc | migrate(vibelang): switch to the toolchain of VibeLang 14fae26d725f +  | .smithers/flows/package.json: changed later in its stack (head 5686bc4bfc) |
| 2026-11-01 03:45 | `046f8b992f` | SUPERSEDED | 0/75/0/0 | 775f26b754 | migrate(vibelang): switch to the toolchain of VibeLang 14fae26d725f +  | .smithers/flows/package.json: changed later in its stack (head 775f26b754) |
| 2026-11-01 03:45 | `624ff61a2f` | SUPERSEDED | 0/75/0/0 | faf3ec5b89 | migrate(vibelang): switch to the toolchain of VibeLang 14fae26d725f +  | .smithers/flows/package.json: changed later in its stack (head faf3ec5b89, d977f8f878, 837 |
| 2026-11-01 04:04 | `c06606dbf5` | SUPERSEDED | 0/6/0/0 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: changed later in its stack (head 56 |
| 2026-11-01 04:04 | `587e89ca41` | PARTIAL | 0/1/5/0 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: import type * as AgentEvent from ". |
| 2026-11-01 04:04 | `4191b12987` | STRANDED | 0/0/6/0 | faf3ec5b89 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: import type * as AgentEvent from ". |
| 2026-11-01 04:05 | `8d448b7f7b` | PARTIAL | 0/0/4/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/platform-browser: 1 of 36 m | packages/smithers/flows/platform-browser/src/BrowserLanguageServer.ts: import * as Browser |
| 2026-11-01 04:05 | `48b3d1b08e` | PARTIAL | 1/2/4/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/observability: 1 of 12 modu | packages/smithers/flows/observability/src/BrowserOtel.d.vibe.ts: export declare const laye |
| 2026-11-01 04:05 | `69647c13f5` | PARTIAL | 0/0/4/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/platform-browser: 1 of 36 m | packages/smithers/flows/platform-browser/src/BrowserLanguageServer.ts: import * as Browser |
| 2026-11-01 04:05 | `13076615e4` | PARTIAL | 1/2/4/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/observability: 1 of 12 modu | packages/smithers/flows/observability/src/BrowserOtel.d.vibe.ts: export declare const laye |
| 2026-11-01 04:05 | `76898893d9` | PARTIAL | 0/0/4/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/platform-browser: 1 of 36 m | packages/smithers/flows/platform-browser/src/BrowserLanguageServer.ts: import * as Browser |
| 2026-11-01 04:05 | `cd29bc0d58` | PARTIAL | 1/0/5/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/observability: 1 of 12 modu | packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Otlp.ts", "src/NodeOtel.ts" |
| 2026-11-01 04:06 | `1d0675ece6` | PARTIAL | 1/1/11/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/step-cache: 1 of 12 modules | packages/smithers/flows/step-cache/src/CacheStoreMetrics.d.vibe.ts: readonly [Tag in "Inse |
| 2026-11-01 04:06 | `bd810a4aba` | PARTIAL | 10/1/94/9 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/registry: 5 of 18 modules t | packages/smithers/agent/registry/PACKAGE.ts: paths: ["src/internal/Authority.ts", "src/Mar |
| 2026-11-01 04:06 | `834a1f2b41` | PARTIAL | 2/0/15/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/gateway: 1 of 18 modules to .vibe | packages/smithers/gateway/PACKAGE.ts: "src/internal/callEvents.vibe",; packages/smithers/g |
| 2026-11-01 04:06 | `936132bed7` | PARTIAL | 1/1/11/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/step-cache: 1 of 12 modules | packages/smithers/flows/step-cache/src/CacheStoreMetrics.d.vibe.ts: readonly [Tag in "Inse |
| 2026-11-01 04:06 | `2bd0ce66e2` | PARTIAL | 10/1/94/9 | 775f26b754 | migrate(vibelang): packages/smithers/agent/registry: 5 of 18 modules t | packages/smithers/agent/registry/PACKAGE.ts: paths: ["src/internal/Authority.ts", "src/Mar |
| 2026-11-01 04:06 | `f8640d98bb` | PARTIAL | 2/0/15/1 | 775f26b754 | migrate(vibelang): packages/smithers/gateway: 1 of 18 modules to .vibe | packages/smithers/gateway/PACKAGE.ts: "src/internal/callEvents.vibe",; packages/smithers/g |
| 2026-11-01 04:06 | `29a1bf76b1` | PARTIAL | 1/0/11/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/step-cache: 1 of 12 modules | packages/smithers/flows/step-cache/package.json: "types": "./src/CacheStoreMetrics.d.vibe. |
| 2026-11-01 04:06 | `8571d89642` | PARTIAL | 10/0/94/10 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/registry: 5 of 18 modules t | packages/smithers/agent/registry/PACKAGE.ts: paths: ["src/internal/Authority.ts", "src/Mar |
| 2026-11-01 04:06 | `c0beee4550` | PARTIAL | 2/0/15/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/gateway: 1 of 18 modules to .vibe | packages/smithers/gateway/PACKAGE.ts: "src/internal/callEvents.vibe",; packages/smithers/g |
| 2026-11-01 04:08 | `106383a8b0` | PARTIAL | 2/1/18/5 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/journal: 4 of 26 modules to | packages/smithers/flows/journal/src/JournalMetrics.d.vibe.ts: import * as Metric from "eff |
| 2026-11-01 04:08 | `e7b131c646` | PARTIAL | 2/1/18/5 | 775f26b754 | migrate(vibelang): packages/smithers/flows/journal: 4 of 26 modules to | packages/smithers/flows/journal/src/JournalMetrics.d.vibe.ts: import * as Metric from "eff |
| 2026-11-01 04:08 | `7782c7e324` | PARTIAL | 2/0/18/6 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/journal: 4 of 26 modules to | packages/smithers/flows/journal/package.json: "types": "./src/JournalMetrics.d.vibe.ts",; |
| 2026-11-01 04:10 | `4fd42f0449` | PARTIAL | 3/4/45/6 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/triggers: 5 of 20 modules t | packages/smithers/agent/triggers/PACKAGE.ts: paths: ["src/Webhook.ts", "src/Channel.vibe"] |
| 2026-11-01 04:10 | `5697b27d89` | PARTIAL | 3/4/45/6 | 775f26b754 | migrate(vibelang): packages/smithers/agent/triggers: 5 of 20 modules t | packages/smithers/agent/triggers/PACKAGE.ts: paths: ["src/Webhook.ts", "src/Channel.vibe"] |
| 2026-11-01 04:10 | `8f48cb9355` | PARTIAL | 3/0/47/8 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/triggers: 5 of 20 modules t | packages/smithers/agent/triggers/PACKAGE.ts: paths: ["src/Webhook.ts", "src/Channel.vibe"] |
| 2026-11-01 04:18 | `b8d6f481d8` | PARTIAL | 1/0/6/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/platform-node: 1 of 22 modu | packages/smithers/flows/platform-node/src/AtomicFileSystem.ts: export { AtomicHelperError, |
| 2026-11-01 04:18 | `bcf23efac2` | PARTIAL | 1/0/6/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/platform-node: 1 of 22 modu | packages/smithers/flows/platform-node/src/AtomicFileSystem.ts: export { AtomicHelperError, |
| 2026-11-01 04:18 | `3c4e702f37` | PARTIAL | 1/0/6/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/platform-node: 1 of 22 modu | packages/smithers/flows/platform-node/src/AtomicFileSystem.ts: export { AtomicHelperError, |
| 2026-11-01 04:23 | `83c03075bc` | ON-MAIN | 3/0/0/0 | 5686bc4bfc | migrate(vibelang): restore tests to main |  |
| 2026-11-01 04:23 | `21bd7d8eb6` | ON-MAIN | 3/0/0/0 | 775f26b754 | migrate(vibelang): restore tests to main |  |
| 2026-11-01 04:23 | `b8d26763ec` | PARTIAL | 3/0/1/1 | faf3ec5b89 | migrate(vibelang): restore tests to main | packages/smithers/flows/kernel/test/ChildProcessSpawner.integration.test.ts: const pattern |
| 2026-11-01 04:28 | `9b4a97ccc2` | PARTIAL | 1/0/23/0 | 5686bc4bfc | migrate(vibelang): flows/crypto: Crypto returns to .ts | packages/smithers/flows/crypto/package.json: "./Crypto": "./src/Crypto.ts",; packages/smit |
| 2026-11-01 04:28 | `5d4e477350` | PARTIAL | 1/2/33/5 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/plan: 5 of 11 modules to .v | packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/StepKey.ts", "src/KeyMaterial.vibe", |
| 2026-11-01 04:28 | `003d163260` | PARTIAL | 1/0/23/0 | 775f26b754 | migrate(vibelang): flows/crypto: Crypto returns to .ts | packages/smithers/flows/crypto/package.json: "./Crypto": "./src/Crypto.ts",; packages/smit |
| 2026-11-01 04:28 | `8ee8baf329` | PARTIAL | 1/2/33/5 | 775f26b754 | migrate(vibelang): packages/smithers/flows/plan: 5 of 11 modules to .v | packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/StepKey.ts", "src/KeyMaterial.vibe", |
| 2026-11-01 04:28 | `9d8aedf752` | PARTIAL | 1/0/23/0 | faf3ec5b89 | migrate(vibelang): flows/crypto: Crypto returns to .ts | packages/smithers/flows/crypto/package.json: "./Crypto": "./src/Crypto.ts",; packages/smit |
| 2026-11-01 04:28 | `0963d4e250` | PARTIAL | 1/0/34/6 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/plan: 5 of 11 modules to .v | packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/StepKey.ts", "src/KeyMaterial.vibe", |
| 2026-11-01 04:29 | `fac2fc5c77` | PARTIAL | 1/1/27/5 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/artifacts: 5 of 17 modules  | packages/smithers/flows/artifacts/PACKAGE.ts: "src/measureBytes.vibe"; packages/smithers/f |
| 2026-11-01 04:29 | `849f4cb262` | PARTIAL | 1/1/27/5 | 775f26b754 | migrate(vibelang): packages/smithers/flows/artifacts: 5 of 17 modules  | packages/smithers/flows/artifacts/PACKAGE.ts: "src/measureBytes.vibe"; packages/smithers/f |
| 2026-11-01 04:29 | `a5384ef93d` | PARTIAL | 1/0/27/6 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/artifacts: 5 of 17 modules  | packages/smithers/flows/artifacts/PACKAGE.ts: "src/measureBytes.vibe"; packages/smithers/f |
| 2026-11-01 04:31 | `b7c93dc7b0` | PARTIAL | 1/1/58/3 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/journal: 3 of 17 modules to | .smithers/flows/coding/steering.ts: import * as JournalEvent from "../../../packages/smith |
| 2026-11-01 04:31 | `aa2809238b` | PARTIAL | 1/1/58/3 | 775f26b754 | migrate(vibelang): packages/smithers/flows/journal: 3 of 17 modules to | .smithers/flows/coding/steering.ts: import * as JournalEvent from "../../../packages/smith |
| 2026-11-01 04:31 | `2121a3a951` | PARTIAL | 1/0/58/4 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/journal: 3 of 17 modules to | .smithers/flows/coding/steering.ts: import * as JournalEvent from "../../../packages/smith |
| 2026-11-01 04:43 | `de40cacac3` | PARTIAL | 1/1/36/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/migrate: 1 of 28 modules to .vibe | packages/smithers/migrate/PACKAGE.ts: paths: ["src/internal/Fs.ts", "src/Scan.ts", "src/fl |
| 2026-11-01 04:43 | `137d6a8e85` | PARTIAL | 1/1/36/2 | 775f26b754 | migrate(vibelang): packages/smithers/migrate: 1 of 28 modules to .vibe | packages/smithers/migrate/PACKAGE.ts: paths: ["src/internal/Fs.ts", "src/Scan.ts", "src/fl |
| 2026-11-01 04:43 | `52f43a5670` | PARTIAL | 1/0/36/3 | faf3ec5b89 | migrate(vibelang): packages/smithers/migrate: 1 of 28 modules to .vibe | packages/smithers/migrate/PACKAGE.ts: paths: ["src/internal/Fs.ts", "src/Scan.ts", "src/fl |
| 2026-11-01 04:46 | `841311ae60` | PARTIAL | 2/0/40/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/patterns: 2 of 31 modules t | packages/smithers/flows/patterns/PACKAGE.ts: "src/internal/Compose.vibe",; packages/smithe |
| 2026-11-01 04:46 | `d056904323` | PARTIAL | 2/0/40/2 | 775f26b754 | migrate(vibelang): packages/smithers/flows/patterns: 2 of 31 modules t | packages/smithers/flows/patterns/PACKAGE.ts: "src/internal/Compose.vibe",; packages/smithe |
| 2026-11-01 04:46 | `2e3dbe881f` | PARTIAL | 2/0/40/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/patterns: 2 of 31 modules t | packages/smithers/flows/patterns/PACKAGE.ts: "src/internal/Compose.vibe",; packages/smithe |
| 2026-11-01 04:49 | `000e4416c6` | PARTIAL | 0/76/5/0 | 5686bc4bfc | migrate(vibelang): switch to the toolchain of VibeLang 14fae26d725f +  | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: import type * as AgentEvent from ". |
| 2026-11-01 04:49 | `9e63284397` | SUPERSEDED | 0/81/0/0 | 775f26b754 | migrate(vibelang): switch to the toolchain of VibeLang 14fae26d725f +  | .smithers/flows/package.json: changed later in its stack (head 775f26b754) |
| 2026-11-01 04:49 | `e963229ac8` | PARTIAL | 0/76/5/0 | faf3ec5b89 | migrate(vibelang): switch to the toolchain of VibeLang 14fae26d725f +  | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: import type * as AgentEvent from ". |
| 2026-11-01 04:49 | `52b402266b` | PARTIAL | 0/6/75/0 | 8372477664 | migrate(vibelang): switch to the toolchain of VibeLang 65fd44a551e3 | .smithers/flows/package.json: "vibelang": "file:../../.vibelang-toolchain/vibelang-0.0.11- |
| 2026-11-01 04:52 | `75f9e89726` | PARTIAL | 1/10/2/0 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/fs/src/FileRouter.d.vibe.ts: import { Effect, FileSystem, Path } f |
| 2026-11-01 04:52 | `a7b02b8bd5` | PARTIAL | 1/1/11/0 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/fs/src/FileRouter.d.vibe.ts: import { Effect, FileSystem, Path } f |
| 2026-11-01 04:52 | `848841eb11` | PARTIAL | 1/0/12/0 | faf3ec5b89 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/fs/src/FileRouter.d.vibe.ts: import { Effect, FileSystem, Path } f |
| 2026-11-01 04:52 | `1f148e0857` | PARTIAL | 1/0/12/0 | 8372477664 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/fs/src/FileRouter.d.vibe.ts: import { Effect, FileSystem, Path } f |
| 2026-11-01 05:08 | `ac789d79bf` | PARTIAL | 2/1/42/8 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/core: 5 of 6 modules to .vi | packages/smithers/flows/core/PACKAGE.ts: paths: ["src/internal/skillFrontmatter.vibe", "sr |
| 2026-11-01 05:08 | `e1e98d76a1` | PARTIAL | 1/1/14/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/run-store: 1 of 14 modules  | packages/smithers/flows/run-store/PACKAGE.ts: paths: ["src/RunStore.ts", "src/AttemptStore |
| 2026-11-01 05:08 | `fdbe0c9b0c` | PARTIAL | 0/0/4/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/build: 1 of 7 modules to .vibe | packages/smithers/build/src/PackageManager.ts: import * as Diagnostics from "./internal/di |
| 2026-11-01 05:08 | `4ed65dad33` | PARTIAL | 2/1/42/8 | 775f26b754 | migrate(vibelang): packages/smithers/flows/core: 5 of 6 modules to .vi | packages/smithers/flows/core/PACKAGE.ts: paths: ["src/internal/skillFrontmatter.vibe", "sr |
| 2026-11-01 05:08 | `b3d6cb9ed8` | PARTIAL | 1/1/14/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/run-store: 1 of 14 modules  | packages/smithers/flows/run-store/PACKAGE.ts: paths: ["src/RunStore.ts", "src/AttemptStore |
| 2026-11-01 05:08 | `51e569ac88` | PARTIAL | 0/0/4/1 | 775f26b754 | migrate(vibelang): packages/smithers/build: 1 of 7 modules to .vibe | packages/smithers/build/src/PackageManager.ts: import * as Diagnostics from "./internal/di |
| 2026-11-01 05:08 | `1fc7ff012a` | PARTIAL | 2/0/42/9 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/core: 5 of 6 modules to .vi | packages/smithers/flows/core/PACKAGE.ts: paths: ["src/internal/skillFrontmatter.vibe", "sr |
| 2026-11-01 05:08 | `198a4ac848` | PARTIAL | 1/0/14/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/run-store: 1 of 14 modules  | packages/smithers/flows/run-store/PACKAGE.ts: paths: ["src/RunStore.ts", "src/AttemptStore |
| 2026-11-01 05:08 | `1dbafef25f` | PARTIAL | 0/0/4/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/build: 1 of 7 modules to .vibe | packages/smithers/build/src/PackageManager.ts: import * as Diagnostics from "./internal/di |
| 2026-11-01 05:08 | `8372477664` | PARTIAL | 2/0/42/9 | 8372477664 | migrate(vibelang): packages/smithers/flows/core: 5 of 6 modules to .vi | packages/smithers/flows/core/PACKAGE.ts: paths: ["src/internal/skillFrontmatter.vibe", "sr |
| 2026-11-01 05:08 | `e709c2d6a0` | PARTIAL | 1/0/14/2 | 8372477664 | migrate(vibelang): packages/smithers/flows/run-store: 1 of 14 modules  | packages/smithers/flows/run-store/PACKAGE.ts: paths: ["src/RunStore.ts", "src/AttemptStore |
| 2026-11-01 05:08 | `94f07aebf7` | PARTIAL | 0/0/4/1 | 8372477664 | migrate(vibelang): packages/smithers/build: 1 of 7 modules to .vibe | packages/smithers/build/src/PackageManager.ts: import * as Diagnostics from "./internal/di |
| 2026-11-01 05:22 | `44bb8bb495` | PARTIAL | 1/2/43/5 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/time-travel: 3 of 24 module | packages/smithers/flows/time-travel/PACKAGE.ts: paths: ["src/TimeTravelError.vibe", "src/E |
| 2026-11-01 05:22 | `60b61506ee` | PARTIAL | 1/2/43/5 | 775f26b754 | migrate(vibelang): packages/smithers/flows/time-travel: 3 of 24 module | packages/smithers/flows/time-travel/PACKAGE.ts: paths: ["src/TimeTravelError.vibe", "src/E |
| 2026-11-01 05:22 | `40ddea1bef` | PARTIAL | 1/0/44/6 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/time-travel: 3 of 24 module | packages/smithers/flows/time-travel/PACKAGE.ts: paths: ["src/TimeTravelError.vibe", "src/E |
| 2026-11-01 05:25 | `d4d4122dc2` | PARTIAL | 1/7/52/4 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/memory: 5 of 28 modules to  | .smithers/flows/memory/mine.ts: import * as Bank from "../../../packages/smithers/agent/me |
| 2026-11-01 05:25 | `31c129208d` | PARTIAL | 1/7/52/4 | 775f26b754 | migrate(vibelang): packages/smithers/agent/memory: 5 of 28 modules to  | .smithers/flows/memory/mine.ts: import * as Bank from "../../../packages/smithers/agent/me |
| 2026-11-01 05:25 | `2bbce5d0b4` | PARTIAL | 1/0/53/10 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/memory: 5 of 28 modules to  | .smithers/flows/memory/mine.ts: import * as Bank from "../../../packages/smithers/agent/me |
| 2026-11-01 05:29 | `4053d05919` | PARTIAL | 1/3/15/0 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/plugin: 1 of 9 modules to . | packages/smithers/agent/plugin/PACKAGE.ts: paths: ["src/Resolve.ts", "src/internal/Boundar |
| 2026-11-01 05:29 | `905b15c5ec` | PARTIAL | 1/3/15/0 | 775f26b754 | migrate(vibelang): packages/smithers/agent/plugin: 1 of 9 modules to . | packages/smithers/agent/plugin/PACKAGE.ts: paths: ["src/Resolve.ts", "src/internal/Boundar |
| 2026-11-01 05:29 | `37f0f2dfa2` | PARTIAL | 1/0/16/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/plugin: 1 of 9 modules to . | packages/smithers/agent/plugin/PACKAGE.ts: paths: ["src/Resolve.ts", "src/internal/Boundar |
| 2026-11-01 05:37 | `e7da136f0f` | PARTIAL | 1/2/12/1 | 5686bc4bfc | migrate(vibelang): wire vibelang-unplugin into Smithers' source bundle | packages/smithers/agent/harness/package.json: "vibelang-unplugin": "file:../../../../.vibe |
| 2026-11-01 05:37 | `28a98d0ef7` | PARTIAL | 1/7/7/1 | 775f26b754 | migrate(vibelang): wire vibelang-unplugin into Smithers' source bundle | packages/smithers/agent/harness/package.json: "vibelang-unplugin": "file:../../../../.vibe |
| 2026-11-01 05:37 | `794f2312fb` | PARTIAL | 1/1/13/1 | faf3ec5b89 | migrate(vibelang): wire vibelang-unplugin into Smithers' source bundle | packages/smithers/agent/harness/package.json: "vibelang-unplugin": "file:../../../../.vibe |
| 2026-11-01 05:40 | `46017df56d` | PARTIAL | 1/1/22/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/plan: 1 of 2 modules to .vi | packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/FileSet.vibe"]; packages/smithers/fl |
| 2026-11-01 05:40 | `0c8879eb09` | PARTIAL | 1/1/22/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/plan: 1 of 2 modules to .vi | packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/FileSet.vibe"]; packages/smithers/fl |
| 2026-11-01 05:40 | `3473831907` | PARTIAL | 1/0/22/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/plan: 1 of 2 modules to .vi | packages/smithers/flows/plan/PACKAGE.ts: paths: ["src/FileSet.vibe"]; packages/smithers/fl |
| 2026-11-01 05:52 | `cdb6ae8116` | PARTIAL | 0/75/4/0 | 5686bc4bfc | migrate(vibelang): switch to the toolchain of VibeLang 14fae26d725f +  | packages/smithers/agent/registry/src/MarkdownFlow.d.vibe.ts: import { type DiscoveryWarnin |
| 2026-11-01 05:52 | `6c74bbf0e8` | SUPERSEDED | 0/79/0/0 | 775f26b754 | migrate(vibelang): switch to the toolchain of VibeLang 14fae26d725f +  | .smithers/flows/package.json: changed later in its stack (head 775f26b754) |
| 2026-11-01 05:52 | `ad353f21ab` | PARTIAL | 0/4/75/0 | faf3ec5b89 | migrate(vibelang): switch to the toolchain of VibeLang 14fae26d725f +  | .smithers/flows/package.json: "vibelang": "file:../../.vibelang-toolchain/vibelang-0.0.11- |
| 2026-11-01 05:52 | `5942e5265a` | PARTIAL | 0/4/75/0 | d977f8f878 | migrate(vibelang): switch to the toolchain of VibeLang d1be3034c235 | .smithers/flows/package.json: "vibelang": "file:../../.vibelang-toolchain/vibelang-0.0.11- |
| 2026-11-01 06:11 | `a8eca8d17d` | PARTIAL | 0/1/10/1 | 5686bc4bfc | migrate(vibelang): packages/testing: 1 of 27 modules to .vibe | packages/testing/PACKAGE.ts: paths: ["src/Fixture.ts", "src/RecordingModel.ts", "src/Cache |
| 2026-11-01 06:11 | `6c1bc6ef61` | SUPERSEDED | 0/10/0/0 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: changed later in its stack (head 56 |
| 2026-11-01 06:11 | `91b0c34b34` | PARTIAL | 0/1/10/1 | 775f26b754 | migrate(vibelang): packages/testing: 1 of 27 modules to .vibe | packages/testing/PACKAGE.ts: paths: ["src/Fixture.ts", "src/RecordingModel.ts", "src/Cache |
| 2026-11-01 06:11 | `67b1734775` | PARTIAL | 0/1/9/0 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: import type * as AgentEvent from ". |
| 2026-11-01 06:11 | `b7ae9d17f8` | PARTIAL | 0/0/10/2 | faf3ec5b89 | migrate(vibelang): packages/testing: 1 of 27 modules to .vibe | packages/testing/PACKAGE.ts: paths: ["src/Fixture.ts", "src/RecordingModel.ts", "src/Cache |
| 2026-11-01 06:11 | `b7a5670f03` | PARTIAL | 0/6/4/0 | faf3ec5b89 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/registry/src/MarkdownFlow.d.vibe.ts: import { type DiscoveryWarnin |
| 2026-11-01 06:11 | `753dbca059` | PARTIAL | 0/0/10/2 | d977f8f878 | migrate(vibelang): packages/testing: 1 of 27 modules to .vibe | packages/testing/PACKAGE.ts: paths: ["src/Fixture.ts", "src/RecordingModel.ts", "src/Cache |
| 2026-11-01 06:11 | `1b2398fa5e` | STRANDED | 0/0/10/0 | d977f8f878 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: import type * as AgentEvent from ". |
| 2026-11-01 06:12 | `32903f0a54` | PARTIAL | 0/2/4/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/artifacts: 1 of 1 modules t | packages/smithers/flows/artifacts/src/index.d.vibe.ts: export * as ArtifactStoreMetrics fr |
| 2026-11-01 06:12 | `4d9639e0d9` | PARTIAL | 0/2/4/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/artifacts: 1 of 1 modules t | packages/smithers/flows/artifacts/src/index.d.vibe.ts: export * as ArtifactStoreMetrics fr |
| 2026-11-01 06:12 | `d2d45f6c6b` | PARTIAL | 0/0/5/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/artifacts: 1 of 1 modules t | packages/smithers/flows/artifacts/package.json: "types": "./src/index.d.vibe.ts",; package |
| 2026-11-01 06:12 | `d977f8f878` | PARTIAL | 0/0/5/2 | d977f8f878 | migrate(vibelang): packages/smithers/flows/artifacts: 1 of 1 modules t | packages/smithers/flows/artifacts/package.json: "types": "./src/index.d.vibe.ts",; package |
| 2026-11-01 06:18 | `da77bc5044` | PARTIAL | 1/1/25/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/time-travel: 1 of 3 modules | packages/smithers/flows/time-travel/PACKAGE.ts: "src/Frame.vibe",; packages/smithers/flows |
| 2026-11-01 06:18 | `e5185115d6` | PARTIAL | 1/1/25/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/time-travel: 1 of 3 modules | packages/smithers/flows/time-travel/PACKAGE.ts: "src/Frame.vibe",; packages/smithers/flows |
| 2026-11-01 06:18 | `93d869a780` | PARTIAL | 1/0/25/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/time-travel: 1 of 3 modules | packages/smithers/flows/time-travel/PACKAGE.ts: "src/Frame.vibe",; packages/smithers/flows |
| 2026-11-01 06:38 | `0c2307a80e` | PARTIAL | 0/3/7/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/observability: 1 of 5 modul | packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Otlp.ts", "src/Endpoint.vib |
| 2026-11-01 06:38 | `8bb3e04c80` | PARTIAL | 0/3/7/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/observability: 1 of 5 modul | packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Otlp.ts", "src/Endpoint.vib |
| 2026-11-01 06:38 | `cc0e5c43e0` | PARTIAL | 0/2/7/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/observability: 1 of 5 modul | packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Otlp.ts", "src/Endpoint.vib |
| 2026-11-01 07:01 | `36d62ab4d6` | PARTIAL | 0/0/32/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/engine: 3 of 10 modules to  | packages/smithers/flows/engine/PACKAGE.ts: "src/FlowEngine/SnapshotBoundary.vibe"; package |
| 2026-11-01 07:01 | `485cfe55d2` | PARTIAL | 0/0/32/2 | 775f26b754 | migrate(vibelang): packages/smithers/flows/engine: 3 of 10 modules to  | packages/smithers/flows/engine/PACKAGE.ts: "src/FlowEngine/SnapshotBoundary.vibe"; package |
| 2026-11-01 07:01 | `40379a7952` | PARTIAL | 0/0/32/2 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/engine: 3 of 10 modules to  | packages/smithers/flows/engine/PACKAGE.ts: "src/FlowEngine/SnapshotBoundary.vibe"; package |
| 2026-11-01 07:04 | `7b679734d1` | PARTIAL | 0/3/25/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/plugin: 2 of 2 modules to . | packages/smithers/agent/plugin/PACKAGE.ts: paths: ["src/Resolve.ts", "src/Hooks.vibe", "sr |
| 2026-11-01 07:04 | `90e30ccfa2` | PARTIAL | 0/3/25/2 | 775f26b754 | migrate(vibelang): packages/smithers/agent/plugin: 2 of 2 modules to . | packages/smithers/agent/plugin/PACKAGE.ts: paths: ["src/Resolve.ts", "src/Hooks.vibe", "sr |
| 2026-11-01 07:04 | `7a92d80665` | PARTIAL | 0/0/26/4 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/plugin: 2 of 2 modules to . | packages/smithers/agent/plugin/PACKAGE.ts: paths: ["src/Resolve.ts", "src/Hooks.vibe", "sr |
| 2026-11-01 07:18 | `75e3033ec8` | PARTIAL | 1/0/9/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/kernel: 2 of 21 modules to  | packages/smithers/flows/kernel/PACKAGE.ts: paths: ["src/FileSystem.ts", "src/FileSystemBat |
| 2026-11-01 07:18 | `9fd7476da9` | PARTIAL | 1/0/9/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/kernel: 2 of 21 modules to  | packages/smithers/flows/kernel/PACKAGE.ts: paths: ["src/FileSystem.ts", "src/FileSystemBat |
| 2026-11-01 07:18 | `e62a0df0d7` | PARTIAL | 1/0/9/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/kernel: 2 of 21 modules to  | packages/smithers/flows/kernel/PACKAGE.ts: paths: ["src/FileSystem.ts", "src/FileSystemBat |
| 2026-11-01 07:20 | `214ab5689f` | PARTIAL | 3/1/42/6 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/observability: 5 of 12 modu | packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Endpoint.vibe", "src/Otlp.t |
| 2026-11-01 07:20 | `0fa67a0ca3` | PARTIAL | 3/1/42/6 | 775f26b754 | migrate(vibelang): packages/smithers/flows/observability: 5 of 12 modu | packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Endpoint.vibe", "src/Otlp.t |
| 2026-11-01 07:20 | `1b93b5329d` | PARTIAL | 3/0/42/7 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/observability: 5 of 12 modu | packages/smithers/flows/observability/PACKAGE.ts: paths: ["src/Endpoint.vibe", "src/Otlp.t |
| 2026-11-01 07:21 | `ae3d06a0df` | PARTIAL | 0/1/33/0 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/memory: 1 of 32 modules to  | packages/smithers/agent/memory/src/Bank.d.vibe.ts: import type * as MemoryError from "./Me |
| 2026-11-01 07:21 | `6bbe6b4bc8` | PARTIAL | 0/1/33/0 | 775f26b754 | migrate(vibelang): packages/smithers/agent/memory: 1 of 32 modules to  | packages/smithers/agent/memory/src/Bank.d.vibe.ts: import type * as MemoryError from "./Me |
| 2026-11-01 07:21 | `2fd94c1557` | PARTIAL | 0/0/33/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/memory: 1 of 32 modules to  | packages/smithers/agent/memory/package.json: "types": "./src/MemoryError.d.vibe.ts",; pack |
| 2026-11-01 07:26 | `e456cee094` | STRANDED | 0/0/9/0 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/std: 1 of 33 modules to .vi | packages/smithers/agent/std/examples/32-intervene.d.vibe.ts: export type Failure = Platfor |
| 2026-11-01 07:26 | `e956961470` | STRANDED | 0/0/9/0 | 775f26b754 | migrate(vibelang): packages/smithers/agent/std: 1 of 33 modules to .vi | packages/smithers/agent/std/examples/32-intervene.d.vibe.ts: export type Failure = Platfor |
| 2026-11-01 07:26 | `317b49f28b` | STRANDED | 0/0/9/0 | faf3ec5b89 | migrate(vibelang): packages/smithers/agent/std: 1 of 33 modules to .vi | packages/smithers/agent/std/examples/32-intervene.d.vibe.ts: export type Failure = Platfor |
| 2026-11-01 07:32 | `355d72c1c7` | PARTIAL | 0/1/11/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/time-travel: 1 of 29 module | packages/smithers/flows/time-travel/PACKAGE.ts: "src/CompensationHandlers.vibe",; packages |
| 2026-11-01 07:32 | `36f0e9b0c8` | PARTIAL | 0/1/11/2 | 775f26b754 | migrate(vibelang): packages/smithers/flows/time-travel: 1 of 29 module | packages/smithers/flows/time-travel/PACKAGE.ts: "src/CompensationHandlers.vibe",; packages |
| 2026-11-01 07:32 | `e724823411` | PARTIAL | 0/0/11/3 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/time-travel: 1 of 29 module | packages/smithers/flows/time-travel/PACKAGE.ts: "src/CompensationHandlers.vibe",; packages |
| 2026-11-01 07:34 | `1667e6e3c8` | PARTIAL | 2/0/101/21 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/sandbox: 24 of 74 modules t | packages/smithers/flows/sandbox/src/AwsSandbox/ExecTransport.d.vibe.ts: import type { Chil |
| 2026-11-01 07:34 | `cbbadc80b2` | PARTIAL | 2/0/101/21 | 775f26b754 | migrate(vibelang): packages/smithers/flows/sandbox: 24 of 74 modules t | packages/smithers/flows/sandbox/src/AwsSandbox/ExecTransport.d.vibe.ts: import type { Chil |
| 2026-11-01 07:34 | `d8e2197f51` | PARTIAL | 2/0/101/21 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/sandbox: 24 of 74 modules t | packages/smithers/flows/sandbox/src/AwsSandbox/ExecTransport.d.vibe.ts: import type { Chil |
| 2026-11-01 07:39 | `a2a8b5cea4` | PARTIAL | 0/1/9/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/platform-bun: 2 of 4 module | packages/smithers/flows/platform-bun/PACKAGE.ts: paths: ["src/BunHost.ts", "src/BunFileSys |
| 2026-11-01 07:39 | `9fb2b8a786` | PARTIAL | 0/1/9/2 | 775f26b754 | migrate(vibelang): packages/smithers/flows/platform-bun: 2 of 4 module | packages/smithers/flows/platform-bun/PACKAGE.ts: paths: ["src/BunHost.ts", "src/BunFileSys |
| 2026-11-01 07:39 | `283dca9fac` | PARTIAL | 0/0/9/3 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/platform-bun: 2 of 4 module | packages/smithers/flows/platform-bun/PACKAGE.ts: paths: ["src/BunHost.ts", "src/BunFileSys |
| 2026-11-01 07:47 | `a2550e64ba` | PARTIAL | 0/0/2/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/sandbox: 1 of 77 modules to | packages/smithers/flows/sandbox/src/internal/linuxSignals.d.vibe.ts: export declare const |
| 2026-11-01 07:47 | `5366d12835` | PARTIAL | 0/0/2/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/sandbox: 1 of 77 modules to | packages/smithers/flows/sandbox/src/internal/linuxSignals.d.vibe.ts: export declare const |
| 2026-11-01 07:47 | `d6f4691a40` | PARTIAL | 0/0/2/1 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/sandbox: 1 of 77 modules to | packages/smithers/flows/sandbox/src/internal/linuxSignals.d.vibe.ts: export declare const |
| 2026-11-01 07:49 | `d27edd6e83` | PARTIAL | 0/2/5/0 | 5686bc4bfc | migrate(vibelang): regenerate the harness realm bundle and sidecars | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: import type * as AgentEvent from ". |
| 2026-11-01 07:49 | `3ddcddc148` | SUPERSEDED | 0/7/0/0 | 775f26b754 | migrate(vibelang): regenerate the harness realm bundle and sidecars | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: changed later in its stack (head 77 |
| 2026-11-01 07:49 | `b32815719f` | PARTIAL | 0/1/6/0 | faf3ec5b89 | migrate(vibelang): regenerate the harness realm bundle and sidecars | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: import type * as AgentEvent from ". |
| 2026-11-01 07:50 | `1f49163335` | ON-MAIN | 12/0/0/0 | 5686bc4bfc | migrate(vibelang): agent/harness: cellPrompt returns to .ts |  |
| 2026-11-01 07:50 | `6650352c53` | ON-MAIN | 1/0/0/0 | 5686bc4bfc | migrate(vibelang): restore platform-node's LSP fixture tsconfig to mai |  |
| 2026-11-01 07:50 | `157441ae07` | ON-MAIN | 12/0/0/0 | 775f26b754 | migrate(vibelang): agent/harness: cellPrompt returns to .ts |  |
| 2026-11-01 07:50 | `cdbbee3e3a` | ON-MAIN | 1/0/0/0 | 775f26b754 | migrate(vibelang): restore platform-node's LSP fixture tsconfig to mai |  |
| 2026-11-01 07:50 | `0fac295453` | ON-MAIN | 12/0/0/0 | faf3ec5b89 | migrate(vibelang): agent/harness: cellPrompt returns to .ts |  |
| 2026-11-01 07:50 | `9f90cd2fed` | ON-MAIN | 1/0/0/0 | faf3ec5b89 | migrate(vibelang): restore platform-node's LSP fixture tsconfig to mai |  |
| 2026-11-01 08:00 | `e14cc8ae6f` | PARTIAL | 0/0/0/1 | 775f26b754 | control: an https origin from another host stays refused on direct TLS | packages/smithers/control/test/ControlOrigin.test.ts: ).pipe(Layer.provideMerge(NodeHttpSe |
| 2026-11-01 08:08 | `5ce60edb9d` | PARTIAL | 3/1/50/6 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/engine-store: 7 of 71 modul | packages/smithers/flows/engine-store/PACKAGE.ts: "src/internal/CacheOutputPolicy.vibe",; p |
| 2026-11-01 08:08 | `40156a2581` | PARTIAL | 3/1/50/6 | 775f26b754 | migrate(vibelang): packages/smithers/flows/engine-store: 7 of 71 modul | packages/smithers/flows/engine-store/PACKAGE.ts: "src/internal/CacheOutputPolicy.vibe",; p |
| 2026-11-01 08:08 | `faf3ec5b89` | PARTIAL | 3/0/50/7 | faf3ec5b89 | migrate(vibelang): packages/smithers/flows/engine-store: 7 of 71 modul | packages/smithers/flows/engine-store/PACKAGE.ts: "src/internal/CacheOutputPolicy.vibe",; p |
| 2026-11-01 08:28 | `acc6235d9e` | SUPERSEDED | 1/5/0/0 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: changed later in its stack (head 56 |
| 2026-11-01 08:28 | `1ba0715a2b` | PARTIAL | 1/0/5/0 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | packages/smithers/agent/harness/src/Monitor.d.vibe.ts: import type * as AgentEvent from ". |
| 2026-11-01 08:39 | `c464489d61` | STRANDED | 0/0/1/0 | 5686bc4bfc | migrate(vibelang): migrate: its dependency list names vibelang-runtime | packages/smithers/migrate/test/Dependencies.test.ts: "vibelang-runtime", |
| 2026-11-01 08:39 | `de7bd422b6` | ON-MAIN | 1/0/0/0 | 5686bc4bfc | migrate(vibelang): gateway: drop vibelang-runtime, which nothing in it |  |
| 2026-11-01 08:39 | `f080c659fd` | STRANDED | 0/0/1/0 | 775f26b754 | migrate(vibelang): migrate: its dependency list names vibelang-runtime | packages/smithers/migrate/test/Dependencies.test.ts: "vibelang-runtime", |
| 2026-11-01 08:39 | `7f42f69eba` | ON-MAIN | 1/0/0/0 | 775f26b754 | migrate(vibelang): gateway: drop vibelang-runtime, which nothing in it |  |
| 2026-11-01 08:40 | `e8e3e43838` | ON-MAIN | 1/0/0/0 | 5686bc4bfc | migrate(vibelang): restore platform-node's LSP fixture tsconfig to the |  |
| 2026-11-01 08:40 | `ab1af16ce9` | PARTIAL | 12/2/121/10 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/model: 8 of 24 modules to . | .smithers/flows/review/seeded-bugs/scriptedSeats.ts: import * as ModelError from "../../.. |
| 2026-11-01 08:40 | `446862b362` | PARTIAL | 6/0/9/0 | 5686bc4bfc | migrate(vibelang): PACKAGE.ts globs that match a migrated module match | PACKAGE.ts: "packages/*/src/**/*.{ts,vibe}", "packages/*/*/src/**/*.{ts,vibe}", "packages/ |
| 2026-11-01 08:40 | `7badfad479` | ON-MAIN | 1/0/0/0 | 775f26b754 | migrate(vibelang): restore platform-node's LSP fixture tsconfig to the |  |
| 2026-11-01 08:40 | `6ed93f5b57` | PARTIAL | 12/1/122/10 | 775f26b754 | migrate(vibelang): packages/smithers/agent/model: 8 of 24 modules to . | .smithers/flows/review/seeded-bugs/scriptedSeats.ts: import * as ModelError from "../../.. |
| 2026-11-01 08:40 | `591dcedd36` | PARTIAL | 6/0/9/0 | 775f26b754 | migrate(vibelang): PACKAGE.ts globs that match a migrated module match | PACKAGE.ts: "packages/*/src/**/*.{ts,vibe}", "packages/*/*/src/**/*.{ts,vibe}", "packages/ |
| 2026-11-01 08:44 | `832874cc9e` | PARTIAL | 2/1/21/3 | 5686bc4bfc | migrate(vibelang): packages/smithers/mcp: 3 of 9 modules to .vibe | packages/smithers/mcp/PACKAGE.ts: "src/internal/DiagnosticReporter.vibe",; packages/smithe |
| 2026-11-01 08:44 | `5c1ef11a6f` | PARTIAL | 2/1/21/3 | 775f26b754 | migrate(vibelang): packages/smithers/mcp: 3 of 9 modules to .vibe | packages/smithers/mcp/PACKAGE.ts: "src/internal/DiagnosticReporter.vibe",; packages/smithe |
| 2026-11-01 08:48 | `a1d94865c3` | PARTIAL | 0/2/14/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/triggers: 2 of 13 modules t | packages/smithers/agent/triggers/PACKAGE.ts: paths: ["src/Cron.ts", "src/CatchUp.vibe", "s |
| 2026-11-01 08:48 | `32d5c7e12e` | PARTIAL | 0/2/14/2 | 775f26b754 | migrate(vibelang): packages/smithers/agent/triggers: 2 of 13 modules t | packages/smithers/agent/triggers/PACKAGE.ts: paths: ["src/Cron.ts", "src/CatchUp.vibe", "s |
| 2026-11-01 08:54 | `146e519838` | PARTIAL | 0/1/24/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/ui: 3 of 3 modules to .vibe | packages/smithers/ui/PACKAGE.ts: Smithers.glob("//packages/smithers/ui/src/**/*.{ts,vibe}" |
| 2026-11-01 08:54 | `cbecbc8f40` | PARTIAL | 0/1/24/1 | 775f26b754 | migrate(vibelang): packages/smithers/ui: 3 of 3 modules to .vibe | packages/smithers/ui/PACKAGE.ts: Smithers.glob("//packages/smithers/ui/src/**/*.{ts,vibe}" |
| 2026-11-01 09:09 | `8af26e86f6` | PARTIAL | 715/396/63/2 | 5686bc4bfc | migrate(vibelang): format with the repository's dprint configuration | apps/tui/tsconfig.json: "moduleSuffixes": ["", ".d.vibe"],; packages/effect-code-storage/t |
| 2026-11-01 09:09 | `a68ca2b6eb` | PARTIAL | 717/398/63/2 | 775f26b754 | migrate(vibelang): format with the repository's dprint configuration | apps/tui/tsconfig.json: "moduleSuffixes": ["", ".d.vibe"],; packages/effect-code-storage/t |
| 2026-11-01 09:11 | `19cd88a388` | PARTIAL | 5/2/75/17 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/integrations: 11 of 30 modu | packages/smithers/agent/integrations/PACKAGE.ts: "src/core/Signature.vibe",; packages/smit |
| 2026-11-01 09:11 | `f02de43c49` | PARTIAL | 5/2/75/17 | 775f26b754 | migrate(vibelang): packages/smithers/agent/integrations: 11 of 30 modu | packages/smithers/agent/integrations/PACKAGE.ts: "src/core/Signature.vibe",; packages/smit |
| 2026-11-01 09:12 | `71ac8efc22` | STRANDED | 0/0/3/0 | 5686bc4bfc | migrate(vibelang): scripts import migrated modules by their .vibe path | packages/smithers/agent/harness/benchmarks/swebench/lib/jev-replay.mjs: import * as Monito |
| 2026-11-01 09:12 | `5c4bf5f31c` | STRANDED | 0/0/1/0 | 5686bc4bfc | migrate(vibelang): flows/database: ESLint ignores sidecars as a config | packages/smithers/flows/database/eslint.config.js: ...config.flatMap((entry) => |
| 2026-11-01 09:12 | `7120bea3cc` | STRANDED | 0/0/3/0 | 775f26b754 | migrate(vibelang): scripts import migrated modules by their .vibe path | packages/smithers/agent/harness/benchmarks/swebench/lib/jev-replay.mjs: import * as Monito |
| 2026-11-01 09:12 | `dc296ccd8c` | STRANDED | 0/0/1/0 | 775f26b754 | migrate(vibelang): flows/database: ESLint ignores sidecars as a config | packages/smithers/flows/database/eslint.config.js: ...config.flatMap((entry) => |
| 2026-11-01 09:13 | `d0830b9d1b` | STRANDED | 0/0/1/0 | 5686bc4bfc | migrate(vibelang): build: ESLint ignores the declaration sidecars | packages/smithers/build/eslint.config.js: ignores: ["**/dist", "**/build", "**/coverage", |
| 2026-11-01 09:13 | `7867ddd9a5` | STRANDED | 0/0/1/0 | 775f26b754 | migrate(vibelang): build: ESLint ignores the declaration sidecars | packages/smithers/build/eslint.config.js: ignores: ["**/dist", "**/build", "**/coverage", |
| 2026-11-01 09:15 | `34fdf1c420` | STRANDED | 0/0/28/0 | 5686bc4bfc | migrate(vibelang): export migrated modules as plain .vibe paths; refre | packages/smithers/agent/chain/package.json: "./internal/ChildRunError": "./src/internal/Ch |
| 2026-11-01 09:15 | `df91c15abb` | STRANDED | 0/0/28/0 | 775f26b754 | migrate(vibelang): export migrated modules as plain .vibe paths; refre | packages/smithers/agent/chain/package.json: "./internal/ChildRunError": "./src/internal/Ch |
| 2026-11-01 09:16 | `38a12b964b` | ON-MAIN | 10/0/0/0 | 5686bc4bfc | migrate(vibelang): flows/engine-store: ReplayOnly returns to .ts |  |
| 2026-11-01 09:16 | `d3df196fe7` | ON-MAIN | 10/0/0/0 | 775f26b754 | migrate(vibelang): flows/engine-store: ReplayOnly returns to .ts |  |
| 2026-11-01 09:23 | `c06b8916d7` | PARTIAL | 1/0/4/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/platform-cloudflare: 1 of 7 | packages/smithers/flows/platform-cloudflare/src/ContainerTerminal.ts: import * as Observed |
| 2026-11-01 09:23 | `b2cb980948` | PARTIAL | 1/0/4/1 | 775f26b754 | migrate(vibelang): packages/smithers/flows/platform-cloudflare: 1 of 7 | packages/smithers/flows/platform-cloudflare/src/ContainerTerminal.ts: import * as Observed |
| 2026-11-01 09:27 | `495d1f21d0` | PARTIAL | 1/0/85/1 | 5686bc4bfc | migrate(vibelang): switch to the toolchain of VibeLang 0d89ba18a7d7 | .smithers/flows/package.json: "vibelang": "file:../../.vibelang-toolchain/vibelang-0.0.11- |
| 2026-11-01 09:27 | `8619d0d27b` | PARTIAL | 1/9/76/1 | 775f26b754 | migrate(vibelang): switch to the toolchain of VibeLang 0d89ba18a7d7 | .smithers/flows/package.json: "vibelang": "file:../../.vibelang-toolchain/vibelang-0.0.11- |
| 2026-11-01 09:30 | `5456650338` | PARTIAL | 97/26/1292/67 | 5686bc4bfc | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | .smithers/flows/review/seeded-bugs/tsconfig.json: "vibe": { "sidecarDir": ".vibe/declarati |
| 2026-11-01 09:30 | `b7543f1bd4` | PARTIAL | 97/0/1323/67 | 775f26b754 | migrate(vibelang): set up VibeLang 0.0.11 (TypeScript 7.1.0-dev) | .smithers/flows/review/seeded-bugs/tsconfig.json: "vibe": { "sidecarDir": ".vibe/declarati |
| 2026-11-01 09:42 | `6d5e0f2f53` | PARTIAL | 0/1/11/0 | 5686bc4bfc | migrate(vibelang): flows/engine-store: ReplayOnly is .vibe again | packages/smithers/flows/engine-store/package.json: "./ReplayOnly": "./src/ReplayOnly.vibe" |
| 2026-11-01 09:42 | `d2c0ba4fd7` | ON-MAIN | 1/0/0/0 | 5686bc4bfc | migrate(vibelang): restore platform-node's LSP fixture tsconfig to the |  |
| 2026-11-01 09:42 | `a1438618a3` | STRANDED | 0/0/21/0 | 775f26b754 | migrate(vibelang): public-export-surface fixture names migrated additi | packages/repo-targets/contracts/fixtures/public-export-surface.json: "development": "./src |
| 2026-11-01 09:42 | `44eb9d0051` | PARTIAL | 0/1/11/0 | 775f26b754 | migrate(vibelang): flows/engine-store: ReplayOnly is .vibe again | packages/smithers/flows/engine-store/package.json: "./ReplayOnly": "./src/ReplayOnly.vibe" |
| 2026-11-01 09:42 | `86e75cd77a` | ON-MAIN | 1/0/0/0 | 775f26b754 | migrate(vibelang): restore platform-node's LSP fixture tsconfig to the |  |
| 2026-11-01 09:43 | `5825f62388` | ON-MAIN | 1/0/0/0 | 5686bc4bfc | migrate(vibelang): restore repo-view's forms.vibe fixture to the basel |  |
| 2026-11-01 09:43 | `76e2f3761e` | PARTIAL | 80/0/11/9 | 5686bc4bfc | migrate(vibelang): format the ported .vibe tests with the repo's dprin | packages/smithers/agent/fs/test/CommandTree.test.vibe: ]))).code; packages/smithers/agent/ |
| 2026-11-01 09:43 | `b7ef228d7f` | ON-MAIN | 1/0/0/0 | 775f26b754 | migrate(vibelang): restore repo-view's forms.vibe fixture to the basel |  |
| 2026-11-01 09:43 | `7f8156d358` | PARTIAL | 80/0/11/9 | 775f26b754 | migrate(vibelang): format the ported .vibe tests with the repo's dprin | packages/smithers/agent/fs/test/CommandTree.test.vibe: ]))).code; packages/smithers/agent/ |
| 2026-11-01 09:53 | `3f928f97fa` | PARTIAL | 0/0/2/1 | 5686bc4bfc | migrate(vibelang): flows/engine-store: ReplayOnly.vibe restored | packages/smithers/flows/engine-store/.vibe/declarations/src/ReplayOnly.d.vibe.ts (rename); |
| 2026-11-01 09:53 | `775f26b754` | PARTIAL | 0/0/2/1 | 775f26b754 | migrate(vibelang): flows/engine-store: ReplayOnly.vibe restored | packages/smithers/flows/engine-store/.vibe/declarations/src/ReplayOnly.d.vibe.ts (rename); |
| 2026-11-01 11:55 | `da14bf611d` | PARTIAL | 0/0/2/1 | 5686bc4bfc | migrate(vibelang): plugin, artifacts, canonical: lib names src/index.v | packages/smithers/agent/plugin/PACKAGE.ts: entry: Input.file("src/index.vibe"),; packages/ |
| 2026-11-01 12:14 | `e8771127f9` | EMPTY-ISH | 0/0/0/0 | 5686bc4bfc | migrate(vibelang): regenerate bun.lock, pnpm-lock.yaml and the target  |  |
| 2026-11-01 12:14 | `25bef205e3` | ON-MAIN | 28/0/0/0 | 5686bc4bfc | migrate(vibelang): harness, model, registry: drop stale sidecars besid |  |
| 2026-11-01 13:21 | `d7eb1d3200` | PARTIAL | 0/1/2/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/migrate: 1 of 10 modules to .vibe | packages/smithers/migrate/.vibe/declarations/src/flow/bin.d.vibe.ts: #!/usr/bin/env node; |
| 2026-11-01 13:23 | `77b15ef93b` | PARTIAL | 20/40/1928/125 | 5686bc4bfc | migrate(vibelang): upgrade Effect to 4.1.0 and VibeLang to 0.0.11 | .gitignore: .vibelang-toolchain/; .smithers/flows/bench/README.md: per node on `scheduler- |
| 2026-11-01 13:32 | `8dce06ad1f` | PARTIAL | 3/0/25/5 | 5686bc4bfc | migrate(vibelang): packages/smithers/ui: 1 of 2 modules to .vibe | packages/smithers/ui/.vibe/declarations/src/flow-form.d.vibe.ts: export declare const subm |
| 2026-11-01 13:33 | `613e45c2ad` | PARTIAL | 1/0/6/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/agent/registry: 1 of 18 modules t | packages/smithers/agent/registry/.vibe/declarations/src/Prompt.d.vibe.ts: export declare c |
| 2026-11-01 13:34 | `01e8f89ddc` | PARTIAL | 2/0/4/0 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/keys: 1 of 5 modules to .vi | packages/smithers/flows/keys/PACKAGE.ts: sources: Input.glob("{src,examples}/**/*.{ts,vibe |
| 2026-11-01 13:34 | `292c033bcf` | PARTIAL | 1/0/12/1 | 5686bc4bfc | migrate(vibelang): packages/testing: 1 of 2 modules to .vibe | packages/testing/.vibe/declarations/src/Vitest.d.vibe.ts: <A, E>(name: string, body: Body< |
| 2026-11-01 13:39 | `40634491d3` | PARTIAL | 3/0/10/5 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/database: 4 of 19 modules t | packages/smithers/flows/database/.vibe/declarations/src/internal/ReadOnly.d.vibe.ts: impor |
| 2026-11-01 13:45 | `9cd761e86b` | PARTIAL | 0/0/9/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/plan: 1 of 7 modules to .vi | packages/smithers/agent/harness/src/internal/RealmFlowBundle.ts: "const __NativeDate = Dat |
| 2026-11-01 13:52 | `3da81ca6f4` | PARTIAL | 0/0/2/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/journal: 1 of 19 modules to | packages/smithers/flows/journal/.vibe/declarations/src/CallFact.d.vibe.ts: declare const A |
| 2026-11-01 14:06 | `7627e4744d` | PARTIAL | 0/0/6/1 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/jj: 1 of 6 modules to .vibe | packages/smithers/flows/jj/.vibe/declarations/src/internal/JjInternalFault.d.vibe.ts: decl |
| 2026-11-01 14:24 | `9018dd2b85` | PARTIAL | 3/0/28/4 | 5686bc4bfc | migrate(vibelang): packages/smithers/notifications: 3 of 11 modules to | .smithers/flows/coding/steering.ts: import * as Notification from "../../../packages/smith |
| 2026-11-01 14:29 | `d2dbd8f346` | PARTIAL | 0/0/17/2 | 5686bc4bfc | migrate(vibelang): packages/smithers/flows/kernel: 2 of 19 modules to  | packages/smithers/flows/kernel/.vibe/declarations/src/GrantEvent.d.vibe.ts: export declare |
| 2026-11-01 14:30 | `0b4fca6d87` | PARTIAL | 1/0/2/0 | 5686bc4bfc | migrate(vibelang): errors: no declarationImportStyle; its declarations | packages/errors/.vibe/declarations/src/SmithersError.d.vibe.ts: import { type SmithersErro |
| 2026-11-01 14:31 | `5686bc4bfc` | PARTIAL | 9/0/1/0 | 5686bc4bfc | migrate(vibelang): flows/canonical: Canonical returns to .ts | packages/smithers/flows/canonical/.vibe/declarations/src/index.d.vibe.ts: export * from ". |
