# Benchmarks

Decision [0017](decisions/0017-benchmarks.md). Measured on shared nyc-01, Linux x86_64, Node 26.5.0, VibeLang 0.0.12, Effect 4.1.1, Vitest 5.0.0 and Chromium 151 / Playwright 1.62.1. Raw JSON under `bench/results/` retains machine, versions, source revision, timestamp, method, limitations and raw samples. Archived with the lane report outside the disposable workspace. Source revisions are never relabeled after rebasing.

Vitest built-in benchmarks assert correctness inside timing. Short callbacks use 30ms warmup and at least five iterations across 100ms. Slow callbacks use three unwarmed samples unless specified. Reported callback throughput is 1000 / mean ms; replay throughput multiplies by the exact event count. Three samples establish no tail percentile. Shared-host wall times are observations; the committed 5% work-count gate supplies the deterministic verdict. Instrumented coverage timings and unsuccessful observations are excluded.

## Local validated workloads

| Suite | Callback | Mean ms | Samples | Callbacks/s | Replay events/s | Method |
| --- | --- | --- | --- | --- | --- | --- |
| accounts-lifecycle | accounts-lifecycle | 43.4518 | 3 | 23.0 |  | M1 |
| accounts-transport | accounts-transport-faults | 11.8583 | 9 | 84.3 |  | M2 |
| accounts-workerd | workerd-account-session-grants | 314.5416 | 3 | 3.2 |  | M3 |
| accounts-workerd-faults | workerd-account-disabled | 11.0011 | 3 | 90.9 |  | M4 |
| accounts-workerd-faults | workerd-account-exchange-failure | 249.7335 | 3 | 4.0 |  | M4 |
| action-catalog | action-catalog | 2.7935 | 36 | 358.0 |  | M5 |
| action-host | action-host-recovery | 603.4044 | 3 | 1.7 |  | M6 |
| action-host-role-downgrade | action-host-role-downgrade | 122.4664 | 3 | 8.2 |  | M7 |
| action-kernels | action-kernels | 0.2286 | 438 | 4375.1 |  | M8 |
| action-prepare | action-prepare | 0.2904 | 345 | 3443.8 |  | M9 |
| action-tools | action-tools | 9.1484 | 3 | 109.3 |  | M10 |
| actions-view-matrix | actions-view-matrix | 7.1628 | 14 | 139.6 |  | M11 |
| agent-projection | agent-projection | 0.1341 | 746 | 7457.4 |  | M12 |
| budget | budget | 0.3754 | 267 | 2663.9 |  | M13 |
| cli | --mock read --json | 1837.7876 | 3 | 0.5 |  | M14 |
| cli | --mock ask install --json | 2052.4438 | 3 | 0.5 |  | M14 |
| cli | --llms | 1598.3130 | 3 | 0.6 |  | M14 |
| cli | --help | 1508.2885 | 3 | 0.7 |  | M14 |
| commands | mock-agent-ask | 300.0925 | 3 | 3.3 |  | M15 |
| commands | read-command | 0.3644 | 275 | 2744.0 |  | M15 |
| context-command-policies | context-and-command-decisions | 0.1398 | 716 | 7151.7 |  | M16 |
| core-10 | decide | 0.0160 | 6236 | 62357.6 |  | M17 |
| core-10 | apply | 0.0192 | 5212 | 52113.6 |  | M17 |
| core-10 | receive | 0.0119 | 8404 | 84036.0 |  | M17 |
| core-10 | replay-apply | 0.0192 | 5207 | 52069.9 | 520698.9 | M17 |
| core-10 | replay-receive | 0.0156 | 6411 | 64108.9 | 641088.9 | M17 |
| core-1000 | decide | 0.0184 | 5422 | 54219.0 |  | M18 |
| core-1000 | apply | 0.0389 | 2569 | 25685.8 |  | M18 |
| core-1000 | receive | 0.0309 | 3241 | 32408.1 |  | M18 |
| core-1000 | replay-apply | 0.1495 | 669 | 6688.9 | 6688906.4 | M18 |
| core-1000 | replay-receive | 0.1297 | 771 | 7707.5 | 7707476.4 | M18 |
| core-100000 | decide | 1.6438 | 61 | 608.3 |  | M19 |
| core-100000 | apply | 2.3432 | 43 | 426.8 |  | M19 |
| core-100000 | receive | 2.0148 | 50 | 496.3 |  | M19 |
| core-100000 | replay-apply | 12.8105 | 9 | 78.1 | 7806075.5 | M19 |
| core-100000 | replay-receive | 11.4478 | 9 | 87.4 | 8735281.2 | M19 |
| dispatcher-decisions | dispatcher-decisions | 0.4816 | 208 | 2076.4 |  | M20 |
| factory-gates | factory-gates | 0.0908 | 1102 | 11015.8 |  | M21 |
| failure-views | failure-views | 10.1383 | 10 | 98.6 |  | M22 |
| history-10 | history-decide | 0.0080 | 12841 | 125123.1 |  | M24 |
| history-10 | history-apply | 0.0209 | 4780 | 47794.7 |  | M24 |
| history-10 | history-decode | 0.0931 | 1074 | 10735.9 |  | M24 |
| history-1000 | history-decide | 0.0135 | 7413 | 74127.1 |  | M25 |
| history-1000 | history-apply | 0.0512 | 1952 | 19516.7 |  | M25 |
| history-1000 | history-decode | 6.7178 | 15 | 148.9 |  | M25 |
| history-100000 | history-decide | 1.3667 | 74 | 731.7 |  | M26 |
| history-100000 | history-apply | 3.4156 | 30 | 292.8 |  | M26 |
| history-100000 | history-decode | 526.3367 | 5 | 1.9 |  | M26 |
| history-actions | history-actions | 0.4231 | 237 | 2363.2 |  | M27 |
| history-bootstrap | history-bootstrap-graph | 0.2964 | 338 | 3374.3 |  | M28 |
| history-catalog | history-catalog-calls | 16.0606 | 3 | 62.3 |  | M30 |
| history-flow-policies | history-flow-ordering | 5.2741 | 20 | 189.6 |  | M31 |
| history-flows | history-plan-start-note-approve-fold | 34.9110 | 3 | 28.6 |  | M32 |
| history-malformed-replay | history-malformed-replay | 0.1814 | 552 | 5513.5 |  | M33 |
| history-page-boundaries | history-page-boundaries | 0.2282 | 439 | 4383.0 |  | M34 |
| history-pages-10 | history-outline | 0.0334 | 2994 | 29933.7 |  | M35 |
| history-pages-10 | history-epic-pages | 0.0269 | 3715 | 37141.0 |  | M35 |
| history-pages-10 | history-commit-page | 0.0097 | 10322 | 103213.1 |  | M35 |
| history-pages-10 | history-search | 0.0262 | 3818 | 38176.1 |  | M35 |
| history-pages-10 | history-page-codecs | 0.1951 | 513 | 5126.1 |  | M35 |
| history-pages-1000 | history-outline | 0.1275 | 785 | 7844.3 |  | M36 |
| history-pages-1000 | history-epic-pages | 0.1521 | 658 | 6574.3 |  | M36 |
| history-pages-1000 | history-commit-page | 0.0253 | 3949 | 39484.8 |  | M36 |
| history-pages-1000 | history-search | 0.2068 | 484 | 4835.7 |  | M36 |
| history-pages-1000 | history-page-codecs | 4.5097 | 23 | 221.7 |  | M36 |
| history-pages-100000 | history-outline | 24.0362 | 5 | 41.6 |  | M37 |
| history-pages-100000 | history-epic-pages | 11.7942 | 9 | 84.8 |  | M37 |
| history-pages-100000 | history-commit-page | 1.7753 | 57 | 563.3 |  | M37 |
| history-pages-100000 | history-search | 23.8922 | 5 | 41.9 |  | M37 |
| history-pages-100000 | history-page-codecs | 648.8686 | 5 | 1.5 |  | M37 |
| history-recovery | history-retelling-recovery | 1.8463 | 55 | 541.6 |  | M38 |
| history-roles | history-role-matrix | 0.1087 | 921 | 9200.6 |  | M39 |
| history-seed | history-seed-decode | 228.0631 | 3 | 4.4 |  | M40 |
| history-surfaces | cli-history | 1796.7672 | 3 | 0.6 |  | M41 |
| history-surfaces | cli-plan | 1547.9424 | 3 | 0.6 |  | M41 |
| history-surfaces | mcp-history-plan-start-note | 35.4242 | 3 | 28.2 |  | M41 |
| history-tools | history-tool-lifecycle | 33.2077 | 3 | 30.1 |  | M42 |
| history-tools | history-tool-faults | 0.5265 | 190 | 1899.5 |  | M42 |
| history-view-matrix | history-view-matrix | 25.7922 | 5 | 38.8 |  | M43 |
| history-web-10 | history-filter-keystroke | 0.0442 | 2264 | 22638.9 |  | M44 |
| history-web-10 | history-open-epic-view | 4.1045 | 3 | 243.6 |  | M44 |
| history-web-1000 | history-filter-keystroke | 0.0271 | 3688 | 36879.5 |  | M45 |
| history-web-1000 | history-open-epic-view | 99.0951 | 3 | 10.1 |  | M45 |
| history-web-1000 | history-next-page-update | 0.1646 | 608 | 6076.4 |  | M45 |
| history-web-100000 | history-filter-keystroke | 0.0355 | 2819 | 28186.9 |  | M46 |
| history-web-100000 | history-open-epic-view | 9154.6258 | 3 | 0.1 |  | M46 |
| history-web-100000 | history-next-page-update | 0.0864 | 1158 | 11577.8 |  | M46 |
| history-workerd | history-first-outline | 360.3072 | 1 | 2.8 |  | M47 |
| history-workerd | history-warm-outline | 13.9869 | 3 | 71.5 |  | M47 |
| history-workerd | history-detail-pages | 35.9090 | 3 | 27.8 |  | M47 |
| history-workerd | history-viewer-refusals | 390.3996 | 3 | 2.6 |  | M47 |
| history-workerd | history-protocol-errors | 18.7476 | 3 | 53.3 |  | M47 |
| history-workerd | history-keyed-call-replay | 265.8604 | 3 | 3.8 |  | M47 |
| http | http-boundaries | 7.0039 | 16 | 142.8 |  | M48 |
| identity-cli | cli-identity-journey | 9304.5576 | 3 | 0.1 |  | M49 |
| identity-labels | identity-labels | 0.0108 | 9266 | 92655.4 |  | M50 |
| identity-mcp | mcp-identity-journey | 737.4847 | 3 | 1.4 |  | M51 |
| issues-commands | issues-read | 11.2222 | 3 | 89.1 |  | M52 |
| issues-commands | issues-new | 11.1433 | 3 | 89.7 |  | M52 |
| issues-commands | issues-comment | 12.9582 | 3 | 77.2 |  | M52 |
| issues-commands | issues-link | 10.1342 | 3 | 98.7 |  | M52 |
| issues-commands | issues-split | 12.7675 | 3 | 78.3 |  | M52 |
| issues-commands | issues-commit | 13.0307 | 3 | 76.7 |  | M52 |
| issues-commands | issues-uncommit | 14.9150 | 3 | 67.0 |  | M52 |
| issues-commands | issues-propose | 12.1629 | 3 | 82.2 |  | M52 |
| issues-commands | issues-accept | 12.8324 | 3 | 77.9 |  | M52 |
| issues-commands | issues-decline | 11.5683 | 3 | 86.4 |  | M52 |
| issues-commands | issues-draft | 7.1225 | 3 | 140.4 |  | M52 |
| issues-flows | issue-flow-journey | 99.6078 | 3 | 10.0 |  | M53 |
| issues-identities | issue-identities | 0.5506 | 182 | 1816.4 |  | M54 |
| issues-policy | issue-policy-corpus | 0.8510 | 118 | 1175.1 |  | M55 |
| issues-reducer | issues-reducer | 0.2558 | 391 | 3909.2 |  | M56 |
| issues-refusals | issue-refusals | 49.8247 | 3 | 20.1 |  | M57 |
| issues-view-matrix | issues-view-matrix | 29.1574 | 5 | 34.3 |  | M58 |
| machine-boundaries | machine-boundaries | 0.3658 | 274 | 2733.7 |  | M65 |
| main-reducer-boundaries | main-reducer-boundaries | 0.5437 | 184 | 1839.2 |  | M66 |
| maintenance-scripts | mythical-seed-write | 460.2510 | 3 | 2.2 |  | M67 |
| maintenance-scripts | mythical-seed-deterministic | 460.5711 | 3 | 2.2 |  | M67 |
| maintenance-scripts | mythical-seed-read-failures | 646.7880 | 3 | 1.5 |  | M67 |
| maintenance-scripts | agent-context-write | 606.1948 | 3 | 1.6 |  | M67 |
| maintenance-scripts | agent-context-check | 305.7592 | 3 | 3.3 |  | M67 |
| maintenance-scripts | agent-context-stale | 299.0653 | 3 | 3.3 |  | M67 |
| markdown | markdown-blocks | 0.0109 | 9141 | 91406.3 |  | M68 |
| mcp | mcp-read | 1857.3257 | 3 | 0.5 |  | M69 |
| mcp | mcp-ask | 2128.0594 | 3 | 0.5 |  | M69 |
| mcp-warm | mcp-warm-read | 3.8322 | 27 | 260.9 |  | M70 |
| media-observe | media-observe | 0.4748 | 211 | 2106.0 |  | M71 |
| mock-actions | mock-actions | 63.9494 | 3 | 15.6 |  | M72 |
| mock-close | mock-factory-close | 0.5640 | 178 | 1773.0 |  | M73 |
| mock-history-agent | mock-agent-history | 571.9497 | 3 | 1.7 |  | M74 |
| mock-scripts | mock-scripts | 0.1336 | 751 | 7482.7 |  | M75 |
| mock-tour | mock-tour-complete | 134742.3470 | 1 | 0.0 |  | M76 |
| mock-tour | mock-tour-end | 20.5351 | 3 | 48.7 |  | M76 |
| model-config | model-config | 1.1509 | 87 | 868.9 |  | M77 |
| model-context-10 | model-context-select-and-window | 0.0845 | 1184 | 11839.3 |  | M78 |
| model-context-1000 | model-context-select-and-window | 1.9727 | 52 | 506.9 |  | M79 |
| model-context-100000 | model-context-select-and-window | 210.8423 | 5 | 4.7 |  | M80 |
| object-cancelled-receipt | object-cancelled-receipt | 34.2861 | 3 | 29.2 |  | M81 |
| object-host | object-post-alarm-recovery | 501.4861 | 3 | 2.0 |  | M82 |
| policies | flow-and-budget-policies | 0.2310 | 433 | 4329.6 |  | M83 |
| protocol | event-encode | 0.0191 | 5229 | 52289.6 |  | M84 |
| protocol | event-decode | 0.0102 | 9849 | 98482.8 |  | M84 |
| protocol | snapshot-decode-10 | 0.0824 | 1214 | 12136.3 |  | M84 |
| protocol | snapshot-decode-1000 | 4.6057 | 23 | 217.1 |  | M84 |
| protocol | snapshot-decode-100000 | 579.2099 | 5 | 1.7 |  | M84 |
| protocol | route-roundtrip | 0.0352 | 2839 | 28389.5 |  | M84 |
| reply-progress-decisions | reply-progress-decisions | 0.1836 | 546 | 5446.5 |  | M85 |
| resources | resources-dev | 35.2867 | 3 | 28.3 |  | M86 |
| resources | resources-production | 21.9296 | 3 | 45.6 |  | M86 |
| resources | resources-factory.example.test | 13.7072 | 3 | 73.0 |  | M86 |
| runtime | runtime-startup-post | 1285.7152 | 3 | 0.8 |  | M87 |
| sandbox-agent | sandbox-agent-bindings | 16.6366 | 3 | 60.1 |  | M88 |
| sandbox-factory-1 | sandbox-file-restart | 37.3724 | 3 | 26.8 |  | M90 |
| sandbox-factory-100 | sandbox-file-restart | 584.1804 | 3 | 1.7 |  | M91 |
| sandbox-meter | sandbox-meter-and-policy | 0.3769 | 266 | 2652.9 |  | M92 |
| sandbox-public-workerd | workerd-sandbox-viewer | 17.6549 | 3 | 56.6 |  | M93 |
| sandbox-surfaces | cli-sandboxes | 2253.7860 | 3 | 0.4 |  | M94 |
| sandbox-surfaces | cli-sandbox-start | 1807.1931 | 3 | 0.6 |  | M94 |
| sandbox-surfaces | mcp-sandbox-file-restart | 24.3862 | 3 | 41.0 |  | M94 |
| screen-protocol-policies | screen-protocol-mock-policies | 0.5225 | 192 | 1913.8 |  | M95 |
| sequencer | sequencer-lifecycle | 1.5965 | 63 | 626.4 |  | M96 |
| shared-decisions | shared-decisions | 0.3087 | 324 | 3239.2 |  | M97 |
| shared-decisions | mythical-lookups | 0.0474 | 2112 | 21116.5 |  | M97 |
| shared-decisions | sandbox-policy-layers | 0.0256 | 3907 | 39067.5 |  | M97 |
| site | site-routing | 64.0374 | 3 | 15.6 |  | M98 |
| specification | specification-review-journey | 78.2397 | 3 | 12.8 |  | M99 |
| startup-theatre-decisions | startup-theatre-decisions | 0.2908 | 345 | 3438.2 |  | M100 |
| surface-failures | cli-failure---mock ask   | 1759.7822 | 3 | 0.6 |  | M101 |
| surface-failures | cli-failure---mock read --after -1 | 1761.8357 | 3 | 0.6 |  | M101 |
| surface-failures | cli-failure---wat | 1842.3284 | 3 | 0.5 |  | M101 |
| surface-failures | cli-failure-read | 1599.7892 | 3 | 0.6 |  | M101 |
| surface-failures | mcp-unreachable | 1672.5568 | 3 | 0.6 |  | M101 |
| transport | transport-fault-matrix | 36.3419 | 5 | 27.5 |  | M102 |
| walkthrough-controls | walkthrough-controls | 0.8449 | 119 | 1183.5 |  | M103 |
| web-10 | keystroke-update | 0.0115 | 8671 | 86696.7 |  | M104 |
| web-10 | incoming-event-update | 0.0132 | 7579 | 75788.6 |  | M104 |
| web-10 | view | 6.5697 | 3 | 152.2 |  | M104 |
| web-1000 | keystroke-update | 0.0117 | 8531 | 85309.4 |  | M105 |
| web-1000 | incoming-event-update | 0.0339 | 2950 | 29495.4 |  | M105 |
| web-1000 | view | 51.6917 | 3 | 19.3 |  | M105 |
| web-100000 | keystroke-update | 0.0125 | 8026 | 80258.3 |  | M106 |
| web-100000 | incoming-event-update | 1.8666 | 54 | 535.7 |  | M106 |
| web-100000 | view | 4357.4402 | 3 | 0.2 |  | M106 |
| web-actions | web-actions | 4.6777 | 22 | 213.8 |  | M107 |
| wiki-cli | cli-wiki-read | 1853.2635 | 3 | 0.5 |  | M108 |
| wiki-cli | cli-wiki-draft | 1774.1608 | 3 | 0.6 |  | M108 |
| wiki-cli | cli-wiki-save | 1792.0026 | 3 | 0.6 |  | M108 |
| wiki-cli | cli-wiki-propose | 1866.5960 | 3 | 0.5 |  | M108 |
| wiki-edit-journeys | wiki-edit-journeys | 38.4818 | 3 | 26.0 |  | M109 |
| wiki-mcp | mcp-wiki-read-readback | 15.0031 | 3 | 66.7 |  | M110 |
| wiki-mcp | mcp-wiki-draft-readback | 6.7110 | 3 | 149.0 |  | M110 |
| wiki-mcp | mcp-wiki-save-readback | 7.3500 | 3 | 136.1 |  | M110 |
| wiki-mcp | mcp-wiki-propose-readback | 6.1712 | 3 | 162.0 |  | M110 |
| wiki-script | wiki-script-journey | 1272.8628 | 3 | 0.8 |  | M111 |
| wiki-view-matrix | wiki-view-matrix | 10.0086 | 10 | 99.9 |  | M112 |
| workerd | workerd-post-reply-read | 420.8056 | 3 | 2.4 |  | M113 |
| workerd | workerd-tour | 135581.8583 | 3 | 0.0 |  | M113 |
| workerd-actions | workerd-actions | 3407.1779 | 3 | 0.3 |  | M114 |
| workerd-sandboxes | workerd-sandbox-ledger | 776.0110 | 3 | 1.3 |  | M115 |
| workerd-sandboxes | workerd-sandbox-meter | 336.3485 | 3 | 3.0 |  | M115 |
| workerd-sandboxes | workerd-sandbox-public | 11.1622 | 3 | 89.6 |  | M115 |

## Methods and artifacts

**M1 — accounts-lifecycle.** `2026-11-09T10-05-49.573Z-accounts-lifecycle.json`; UTC `2026-11-09T10:05:49.573Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual product MockAccounts, policy and durable role-grant engine. Verify literal five-person fixture, once-only participation, duplicate no-op grant, promotions/demotions, final-maintainer/self-promotion refusals, complete five-event replay, identity schema round trip and sign-out. Three new scoped engines; initialization/assertions included. Limitations: Product fixture identity, not GitHub OAuth, production session cryptography or remote storage. One callback is the complete lifecycle, not a per-command latency.

**M2 — accounts-transport.** `2026-11-09T10-05-49.874Z-accounts-transport.json`; UTC `2026-11-09T10:05:49.874Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual LiveAccounts adapter with an injected faulty Effect HttpClient. Seven operations across transport loss, forbidden/unavailable statuses, malformed JSON/protocol/SSE and bodyless 204; exact success/failure tags and bounded typed errors checked. Limitations: No request interception or real network. Invalid upstream answers measure failure handling, not GitHub sign-in success or WAN latency.

**M3 — accounts-workerd.** `2026-11-09T10-03-45.194Z-accounts-workerd.json`; UTC `2026-11-09T10:03:45.194Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; real production account service, cookie signatures, SQLite sessions, durable role grants and current sandbox authority in local workerd. Each of three samples uses fresh signed/expired fixture sessions and a unique person; check tamper/expiry, self-promotion refusal, maintainer grant, current role, cross-origin refusal/unchanged state, People and session revocation. Host startup excluded; requests/assertions included. Limitations: Only the unshipped test host issues fixture sessions with real signatures. This does not benchmark successful GitHub OAuth/consent, provider latency or production credentials. No cookie/token values enter artifacts; all configuration is synthetic.

**M4 — accounts-workerd-faults.** `2026-11-09T10-03-48.581Z-accounts-workerd-faults.json`; UTC `2026-11-09T10:03:48.581Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual account configuration/router and journaled sign-in/callback flows in local workerd. Three samples each: missing configuration stays viewer/503; configured PKCE redirect then an injected faulty Effect GitHub exchange, visible failure redirect, consumed state and refused replay, cleared state cookie and no session cookie issued. Redirect following disabled. Startup excluded; crypto/storage/requests/assertions included. Limitations: The production GitHub service is replaced only by the existing host's explicit failing Effect service. No request interception, GitHub request, real login or successful provider exchange. Synthetic secrets/cookies remain in memory and are omitted from artifacts.

**M5 — action-catalog.** `2026-11-09T10-05-21.240Z-action-catalog.json`; UTC `2026-11-09T10:05:21.240Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; every bundled flow declaration's presentation, command, minimum role and input kind, with the shared mayRun gate evaluated for all five roles per entry. Limitations: Presentation/policy cost only; a run's durable execution is benchmarked through the mock and workerd action surfaces.

**M6 — action-host.** `2026-11-09T10-05-11.227Z-action-host.json`; UTC `2026-11-09T10:05:11.227Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual production action index/per-run hosts with real SQLite and product MockAccounts/Mythical services. Check once-only post acceptance, changed-input conflict, correlated terminal Post/Reply traces after two alarms, and cancelling a queued Plan before admission without any history mutation. Three new scoped worlds, migrations and assertions included. Limitations: Node SQLite/KV/alarm adapter, no workerd scheduling or remote storage. Deliberately unconfigured model fails the reply; no inference or GitHub mutation. The product mock provides local accounts/history.

**M7 — action-host-role-downgrade.** `2026-11-09T10-05-11.766Z-action-host-role-downgrade.json`; UTC `2026-11-09T10:05:11.766Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; accept a real SQLite-backed history action, revoke its owner's role through product account flows, drive two alarms, then compare the terminal permission refusal and unchanged empty history. Three fresh worlds, setup and assertions included. Limitations: Product mock identities, no OAuth/provider call. Node SQLite/alarm host; measures admission/recovery overhead without a model.

**M8 — action-kernels.** `2026-11-09T10-05-20.947Z-action-kernels.json`; UTC `2026-11-09T10:05:20.947Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; run snapshot/step acceptance orderings, terminal settle and cancellation, engine upsert identity and replay, pending acknowledgement identity, and VIP document authorship/path truth tables. Assertions included. Limitations: Pure in-process decisions; the durable action surface runs in the workerd benchmark.

**M9 — action-prepare.** `2026-11-09T10-05-21.541Z-action-prepare.json`; UTC `2026-11-09T10:05:21.541Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; every invocation kind's schema preparation with client/operation identity defaults, then not-found and invalid-input failures as typed ActionFailures. Limitations: In-process preparation; the dispatch into durable engines is benchmarked through the mock and workerd action surfaces.

**M10 — action-tools.** `2026-11-09T10-05-22.065Z-action-tools.json`; UTC `2026-11-09T10:05:22.065Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; all four actual action FlowBinding handlers invoked with real harness call identities and declaration digests over the product mock actions service; start announces its first run snapshot, read returns it and cancel acknowledges. Limitations: Binding/handler boundary without model selection or QuickJS; the same declarations serve CLI and MCP surfaces.

**M11 — actions-view-matrix.** `2026-11-09T10-05-18.876Z-actions-view-matrix.json`; UTC `2026-11-09T10:05:18.876Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; Foldkit scenes render the actions pane collapsed with its latest badge, open and empty, the failed-run trace, per-selection run control and maximized state; merge/selection/completion decisions checked against slower or terminal snapshots. Limitations: Scene rendering and pure decisions; live runs stream through the mock and workerd action benchmarks.

**M12 — agent-projection.** `2026-11-09T10-05-43.616Z-agent-projection.json`; UTC `2026-11-09T10:05:43.616Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; project partial cell answers, restart, sum token usage, bound input history and classify provider failures without disclosing messages. Limitations: Projection and policy only; actual agent and QuickJS cell execution measured in workerd.

**M13 — budget.** `2026-11-09T10-05-47.038Z-budget.json`; UTC `2026-11-09T10:05:47.038Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; real budget over in-memory ledger; rounding/clamping, duplicate spend, admission at limit and exact ledger asserted. Limitations: In-process ledger; remote Durable Object transport excluded.

**M14 — cli.** `2026-11-09T09-59-41.821Z-cli.json`; UTC `2026-11-09T09:59:41.821Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; spawn emitted CLI to exit with stdout/stderr capture; three samples per command, no warmup. Build excluded; loader/process startup included. Limitations: Mock backend for ask/read; no network/model. Source package loading contributes to startup.

**M15 — commands.** `2026-11-09T09-59-20.674Z-commands.json`; UTC `2026-11-09T09:59:20.674Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; new scoped MockFactory/engine per call. Ask includes real scripted delays and settled answer; Read includes schema validation and layer lifecycle. Limitations: Product mock mode; no backend/model. Ask timing includes intentional 25ms per scripted chunk.

**M16 — context-command-policies.** `2026-11-09T10-05-31.622Z-context-command-policies.json`; UTC `2026-11-09T10:05:31.622Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; prompt eligibility, first duplicate identity, source-order indexes/windowing and correlated CLI/MCP collection through unrelated events, restart, finish/failure. Complete expected selections, answer fields/event numbers and outcome/error precedence checked. Limitations: Small in-process decision corpus, no model/IPC or service execution. Assertions included; large transcript cost is measured separately.

**M17 — core-10.** `2026-11-09T10-04-20.400Z-core-10.json`; UTC `2026-11-09T10:04:20.400Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 10 completed posts for single transitions; replay has exactly 10 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**M18 — core-1000.** `2026-11-09T10-04-21.236Z-core-1000.json`; UTC `2026-11-09T10:04:21.236Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 1000 completed posts for single transitions; replay has exactly 1000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**M19 — core-100000.** `2026-11-09T10-04-22.107Z-core-100000.json`; UTC `2026-11-09T10:04:22.107Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 100000 completed posts for single transitions; replay has exactly 100000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**M20 — dispatcher-decisions.** `2026-11-09T10-05-32.675Z-dispatcher-decisions.json`; UTC `2026-11-09T10:05:32.675Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; all eight storage-mark combinations for three ordered posts, exact independently listed first candidate, single attempted start/refusal and terminal no-op, plus empty queue. Assertions included. Limitations: Pure dispatcher decisions only; storage probes and durable starts are measured in object-host/workerd workloads.

**M21 — factory-gates.** `2026-11-09T10-06-13.074Z-factory-gates.json`; UTC `2026-11-09T10:06:13.074Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Both acceptance predicates over the accepted fixture, sixteen single-review refusals, revision reset and person/agent approval; assertions included. Limitations: In-process decisions; excludes model inference, transport and storage.

**M22 — failure-views.** `2026-11-09T10-05-35.107Z-failure-views.json`; UTC `2026-11-09T10:05:35.107Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; render every declared post failure and connection/tour failure with accessible retry/reconnect controls. Limitations: Scenes from state-machine client fixtures; no transport interception.

**M23 — gate.** `2026-11-09T10-05-36.452Z-gate.json`; UTC `2026-11-09T10:05:36.452Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Indexed entry reads through a transparent Proxy on completed-post fixtures of 10/1000/100000 entries. Correctness checked after counter capture. Allowed increase: ceil(baseline * 1.05); zero stays zero; exact roster required. Limitations: Counts entry access, not instruction count, allocations, network or latency; additional uninstrumented work requires timing review.

**M24 — history-10.** `2026-11-09T10-04-29.407Z-history-10.json`; UTC `2026-11-09T10:04:29.407Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 10 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**M25 — history-1000.** `2026-11-09T10-04-29.987Z-history-1000.json`; UTC `2026-11-09T10:04:29.987Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 1000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**M26 — history-100000.** `2026-11-09T10-04-34.814Z-history-100000.json`; UTC `2026-11-09T10:04:34.814Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 100000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**M27 — history-actions.** `2026-11-09T10-02-45.911Z-history-actions.json`; UTC `2026-11-09T10:02:45.911Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; history reducer corpus for page/read responses, forms, navigation/write intents, success/refusal, retries, late/detached data and events. Independent field, command-count and identity assertions; real commands execute in Chromium separately. Limitations: Reducer/command construction cost, no network or durable execution. Pages are actual projections of a two-commit fixture.

**M28 — history-bootstrap.** `2026-11-09T10-06-14.384Z-history-bootstrap.json`; UTC `2026-11-09T10:06:14.384Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; three-commit first-parent/merge graph with rejected and landed queue entries; exact first-parent incremental order/cursor handling, bucket order/mapping, evidence, complete bootstrap and lossless seed projection/replay checked. Limitations: Small deterministic real-commit fixture; actual large committed snapshot decode measured separately; no GitHub call or repository mutation.

**M29 — history-browser-actions.** `2026-11-09T10-01-29.561Z-history-browser-actions.json`; UTC `2026-11-09T10:01:29.561Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial Chromium journey over the full committed history and real MockMythical durable flows. Bootstrap, scripted work and automation included; no percentile. Fold changes only the product mock, never a real repository. Viewer UI omits writes; live writes are benchmarked as actual workerd refusals.

**M30 — history-catalog.** `2026-11-09T10-04-56.070Z-history-catalog.json`; UTC `2026-11-09T10:04:56.070Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; real harness call identities/declaration digests invoke all four actual FlowBinding handlers and a populated outline reread after writes, including schema validation and result encoding; fresh product history engine, exact outputs and resulting signed note checked. Three samples. Limitations: No model selection or QuickJS process; this measures the binding/handler boundary directly. Real durable history flows run behind the binding.

**M31 — history-flow-policies.** `2026-11-09T10-05-31.360Z-history-flow-policies.json`; UTC `2026-11-09T10:05:31.360Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; five roles × seven actions × human/agent; independent minimum-role matrix, authorization once, recording forbidden before authorization, single record except repeated fold, and illegal states checked. Limitations: Pure journal/policy decisions; actual durable flows and storage are separate workloads. Assertions included.

**M32 — history-flows.** `2026-11-09T10-04-35.055Z-history-flows.json`; UTC `2026-11-09T10:04:35.055Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual MockMythical, sequencer and in-memory durable engine; plan/create epic, start, note, human approval and merge-queue fold; outline/detail composition and complete event replay equality checked. Three fresh engines. Limitations: Explicit human maintainer in a local fixture; product agent permission is measured separately. No real repository write or provider call.

**M33 — history-malformed-replay.** `2026-11-09T10-05-45.339Z-history-malformed-replay.json`; UTC `2026-11-09T10:05:45.339Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; ten invalid event shapes across all seven event kinds, each checked as next, duplicate and gap. Invalid next content advances only the cursor; duplicates/gaps retain the original object and full state. Limitations: Pure replay boundary, deliberately malformed events; not storage transport corruption or authenticated admission.

**M34 — history-page-boundaries.** `2026-11-09T10-04-44.581Z-history-page-boundaries.json`; UTC `2026-11-09T10:04:44.581Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; reversed physical commit array across two epics, notes and three real folds; exact stack order/counts/details, missing/negative cursor behavior, all four valid route/URI round trips, malformed Unicode path refusals and status classes checked. Limitations: Small deterministic projection/protocol corpus; no network or history mutation.

**M35 — history-pages-10.** `2026-11-09T10-04-37.762Z-history-pages-10.json`; UTC `2026-11-09T10:04:37.762Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 10 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**M36 — history-pages-1000.** `2026-11-09T10-04-38.609Z-history-pages-1000.json`; UTC `2026-11-09T10:04:38.609Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 1000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**M37 — history-pages-100000.** `2026-11-09T10-04-44.306Z-history-pages-100000.json`; UTC `2026-11-09T10:04:44.306Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 100000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**M38 — history-recovery.** `2026-11-09T10-05-45.028Z-history-recovery.json`; UTC `2026-11-09T10:05:45.028Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; bootstrap a landed commit and pending sibling, reopen/amend, insert before sibling, refuse invalid plans, start/note/approve and fold exact trailer. Recreate the real sequencer over the same memory store; compare full independent expected state, every event, replay, schema round trip and duplicate identity. Each callback owns a new store. Limitations: In-memory durable-store contract and sequencer; no SQLite restart, repository write, network or model. Assertions and fresh store construction included.

**M39 — history-roles.** `2026-11-09T10-04-36.153Z-history-roles.json`; UTC `2026-11-09T10:04:36.153Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; all five roles, human and agent; every agent forbidden to approve/fold, every role allowed to read, only human maintainer allowed to approve. Limitations: Pure policy cost; signed-in identity is a separate integration boundary.

**M40 — history-seed.** `2026-11-09T10-04-35.866Z-history-seed.json`; UTC `2026-11-09T10:04:35.866Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; decode the actual committed VibeLang bootstrap projection; validate unique mythical identities, every real-commit mapping and the final main cursor. Three samples; module cached after its first import. Limitations: Snapshot parsing and validation, not a fresh network/GitHub import or bootstrap from an empty durable object.

**M41 — history-surfaces.** `2026-11-09T10-00-34.780Z-history-surfaces.json`; UTC `2026-11-09T10:00:34.780Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; emitted CLI history/plan include startup and full committed bootstrap; persistent real MCP plan/start/note/history includes schema/IPC and four flows/calls. Three samples each, no warmup; exact detail, note author and unchanged main checked. Limitations: Product mock history, no repository mutation or model. MCP history grows by one planned commit per sample; handshake/bootstrap excluded from its timing.

**M42 — history-tools.** `2026-11-09T10-04-53.798Z-history-tools.json`; UTC `2026-11-09T10:04:53.798Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; real tool catalog, product MockMythical and durable plan/start/note plus all four paged reads; contributor retell refusal, signed note, missing-input defaults and injected faulty Effect service. Three fresh lifecycle engines; fault handling short-run warmup. Limitations: Tool/flow overhead, no model inference or production storage. No approve/fold binding exists. Actual model choice and calls to these bindings inside QuickJS are not measured here.

**M43 — history-view-matrix.** `2026-11-09T10-05-17.453Z-history-view-matrix.json`; UTC `2026-11-09T10:05:17.453Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; Foldkit scenes render the history list, epic, commit and plan pages across roles, states, filters, errors and dialog variants with exact control presence/absence assertions; refusal wording table included. Limitations: Scene rendering without layout/paint; the same journeys with real events run in Chromium and workerd benchmarks.

**M44 — history-web-10.** `2026-11-09T10-02-08.181Z-history-web-10.json`; UTC `2026-11-09T10:02:08.181Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 10 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**M45 — history-web-1000.** `2026-11-09T10-02-08.984Z-history-web-1000.json`; UTC `2026-11-09T10:02:08.984Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 1000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**M46 — history-web-100000.** `2026-11-09T10-02-45.645Z-history-web-100000.json`; UTC `2026-11-09T10:02:45.645Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 100000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**M47 — history-workerd.** `2026-11-09T09-50-03.493Z-history-workerd.json`; UTC `2026-11-09T09:50:03.493Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual History Durable Object with full committed bootstrap, real SQLite durable flows and LiveMythical HTTP. First read measured once on a fresh object; warm outlines, first/second epic pages, commit detail, bounded search, five viewer refusals plus unchanged outline, and protocol errors measured three times. A keyed Plan binding runs twice with the same real cell identity and once with a new ordinal; exact cached response, one/two matching commits and cursor increments asserted across real SQLite flows. Server/bundler startup excluded; schema/assertions included. Limitations: Local workerd, no production network or model. First read is object bootstrap, not a forced cold isolate. Anonymous callers are viewers on this revision, so public writes remain forbidden; the separate keyed replay uses the test host’s trusted maintainer agent and actual production reader/binding/SQLite write path. No sign-in or GitHub write is claimed.

**M48 — http.** `2026-11-09T10-05-58.015Z-http.json`; UTC `2026-11-09T10:05:58.015Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; real handler and sequencer; valid post/read/tour/end/events routing, body size/schema/name checks including lengthless multi-byte history overflow, cursor bounds, duplicate, and injected faulty Effect service returning Unreachable. Exact status and accepted state asserted. Limitations: In-process HTTP objects, no TCP; SQLite/durable engine covered in workerd.

**M49 — identity-cli.** `2026-11-09T11-42-17.751Z-identity-cli.json`; UTC `2026-11-09T11:42:17.751Z`; source `711e00bf2e4a3dfcaba63a94417be7feb113cac4`. Vitest built-in bench; three complete journeys, four emitted CLI processes each, fresh scoped private settings. Decode every public schema, check signed fixture identity, settled answer, first/repeated logout and removed session file. Includes startup, durable session actions, scripted reply and assertions; build excluded. Limitations: Product mock sign-in, no OAuth, network, real session or model. This is whole-journey cost, not one-command latency. Private settings paths and contents are not retained.

**M50 — identity-labels.** `2026-11-09T11-41-49.712Z-identity-labels.json`; UTC `2026-11-09T11:41:49.712Z`; source `711e00bf2e4a3dfcaba63a94417be7feb113cac4`. Vitest built-in bench; three literal guest/person/agent cases per callback over the production label decision, assertions included. Limitations: Pure presentation rule; does not prove signature validity, provider identity or role authority.

**M51 — identity-mcp.** `2026-11-09T11-42-22.564Z-identity-mcp.json`; UTC `2026-11-09T11:42:22.564Z`; source `711e00bf2e4a3dfcaba63a94417be7feb113cac4`. Vitest built-in bench; persistent actual stdio MCP, discovery/startup excluded. Three five-call journeys: login, signed ask, logout, guest ask and full readback; literal author labels and exact settled reply count checked. Durable session actions, private file IO, schema/IPC, scripted replies and assertions included. Limitations: Isolated product mock settings, no OAuth/network/real session/model. Transcript grows by two posts per sample. Whole-journey cost, no percentile claim.

**M52 — issues-commands.** `2026-11-09T10-05-29.161Z-issues-commands.json`; UTC `2026-11-09T10:05:29.161Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; each of eleven real product fixture issue commands from a fresh memory flow engine, nineteen committed fixture rows and maintainer identity. Three unwarmed samples each, with engine initialization, authorization, command, teardown and assertions included; exact affected row, cursor, unrelated rows and creation count checked. Limitations: Local product fixture host, no GitHub request, sign-in, network or model. Fresh-engine costs differ from a persistent UI session and successful writes do not claim production GitHub latency.

**M53 — issues-flows.** `2026-11-09T10-05-28.324Z-issues-flows.json`; UTC `2026-11-09T10:05:28.324Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; fresh real makeIssueFactory, memory flow engine and host per callback; all eleven operations, retained intermediate writes, exact sequence, idempotent replay, literal proposal document, unchanged unrelated issues and complete schema equality. Three unwarmed whole-journey samples; initialization/assertions included. Limitations: Product fixture mode: no GitHub write, sign-in, repository review, network or model. One callback contains the entire journey; its latency is not a per-command latency.

**M54 — issues-identities.** `2026-11-09T10-05-29.430Z-issues-identities.json`; UTC `2026-11-09T10:05:29.430Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual Effect WebCrypto durable execution/recovery identity helpers checked against fixed SHA-256 vectors independently calculated with Python hashlib at authoring time of the canonical namespaced actor/operation/key tuples. Three operation identities and one recovery identity per callback. Limitations: Local digest and identity overhead, not a recovered remote execution or GitHub write.

**M55 — issues-policy.** `2026-11-09T10-05-28.621Z-issues-policy.json`; UTC `2026-11-09T10:05:28.621Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; literal five-role by eleven-operation permission table, next/duplicate/gap projection, valid tree and self/missing/cycle refusals, all review label/close recovery states and request schema equality. Assertions included. Limitations: Pure policy/codec overhead with the nineteen-issue committed fixture; no storage, browser, GitHub or model.

**M56 — issues-reducer.** `2026-11-09T10-05-17.755Z-issues-reducer.json`; UTC `2026-11-09T10:05:17.755Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; the full issues control table: navigation, filters, wizard steps with each validation, per-role forms and dialogs, saved-action retry identity and recovery keys, and request construction. Limitations: Pure reducer; the durable flows and views are benchmarked separately.

**M57 — issues-refusals.** `2026-11-09T10-05-29.723Z-issues-refusals.json`; UTC `2026-11-09T10:05:29.723Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual product fixture engine with Effect-backed changing identity and participation service. Replay a cached commitment after downgrade to viewer, then assert eight exact domain refusals and unchanged state; successful new/comment call participation twice with exact identity. Three fresh engines; all assertions included. Limitations: Local authorization/domain boundary, no sign-in provider or GitHub request. Identity is a host-injected Effect service; no request interception.

**M58 — issues-view-matrix.** `2026-11-09T10-05-18.254Z-issues-view-matrix.json`; UTC `2026-11-09T10:05:18.254Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; Foldkit scenes over the real app update/view render the issues pane list kinds, state and query filters, detail with notes and VIP review, commit/split/link dialogs, new and VIP wizard steps, the role matrix, connect gating, loading, failure and inline errors. Limitations: Scene rendering without layout/paint or a GitHub call; the write boundary runs in the issues fixture and workerd benchmarks.

**M59 — live-api.** `2026-11-09T09-22-49.917Z-live-api.json`; UTC `2026-11-09T09:22:49.917Z`; source `7510f3aca2c6de7a145122ba7296af8a40dc61f3`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: Real model tokens, opt in. Fresh object vs repeated read cannot force a cold Worker isolate; network/PoP/provider/cache/budget contention are uncontrolled. First answer delta is the first projected visible token, not the provider's first raw token (the protocol does not expose that). Three samples do not establish percentiles. A failure field is unsuccessful evidence, not a latency claim.

**M60 — live-browser.** `2026-11-09T09-22-40.903Z-live-browser.json`; UTC `2026-11-09T09:22:40.903Z`; source `7510f3aca2c6de7a145122ba7296af8a40dc61f3`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: Default production backend selection; UI-only navigation and keys make no model call. Fresh context, shared browser/OS caches and automation overhead; no forced cold cache.

**M61 — local-browser.** `2026-11-09T10-01-15.582Z-local-browser.json`; UTC `2026-11-09T10:01:15.582Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: Product mock mode, fresh browser context, shared browser/OS caches and automation overhead; no forced cold cache.

**M62 — local-browser-actions.** `2026-11-09T10-01-27.006Z-local-browser-actions.json`; UTC `2026-11-09T10:01:27.006Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native-browser journey with real Foldkit and product MockFactory; timings include scripted delays and automation. External docs content is not asserted; only the correct pane URL and controls. Video timing begins after navigation; ready-state/decoded-frame observation and native programmatic pause/play include automation, browser caches and software decode, without physical control interaction. Touch is dispatched as native synthetic DOM events, not physical hardware. Single observations establish no percentile.

**M63 — local-role-actions.** `2026-11-09T10-01-37.639Z-local-role-actions.json`; UTC `2026-11-09T10:01:37.639Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native-browser journey over the real product fixture account/role flows. Each role visit includes selection, identity visibility and (for signed roles) opening/checking/closing People. Other actions include confirmation or cancellation and resulting state. Sign-in/retry use the explicit mock identity host; no GitHub login, production identity, account mutation or model. Scripted reply/automation delays included; one observation per action establishes no percentile.

**M64 — local-wiki-actions.** `2026-11-09T11-12-01.488Z-local-wiki-actions.json`; UTC `2026-11-09T11:12:01.488Z`; source `4b42f111edbbad4735451803aa5c5455137b4ceb`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native Chromium journey through real product fixture flows. Maintainer Save and contributor Propose each open a review and preserve repository Markdown; reopening checks the original source. Escape, role revocation and a scripted agent draft are checked. No real GitHub writes, OAuth or model. Scripted waits and automation included; one sample per action establishes no percentile.

**M65 — machine-boundaries.** `2026-11-09T10-06-11.851Z-machine-boundaries.json`; UTC `2026-11-09T10:06:11.851Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; complete reply/restart/tour lifecycles, admission boundaries, malformed replay, optimistic failure/retry/confirmation/gap/duplicate delivery; assertions included. Limitations: In-process state machine; not exhaustive input enumeration or proof.

**M66 — main-reducer-boundaries.** `2026-11-09T10-05-19.174Z-main-reducer-boundaries.json`; UTC `2026-11-09T10:05:19.174Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; issue connection state with resume links, durable wiki visits with pane/people restoration and epoch reuse, action dispatch gating by selection and in-flight starts, slash dispatch clearing the draft, and sandbox start/stop/terminal controls with busy and blank-command refusals; exact emitted commands checked. Limitations: Reducer and command construction; the commands' durable execution is benchmarked through the mock factory.

**M67 — maintenance-scripts.** `2026-11-09T10-04-18.816Z-maintenance-scripts.json`; UTC `2026-11-09T10:04:18.816Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; spawn each emitted script to exit over a real fixture jj repository and merge queue (seed) or the real installed vibelang skill (agent context); three samples each, no warmup. Fixture repository/queue construction is untimed setup. Write determinism, failed-read preservation and stale rejection are checked inside timed callbacks; the seed's parsed history content is fully asserted. Limitations: Fixture jj repositories, not VibeLang's real history; the full-history run's cost is dominated by its repository, not this fixture. Scripts write only inside the ignored dist-script-tests tree. Process/loader startup included; build excluded.

**M68 — markdown.** `2026-11-09T10-04-09.466Z-markdown.json`; UTC `2026-11-09T10:04:09.466Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; parse a paragraph/code/paragraph answer; compare complete blocks. Limitations: Small fixed answer; rendering is measured separately.

**M69 — mcp.** `2026-11-09T09-59-53.921Z-mcp.json`; UTC `2026-11-09T09:59:53.921Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; new emitted stdio server, real MCP initialize/discovery/call, validated schema and result; three samples, no warmup. Limitations: Includes process startup, handshake and teardown; mock backend; warm persistent-session call latency is measured separately.

**M70 — mcp-warm.** `2026-11-09T10-00-22.487Z-mcp-warm.json`; UTC `2026-11-09T10:00:22.487Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; initialize and discover once outside timing; measure read calls on the same real stdio process, asserting the complete empty snapshot. Limitations: Product mock backend; schema/protocol/IPC included, startup/teardown excluded.

**M71 — media-observe.** `2026-11-09T10-06-09.804Z-media-observe.json`; UTC `2026-11-09T10:06:09.804Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual media observation service for all image/video loaded/failed outcomes. Each counter dimension increases exactly one; capture and compare complete bounded log messages. Assertions and logger lifecycle included. Limitations: Effect telemetry boundary only; does not measure image download or video decode.

**M72 — mock-actions.** `2026-11-09T10-05-21.882Z-mock-actions.json`; UTC `2026-11-09T10:05:21.882Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; product MockActions over MockFactory: catalog, command table, button and slash starts, follow to settlement, per-flow runs, direct read, unknown command, invalid JSON input, missing run, cancellation and rerun. Three unwarmed samples. Limitations: Product mock backend; no model, network or workerd isolation. The same protocol against the real Worker runs in the workerd actions benchmark.

**M73 — mock-close.** `2026-11-09T09-59-17.371Z-mock-close.json`; UTC `2026-11-09T09:59:17.371Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; build and close actual Factory scope, then verify a post is refused as unavailable. Limitations: Lifecycle cost, no model or network.

**M74 — mock-history-agent.** `2026-11-09T10-04-55.861Z-mock-history-agent.json`; UTC `2026-11-09T10:04:55.861Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; fresh real MockFactory per sample, committed history decoded, journaled show tool, naturally streamed answer; exact repository main and epic counts independently composed and checked. Limitations: Product mock mode; three samples include intentional reply delays and history decode. No provider/model or network.

**M75 — mock-scripts.** `2026-11-09T09-59-17.050Z-mock-scripts.json`; UTC `2026-11-09T09:59:17.050Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; script selection including fallback, reconstruct every selected reply from chunks. Limitations: Fixed synthetic prompts; syntax compilation remains in the separate unit suite.

**M76 — mock-tour.** `2026-11-09T09-59-16.721Z-mock-tour.json`; UTC `2026-11-09T09:59:16.721Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; real MockFactory durable tour; verify each stop, complete exact script, busy refusal, ended-tour refusal and cancellation after first delta. One complete natural-paced run; three cancellations. Limitations: Includes production reading holds, based on each paragraph; one completion establishes no percentile. Product mock mode, no model/backend.

**M77 — model-config.** `2026-11-09T10-05-43.908Z-model-config.json`; UTC `2026-11-09T10:05:43.908Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual Config and HostModel planning; default/unconfigured and configured model records, zero/default daily budget; no provider calls. Limitations: Configuration and route construction cost only.

**M78 — model-context-10.** `2026-11-09T10-04-57.028Z-model-context-10.json`; UTC `2026-11-09T10:04:57.028Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 10 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**M79 — model-context-1000.** `2026-11-09T10-04-57.325Z-model-context-1000.json`; UTC `2026-11-09T10:04:57.325Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 1000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**M80 — model-context-100000.** `2026-11-09T10-04-59.097Z-model-context-100000.json`; UTC `2026-11-09T10:04:59.097Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; 100000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**M81 — object-cancelled-receipt.** `2026-11-09T10-05-26.637Z-object-cancelled-receipt.json`; UTC `2026-11-09T10:05:26.637Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; real SQLite journal polling of an absent reply before and after a durable cancellation tombstone. Missing execution must remain an error; only recorded pre-admission cancellation returns no receipt. Three fresh scoped databases, setup and assertions included. Limitations: Deliberate absent-journal recovery boundary; no active model call or remote object.

**M82 — object-host.** `2026-11-09T10-05-26.335Z-object-host.json`; UTC `2026-11-09T10:05:26.335Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; production conversation/request/alarm functions on the existing real node:sqlite host adapter. Two queued posts, malformed input and changed-owner duplicate, five alarms, exact ordered failure events, fresh sequencer recovery and ownership, budget/execution storage read/write/delete/alarm checks. Three fresh databases; initialization, durable migrations and assertions included. Limitations: Node SQLite with in-memory KV/alarm host, not workerd scheduling or disk durability. Deliberately unconfigured model exercises configuration failure, not inference. Actual workerd success paths remain separate workloads.

**M83 — policies.** `2026-11-09T10-05-30.801Z-policies.json`; UTC `2026-11-09T10:05:30.801Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; strict admission, idempotent charging, accepted-only dispatch, reply attempt/offset/empty boundaries, tour terminal identity, retry classification and failure precedence; explicit behavioral truth tables. Limitations: Fixed in-process policy corpus; assertions dominate these small decisions, not an inference/model/storage measurement.

**M84 — protocol.** `2026-11-09T10-04-27.711Z-protocol.json`; UTC `2026-11-09T10:04:27.711Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench, Schema JSON codec, validated complete event round trips and snapshot length/tail; URL encode/decode. Setup excluded, assertions included. Limitations: In-process codec cost; no HTTP or network.

**M85 — reply-progress-decisions.** `2026-11-09T10-05-32.976Z-reply-progress-decisions.json`; UTC `2026-11-09T10:05:32.976Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; projected/partial/non-text/unknown deltas, retry reset retaining output and usage, exact safe-integer boundary, negative/unsafe/overflow usage latching invalidity, provider failure and completion precedence. Complete state comparisons inside timing. Limitations: SDK event projection policy, no provider decoding or inference. Actual agent/durable execution is separate.

**M86 — resources.** `2026-11-09T10-05-55.761Z-resources.json`; UTC `2026-11-09T10:05:55.761Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual Alchemy stack compilation in temporary local state, dev/default production/domain variants; exact resource names, bindings, routes and CPU/observability settings checked. Three samples each, including layer/state-directory lifecycle. Limitations: Resource declarations only; no plan, deploy, provider lifecycle or Cloudflare account operation. Runtime object paths run separately in workerd.

**M87 — runtime.** `2026-11-09T10-04-50.124Z-runtime.json`; UTC `2026-11-09T10:04:50.124Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench, happy-dom with the actual startup program, stylesheet, Foldkit subscriptions/commands and MockFactory. Native Command-K and input/Enter; wait for the complete expected installed command. New scoped runtime each sample; 3 samples. Limitations: DOM runtime, no layout or paint; includes scripted reply delays and observer polling. Forced product mock mode, no network/model.

**M88 — sandbox-agent.** `2026-11-09T10-05-15.678Z-sandbox-agent.json`; UTC `2026-11-09T10:05:15.678Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual harness bindings and stable cell identities over the real product mock flows. Invoke Start/Command/Stop/Start, replay old Stop, and read retained bytes through Command; verify bound conversation, catalog roster, generations and output. Three fresh engines. Limitations: Agent binding overhead without model selection or QuickJS; no Container. The public viewer boundary is measured separately; the SQLite lifecycle benchmark remains deferred by the compiler reproduction.

**M89 — sandbox-browser-actions.** `2026-11-09T10-01-33.793Z-sandbox-browser-actions.json`; UTC `2026-11-09T10:01:33.793Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial real Chromium journey over product mock flows and supported terminal commands; exact retained terminal transcript checked across Stop/Start. No model/backend/real Container. Forced mock roles never grant live authority. Automation and scripted waits included; no percentile.

**M90 — sandbox-factory-1.** `2026-11-09T10-05-13.591Z-sandbox-factory-1.json`; UTC `2026-11-09T10:05:13.591Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 1 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**M91 — sandbox-factory-100.** `2026-11-09T10-05-15.490Z-sandbox-factory-100.json`; UTC `2026-11-09T10:05:15.490Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 100 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**M92 — sandbox-meter.** `2026-11-09T10-05-13.303Z-sandbox-meter.json`; UTC `2026-11-09T10:05:13.303Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; five role allowances, distinct identity/lease bounds, exact two-running-box accounting across a UTC boundary, rollback/high-water recovery, snapshot rounding, invalid clock domains and safe-sum overflow. Independent numeric totals checked; assertions included. Limitations: In-process normalized-clock fixtures, not a fake global clock or Container performance. Real-clock host/flow paths are separate workloads.

**M93 — sandbox-public-workerd.** `2026-11-09T09-50-03.784Z-sandbox-public-workerd.json`; UTC `2026-11-09T09:50:03.784Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual local workerd public sandbox router through LiveFactory: viewer snapshot, Start/Stop/Command forbidden, then unchanged empty state; exact typed refusals and all snapshot fields checked. Three serial five-request samples; bundling/server startup excluded. Limitations: Signed-out deployment boundary only, no trusted compute identity, Container or SQLite lifecycle. The separate sandbox SQLite benchmark is deferred by the nested-Effect compiler reproduction; this case does not substitute for it.

**M94 — sandbox-surfaces.** `2026-11-09T11-40-46.602Z-sandbox-surfaces.json`; UTC `2026-11-09T11:40:46.602Z`; source `711e00bf2e4a3dfcaba63a94417be7feb113cac4`. Vitest built-in bench; emitted CLI read/start includes cold process/layer setup. Persistent real stdio MCP starts, writes, stops, restarts, reads retained bytes, stops and verifies snapshot through seven calls; full twenty-command catalog and exact generations/output checked. Three samples; MCP handshake excluded. Limitations: Product mock backend and maintainer surface principal, no real Container, model or repository write. MCP keeps one engine across samples and grows its receipt history; CLI gets a fresh engine each time. Assertions and IPC included.

**M95 — screen-protocol-policies.** `2026-11-09T10-05-31.073Z-screen-protocol-policies.json`; UTC `2026-11-09T10:05:31.073Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual extracted screen/protocol/mock decisions, independent truth tables for shortcut priority, scroll revisions, input bounds, routing/status, backend choice and script priority. Module imports/setup excluded, correctness assertions included. Limitations: Fixed policy corpus; assertion overhead dominates. DOM, HTTP and actual agent flows are separate workloads.

**M96 — sequencer.** `2026-11-09T10-05-46.727Z-sequencer.json`; UTC `2026-11-09T10:05:46.727Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; real sequencer on an in-memory append-only log. Post/refusal/duplicate, reply pieces, duplicate/stale pieces, restart, final replacement, tour, follower and fresh sequencer replay. Exact transcript and ordered events asserted; model history excludes tour narration while the transcript retains it. Limitations: In-process log, no storage I/O; SQLite/workerd measured separately.

**M97 — shared-decisions.** `2026-11-09T10-05-22.613Z-shared-decisions.json`; UTC `2026-11-09T10:05:22.613Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; inline/rich Markdown and safe-link table, build-time HTML with anchors and escaping, wiki path normalization/lookup/request mapping, role standing, VIP document rendering, sandbox pane decisions, media failure memory, mythical miss-path lookups and both sandbox policy layers. Limitations: Pure functions and layer reads; the wiki's durable open flow and workerd surfaces are benchmarked separately.

**M98 — site.** `2026-11-09T10-06-08.922Z-site.json`; UTC `2026-11-09T10:06:08.922Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; production site Worker router over a real loopback HTTP file server serving repository home/logo bytes with SPA fallback, and real API handler health. Exact bodies, mock/live health and every rejection status checked. Three fresh scoped servers; startup/teardown included. Limitations: Local service-binding adapter over HTTP, no Cloudflare PoP or deployed asset cache; API error dependency is a deliberately faulty Effect service. Actual compiled UI/layout measured separately in Chromium.

**M99 — specification.** `2026-11-09T10-06-03.989Z-specification.json`; UTC `2026-11-09T10:06:03.989Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual product issue flows and memory durable engine. Revise accepted specification, refuse stale/empty edits, collect all four scripted named reviews with Opus requesting a second review, verify once-only replay, reset on another revision and invoke the same review through the mock chat command. Complete review-history tuples and unchanged issues checked. Three fresh engines; setup/assertions included. Limitations: Product scripted reviewer behavior, no real model review, grade quality assessment, GitHub write or network. Named model performance belongs to an explicitly configured live workload.

**M100 — startup-theatre-decisions.** `2026-11-09T10-05-33.235Z-startup-theatre-decisions.json`; UTC `2026-11-09T10:05:33.235Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; explicit query/storage precedence and persistence, role/session admission, tutorial resume and auto-start choices, every theatre target, speech state transitions, bounded telemetry labels and keyboard wrap. Literal expected choices asserted inside timing. Limitations: Pure policy decisions; browser DOM, storage, layout and native speech execution are separate runtime boundaries.

**M101 — surface-failures.** `2026-11-09T10-00-19.995Z-surface-failures.json`; UTC `2026-11-09T10:00:19.995Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; emitted processes reject blank/invalid input, unknown flags and an actually closed loopback endpoint. Exact exit/status stream and public error checked; three samples each. Limitations: Unreachable loopback, no request interception; process startup and error rendering included.

**M102 — transport.** `2026-11-09T10-05-48.019Z-transport.json`; UTC `2026-11-09T10:05:48.019Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; inject a faulty Effect HttpClient into the actual Factory and Mythical adapters. Measure all chat/history/sandbox/terminal operations across transport errors, status failures, malformed JSON/protocol; exact safe typed error checked, no response body leaks. Limitations: Deliberate faulty service, no request interception; failure handling overhead without network latency. Successful transport paths run through real workerd.

**M103 — walkthrough-controls.** `2026-11-09T10-06-10.820Z-walkthrough-controls.json`; UTC `2026-11-09T10:06:10.820Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; forty real state transitions over the exact ten-step catalog with elapsed reading time, pause and resume. Checks every accepted intent, current destination, preserved agent entry and exact remaining time. Limitations: Pure transition cost with assertions; no browser layout, network or durable SQLite execution.

**M104 — web-10.** `2026-11-09T10-03-50.646Z-web-10.json`; UTC `2026-11-09T10:03:50.646Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**M105 — web-1000.** `2026-11-09T10-03-51.311Z-web-1000.json`; UTC `2026-11-09T10:03:51.311Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**M106 — web-100000.** `2026-11-09T10-04-09.176Z-web-100000.json`; UTC `2026-11-09T10:04:09.176Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**M107 — web-actions.** `2026-11-09T10-05-34.774Z-web-actions.json`; UTC `2026-11-09T10:05:34.774Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; all person-facing reducer messages, optimistic post retry, replay gap, connection, scroll, palette, splash and tour controls; scene assertions for retry and Esc. Limitations: Reducer/scene cost, no browser layout; native input and modal focus are covered by Chromium separately.

**M108 — wiki-cli.** `2026-11-09T11-41-09.306Z-wiki-cli.json`; UTC `2026-11-09T11:41:09.306Z`; source `711e00bf2e4a3dfcaba63a94417be7feb113cac4`. Vitest built-in bench; three unwarmed samples for each wiki operation, spawning the actual emitted CLI to exit. Validated schema, fixture role, full read/draft bytes and exact first review identity. Build excluded; process startup and assertions included. Limitations: Product mock backend and maintainer principal, fresh engine each call. Save and Propose open fixture reviews; no GitHub mutation, OAuth or model. Command-line source arguments remain in memory and never enter artifacts.

**M109 — wiki-edit-journeys.** `2026-11-09T11-06-23.515Z-wiki-edit-journeys.json`; UTC `2026-11-09T11:06:23.515Z`; source `e6f8707c5d1ed1a14fa9b3295a9f246c180c128f`. Vitest built-in bench, three whole-journey samples. Each sample initializes two independent real fixture repositories/engines, reads source, drafts, submits by each role, replays and verifies unchanged Markdown and exactly one review per repository. Assertions included. Limitations: Product fixture mode; excludes real GitHub, credentials, model generation and network. Whole-journey latency is not per-command latency or a coverage claim.

**M110 — wiki-mcp.** `2026-11-09T11-41-11.318Z-wiki-mcp.json`; UTC `2026-11-09T11:41:11.318Z`; source `711e00bf2e4a3dfcaba63a94417be7feb113cac4`. Vitest built-in bench; one real persistent stdio process, initialization/discovery excluded. Three samples per operation. Each measured callback includes the command plus a source-readback call; Save/Propose also include an identical-request replay and compare the complete result. Full original source, role, draft bytes and cleared submitted draft checked; schema/IPC/assertions included. Limitations: Product fixture wiki; no GitHub mutation, OAuth or model. The persistent engine grows its review history; command-plus-validation roundtrips are not single-call wire latency. No percentile claim.

**M111 — wiki-script.** `2026-11-09T10-06-02.559Z-wiki-script.json`; UTC `2026-11-09T10:06:02.559Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; actual emitted wiki generator over fixture files in the compiler's ignored output tree. Build twice, remove a required receipt and then the directory. Check exact page roster/order, nested/absolute/external/hash links, ruling deduplication, status/suite metadata, byte-identical second build and preserved output after both real read failures. Three complete four-process journeys; filesystem setup/assertions included, compilation excluded. Limitations: Small fixture wiki; not a full-site build throughput measurement. Child process startup, source loading and filesystem work included. Run independently of ordinary wiki-process tests, which use the same compiler fixture directory.

**M112 — wiki-view-matrix.** `2026-11-09T10-05-18.583Z-wiki-view-matrix.json`; UTC `2026-11-09T10:05:18.583Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; Foldkit scenes over the real update/view render the wiki pane's index, decision chrome, loading skeleton, error with retry, filtered and empty navigation and tour-maximized state. Limitations: Scene rendering without layout/paint; the durable open flow is benchmarked through the mock factory and workerd.

**M113 — workerd.** `2026-11-09T10-23-05.185Z-workerd.json`; UTC `2026-11-09T10:23:05.185Z`; source `160b963649ddf15b648dd041d757e44873031907`. Vitest built-in bench; actual local workerd Durable Objects, SQLite engine, alarms, LiveFactory HTTP/SSE, agent and QuickJS; deterministic HTTP model service. Three new conversations each, unwarmed. Bundling/server startup excluded; post-through-settle/read included. Limitations: Flow/adapter overhead, no model inference, WAN or production contention. Tour includes ten real durable reading holds, totaling 134 seconds. Test host delegates to production Objects/Http; Alchemy's deploy-only wiring is not run.

**M114 — workerd-actions.** `2026-11-09T10-03-21.442Z-workerd-actions.json`; UTC `2026-11-09T10:03:21.442Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; real local workerd API Worker with the deterministic model service: LiveActions list/commands/start/cancel/follow/runs/read/rerun/slash and its typed failures, then signed sessions run Post and history Plan flows to settlement, with the input/authority/conflict/not-found matrix and cross-origin refusal. Limitations: Flow/adapter overhead over local workerd, no WAN or production contention; model replies are deterministic HTTP fixtures. Three samples per command on one served instance.

**M115 — workerd-sandboxes.** `2026-11-09T10-02-05.549Z-workerd-sandboxes.json`; UTC `2026-11-09T10:02:05.549Z`; source `c0f0cfab15ce5e357d0057344ee7467b911aa21e`. Vitest built-in bench; the per-person sandbox ledger object in real workerd SQLite with the product in-memory machines: start/write/stop/restart with generation fencing, stale and replayed receipts, retained bytes, metering and pruning, plus the public HTTP boundary's signed-out snapshot, forged-role refusal, routing and body admission. Limitations: In-memory machines stand in for the opt-in Cloudflare Container; container latency is not measured. Three samples per journey on one served object.

## local-browser

Artifact `2026-11-09T10-01-15.582Z-local-browser.json`. Three fresh Chromium contexts; navigation to visible heading, native Meta+K to visible modal/focused prompt, then one character to actual input value. Automation, shared browser/OS caches and polling included; no forced cold cache. Product mock mode, fresh browser context, shared browser/OS caches and automation overhead; no forced cold cache.

| Run | First visible render ms | Command-K ms | Keystroke ms |
| --- | --- | --- | --- |
| 0 | 373.48 | 50.73 | 28.92 |
| 1 | 230.49 | 77.05 | 24.97 |
| 2 | 274.90 | 69.56 | 34.56 |

## live-browser

Artifact `2026-11-09T09-22-40.903Z-live-browser.json`. Three fresh Chromium contexts; navigation to visible heading, native Meta+K to visible modal/focused prompt, then one character to actual input value. Automation, shared browser/OS caches and polling included; no forced cold cache. Default production backend selection; UI-only navigation and keys make no model call. Fresh context, shared browser/OS caches and automation overhead; no forced cold cache.

| Run | First visible render ms | Command-K ms | Keystroke ms |
| --- | --- | --- | --- |
| 0 | 247.27 | 40.52 | 9.59 |
| 1 | 278.05 | 23.18 | 11.28 |
| 2 | 240.88 | 39.31 | 20.38 |

## Live API

Artifact `2026-11-09T09-22-49.917Z-live-api.json`; first sample `2026-11-09T01:22:41.842000-08:00` in America/Los_Angeles. Deployed commit `1f84cfdeef` from /api/health. Three real-model posts, complete numbered SSE and settled snapshot checked. All post metrics begin at dispatch; subscription begins after acceptance. First answer delta is the public projection, not the provider raw token. Fresh is a unique object first read; warm is its next read. Neither forces a cold isolate. WAN/provider/PoP/budget/cache and shared-host contention included; no percentile claim.

| UTC sample | Fresh object ms | Warm read ms | Acceptance ms | First event ms | First answer delta ms | Settled ms |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-09T09:22:41.842Z | 766.76 | 24.19 | 1024.06 | 1085.04 | 2868.96 | 3150.22 |
| 2026-11-09T09:22:46.002Z | 914.69 | 44.79 | 498.51 | 572.59 | 1500.79 | 1861.49 |
| 2026-11-09T09:22:48.630Z | 690.33 | 35.34 | 386.93 | 649.31 | 959.76 | 1241.33 |

## history-browser-actions

Artifact `2026-11-09T10-01-29.561Z-history-browser-actions.json`. One serial native-browser journey, each action behaviorally asserted. Scripted waits and automation included; a single observation establishes no percentile. One serial Chromium journey over the full committed history and real MockMythical durable flows. Bootstrap, scripted work and automation included; no percentile. Fold changes only the product mock, never a real repository. Viewer UI omits writes; live writes are benchmarked as actual workerd refusals.

| Action | ms | Correctness passed |
| --- | --- | --- |
| history-first-render | 511.39 | True |
| history-expand-epic | 71.57 | True |
| history-next-page | 66.77 | True |
| history-open-commit | 77.41 | True |
| history-amend-and-escape | 89.03 | True |
| history-amend-submit | 131.12 | True |
| history-insert-before | 146.45 | True |
| history-filter-keystroke | 113.02 | True |
| history-plan | 148.89 | True |
| history-start | 59.74 | True |
| history-add-note | 75.28 | True |
| history-approve | 55.37 | True |
| history-fold | 249.29 | True |
| history-viewer-controls | 489.57 | True |

## local-browser-actions

Artifact `2026-11-09T10-01-27.006Z-local-browser-actions.json`. One serial native-browser journey, each action behaviorally asserted. Scripted waits and automation included; a single observation establishes no percentile. One serial native-browser journey with real Foldkit and product MockFactory; timings include scripted delays and automation. External docs content is not asserted; only the correct pane URL and controls. Video timing begins after navigation; ready-state/decoded-frame observation and native programmatic pause/play include automation, browser caches and software decode, without physical control interaction. Touch is dispatched as native synthetic DOM events, not physical hardware. Single observations establish no percentile.

| Action | ms | Correctness passed |
| --- | --- | --- |
| hero-ready-frame | 157.02 | True |
| hero-native-pause | 9.74 | True |
| hero-native-play | 21.97 | True |
| ask-button | 62.82 | True |
| submit-settle-0 | 915.20 | True |
| submit-settle-1 | 841.59 | True |
| submit-settle-2 | 827.52 | True |
| submit-settle-3 | 809.62 | True |
| wheel-pause | 35.93 | True |
| latest | 99.70 | True |
| pause-Home | 127.91 | True |
| pause-PageUp | 122.51 | True |
| pause-ArrowUp | 117.25 | True |
| pause-Control+Home | 102.67 | True |
| pause-Meta+ArrowUp | 95.72 | True |
| new-input-cancels-latest | 294.27 | True |
| touch-pause | 123.58 | True |
| actions-open | 129.33 | True |
| actions-run-and-trace | 343.65 | True |
| actions-cancel | 57.27 | True |
| actions-rerun | 141.76 | True |
| actions-escape-collapse | 134.75 | True |
| home-expand-minimize | 757.83 | True |
| learn-more | 605.48 | True |
| tour-pause | 74.39 | True |
| tour-resume | 61.37 | True |
| tour-skip-2 | 91.17 | True |
| tour-skip-3 | 556.76 | True |
| tour-skip-4 | 566.40 | True |
| tour-skip-5 | 86.02 | True |
| tour-skip-6 | 88.90 | True |
| escape-tour | 45.73 | True |
| wiki-maximize | 1164.73 | True |
| wiki-minimize | 54.42 | True |
| escape-wiki | 4.46 | True |

## local-role-actions

Artifact `2026-11-09T10-01-37.639Z-local-role-actions.json`. One serial native-browser journey, each action behaviorally asserted. Scripted waits and automation included; a single observation establishes no percentile. One serial native-browser journey over the real product fixture account/role flows. Each role visit includes selection, identity visibility and (for signed roles) opening/checking/closing People. Other actions include confirmation or cancellation and resulting state. Sign-in/retry use the explicit mock identity host; no GitHub login, production identity, account mutation or model. Scripted reply/automation delays included; one observation per action establishes no percentile.

| Action | ms | Correctness passed |
| --- | --- | --- |
| role-view-viewer | 41.18 | True |
| role-view-new | 1292.06 | True |
| role-view-community | 143.58 | True |
| role-view-contributor | 147.41 | True |
| role-view-maintainer | 133.01 | True |
| account-menu-keyboard | 74.78 | True |
| promote-member | 109.42 | True |
| cancel-role-change | 88.20 | True |
| escape-role-dialog | 62.69 | True |
| demote-member | 106.49 | True |
| restore-member | 85.23 | True |
| sign-out | 142.12 | True |
| mock-sign-in | 45.43 | True |
| participation-promotes-community | 557.64 | True |
| retry-mock-sign-in | 149.72 | True |

## local-wiki-actions

Artifact `2026-11-09T11-12-01.488Z-local-wiki-actions.json`. One serial native-browser journey, each action behaviorally asserted. Scripted waits and automation included; a single observation establishes no percentile. One serial native Chromium journey through real product fixture flows. Maintainer Save and contributor Propose each open a review and preserve repository Markdown; reopening checks the original source. Escape, role revocation and a scripted agent draft are checked. No real GitHub writes, OAuth or model. Scripted waits and automation included; one sample per action establishes no percentile.

| Action | ms | Correctness passed |
| --- | --- | --- |
| wiki-edit-maintainer | 104.14 | True |
| wiki-save | 85.88 | True |
| wiki-escape-maintainer | 50.63 | True |
| wiki-edit-contributor | 70.47 | True |
| wiki-propose | 84.79 | True |
| wiki-escape-contributor | 38.85 | True |
| wiki-role-change-closes-editor | 32.81 | True |
| wiki-agent-draft-review | 776.43 | True |
| wiki-agent-draft-propose | 68.64 | True |

## sandbox-browser-actions

Artifact `2026-11-09T10-01-33.793Z-sandbox-browser-actions.json`. One serial native-browser journey, each action behaviorally asserted. Scripted waits and automation included; a single observation establishes no percentile. One serial real Chromium journey over product mock flows and supported terminal commands; exact retained terminal transcript checked across Stop/Start. No model/backend/real Container. Forced mock roles never grant live authority. Automation and scripted waits included; no percentile.

| Action | ms | Correctness passed |
| --- | --- | --- |
| sandbox-open-pane | 44.10 | True |
| sandbox-start | 65.51 | True |
| sandbox-terminal-write | 39.49 | True |
| sandbox-stop | 58.66 | True |
| sandbox-restart | 62.94 | True |
| sandbox-read-retained-bytes | 56.96 | True |
| sandbox-maximize | 70.77 | True |
| sandbox-minimize | 68.54 | True |
| sandbox-escape | 4.75 | True |
| sandbox-viewer-controls | 1356.99 | True |

## Regression gate

The committed nine-case roster counts actual indexed reads in decide/apply/receive at 10/1,000/100,000 entries. Counts may rise at most 5%, rounded up; zero remains zero. Full prefix, new entry and pending confirmation are asserted. Missing roster and beyond-tolerance controls reject. It gates entry access, not CPU instructions, allocations, network or wall time. CI never changes the baseline.

## Findings

- Whole-transcript scene rendering includes vnode construction, serialization and correctness queries; no virtualization exists. `web-100000/view`: 4357.440ms mean, 3 samples; `2026-11-09T10-04-09.176Z-web-100000.json`. Exact method/limitations above.
- The epic list is paged, but this fixture plans every commit and the separate Planned list scales with the entire outline. `history-web-100000/history-open-epic-view`: 9154.626ms mean, 3 samples; `2026-11-09T10-02-45.645Z-history-web-100000.json`. Exact method/limitations above.
- Complete schema decode/equality remains substantial at 100,000 entries. `protocol/snapshot-decode-100000`: 579.210ms mean, 5 samples; `2026-11-09T10-04-27.711Z-protocol.json`. Exact method/limitations above.
- Emitted CLI startup dominates a small local read. `cli/--mock read --json`: 1837.788ms mean, 3 samples; `2026-11-09T09-59-41.821Z-cli.json`. Exact method/limitations above.
- MCP startup, initialize and discovery dominate a small call. `mcp/mcp-read`: 1857.326ms mean, 3 samples; `2026-11-09T09-59-53.921Z-mcp.json`. Exact method/limitations above.
- Persistent-session MCP excludes cold process startup. `mcp-warm/mcp-warm-read`: 3.832ms mean, 27 samples; `2026-11-09T10-00-22.487Z-mcp-warm.json`. Exact method/limitations above.
- The ten real reading holds contribute 134 seconds to each complete tour; this is presentation time plus flow overhead. `workerd/workerd-tour`: 135581.858ms mean, 3 samples; `2026-11-09T10-23-05.185Z-workerd.json`. Exact method/limitations above.
- Fixed the merger crediting an unexecuted nested statement from an enclosing range and borrowing same-line function/branch hits. Four failed-first regressions now pass; figures from the former span heuristic are superseded.
- Added native wiki editing, Save/Propose, Escape, role revocation and reviewing a scripted agent draft. Each submission opens a review without replacing repository Markdown; real GitHub writes remain outside this fixture method.
- Updated stale pre-VL-31 fixtures to the private walkthrough stream and real theatre/issue/VIP/wiki controls. Native action Run/Cancel/Re-run requires distinct run identities and retained terminal traces.
- The workerd deadline now includes three real reading budgets. The preceding run passed 97 groups and failed only that deadline; no reading hold was shortened.
- Earlier landed fixes remain: native page-key/Latest follow recovery, site /history routing, correlated concurrent replies, and real mock initialization before clocked tests. Their historical receipts remain in the lane report.

## Benchmark-only coverage

`pnpm bench:coverage` executes only benchmark workloads once under the coverage lane patched V8 5.0.0 provider, with subprocess evidence; no unit or fuzz suite is imported. Workerd adds independent Istanbul counters and Chromium precise V8 dumps. Strict 100% per-file thresholds remain red. Merged src/worker count: 5083/6675 statement-start executable lines. Scope additionally includes infra/scripts; the sole reasoned source exclusion is the unreachable mythical-seed guard in 0017. No src/worker line is excluded.

**100% remains unfinished.** Coverage source `6a979627e06c4be522557d65f6ffa8bb8320b349` (parent `9c4f4eed14f8fd3e51c4c96ebf885ba2a4541087`) predates the later CLI/MCP identity change (0028); its new modules are not in this denominator. Focused identity timing receipts retain their own later revisions and make no independent coverage claim. The latest full run reuses decision 0016’s canonical V8 configuration with its strict gate deferred until all runtime collectors join. It executes the independent benchmark include list on the archived `shared-config-source.json` snapshot, including the new wiki journey and six native browser workloads. All collectors belong to the same production source snapshot; before/after source digests are retained. Browser source profiling uses the unminified `bench-coverage` build. Real JavaScript and VibeLang skipped-return controls pass there; optimized-bundle statement attribution remains unqualified. Timings use the normal optimized build. Workerd precise V8 profiling is unavailable, so it contributes independent instrumented counters. The merger normalizes only Infinity end columns exactly like the shared provider and requires complete finite matching locations; different shapes stay uncovered. Production-only GitHub mutations, OAuth success and real Container lifecycle are not established by product fixture mode. Additional allowed error/control paths also remain uncovered; the per-file maps retain their exact positions. No src/worker line is excluded. Raw Node, workerd, Chromium and merged maps are archived with the report.

| File | Node V8 covered/executable | Merged covered/executable | Merged percent |
| --- | --- | --- | --- |
| infra/SandboxImage.vibe | 0/2 | 0/2 | 0.00% |
| infra/Stack.vibe | 8/8 | 8/8 | 100.00% |
| infra/WorkerBuild.vibe | 1/1 | 1/1 | 100.00% |
| scripts/agent-context.vibe | 22/22 | 22/22 | 100.00% |
| scripts/mythical-seed.vibe | 51/51 | 50/50 | 100.00% |
| scripts/wiki.vibe | 30/30 | 30/30 | 100.00% |
| src/actions/Actions.vibe | 4/4 | 4/4 | 100.00% |
| src/actions/LiveActions.vibe | 43/43 | 43/43 | 100.00% |
| src/actions/MockActions.vibe | 109/118 | 110/118 | 93.22% |
| src/actions/agent.vibe | 5/11 | 5/11 | 45.45% |
| src/actions/catalog.vibe | 8/8 | 8/8 | 100.00% |
| src/actions/execution.vibe | 28/40 | 28/40 | 70.00% |
| src/actions/tools.vibe | 12/13 | 12/13 | 92.31% |
| src/actions/wire.vibe | 6/6 | 6/6 | 100.00% |
| src/assets/wiki.generated.vibe | 2/2 | 2/2 | 100.00% |
| src/core/Factory.vibe | 3/3 | 3/3 | 100.00% |
| src/core/IssuesFactory.vibe | 74/75 | 74/75 | 98.67% |
| src/core/LiveAccounts.vibe | 25/25 | 25/25 | 100.00% |
| src/core/LiveFactory.vibe | 69/77 | 69/77 | 89.61% |
| src/core/LiveIssues.vibe | 3/11 | 3/11 | 27.27% |
| src/core/LiveWiki.vibe | 4/15 | 4/15 | 26.67% |
| src/core/MockAccounts.vibe | 64/68 | 67/68 | 98.53% |
| src/core/MockFactory.vibe | 205/252 | 233/252 | 92.46% |
| src/core/MockJournal.vibe | 1/1 | 1/1 | 100.00% |
| src/core/VipWriter.vibe | 1/1 | 1/1 | 100.00% |
| src/core/WikiFactory.vibe | 58/64 | 61/64 | 95.31% |
| src/core/WikiWriter.vibe | 1/1 | 1/1 | 100.00% |
| src/core/conversation.vibe | 286/296 | 288/296 | 97.30% |
| src/core/flowDecision.vibe | 49/65 | 51/65 | 78.46% |
| src/core/flows.vibe | 122/165 | 145/165 | 87.88% |
| src/core/issueFlows.vibe | 32/32 | 32/32 | 100.00% |
| src/core/issueSchemas.vibe | 12/12 | 12/12 | 100.00% |
| src/core/mockDecision.vibe | 10/10 | 10/10 | 100.00% |
| src/core/mockReplies.vibe | 19/19 | 19/19 | 100.00% |
| src/core/protocolDecision.vibe | 16/17 | 17/17 | 100.00% |
| src/core/roles.vibe | 4/4 | 4/4 | 100.00% |
| src/core/sandboxDecision.vibe | 54/55 | 55/55 | 100.00% |
| src/core/sandboxHost.vibe | 130/181 | 147/181 | 81.22% |
| src/core/sandboxMeter.vibe | 33/33 | 33/33 | 100.00% |
| src/core/sandboxMock.vibe | 40/47 | 43/47 | 91.49% |
| src/core/sandboxPolicy.vibe | 2/2 | 2/2 | 100.00% |
| src/core/schemas.vibe | 30/30 | 30/30 | 100.00% |
| src/core/sequenceDecision.vibe | 20/20 | 20/20 | 100.00% |
| src/core/specification.vibe | 32/32 | 32/32 | 100.00% |
| src/core/walkthroughSteps.vibe | 2/2 | 2/2 | 100.00% |
| src/core/wiki.vibe | 15/15 | 15/15 | 100.00% |
| src/core/wikiDecision.vibe | 1/1 | 1/1 | 100.00% |
| src/core/wikiFlows.vibe | 29/32 | 29/32 | 90.62% |
| src/core/wikiLinks.vibe | 13/14 | 13/14 | 92.86% |
| src/core/wikiSchemas.vibe | 5/5 | 5/5 | 100.00% |
| src/core/wire.vibe | 26/27 | 26/27 | 96.30% |
| src/history/LiveMythical.vibe | 39/41 | 39/41 | 95.12% |
| src/history/MockMythical.vibe | 35/35 | 35/35 | 100.00% |
| src/history/MythicalHistory.vibe | 2/2 | 2/2 | 100.00% |
| src/history/Sequencer.vibe | 86/96 | 86/96 | 89.58% |
| src/history/flowMachine.vibe | 50/51 | 50/51 | 98.04% |
| src/history/flows.vibe | 65/76 | 68/76 | 89.47% |
| src/history/mythical.vibe | 141/141 | 141/141 | 100.00% |
| src/history/pages.vibe | 36/36 | 36/36 | 100.00% |
| src/history/roles.vibe | 6/6 | 6/6 | 100.00% |
| src/history/schemas.vibe | 31/32 | 32/32 | 100.00% |
| src/history/seed.vibe | 166/171 | 166/171 | 97.08% |
| src/history/seed/vibelang.vibe | 2/2 | 2/2 | 100.00% |
| src/history/tools.vibe | 26/27 | 26/27 | 96.30% |
| src/history/wire.vibe | 35/35 | 35/35 | 100.00% |
| src/surfaces/backend.vibe | 19/27 | 19/27 | 70.37% |
| src/surfaces/cli-entry.vibe | 8/8 | 8/8 | 100.00% |
| src/surfaces/cli.vibe | 16/16 | 16/16 | 100.00% |
| src/surfaces/commandDecision.vibe | 9/9 | 9/9 | 100.00% |
| src/surfaces/commands.vibe | 119/161 | 119/161 | 73.91% |
| src/surfaces/manifest.vibe | 4/4 | 4/4 | 100.00% |
| src/surfaces/mcp-entry.vibe | 6/6 | 6/6 | 100.00% |
| src/surfaces/mcp.vibe | 15/15 | 15/15 | 100.00% |
| src/web/actionModel.vibe | 15/15 | 15/15 | 100.00% |
| src/web/actionView.vibe | 25/30 | 27/30 | 90.00% |
| src/web/backend.vibe | 33/72 | 59/72 | 81.94% |
| src/web/entry.vibe | 0/8 | 8/8 | 100.00% |
| src/web/historyApp.vibe | 85/156 | 93/156 | 59.62% |
| src/web/historyBackend.vibe | 0/26 | 16/26 | 61.54% |
| src/web/historyStartup.vibe | 0/32 | 33/33 | 100.00% |
| src/web/historyView.vibe | 64/73 | 64/73 | 87.67% |
| src/web/issues.vibe | 43/49 | 43/49 | 87.76% |
| src/web/issuesView.vibe | 63/78 | 63/78 | 80.77% |
| src/web/main.vibe | 255/618 | 440/618 | 71.20% |
| src/web/markdown.vibe | 94/103 | 101/103 | 98.06% |
| src/web/media.vibe | 6/6 | 6/6 | 100.00% |
| src/web/modeSwitch.vibe | 2/2 | 2/2 | 100.00% |
| src/web/modelDecision.vibe | 4/28 | 9/28 | 32.14% |
| src/web/roleView.vibe | 17/24 | 18/24 | 75.00% |
| src/web/sandboxView.vibe | 14/17 | 15/17 | 88.24% |
| src/web/screenDecision.vibe | 38/41 | 38/41 | 92.68% |
| src/web/startup.vibe | 46/50 | 50/50 | 100.00% |
| src/web/startupDecision.vibe | 9/9 | 9/9 | 100.00% |
| src/web/styles.vibe | 1/1 | 1/1 | 100.00% |
| src/web/theatre.vibe | 4/45 | 32/45 | 71.11% |
| src/web/theatreDecision.vibe | 18/18 | 18/18 | 100.00% |
| src/web/view.vibe | 48/51 | 48/51 | 94.12% |
| src/web/viewDecision.vibe | 22/22 | 22/22 | 100.00% |
| src/web/viewport.vibe | 16/48 | 46/48 | 95.83% |
| src/web/wikiView.vibe | 26/28 | 26/28 | 92.86% |
| worker/Accounts.vibe | 14/211 | 153/211 | 72.51% |
| worker/ActionDirectory.vibe | 26/36 | 34/36 | 94.44% |
| worker/ActionIdentity.vibe | 4/14 | 10/14 | 71.43% |
| worker/ActionRuns.vibe | 95/117 | 102/117 | 87.18% |
| worker/ActionsHttp.vibe | 3/41 | 40/41 | 97.56% |
| worker/AgentModel.vibe | 9/9 | 9/9 | 100.00% |
| worker/Api.vibe | 44/225 | 44/225 | 19.56% |
| worker/Budget.vibe | 20/22 | 20/22 | 90.91% |
| worker/HistoryActions.vibe | 17/33 | 18/33 | 54.55% |
| worker/HistoryObject.vibe | 6/60 | 45/60 | 75.00% |
| worker/HistoryTools.vibe | 8/8 | 8/8 | 100.00% |
| worker/Http.vibe | 65/93 | 77/93 | 82.80% |
| worker/IssueCredentials.vibe | 1/16 | 5/16 | 31.25% |
| worker/Issues.vibe | 6/271 | 6/271 | 2.21% |
| worker/MainLog.vibe | 29/43 | 29/43 | 67.44% |
| worker/ObjectStorage.vibe | 10/10 | 10/10 | 100.00% |
| worker/Objects.vibe | 61/107 | 88/107 | 82.24% |
| worker/Reply.vibe | 87/136 | 121/136 | 88.97% |
| worker/SandboxAccounts.vibe | 6/60 | 6/60 | 10.00% |
| worker/SandboxHttp.vibe | 4/30 | 26/30 | 86.67% |
| worker/SandboxMachine.vibe | 1/66 | 1/66 | 1.52% |
| worker/SandboxTools.vibe | 8/11 | 8/11 | 72.73% |
| worker/Sandboxes.vibe | 0/22 | 26/26 | 100.00% |
| worker/Sequencer.vibe | 101/118 | 106/118 | 89.83% |
| worker/SpecificationReviewers.vibe | 10/31 | 10/31 | 32.26% |
| worker/Tour.vibe | 4/5 | 5/5 | 100.00% |
| worker/Unreachable.vibe | 1/1 | 1/1 | 100.00% |
| worker/VipDraft.vibe | 4/30 | 4/30 | 13.33% |
| worker/Wiki.vibe | 2/152 | 2/152 | 1.32% |
| worker/WikiDraft.vibe | 4/32 | 4/32 | 12.50% |
| worker/WikiTools.vibe | 1/9 | 2/9 | 22.22% |
| worker/agentContext.vibe | 1/1 | 1/1 | 100.00% |
| worker/budgetDecision.vibe | 4/5 | 5/5 | 100.00% |
| worker/index.vibe | 13/13 | 13/13 | 100.00% |
| worker/liveDispatchDecision.vibe | 7/7 | 7/7 | 100.00% |
| worker/replyProgressDecision.vibe | 17/17 | 17/17 | 100.00% |
| worker/replyReasons.vibe | 7/7 | 7/7 | 100.00% |
