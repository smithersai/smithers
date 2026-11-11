# Benchmarks

Decision [0017](decisions/0017-benchmarks.md). Measured on shared nyc-01, Linux x86_64, Node 26.5.0, VibeLang 0.0.12, Effect 4.1.1, Vitest 5.0.0 and Chromium 151 / Playwright 1.62.1. Raw JSON under `bench/results/` retains machine, versions, source revision, timestamp, method, limitations and raw samples. Archived with the lane report outside the disposable workspace. Source revisions are never relabeled after rebasing.

Vitest built-in benchmarks assert correctness inside timing. Short callbacks use 30ms warmup and at least five iterations across 100ms. Slow callbacks use three unwarmed samples unless specified. Reported callback throughput is 1000 / mean ms; replay throughput multiplies by the exact event count. Three samples establish no tail percentile. Shared-host wall times are observations; the committed 5% work-count gate supplies the deterministic verdict. Instrumented coverage timings and unsuccessful observations are excluded.

Current hosted-broker receipt: **5,827/7,036 src/worker statement-start lines (82.82%)**, production parent `ca292c70`; strict gate red for 95 files. [Current coverage](#resumed-source-profile-measurement-2026-11-09) and [corrected timing roster](#complete-corrected-local-timing-roster) follow the historical receipts. No src/worker line is excluded. Historical timing without explicit runner classification does not establish isolated unwarmed execution; the real-runner regression and correction are in 0017.

## Earlier local validated workloads

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
| workerd-actions (withdrawn) | workerd-actions (withdrawn) | — | — | — |  | M114 |
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

## Sandbox objects (in-memory Container)

Vitest built-in bench, three samples per journey on one served Worker, production object bodies in real workerd SQLite. Artifact: `2026-11-09T17-36-26.294Z-sandbox-objects.json`, recorded 2026-11-09T17:36:26.294Z on the development host.

| Journey | Mean (ms) | Samples |
| --- | ---: | ---: |
| `sandbox-objects-lifecycle` | 751.395 | 3 |
| `sandbox-objects-refusals` | 9.323 | 3 |
| `sandbox-machine-faults` | 54.788 | 3 |

Limitation: an in-memory Container answers the run tool's fence protocol. No Cloudflare Container, image, checkpoint or shell latency is measured (0017).

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

## Earlier source-profile measurement before hosted broker (2026-11-09)

The complete benchmark-only run on archived production parent `6886bb65022164f79cf6df922eb197d3c9c10343` covers **5,789/6,991 src/worker statement-start lines (82.81%)**. All executable source hashes (including the generated wiki module) match before/after; ignored `.d.vibe.ts` compiler outputs were regenerated and are separately listed, never used as coverage evidence. All benchmark workloads pass; the strict merged gate exits 1 for 95 files. No src/worker line is excluded. This is unfinished. The initial current-main baseline on `3fa8df73` was 5,221/6,947 (75.15%); intervening main changes include account/action proof refactors and issue rendering updates, so this is a comparison of named snapshots, not a controlled attribution of every denominator change to benchmark additions. Raw JSON receipt `2026-11-09T14-23-26.344Z-coverage-receipt.json`, complete source, before/after hashes, Node/workerd/Chromium maps and source-profile bundles are retained with the lane report.

The collector reuses decision 0016's configuration. Only benchmark workloads run; no unit/fuzz counters or earlier source snapshots join this map. Chromium source profiling is unminified and exact source ranges must match. Optimized-bundle attribution remains unqualified. Instrumented timings are excluded from performance tables. Real Container, GitHub write and OAuth requirements and precise future benchmarks remain in 0017. Ordinary reachable errors/control paths also remain visible below.

### Added validated observations

Shared nyc-01; raw metadata includes machine, versions, timestamp, exact source revision, method and limitations. Every callback checks its result. Means below include those assertions. Explicit sync/async runner registration prevents unmeasured classification calls; real-runner controls check exact callback counts and concurrency. Three samples do not establish a tail percentile.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| content-workerd | 15382.8983 | 3 | `2026-11-09T13-56-51.860Z-content-workerd.json` |
| drafts-workerd | 12777.6828 | 3 | `2026-11-09T13-56-04.591Z-drafts-workerd.json` |
| history-browser-command-faults | 2.0450 | 3 | `2026-11-09T14-02-12.541Z-history-browser-command-faults.json` |
| history-browser-commands | 19.8902 | 3 | `2026-11-09T14-02-12.438Z-history-browser-commands.json` |
| issues-host-journey | 632.0557 | 3 | `2026-11-09T14-00-26.294Z-issues-host-journey.json` |
| issues-host-recovery | 1291.1158 | 3 | `2026-11-09T14-00-30.281Z-issues-host-recovery.json` |
| provider-guards | 0.5384 | 186 | `2026-11-09T14-01-57.907Z-provider-guards.json` |
| provider-host-refusals | 6.7428 | 3 | `2026-11-09T14-01-58.036Z-provider-host-refusals.json` |
| session-live-refusals | 415.4899 | 3 | `2026-11-09T14-01-07.543Z-session-live-refusals.json` |
| session-runtime | 288.5772 | 3 | `2026-11-09T14-01-06.196Z-session-runtime.json` |
| session-settings | 12.7034 | 3 | `2026-11-09T14-01-05.114Z-session-settings.json` |
| session-settings-faults | 3.3968 | 3 | `2026-11-09T14-01-05.233Z-session-settings-faults.json` |
| web-account-state | 0.3019 | 332 | `2026-11-09T14-01-42.220Z-web-account-state.json` |
| web-content-commands | 48.3173 | 3 | `2026-11-09T14-01-46.255Z-web-content-commands.json` |
| web-execution-commands | 37.0384 | 3 | `2026-11-09T14-01-46.475Z-web-execution-commands.json` |
| web-issue-state | 2.4299 | 42 | `2026-11-09T14-01-42.459Z-web-issue-state.json` |
| web-wiki-state | 0.1794 | 558 | `2026-11-09T14-01-42.687Z-web-wiki-state.json` |
| wiki-host-journey | 504.3292 | 3 | `2026-11-09T14-00-31.904Z-wiki-host-journey.json` |
| wiki-host-recovery | 1267.1842 | 3 | `2026-11-09T14-00-35.855Z-wiki-host-recovery.json` |

**content-workerd.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T13:56:51.860Z`. Vitest built-in bench; each of three unwarmed samples starts fresh real workerd issue and wiki hosts. HTTP/SQLite commitments replay once; credentials are encrypted/session-bound/current-role/expiring; paid failed drafts charge once; partial write retryFrom adopts exactly one original child. Wiki draft privacy, contributor proposal/replay, forbidden Save, unchanged Markdown and one completed proposal journal row checked. Bundling, server lifecycle and assertions included. Limitations: Existing unshipped host supplies product fixture identities/repository; typed faulty Effect services exercise paid failures and partial recovery. No real GitHub write, OAuth or Container. Whole fresh-host corpus cost includes bundling and startup; it is not per-request latency or model inference.

**drafts-workerd.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T13:56:04.591Z`. Vitest built-in bench; three fresh native workerd worlds run production VIP draft, wiki draft and specification reviewer AgentActions, SDK model HTTP/SSE, QuickJS and SQLite over one deterministic local model service. Exact schema answers, six metered tokens, three HTTP model calls and cached replay with no further call checked. Bundling/startup/assertions included. Limitations: Deterministic model responses measure flow/agent overhead without inference or WAN. No GitHub write, OAuth, Container or real provider spending. Whole fresh-host corpus is not per-request latency.

**history-browser-command-faults.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:02:12.541Z`. Vitest built-in bench; typed faulty Effect Mythical service, four browser reads and five writes under both permission and transport failures. All exact message/reason projections and redaction checked. Three full corpora, setup/assertions included. Limitations: Deliberate service failures, no request interception or successful provider simulation; no network, repository writes or model.

**history-browser-commands.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:02:12.438Z`. Vitest built-in bench; actual History Command effects over MockMythical's memory engine from empty history. Outline, Plan, epic/search, Start/Note/Approve/Fold and commit/missing detail; exact command messages, retained fields, notes, fold SHA and final six-event outline checked. Three fresh scoped engines, assertions included. Limitations: Shipped product mock main, no GitHub mutation, network, OAuth or actual repository fold. Command Effects without browser layout/DOM focus.

**issues-host-journey.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:00:26.294Z`. Vitest built-in bench; real serveIssues/executeIssues with SQLite, actual fixtureHost and changing Effect identity. Fresh world per sample; public projection strips untrusted approval, new/replay/changed request, human approval, saved receipt, revoked/agent writes, specification revision and missing reviewer checked. Exact HTTP statuses, retained body, once-only creation, approval and reset history asserted. Setup/assertions included. Limitations: Node HTTP values and real in-memory SQLite; no TCP, workerd scheduling, GitHub/OAuth or model. Product fixture host is explicitly injected. Whole journey is not per-command latency.

**issues-host-recovery.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:00:30.281Z`. Vitest built-in bench; production HTTP/SQLite issue adapter, fifteen injected typed Effect host failures, then a real fixture creation after explicit native retryFrom. Cached failure cannot retry implicitly; changed payload refused; exact matching recovery, replay, saved operation and missing receipt checked against unchanged fixture rows. Three fresh worlds; all assertions included. Phase-only diagnostic logs disabled. Limitations: Fault injection fails before the shipped fixture host; no own-code request interception, GitHub mutation or OAuth. Node SQLite in memory, no network/model. This is a complete fault/recovery corpus cost.

**provider-guards.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:57.907Z`. Vitest built-in bench; exact safe issue/wiki error classification (precedence, retry interval, no provider detail), malformed/mismatched/noncanonical/unsafe VIP markers and invalid author, configured wiki file path and traversal/generated-index refusal. Every callback checks its outputs. Limitations: Pure guards and no-request early returns; no successful GitHub review validation, network, credentials or writes.

**provider-host-refusals.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:58.036Z`. Vitest built-in bench; actual GitHub issue/wiki host closures with an injected unavailable Effect HttpClient and changing principal. Missing key, credential connection, unavailable draft, unknown page, empty draft and anonymous write failures asserted. Wiki text persists before Connect. All writes make zero requests; one public read reaches the failing transport exactly once. Three fresh SQLite/KV worlds, setup/assertions included. Limitations: No request interception, external request, real credential, OAuth or GitHub mutation. Deliberate transport failure establishes refusal behavior only; successful provider paths remain unmeasured.

**session-live-refusals.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:07.543Z`. Vitest built-in bench; actual native signIn/signOutSurface, SDK SQLite journal and real loopback HTTP faulty Effect service. Three invalid origins make no request; local device-route 503 and sign-out 503 produce exact safe failures. Failed revocation still deletes private credentials; repeated logout is false; exactly two requests asserted. Three fresh scoped samples. Limitations: Deliberately refusing loopback service; no request interception, OAuth grant, real token, external network or production write. Measures refusal/validation and durable IO overhead, not successful sign-in.

**session-runtime.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:06.196Z`. Vitest built-in bench; real platform-node SQLite host for sessionOperation and waitForSignIn. Action succeeds/fails, Poll completes on its first check or injected typed check failure. Exact statuses, propagated safe failure, counter increment and four bounded content-free telemetry records asserted. Three fresh private journals; setup/teardown included. Limitations: Deterministic action/check results measure durable flow overhead, not GitHub authorization, device polling intervals or WAN latency. No provider credential is used.

**session-settings.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:05.114Z`. Vitest built-in bench; real scoped filesystem settings lifecycle: absent/full replacement, separate mock/live session, exact 0700/0600 modes, pending grant retained/expired/deleted, repeated removal, invalid JSON/schema refusal, HOME fallback/missing HOME, explicit credential validation. Three unwarmed full corpora; setup, disk IO and correctness checks included. Limitations: Synthetic fixture values only; no OAuth/network. Local filesystem and process cache, no fsync/crash-durability claim. Private paths/contents omitted from artifacts.

**session-settings-faults.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:05.233Z`. Vitest built-in bench; actual settings functions with an injected faulty Effect FileSystem chmod/remove over real temporary directories. Preparation/write/removal return exact safe reasons and no session file is published. Three fresh scoped samples, assertions included. Limitations: Permission failures are injected, not measured OS permission policy; no credential/OAuth/provider action.

**web-account-state.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:42.220Z`. Vitest built-in bench; account/People/menu/grant/cancel/sign-in/out reducer corpus with all five roles, exact emitted work, three command retries, role-stream recovery and duplicate/gap/demotion fences. Every callback asserts state and ordered command names. Limitations: Pure reducer policy cost, no native dialogs, OAuth, network or persistence; runtime services and browser journeys are separate benchmarks.

**web-content-commands.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:46.255Z`. Vitest built-in bench; real Foldkit Command effects over one scoped MockFactory, including identity/grant/readback, issue creation/details/projection, wiki editor/private draft/Save/readback and sign-in/out. Exact messages, source, public author/role and once-only review checked. Three fresh engines; setup, flow execution and assertions included. Limitations: Effect command boundary without DOM layout/paint; shipped product fixture services, no network/OAuth/GitHub/model. Full journey cost, not per-keystroke latency.

**web-execution-commands.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:46.475Z`. Vitest built-in bench; actual Command effects over MockActions/Factory: catalog, Tour run/read/cancel and invalid input, sandbox file write/stop/restart/readback, then faulty action discovery/read/cancel. Exact ids, states, generations, retained output and request/epoch fields checked. Three fresh engines, assertions included. Limitations: Product mock runtime, no actual Container, model or network. Command-level journey includes initialization and IO; native browser layout separately benchmarked.

**web-issue-state.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:42.459Z`. Vitest built-in bench; saved new/VIP/comment/specification requests across completed/failed/running receipts, unrelated error fence, seven exact failure labels, unwritten correction, selected-detail cursor fences and live detail dispatch. Literal text/identity/state and ordered emitted work checked each callback. Limitations: Reducer/restoration overhead only; no request/transport interception, network, provider write or model.

**web-wiki-state.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:01:42.687Z`. Vitest built-in bench; wiki editor begin/type/submit/cancel, immutable uncertain request, stale completion/failure fences, five exact failure labels and unwritten correction, unchanged observed source with review, filter/location and page-open failure identity. Exact model fields asserted each callback. Limitations: Pure update-state cost; does not execute emitted services or simulate browser dialogs/network. Native and SQLite wiki journeys run separately.

**wiki-host-journey.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:00:31.904Z`. Vitest built-in bench; production serveWiki/executeWiki and SQLite runtime over real fixtureWikiHost. GET/read, private draft/readback, maintainer Save, exact replay and changed-payload refusal, contributor gate/Propose and agent refusal. Original source, literal draft, two distinct review receipts and exact retained proposals checked; three fresh worlds, setup/assertions included. Limitations: Product fixture repository, no GitHub/OAuth/network/model. Node HTTP objects and in-memory SQLite; no claim of actual provider review creation or workerd scheduling. Whole-journey cost.

**wiki-host-recovery.** Source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`; UTC `2026-11-09T14:00:35.855Z`. Vitest built-in bench; nine typed faulty Effect host outcomes through production HTTP/SQLite, failure receipt replay, changed request rejection and native retryFrom into shipped fixtureWikiHost. Exact statuses, original request, once-only review and unchanged Markdown checked; three fresh worlds, assertions included. Limitations: Fault service fails before host writes; no HTTP interception. Local SQLite, no provider/real credentials/model/network. No successful GitHub or OAuth coverage claimed.

### Current per-file benchmark coverage

Executable lines are statement starts; an enclosing declaration cannot credit its nested body. All four strict metrics and exact uncovered positions remain in the raw receipt. Counts below additionally retain Node-only execution separately from merged evidence.

| File | Node covered/executable | Merged covered/executable | Merged lines |
| --- | ---: | ---: | ---: |
| `infra/SandboxImage.vibe` | 0/2 | 0/2 | 0.00% |
| `infra/Stack.vibe` | 8/8 | 8/8 | 100.00% |
| `infra/WorkerBuild.vibe` | 1/1 | 1/1 | 100.00% |
| `scripts/agent-context.vibe` | 22/22 | 22/22 | 100.00% |
| `scripts/mythical-seed.vibe` | 51/51 | 50/50 | 100.00% |
| `scripts/wiki.vibe` | 30/30 | 30/30 | 100.00% |
| `src/actions/Actions.vibe` | 4/4 | 4/4 | 100.00% |
| `src/actions/LiveActions.vibe` | 43/43 | 43/43 | 100.00% |
| `src/actions/MockActions.vibe` | 109/118 | 110/118 | 93.22% |
| `src/actions/agent.vibe` | 5/11 | 5/11 | 45.45% |
| `src/actions/catalog.vibe` | 8/8 | 8/8 | 100.00% |
| `src/actions/execution.vibe` | 28/40 | 28/40 | 70.00% |
| `src/actions/tools.vibe` | 12/13 | 12/13 | 92.31% |
| `src/actions/wire.vibe` | 6/6 | 6/6 | 100.00% |
| `src/assets/wiki.generated.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/Factory.vibe` | 3/3 | 3/3 | 100.00% |
| `src/core/IssuesFactory.vibe` | 75/76 | 75/76 | 98.68% |
| `src/core/LiveAccounts.vibe` | 25/26 | 25/26 | 96.15% |
| `src/core/LiveFactory.vibe` | 69/77 | 69/77 | 89.61% |
| `src/core/LiveIssues.vibe` | 3/11 | 3/11 | 27.27% |
| `src/core/LiveWiki.vibe` | 4/15 | 4/15 | 26.67% |
| `src/core/MockAccounts.vibe` | 73/77 | 76/77 | 98.70% |
| `src/core/MockFactory.vibe` | 208/254 | 236/254 | 92.91% |
| `src/core/MockJournal.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/VipWriter.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/WikiFactory.vibe` | 62/65 | 65/65 | 100.00% |
| `src/core/WikiWriter.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/conversation.vibe` | 287/296 | 288/296 | 97.30% |
| `src/core/flowDecision.vibe` | 49/65 | 51/65 | 78.46% |
| `src/core/flows.vibe` | 122/165 | 145/165 | 87.88% |
| `src/core/identityDecision.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/issueFlows.vibe` | 32/32 | 32/32 | 100.00% |
| `src/core/issueSchemas.vibe` | 12/12 | 12/12 | 100.00% |
| `src/core/mockDecision.vibe` | 10/10 | 10/10 | 100.00% |
| `src/core/mockReplies.vibe` | 19/19 | 19/19 | 100.00% |
| `src/core/protocolDecision.vibe` | 16/17 | 17/17 | 100.00% |
| `src/core/roles.vibe` | 5/5 | 5/5 | 100.00% |
| `src/core/sandboxDecision.vibe` | 54/55 | 55/55 | 100.00% |
| `src/core/sandboxHost.vibe` | 130/181 | 147/181 | 81.22% |
| `src/core/sandboxMeter.vibe` | 33/33 | 33/33 | 100.00% |
| `src/core/sandboxMock.vibe` | 40/47 | 43/47 | 91.49% |
| `src/core/sandboxPolicy.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/schemas.vibe` | 30/30 | 30/30 | 100.00% |
| `src/core/sequenceDecision.vibe` | 20/20 | 20/20 | 100.00% |
| `src/core/specification.vibe` | 32/32 | 32/32 | 100.00% |
| `src/core/walkthroughSteps.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/wiki.vibe` | 15/15 | 15/15 | 100.00% |
| `src/core/wikiDecision.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/wikiFlows.vibe` | 32/32 | 32/32 | 100.00% |
| `src/core/wikiLinks.vibe` | 13/14 | 13/14 | 92.86% |
| `src/core/wikiSchemas.vibe` | 5/5 | 5/5 | 100.00% |
| `src/core/wire.vibe` | 26/27 | 26/27 | 96.30% |
| `src/history/LiveMythical.vibe` | 39/41 | 39/41 | 95.12% |
| `src/history/MockMythical.vibe` | 35/35 | 35/35 | 100.00% |
| `src/history/MythicalHistory.vibe` | 2/2 | 2/2 | 100.00% |
| `src/history/Sequencer.vibe` | 86/96 | 86/96 | 89.58% |
| `src/history/flowMachine.vibe` | 50/51 | 50/51 | 98.04% |
| `src/history/flows.vibe` | 66/76 | 68/76 | 89.47% |
| `src/history/mythical.vibe` | 141/141 | 141/141 | 100.00% |
| `src/history/pages.vibe` | 36/36 | 36/36 | 100.00% |
| `src/history/roles.vibe` | 6/6 | 6/6 | 100.00% |
| `src/history/schemas.vibe` | 31/32 | 32/32 | 100.00% |
| `src/history/seed.vibe` | 166/171 | 166/171 | 97.08% |
| `src/history/seed/vibelang.vibe` | 2/2 | 2/2 | 100.00% |
| `src/history/tools.vibe` | 26/27 | 26/27 | 96.30% |
| `src/history/wire.vibe` | 35/35 | 35/35 | 100.00% |
| `src/surfaces/backend.vibe` | 38/45 | 38/45 | 84.44% |
| `src/surfaces/cli-entry.vibe` | 8/8 | 8/8 | 100.00% |
| `src/surfaces/cli.vibe` | 16/16 | 16/16 | 100.00% |
| `src/surfaces/commandDecision.vibe` | 9/9 | 9/9 | 100.00% |
| `src/surfaces/commands.vibe` | 124/168 | 124/168 | 73.81% |
| `src/surfaces/manifest.vibe` | 4/4 | 4/4 | 100.00% |
| `src/surfaces/mcp-entry.vibe` | 6/6 | 6/6 | 100.00% |
| `src/surfaces/mcp.vibe` | 17/17 | 17/17 | 100.00% |
| `src/surfaces/session.vibe` | 63/63 | 63/63 | 100.00% |
| `src/surfaces/sessionFlow.vibe` | 28/29 | 28/29 | 96.55% |
| `src/surfaces/signin.vibe` | 49/107 | 49/107 | 45.79% |
| `src/web/actionModel.vibe` | 15/15 | 15/15 | 100.00% |
| `src/web/actionView.vibe` | 25/30 | 27/30 | 90.00% |
| `src/web/backend.vibe` | 33/73 | 59/73 | 80.82% |
| `src/web/entry.vibe` | 0/8 | 8/8 | 100.00% |
| `src/web/historyApp.vibe` | 132/156 | 139/156 | 89.10% |
| `src/web/historyBackend.vibe` | 0/26 | 16/26 | 61.54% |
| `src/web/historyStartup.vibe` | 0/32 | 33/33 | 100.00% |
| `src/web/historyView.vibe` | 64/73 | 64/73 | 87.67% |
| `src/web/issues.vibe` | 43/49 | 43/49 | 87.76% |
| `src/web/issuesView.vibe` | 63/78 | 63/78 | 80.77% |
| `src/web/main.vibe` | 424/636 | 554/636 | 87.11% |
| `src/web/markdown.vibe` | 94/103 | 101/103 | 98.06% |
| `src/web/media.vibe` | 6/6 | 6/6 | 100.00% |
| `src/web/modeSwitch.vibe` | 2/2 | 2/2 | 100.00% |
| `src/web/modelDecision.vibe` | 39/54 | 43/54 | 79.63% |
| `src/web/roleView.vibe` | 17/24 | 18/24 | 75.00% |
| `src/web/sandboxView.vibe` | 14/17 | 15/17 | 88.24% |
| `src/web/screenDecision.vibe` | 38/41 | 38/41 | 92.68% |
| `src/web/startup.vibe` | 46/50 | 50/50 | 100.00% |
| `src/web/startupDecision.vibe` | 9/9 | 9/9 | 100.00% |
| `src/web/styles.vibe` | 1/1 | 1/1 | 100.00% |
| `src/web/theatre.vibe` | 4/45 | 32/45 | 71.11% |
| `src/web/theatreDecision.vibe` | 18/18 | 18/18 | 100.00% |
| `src/web/view.vibe` | 48/51 | 48/51 | 94.12% |
| `src/web/viewDecision.vibe` | 22/22 | 22/22 | 100.00% |
| `src/web/viewport.vibe` | 16/48 | 46/48 | 95.83% |
| `src/web/wikiView.vibe` | 26/28 | 26/28 | 92.86% |
| `worker/Accounts.vibe` | 15/235 | 159/235 | 67.66% |
| `worker/ActionDirectory.vibe` | 26/36 | 34/36 | 94.44% |
| `worker/ActionIdentity.vibe` | 4/14 | 10/14 | 71.43% |
| `worker/ActionRuns.vibe` | 95/117 | 102/117 | 87.18% |
| `worker/ActionsHttp.vibe` | 3/41 | 40/41 | 97.56% |
| `worker/AgentModel.vibe` | 9/9 | 9/9 | 100.00% |
| `worker/Api.vibe` | 44/229 | 44/229 | 19.21% |
| `worker/Budget.vibe` | 20/22 | 20/22 | 90.91% |
| `worker/HistoryActions.vibe` | 17/33 | 18/33 | 54.55% |
| `worker/HistoryObject.vibe` | 6/60 | 44/60 | 73.33% |
| `worker/HistoryTools.vibe` | 8/8 | 8/8 | 100.00% |
| `worker/Http.vibe` | 65/93 | 77/93 | 82.80% |
| `worker/IssueCredentials.vibe` | 1/16 | 13/16 | 81.25% |
| `worker/Issues.vibe` | 148/271 | 153/271 | 56.46% |
| `worker/MainLog.vibe` | 29/43 | 29/43 | 67.44% |
| `worker/ObjectStorage.vibe` | 10/10 | 10/10 | 100.00% |
| `worker/Objects.vibe` | 61/107 | 88/107 | 82.24% |
| `worker/Reply.vibe` | 87/136 | 121/136 | 88.97% |
| `worker/SandboxAccounts.vibe` | 6/60 | 6/60 | 10.00% |
| `worker/SandboxHttp.vibe` | 4/30 | 26/30 | 86.67% |
| `worker/SandboxMachine.vibe` | 1/66 | 1/66 | 1.52% |
| `worker/SandboxTools.vibe` | 8/11 | 8/11 | 72.73% |
| `worker/Sandboxes.vibe` | 0/22 | 26/26 | 100.00% |
| `worker/Sequencer.vibe` | 101/118 | 106/118 | 89.83% |
| `worker/SpecificationReviewers.vibe` | 10/31 | 29/31 | 93.55% |
| `worker/Tour.vibe` | 4/5 | 5/5 | 100.00% |
| `worker/Unreachable.vibe` | 1/1 | 1/1 | 100.00% |
| `worker/VipDraft.vibe` | 4/30 | 27/30 | 90.00% |
| `worker/Wiki.vibe` | 97/152 | 98/152 | 64.47% |
| `worker/WikiDraft.vibe` | 4/32 | 29/32 | 90.62% |
| `worker/WikiTools.vibe` | 1/9 | 2/9 | 22.22% |
| `worker/agentContext.vibe` | 1/1 | 1/1 | 100.00% |
| `worker/budgetDecision.vibe` | 4/5 | 5/5 | 100.00% |
| `worker/index.vibe` | 13/13 | 13/13 | 100.00% |
| `worker/liveDispatchDecision.vibe` | 7/7 | 7/7 | 100.00% |
| `worker/replyProgressDecision.vibe` | 17/17 | 17/17 | 100.00% |
| `worker/replyReasons.vibe` | 7/7 | 7/7 | 100.00% |

Largest remaining line gaps:

- `worker/Api.vibe`: 185 uncovered of 229.
- `worker/Issues.vibe`: 118 uncovered of 271.
- `src/web/main.vibe`: 82 uncovered of 636.
- `worker/Accounts.vibe`: 76 uncovered of 235.
- `worker/SandboxMachine.vibe`: 65 uncovered of 66.
- `src/surfaces/signin.vibe`: 58 uncovered of 107.
- `worker/SandboxAccounts.vibe`: 54 uncovered of 60.
- `worker/Wiki.vibe`: 54 uncovered of 152.
- `src/surfaces/commands.vibe`: 44 uncovered of 168.
- `src/core/sandboxHost.vibe`: 34 uncovered of 181.
- `src/core/flows.vibe`: 20 uncovered of 165.
- `worker/Objects.vibe`: 19 uncovered of 107.
- `src/core/MockFactory.vibe`: 18 uncovered of 254.
- `src/web/historyApp.vibe`: 17 uncovered of 156.
- `worker/HistoryObject.vibe`: 16 uncovered of 60.

### Earlier corrected local timing roster before hosted broker

This table comes only from the complete passing timing window, using explicit sync/async registration. Each row includes assertion cost. Shared nyc-01 host, JIT, GC and OS caches are uncontrolled. Milliseconds are client-observed work, not a server CPU profile. The method and limitations for every artifact follow the table. No instrumented measurement appears here.

| Artifact group / workload | Mean ms | Samples |
| --- | ---: | ---: |
| `accounts-lifecycle/accounts-lifecycle` | 20.276797 | 3 |
| `accounts-transport/accounts-transport-faults` | 5.449684 | 19 |
| `accounts-workerd/workerd-account-session-grants` | 299.605957 | 3 |
| `accounts-workerd-faults/0/workerd-account-disabled` | 9.035441 | 3 |
| `accounts-workerd-faults/1/workerd-account-exchange-failure` | 208.031823 | 3 |
| `action-catalog/action-catalog` | 2.365845 | 43 |
| `action-host/action-host-recovery` | 336.079811 | 3 |
| `action-host-role-downgrade/action-host-role-downgrade` | 102.925573 | 3 |
| `action-kernels/action-kernels` | 0.188163 | 532 |
| `action-prepare/action-prepare` | 0.227689 | 440 |
| `action-tools/action-tools` | 8.915104 | 3 |
| `actions-view-matrix/actions-view-matrix` | 5.263302 | 19 |
| `agent-projection/agent-projection` | 0.082422 | 1214 |
| `budget/budget` | 0.384810 | 260 |
| `cli/0/--mock read --json` | 2302.439977 | 3 |
| `cli/1/--mock ask install --json` | 2612.208517 | 3 |
| `cli/2/--llms` | 2504.585669 | 3 |
| `cli/3/--help` | 2701.745527 | 3 |
| `commands/0/mock-agent-ask` | 285.581093 | 3 |
| `commands/1/read-command` | 0.301466 | 332 |
| `content-workerd/content-workerd` | 15382.898263 | 3 |
| `context-command-policies/context-and-command-decisions` | 0.135814 | 737 |
| `core-10/0/decide` | 0.007355 | 13597 |
| `core-10/1/apply` | 0.013391 | 7468 |
| `core-10/2/receive` | 0.010732 | 9319 |
| `core-10/3/replay-apply` | 0.017615 | 5678 |
| `core-10/4/replay-receive` | 0.014330 | 6986 |
| `core-1000/0/decide` | 0.015876 | 6299 |
| `core-1000/1/apply` | 0.040919 | 2444 |
| `core-1000/2/receive` | 0.031878 | 3137 |
| `core-1000/3/replay-apply` | 0.107655 | 929 |
| `core-1000/4/replay-receive` | 0.099263 | 1008 |
| `core-100000/0/decide` | 0.729288 | 138 |
| `core-100000/1/apply` | 1.656289 | 62 |
| `core-100000/2/receive` | 1.332960 | 77 |
| `core-100000/3/replay-apply` | 8.578769 | 12 |
| `core-100000/4/replay-receive` | 9.333421 | 11 |
| `dispatcher-decisions/dispatcher-decisions` | 0.372020 | 269 |
| `drafts-workerd/drafts-workerd` | 12777.682770 | 3 |
| `factory-gates/factory-gates` | 0.091500 | 1093 |
| `failure-views/failure-views` | 12.045059 | 9 |
| `history-10/0/history-decide` | 0.007011 | 14264 |
| `history-10/1/history-apply` | 0.033467 | 2989 |
| `history-10/2/history-decode` | 0.072210 | 1385 |
| `history-1000/0/history-decide` | 0.015384 | 6501 |
| `history-1000/1/history-apply` | 0.045318 | 2207 |
| `history-1000/2/history-decode` | 5.712721 | 18 |
| `history-100000/0/history-decide` | 1.394740 | 72 |
| `history-100000/1/history-apply` | 4.426012 | 23 |
| `history-100000/2/history-decode` | 505.585209 | 5 |
| `history-actions/history-actions` | 0.330255 | 303 |
| `history-bootstrap/history-bootstrap-graph` | 0.201756 | 496 |
| `history-browser-actions/history-first-render` | 511.210837 | 1 |
| `history-browser-actions/history-expand-epic` | 68.713168 | 1 |
| `history-browser-actions/history-next-page` | 79.568432 | 1 |
| `history-browser-actions/history-open-commit` | 83.361654 | 1 |
| `history-browser-actions/history-amend-and-escape` | 65.933241 | 1 |
| `history-browser-actions/history-amend-submit` | 133.035684 | 1 |
| `history-browser-actions/history-insert-before` | 126.873835 | 1 |
| `history-browser-actions/history-filter-keystroke` | 130.447547 | 1 |
| `history-browser-actions/history-plan` | 202.918055 | 1 |
| `history-browser-actions/history-start` | 58.279893 | 1 |
| `history-browser-actions/history-add-note` | 60.345626 | 1 |
| `history-browser-actions/history-approve` | 48.736248 | 1 |
| `history-browser-actions/history-fold` | 306.760351 | 1 |
| `history-browser-actions/history-viewer-controls` | 452.259982 | 1 |
| `history-browser-command-faults/history-browser-command-faults` | 2.045012 | 3 |
| `history-browser-commands/history-browser-commands` | 19.890199 | 3 |
| `history-catalog/history-catalog-calls` | 10.322747 | 3 |
| `history-flow-policies/history-flow-ordering` | 4.168330 | 25 |
| `history-flows/history-plan-start-note-approve-fold` | 19.554922 | 3 |
| `history-malformed-replay/history-malformed-replay` | 0.129968 | 770 |
| `history-page-boundaries/history-page-boundaries` | 0.215814 | 464 |
| `history-pages-10/0/history-outline` | 0.020922 | 4780 |
| `history-pages-10/1/history-epic-pages` | 0.024406 | 4098 |
| `history-pages-10/2/history-commit-page` | 0.008752 | 11427 |
| `history-pages-10/3/history-search` | 0.023908 | 4183 |
| `history-pages-10/4/history-page-codecs` | 0.097323 | 1028 |
| `history-pages-1000/0/history-outline` | 0.098752 | 1013 |
| `history-pages-1000/1/history-epic-pages` | 0.103649 | 965 |
| `history-pages-1000/2/history-commit-page` | 0.043642 | 2292 |
| `history-pages-1000/3/history-search` | 0.370684 | 270 |
| `history-pages-1000/4/history-page-codecs` | 7.497737 | 14 |
| `history-pages-100000/0/history-outline` | 29.281980 | 5 |
| `history-pages-100000/1/history-epic-pages` | 9.884880 | 11 |
| `history-pages-100000/2/history-commit-page` | 2.682763 | 38 |
| `history-pages-100000/3/history-search` | 27.401209 | 5 |
| `history-pages-100000/4/history-page-codecs` | 407.619337 | 5 |
| `history-recovery/history-retelling-recovery` | 0.792235 | 127 |
| `history-roles/history-role-matrix` | 0.066346 | 1508 |
| `history-seed/history-seed-decode` | 253.227826 | 3 |
| `history-surfaces/0/cli-history` | 3161.480280 | 3 |
| `history-surfaces/1/cli-plan` | 3718.086024 | 3 |
| `history-surfaces/2/mcp-history-plan-start-note` | 38.726176 | 3 |
| `history-tools/0/history-tool-lifecycle` | 20.588819 | 3 |
| `history-tools/1/history-tool-faults` | 0.263504 | 380 |
| `history-view-matrix/history-view-matrix` | 28.083612 | 5 |
| `history-web-10/0/history-filter-keystroke` | 0.027050 | 3697 |
| `history-web-10/1/history-open-epic-view` | 14.991327 | 3 |
| `history-web-1000/0/history-filter-keystroke` | 0.025407 | 4046 |
| `history-web-1000/1/history-open-epic-view` | 74.763920 | 3 |
| `history-web-1000/2/history-next-page-update` | 0.082748 | 1209 |
| `history-web-100000/0/history-filter-keystroke` | 0.026450 | 3781 |
| `history-web-100000/1/history-open-epic-view` | 7922.278062 | 3 |
| `history-web-100000/2/history-next-page-update` | 0.084500 | 1184 |
| `history-workerd/0/history-first-outline` | 323.756358 | 1 |
| `history-workerd/1/history-warm-outline` | 11.914053 | 3 |
| `history-workerd/2/history-detail-pages` | 31.974585 | 3 |
| `history-workerd/3/history-viewer-refusals` | 306.200132 | 3 |
| `history-workerd/4/history-protocol-errors` | 9.759614 | 3 |
| `history-workerd/5/history-keyed-call-replay` | 193.681327 | 3 |
| `http/http-boundaries` | 5.332380 | 19 |
| `identity-cli/cli-identity-journey` | 8949.017183 | 3 |
| `identity-labels/identity-labels` | 0.011846 | 8442 |
| `identity-mcp/mcp-identity-journey` | 679.117532 | 3 |
| `issues-commands/0/issues-read` | 7.086488 | 3 |
| `issues-commands/1/issues-new` | 5.771889 | 3 |
| `issues-commands/2/issues-comment` | 5.236865 | 3 |
| `issues-commands/3/issues-link` | 5.497157 | 3 |
| `issues-commands/4/issues-split` | 4.991217 | 3 |
| `issues-commands/5/issues-commit` | 5.595841 | 3 |
| `issues-commands/6/issues-uncommit` | 4.935632 | 3 |
| `issues-commands/7/issues-propose` | 5.523388 | 3 |
| `issues-commands/8/issues-accept` | 4.815843 | 3 |
| `issues-commands/9/issues-decline` | 4.685544 | 3 |
| `issues-commands/10/issues-draft` | 5.033839 | 3 |
| `issues-flows/issue-flow-journey` | 61.579002 | 3 |
| `issues-host-journey/issues-host-journey` | 632.055684 | 3 |
| `issues-host-recovery/issues-host-recovery` | 1291.115845 | 3 |
| `issues-identities/issue-identities` | 0.256806 | 390 |
| `issues-policy/issue-policy-corpus` | 0.579746 | 173 |
| `issues-reducer/issues-reducer` | 0.207179 | 483 |
| `issues-refusals/issue-refusals` | 26.454951 | 3 |
| `issues-view-matrix/issues-view-matrix` | 35.416612 | 5 |
| `local-browser/commandKMs` | 73.194713 | 3 |
| `local-browser/firstRenderMs` | 266.465455 | 3 |
| `local-browser/keystrokeMs` | 42.635192 | 3 |
| `local-browser-actions/hero-ready-frame` | 75.369182 | 1 |
| `local-browser-actions/hero-native-pause` | 18.275922 | 1 |
| `local-browser-actions/hero-native-play` | 10.560911 | 1 |
| `local-browser-actions/ask-button` | 67.676632 | 1 |
| `local-browser-actions/submit-settle-0` | 894.924082 | 1 |
| `local-browser-actions/submit-settle-1` | 819.683084 | 1 |
| `local-browser-actions/submit-settle-2` | 845.311070 | 1 |
| `local-browser-actions/submit-settle-3` | 840.213416 | 1 |
| `local-browser-actions/wheel-pause` | 40.080655 | 1 |
| `local-browser-actions/latest` | 66.649535 | 1 |
| `local-browser-actions/pause-Home` | 108.163474 | 1 |
| `local-browser-actions/pause-PageUp` | 104.072638 | 1 |
| `local-browser-actions/pause-ArrowUp` | 115.792842 | 1 |
| `local-browser-actions/pause-Control+Home` | 127.171820 | 1 |
| `local-browser-actions/pause-Meta+ArrowUp` | 132.737533 | 1 |
| `local-browser-actions/new-input-cancels-latest` | 328.547908 | 1 |
| `local-browser-actions/touch-pause` | 91.758688 | 1 |
| `local-browser-actions/actions-open` | 130.213118 | 1 |
| `local-browser-actions/actions-run-and-trace` | 362.215081 | 1 |
| `local-browser-actions/actions-cancel` | 51.619811 | 1 |
| `local-browser-actions/actions-rerun` | 121.807765 | 1 |
| `local-browser-actions/actions-escape-collapse` | 64.285627 | 1 |
| `local-browser-actions/home-expand-minimize` | 803.349643 | 1 |
| `local-browser-actions/learn-more` | 712.225132 | 1 |
| `local-browser-actions/tour-pause` | 88.992201 | 1 |
| `local-browser-actions/tour-resume` | 59.553791 | 1 |
| `local-browser-actions/tour-skip-2` | 89.676712 | 1 |
| `local-browser-actions/tour-skip-3` | 593.887455 | 1 |
| `local-browser-actions/tour-skip-4` | 574.812304 | 1 |
| `local-browser-actions/tour-skip-5` | 88.451936 | 1 |
| `local-browser-actions/tour-skip-6` | 87.899901 | 1 |
| `local-browser-actions/escape-tour` | 28.861343 | 1 |
| `local-browser-actions/wiki-maximize` | 1134.787762 | 1 |
| `local-browser-actions/wiki-minimize` | 62.745845 | 1 |
| `local-browser-actions/escape-wiki` | 19.426024 | 1 |
| `local-role-actions/role-view-viewer` | 73.248833 | 1 |
| `local-role-actions/role-view-new` | 1357.619796 | 1 |
| `local-role-actions/role-view-community` | 170.151271 | 1 |
| `local-role-actions/role-view-contributor` | 168.305637 | 1 |
| `local-role-actions/role-view-maintainer` | 199.382221 | 1 |
| `local-role-actions/account-menu-keyboard` | 133.668001 | 1 |
| `local-role-actions/promote-member` | 121.739008 | 1 |
| `local-role-actions/cancel-role-change` | 91.883960 | 1 |
| `local-role-actions/escape-role-dialog` | 75.041524 | 1 |
| `local-role-actions/demote-member` | 127.387906 | 1 |
| `local-role-actions/restore-member` | 112.938857 | 1 |
| `local-role-actions/sign-out` | 136.259879 | 1 |
| `local-role-actions/mock-sign-in` | 30.321159 | 1 |
| `local-role-actions/participation-promotes-community` | 493.443138 | 1 |
| `local-role-actions/retry-mock-sign-in` | 146.183799 | 1 |
| `local-wiki-actions/wiki-edit-maintainer` | 113.216979 | 1 |
| `local-wiki-actions/wiki-save` | 126.102156 | 1 |
| `local-wiki-actions/wiki-escape-maintainer` | 63.780951 | 1 |
| `local-wiki-actions/wiki-edit-contributor` | 87.097192 | 1 |
| `local-wiki-actions/wiki-propose` | 97.009073 | 1 |
| `local-wiki-actions/wiki-escape-contributor` | 100.936451 | 1 |
| `local-wiki-actions/wiki-role-change-closes-editor` | 47.391836 | 1 |
| `local-wiki-actions/wiki-agent-draft-review` | 1137.374660 | 1 |
| `local-wiki-actions/wiki-agent-draft-propose` | 75.599718 | 1 |
| `machine-boundaries/machine-boundaries` | 0.299020 | 335 |
| `main-reducer-boundaries/main-reducer-boundaries` | 0.265990 | 376 |
| `maintenance-scripts/0/mythical-seed-write` | 384.747285 | 3 |
| `maintenance-scripts/1/mythical-seed-deterministic` | 347.273473 | 3 |
| `maintenance-scripts/2/mythical-seed-read-failures` | 545.435767 | 3 |
| `maintenance-scripts/3/agent-context-write` | 478.720727 | 3 |
| `maintenance-scripts/4/agent-context-check` | 245.930559 | 3 |
| `maintenance-scripts/5/agent-context-stale` | 246.109193 | 3 |
| `markdown/markdown-blocks` | 0.009125 | 10959 |
| `mcp/0/mcp-read` | 2809.274527 | 3 |
| `mcp/1/mcp-ask` | 3632.918121 | 3 |
| `mcp-warm/mcp-warm-read` | 1.042657 | 96 |
| `media-observe/media-observe` | 0.303463 | 330 |
| `mock-actions/mock-actions` | 33.321610 | 3 |
| `mock-close/mock-factory-close` | 0.487520 | 206 |
| `mock-history-agent/mock-agent-history` | 533.361701 | 3 |
| `mock-scripts/mock-scripts` | 0.123593 | 810 |
| `mock-tour/0/mock-tour-complete` | 134466.164835 | 1 |
| `mock-tour/1/mock-tour-end` | 9.976499 | 3 |
| `model-config/model-config` | 0.544418 | 184 |
| `model-context-10/model-context-select-and-window` | 0.046215 | 2164 |
| `model-context-1000/model-context-select-and-window` | 1.506965 | 67 |
| `model-context-100000/model-context-select-and-window` | 153.419402 | 5 |
| `object-cancelled-receipt/object-cancelled-receipt` | 26.294640 | 3 |
| `object-host/object-post-alarm-recovery` | 257.793500 | 3 |
| `policies/flow-and-budget-policies` | 0.154246 | 649 |
| `protocol/0/event-encode` | 0.016109 | 6208 |
| `protocol/1/event-decode` | 0.008682 | 11519 |
| `protocol/2/snapshot-decode-10` | 0.052272 | 1914 |
| `protocol/3/snapshot-decode-1000` | 3.621950 | 28 |
| `protocol/4/snapshot-decode-100000` | 417.410113 | 5 |
| `protocol/5/route-roundtrip` | 0.015937 | 6275 |
| `provider-guards/provider-guards` | 0.538373 | 186 |
| `provider-host-refusals/provider-host-refusals` | 6.742843 | 3 |
| `reply-progress-decisions/reply-progress-decisions` | 0.132884 | 753 |
| `resources/0/resources-dev` | 18.457741 | 3 |
| `resources/1/resources-production` | 7.607642 | 3 |
| `resources/2/resources-factory.example.test` | 6.353759 | 3 |
| `runtime/runtime-startup-post` | 1063.427218 | 3 |
| `sandbox-agent/sandbox-agent-bindings` | 14.811245 | 3 |
| `sandbox-browser-actions/sandbox-open-pane` | 66.712985 | 1 |
| `sandbox-browser-actions/sandbox-start` | 53.477614 | 1 |
| `sandbox-browser-actions/sandbox-terminal-write` | 48.103629 | 1 |
| `sandbox-browser-actions/sandbox-stop` | 62.003071 | 1 |
| `sandbox-browser-actions/sandbox-restart` | 52.995261 | 1 |
| `sandbox-browser-actions/sandbox-read-retained-bytes` | 143.402276 | 1 |
| `sandbox-browser-actions/sandbox-maximize` | 63.670727 | 1 |
| `sandbox-browser-actions/sandbox-minimize` | 66.794150 | 1 |
| `sandbox-browser-actions/sandbox-escape` | 7.283831 | 1 |
| `sandbox-browser-actions/sandbox-viewer-controls` | 1360.735584 | 1 |
| `sandbox-factory-1/sandbox-file-restart` | 26.661607 | 3 |
| `sandbox-factory-100/sandbox-file-restart` | 385.451831 | 3 |
| `sandbox-meter/sandbox-meter-and-policy` | 0.371022 | 270 |
| `sandbox-public-workerd/workerd-sandbox-viewer` | 17.457544 | 3 |
| `sandbox-surfaces/0/cli-sandboxes` | 3481.970758 | 3 |
| `sandbox-surfaces/1/cli-sandbox-start` | 2715.759002 | 3 |
| `sandbox-surfaces/2/mcp-sandbox-file-restart` | 53.003050 | 3 |
| `screen-protocol-policies/screen-protocol-mock-policies` | 0.368182 | 272 |
| `sequencer/sequencer-lifecycle` | 0.994990 | 101 |
| `session-live-refusals/session-live-refusals` | 415.489906 | 3 |
| `session-runtime/session-runtime` | 288.577247 | 3 |
| `session-settings/session-settings` | 12.703441 | 3 |
| `session-settings-faults/session-settings-faults` | 3.396836 | 3 |
| `shared-decisions/0/shared-decisions` | 0.288902 | 347 |
| `shared-decisions/1/mythical-lookups` | 0.048889 | 2046 |
| `shared-decisions/2/sandbox-policy-layers` | 0.022164 | 4512 |
| `site/site-routing` | 40.657247 | 3 |
| `specification/specification-review-journey` | 48.882217 | 3 |
| `startup-theatre-decisions/startup-theatre-decisions` | 0.182110 | 550 |
| `surface-failures/0/cli-failure---mock ask  ` | 2556.727096 | 3 |
| `surface-failures/1/cli-failure---mock read --after -1` | 2146.821020 | 3 |
| `surface-failures/2/cli-failure---wat` | 1982.324735 | 3 |
| `surface-failures/3/cli-failure-read` | 2113.979223 | 3 |
| `surface-failures/4/mcp-unreachable` | 2099.049058 | 3 |
| `transport/transport-fault-matrix` | 23.612046 | 5 |
| `walkthrough-controls/walkthrough-controls` | 0.629667 | 159 |
| `web-10/0/keystroke-update` | 0.007993 | 12511 |
| `web-10/1/incoming-event-update` | 0.008358 | 11965 |
| `web-10/2/view` | 7.602035 | 3 |
| `web-1000/0/keystroke-update` | 0.014618 | 6842 |
| `web-1000/1/incoming-event-update` | 0.034538 | 2896 |
| `web-1000/2/view` | 66.528383 | 3 |
| `web-100000/0/keystroke-update` | 0.008113 | 12327 |
| `web-100000/1/incoming-event-update` | 1.644159 | 61 |
| `web-100000/2/view` | 3118.105623 | 3 |
| `web-account-state/web-account-state` | 0.301946 | 332 |
| `web-actions/web-actions` | 5.304522 | 19 |
| `web-content-commands/web-content-commands` | 48.317272 | 3 |
| `web-execution-commands/web-execution-commands` | 37.038379 | 3 |
| `web-issue-state/web-issue-state` | 2.429946 | 42 |
| `web-wiki-state/web-wiki-state` | 0.179369 | 558 |
| `wiki-cli/0/cli-wiki-read` | 2096.531156 | 3 |
| `wiki-cli/1/cli-wiki-draft` | 2115.163474 | 3 |
| `wiki-cli/2/cli-wiki-save` | 1965.828771 | 3 |
| `wiki-cli/3/cli-wiki-propose` | 2162.802644 | 3 |
| `wiki-edit-journeys/wiki-edit-journeys` | 33.506964 | 3 |
| `wiki-host-journey/wiki-host-journey` | 504.329151 | 3 |
| `wiki-host-recovery/wiki-host-recovery` | 1267.184223 | 3 |
| `wiki-mcp/0/mcp-wiki-read-readback` | 14.820870 | 3 |
| `wiki-mcp/1/mcp-wiki-draft-readback` | 5.891932 | 3 |
| `wiki-mcp/2/mcp-wiki-save-readback` | 6.578866 | 3 |
| `wiki-mcp/3/mcp-wiki-propose-readback` | 6.218453 | 3 |
| `wiki-script/wiki-script-journey` | 947.119882 | 3 |
| `wiki-view-matrix/wiki-view-matrix` | 14.354015 | 7 |
| `workerd/0/workerd-post-reply-read` | 440.307961 | 3 |
| `workerd/1/workerd-tour` | 136208.505970 | 3 |
| `workerd-actions (withdrawn)/workerd-actions (withdrawn)` | — | — |
| `workerd-sandboxes/0/workerd-sandbox-ledger` | 603.009439 | 3 |
| `workerd-sandboxes/1/workerd-sandbox-meter` | 246.790666 | 3 |
| `workerd-sandboxes/2/workerd-sandbox-public` | 7.972689 | 3 |

Deterministic gate: complete roster of indexed entry reads, `ceil(baseline × 1.05)` tolerance; zero stays zero. It does not gate noisy latency or detect uninstrumented work. Two real-runner controls additionally check exact callback counts and serial execution; they emit no latency artifact. Chromium first-render/Command-K/keystroke rows summarize three raw wall-time samples; individual action rows are single observations, not distributions.

**accounts-lifecycle** — `2026-11-09T14-01-59.049Z-accounts-lifecycle.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:59.049Z`. Vitest built-in bench; actual product MockAccounts, policy and durable role-grant engine. Verify literal five-person fixture, once-only participation, duplicate no-op grant, promotions/demotions, final-maintainer/self-promotion refusals, complete five-event replay, identity schema round trip and sign-out. Three new scoped engines; initialization/assertions included. Limitations: Product fixture identity, not GitHub OAuth, production session cryptography or remote storage. One callback is the complete lifecycle, not a per-command latency.

**accounts-transport** — `2026-11-09T14-01-59.282Z-accounts-transport.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:59.282Z`. Vitest built-in bench; actual LiveAccounts adapter with an injected faulty Effect HttpClient. Seven operations across transport loss, forbidden/unavailable statuses, malformed JSON/protocol/SSE and bodyless 204; exact success/failure tags and bounded typed errors checked. Limitations: No request interception or real network. Invalid upstream answers measure failure handling, not GitHub sign-in success or WAN latency.

**accounts-workerd** — `2026-11-09T13-58-09.299Z-accounts-workerd.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:58:09.299Z`. Vitest built-in bench; real production account service, cookie signatures, SQLite sessions, durable role grants and current sandbox authority in local workerd. Each of three samples uses fresh signed/expired fixture sessions and a unique person; check tamper/expiry, self-promotion refusal, maintainer grant, current role, cross-origin refusal/unchanged state, People and session revocation. Host startup excluded; requests/assertions included. Limitations: Only the unshipped test host issues fixture sessions with real signatures. This does not benchmark successful GitHub OAuth/consent, provider latency or production credentials. No cookie/token values enter artifacts; all configuration is synthetic.

**accounts-workerd-faults** — `2026-11-09T13-58-12.521Z-accounts-workerd-faults.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:58:12.521Z`. Vitest built-in bench; actual account configuration/router and journaled sign-in/callback flows in local workerd. Three samples each: missing configuration stays viewer/503; configured PKCE redirect then an injected faulty Effect GitHub exchange, visible failure redirect, consumed state and refused replay, cleared state cookie and no session cookie issued. Redirect following disabled. Startup excluded; crypto/storage/requests/assertions included. Limitations: The production GitHub service is replaced only by the existing host's explicit failing Effect service. No request interception, GitHub request, real login or successful provider exchange. Synthetic secrets/cookies remain in memory and are omitted from artifacts.

**action-catalog** — `2026-11-09T14-01-31.152Z-action-catalog.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:31.152Z`. Vitest built-in bench; every bundled flow declaration's presentation, command, minimum role and input kind, with the shared mayRun gate evaluated for all five roles per entry. Limitations: Presentation/policy cost only; a run's durable execution is benchmarked through the mock and workerd action surfaces.

**action-host** — `2026-11-09T14-01-23.699Z-action-host.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:23.699Z`. Vitest built-in bench; actual production action index/per-run hosts with real SQLite and product MockAccounts/Mythical services. Check once-only post acceptance, changed-input conflict, correlated terminal Post/Reply traces after two alarms, and cancelling a queued Plan before admission without any history mutation. Three new scoped worlds, migrations and assertions included. Limitations: Node SQLite/KV/alarm adapter, no workerd scheduling or remote storage. Deliberately unconfigured model fails the reply; no inference or GitHub mutation. The product mock provides local accounts/history.

**action-host-role-downgrade** — `2026-11-09T14-01-24.134Z-action-host-role-downgrade.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:24.134Z`. Vitest built-in bench; accept a real SQLite-backed history action, revoke its owner's role through product account flows, drive two alarms, then compare the terminal permission refusal and unchanged empty history. Three fresh worlds, setup and assertions included. Limitations: Product mock identities, no OAuth/provider call. Node SQLite/alarm host; measures admission/recovery overhead without a model.

**action-kernels** — `2026-11-09T14-01-30.903Z-action-kernels.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:30.903Z`. Vitest built-in bench; run snapshot/step acceptance orderings, terminal settle and cancellation, engine upsert identity and replay, pending acknowledgement identity, and VIP document authorship/path truth tables. Assertions included. Limitations: Pure in-process decisions; the durable action surface runs in the workerd benchmark.

**action-prepare** — `2026-11-09T14-01-31.381Z-action-prepare.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:31.381Z`. Vitest built-in bench; every invocation kind's schema preparation with client/operation identity defaults, then not-found and invalid-input failures as typed ActionFailures. Limitations: In-process preparation; the dispatch into durable engines is benchmarked through the mock and workerd action surfaces.

**action-tools** — `2026-11-09T14-01-31.713Z-action-tools.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:31.713Z`. Vitest built-in bench; all four actual action FlowBinding handlers invoked with real harness call identities and declaration digests over the product mock actions service; start announces its first run snapshot, read returns it and cancel acknowledges. Limitations: Binding/handler boundary without model selection or QuickJS; the same declarations serve CLI and MCP surfaces.

**actions-view-matrix** — `2026-11-09T14-01-29.149Z-actions-view-matrix.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:29.149Z`. Vitest built-in bench; Foldkit scenes render the actions pane collapsed with its latest badge, open and empty, the failed-run trace, per-selection run control and maximized state; merge/selection/completion decisions checked against slower or terminal snapshots. Limitations: Scene rendering and pure decisions; live runs stream through the mock and workerd action benchmarks.

**agent-projection** — `2026-11-09T14-01-50.228Z-agent-projection.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:50.228Z`. Vitest built-in bench; project partial cell answers, restart, sum token usage, bound input history and classify provider failures without disclosing messages. Limitations: Projection and policy only; actual agent and QuickJS cell execution measured in workerd.

**budget** — `2026-11-09T14-01-56.644Z-budget.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:56.644Z`. Vitest built-in bench; real budget over in-memory ledger; rounding/clamping, duplicate spend, admission at limit and exact ledger asserted. Limitations: In-process ledger; remote Durable Object transport excluded.

**cli** — `2026-11-09T13-50-20.295Z-cli.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:50:20.295Z`. Vitest built-in bench; spawn emitted CLI to exit with stdout/stderr capture; three samples per command, no warmup. Build excluded; loader/process startup included. Limitations: Mock backend for ask/read; no network/model. Source package loading contributes to startup.

**commands** — `2026-11-09T13-49-49.781Z-commands.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:49:49.781Z`. Vitest built-in bench; new scoped MockFactory/engine per call. Ask includes real scripted delays and settled answer; Read includes schema validation and layer lifecycle. Limitations: Product mock mode; no backend/model. Ask timing includes intentional 25ms per scripted chunk.

**content-workerd** — `2026-11-09T13-56-51.860Z-content-workerd.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:56:51.860Z`. Vitest built-in bench; each of three unwarmed samples starts fresh real workerd issue and wiki hosts. HTTP/SQLite commitments replay once; credentials are encrypted/session-bound/current-role/expiring; paid failed drafts charge once; partial write retryFrom adopts exactly one original child. Wiki draft privacy, contributor proposal/replay, forbidden Save, unchanged Markdown and one completed proposal journal row checked. Bundling, server lifecycle and assertions included. Limitations: Existing unshipped host supplies product fixture identities/repository; typed faulty Effect services exercise paid failures and partial recovery. No real GitHub write, OAuth or Container. Whole fresh-host corpus cost includes bundling and startup; it is not per-request latency or model inference.

**context-command-policies** — `2026-11-09T14-01-38.503Z-context-command-policies.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:38.503Z`. Vitest built-in bench; prompt eligibility, first duplicate identity, source-order indexes/windowing and correlated CLI/MCP collection through unrelated events, restart, finish/failure. Complete expected selections, answer fields/event numbers and outcome/error precedence checked. Limitations: Small in-process decision corpus, no model/IPC or service execution. Assertions included; large transcript cost is measured separately.

**core-10** — `2026-11-09T14-00-37.253Z-core-10.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:37.253Z`. Vitest built-in bench; 10 completed posts for single transitions; replay has exactly 10 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**core-1000** — `2026-11-09T14-00-38.072Z-core-1000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:38.072Z`. Vitest built-in bench; 1000 completed posts for single transitions; replay has exactly 1000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**core-100000** — `2026-11-09T14-00-38.868Z-core-100000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:38.868Z`. Vitest built-in bench; 100000 completed posts for single transitions; replay has exactly 100000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**dispatcher-decisions** — `2026-11-09T14-01-44.515Z-dispatcher-decisions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:44.515Z`. Vitest built-in bench; all eight storage-mark combinations for three ordered posts, exact independently listed first candidate, single attempted start/refusal and terminal no-op, plus empty queue. Assertions included. Limitations: Pure dispatcher decisions only; storage probes and durable starts are measured in object-host/workerd workloads.

**drafts-workerd** — `2026-11-09T13-56-04.591Z-drafts-workerd.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:56:04.591Z`. Vitest built-in bench; three fresh native workerd worlds run production VIP draft, wiki draft and specification reviewer AgentActions, SDK model HTTP/SSE, QuickJS and SQLite over one deterministic local model service. Exact schema answers, six metered tokens, three HTTP model calls and cached replay with no further call checked. Bundling/startup/assertions included. Limitations: Deterministic model responses measure flow/agent overhead without inference or WAN. No GitHub write, OAuth, Container or real provider spending. Whole fresh-host corpus is not per-request latency.

**factory-gates** — `2026-11-09T14-02-05.986Z-factory-gates.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:05.986Z`. Both acceptance predicates over the accepted fixture, sixteen single-review refusals, revision reset and person/agent approval; assertions included. Limitations: In-process decisions; excludes model inference, transport and storage.

**failure-views** — `2026-11-09T14-01-54.306Z-failure-views.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:54.306Z`. Vitest built-in bench; render every declared post failure and connection/tour failure with accessible retry/reconnect controls. Limitations: Scenes from state-machine client fixtures; no transport interception.

**gate** — `2026-11-09T14-01-43.641Z-gate.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:43.641Z`. Indexed entry reads through a transparent Proxy on completed-post fixtures of 10/1000/100000 entries. Correctness checked after counter capture. Allowed increase: ceil(baseline * 1.05); zero stays zero; exact roster required. Limitations: Counts entry access, not instruction count, allocations, network or latency; additional uninstrumented work requires timing review.

**history-10** — `2026-11-09T14-00-57.939Z-history-10.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:57.939Z`. Vitest built-in bench; 10 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**history-1000** — `2026-11-09T14-00-58.472Z-history-1000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:58.472Z`. Vitest built-in bench; 1000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**history-100000** — `2026-11-09T14-01-02.672Z-history-100000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:02.672Z`. Vitest built-in bench; 100000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**history-actions** — `2026-11-09T13-58-39.864Z-history-actions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:58:39.864Z`. Vitest built-in bench; history reducer corpus for page/read responses, forms, navigation/write intents, success/refusal, retries, late/detached data and events. Independent field, command-count and identity assertions; real commands execute in Chromium separately. Limitations: Reducer/command construction cost, no network or durable execution. Pages are actual projections of a two-commit fixture.

**history-bootstrap** — `2026-11-09T14-02-11.389Z-history-bootstrap.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:11.389Z`. Vitest built-in bench; three-commit first-parent/merge graph with rejected and landed queue entries; exact first-parent incremental order/cursor handling, bucket order/mapping, evidence, complete bootstrap and lossless seed projection/replay checked. Limitations: Small deterministic real-commit fixture; actual large committed snapshot decode measured separately; no GitHub call or repository mutation.

**history-browser-actions** — `2026-11-09T13-55-12.513Z-history-browser-actions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:55:12.513Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial Chromium journey over the full committed history and real MockMythical durable flows. Bootstrap, scripted work and automation included; no percentile. Fold changes only the product mock, never a real repository. Viewer UI omits writes; live writes are benchmarked as actual workerd refusals.

**history-browser-command-faults** — `2026-11-09T14-02-12.541Z-history-browser-command-faults.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:12.541Z`. Vitest built-in bench; typed faulty Effect Mythical service, four browser reads and five writes under both permission and transport failures. All exact message/reason projections and redaction checked. Three full corpora, setup/assertions included. Limitations: Deliberate service failures, no request interception or successful provider simulation; no network, repository writes or model.

**history-browser-commands** — `2026-11-09T14-02-12.438Z-history-browser-commands.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:12.438Z`. Vitest built-in bench; actual History Command effects over MockMythical's memory engine from empty history. Outline, Plan, epic/search, Start/Note/Approve/Fold and commit/missing detail; exact command messages, retained fields, notes, fold SHA and final six-event outline checked. Three fresh scoped engines, assertions included. Limitations: Shipped product mock main, no GitHub mutation, network, OAuth or actual repository fold. Command Effects without browser layout/DOM focus.

**history-catalog** — `2026-11-09T14-01-19.840Z-history-catalog.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:19.840Z`. Vitest built-in bench; real harness call identities/declaration digests invoke all four actual FlowBinding handlers and a populated outline reread after writes, including schema validation and result encoding; fresh product history engine, exact outputs and resulting signed note checked. Three samples. Limitations: No model selection or QuickJS process; this measures the binding/handler boundary directly. Real durable history flows run behind the binding.

**history-flow-policies** — `2026-11-09T14-01-38.266Z-history-flow-policies.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:38.266Z`. Vitest built-in bench; five roles × seven actions × human/agent; independent minimum-role matrix, authorization once, recording forbidden before authorization, single record except repeated fold, and illegal states checked. Limitations: Pure journal/policy decisions; actual durable flows and storage are separate workloads. Assertions included.

**history-flows** — `2026-11-09T14-01-02.826Z-history-flows.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:02.826Z`. Vitest built-in bench; actual MockMythical, sequencer and in-memory durable engine; plan/create epic, start, note, human approval and merge-queue fold; outline/detail composition and complete event replay equality checked. Three fresh engines. Limitations: Explicit human maintainer in a local fixture; product agent permission is measured separately. No real repository write or provider call.

**history-malformed-replay** — `2026-11-09T14-01-51.468Z-history-malformed-replay.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:51.468Z`. Vitest built-in bench; ten invalid event shapes across all seven event kinds, each checked as next, duplicate and gap. Invalid next content advances only the cursor; duplicates/gaps retain the original object and full state. Limitations: Pure replay boundary, deliberately malformed events; not storage transport corruption or authenticated admission.

**history-page-boundaries** — `2026-11-09T14-00-56.475Z-history-page-boundaries.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:56.475Z`. Vitest built-in bench; reversed physical commit array across two epics, notes and three real folds; exact stack order/counts/details, missing/negative cursor behavior, all four valid route/URI round trips, malformed Unicode path refusals and status classes checked. Limitations: Small deterministic projection/protocol corpus; no network or history mutation.

**history-pages-10** — `2026-11-09T14-00-51.489Z-history-pages-10.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:51.489Z`. Vitest built-in bench; 10 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**history-pages-1000** — `2026-11-09T14-00-52.275Z-history-pages-1000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:52.275Z`. Vitest built-in bench; 1000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**history-pages-100000** — `2026-11-09T14-00-56.236Z-history-pages-100000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:56.236Z`. Vitest built-in bench; 100000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**history-recovery** — `2026-11-09T14-01-51.234Z-history-recovery.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:51.234Z`. Vitest built-in bench; bootstrap a landed commit and pending sibling, reopen/amend, insert before sibling, refuse invalid plans, start/note/approve and fold exact trailer. Recreate the real sequencer over the same memory store; compare full independent expected state, every event, replay, schema round trip and duplicate identity. Each callback owns a new store. Limitations: In-memory durable-store contract and sequencer; no SQLite restart, repository write, network or model. Assertions and fresh store construction included.

**history-roles** — `2026-11-09T14-01-03.908Z-history-roles.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:03.908Z`. Vitest built-in bench; all five roles, human and agent; every agent forbidden to approve/fold, every role allowed to read, only human maintainer allowed to approve. Limitations: Pure policy cost; signed-in identity is a separate integration boundary.

**history-seed** — `2026-11-09T14-01-03.675Z-history-seed.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:03.675Z`. Vitest built-in bench; decode the actual committed VibeLang bootstrap projection; validate unique mythical identities, every real-commit mapping and the final main cursor. Three samples; module cached after its first import. Limitations: Snapshot parsing and validation, not a fresh network/GitHub import or bootstrap from an empty durable object.

**history-surfaces** — `2026-11-09T13-51-39.774Z-history-surfaces.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:51:39.774Z`. Vitest built-in bench; emitted CLI history/plan include startup and full committed bootstrap; persistent real MCP plan/start/note/history includes schema/IPC and four flows/calls. Three samples each, no warmup; exact detail, note author and unchanged main checked. Limitations: Product mock history, no repository mutation or model. MCP history grows by one planned commit per sample; handshake/bootstrap excluded from its timing.

**history-tools** — `2026-11-09T14-01-17.840Z-history-tools.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:17.840Z`. Vitest built-in bench; real tool catalog, product MockMythical and durable plan/start/note plus all four paged reads; contributor retell refusal, signed note, missing-input defaults and injected faulty Effect service. Three fresh lifecycle engines; fault handling short-run warmup. Limitations: Tool/flow overhead, no model inference or production storage. No approve/fold binding exists. Actual model choice and calls to these bindings inside QuickJS are not measured here.

**history-view-matrix** — `2026-11-09T14-01-27.980Z-history-view-matrix.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:27.980Z`. Vitest built-in bench; Foldkit scenes render the history list, epic, commit and plan pages across roles, states, filters, errors and dialog variants with exact control presence/absence assertions; refusal wording table included. Limitations: Scene rendering without layout/paint; the same journeys with real events run in Chromium and workerd benchmarks.

**history-web-10** — `2026-11-09T13-58-14.705Z-history-web-10.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:58:14.705Z`. Vitest built-in bench; 10 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**history-web-1000** — `2026-11-09T13-58-15.323Z-history-web-1000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:58:15.323Z`. Vitest built-in bench; 1000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**history-web-100000** — `2026-11-09T13-58-39.580Z-history-web-100000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:58:39.580Z`. Vitest built-in bench; 100000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**history-workerd** — `2026-11-09T13-42-51.638Z-history-workerd.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:42:51.638Z`. Vitest built-in bench; actual History Durable Object with full committed bootstrap, real SQLite durable flows and LiveMythical HTTP. First read measured once on a fresh object; warm outlines, first/second epic pages, commit detail, bounded search, five viewer refusals plus unchanged outline, and protocol errors measured three times. A keyed Plan binding runs twice with the same real cell identity and once with a new ordinal; exact cached response, one/two matching commits and cursor increments asserted across real SQLite flows. Server/bundler startup excluded; schema/assertions included. Limitations: Local workerd, no production network or model. First read is object bootstrap, not a forced cold isolate. Anonymous callers are viewers on this revision, so public writes remain forbidden; the separate keyed replay uses the test host’s trusted maintainer agent and actual production reader/binding/SQLite write path. No sign-in or GitHub write is claimed.

**http** — `2026-11-09T14-02-15.014Z-http.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:15.014Z`. Vitest built-in bench; real handler and sequencer; valid post/read/tour/end/events routing, body size/schema/name checks including lengthless multi-byte history overflow, cursor bounds, duplicate, and injected faulty Effect service returning Unreachable. Exact status and accepted state asserted. Limitations: In-process HTTP objects, no TCP; SQLite/durable engine covered in workerd.

**identity-cli** — `2026-11-09T13-59-38.475Z-identity-cli.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:59:38.475Z`. Vitest built-in bench; three complete journeys, four emitted CLI processes each, fresh scoped private settings. Decode every public schema, check signed fixture identity, settled answer, first/repeated logout and removed session file. Includes startup, durable session actions, scripted reply and assertions; build excluded. Limitations: Product mock sign-in, no OAuth, network, real session or model. This is whole-journey cost, not one-command latency. Private settings paths and contents are not retained.

**identity-labels** — `2026-11-09T13-59-11.488Z-identity-labels.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:59:11.488Z`. Vitest built-in bench; three literal guest/person/agent cases per callback over the production label decision, assertions included. Limitations: Pure presentation rule; does not prove signature validity, provider identity or role authority.

**identity-mcp** — `2026-11-09T13-59-42.576Z-identity-mcp.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:59:42.576Z`. Vitest built-in bench; persistent actual stdio MCP, discovery/startup excluded. Three five-call journeys: login, signed ask, logout, guest ask and full readback; literal author labels and exact settled reply count checked. Durable session actions, private file IO, schema/IPC, scripted replies and assertions included. Limitations: Isolated product mock settings, no OAuth/network/real session/model. Transcript grows by two posts per sample. Whole-journey cost, no percentile claim.

**issues-commands** — `2026-11-09T14-01-33.797Z-issues-commands.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:33.797Z`. Vitest built-in bench; each of eleven real product fixture issue commands from a fresh memory flow engine, nineteen committed fixture rows and maintainer identity. Three unwarmed samples each, with engine initialization, authorization, command, teardown and assertions included; exact affected row, cursor, unrelated rows and creation count checked. Limitations: Local product fixture host, no GitHub request, sign-in, network or model. Fresh-engine costs differ from a persistent UI session and successful writes do not claim production GitHub latency.

**issues-flows** — `2026-11-09T14-01-33.293Z-issues-flows.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:33.293Z`. Vitest built-in bench; fresh real makeIssueFactory, memory flow engine and host per callback; all eleven operations, retained intermediate writes, exact sequence, idempotent replay, literal proposal document, unchanged unrelated issues and complete schema equality. Three unwarmed whole-journey samples; initialization/assertions included. Limitations: Product fixture mode: no GitHub write, sign-in, repository review, network or model. One callback contains the entire journey; its latency is not a per-command latency.

**issues-host-journey** — `2026-11-09T14-00-26.294Z-issues-host-journey.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:26.294Z`. Vitest built-in bench; real serveIssues/executeIssues with SQLite, actual fixtureHost and changing Effect identity. Fresh world per sample; public projection strips untrusted approval, new/replay/changed request, human approval, saved receipt, revoked/agent writes, specification revision and missing reviewer checked. Exact HTTP statuses, retained body, once-only creation, approval and reset history asserted. Setup/assertions included. Limitations: Node HTTP values and real in-memory SQLite; no TCP, workerd scheduling, GitHub/OAuth or model. Product fixture host is explicitly injected. Whole journey is not per-command latency.

**issues-host-recovery** — `2026-11-09T14-00-30.281Z-issues-host-recovery.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:30.281Z`. Vitest built-in bench; production HTTP/SQLite issue adapter, fifteen injected typed Effect host failures, then a real fixture creation after explicit native retryFrom. Cached failure cannot retry implicitly; changed payload refused; exact matching recovery, replay, saved operation and missing receipt checked against unchanged fixture rows. Three fresh worlds; all assertions included. Phase-only diagnostic logs disabled. Limitations: Fault injection fails before the shipped fixture host; no own-code request interception, GitHub mutation or OAuth. Node SQLite in memory, no network/model. This is a complete fault/recovery corpus cost.

**issues-identities** — `2026-11-09T14-01-34.019Z-issues-identities.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:34.019Z`. Vitest built-in bench; actual Effect WebCrypto durable execution/recovery identity helpers checked against fixed SHA-256 vectors independently calculated with Python hashlib at authoring time of the canonical namespaced actor/operation/key tuples. Three operation identities and one recovery identity per callback. Limitations: Local digest and identity overhead, not a recovered remote execution or GitHub write.

**issues-policy** — `2026-11-09T14-01-33.528Z-issues-policy.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:33.528Z`. Vitest built-in bench; literal five-role by eleven-operation permission table, next/duplicate/gap projection, valid tree and self/missing/cycle refusals, all review label/close recovery states and request schema equality. Assertions included. Limitations: Pure policy/codec overhead with the nineteen-issue committed fixture; no storage, browser, GitHub or model.

**issues-reducer** — `2026-11-09T14-01-28.247Z-issues-reducer.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:28.247Z`. Vitest built-in bench; the full issues control table: navigation, filters, wizard steps with each validation, per-role forms and dialogs, saved-action retry identity and recovery keys, and request construction. Limitations: Pure reducer; the durable flows and views are benchmarked separately.

**issues-refusals** — `2026-11-09T14-01-34.190Z-issues-refusals.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:34.190Z`. Vitest built-in bench; actual product fixture engine with Effect-backed changing identity and participation service. Replay a cached commitment after downgrade to viewer, then assert eight exact domain refusals and unchanged state; successful new/comment call participation twice with exact identity. Three fresh engines; all assertions included. Limitations: Local authorization/domain boundary, no sign-in provider or GitHub request. Identity is a host-injected Effect service; no request interception.

**issues-view-matrix** — `2026-11-09T14-01-28.635Z-issues-view-matrix.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:28.635Z`. Vitest built-in bench; Foldkit scenes over the real app update/view render the issues pane list kinds, state and query filters, detail with notes and VIP review, commit/split/link dialogs, new and VIP wizard steps, the role matrix, connect gating, loading, failure and inline errors. Limitations: Scene rendering without layout/paint or a GitHub call; the write boundary runs in the issues fixture and workerd benchmarks.

**local-browser** — `2026-11-09T13-54-59.242Z-local-browser.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:54:59.242Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: Product mock mode, fresh browser context, shared browser/OS caches and automation overhead; no forced cold cache.

**local-browser-actions** — `2026-11-09T13-55-09.912Z-local-browser-actions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:55:09.912Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native-browser journey with real Foldkit and product MockFactory; timings include scripted delays and automation. External docs content is not asserted; only the correct pane URL and controls. Video timing begins after navigation; ready-state/decoded-frame observation and native programmatic pause/play include automation, browser caches and software decode, without physical control interaction. Touch is dispatched as native synthetic DOM events, not physical hardware. Single observations establish no percentile.

**local-role-actions** — `2026-11-09T13-55-21.276Z-local-role-actions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:55:21.276Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native-browser journey over the real product fixture account/role flows. Each role visit includes selection, identity visibility and (for signed roles) opening/checking/closing People. Other actions include confirmation or cancellation and resulting state. Sign-in/retry use the explicit mock identity host; no GitHub login, production identity, account mutation or model. Scripted reply/automation delays included; one observation per action establishes no percentile.

**local-wiki-actions** — `2026-11-09T13-55-25.013Z-local-wiki-actions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:55:25.013Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native Chromium journey through real product fixture flows. Maintainer Save and contributor Propose each open a review and preserve repository Markdown; reopening checks the original source. Escape, role revocation and a scripted agent draft are checked. No real GitHub writes, OAuth or model. Scripted waits and automation included; one sample per action establishes no percentile.

**machine-boundaries** — `2026-11-09T14-02-13.281Z-machine-boundaries.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:13.281Z`. Vitest built-in bench; complete reply/restart/tour lifecycles, admission boundaries, malformed replay, optimistic failure/retry/confirmation/gap/duplicate delivery; assertions included. Limitations: In-process state machine; not exhaustive input enumeration or proof.

**main-reducer-boundaries** — `2026-11-09T14-01-29.395Z-main-reducer-boundaries.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:29.395Z`. Vitest built-in bench; issue connection state with resume links, durable wiki visits with pane/people restoration and epoch reuse, action dispatch gating by selection and in-flight starts, slash dispatch clearing the draft, and sandbox start/stop/terminal controls with busy and blank-command refusals; exact emitted commands checked. Limitations: Reducer and command construction; the commands' durable execution is benchmarked through the mock factory.

**maintenance-scripts** — `2026-11-09T14-00-50.184Z-maintenance-scripts.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:50.184Z`. Vitest built-in bench; spawn each emitted script to exit over a real fixture jj repository and merge queue (seed) or the real installed vibelang skill (agent context); three samples each, no warmup. Fixture repository/queue construction is untimed setup. Write determinism, failed-read preservation and stale rejection are checked inside timed callbacks; the seed's parsed history content is fully asserted. Limitations: Fixture jj repositories, not VibeLang's real history; the full-history run's cost is dominated by its repository, not this fixture. Scripts write only inside the ignored dist-script-tests tree. Process/loader startup included; build excluded.

**markdown** — `2026-11-09T14-00-22.549Z-markdown.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:22.549Z`. Vitest built-in bench; parse a paragraph/code/paragraph answer; compare complete blocks. Limitations: Small fixed answer; rendering is measured separately.

**mcp** — `2026-11-09T13-50-39.757Z-mcp.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:50:39.757Z`. Vitest built-in bench; new emitted stdio server, real MCP initialize/discovery/call, validated schema and result; three samples, no warmup. Limitations: Includes process startup, handshake and teardown; mock backend; warm persistent-session call latency is measured separately.

**mcp-warm** — `2026-11-09T13-51-15.512Z-mcp-warm.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:51:15.512Z`. Vitest built-in bench; initialize and discover once outside timing; measure read calls on the same real stdio process, asserting the complete empty snapshot. Limitations: Product mock backend; schema/protocol/IPC included, startup/teardown excluded.

**media-observe** — `2026-11-09T14-02-10.331Z-media-observe.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:10.331Z`. Vitest built-in bench; actual media observation service for all image/video loaded/failed outcomes. Each counter dimension increases exactly one; capture and compare complete bounded log messages. Assertions and logger lifecycle included. Limitations: Effect telemetry boundary only; does not measure image download or video decode.

**mock-actions** — `2026-11-09T14-01-31.582Z-mock-actions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:31.582Z`. Vitest built-in bench; product MockActions over MockFactory: catalog, command table, button and slash starts, follow to settlement, per-flow runs, direct read, unknown command, invalid JSON input, missing run, cancellation and rerun. Three unwarmed samples. Limitations: Product mock backend; no model, network or workerd isolation. The same protocol against the real Worker runs in the workerd actions benchmark.

**mock-close** — `2026-11-09T13-54-21.538Z-mock-close.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:54:21.538Z`. Vitest built-in bench; build and close actual Factory scope, then verify a post is refused as unavailable. Limitations: Lifecycle cost, no model or network.

**mock-history-agent** — `2026-11-09T14-01-19.697Z-mock-history-agent.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:19.697Z`. Vitest built-in bench; fresh real MockFactory per sample, committed history decoded, journaled show tool, naturally streamed answer; exact repository main and epic counts independently composed and checked. Limitations: Product mock mode; three samples include intentional reply delays and history decode. No provider/model or network.

**mock-scripts** — `2026-11-09T13-54-21.244Z-mock-scripts.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:54:21.244Z`. Vitest built-in bench; script selection including fallback, reconstruct every selected reply from chunks. Limitations: Fixed synthetic prompts; syntax compilation remains in the separate unit suite.

**mock-tour** — `2026-11-09T13-54-20.965Z-mock-tour.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:54:20.965Z`. Vitest built-in bench; real MockFactory durable tour; verify each stop, complete exact script, busy refusal, ended-tour refusal and cancellation after first delta. One complete natural-paced run; three cancellations. Limitations: Includes production reading holds, based on each paragraph; one completion establishes no percentile. Product mock mode, no model/backend.

**model-config** — `2026-11-09T14-01-50.489Z-model-config.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:50.489Z`. Vitest built-in bench; actual Config and HostModel planning; default/unconfigured and configured model records, zero/default daily budget; no provider calls. Limitations: Configuration and route construction cost only.

**model-context-10** — `2026-11-09T14-01-24.909Z-model-context-10.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:24.909Z`. Vitest built-in bench; 10 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**model-context-1000** — `2026-11-09T14-01-25.149Z-model-context-1000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:25.149Z`. Vitest built-in bench; 1000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**model-context-100000** — `2026-11-09T14-01-26.361Z-model-context-100000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:26.361Z`. Vitest built-in bench; 100000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**object-cancelled-receipt** — `2026-11-09T14-01-40.952Z-object-cancelled-receipt.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:40.952Z`. Vitest built-in bench; real SQLite journal polling of an absent reply before and after a durable cancellation tombstone. Missing execution must remain an error; only recorded pre-admission cancellation returns no receipt. Three fresh scoped databases, setup and assertions included. Limitations: Deliberate absent-journal recovery boundary; no active model call or remote object.

**object-host** — `2026-11-09T14-01-40.766Z-object-host.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:40.766Z`. Vitest built-in bench; production conversation/request/alarm functions on the existing real node:sqlite host adapter. Two queued posts, malformed input and changed-owner duplicate, five alarms, exact ordered failure events, fresh sequencer recovery and ownership, budget/execution storage read/write/delete/alarm checks. Three fresh databases; initialization, durable migrations and assertions included. Limitations: Node SQLite with in-memory KV/alarm host, not workerd scheduling or disk durability. Deliberately unconfigured model exercises configuration failure, not inference. Actual workerd success paths remain separate workloads.

**policies** — `2026-11-09T14-01-37.793Z-policies.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:37.793Z`. Vitest built-in bench; strict admission, idempotent charging, accepted-only dispatch, reply attempt/offset/empty boundaries, tour terminal identity, retry classification and failure precedence; explicit behavioral truth tables. Limitations: Fixed in-process policy corpus; assertions dominate these small decisions, not an inference/model/storage measurement.

**protocol** — `2026-11-09T14-00-42.637Z-protocol.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:42.637Z`. Vitest built-in bench, Schema JSON codec, validated complete event round trips and snapshot length/tail; URL encode/decode. Setup excluded, assertions included. Limitations: In-process codec cost; no HTTP or network.

**provider-guards** — `2026-11-09T14-01-57.907Z-provider-guards.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:57.907Z`. Vitest built-in bench; exact safe issue/wiki error classification (precedence, retry interval, no provider detail), malformed/mismatched/noncanonical/unsafe VIP markers and invalid author, configured wiki file path and traversal/generated-index refusal. Every callback checks its outputs. Limitations: Pure guards and no-request early returns; no successful GitHub review validation, network, credentials or writes.

**provider-host-refusals** — `2026-11-09T14-01-58.036Z-provider-host-refusals.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:58.036Z`. Vitest built-in bench; actual GitHub issue/wiki host closures with an injected unavailable Effect HttpClient and changing principal. Missing key, credential connection, unavailable draft, unknown page, empty draft and anonymous write failures asserted. Wiki text persists before Connect. All writes make zero requests; one public read reaches the failing transport exactly once. Three fresh SQLite/KV worlds, setup/assertions included. Limitations: No request interception, external request, real credential, OAuth or GitHub mutation. Deliberate transport failure establishes refusal behavior only; successful provider paths remain unmeasured.

**reply-progress-decisions** — `2026-11-09T14-01-44.757Z-reply-progress-decisions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:44.757Z`. Vitest built-in bench; projected/partial/non-text/unknown deltas, retry reset retaining output and usage, exact safe-integer boundary, negative/unsafe/overflow usage latching invalidity, provider failure and completion precedence. Complete state comparisons inside timing. Limitations: SDK event projection policy, no provider decoding or inference. Actual agent/durable execution is separate.

**resources** — `2026-11-09T14-02-03.987Z-resources.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:03.987Z`. Vitest built-in bench; actual Alchemy stack compilation in temporary local state, dev/default production/domain variants; exact resource names, bindings, routes and CPU/observability settings checked. Three samples each, including layer/state-directory lifecycle. Limitations: Resource declarations only; no plan, deploy, provider lifecycle or Cloudflare account operation. Runtime object paths run separately in workerd.

**runtime** — `2026-11-09T14-01-12.262Z-runtime.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:12.262Z`. Vitest built-in bench, happy-dom with the actual startup program, stylesheet, Foldkit subscriptions/commands and MockFactory. Native Command-K and input/Enter; wait for the complete expected installed command. New scoped runtime each sample; 3 samples. Limitations: DOM runtime, no layout or paint; includes scripted reply delays and observer polling. Forced product mock mode, no network/model.

**sandbox-agent** — `2026-11-09T14-01-37.019Z-sandbox-agent.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:37.019Z`. Vitest built-in bench; actual harness bindings and stable cell identities over the real product mock flows. Invoke Start/Command/Stop/Start, replay old Stop, and read retained bytes through Command; verify bound conversation, catalog roster, generations and output. Three fresh engines. Limitations: Agent binding overhead without model selection or QuickJS; no Container. The public viewer boundary is measured separately; the SQLite lifecycle benchmark remains deferred by the compiler reproduction.

**sandbox-browser-actions** — `2026-11-09T13-55-16.976Z-sandbox-browser-actions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:55:16.976Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial real Chromium journey over product mock flows and supported terminal commands; exact retained terminal transcript checked across Stop/Start. No model/backend/real Container. Forced mock roles never grant live authority. Automation and scripted waits included; no percentile.

**sandbox-factory-1** — `2026-11-09T14-01-35.625Z-sandbox-factory-1.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:35.625Z`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 1 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**sandbox-factory-100** — `2026-11-09T14-01-36.879Z-sandbox-factory-100.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:36.879Z`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 100 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**sandbox-meter** — `2026-11-09T14-01-35.433Z-sandbox-meter.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:35.433Z`. Vitest built-in bench; five role allowances, distinct identity/lease bounds, exact two-running-box accounting across a UTC boundary, rollback/high-water recovery, snapshot rounding, invalid clock domains and safe-sum overflow. Independent numeric totals checked; assertions included. Limitations: In-process normalized-clock fixtures, not a fake global clock or Container performance. Real-clock host/flow paths are separate workloads.

**sandbox-public-workerd** — `2026-11-09T13-42-51.874Z-sandbox-public-workerd.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:42:51.874Z`. Vitest built-in bench; actual local workerd public sandbox router through LiveFactory: viewer snapshot, Start/Stop/Command forbidden, then unchanged empty state; exact typed refusals and all snapshot fields checked. Three serial five-request samples; bundling/server startup excluded. Limitations: Signed-out deployment boundary only, no trusted compute identity, Container or SQLite lifecycle. The separate sandbox SQLite benchmark is deferred by the nested-Effect compiler reproduction; this case does not substitute for it.

**sandbox-surfaces** — `2026-11-09T13-52-01.382Z-sandbox-surfaces.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:52:01.382Z`. Vitest built-in bench; emitted CLI read/start includes cold process/layer setup. Persistent real stdio MCP starts, writes, stops, restarts, reads retained bytes, stops and verifies snapshot through seven calls; full twenty-command catalog and exact generations/output checked. Three samples; MCP handshake excluded. Limitations: Product mock backend and maintainer surface principal, no real Container, model or repository write. MCP keeps one engine across samples and grows its receipt history; CLI gets a fresh engine each time. Assertions and IPC included.

**screen-protocol-policies** — `2026-11-09T14-01-38.036Z-screen-protocol-policies.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:38.036Z`. Vitest built-in bench; actual extracted screen/protocol/mock decisions, independent truth tables for shortcut priority, scroll revisions, input bounds, routing/status, backend choice and script priority. Module imports/setup excluded, correctness assertions included. Limitations: Fixed policy corpus; assertion overhead dominates. DOM, HTTP and actual agent flows are separate workloads.

**sequencer** — `2026-11-09T14-01-56.394Z-sequencer.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:56.394Z`. Vitest built-in bench; real sequencer on an in-memory append-only log. Post/refusal/duplicate, reply pieces, duplicate/stale pieces, restart, final replacement, tour, follower and fresh sequencer replay. Exact transcript and ordered events asserted; model history excludes tour narration while the transcript retains it. Limitations: In-process log, no storage I/O; SQLite/workerd measured separately.

**session-live-refusals** — `2026-11-09T14-01-07.543Z-session-live-refusals.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:07.543Z`. Vitest built-in bench; actual native signIn/signOutSurface, SDK SQLite journal and real loopback HTTP faulty Effect service. Three invalid origins make no request; local device-route 503 and sign-out 503 produce exact safe failures. Failed revocation still deletes private credentials; repeated logout is false; exactly two requests asserted. Three fresh scoped samples. Limitations: Deliberately refusing loopback service; no request interception, OAuth grant, real token, external network or production write. Measures refusal/validation and durable IO overhead, not successful sign-in.

**session-runtime** — `2026-11-09T14-01-06.196Z-session-runtime.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:06.196Z`. Vitest built-in bench; real platform-node SQLite host for sessionOperation and waitForSignIn. Action succeeds/fails, Poll completes on its first check or injected typed check failure. Exact statuses, propagated safe failure, counter increment and four bounded content-free telemetry records asserted. Three fresh private journals; setup/teardown included. Limitations: Deterministic action/check results measure durable flow overhead, not GitHub authorization, device polling intervals or WAN latency. No provider credential is used.

**session-settings** — `2026-11-09T14-01-05.114Z-session-settings.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:05.114Z`. Vitest built-in bench; real scoped filesystem settings lifecycle: absent/full replacement, separate mock/live session, exact 0700/0600 modes, pending grant retained/expired/deleted, repeated removal, invalid JSON/schema refusal, HOME fallback/missing HOME, explicit credential validation. Three unwarmed full corpora; setup, disk IO and correctness checks included. Limitations: Synthetic fixture values only; no OAuth/network. Local filesystem and process cache, no fsync/crash-durability claim. Private paths/contents omitted from artifacts.

**session-settings-faults** — `2026-11-09T14-01-05.233Z-session-settings-faults.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:05.233Z`. Vitest built-in bench; actual settings functions with an injected faulty Effect FileSystem chmod/remove over real temporary directories. Preparation/write/removal return exact safe reasons and no session file is published. Three fresh scoped samples, assertions included. Limitations: Permission failures are injected, not measured OS permission policy; no credential/OAuth/provider action.

**shared-decisions** — `2026-11-09T14-01-32.216Z-shared-decisions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:32.216Z`. Vitest built-in bench; inline/rich Markdown and safe-link table, build-time HTML with anchors and escaping, wiki path normalization/lookup/request mapping, role standing, VIP document rendering, sandbox pane decisions, media failure memory, mythical miss-path lookups and both sandbox policy layers. Limitations: Pure functions and layer reads; the wiki's durable open flow and workerd surfaces are benchmarked separately.

**site** — `2026-11-09T14-02-09.586Z-site.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:09.586Z`. Vitest built-in bench; production site Worker router over a real loopback HTTP file server serving repository home/logo bytes with SPA fallback, and real API handler health. Exact bodies, mock/live health and every rejection status checked. Three fresh scoped servers; startup/teardown included. Limitations: Local service-binding adapter over HTTP, no Cloudflare PoP or deployed asset cache; API error dependency is a deliberately faulty Effect service. Actual compiled UI/layout measured separately in Chromium.

**specification** — `2026-11-09T14-01-55.356Z-specification.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:55.356Z`. Vitest built-in bench; actual product issue flows and memory durable engine. Revise accepted specification, refuse stale/empty edits, collect all four scripted named reviews with Opus requesting a second review, verify once-only replay, reset on another revision and invoke the same review through the mock chat command. Complete review-history tuples and unchanged issues checked. Three fresh engines; setup/assertions included. Limitations: Product scripted reviewer behavior, no real model review, grade quality assessment, GitHub write or network. Named model performance belongs to an explicitly configured live workload.

**startup-theatre-decisions** — `2026-11-09T14-01-44.972Z-startup-theatre-decisions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:44.972Z`. Vitest built-in bench; explicit query/storage precedence and persistence, role/session admission, tutorial resume and auto-start choices, every theatre target, speech state transitions, bounded telemetry labels and keyboard wrap. Literal expected choices asserted inside timing. Limitations: Pure policy decisions; browser DOM, storage, layout and native speech execution are separate runtime boundaries.

**surface-failures** — `2026-11-09T13-51-12.775Z-surface-failures.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:51:12.775Z`. Vitest built-in bench; emitted processes reject blank/invalid input, unknown flags and an actually closed loopback endpoint. Exact exit/status stream and public error checked; three samples each. Limitations: Unreachable loopback, no request interception; process startup and error rendering included.

**transport** — `2026-11-09T14-01-59.965Z-transport.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:59.965Z`. Vitest built-in bench; inject a faulty Effect HttpClient into the actual Factory and Mythical adapters. Measure all chat/history/sandbox/terminal operations across transport errors, status failures, malformed JSON/protocol; exact safe typed error checked, no response body leaks. Limitations: Deliberate faulty service, no request interception; failure handling overhead without network latency. Successful transport paths run through real workerd.

**walkthrough-controls** — `2026-11-09T14-02-04.782Z-walkthrough-controls.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:02:04.782Z`. Vitest built-in bench; forty real state transitions over the exact ten-step catalog with elapsed reading time, pause and resume. Checks every accepted intent, current destination, preserved agent entry and exact remaining time. Limitations: Pure transition cost with assertions; no browser layout, network or durable SQLite execution.

**web-10** — `2026-11-09T14-00-11.934Z-web-10.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:11.934Z`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**web-1000** — `2026-11-09T14-00-12.533Z-web-1000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:12.533Z`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**web-100000** — `2026-11-09T14-00-22.288Z-web-100000.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:22.288Z`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**web-account-state** — `2026-11-09T14-01-42.220Z-web-account-state.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:42.220Z`. Vitest built-in bench; account/People/menu/grant/cancel/sign-in/out reducer corpus with all five roles, exact emitted work, three command retries, role-stream recovery and duplicate/gap/demotion fences. Every callback asserts state and ordered command names. Limitations: Pure reducer policy cost, no native dialogs, OAuth, network or persistence; runtime services and browser journeys are separate benchmarks.

**web-actions** — `2026-11-09T14-01-54.026Z-web-actions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:54.026Z`. Vitest built-in bench; all person-facing reducer messages, optimistic post retry, replay gap, connection, scroll, palette, splash and tour controls; scene assertions for retry and Esc. Limitations: Reducer/scene cost, no browser layout; native input and modal focus are covered by Chromium separately.

**web-content-commands** — `2026-11-09T14-01-46.255Z-web-content-commands.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:46.255Z`. Vitest built-in bench; real Foldkit Command effects over one scoped MockFactory, including identity/grant/readback, issue creation/details/projection, wiki editor/private draft/Save/readback and sign-in/out. Exact messages, source, public author/role and once-only review checked. Three fresh engines; setup, flow execution and assertions included. Limitations: Effect command boundary without DOM layout/paint; shipped product fixture services, no network/OAuth/GitHub/model. Full journey cost, not per-keystroke latency.

**web-execution-commands** — `2026-11-09T14-01-46.475Z-web-execution-commands.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:46.475Z`. Vitest built-in bench; actual Command effects over MockActions/Factory: catalog, Tour run/read/cancel and invalid input, sandbox file write/stop/restart/readback, then faulty action discovery/read/cancel. Exact ids, states, generations, retained output and request/epoch fields checked. Three fresh engines, assertions included. Limitations: Product mock runtime, no actual Container, model or network. Command-level journey includes initialization and IO; native browser layout separately benchmarked.

**web-issue-state** — `2026-11-09T14-01-42.459Z-web-issue-state.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:42.459Z`. Vitest built-in bench; saved new/VIP/comment/specification requests across completed/failed/running receipts, unrelated error fence, seven exact failure labels, unwritten correction, selected-detail cursor fences and live detail dispatch. Literal text/identity/state and ordered emitted work checked each callback. Limitations: Reducer/restoration overhead only; no request/transport interception, network, provider write or model.

**web-wiki-state** — `2026-11-09T14-01-42.687Z-web-wiki-state.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:42.687Z`. Vitest built-in bench; wiki editor begin/type/submit/cancel, immutable uncertain request, stale completion/failure fences, five exact failure labels and unwritten correction, unchanged observed source with review, filter/location and page-open failure identity. Exact model fields asserted each callback. Limitations: Pure update-state cost; does not execute emitted services or simulate browser dialogs/network. Native and SQLite wiki journeys run separately.

**wiki-cli** — `2026-11-09T14-00-08.287Z-wiki-cli.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:08.287Z`. Vitest built-in bench; three unwarmed samples for each wiki operation, spawning the actual emitted CLI to exit. Validated schema, fixture role, full read/draft bytes and exact first review identity. Build excluded; process startup and assertions included. Limitations: Product mock backend and maintainer principal, fresh engine each call. Save and Propose open fixture reviews; no GitHub mutation, OAuth or model. Command-line source arguments remain in memory and never enter artifacts.

**wiki-edit-journeys** — `2026-11-09T14-01-52.486Z-wiki-edit-journeys.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:52.486Z`. Vitest built-in bench, three whole-journey samples. Each sample initializes two independent real fixture repositories/engines, reads source, drafts, submits by each role, replays and verifies unchanged Markdown and exactly one review per repository. Assertions included. Limitations: Product fixture mode; excludes real GitHub, credentials, model generation and network. Whole-journey latency is not per-command latency or a coverage claim.

**wiki-host-journey** — `2026-11-09T14-00-31.904Z-wiki-host-journey.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:31.904Z`. Vitest built-in bench; production serveWiki/executeWiki and SQLite runtime over real fixtureWikiHost. GET/read, private draft/readback, maintainer Save, exact replay and changed-payload refusal, contributor gate/Propose and agent refusal. Original source, literal draft, two distinct review receipts and exact retained proposals checked; three fresh worlds, setup/assertions included. Limitations: Product fixture repository, no GitHub/OAuth/network/model. Node HTTP objects and in-memory SQLite; no claim of actual provider review creation or workerd scheduling. Whole-journey cost.

**wiki-host-recovery** — `2026-11-09T14-00-35.855Z-wiki-host-recovery.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:35.855Z`. Vitest built-in bench; nine typed faulty Effect host outcomes through production HTTP/SQLite, failure receipt replay, changed request rejection and native retryFrom into shipped fixtureWikiHost. Exact statuses, original request, once-only review and unchanged Markdown checked; three fresh worlds, assertions included. Limitations: Fault service fails before host writes; no HTTP interception. Local SQLite, no provider/real credentials/model/network. No successful GitHub or OAuth coverage claimed.

**wiki-mcp** — `2026-11-09T14-00-10.311Z-wiki-mcp.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:00:10.311Z`. Vitest built-in bench; one real persistent stdio process, initialization/discovery excluded. Three samples per operation. Each measured callback includes the command plus a source-readback call; Save/Propose also include an identical-request replay and compare the complete result. Full original source, role, draft bytes and cleared submitted draft checked; schema/IPC/assertions included. Limitations: Product fixture wiki; no GitHub mutation, OAuth or model. The persistent engine grows its review history; command-plus-validation roundtrips are not single-call wire latency. No percentile claim.

**wiki-script** — `2026-11-09T14-01-15.591Z-wiki-script.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:15.591Z`. Vitest built-in bench; actual emitted wiki generator over fixture files in the compiler's ignored output tree. Build twice, remove a required receipt and then the directory. Check exact page roster/order, nested/absolute/external/hash links, ruling deduplication, status/suite metadata, byte-identical second build and preserved output after both real read failures. Three complete four-process journeys; filesystem setup/assertions included, compilation excluded. Limitations: Small fixture wiki; not a full-site build throughput measurement. Child process startup, source loading and filesystem work included. Run independently of ordinary wiki-process tests, which use the same compiler fixture directory.

**wiki-view-matrix** — `2026-11-09T14-01-28.914Z-wiki-view-matrix.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T14:01:28.914Z`. Vitest built-in bench; Foldkit scenes over the real update/view render the wiki pane's index, decision chrome, loading skeleton, error with retry, filtered and empty navigation and tour-maximized state. Limitations: Scene rendering without layout/paint; the durable open flow is benchmarked through the mock factory and workerd.

**workerd** — `2026-11-09T13-49-42.007Z-workerd.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:49:42.007Z`. Vitest built-in bench; actual local workerd Durable Objects, SQLite engine, alarms, LiveFactory HTTP/SSE, agent and QuickJS; deterministic HTTP model service. Three new conversations each, unwarmed. Bundling/server startup excluded; post-through-settle/read included. Limitations: Flow/adapter overhead, no model inference, WAN or production contention. Tour includes ten real durable reading holds, totaling 134 seconds. Test host delegates to production Objects/Http; Alchemy's deploy-only wiring is not run.

**Withdrawn earlier observation.** **workerd-actions** — `2026-11-09T13-57-35.402Z-workerd-actions.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:57:35.402Z`. Vitest built-in bench; real local workerd API Worker with the deterministic model service: LiveActions list/commands/start/cancel/follow/runs/read/rerun/slash and its typed failures, then signed sessions run Post and history Plan flows to settlement, with the input/authority/conflict/not-found matrix and cross-origin refusal. Limitations: Flow/adapter overhead over local workerd, no WAN or production contention; model replies are deterministic HTTP fixtures. Three samples per command on one served instance.

**workerd-sandboxes** — `2026-11-09T13-59-09.665Z-workerd-sandboxes.json`; source `96cd56be7ddd42bcbc8a25cf66ddfe41c76cfd35`, UTC `2026-11-09T13:59:09.665Z`. Vitest built-in bench; the per-person sandbox ledger object in real workerd SQLite with the product in-memory machines: start/write/stop/restart with generation fencing, stale and replayed receipts, retained bytes, metering and pruning, plus the public HTTP boundary's signed-out snapshot, forged-role refusal, routing and body admission. Limitations: In-memory machines stand in for the opt-in Cloudflare Container; container latency is not measured. Three samples per journey on one served object.


## Production observations, 2026-11-09 12:35 UTC

`pnpm bench:live` exits 0: two tests pass and five local-only tests are skipped, 16.4 seconds. Three real-model API samples run against `https://vibelang.smithers.sh`, deployment `7993617b64` reported by `/api/health`. This deployment differs from the local production-source snapshot. Client machine: shared nyc-01, AMD EPYC 7443P, 48 logical CPUs, Node 26.5.0, Chromium 151.0.7922.34, Playwright 1.62.1, VibeLang 0.0.12, Effect 4.1.1, Vitest 5.0.0. Host timezone UTC (04:35 America/Los_Angeles).

| Metric, ms | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| First render | 842.01 | 482.17 | 632.01 |
| Command-K to focused prompt | 106.13 | 127.99 | 118.37 |
| Keystroke to input value | 78.40 | 31.44 | 20.27 |
| Fresh-object API read | 1270.45 | 795.96 | 676.09 |
| Warm-object API read | 66.48 | 23.84 | 25.96 |
| Post acceptance | 2127.47 | 581.90 | 394.34 |
| First numbered event | 2187.31 | 1029.11 | 789.25 |
| First visible answer delta | 3853.93 | 1249.60 | 1165.00 |
| Settled reply | 4288.93 | 1548.21 | 1425.66 |

Browser: serial fresh contexts, navigation to visible heading; key dispatch to a visible modal/focused input or updated value. API: client wall time over real HTTP/SSE, full numbered protocol replay, settled exact snapshot and successful nonempty reply checks. Raw samples, event/character counts, source revision, deployment and metadata remain in `2026-11-09T12-35-41.848Z-live-browser.json` and `2026-11-09T12-35-52.453Z-live-api.json`.

Limitations: shared host/browser/OS caches and automation overhead; no forced cold Worker isolate. Fresh/warm describes objects and repeated reads. WAN, PoP, provider, cache and daily-budget contention are uncontrolled. First answer delta is the first projected visible token; provider first-token time is not exposed by this protocol. Three samples establish no tail percentiles. Real model tokens were spent as explicitly requested; no provider mutation, OAuth or Container claim is made.

### Current large-fixture findings

On the archived `6886bb65` production parent plus benchmark source `96cd56be`, the 100,000-completed-entry conversation scene averages 3,118.11 ms and the 100,000-internal-planned-commit History scene 7,922.28 ms, three samples each. They include vnode generation, serialization and query assertions, with no DOM patch/layout/paint. History checks a 50-row open epic, but the separate Planned list still scales with all 100,000 commits; normal committed-history browsing pages 50 at a time. The conversation transcript and worst-case Planned list are not virtualized. Those large-fixture costs remain findings; no browser CPU conclusion or new performance fix is claimed. On the conversation fixture, a keystroke update averages 0.008113 ms and an incoming event 1.64416 ms. See `web-100000` and `history-web-100000` artifacts/methods above.

The post/reply/read workerd journey averages 440.31 ms across three new conversations over a deterministic local model service, with real HTTP/SSE/SQLite/agent overhead and no inference/WAN. Tour averages 136,208.51 ms, explicitly including 134 seconds of real reading holds. Fresh content/drafting host corpora average 15,382.90/12,777.68 ms; bundling/startup/assertions are included. Whole-host costs are not per-request latency. All raw samples remain in the complete corrected roster.

## Earlier source-profile measurement before final History validation (2026-11-09)

The complete benchmark-only run on archived production parent `6227bf09c9a5ce33557990e4cbea361ab19a5c4e` covers **5,816/7,035 src/worker statement-start lines (82.67%)**. All executable source hashes (including the generated wiki module) match before/after; ignored `.d.vibe.ts` compiler outputs were regenerated and are separately listed, never used as coverage evidence. All benchmark workloads pass; the strict merged gate exits 1 for 95 files. No src/worker line is excluded. This is unfinished. The initial current-main baseline on `3fa8df73` was 5,221/6,947 (75.15%); intervening main changes include proof refactors, issue rendering, VL-32 acceptance and the hosted sign-in broker, so this is a comparison of named snapshots, not a controlled attribution of every denominator change to benchmark additions. Raw JSON receipt `2026-11-09T15-34-02.612Z-coverage-receipt.json`, complete source, before/after hashes, Node/workerd/Chromium maps and source-profile bundles are retained with the lane report.

The collector reuses decision 0016's configuration. Only benchmark workloads run; no unit/fuzz counters or earlier source snapshots join this map. Chromium source profiling is unminified and exact source ranges must match. Optimized-bundle attribution remains unqualified. Instrumented timings are excluded from performance tables. Real Container, GitHub write and OAuth requirements and precise future benchmarks remain in 0017. Ordinary reachable errors/control paths also remain visible below.

### Added validated observations

Shared nyc-01; raw metadata includes machine, versions, timestamp, exact source revision, method and limitations. Every callback checks its result. Means below include those assertions. Explicit sync/async runner registration prevents unmeasured classification calls; real-runner controls check exact callback counts and concurrency. Three samples do not establish a tail percentile.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| account-cookie-admission | 0.4868 | 206 | `2026-11-09T15-12-09.810Z-account-cookie-admission.json` |
| content-workerd | 14501.2875 | 3 | `2026-11-09T15-06-35.887Z-content-workerd.json` |
| drafts-workerd | 11525.8407 | 3 | `2026-11-09T15-07-45.238Z-drafts-workerd.json` |
| history-browser-command-faults | 1.7010 | 3 | `2026-11-09T15-12-12.640Z-history-browser-command-faults.json` |
| history-browser-commands | 20.3065 | 3 | `2026-11-09T15-12-12.543Z-history-browser-commands.json` |
| issues-host-journey | 659.1285 | 3 | `2026-11-09T15-10-21.419Z-issues-host-journey.json` |
| issues-host-recovery | 1520.0987 | 3 | `2026-11-09T15-10-26.102Z-issues-host-recovery.json` |
| provider-guards | 0.6232 | 161 | `2026-11-09T15-12-07.948Z-provider-guards.json` |
| provider-host-refusals | 7.4324 | 3 | `2026-11-09T15-12-08.097Z-provider-host-refusals.json` |
| session-live-refusals | 324.4214 | 3 | `2026-11-09T15-11-24.162Z-session-live-refusals.json` |
| session-runtime | 306.9931 | 3 | `2026-11-09T15-11-23.085Z-session-runtime.json` |
| session-settings | 14.0975 | 3 | `2026-11-09T15-11-21.931Z-session-settings.json` |
| session-settings-faults | 1.8903 | 3 | `2026-11-09T15-11-22.053Z-session-settings-faults.json` |
| web-account-state | 0.3192 | 314 | `2026-11-09T15-11-52.884Z-web-account-state.json` |
| web-content-commands | 48.6152 | 3 | `2026-11-09T15-12-03.064Z-web-content-commands.json` |
| web-execution-commands | 36.8139 | 3 | `2026-11-09T15-12-03.304Z-web-execution-commands.json` |
| web-issue-state | 2.5164 | 40 | `2026-11-09T15-11-53.148Z-web-issue-state.json` |
| web-wiki-state | 0.2376 | 421 | `2026-11-09T15-11-53.393Z-web-wiki-state.json` |
| wiki-host-journey | 447.6029 | 3 | `2026-11-09T15-10-27.565Z-wiki-host-journey.json` |
| wiki-host-recovery | 1095.4843 | 3 | `2026-11-09T15-10-30.959Z-wiki-host-recovery.json` |

**account-cookie-admission.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:12:09.810Z`. Vitest built-in bench; production cookie-name and admission functions. Exact secure/local names, three hosted origins, four loopback origins, 1/4096/4097-character values, eleven invalid/noncanonical origins, invalid characters and line terminators checked in every callback. Setup and assertions included. Limitations: Pure URL/cookie syntax admission; does not establish a valid signature, identity, broker exchange, role, real OAuth or production session. No network, request interception or credential used.

**content-workerd.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:06:35.887Z`. Vitest built-in bench; each of three unwarmed samples starts fresh real workerd issue and wiki hosts. HTTP/SQLite commitments replay once; credentials are encrypted/session-bound/current-role/expiring; paid failed drafts charge once; partial write retryFrom adopts exactly one original child. Wiki draft privacy, contributor proposal/replay, forbidden Save, unchanged Markdown and one completed proposal journal row checked. Bundling, server lifecycle and assertions included. Limitations: Existing unshipped host supplies product fixture identities/repository; typed faulty Effect services exercise paid failures and partial recovery. No real GitHub write, OAuth or Container. Whole fresh-host corpus cost includes bundling and startup; it is not per-request latency or model inference.

**drafts-workerd.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:07:45.238Z`. Vitest built-in bench; three fresh native workerd worlds run production VIP draft, wiki draft and specification reviewer AgentActions, SDK model HTTP/SSE, QuickJS and SQLite over one deterministic local model service. Exact schema answers, six metered tokens, three HTTP model calls and cached replay with no further call checked. Bundling/startup/assertions included. Limitations: Deterministic model responses measure flow/agent overhead without inference or WAN. No GitHub write, OAuth, Container or real provider spending. Whole fresh-host corpus is not per-request latency.

**history-browser-command-faults.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:12:12.640Z`. Vitest built-in bench; typed faulty Effect Mythical service, four browser reads and five writes under both permission and transport failures. All exact message/reason projections and redaction checked. Three full corpora, setup/assertions included. Limitations: Deliberate service failures, no request interception or successful provider simulation; no network, repository writes or model.

**history-browser-commands.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:12:12.543Z`. Vitest built-in bench; actual History Command effects over MockMythical's memory engine from empty history. Outline, Plan, epic/search, Start/Note/Approve/Fold and commit/missing detail; exact command messages, retained fields, notes, fold SHA and final six-event outline checked. Three fresh scoped engines, assertions included. Limitations: Shipped product mock main, no GitHub mutation, network, OAuth or actual repository fold. Command Effects without browser layout/DOM focus.

**issues-host-journey.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:10:21.419Z`. Vitest built-in bench; real serveIssues/executeIssues with SQLite, actual fixtureHost and changing Effect identity. Fresh world per sample; public projection strips untrusted approval, new/replay/changed request, human approval, saved receipt, revoked/agent writes, specification revision and missing reviewer checked. Exact HTTP statuses, retained body, once-only creation, approval and revision history asserted. Setup/assertions included. Limitations: Node HTTP values and real in-memory SQLite; no TCP, workerd scheduling, GitHub/OAuth or model. Product fixture host is explicitly injected. Whole journey is not per-command latency.

**issues-host-recovery.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:10:26.102Z`. Vitest built-in bench; production HTTP/SQLite issue adapter, fifteen injected typed Effect host failures, then a real fixture creation after explicit native retryFrom. Cached failure cannot retry implicitly; changed payload refused; exact matching recovery, replay, saved operation and missing receipt checked against unchanged fixture rows. Three fresh worlds; all assertions included. Phase-only diagnostic logs disabled. Limitations: Fault injection fails before the shipped fixture host; no own-code request interception, GitHub mutation or OAuth. Node SQLite in memory, no network/model. This is a complete fault/recovery corpus cost.

**provider-guards.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:12:07.948Z`. Vitest built-in bench; exact safe issue/wiki error classification (precedence, retry interval, no provider detail), malformed/mismatched/noncanonical/unsafe VIP markers and invalid author, configured wiki file path and traversal/generated-index refusal. Every callback checks its outputs. Limitations: Pure guards and no-request early returns; no successful GitHub review validation, network, credentials or writes.

**provider-host-refusals.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:12:08.097Z`. Vitest built-in bench; actual GitHub issue/wiki host closures with an injected unavailable Effect HttpClient and changing principal. Missing key, credential connection, unavailable draft, unknown page, empty draft and anonymous write failures asserted. Wiki text persists before Connect. All writes make zero requests; one public read reaches the failing transport exactly once. Three fresh SQLite/KV worlds, setup/assertions included. Limitations: No request interception, external request, real credential, OAuth or GitHub mutation. Deliberate transport failure establishes refusal behavior only; successful provider paths remain unmeasured.

**session-live-refusals.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:11:24.162Z`. Vitest built-in bench; actual native signIn/signOutSurface, SDK SQLite journal and real loopback HTTP faulty Effect service. Three invalid origins make no request; local device-route 503 and sign-out 503 produce exact safe failures. Failed revocation still deletes private credentials; repeated logout is false; exactly two requests asserted. Three fresh scoped samples. Limitations: Deliberately refusing loopback service; no request interception, OAuth grant, real token, external network or production write. Measures refusal/validation and durable IO overhead, not successful sign-in.

**session-runtime.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:11:23.085Z`. Vitest built-in bench; real platform-node SQLite host for sessionOperation and waitForSignIn. Action succeeds/fails, Poll completes on its first check or injected typed check failure. Exact statuses, propagated safe failure, counter increment and four bounded content-free telemetry records asserted. Three fresh private journals; setup/teardown included. Limitations: Deterministic action/check results measure durable flow overhead, not GitHub authorization, device polling intervals or WAN latency. No provider credential is used.

**session-settings.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:11:21.931Z`. Vitest built-in bench; real scoped filesystem settings lifecycle: absent/full replacement, separate mock/live session, exact 0700/0600 modes, pending grant retained/expired/deleted, repeated removal, invalid JSON/schema refusal, HOME fallback/missing HOME, explicit credential validation. Three unwarmed full corpora; setup, disk IO and correctness checks included. Limitations: Synthetic fixture values only; no OAuth/network. Local filesystem and process cache, no fsync/crash-durability claim. Private paths/contents omitted from artifacts.

**session-settings-faults.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:11:22.053Z`. Vitest built-in bench; actual settings functions with an injected faulty Effect FileSystem chmod/remove over real temporary directories. Preparation/write/removal return exact safe reasons and no session file is published. Three fresh scoped samples, assertions included. Limitations: Permission failures are injected, not measured OS permission policy; no credential/OAuth/provider action.

**web-account-state.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:11:52.884Z`. Vitest built-in bench; account/People/menu/grant/cancel/sign-in/out reducer corpus with all five roles, exact emitted work, three command retries, role-stream recovery and duplicate/gap/demotion fences. Every callback asserts state and ordered command names. Limitations: Pure reducer policy cost, no native dialogs, OAuth, network or persistence; runtime services and browser journeys are separate benchmarks.

**web-content-commands.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:12:03.064Z`. Vitest built-in bench; real Foldkit Command effects over one scoped MockFactory, including identity/grant/readback, issue creation/details/projection, wiki editor/private draft/Save/readback and sign-in/out. Exact messages, source, public author/role and once-only review checked. Three fresh engines; setup, flow execution and assertions included. Limitations: Effect command boundary without DOM layout/paint; shipped product fixture services, no network/OAuth/GitHub/model. Full journey cost, not per-keystroke latency.

**web-execution-commands.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:12:03.304Z`. Vitest built-in bench; actual Command effects over MockActions/Factory: catalog, Tour run/read/cancel and invalid input, sandbox file write/stop/restart/readback, then faulty action discovery/read/cancel. Exact ids, states, generations, retained output and request/epoch fields checked. Three fresh engines, assertions included. Limitations: Product mock runtime, no actual Container, model or network. Command-level journey includes initialization and IO; native browser layout separately benchmarked.

**web-issue-state.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:11:53.148Z`. Vitest built-in bench; saved new/VIP/comment/specification requests across completed/failed/running receipts, unrelated error fence, seven exact failure labels, unwritten correction, selected-detail cursor fences and live detail dispatch. Literal text/identity/state and ordered emitted work checked each callback. Limitations: Reducer/restoration overhead only; no request/transport interception, network, provider write or model.

**web-wiki-state.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:11:53.393Z`. Vitest built-in bench; wiki editor begin/type/submit/cancel, immutable uncertain request, stale completion/failure fences, five exact failure labels and unwritten correction, unchanged observed source with review, filter/location and page-open failure identity. Exact model fields asserted each callback. Limitations: Pure update-state cost; does not execute emitted services or simulate browser dialogs/network. Native and SQLite wiki journeys run separately.

**wiki-host-journey.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:10:27.565Z`. Vitest built-in bench; production serveWiki/executeWiki and SQLite runtime over real fixtureWikiHost. GET/read, private draft/readback, maintainer Save, exact replay and changed-payload refusal, contributor gate/Propose and agent refusal. Original source, literal draft, two distinct review receipts and exact retained proposals checked; three fresh worlds, setup/assertions included. Limitations: Product fixture repository, no GitHub/OAuth/network/model. Node HTTP objects and in-memory SQLite; no claim of actual provider review creation or workerd scheduling. Whole-journey cost.

**wiki-host-recovery.** Source `544589c510aa1116e5bfa18de996ec58d17b47d2`; UTC `2026-11-09T15:10:30.959Z`. Vitest built-in bench; nine typed faulty Effect host outcomes through production HTTP/SQLite, failure receipt replay, changed request rejection and native retryFrom into shipped fixtureWikiHost. Exact statuses, original request, once-only review and unchanged Markdown checked; three fresh worlds, assertions included. Limitations: Fault service fails before host writes; no HTTP interception. Local SQLite, no provider/real credentials/model/network. No successful GitHub or OAuth coverage claimed.

### Current per-file benchmark coverage

Executable lines are statement starts; an enclosing declaration cannot credit its nested body. All four strict metrics and exact uncovered positions remain in the raw receipt. Counts below additionally retain Node-only execution separately from merged evidence.

| File | Node covered/executable | Merged covered/executable | Merged lines |
| --- | ---: | ---: | ---: |
| `infra/SandboxImage.vibe` | 0/2 | 0/2 | 0.00% |
| `infra/Stack.vibe` | 8/8 | 8/8 | 100.00% |
| `infra/WorkerBuild.vibe` | 1/1 | 1/1 | 100.00% |
| `scripts/agent-context.vibe` | 22/22 | 22/22 | 100.00% |
| `scripts/mythical-seed.vibe` | 51/51 | 50/50 | 100.00% |
| `scripts/wiki.vibe` | 30/30 | 30/30 | 100.00% |
| `src/actions/Actions.vibe` | 4/4 | 4/4 | 100.00% |
| `src/actions/LiveActions.vibe` | 43/43 | 43/43 | 100.00% |
| `src/actions/MockActions.vibe` | 109/118 | 110/118 | 93.22% |
| `src/actions/agent.vibe` | 5/11 | 5/11 | 45.45% |
| `src/actions/catalog.vibe` | 8/8 | 8/8 | 100.00% |
| `src/actions/execution.vibe` | 28/40 | 28/40 | 70.00% |
| `src/actions/tools.vibe` | 12/13 | 12/13 | 92.31% |
| `src/actions/wire.vibe` | 6/6 | 6/6 | 100.00% |
| `src/assets/wiki.generated.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/Factory.vibe` | 3/3 | 3/3 | 100.00% |
| `src/core/IssuesFactory.vibe` | 75/76 | 75/76 | 98.68% |
| `src/core/LiveAccounts.vibe` | 25/26 | 25/26 | 96.15% |
| `src/core/LiveFactory.vibe` | 69/77 | 69/77 | 89.61% |
| `src/core/LiveIssues.vibe` | 3/11 | 3/11 | 27.27% |
| `src/core/LiveWiki.vibe` | 4/15 | 4/15 | 26.67% |
| `src/core/MockAccounts.vibe` | 73/77 | 76/77 | 98.70% |
| `src/core/MockFactory.vibe` | 208/254 | 236/254 | 92.91% |
| `src/core/MockJournal.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/VipWriter.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/WikiFactory.vibe` | 62/65 | 65/65 | 100.00% |
| `src/core/WikiWriter.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/accountCookieDecision.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/accountCookies.vibe` | 9/9 | 9/9 | 100.00% |
| `src/core/conversation.vibe` | 288/296 | 289/296 | 97.64% |
| `src/core/flowDecision.vibe` | 49/65 | 51/65 | 78.46% |
| `src/core/flows.vibe` | 122/165 | 145/165 | 87.88% |
| `src/core/identityDecision.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/issueFlows.vibe` | 32/32 | 32/32 | 100.00% |
| `src/core/issueSchemas.vibe` | 12/12 | 12/12 | 100.00% |
| `src/core/mockDecision.vibe` | 10/10 | 10/10 | 100.00% |
| `src/core/mockReplies.vibe` | 19/19 | 19/19 | 100.00% |
| `src/core/protocolDecision.vibe` | 16/17 | 17/17 | 100.00% |
| `src/core/roles.vibe` | 5/5 | 5/5 | 100.00% |
| `src/core/sandboxDecision.vibe` | 54/55 | 55/55 | 100.00% |
| `src/core/sandboxHost.vibe` | 130/181 | 147/181 | 81.22% |
| `src/core/sandboxMeter.vibe` | 33/33 | 33/33 | 100.00% |
| `src/core/sandboxMock.vibe` | 40/47 | 43/47 | 91.49% |
| `src/core/sandboxPolicy.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/schemas.vibe` | 30/30 | 30/30 | 100.00% |
| `src/core/sequenceDecision.vibe` | 20/20 | 20/20 | 100.00% |
| `src/core/specification.vibe` | 32/32 | 32/32 | 100.00% |
| `src/core/walkthroughSteps.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/wiki.vibe` | 15/15 | 15/15 | 100.00% |
| `src/core/wikiDecision.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/wikiFlows.vibe` | 32/32 | 32/32 | 100.00% |
| `src/core/wikiLinks.vibe` | 13/14 | 13/14 | 92.86% |
| `src/core/wikiSchemas.vibe` | 5/5 | 5/5 | 100.00% |
| `src/core/wire.vibe` | 26/27 | 26/27 | 96.30% |
| `src/history/LiveMythical.vibe` | 39/41 | 39/41 | 95.12% |
| `src/history/MockMythical.vibe` | 35/35 | 35/35 | 100.00% |
| `src/history/MythicalHistory.vibe` | 2/2 | 2/2 | 100.00% |
| `src/history/Sequencer.vibe` | 86/96 | 86/96 | 89.58% |
| `src/history/flowMachine.vibe` | 50/51 | 50/51 | 98.04% |
| `src/history/flows.vibe` | 66/76 | 68/76 | 89.47% |
| `src/history/mythical.vibe` | 141/141 | 141/141 | 100.00% |
| `src/history/pages.vibe` | 36/36 | 36/36 | 100.00% |
| `src/history/roles.vibe` | 6/6 | 6/6 | 100.00% |
| `src/history/schemas.vibe` | 31/32 | 32/32 | 100.00% |
| `src/history/seed.vibe` | 166/171 | 166/171 | 97.08% |
| `src/history/seed/vibelang.vibe` | 2/2 | 2/2 | 100.00% |
| `src/history/tools.vibe` | 26/27 | 26/27 | 96.30% |
| `src/history/wire.vibe` | 35/35 | 35/35 | 100.00% |
| `src/surfaces/backend.vibe` | 38/45 | 38/45 | 84.44% |
| `src/surfaces/cli-entry.vibe` | 8/8 | 8/8 | 100.00% |
| `src/surfaces/cli.vibe` | 16/16 | 16/16 | 100.00% |
| `src/surfaces/commandDecision.vibe` | 9/9 | 9/9 | 100.00% |
| `src/surfaces/commands.vibe` | 124/168 | 124/168 | 73.81% |
| `src/surfaces/manifest.vibe` | 4/4 | 4/4 | 100.00% |
| `src/surfaces/mcp-entry.vibe` | 6/6 | 6/6 | 100.00% |
| `src/surfaces/mcp.vibe` | 17/17 | 17/17 | 100.00% |
| `src/surfaces/session.vibe` | 63/63 | 63/63 | 100.00% |
| `src/surfaces/sessionFlow.vibe` | 28/29 | 28/29 | 96.55% |
| `src/surfaces/signin.vibe` | 49/107 | 49/107 | 45.79% |
| `src/web/actionModel.vibe` | 15/15 | 15/15 | 100.00% |
| `src/web/actionView.vibe` | 25/30 | 27/30 | 90.00% |
| `src/web/backend.vibe` | 33/73 | 59/73 | 80.82% |
| `src/web/entry.vibe` | 0/8 | 8/8 | 100.00% |
| `src/web/historyApp.vibe` | 132/156 | 139/156 | 89.10% |
| `src/web/historyBackend.vibe` | 0/26 | 16/26 | 61.54% |
| `src/web/historyStartup.vibe` | 0/32 | 33/33 | 100.00% |
| `src/web/historyView.vibe` | 64/73 | 64/73 | 87.67% |
| `src/web/issues.vibe` | 43/49 | 43/49 | 87.76% |
| `src/web/issuesView.vibe` | 63/78 | 63/78 | 80.77% |
| `src/web/main.vibe` | 424/636 | 554/636 | 87.11% |
| `src/web/markdown.vibe` | 94/103 | 101/103 | 98.06% |
| `src/web/media.vibe` | 6/6 | 6/6 | 100.00% |
| `src/web/modeSwitch.vibe` | 2/2 | 2/2 | 100.00% |
| `src/web/modelDecision.vibe` | 39/54 | 43/54 | 79.63% |
| `src/web/roleView.vibe` | 17/24 | 18/24 | 75.00% |
| `src/web/sandboxView.vibe` | 14/17 | 15/17 | 88.24% |
| `src/web/screenDecision.vibe` | 38/41 | 38/41 | 92.68% |
| `src/web/startup.vibe` | 46/50 | 50/50 | 100.00% |
| `src/web/startupDecision.vibe` | 9/9 | 9/9 | 100.00% |
| `src/web/styles.vibe` | 1/1 | 1/1 | 100.00% |
| `src/web/theatre.vibe` | 4/45 | 32/45 | 71.11% |
| `src/web/theatreDecision.vibe` | 18/18 | 18/18 | 100.00% |
| `src/web/view.vibe` | 48/51 | 48/51 | 94.12% |
| `src/web/viewDecision.vibe` | 22/22 | 22/22 | 100.00% |
| `src/web/viewport.vibe` | 16/48 | 46/48 | 95.83% |
| `src/web/wikiView.vibe` | 26/28 | 26/28 | 92.86% |
| `worker/Accounts.vibe` | 14/267 | 173/267 | 64.79% |
| `worker/ActionDirectory.vibe` | 26/36 | 34/36 | 94.44% |
| `worker/ActionIdentity.vibe` | 4/14 | 10/14 | 71.43% |
| `worker/ActionRuns.vibe` | 95/117 | 102/117 | 87.18% |
| `worker/ActionsHttp.vibe` | 3/41 | 40/41 | 97.56% |
| `worker/AgentModel.vibe` | 9/9 | 9/9 | 100.00% |
| `worker/Api.vibe` | 46/231 | 46/231 | 19.91% |
| `worker/Budget.vibe` | 20/22 | 20/22 | 90.91% |
| `worker/HistoryActions.vibe` | 17/33 | 18/33 | 54.55% |
| `worker/HistoryObject.vibe` | 6/60 | 44/60 | 73.33% |
| `worker/HistoryTools.vibe` | 8/8 | 8/8 | 100.00% |
| `worker/Http.vibe` | 65/93 | 77/93 | 82.80% |
| `worker/IssueCredentials.vibe` | 1/16 | 13/16 | 81.25% |
| `worker/Issues.vibe` | 148/271 | 153/271 | 56.46% |
| `worker/MainLog.vibe` | 29/43 | 29/43 | 67.44% |
| `worker/ObjectStorage.vibe` | 10/10 | 10/10 | 100.00% |
| `worker/Objects.vibe` | 61/107 | 88/107 | 82.24% |
| `worker/Reply.vibe` | 87/136 | 121/136 | 88.97% |
| `worker/SandboxAccounts.vibe` | 6/60 | 6/60 | 10.00% |
| `worker/SandboxHttp.vibe` | 4/30 | 26/30 | 86.67% |
| `worker/SandboxMachine.vibe` | 1/66 | 1/66 | 1.52% |
| `worker/SandboxTools.vibe` | 8/11 | 8/11 | 72.73% |
| `worker/Sandboxes.vibe` | 0/22 | 26/26 | 100.00% |
| `worker/Sequencer.vibe` | 101/118 | 106/118 | 89.83% |
| `worker/SpecificationReviewers.vibe` | 10/31 | 29/31 | 93.55% |
| `worker/Tour.vibe` | 4/5 | 5/5 | 100.00% |
| `worker/Unreachable.vibe` | 1/1 | 1/1 | 100.00% |
| `worker/VipDraft.vibe` | 4/30 | 27/30 | 90.00% |
| `worker/Wiki.vibe` | 97/152 | 98/152 | 64.47% |
| `worker/WikiDraft.vibe` | 4/32 | 29/32 | 90.62% |
| `worker/WikiTools.vibe` | 1/9 | 2/9 | 22.22% |
| `worker/agentContext.vibe` | 1/1 | 1/1 | 100.00% |
| `worker/budgetDecision.vibe` | 4/5 | 5/5 | 100.00% |
| `worker/index.vibe` | 13/13 | 13/13 | 100.00% |
| `worker/liveDispatchDecision.vibe` | 7/7 | 7/7 | 100.00% |
| `worker/replyProgressDecision.vibe` | 17/17 | 17/17 | 100.00% |
| `worker/replyReasons.vibe` | 7/7 | 7/7 | 100.00% |

Largest remaining line gaps:

- `worker/Api.vibe`: 185 uncovered of 231.
- `worker/Issues.vibe`: 118 uncovered of 271.
- `worker/Accounts.vibe`: 94 uncovered of 267.
- `src/web/main.vibe`: 82 uncovered of 636.
- `worker/SandboxMachine.vibe`: 65 uncovered of 66.
- `src/surfaces/signin.vibe`: 58 uncovered of 107.
- `worker/SandboxAccounts.vibe`: 54 uncovered of 60.
- `worker/Wiki.vibe`: 54 uncovered of 152.
- `src/surfaces/commands.vibe`: 44 uncovered of 168.
- `src/core/sandboxHost.vibe`: 34 uncovered of 181.
- `src/core/flows.vibe`: 20 uncovered of 165.
- `worker/Objects.vibe`: 19 uncovered of 107.
- `src/core/MockFactory.vibe`: 18 uncovered of 254.
- `src/web/historyApp.vibe`: 17 uncovered of 156.
- `worker/HistoryObject.vibe`: 16 uncovered of 60.

### Earlier corrected local timing roster before final History validation

This table comes only from the complete passing timing window, using explicit sync/async registration. Each row includes assertion cost. Shared nyc-01 host, JIT, GC and OS caches are uncontrolled. Milliseconds are client-observed work, not a server CPU profile. The method and limitations for every artifact follow the table. No instrumented measurement appears here.

| Artifact group / workload | Mean ms | Samples |
| --- | ---: | ---: |
| `account-cookie-admission/account-cookie-admission` | 0.486836 | 206 |
| `accounts-lifecycle/accounts-lifecycle` | 20.338092 | 3 |
| `accounts-transport/accounts-transport-faults` | 5.574782 | 18 |
| `accounts-workerd/workerd-account-session-grants` | 206.293167 | 3 |
| `accounts-workerd-faults/0/workerd-account-disabled` | 8.021312 | 3 |
| `accounts-workerd-faults/1/workerd-account-exchange-failure` | 204.339581 | 3 |
| `action-catalog/action-catalog` | 2.815653 | 36 |
| `action-host/action-host-recovery` | 415.002875 | 3 |
| `action-host-role-downgrade/action-host-role-downgrade` | 101.216258 | 3 |
| `action-kernels/action-kernels` | 0.170953 | 585 |
| `action-prepare/action-prepare` | 0.200484 | 499 |
| `action-tools/action-tools` | 8.559077 | 3 |
| `actions-view-matrix/actions-view-matrix` | 6.683932 | 15 |
| `agent-projection/agent-projection` | 0.084226 | 1188 |
| `budget/budget` | 0.486197 | 206 |
| `cli/0/--mock read --json` | 2018.995916 | 3 |
| `cli/1/--mock ask install --json` | 2439.026774 | 3 |
| `cli/2/--llms` | 1923.327556 | 3 |
| `cli/3/--help` | 1927.056008 | 3 |
| `commands/0/mock-agent-ask` | 279.219149 | 3 |
| `commands/1/read-command` | 0.262635 | 399 |
| `content-workerd/content-workerd` | 14501.287491 | 3 |
| `context-command-policies/context-and-command-decisions` | 0.179577 | 557 |
| `core-10/0/decide` | 0.007630 | 13107 |
| `core-10/1/apply` | 0.013596 | 7356 |
| `core-10/2/receive` | 0.010903 | 9172 |
| `core-10/3/replay-apply` | 0.018196 | 5496 |
| `core-10/4/replay-receive` | 0.014342 | 6973 |
| `core-1000/0/decide` | 0.019064 | 5246 |
| `core-1000/1/apply` | 0.022023 | 4541 |
| `core-1000/2/receive` | 0.018109 | 5523 |
| `core-1000/3/replay-apply` | 0.094481 | 1059 |
| `core-1000/4/replay-receive` | 0.098375 | 1017 |
| `core-100000/0/decide` | 0.983017 | 103 |
| `core-100000/1/apply` | 1.626703 | 62 |
| `core-100000/2/receive` | 1.606843 | 63 |
| `core-100000/3/replay-apply` | 9.227246 | 11 |
| `core-100000/4/replay-receive` | 19.434386 | 6 |
| `dispatcher-decisions/dispatcher-decisions` | 0.331688 | 302 |
| `drafts-workerd/drafts-workerd` | 11525.840688 | 3 |
| `factory-gates/factory-gates` | 0.111630 | 896 |
| `failure-views/failure-views` | 8.155314 | 13 |
| `history-10/0/history-decide` | 0.007569 | 13213 |
| `history-10/1/history-apply` | 0.020135 | 4967 |
| `history-10/2/history-decode` | 0.062992 | 1588 |
| `history-1000/0/history-decide` | 0.012495 | 8003 |
| `history-1000/1/history-apply` | 0.046310 | 2160 |
| `history-1000/2/history-decode` | 7.199768 | 14 |
| `history-100000/0/history-decide` | 0.996231 | 101 |
| `history-100000/1/history-apply` | 2.734177 | 37 |
| `history-100000/2/history-decode` | 612.492757 | 5 |
| `history-actions/history-actions` | 0.362511 | 276 |
| `history-bootstrap/history-bootstrap-graph` | 0.390276 | 257 |
| `history-browser-actions/history-first-render` | 419.103797 | 1 |
| `history-browser-actions/history-expand-epic` | 52.205648 | 1 |
| `history-browser-actions/history-next-page` | 66.376125 | 1 |
| `history-browser-actions/history-open-commit` | 118.492808 | 1 |
| `history-browser-actions/history-amend-and-escape` | 55.498171 | 1 |
| `history-browser-actions/history-amend-submit` | 117.866453 | 1 |
| `history-browser-actions/history-insert-before` | 117.126973 | 1 |
| `history-browser-actions/history-filter-keystroke` | 55.520923 | 1 |
| `history-browser-actions/history-plan` | 137.701112 | 1 |
| `history-browser-actions/history-start` | 63.822881 | 1 |
| `history-browser-actions/history-add-note` | 69.134947 | 1 |
| `history-browser-actions/history-approve` | 62.284928 | 1 |
| `history-browser-actions/history-fold` | 335.591176 | 1 |
| `history-browser-actions/history-viewer-controls` | 308.323465 | 1 |
| `history-browser-command-faults/history-browser-command-faults` | 1.701041 | 3 |
| `history-browser-commands/history-browser-commands` | 20.306471 | 3 |
| `history-catalog/history-catalog-calls` | 10.339811 | 3 |
| `history-flow-policies/history-flow-ordering` | 3.049155 | 33 |
| `history-flows/history-plan-start-note-approve-fold` | 17.831695 | 3 |
| `history-malformed-replay/history-malformed-replay` | 0.131443 | 761 |
| `history-page-boundaries/history-page-boundaries` | 0.440150 | 228 |
| `history-pages-10/0/history-outline` | 0.022132 | 4519 |
| `history-pages-10/1/history-epic-pages` | 0.025063 | 3990 |
| `history-pages-10/2/history-commit-page` | 0.009243 | 10820 |
| `history-pages-10/3/history-search` | 0.024680 | 4052 |
| `history-pages-10/4/history-page-codecs` | 0.102951 | 972 |
| `history-pages-1000/0/history-outline` | 0.116601 | 858 |
| `history-pages-1000/1/history-epic-pages` | 0.160025 | 625 |
| `history-pages-1000/2/history-commit-page` | 0.032379 | 3089 |
| `history-pages-1000/3/history-search` | 0.209833 | 477 |
| `history-pages-1000/4/history-page-codecs` | 7.004801 | 15 |
| `history-pages-100000/0/history-outline` | 15.635145 | 7 |
| `history-pages-100000/1/history-epic-pages` | 7.042671 | 15 |
| `history-pages-100000/2/history-commit-page` | 1.546404 | 65 |
| `history-pages-100000/3/history-search` | 15.995756 | 7 |
| `history-pages-100000/4/history-page-codecs` | 378.576178 | 5 |
| `history-recovery/history-retelling-recovery` | 0.834537 | 120 |
| `history-roles/history-role-matrix` | 0.093198 | 1073 |
| `history-seed/history-seed-decode` | 190.406781 | 3 |
| `history-surfaces/0/cli-history` | 2004.586567 | 3 |
| `history-surfaces/1/cli-plan` | 2220.904395 | 3 |
| `history-surfaces/2/mcp-history-plan-start-note` | 19.762731 | 3 |
| `history-tools/0/history-tool-lifecycle` | 21.441194 | 3 |
| `history-tools/1/history-tool-faults` | 0.253970 | 394 |
| `history-view-matrix/history-view-matrix` | 22.671717 | 5 |
| `history-web-10/0/history-filter-keystroke` | 0.026575 | 3763 |
| `history-web-10/1/history-open-epic-view` | 9.939143 | 3 |
| `history-web-1000/0/history-filter-keystroke` | 0.024381 | 4102 |
| `history-web-1000/1/history-open-epic-view` | 73.275223 | 3 |
| `history-web-1000/2/history-next-page-update` | 0.078971 | 1267 |
| `history-web-100000/0/history-filter-keystroke` | 0.031551 | 3170 |
| `history-web-100000/1/history-open-epic-view` | 6996.093727 | 3 |
| `history-web-100000/2/history-next-page-update` | 0.078558 | 1273 |
| `history-workerd/0/history-first-outline` | 253.454996 | 1 |
| `history-workerd/1/history-warm-outline` | 5.862779 | 3 |
| `history-workerd/2/history-detail-pages` | 21.623023 | 3 |
| `history-workerd/3/history-viewer-refusals` | 239.059884 | 3 |
| `history-workerd/4/history-protocol-errors` | 8.894238 | 3 |
| `history-workerd/5/history-keyed-call-replay` | 189.629622 | 3 |
| `http/http-boundaries` | 4.953674 | 21 |
| `identity-cli/cli-identity-journey` | 9220.446007 | 3 |
| `identity-labels/identity-labels` | 0.010093 | 9908 |
| `identity-mcp/mcp-identity-journey` | 694.641787 | 3 |
| `issues-commands/0/issues-read` | 9.055104 | 3 |
| `issues-commands/1/issues-new` | 7.434160 | 3 |
| `issues-commands/2/issues-comment` | 7.709782 | 3 |
| `issues-commands/3/issues-link` | 6.480054 | 3 |
| `issues-commands/4/issues-split` | 6.804370 | 3 |
| `issues-commands/5/issues-commit` | 5.994463 | 3 |
| `issues-commands/6/issues-uncommit` | 7.056915 | 3 |
| `issues-commands/7/issues-propose` | 6.948469 | 3 |
| `issues-commands/8/issues-accept` | 5.778851 | 3 |
| `issues-commands/9/issues-decline` | 7.691524 | 3 |
| `issues-commands/10/issues-draft` | 6.154480 | 3 |
| `issues-flows/issue-flow-journey` | 49.454639 | 3 |
| `issues-host-journey/issues-host-journey` | 659.128478 | 3 |
| `issues-host-recovery/issues-host-recovery` | 1520.098699 | 3 |
| `issues-identities/issue-identities` | 0.379254 | 264 |
| `issues-policy/issue-policy-corpus` | 0.346233 | 289 |
| `issues-reducer/issues-reducer` | 0.239921 | 417 |
| `issues-refusals/issue-refusals` | 26.831686 | 3 |
| `issues-view-matrix/issues-view-matrix` | 30.065863 | 5 |
| `local-browser/commandKMs` | 55.913810 | 3 |
| `local-browser/firstRenderMs` | 196.080968 | 3 |
| `local-browser/keystrokeMs` | 21.079141 | 3 |
| `local-browser-actions/hero-ready-frame` | 71.277162 | 1 |
| `local-browser-actions/hero-native-pause` | 8.537288 | 1 |
| `local-browser-actions/hero-native-play` | 8.383741 | 1 |
| `local-browser-actions/ask-button` | 69.573543 | 1 |
| `local-browser-actions/submit-settle-0` | 848.836517 | 1 |
| `local-browser-actions/submit-settle-1` | 806.443414 | 1 |
| `local-browser-actions/submit-settle-2` | 798.896628 | 1 |
| `local-browser-actions/submit-settle-3` | 801.533398 | 1 |
| `local-browser-actions/wheel-pause` | 26.685776 | 1 |
| `local-browser-actions/latest` | 65.829621 | 1 |
| `local-browser-actions/pause-Home` | 137.231108 | 1 |
| `local-browser-actions/pause-PageUp` | 84.477830 | 1 |
| `local-browser-actions/pause-ArrowUp` | 129.755574 | 1 |
| `local-browser-actions/pause-Control+Home` | 106.058159 | 1 |
| `local-browser-actions/pause-Meta+ArrowUp` | 145.232164 | 1 |
| `local-browser-actions/new-input-cancels-latest` | 275.593404 | 1 |
| `local-browser-actions/touch-pause` | 95.633006 | 1 |
| `local-browser-actions/actions-open` | 113.397089 | 1 |
| `local-browser-actions/actions-run-and-trace` | 111.456949 | 1 |
| `local-browser-actions/actions-cancel` | 71.164798 | 1 |
| `local-browser-actions/actions-rerun` | 131.907293 | 1 |
| `local-browser-actions/actions-escape-collapse` | 101.757684 | 1 |
| `local-browser-actions/home-expand-minimize` | 585.267528 | 1 |
| `local-browser-actions/learn-more` | 590.962942 | 1 |
| `local-browser-actions/tour-pause` | 61.321788 | 1 |
| `local-browser-actions/tour-resume` | 62.596430 | 1 |
| `local-browser-actions/tour-skip-2` | 80.548431 | 1 |
| `local-browser-actions/tour-skip-3` | 593.310781 | 1 |
| `local-browser-actions/tour-skip-4` | 511.526760 | 1 |
| `local-browser-actions/tour-skip-5` | 54.985500 | 1 |
| `local-browser-actions/tour-skip-6` | 65.242158 | 1 |
| `local-browser-actions/escape-tour` | 35.217995 | 1 |
| `local-browser-actions/wiki-maximize` | 1091.792534 | 1 |
| `local-browser-actions/wiki-minimize` | 66.970829 | 1 |
| `local-browser-actions/escape-wiki` | 3.729652 | 1 |
| `local-role-actions/role-view-viewer` | 29.198661 | 1 |
| `local-role-actions/role-view-new` | 1198.756246 | 1 |
| `local-role-actions/role-view-community` | 148.995365 | 1 |
| `local-role-actions/role-view-contributor` | 133.598407 | 1 |
| `local-role-actions/role-view-maintainer` | 150.266877 | 1 |
| `local-role-actions/account-menu-keyboard` | 70.109719 | 1 |
| `local-role-actions/promote-member` | 132.831677 | 1 |
| `local-role-actions/cancel-role-change` | 124.427714 | 1 |
| `local-role-actions/escape-role-dialog` | 45.433113 | 1 |
| `local-role-actions/demote-member` | 139.853763 | 1 |
| `local-role-actions/restore-member` | 133.457982 | 1 |
| `local-role-actions/sign-out` | 119.410000 | 1 |
| `local-role-actions/mock-sign-in` | 46.105000 | 1 |
| `local-role-actions/participation-promotes-community` | 464.633678 | 1 |
| `local-role-actions/retry-mock-sign-in` | 147.138710 | 1 |
| `local-wiki-actions/wiki-edit-maintainer` | 93.234202 | 1 |
| `local-wiki-actions/wiki-save` | 84.270028 | 1 |
| `local-wiki-actions/wiki-escape-maintainer` | 39.479010 | 1 |
| `local-wiki-actions/wiki-edit-contributor` | 75.829493 | 1 |
| `local-wiki-actions/wiki-propose` | 83.365280 | 1 |
| `local-wiki-actions/wiki-escape-contributor` | 86.668955 | 1 |
| `local-wiki-actions/wiki-role-change-closes-editor` | 31.682872 | 1 |
| `local-wiki-actions/wiki-agent-draft-review` | 786.000341 | 1 |
| `local-wiki-actions/wiki-agent-draft-propose` | 56.956214 | 1 |
| `machine-boundaries/machine-boundaries` | 0.313226 | 320 |
| `main-reducer-boundaries/main-reducer-boundaries` | 0.520811 | 193 |
| `maintenance-scripts/0/mythical-seed-write` | 384.539007 | 3 |
| `maintenance-scripts/1/mythical-seed-deterministic` | 409.938361 | 3 |
| `maintenance-scripts/2/mythical-seed-read-failures` | 578.651610 | 3 |
| `maintenance-scripts/3/agent-context-write` | 518.485936 | 3 |
| `maintenance-scripts/4/agent-context-check` | 254.862650 | 3 |
| `maintenance-scripts/5/agent-context-stale` | 254.380074 | 3 |
| `markdown/markdown-blocks` | 0.009512 | 10513 |
| `mcp/0/mcp-read` | 2032.108522 | 3 |
| `mcp/1/mcp-ask` | 2422.810324 | 3 |
| `mcp-warm/mcp-warm-read` | 0.792810 | 127 |
| `media-observe/media-observe` | 0.366545 | 273 |
| `mock-actions/mock-actions` | 33.555309 | 3 |
| `mock-close/mock-factory-close` | 0.242533 | 413 |
| `mock-history-agent/mock-agent-history` | 513.269571 | 3 |
| `mock-scripts/mock-scripts` | 0.053884 | 1856 |
| `mock-tour/0/mock-tour-complete` | 134431.369148 | 1 |
| `mock-tour/1/mock-tour-end` | 7.082414 | 3 |
| `model-config/model-config` | 0.717272 | 140 |
| `model-context-10/model-context-select-and-window` | 0.069818 | 1433 |
| `model-context-1000/model-context-select-and-window` | 1.275853 | 79 |
| `model-context-100000/model-context-select-and-window` | 215.066933 | 5 |
| `object-cancelled-receipt/object-cancelled-receipt` | 28.269409 | 3 |
| `object-host/object-post-alarm-recovery` | 308.158891 | 3 |
| `policies/flow-and-budget-policies` | 0.168826 | 593 |
| `protocol/0/event-encode` | 0.020386 | 4906 |
| `protocol/1/event-decode` | 0.015149 | 6602 |
| `protocol/2/snapshot-decode-10` | 0.119574 | 837 |
| `protocol/3/snapshot-decode-1000` | 7.569453 | 14 |
| `protocol/4/snapshot-decode-100000` | 502.474568 | 5 |
| `protocol/5/route-roundtrip` | 0.016994 | 5885 |
| `provider-guards/provider-guards` | 0.623166 | 161 |
| `provider-host-refusals/provider-host-refusals` | 7.432400 | 3 |
| `reply-progress-decisions/reply-progress-decisions` | 0.242664 | 413 |
| `resources/0/resources-dev` | 19.130489 | 3 |
| `resources/1/resources-production` | 8.121613 | 3 |
| `resources/2/resources-factory.example.test` | 6.665738 | 3 |
| `runtime/runtime-startup-post` | 1097.422955 | 3 |
| `sandbox-agent/sandbox-agent-bindings` | 17.562949 | 3 |
| `sandbox-browser-actions/sandbox-open-pane` | 42.571365 | 1 |
| `sandbox-browser-actions/sandbox-start` | 62.996938 | 1 |
| `sandbox-browser-actions/sandbox-terminal-write` | 120.453900 | 1 |
| `sandbox-browser-actions/sandbox-stop` | 63.503438 | 1 |
| `sandbox-browser-actions/sandbox-restart` | 64.523200 | 1 |
| `sandbox-browser-actions/sandbox-read-retained-bytes` | 122.002003 | 1 |
| `sandbox-browser-actions/sandbox-maximize` | 59.099709 | 1 |
| `sandbox-browser-actions/sandbox-minimize` | 50.819182 | 1 |
| `sandbox-browser-actions/sandbox-escape` | 3.094526 | 1 |
| `sandbox-browser-actions/sandbox-viewer-controls` | 1328.575811 | 1 |
| `sandbox-factory-1/sandbox-file-restart` | 25.381555 | 3 |
| `sandbox-factory-100/sandbox-file-restart` | 350.623165 | 3 |
| `sandbox-meter/sandbox-meter-and-policy` | 0.623607 | 161 |
| `sandbox-public-workerd/workerd-sandbox-viewer` | 11.150747 | 3 |
| `sandbox-surfaces/0/cli-sandboxes` | 2071.851993 | 3 |
| `sandbox-surfaces/1/cli-sandbox-start` | 1989.249427 | 3 |
| `sandbox-surfaces/2/mcp-sandbox-file-restart` | 24.159401 | 3 |
| `screen-protocol-policies/screen-protocol-mock-policies` | 0.370221 | 271 |
| `sequencer/sequencer-lifecycle` | 1.299664 | 77 |
| `session-live-refusals/session-live-refusals` | 324.421368 | 3 |
| `session-runtime/session-runtime` | 306.993061 | 3 |
| `session-settings/session-settings` | 14.097527 | 3 |
| `session-settings-faults/session-settings-faults` | 1.890322 | 3 |
| `shared-decisions/0/shared-decisions` | 0.296817 | 337 |
| `shared-decisions/1/mythical-lookups` | 0.046890 | 2133 |
| `shared-decisions/2/sandbox-policy-layers` | 0.023932 | 4179 |
| `site/site-routing` | 42.581079 | 3 |
| `specification/specification-review-journey` | 49.367658 | 3 |
| `startup-theatre-decisions/startup-theatre-decisions` | 0.179049 | 559 |
| `surface-failures/0/cli-failure---mock ask  ` | 2025.247790 | 3 |
| `surface-failures/1/cli-failure---mock read --after -1` | 2050.445165 | 3 |
| `surface-failures/2/cli-failure---wat` | 1888.252971 | 3 |
| `surface-failures/3/cli-failure-read` | 1824.974605 | 3 |
| `surface-failures/4/mcp-unreachable` | 1864.998504 | 3 |
| `transport/transport-fault-matrix` | 35.741428 | 5 |
| `walkthrough-controls/walkthrough-controls` | 0.539932 | 186 |
| `web-10/0/keystroke-update` | 0.008241 | 12135 |
| `web-10/1/incoming-event-update` | 0.008619 | 11603 |
| `web-10/2/view` | 7.454259 | 3 |
| `web-1000/0/keystroke-update` | 0.014896 | 6714 |
| `web-1000/1/incoming-event-update` | 0.027215 | 3675 |
| `web-1000/2/view` | 56.689897 | 3 |
| `web-100000/0/keystroke-update` | 0.007762 | 12884 |
| `web-100000/1/incoming-event-update` | 1.327744 | 76 |
| `web-100000/2/view` | 3149.872403 | 3 |
| `web-account-state/web-account-state` | 0.319248 | 314 |
| `web-actions/web-actions` | 2.453083 | 41 |
| `web-content-commands/web-content-commands` | 48.615226 | 3 |
| `web-execution-commands/web-execution-commands` | 36.813900 | 3 |
| `web-issue-state/web-issue-state` | 2.516389 | 40 |
| `web-wiki-state/web-wiki-state` | 0.237603 | 421 |
| `wiki-cli/0/cli-wiki-read` | 2010.983716 | 3 |
| `wiki-cli/1/cli-wiki-draft` | 2041.858560 | 3 |
| `wiki-cli/2/cli-wiki-save` | 2105.559407 | 3 |
| `wiki-cli/3/cli-wiki-propose` | 2073.312253 | 3 |
| `wiki-edit-journeys/wiki-edit-journeys` | 35.487412 | 3 |
| `wiki-host-journey/wiki-host-journey` | 447.602940 | 3 |
| `wiki-host-recovery/wiki-host-recovery` | 1095.484333 | 3 |
| `wiki-mcp/0/mcp-wiki-read-readback` | 17.904396 | 3 |
| `wiki-mcp/1/mcp-wiki-draft-readback` | 7.522182 | 3 |
| `wiki-mcp/2/mcp-wiki-save-readback` | 9.059243 | 3 |
| `wiki-mcp/3/mcp-wiki-propose-readback` | 9.330901 | 3 |
| `wiki-script/wiki-script-journey` | 928.571918 | 3 |
| `wiki-view-matrix/wiki-view-matrix` | 10.785725 | 10 |
| `workerd/0/workerd-post-reply-read` | 476.207996 | 3 |
| `workerd/1/workerd-tour` | 135424.801135 | 3 |
| `workerd-actions (withdrawn)/workerd-actions (withdrawn)` | — | — |
| `workerd-sandboxes/0/workerd-sandbox-ledger` | 560.959669 | 3 |
| `workerd-sandboxes/1/workerd-sandbox-meter` | 256.374582 | 3 |
| `workerd-sandboxes/2/workerd-sandbox-public` | 7.509234 | 3 |

Deterministic gate: complete roster of indexed entry reads, `ceil(baseline × 1.05)` tolerance; zero stays zero. It does not gate noisy latency or detect uninstrumented work. Two real-runner controls additionally check exact callback counts and serial execution; they emit no latency artifact. Chromium first-render/Command-K/keystroke rows summarize three raw wall-time samples; individual action rows are single observations, not distributions.

**account-cookie-admission** — `2026-11-09T15-12-09.810Z-account-cookie-admission.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:09.810Z`. Vitest built-in bench; production cookie-name and admission functions. Exact secure/local names, three hosted origins, four loopback origins, 1/4096/4097-character values, eleven invalid/noncanonical origins, invalid characters and line terminators checked in every callback. Setup and assertions included. Limitations: Pure URL/cookie syntax admission; does not establish a valid signature, identity, broker exchange, role, real OAuth or production session. No network, request interception or credential used.

**accounts-lifecycle** — `2026-11-09T15-12-06.355Z-accounts-lifecycle.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:06.355Z`. Vitest built-in bench; actual product MockAccounts, policy and durable role-grant engine. Verify literal five-person fixture, once-only participation, duplicate no-op grant, promotions/demotions, final-maintainer/self-promotion refusals, complete five-event replay, identity schema round trip and sign-out. Three new scoped engines; initialization/assertions included. Limitations: Product fixture identity, not GitHub OAuth, production session cryptography or remote storage. One callback is the complete lifecycle, not a per-command latency.

**accounts-transport** — `2026-11-09T15-12-06.593Z-accounts-transport.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:06.593Z`. Vitest built-in bench; actual LiveAccounts adapter with an injected faulty Effect HttpClient. Seven operations across transport loss, forbidden/unavailable statuses, malformed JSON/protocol/SSE and bodyless 204; exact success/failure tags and bounded typed errors checked. Limitations: No request interception or real network. Invalid upstream answers measure failure handling, not GitHub sign-in success or WAN latency.

**accounts-workerd** — `2026-11-09T15-09-22.874Z-accounts-workerd.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:09:22.874Z`. Vitest built-in bench; real production account service, cookie signatures, SQLite sessions, durable role grants and current sandbox authority in local workerd. Each of three samples uses fresh signed/expired fixture sessions and a unique person; check tamper/expiry, self-promotion refusal, maintainer grant, current role, cross-origin refusal/unchanged state, People and session revocation; browser sign-in remains unavailable without broker configuration. Host startup excluded; requests/assertions included. Limitations: Only the unshipped test host issues fixture sessions with real signatures. This does not benchmark successful GitHub OAuth/consent, provider latency or production credentials. No cookie/token values enter artifacts; all configuration is synthetic.

**accounts-workerd-faults** — `2026-11-09T15-09-25.645Z-accounts-workerd-faults.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:09:25.645Z`. Vitest built-in bench; actual account configuration/router and journaled sign-in/callback flows in local workerd. Three samples each: missing configuration stays viewer/503; configured device route remains usable while missing broker configuration refuses browser sign-in; a real signed fixture person connects credentials with PKCE, then an injected faulty Effect GitHub exchange yields a visible failure redirect, consumed state/refused replay, cleared state cookie and no new session cookie. Original person session survives. Redirect following disabled. Startup excluded; crypto/storage/requests/assertions included. Limitations: The production GitHub service is replaced only by the existing host's explicit failing Effect service. No request interception, GitHub request, real login or successful provider exchange. Synthetic secrets/cookies remain in memory and are omitted from artifacts.

**action-catalog** — `2026-11-09T15-11-39.732Z-action-catalog.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:39.732Z`. Vitest built-in bench; every bundled flow declaration's presentation, command, minimum role and input kind, with the shared mayRun gate evaluated for all five roles per entry. Limitations: Presentation/policy cost only; a run's durable execution is benchmarked through the mock and workerd action surfaces.

**action-host** — `2026-11-09T15-11-44.535Z-action-host.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:44.535Z`. Vitest built-in bench; actual production action index/per-run hosts with real SQLite and product MockAccounts/Mythical services. Check once-only post acceptance, changed-input conflict, correlated terminal Post/Reply traces after two alarms, and cancelling a queued Plan before admission without any history mutation. Three new scoped worlds, migrations and assertions included. Limitations: Node SQLite/KV/alarm adapter, no workerd scheduling or remote storage. Deliberately unconfigured model fails the reply; no inference or GitHub mutation. The product mock provides local accounts/history.

**action-host-role-downgrade** — `2026-11-09T15-11-44.961Z-action-host-role-downgrade.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:44.961Z`. Vitest built-in bench; accept a real SQLite-backed history action, revoke its owner's role through product account flows, drive two alarms, then compare the terminal permission refusal and unchanged empty history. Three fresh worlds, setup and assertions included. Limitations: Product mock identities, no OAuth/provider call. Node SQLite/alarm host; measures admission/recovery overhead without a model.

**action-kernels** — `2026-11-09T15-11-39.478Z-action-kernels.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:39.478Z`. Vitest built-in bench; run snapshot/step acceptance orderings, terminal settle and cancellation, engine upsert identity and replay, pending acknowledgement identity, and VIP document authorship/path truth tables. Assertions included. Limitations: Pure in-process decisions; the durable action surface runs in the workerd benchmark.

**action-prepare** — `2026-11-09T15-11-39.971Z-action-prepare.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:39.971Z`. Vitest built-in bench; every invocation kind's schema preparation with client/operation identity defaults, then not-found and invalid-input failures as typed ActionFailures. Limitations: In-process preparation; the dispatch into durable engines is benchmarked through the mock and workerd action surfaces.

**action-tools** — `2026-11-09T15-11-40.340Z-action-tools.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:40.340Z`. Vitest built-in bench; all four actual action FlowBinding handlers invoked with real harness call identities and declaration digests over the product mock actions service; start announces its first run snapshot, read returns it and cancel acknowledges. Limitations: Binding/handler boundary without model selection or QuickJS; the same declarations serve CLI and MCP surfaces.

**actions-view-matrix** — `2026-11-09T15-11-34.639Z-actions-view-matrix.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:34.639Z`. Vitest built-in bench; Foldkit scenes render the actions pane collapsed with its latest badge, open and empty, the failed-run trace, per-selection run control and maximized state; merge/selection/completion decisions checked against slower or terminal snapshots. Limitations: Scene rendering and pure decisions; live runs stream through the mock and workerd action benchmarks.

**agent-projection** — `2026-11-09T15-12-00.047Z-agent-projection.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:00.047Z`. Vitest built-in bench; project partial cell answers, restart, sum token usage, bound input history and classify provider failures without disclosing messages. Limitations: Projection and policy only; actual agent and QuickJS cell execution measured in workerd.

**budget** — `2026-11-09T15-12-01.562Z-budget.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:01.562Z`. Vitest built-in bench; real budget over in-memory ledger; rounding/clamping, duplicate spend, admission at limit and exact ledger asserted. Limitations: In-process ledger; remote Durable Object transport excluded.

**cli** — `2026-11-09T15-03-42.259Z-cli.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:03:42.259Z`. Vitest built-in bench; spawn emitted CLI to exit with stdout/stderr capture; three samples per command, no warmup. Build excluded; loader/process startup included. Limitations: Mock backend for ask/read; no network/model. Source package loading contributes to startup.

**commands** — `2026-11-09T15-03-17.211Z-commands.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:03:17.211Z`. Vitest built-in bench; new scoped MockFactory/engine per call. Ask includes real scripted delays and settled answer; Read includes schema validation and layer lifecycle. Limitations: Product mock mode; no backend/model. Ask timing includes intentional 25ms per scripted chunk.

**content-workerd** — `2026-11-09T15-06-35.887Z-content-workerd.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:06:35.887Z`. Vitest built-in bench; each of three unwarmed samples starts fresh real workerd issue and wiki hosts. HTTP/SQLite commitments replay once; credentials are encrypted/session-bound/current-role/expiring; paid failed drafts charge once; partial write retryFrom adopts exactly one original child. Wiki draft privacy, contributor proposal/replay, forbidden Save, unchanged Markdown and one completed proposal journal row checked. Bundling, server lifecycle and assertions included. Limitations: Existing unshipped host supplies product fixture identities/repository; typed faulty Effect services exercise paid failures and partial recovery. No real GitHub write, OAuth or Container. Whole fresh-host corpus cost includes bundling and startup; it is not per-request latency or model inference.

**context-command-policies** — `2026-11-09T15-11-51.573Z-context-command-policies.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:51.573Z`. Vitest built-in bench; prompt eligibility, first duplicate identity, source-order indexes/windowing and correlated CLI/MCP collection through unrelated events, restart, finish/failure. Complete expected selections, answer fields/event numbers and outcome/error precedence checked. Limitations: Small in-process decision corpus, no model/IPC or service execution. Assertions included; large transcript cost is measured separately.

**core-10** — `2026-11-09T15-11-00.392Z-core-10.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:00.392Z`. Vitest built-in bench; 10 completed posts for single transitions; replay has exactly 10 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**core-1000** — `2026-11-09T15-11-01.201Z-core-1000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:01.201Z`. Vitest built-in bench; 1000 completed posts for single transitions; replay has exactly 1000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**core-100000** — `2026-11-09T15-11-02.033Z-core-100000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:02.033Z`. Vitest built-in bench; 100000 completed posts for single transitions; replay has exactly 100000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**dispatcher-decisions** — `2026-11-09T15-11-54.257Z-dispatcher-decisions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:54.257Z`. Vitest built-in bench; all eight storage-mark combinations for three ordered posts, exact independently listed first candidate, single attempted start/refusal and terminal no-op, plus empty queue. Assertions included. Limitations: Pure dispatcher decisions only; storage probes and durable starts are measured in object-host/workerd workloads.

**drafts-workerd** — `2026-11-09T15-07-45.238Z-drafts-workerd.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:07:45.238Z`. Vitest built-in bench; three fresh native workerd worlds run production VIP draft, wiki draft and specification reviewer AgentActions, SDK model HTTP/SSE, QuickJS and SQLite over one deterministic local model service. Exact schema answers, six metered tokens, three HTTP model calls and cached replay with no further call checked. Bundling/startup/assertions included. Limitations: Deterministic model responses measure flow/agent overhead without inference or WAN. No GitHub write, OAuth, Container or real provider spending. Whole fresh-host corpus is not per-request latency.

**factory-gates** — `2026-11-09T15-12-14.894Z-factory-gates.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:14.894Z`. Both acceptance predicates over the accepted fixture, sixteen single-review refusals including B+, keep and reset revision policies and person/agent approval; assertions included. Limitations: In-process decisions; excludes model inference, transport and storage.

**failure-views** — `2026-11-09T15-11-56.240Z-failure-views.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:56.240Z`. Vitest built-in bench; render every declared post failure and connection/tour failure with accessible retry/reconnect controls. Limitations: Scenes from state-machine client fixtures; no transport interception.

**gate** — `2026-11-09T15-12-05.462Z-gate.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:05.462Z`. Indexed entry reads through a transparent Proxy on completed-post fixtures of 10/1000/100000 entries. Correctness checked after counter capture. Allowed increase: ceil(baseline * 1.05); zero stays zero; exact roster required. Limitations: Counts entry access, not instruction count, allocations, network or latency; additional uninstrumented work requires timing review.

**history-10** — `2026-11-09T15-10-52.736Z-history-10.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:52.736Z`. Vitest built-in bench; 10 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**history-1000** — `2026-11-09T15-10-53.271Z-history-1000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:53.271Z`. Vitest built-in bench; 1000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**history-100000** — `2026-11-09T15-10-57.905Z-history-100000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:57.905Z`. Vitest built-in bench; 100000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**history-actions** — `2026-11-09T15-10-17.487Z-history-actions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:17.487Z`. Vitest built-in bench; history reducer corpus for page/read responses, forms, navigation/write intents, success/refusal, retries, late/detached data and events. Independent field, command-count and identity assertions; real commands execute in Chromium separately. Limitations: Reducer/command construction cost, no network or durable execution. Pages are actual projections of a two-commit fixture.

**history-bootstrap** — `2026-11-09T15-12-16.809Z-history-bootstrap.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:16.809Z`. Vitest built-in bench; three-commit first-parent/merge graph with rejected and landed queue entries; exact first-parent incremental order/cursor handling, bucket order/mapping, evidence, complete bootstrap and lossless seed projection/replay checked. Limitations: Small deterministic real-commit fixture; actual large committed snapshot decode measured separately; no GitHub call or repository mutation.

**history-browser-actions** — `2026-11-09T15-05-40.923Z-history-browser-actions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:05:40.923Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial Chromium journey over the full committed history and real MockMythical durable flows. Bootstrap, scripted work and automation included; no percentile. Fold changes only the product mock, never a real repository. Viewer UI omits writes; live writes are benchmarked as actual workerd refusals.

**history-browser-command-faults** — `2026-11-09T15-12-12.640Z-history-browser-command-faults.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:12.640Z`. Vitest built-in bench; typed faulty Effect Mythical service, four browser reads and five writes under both permission and transport failures. All exact message/reason projections and redaction checked. Three full corpora, setup/assertions included. Limitations: Deliberate service failures, no request interception or successful provider simulation; no network, repository writes or model.

**history-browser-commands** — `2026-11-09T15-12-12.543Z-history-browser-commands.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:12.543Z`. Vitest built-in bench; actual History Command effects over MockMythical's memory engine from empty history. Outline, Plan, epic/search, Start/Note/Approve/Fold and commit/missing detail; exact command messages, retained fields, notes, fold SHA and final six-event outline checked. Three fresh scoped engines, assertions included. Limitations: Shipped product mock main, no GitHub mutation, network, OAuth or actual repository fold. Command Effects without browser layout/DOM focus.

**history-catalog** — `2026-11-09T15-11-28.554Z-history-catalog.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:28.554Z`. Vitest built-in bench; real harness call identities/declaration digests invoke all four actual FlowBinding handlers and a populated outline reread after writes, including schema validation and result encoding; fresh product history engine, exact outputs and resulting signed note checked. Three samples. Limitations: No model selection or QuickJS process; this measures the binding/handler boundary directly. Real durable history flows run behind the binding.

**history-flow-policies** — `2026-11-09T15-11-51.324Z-history-flow-policies.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:51.324Z`. Vitest built-in bench; five roles × seven actions × human/agent; independent minimum-role matrix, authorization once, recording forbidden before authorization, single record except repeated fold, and illegal states checked. Limitations: Pure journal/policy decisions; actual durable flows and storage are separate workloads. Assertions included.

**history-flows** — `2026-11-09T15-10-58.062Z-history-flows.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:58.062Z`. Vitest built-in bench; actual MockMythical, sequencer and in-memory durable engine; plan/create epic, start, note, human approval and merge-queue fold; outline/detail composition and complete event replay equality checked. Three fresh engines. Limitations: Explicit human maintainer in a local fixture; product agent permission is measured separately. No real repository write or provider call.

**history-malformed-replay** — `2026-11-09T15-12-04.390Z-history-malformed-replay.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:04.390Z`. Vitest built-in bench; ten invalid event shapes across all seven event kinds, each checked as next, duplicate and gap. Invalid next content advances only the cursor; duplicates/gaps retain the original object and full state. Limitations: Pure replay boundary, deliberately malformed events; not storage transport corruption or authenticated admission.

**history-page-boundaries** — `2026-11-09T15-11-12.532Z-history-page-boundaries.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:12.532Z`. Vitest built-in bench; reversed physical commit array across two epics, notes and three real folds; exact stack order/counts/details, missing/negative cursor behavior, all four valid route/URI round trips, malformed Unicode path refusals and status classes checked. Limitations: Small deterministic projection/protocol corpus; no network or history mutation.

**history-pages-10** — `2026-11-09T15-11-08.069Z-history-pages-10.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:08.069Z`. Vitest built-in bench; 10 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**history-pages-1000** — `2026-11-09T15-11-08.866Z-history-pages-1000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:08.866Z`. Vitest built-in bench; 1000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**history-pages-100000** — `2026-11-09T15-11-12.307Z-history-pages-100000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:12.307Z`. Vitest built-in bench; 100000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**history-recovery** — `2026-11-09T15-12-04.142Z-history-recovery.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:04.142Z`. Vitest built-in bench; bootstrap a landed commit and pending sibling, reopen/amend, insert before sibling, refuse invalid plans, start/note/approve and fold exact trailer. Recreate the real sequencer over the same memory store; compare full independent expected state, every event, replay, schema round trip and duplicate identity. Each callback owns a new store. Limitations: In-memory durable-store contract and sequencer; no SQLite restart, repository write, network or model. Assertions and fresh store construction included.

**history-roles** — `2026-11-09T15-10-58.987Z-history-roles.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:58.987Z`. Vitest built-in bench; all five roles, human and agent; every agent forbidden to approve/fold, every role allowed to read, only human maintainer allowed to approve. Limitations: Pure policy cost; signed-in identity is a separate integration boundary.

**history-seed** — `2026-11-09T15-10-58.745Z-history-seed.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:58.745Z`. Vitest built-in bench; decode the actual committed VibeLang bootstrap projection; validate unique mythical identities, every real-commit mapping and the final main cursor. Three samples; module cached after its first import. Limitations: Snapshot parsing and validation, not a fresh network/GitHub import or bootstrap from an empty durable object.

**history-surfaces** — `2026-11-09T15-04-42.015Z-history-surfaces.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:04:42.015Z`. Vitest built-in bench; emitted CLI history/plan include startup and full committed bootstrap; persistent real MCP plan/start/note/history includes schema/IPC and four flows/calls. Three samples each, no warmup; exact detail, note author and unchanged main checked. Limitations: Product mock history, no repository mutation or model. MCP history grows by one planned commit per sample; handshake/bootstrap excluded from its timing.

**history-tools** — `2026-11-09T15-11-26.571Z-history-tools.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:26.571Z`. Vitest built-in bench; real tool catalog, product MockMythical and durable plan/start/note plus all four paged reads; contributor retell refusal, signed note, missing-input defaults and injected faulty Effect service. Three fresh lifecycle engines; fault handling short-run warmup. Limitations: Tool/flow overhead, no model inference or production storage. No approve/fold binding exists. Actual model choice and calls to these bindings inside QuickJS are not measured here.

**history-view-matrix** — `2026-11-09T15-11-33.453Z-history-view-matrix.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:33.453Z`. Vitest built-in bench; Foldkit scenes render the history list, epic, commit and plan pages across roles, states, filters, errors and dialog variants with exact control presence/absence assertions; refusal wording table included. Limitations: Scene rendering without layout/paint; the same journeys with real events run in Chromium and workerd benchmarks.

**history-web-10** — `2026-11-09T15-09-55.211Z-history-web-10.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:09:55.211Z`. Vitest built-in bench; 10 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**history-web-1000** — `2026-11-09T15-09-55.808Z-history-web-1000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:09:55.808Z`. Vitest built-in bench; 1000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**history-web-100000** — `2026-11-09T15-10-17.229Z-history-web-100000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:17.229Z`. Vitest built-in bench; 100000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**history-workerd** — `2026-11-09T14-54-05.950Z-history-workerd.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T14:54:05.950Z`. Vitest built-in bench; actual History Durable Object with full committed bootstrap, real SQLite durable flows and LiveMythical HTTP. First read measured once on a fresh object; warm outlines, first/second epic pages, commit detail, bounded search, five viewer refusals plus unchanged outline, and protocol errors measured three times. A keyed Plan binding runs twice with the same real cell identity and once with a new ordinal; exact cached response, one/two matching commits and cursor increments asserted across real SQLite flows. Server/bundler startup excluded; schema/assertions included. Limitations: Local workerd, no production network or model. First read is object bootstrap, not a forced cold isolate. Anonymous callers are viewers on this revision, so public writes remain forbidden; the separate keyed replay uses the test host’s trusted maintainer agent and actual production reader/binding/SQLite write path. No sign-in or GitHub write is claimed.

**http** — `2026-11-09T15-12-11.448Z-http.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:11.448Z`. Vitest built-in bench; real handler and sequencer; valid post/read/tour/end/events routing, body size/schema/name checks including lengthless multi-byte history overflow, cursor bounds, duplicate, and injected faulty Effect service returning Unreachable. Exact status and accepted state asserted. Limitations: In-process HTTP objects, no TCP; SQLite/durable engine covered in workerd.

**identity-cli** — `2026-11-09T15-08-14.573Z-identity-cli.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:08:14.573Z`. Vitest built-in bench; three complete journeys, four emitted CLI processes each, fresh scoped private settings. Decode every public schema, check signed fixture identity, settled answer, first/repeated logout and removed session file. Includes startup, durable session actions, scripted reply and assertions; build excluded. Limitations: Product mock sign-in, no OAuth, network, real session or model. This is whole-journey cost, not one-command latency. Private settings paths and contents are not retained.

**identity-labels** — `2026-11-09T15-07-46.790Z-identity-labels.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:07:46.790Z`. Vitest built-in bench; three literal guest/person/agent cases per callback over the production label decision, assertions included. Limitations: Pure presentation rule; does not prove signature validity, provider identity or role authority.

**identity-mcp** — `2026-11-09T15-08-19.052Z-identity-mcp.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:08:19.052Z`. Vitest built-in bench; persistent actual stdio MCP, discovery/startup excluded. Three five-call journeys: login, signed ask, logout, guest ask and full readback; literal author labels and exact settled reply count checked. Durable session actions, private file IO, schema/IPC, scripted replies and assertions included. Limitations: Isolated product mock settings, no OAuth/network/real session/model. Transcript grows by two posts per sample. Whole-journey cost, no percentile claim.

**issues-commands** — `2026-11-09T15-11-46.749Z-issues-commands.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:46.749Z`. Vitest built-in bench; each of eleven real product fixture issue commands from a fresh memory flow engine, nineteen committed fixture rows and maintainer identity. Three unwarmed samples each, with engine initialization, authorization, command, teardown and assertions included; exact affected row, cursor, unrelated rows and creation count checked. Limitations: Local product fixture host, no GitHub request, sign-in, network or model. Fresh-engine costs differ from a persistent UI session and successful writes do not claim production GitHub latency.

**issues-flows** — `2026-11-09T15-11-46.168Z-issues-flows.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:46.168Z`. Vitest built-in bench; fresh real makeIssueFactory, memory flow engine and host per callback; all eleven operations, retained intermediate writes, exact sequence, idempotent replay, literal proposal document, unchanged unrelated issues and complete schema equality. Three unwarmed whole-journey samples; initialization/assertions included. Limitations: Product fixture mode: no GitHub write, sign-in, repository review, network or model. One callback contains the entire journey; its latency is not a per-command latency.

**issues-host-journey** — `2026-11-09T15-10-21.419Z-issues-host-journey.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:21.419Z`. Vitest built-in bench; real serveIssues/executeIssues with SQLite, actual fixtureHost and changing Effect identity. Fresh world per sample; public projection strips untrusted approval, new/replay/changed request, human approval, saved receipt, revoked/agent writes, specification revision and missing reviewer checked. Exact HTTP statuses, retained body, once-only creation, approval and revision history asserted. Setup/assertions included. Limitations: Node HTTP values and real in-memory SQLite; no TCP, workerd scheduling, GitHub/OAuth or model. Product fixture host is explicitly injected. Whole journey is not per-command latency.

**issues-host-recovery** — `2026-11-09T15-10-26.102Z-issues-host-recovery.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:26.102Z`. Vitest built-in bench; production HTTP/SQLite issue adapter, fifteen injected typed Effect host failures, then a real fixture creation after explicit native retryFrom. Cached failure cannot retry implicitly; changed payload refused; exact matching recovery, replay, saved operation and missing receipt checked against unchanged fixture rows. Three fresh worlds; all assertions included. Phase-only diagnostic logs disabled. Limitations: Fault injection fails before the shipped fixture host; no own-code request interception, GitHub mutation or OAuth. Node SQLite in memory, no network/model. This is a complete fault/recovery corpus cost.

**issues-identities** — `2026-11-09T15-11-46.973Z-issues-identities.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:46.973Z`. Vitest built-in bench; actual Effect WebCrypto durable execution/recovery identity helpers checked against fixed SHA-256 vectors independently calculated with Python hashlib at authoring time of the canonical namespaced actor/operation/key tuples. Three operation identities and one recovery identity per callback. Limitations: Local digest and identity overhead, not a recovered remote execution or GitHub write.

**issues-policy** — `2026-11-09T15-11-46.411Z-issues-policy.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:46.411Z`. Vitest built-in bench; literal five-role by eleven-operation permission table, next/duplicate/gap projection, valid tree and self/missing/cycle refusals, all review label/close recovery states and request schema equality. Assertions included. Limitations: Pure policy/codec overhead with the nineteen-issue committed fixture; no storage, browser, GitHub or model.

**issues-reducer** — `2026-11-09T15-11-33.730Z-issues-reducer.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:33.730Z`. Vitest built-in bench; the full issues control table: navigation, filters, wizard steps with each validation, per-role forms and dialogs, saved-action retry identity and recovery keys, and request construction. Limitations: Pure reducer; the durable flows and views are benchmarked separately.

**issues-refusals** — `2026-11-09T15-11-47.156Z-issues-refusals.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:47.156Z`. Vitest built-in bench; actual product fixture engine with Effect-backed changing identity and participation service. Replay a cached commitment after downgrade to viewer, then assert eight exact domain refusals and unchanged state; successful new/comment call participation twice with exact identity. Three fresh engines; all assertions included. Limitations: Local authorization/domain boundary, no sign-in provider or GitHub request. Identity is a host-injected Effect service; no request interception.

**issues-view-matrix** — `2026-11-09T15-11-34.105Z-issues-view-matrix.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:34.105Z`. Vitest built-in bench; Foldkit scenes over the real app update/view render the issues pane list kinds, state and query filters, detail with notes and VIP review, commit/split/link dialogs, new and VIP wizard steps, the role matrix, connect gating, loading, failure and inline errors. Limitations: Scene rendering without layout/paint or a GitHub call; the write boundary runs in the issues fixture and workerd benchmarks.

**local-browser** — `2026-11-09T15-05-28.396Z-local-browser.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:05:28.396Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: Product mock mode, fresh browser context, shared browser/OS caches and automation overhead; no forced cold cache.

**local-browser-actions** — `2026-11-09T15-05-38.722Z-local-browser-actions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:05:38.722Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native-browser journey with real Foldkit and product MockFactory; timings include scripted delays and automation. External docs content is not asserted; only the correct pane URL and controls. Video timing begins after navigation; ready-state/decoded-frame observation and native programmatic pause/play include automation, browser caches and software decode, without physical control interaction. Touch is dispatched as native synthetic DOM events, not physical hardware. Single observations establish no percentile.

**local-role-actions** — `2026-11-09T15-05-48.637Z-local-role-actions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:05:48.637Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native-browser journey over the real product fixture account/role flows. Each role visit includes selection, identity visibility and (for signed roles) opening/checking/closing People. Other actions include confirmation or cancellation and resulting state. Sign-in/retry use the explicit mock identity host; no GitHub login, production identity, account mutation or model. Scripted reply/automation delays included; one observation per action establishes no percentile.

**local-wiki-actions** — `2026-11-09T15-05-51.405Z-local-wiki-actions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:05:51.405Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native Chromium journey through real product fixture flows. Maintainer Save and contributor Propose each open a review and preserve repository Markdown; reopening checks the original source. Escape, role revocation and a scripted agent draft are checked. No real GitHub writes, OAuth or model. Scripted waits and automation included; one sample per action establishes no percentile.

**machine-boundaries** — `2026-11-09T15-12-15.682Z-machine-boundaries.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:15.682Z`. Vitest built-in bench; complete reply/restart/tour lifecycles, admission boundaries, malformed replay, optimistic failure/retry/confirmation/gap/duplicate delivery; assertions included. Limitations: In-process state machine; not exhaustive input enumeration or proof.

**main-reducer-boundaries** — `2026-11-09T15-11-34.902Z-main-reducer-boundaries.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:34.902Z`. Vitest built-in bench; issue connection state with resume links, durable wiki visits with pane/people restoration and epoch reuse, action dispatch gating by selection and in-flight starts, slash dispatch clearing the draft, and sandbox start/stop/terminal controls with busy and blank-command refusals; exact emitted commands checked. Limitations: Reducer and command construction; the commands' durable execution is benchmarked through the mock factory.

**maintenance-scripts** — `2026-11-09T15-10-51.351Z-maintenance-scripts.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:51.351Z`. Vitest built-in bench; spawn each emitted script to exit over a real fixture jj repository and merge queue (seed) or the real installed vibelang skill (agent context); three samples each, no warmup. Fixture repository/queue construction is untimed setup. Write determinism, failed-read preservation and stale rejection are checked inside timed callbacks; the seed's parsed history content is fully asserted. Limitations: Fixture jj repositories, not VibeLang's real history; the full-history run's cost is dominated by its repository, not this fixture. Scripts write only inside the ignored dist-script-tests tree. Process/loader startup included; build excluded.

**markdown** — `2026-11-09T15-10-43.313Z-markdown.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:43.313Z`. Vitest built-in bench; parse a paragraph/code/paragraph answer; compare complete blocks. Limitations: Small fixed answer; rendering is measured separately.

**mcp** — `2026-11-09T15-03-55.730Z-mcp.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:03:55.730Z`. Vitest built-in bench; new emitted stdio server, real MCP initialize/discovery/call, validated schema and result; three samples, no warmup. Limitations: Includes process startup, handshake and teardown; mock backend; warm persistent-session call latency is measured separately.

**mcp-warm** — `2026-11-09T15-04-26.881Z-mcp-warm.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:04:26.881Z`. Vitest built-in bench; initialize and discover once outside timing; measure read calls on the same real stdio process, asserting the complete empty snapshot. Limitations: Product mock backend; schema/protocol/IPC included, startup/teardown excluded.

**media-observe** — `2026-11-09T15-12-17.653Z-media-observe.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:17.653Z`. Vitest built-in bench; actual media observation service for all image/video loaded/failed outcomes. Each counter dimension increases exactly one; capture and compare complete bounded log messages. Assertions and logger lifecycle included. Limitations: Effect telemetry boundary only; does not measure image download or video decode.

**mock-actions** — `2026-11-09T15-11-40.182Z-mock-actions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:40.182Z`. Vitest built-in bench; product MockActions over MockFactory: catalog, command table, button and slash starts, follow to settlement, per-flow runs, direct read, unknown command, invalid JSON input, missing run, cancellation and rerun. Three unwarmed samples. Limitations: Product mock backend; no model, network or workerd isolation. The same protocol against the real Worker runs in the workerd actions benchmark.

**mock-close** — `2026-11-09T15-03-11.432Z-mock-close.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:03:11.432Z`. Vitest built-in bench; build and close actual Factory scope, then verify a post is refused as unavailable. Limitations: Lifecycle cost, no model or network.

**mock-history-agent** — `2026-11-09T15-11-28.385Z-mock-history-agent.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:28.385Z`. Vitest built-in bench; fresh real MockFactory per sample, committed history decoded, journaled show tool, naturally streamed answer; exact repository main and epic counts independently composed and checked. Limitations: Product mock mode; three samples include intentional reply delays and history decode. No provider/model or network.

**mock-scripts** — `2026-11-09T15-03-11.204Z-mock-scripts.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:03:11.204Z`. Vitest built-in bench; script selection including fallback, reconstruct every selected reply from chunks. Limitations: Fixed synthetic prompts; syntax compilation remains in the separate unit suite.

**mock-tour** — `2026-11-09T15-03-10.962Z-mock-tour.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:03:10.962Z`. Vitest built-in bench; real MockFactory durable tour; verify each stop, complete exact script, busy refusal, ended-tour refusal and cancellation after first delta. One complete natural-paced run; three cancellations. Limitations: Includes production reading holds, based on each paragraph; one completion establishes no percentile. Product mock mode, no model/backend.

**model-config** — `2026-11-09T15-12-00.296Z-model-config.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:00.296Z`. Vitest built-in bench; actual Config and HostModel planning; default/unconfigured and configured model records, zero/default daily budget; no provider calls. Limitations: Configuration and route construction cost only.

**model-context-10** — `2026-11-09T15-11-35.838Z-model-context-10.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:35.838Z`. Vitest built-in bench; 10 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**model-context-1000** — `2026-11-09T15-11-36.106Z-model-context-1000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:36.106Z`. Vitest built-in bench; 1000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**model-context-100000** — `2026-11-09T15-11-37.851Z-model-context-100000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:37.851Z`. Vitest built-in bench; 100000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**object-cancelled-receipt** — `2026-11-09T15-11-49.905Z-object-cancelled-receipt.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:49.905Z`. Vitest built-in bench; real SQLite journal polling of an absent reply before and after a durable cancellation tombstone. Missing execution must remain an error; only recorded pre-admission cancellation returns no receipt. Three fresh scoped databases, setup and assertions included. Limitations: Deliberate absent-journal recovery boundary; no active model call or remote object.

**object-host** — `2026-11-09T15-11-49.690Z-object-host.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:49.690Z`. Vitest built-in bench; production conversation/request/alarm functions on the existing real node:sqlite host adapter. Two queued posts, malformed input and changed-owner duplicate, five alarms, exact ordered failure events, fresh sequencer recovery and ownership, budget/execution storage read/write/delete/alarm checks. Three fresh databases; initialization, durable migrations and assertions included. Limitations: Node SQLite with in-memory KV/alarm host, not workerd scheduling or disk durability. Deliberately unconfigured model exercises configuration failure, not inference. Actual workerd success paths remain separate workloads.

**policies** — `2026-11-09T15-11-50.818Z-policies.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:50.818Z`. Vitest built-in bench; strict admission, idempotent charging, accepted-only dispatch, reply attempt/offset/empty boundaries, tour terminal identity, retry classification and failure precedence; explicit behavioral truth tables. Limitations: Fixed in-process policy corpus; assertions dominate these small decisions, not an inference/model/storage measurement.

**protocol** — `2026-11-09T15-11-06.658Z-protocol.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:06.658Z`. Vitest built-in bench, Schema JSON codec, validated complete event round trips and snapshot length/tail; URL encode/decode. Setup excluded, assertions included. Limitations: In-process codec cost; no HTTP or network.

**provider-guards** — `2026-11-09T15-12-07.948Z-provider-guards.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:07.948Z`. Vitest built-in bench; exact safe issue/wiki error classification (precedence, retry interval, no provider detail), malformed/mismatched/noncanonical/unsafe VIP markers and invalid author, configured wiki file path and traversal/generated-index refusal. Every callback checks its outputs. Limitations: Pure guards and no-request early returns; no successful GitHub review validation, network, credentials or writes.

**provider-host-refusals** — `2026-11-09T15-12-08.097Z-provider-host-refusals.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:08.097Z`. Vitest built-in bench; actual GitHub issue/wiki host closures with an injected unavailable Effect HttpClient and changing principal. Missing key, credential connection, unavailable draft, unknown page, empty draft and anonymous write failures asserted. Wiki text persists before Connect. All writes make zero requests; one public read reaches the failing transport exactly once. Three fresh SQLite/KV worlds, setup/assertions included. Limitations: No request interception, external request, real credential, OAuth or GitHub mutation. Deliberate transport failure establishes refusal behavior only; successful provider paths remain unmeasured.

**reply-progress-decisions** — `2026-11-09T15-11-54.503Z-reply-progress-decisions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:54.503Z`. Vitest built-in bench; projected/partial/non-text/unknown deltas, retry reset retaining output and usage, exact safe-integer boundary, negative/unsafe/overflow usage latching invalidity, provider failure and completion precedence. Complete state comparisons inside timing. Limitations: SDK event projection policy, no provider decoding or inference. Actual agent/durable execution is separate.

**resources** — `2026-11-09T15-12-27.838Z-resources.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:27.838Z`. Vitest built-in bench; actual Alchemy stack compilation in temporary local state, dev/default production/domain variants; exact resource names, bindings, routes and CPU/observability settings checked. Three samples each, including layer/state-directory lifecycle. Limitations: Resource declarations only; no plan, deploy, provider lifecycle or Cloudflare account operation. Runtime object paths run separately in workerd.

**runtime** — `2026-11-09T15-11-17.345Z-runtime.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:17.345Z`. Vitest built-in bench, happy-dom with the actual startup program, stylesheet, Foldkit subscriptions/commands and MockFactory. Native Command-K and input/Enter; wait for the complete expected installed command. New scoped runtime each sample; 3 samples. Limitations: DOM runtime, no layout or paint; includes scripted reply delays and observer polling. Forced product mock mode, no network/model.

**sandbox-agent** — `2026-11-09T15-11-31.750Z-sandbox-agent.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:31.750Z`. Vitest built-in bench; actual harness bindings and stable cell identities over the real product mock flows. Invoke Start/Command/Stop/Start, replay old Stop, and read retained bytes through Command; verify bound conversation, catalog roster, generations and output. Three fresh engines. Limitations: Agent binding overhead without model selection or QuickJS; no Container. The public viewer boundary is measured separately; the SQLite lifecycle benchmark remains deferred by the compiler reproduction.

**sandbox-browser-actions** — `2026-11-09T15-05-44.947Z-sandbox-browser-actions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:05:44.947Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial real Chromium journey over product mock flows and supported terminal commands; exact retained terminal transcript checked across Stop/Start. No model/backend/real Container. Forced mock roles never grant live authority. Automation and scripted waits included; no percentile.

**sandbox-factory-1** — `2026-11-09T15-11-30.439Z-sandbox-factory-1.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:30.439Z`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 1 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**sandbox-factory-100** — `2026-11-09T15-11-31.589Z-sandbox-factory-100.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:31.589Z`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 100 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**sandbox-meter** — `2026-11-09T15-11-30.229Z-sandbox-meter.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:30.229Z`. Vitest built-in bench; five role allowances, distinct identity/lease bounds, exact two-running-box accounting across a UTC boundary, rollback/high-water recovery, snapshot rounding, invalid clock domains and safe-sum overflow. Independent numeric totals checked; assertions included. Limitations: In-process normalized-clock fixtures, not a fake global clock or Container performance. Real-clock host/flow paths are separate workloads.

**sandbox-public-workerd** — `2026-11-09T14-54-06.121Z-sandbox-public-workerd.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T14:54:06.121Z`. Vitest built-in bench; actual local workerd public sandbox router through LiveFactory: viewer snapshot, Start/Stop/Command forbidden, then unchanged empty state; exact typed refusals and all snapshot fields checked. Three serial five-request samples; bundling/server startup excluded. Limitations: Signed-out deployment boundary only, no trusted compute identity, Container or SQLite lifecycle. The separate sandbox SQLite benchmark is deferred by the nested-Effect compiler reproduction; this case does not substitute for it.

**sandbox-surfaces** — `2026-11-09T15-04-56.543Z-sandbox-surfaces.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:04:56.543Z`. Vitest built-in bench; emitted CLI read/start includes cold process/layer setup. Persistent real stdio MCP starts, writes, stops, restarts, reads retained bytes, stops and verifies snapshot through seven calls; full twenty-command catalog and exact generations/output checked. Three samples; MCP handshake excluded. Limitations: Product mock backend and maintainer surface principal, no real Container, model or repository write. MCP keeps one engine across samples and grows its receipt history; CLI gets a fresh engine each time. Assertions and IPC included.

**screen-protocol-policies** — `2026-11-09T15-11-51.074Z-screen-protocol-policies.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:51.074Z`. Vitest built-in bench; actual extracted screen/protocol/mock decisions, independent truth tables for shortcut priority, scroll revisions, input bounds, routing/status, backend choice and script priority. Module imports/setup excluded, correctness assertions included. Limitations: Fixed policy corpus; assertion overhead dominates. DOM, HTTP and actual agent flows are separate workloads.

**sequencer** — `2026-11-09T15-12-01.302Z-sequencer.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:01.302Z`. Vitest built-in bench; real sequencer on an in-memory append-only log. Post/refusal/duplicate, reply pieces, duplicate/stale pieces, restart, final replacement, tour, follower and fresh sequencer replay. Exact transcript and ordered events asserted; model history excludes tour narration while the transcript retains it. Limitations: In-process log, no storage I/O; SQLite/workerd measured separately.

**session-live-refusals** — `2026-11-09T15-11-24.162Z-session-live-refusals.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:24.162Z`. Vitest built-in bench; actual native signIn/signOutSurface, SDK SQLite journal and real loopback HTTP faulty Effect service. Three invalid origins make no request; local device-route 503 and sign-out 503 produce exact safe failures. Failed revocation still deletes private credentials; repeated logout is false; exactly two requests asserted. Three fresh scoped samples. Limitations: Deliberately refusing loopback service; no request interception, OAuth grant, real token, external network or production write. Measures refusal/validation and durable IO overhead, not successful sign-in.

**session-runtime** — `2026-11-09T15-11-23.085Z-session-runtime.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:23.085Z`. Vitest built-in bench; real platform-node SQLite host for sessionOperation and waitForSignIn. Action succeeds/fails, Poll completes on its first check or injected typed check failure. Exact statuses, propagated safe failure, counter increment and four bounded content-free telemetry records asserted. Three fresh private journals; setup/teardown included. Limitations: Deterministic action/check results measure durable flow overhead, not GitHub authorization, device polling intervals or WAN latency. No provider credential is used.

**session-settings** — `2026-11-09T15-11-21.931Z-session-settings.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:21.931Z`. Vitest built-in bench; real scoped filesystem settings lifecycle: absent/full replacement, separate mock/live session, exact 0700/0600 modes, pending grant retained/expired/deleted, repeated removal, invalid JSON/schema refusal, HOME fallback/missing HOME, explicit credential validation. Three unwarmed full corpora; setup, disk IO and correctness checks included. Limitations: Synthetic fixture values only; no OAuth/network. Local filesystem and process cache, no fsync/crash-durability claim. Private paths/contents omitted from artifacts.

**session-settings-faults** — `2026-11-09T15-11-22.053Z-session-settings-faults.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:22.053Z`. Vitest built-in bench; actual settings functions with an injected faulty Effect FileSystem chmod/remove over real temporary directories. Preparation/write/removal return exact safe reasons and no session file is published. Three fresh scoped samples, assertions included. Limitations: Permission failures are injected, not measured OS permission policy; no credential/OAuth/provider action.

**shared-decisions** — `2026-11-09T15-11-40.853Z-shared-decisions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:40.853Z`. Vitest built-in bench; inline/rich Markdown and safe-link table, build-time HTML with anchors and escaping, wiki path normalization/lookup/request mapping, role standing, VIP document rendering, sandbox pane decisions, media failure memory, mythical miss-path lookups and both sandbox policy layers. Limitations: Pure functions and layer reads; the wiki's durable open flow and workerd surfaces are benchmarked separately.

**site** — `2026-11-09T15-12-22.662Z-site.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:22.662Z`. Vitest built-in bench; production site Worker router over a real loopback HTTP file server serving repository home/logo bytes with SPA fallback, and real API handler health. Exact bodies, mock/live health and every rejection status checked. Three fresh scoped servers; startup/teardown included. Limitations: Local service-binding adapter over HTTP, no Cloudflare PoP or deployed asset cache; API error dependency is a deliberately faulty Effect service. Actual compiled UI/layout measured separately in Chromium.

**specification** — `2026-11-09T15-12-13.627Z-specification.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:13.627Z`. Vitest built-in bench; actual product issue flows and memory durable engine. Revise accepted specification, refuse stale/empty edits, collect all four scripted named reviews with A- grades and an optional second Opus review, verify once-only replay, keep acceptance on another revision and invoke the same review through the mock chat command. Complete review-history tuples and unchanged issues checked. Three fresh engines; setup/assertions included. Limitations: Product scripted reviewer behavior, no real model review, grade quality assessment, GitHub write or network. Named model performance belongs to an explicitly configured live workload.

**startup-theatre-decisions** — `2026-11-09T15-11-54.731Z-startup-theatre-decisions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:54.731Z`. Vitest built-in bench; explicit query/storage precedence and persistence, role/session admission, tutorial resume and auto-start choices, every theatre target, speech state transitions, bounded telemetry labels and keyboard wrap. Literal expected choices asserted inside timing. Limitations: Pure policy decisions; browser DOM, storage, layout and native speech execution are separate runtime boundaries.

**surface-failures** — `2026-11-09T15-04-24.796Z-surface-failures.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:04:24.796Z`. Vitest built-in bench; emitted processes reject blank/invalid input, unknown flags and an actually closed loopback endpoint. Exact exit/status stream and public error checked; three samples each. Limitations: Unreachable loopback, no request interception; process startup and error rendering included.

**transport** — `2026-11-09T15-12-08.973Z-transport.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:08.973Z`. Vitest built-in bench; inject a faulty Effect HttpClient into the actual Factory and Mythical adapters. Measure all chat/history/sandbox/terminal operations across transport errors, status failures, malformed JSON/protocol; exact safe typed error checked, no response body leaks. Limitations: Deliberate faulty service, no request interception; failure handling overhead without network latency. Successful transport paths run through real workerd.

**walkthrough-controls** — `2026-11-09T15-12-18.485Z-walkthrough-controls.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:18.485Z`. Vitest built-in bench; forty real state transitions over the exact ten-step catalog with elapsed reading time, pause and resume. Checks every accepted intent, current destination, preserved agent entry and exact remaining time. Limitations: Pure transition cost with assertions; no browser layout, network or durable SQLite execution.

**web-10** — `2026-11-09T15-10-32.610Z-web-10.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:32.610Z`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**web-1000** — `2026-11-09T15-10-33.201Z-web-1000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:33.201Z`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**web-100000** — `2026-11-09T15-10-43.050Z-web-100000.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:43.050Z`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**web-account-state** — `2026-11-09T15-11-52.884Z-web-account-state.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:52.884Z`. Vitest built-in bench; account/People/menu/grant/cancel/sign-in/out reducer corpus with all five roles, exact emitted work, three command retries, role-stream recovery and duplicate/gap/demotion fences. Every callback asserts state and ordered command names. Limitations: Pure reducer policy cost, no native dialogs, OAuth, network or persistence; runtime services and browser journeys are separate benchmarks.

**web-actions** — `2026-11-09T15-11-55.982Z-web-actions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:55.982Z`. Vitest built-in bench; all person-facing reducer messages, optimistic post retry, replay gap, connection, scroll, palette, splash and tour controls; scene assertions for retry and Esc. Limitations: Reducer/scene cost, no browser layout; native input and modal focus are covered by Chromium separately.

**web-content-commands** — `2026-11-09T15-12-03.064Z-web-content-commands.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:03.064Z`. Vitest built-in bench; real Foldkit Command effects over one scoped MockFactory, including identity/grant/readback, issue creation/details/projection, wiki editor/private draft/Save/readback and sign-in/out. Exact messages, source, public author/role and once-only review checked. Three fresh engines; setup, flow execution and assertions included. Limitations: Effect command boundary without DOM layout/paint; shipped product fixture services, no network/OAuth/GitHub/model. Full journey cost, not per-keystroke latency.

**web-execution-commands** — `2026-11-09T15-12-03.304Z-web-execution-commands.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:03.304Z`. Vitest built-in bench; actual Command effects over MockActions/Factory: catalog, Tour run/read/cancel and invalid input, sandbox file write/stop/restart/readback, then faulty action discovery/read/cancel. Exact ids, states, generations, retained output and request/epoch fields checked. Three fresh engines, assertions included. Limitations: Product mock runtime, no actual Container, model or network. Command-level journey includes initialization and IO; native browser layout separately benchmarked.

**web-issue-state** — `2026-11-09T15-11-53.148Z-web-issue-state.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:53.148Z`. Vitest built-in bench; saved new/VIP/comment/specification requests across completed/failed/running receipts, unrelated error fence, seven exact failure labels, unwritten correction, selected-detail cursor fences and live detail dispatch. Literal text/identity/state and ordered emitted work checked each callback. Limitations: Reducer/restoration overhead only; no request/transport interception, network, provider write or model.

**web-wiki-state** — `2026-11-09T15-11-53.393Z-web-wiki-state.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:53.393Z`. Vitest built-in bench; wiki editor begin/type/submit/cancel, immutable uncertain request, stale completion/failure fences, five exact failure labels and unwritten correction, unchanged observed source with review, filter/location and page-open failure identity. Exact model fields asserted each callback. Limitations: Pure update-state cost; does not execute emitted services or simulate browser dialogs/network. Native and SQLite wiki journeys run separately.

**wiki-cli** — `2026-11-09T15-09-51.143Z-wiki-cli.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:09:51.143Z`. Vitest built-in bench; three unwarmed samples for each wiki operation, spawning the actual emitted CLI to exit. Validated schema, fixture role, full read/draft bytes and exact first review identity. Build excluded; process startup and assertions included. Limitations: Product mock backend and maintainer principal, fresh engine each call. Save and Propose open fixture reviews; no GitHub mutation, OAuth or model. Command-line source arguments remain in memory and never enter artifacts.

**wiki-edit-journeys** — `2026-11-09T15-12-23.838Z-wiki-edit-journeys.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:12:23.838Z`. Vitest built-in bench, three whole-journey samples. Each sample initializes two independent real fixture repositories/engines, reads source, drafts, submits by each role, replays and verifies unchanged Markdown and exactly one review per repository. Assertions included. Limitations: Product fixture mode; excludes real GitHub, credentials, model generation and network. Whole-journey latency is not per-command latency or a coverage claim.

**wiki-host-journey** — `2026-11-09T15-10-27.565Z-wiki-host-journey.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:27.565Z`. Vitest built-in bench; production serveWiki/executeWiki and SQLite runtime over real fixtureWikiHost. GET/read, private draft/readback, maintainer Save, exact replay and changed-payload refusal, contributor gate/Propose and agent refusal. Original source, literal draft, two distinct review receipts and exact retained proposals checked; three fresh worlds, setup/assertions included. Limitations: Product fixture repository, no GitHub/OAuth/network/model. Node HTTP objects and in-memory SQLite; no claim of actual provider review creation or workerd scheduling. Whole-journey cost.

**wiki-host-recovery** — `2026-11-09T15-10-30.959Z-wiki-host-recovery.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:10:30.959Z`. Vitest built-in bench; nine typed faulty Effect host outcomes through production HTTP/SQLite, failure receipt replay, changed request rejection and native retryFrom into shipped fixtureWikiHost. Exact statuses, original request, once-only review and unchanged Markdown checked; three fresh worlds, assertions included. Limitations: Fault service fails before host writes; no HTTP interception. Local SQLite, no provider/real credentials/model/network. No successful GitHub or OAuth coverage claimed.

**wiki-mcp** — `2026-11-09T15-09-53.598Z-wiki-mcp.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:09:53.598Z`. Vitest built-in bench; one real persistent stdio process, initialization/discovery excluded. Three samples per operation. Each measured callback includes the command plus a source-readback call; Save/Propose also include an identical-request replay and compare the complete result. Full original source, role, draft bytes and cleared submitted draft checked; schema/IPC/assertions included. Limitations: Product fixture wiki; no GitHub mutation, OAuth or model. The persistent engine grows its review history; command-plus-validation roundtrips are not single-call wire latency. No percentile claim.

**wiki-script** — `2026-11-09T15-11-20.643Z-wiki-script.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:20.643Z`. Vitest built-in bench; actual emitted wiki generator over fixture files in the compiler's ignored output tree. Build twice, remove a required receipt and then the directory. Check exact page roster/order, nested/absolute/external/hash links, ruling deduplication, status/suite metadata, byte-identical second build and preserved output after both real read failures. Three complete four-process journeys; filesystem setup/assertions included, compilation excluded. Limitations: Small fixture wiki; not a full-site build throughput measurement. Child process startup, source loading and filesystem work included. Run independently of ordinary wiki-process tests, which use the same compiler fixture directory.

**wiki-view-matrix** — `2026-11-09T15-11-34.387Z-wiki-view-matrix.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:11:34.387Z`. Vitest built-in bench; Foldkit scenes over the real update/view render the wiki pane's index, decision chrome, loading skeleton, error with retry, filtered and empty navigation and tour-maximized state. Limitations: Scene rendering without layout/paint; the durable open flow is benchmarked through the mock factory and workerd.

**workerd** — `2026-11-09T15-00-53.957Z-workerd.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:00:53.957Z`. Vitest built-in bench; actual local workerd Durable Objects, SQLite engine, alarms, LiveFactory HTTP/SSE, agent and QuickJS; deterministic HTTP model service. Three new conversations each, unwarmed. Bundling/server startup excluded; post-through-settle/read included. Limitations: Flow/adapter overhead, no model inference, WAN or production contention. Tour includes ten real durable reading holds, totaling 134 seconds. Test host delegates to production Objects/Http; Alchemy's deploy-only wiring is not run.

**Withdrawn earlier observation.** **workerd-actions** — `2026-11-09T15-07-09.669Z-workerd-actions.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:07:09.669Z`. Vitest built-in bench; real local workerd API Worker with the deterministic model service: LiveActions list/commands/start/cancel/follow/runs/read/rerun/slash and its typed failures, then signed sessions run Post and history Plan flows to settlement, with the input/authority/conflict/not-found matrix and cross-origin refusal. Limitations: Flow/adapter overhead over local workerd, no WAN or production contention; model replies are deterministic HTTP fixtures. Three samples per command on one served instance.

**workerd-sandboxes** — `2026-11-09T15-08-53.644Z-workerd-sandboxes.json`; source `544589c510aa1116e5bfa18de996ec58d17b47d2`, UTC `2026-11-09T15:08:53.644Z`. Vitest built-in bench; the per-person sandbox ledger object in real workerd SQLite with the product in-memory machines: start/write/stop/restart with generation fencing, stale and replayed receipts, retained bytes, metering and pruning, plus the public HTTP boundary's signed-out snapshot, forged-role refusal, routing and body admission. Limitations: In-memory machines stand in for the opt-in Cloudflare Container; container latency is not measured. Three samples per journey on one served object.


Earlier workerd-actions latency observations are withdrawn: the fixture bound History as viewer and an actual refusal was mislabeled passed. The corrected host mirrors production owner/current-role delegation; the benchmark now checks the real History answer, retained commit and exact replay readback. Raw records and the withdrawal manifest are retained; earlier execution coverage is not a correctness certificate.

## Resumed source-profile measurement (2026-11-09)

The complete benchmark-only run on archived production parent `ca292c707458c8970651fe06559bbe2ac803ae28` covers **5,827/7,036 src/worker statement-start lines (82.82%)**. All executable source hashes (including the generated wiki module) match before/after; ignored `.d.vibe.ts` compiler outputs were regenerated and are separately listed, never used as coverage evidence. All benchmark workloads pass; the strict merged gate exits 1 for 95 files. No src/worker line is excluded. This is unfinished. The initial current-main baseline on `3fa8df73` was 5,221/6,947 (75.15%); intervening main changes include proof refactors, issue rendering, VL-32 acceptance and the hosted sign-in broker, so this is a comparison of named snapshots, not a controlled attribution of every denominator change to benchmark additions. Raw JSON receipt `2026-11-09T17-09-15.461Z-coverage-receipt.json`, complete source, before/after hashes, Node/workerd/Chromium maps and source-profile bundles are retained with the lane report.

The collector reuses decision 0016's configuration. Only benchmark workloads run; no unit/fuzz counters or earlier source snapshots join this map. Chromium source profiling is unminified and exact source ranges must match. Optimized-bundle attribution remains unqualified. Instrumented timings are excluded from performance tables. Real Container, GitHub write and OAuth requirements and precise future benchmarks remain in 0017. Ordinary reachable errors/control paths also remain visible below.

### Added validated observations

Shared nyc-01; raw metadata includes machine, versions, timestamp, exact source revision, method and limitations. Every callback checks its result. Means below include those assertions. Explicit sync/async runner registration prevents unmeasured classification calls; real-runner controls check exact callback counts and concurrency. Three samples do not establish a tail percentile.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| account-cookie-admission | 0.4717 | 212 | `2026-11-09T16-46-45.474Z-account-cookie-admission.json` |
| content-workerd | 16301.4147 | 3 | `2026-11-09T16-40-17.271Z-content-workerd.json` |
| drafts-workerd | 14692.9919 | 3 | `2026-11-09T16-41-02.347Z-drafts-workerd.json` |
| history-browser-command-faults | 1.7229 | 3 | `2026-11-09T16-46-36.264Z-history-browser-command-faults.json` |
| history-browser-commands | 20.2227 | 3 | `2026-11-09T16-46-36.155Z-history-browser-commands.json` |
| issues-host-journey | 825.1815 | 3 | `2026-11-09T16-44-38.060Z-issues-host-journey.json` |
| issues-host-recovery | 1698.7695 | 3 | `2026-11-09T16-44-43.283Z-issues-host-recovery.json` |
| provider-guards | 0.5309 | 189 | `2026-11-09T16-46-27.026Z-provider-guards.json` |
| provider-host-refusals | 8.4148 | 3 | `2026-11-09T16-46-27.171Z-provider-host-refusals.json` |
| session-live-refusals | 357.7222 | 3 | `2026-11-09T16-45-43.695Z-session-live-refusals.json` |
| session-runtime | 394.8750 | 3 | `2026-11-09T16-45-42.512Z-session-runtime.json` |
| session-settings | 13.7160 | 3 | `2026-11-09T16-45-41.084Z-session-settings.json` |
| session-settings-faults | 2.0228 | 3 | `2026-11-09T16-45-41.222Z-session-settings-faults.json` |
| web-account-state | 0.3835 | 261 | `2026-11-09T16-46-12.692Z-web-account-state.json` |
| web-content-commands | 60.3431 | 3 | `2026-11-09T16-46-23.614Z-web-content-commands.json` |
| web-execution-commands | 40.0830 | 3 | `2026-11-09T16-46-23.851Z-web-execution-commands.json` |
| web-issue-state | 4.9099 | 21 | `2026-11-09T16-46-12.947Z-web-issue-state.json` |
| web-wiki-state | 0.2399 | 417 | `2026-11-09T16-46-13.188Z-web-wiki-state.json` |
| wiki-host-journey | 392.9777 | 3 | `2026-11-09T16-44-44.591Z-wiki-host-journey.json` |
| wiki-host-recovery | 1145.6324 | 3 | `2026-11-09T16-44-48.150Z-wiki-host-recovery.json` |

**account-cookie-admission.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:45.474Z`. Vitest built-in bench; production cookie-name and admission functions. Exact secure/local names, three hosted origins, four loopback origins, 1/4096/4097-character values, eleven invalid/noncanonical origins, invalid characters and line terminators checked in every callback. Setup and assertions included. Limitations: Pure URL/cookie syntax admission; does not establish a valid signature, identity, broker exchange, role, real OAuth or production session. No network, request interception or credential used.

**content-workerd.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:40:17.271Z`. Vitest built-in bench; each of three unwarmed samples starts fresh real workerd issue and wiki hosts. HTTP/SQLite commitments replay once; credentials are encrypted/session-bound/current-role/expiring; paid failed drafts charge once; partial write retryFrom adopts exactly one original child. Wiki draft privacy, contributor proposal/replay, forbidden Save, unchanged Markdown and one completed proposal journal row checked. Bundling, server lifecycle and assertions included. Limitations: Existing unshipped host supplies product fixture identities/repository; typed faulty Effect services exercise paid failures and partial recovery. No real GitHub write, OAuth or Container. Whole fresh-host corpus cost includes bundling and startup; it is not per-request latency or model inference.

**drafts-workerd.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:41:02.347Z`. Vitest built-in bench; three fresh native workerd worlds run production VIP draft, wiki draft and specification reviewer AgentActions, SDK model HTTP/SSE, QuickJS and SQLite over one deterministic local model service. Exact schema answers, six metered tokens, three HTTP model calls and cached replay with no further call checked. Bundling/startup/assertions included. Limitations: Deterministic model responses measure flow/agent overhead without inference or WAN. No GitHub write, OAuth, Container or real provider spending. Whole fresh-host corpus is not per-request latency.

**history-browser-command-faults.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:36.264Z`. Vitest built-in bench; typed faulty Effect Mythical service, four browser reads and five writes under both permission and transport failures. All exact message/reason projections and redaction checked. Three full corpora, setup/assertions included. Limitations: Deliberate service failures, no request interception or successful provider simulation; no network, repository writes or model.

**history-browser-commands.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:36.155Z`. Vitest built-in bench; actual History Command effects over MockMythical's memory engine from empty history. Outline, Plan, epic/search, Start/Note/Approve/Fold and commit/missing detail; exact command messages, retained fields, notes, fold SHA and final six-event outline checked. Three fresh scoped engines, assertions included. Limitations: Shipped product mock main, no GitHub mutation, network, OAuth or actual repository fold. Command Effects without browser layout/DOM focus.

**issues-host-journey.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:44:38.060Z`. Vitest built-in bench; real serveIssues/executeIssues with SQLite, actual fixtureHost and changing Effect identity. Fresh world per sample; public projection strips untrusted approval, new/replay/changed request, human approval, saved receipt, revoked/agent writes, specification revision and missing reviewer checked. Exact HTTP statuses, retained body, once-only creation, approval and revision history asserted. Setup/assertions included. Limitations: Node HTTP values and real in-memory SQLite; no TCP, workerd scheduling, GitHub/OAuth or model. Product fixture host is explicitly injected. Whole journey is not per-command latency.

**issues-host-recovery.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:44:43.283Z`. Vitest built-in bench; production HTTP/SQLite issue adapter, fifteen injected typed Effect host failures, then a real fixture creation after explicit native retryFrom. Cached failure cannot retry implicitly; changed payload refused; exact matching recovery, replay, saved operation and missing receipt checked against unchanged fixture rows. Three fresh worlds; all assertions included. Phase-only diagnostic logs disabled. Limitations: Fault injection fails before the shipped fixture host; no own-code request interception, GitHub mutation or OAuth. Node SQLite in memory, no network/model. This is a complete fault/recovery corpus cost.

**provider-guards.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:27.026Z`. Vitest built-in bench; exact safe issue/wiki error classification (precedence, retry interval, no provider detail), malformed/mismatched/noncanonical/unsafe VIP markers and invalid author, configured wiki file path and traversal/generated-index refusal. Every callback checks its outputs. Limitations: Pure guards and no-request early returns; no successful GitHub review validation, network, credentials or writes.

**provider-host-refusals.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:27.171Z`. Vitest built-in bench; actual GitHub issue/wiki host closures with an injected unavailable Effect HttpClient and changing principal. Missing key, credential connection, unavailable draft, unknown page, empty draft and anonymous write failures asserted. Wiki text persists before Connect. All writes make zero requests; one public read reaches the failing transport exactly once. Three fresh SQLite/KV worlds, setup/assertions included. Limitations: No request interception, external request, real credential, OAuth or GitHub mutation. Deliberate transport failure establishes refusal behavior only; successful provider paths remain unmeasured.

**session-live-refusals.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:45:43.695Z`. Vitest built-in bench; actual native signIn/signOutSurface, SDK SQLite journal and real loopback HTTP faulty Effect service. Three invalid origins make no request; local device-route 503 and sign-out 503 produce exact safe failures. Failed revocation still deletes private credentials; repeated logout is false; exactly two requests asserted. Three fresh scoped samples. Limitations: Deliberately refusing loopback service; no request interception, OAuth grant, real token, external network or production write. Measures refusal/validation and durable IO overhead, not successful sign-in.

**session-runtime.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:45:42.512Z`. Vitest built-in bench; real platform-node SQLite host for sessionOperation and waitForSignIn. Action succeeds/fails, Poll completes on its first check or injected typed check failure. Exact statuses, propagated safe failure, counter increment and four bounded content-free telemetry records asserted. Three fresh private journals; setup/teardown included. Limitations: Deterministic action/check results measure durable flow overhead, not GitHub authorization, device polling intervals or WAN latency. No provider credential is used.

**session-settings.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:45:41.084Z`. Vitest built-in bench; real scoped filesystem settings lifecycle: absent/full replacement, separate mock/live session, exact 0700/0600 modes, pending grant retained/expired/deleted, repeated removal, invalid JSON/schema refusal, HOME fallback/missing HOME, explicit credential validation. Three unwarmed full corpora; setup, disk IO and correctness checks included. Limitations: Synthetic fixture values only; no OAuth/network. Local filesystem and process cache, no fsync/crash-durability claim. Private paths/contents omitted from artifacts.

**session-settings-faults.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:45:41.222Z`. Vitest built-in bench; actual settings functions with an injected faulty Effect FileSystem chmod/remove over real temporary directories. Preparation/write/removal return exact safe reasons and no session file is published. Three fresh scoped samples, assertions included. Limitations: Permission failures are injected, not measured OS permission policy; no credential/OAuth/provider action.

**web-account-state.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:12.692Z`. Vitest built-in bench; account/People/menu/grant/cancel/sign-in/out reducer corpus with all five roles, exact emitted work, three command retries, role-stream recovery and duplicate/gap/demotion fences. Every callback asserts state and ordered command names. Limitations: Pure reducer policy cost, no native dialogs, OAuth, network or persistence; runtime services and browser journeys are separate benchmarks.

**web-content-commands.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:23.614Z`. Vitest built-in bench; real Foldkit Command effects over one scoped MockFactory, including identity/grant/readback, issue creation/details/projection, wiki editor/private draft/Save/readback and sign-in/out. Exact messages, source, public author/role and once-only review checked. Three fresh engines; setup, flow execution and assertions included. Limitations: Effect command boundary without DOM layout/paint; shipped product fixture services, no network/OAuth/GitHub/model. Full journey cost, not per-keystroke latency.

**web-execution-commands.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:23.851Z`. Vitest built-in bench; actual Command effects over MockActions/Factory: catalog, Tour run/read/cancel and invalid input, sandbox file write/stop/restart/readback, then faulty action discovery/read/cancel. Exact ids, states, generations, retained output and request/epoch fields checked. Three fresh engines, assertions included. Limitations: Product mock runtime, no actual Container, model or network. Command-level journey includes initialization and IO; native browser layout separately benchmarked.

**web-issue-state.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:12.947Z`. Vitest built-in bench; saved new/VIP/comment/specification requests across completed/failed/running receipts, unrelated error fence, seven exact failure labels, unwritten correction, selected-detail cursor fences and live detail dispatch. Literal text/identity/state and ordered emitted work checked each callback. Limitations: Reducer/restoration overhead only; no request/transport interception, network, provider write or model.

**web-wiki-state.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:46:13.188Z`. Vitest built-in bench; wiki editor begin/type/submit/cancel, immutable uncertain request, stale completion/failure fences, five exact failure labels and unwritten correction, unchanged observed source with review, filter/location and page-open failure identity. Exact model fields asserted each callback. Limitations: Pure update-state cost; does not execute emitted services or simulate browser dialogs/network. Native and SQLite wiki journeys run separately.

**wiki-host-journey.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:44:44.591Z`. Vitest built-in bench; production serveWiki/executeWiki and SQLite runtime over real fixtureWikiHost. GET/read, private draft/readback, maintainer Save, exact replay and changed-payload refusal, contributor gate/Propose and agent refusal. Original source, literal draft, two distinct review receipts and exact retained proposals checked; three fresh worlds, setup/assertions included. Limitations: Product fixture repository, no GitHub/OAuth/network/model. Node HTTP objects and in-memory SQLite; no claim of actual provider review creation or workerd scheduling. Whole-journey cost.

**wiki-host-recovery.** Source `0aede2351637910237f39e1304df2ce6599d4952`; UTC `2026-11-09T16:44:48.150Z`. Vitest built-in bench; nine typed faulty Effect host outcomes through production HTTP/SQLite, failure receipt replay, changed request rejection and native retryFrom into shipped fixtureWikiHost. Exact statuses, original request, once-only review and unchanged Markdown checked; three fresh worlds, assertions included. Limitations: Fault service fails before host writes; no HTTP interception. Local SQLite, no provider/real credentials/model/network. No successful GitHub or OAuth coverage claimed.

### Current per-file benchmark coverage

Executable lines are statement starts; an enclosing declaration cannot credit its nested body. All four strict metrics and exact uncovered positions remain in the raw receipt. Counts below additionally retain Node-only execution separately from merged evidence.

| File | Node covered/executable | Merged covered/executable | Merged lines |
| --- | ---: | ---: | ---: |
| `infra/SandboxImage.vibe` | 0/2 | 0/2 | 0.00% |
| `infra/Stack.vibe` | 8/8 | 8/8 | 100.00% |
| `infra/WorkerBuild.vibe` | 1/1 | 1/1 | 100.00% |
| `scripts/agent-context.vibe` | 22/22 | 22/22 | 100.00% |
| `scripts/mythical-seed.vibe` | 51/51 | 50/50 | 100.00% |
| `scripts/wiki.vibe` | 30/30 | 30/30 | 100.00% |
| `src/actions/Actions.vibe` | 4/4 | 4/4 | 100.00% |
| `src/actions/LiveActions.vibe` | 43/43 | 43/43 | 100.00% |
| `src/actions/MockActions.vibe` | 114/118 | 115/118 | 97.46% |
| `src/actions/agent.vibe` | 5/11 | 5/11 | 45.45% |
| `src/actions/catalog.vibe` | 8/8 | 8/8 | 100.00% |
| `src/actions/execution.vibe` | 31/41 | 31/41 | 75.61% |
| `src/actions/tools.vibe` | 12/13 | 12/13 | 92.31% |
| `src/actions/wire.vibe` | 6/6 | 6/6 | 100.00% |
| `src/assets/wiki.generated.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/Factory.vibe` | 3/3 | 3/3 | 100.00% |
| `src/core/IssuesFactory.vibe` | 75/76 | 75/76 | 98.68% |
| `src/core/LiveAccounts.vibe` | 25/26 | 25/26 | 96.15% |
| `src/core/LiveFactory.vibe` | 69/77 | 69/77 | 89.61% |
| `src/core/LiveIssues.vibe` | 3/11 | 3/11 | 27.27% |
| `src/core/LiveWiki.vibe` | 4/15 | 4/15 | 26.67% |
| `src/core/MockAccounts.vibe` | 73/77 | 76/77 | 98.70% |
| `src/core/MockFactory.vibe` | 208/254 | 236/254 | 92.91% |
| `src/core/MockJournal.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/VipWriter.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/WikiFactory.vibe` | 62/65 | 65/65 | 100.00% |
| `src/core/WikiWriter.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/accountCookieDecision.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/accountCookies.vibe` | 9/9 | 9/9 | 100.00% |
| `src/core/conversation.vibe` | 288/296 | 289/296 | 97.64% |
| `src/core/flowDecision.vibe` | 49/65 | 51/65 | 78.46% |
| `src/core/flows.vibe` | 122/165 | 145/165 | 87.88% |
| `src/core/identityDecision.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/issueFlows.vibe` | 32/32 | 32/32 | 100.00% |
| `src/core/issueSchemas.vibe` | 12/12 | 12/12 | 100.00% |
| `src/core/mockDecision.vibe` | 10/10 | 10/10 | 100.00% |
| `src/core/mockReplies.vibe` | 19/19 | 19/19 | 100.00% |
| `src/core/protocolDecision.vibe` | 16/17 | 17/17 | 100.00% |
| `src/core/roles.vibe` | 5/5 | 5/5 | 100.00% |
| `src/core/sandboxDecision.vibe` | 54/55 | 55/55 | 100.00% |
| `src/core/sandboxHost.vibe` | 130/181 | 147/181 | 81.22% |
| `src/core/sandboxMeter.vibe` | 33/33 | 33/33 | 100.00% |
| `src/core/sandboxMock.vibe` | 40/47 | 43/47 | 91.49% |
| `src/core/sandboxPolicy.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/schemas.vibe` | 30/30 | 30/30 | 100.00% |
| `src/core/sequenceDecision.vibe` | 20/20 | 20/20 | 100.00% |
| `src/core/specification.vibe` | 32/32 | 32/32 | 100.00% |
| `src/core/walkthroughSteps.vibe` | 2/2 | 2/2 | 100.00% |
| `src/core/wiki.vibe` | 15/15 | 15/15 | 100.00% |
| `src/core/wikiDecision.vibe` | 1/1 | 1/1 | 100.00% |
| `src/core/wikiFlows.vibe` | 32/32 | 32/32 | 100.00% |
| `src/core/wikiLinks.vibe` | 13/14 | 13/14 | 92.86% |
| `src/core/wikiSchemas.vibe` | 5/5 | 5/5 | 100.00% |
| `src/core/wire.vibe` | 26/27 | 26/27 | 96.30% |
| `src/history/LiveMythical.vibe` | 39/41 | 39/41 | 95.12% |
| `src/history/MockMythical.vibe` | 35/35 | 35/35 | 100.00% |
| `src/history/MythicalHistory.vibe` | 2/2 | 2/2 | 100.00% |
| `src/history/Sequencer.vibe` | 86/96 | 86/96 | 89.58% |
| `src/history/flowMachine.vibe` | 50/51 | 50/51 | 98.04% |
| `src/history/flows.vibe` | 66/76 | 68/76 | 89.47% |
| `src/history/mythical.vibe` | 141/141 | 141/141 | 100.00% |
| `src/history/pages.vibe` | 36/36 | 36/36 | 100.00% |
| `src/history/roles.vibe` | 6/6 | 6/6 | 100.00% |
| `src/history/schemas.vibe` | 31/32 | 32/32 | 100.00% |
| `src/history/seed.vibe` | 166/171 | 166/171 | 97.08% |
| `src/history/seed/vibelang.vibe` | 2/2 | 2/2 | 100.00% |
| `src/history/tools.vibe` | 26/27 | 26/27 | 96.30% |
| `src/history/wire.vibe` | 35/35 | 35/35 | 100.00% |
| `src/surfaces/backend.vibe` | 38/45 | 38/45 | 84.44% |
| `src/surfaces/cli-entry.vibe` | 8/8 | 8/8 | 100.00% |
| `src/surfaces/cli.vibe` | 16/16 | 16/16 | 100.00% |
| `src/surfaces/commandDecision.vibe` | 9/9 | 9/9 | 100.00% |
| `src/surfaces/commands.vibe` | 124/168 | 124/168 | 73.81% |
| `src/surfaces/manifest.vibe` | 4/4 | 4/4 | 100.00% |
| `src/surfaces/mcp-entry.vibe` | 6/6 | 6/6 | 100.00% |
| `src/surfaces/mcp.vibe` | 17/17 | 17/17 | 100.00% |
| `src/surfaces/session.vibe` | 63/63 | 63/63 | 100.00% |
| `src/surfaces/sessionFlow.vibe` | 28/29 | 28/29 | 96.55% |
| `src/surfaces/signin.vibe` | 49/107 | 49/107 | 45.79% |
| `src/web/actionModel.vibe` | 15/15 | 15/15 | 100.00% |
| `src/web/actionView.vibe` | 25/30 | 27/30 | 90.00% |
| `src/web/backend.vibe` | 33/73 | 59/73 | 80.82% |
| `src/web/entry.vibe` | 0/8 | 8/8 | 100.00% |
| `src/web/historyApp.vibe` | 132/156 | 139/156 | 89.10% |
| `src/web/historyBackend.vibe` | 0/26 | 16/26 | 61.54% |
| `src/web/historyStartup.vibe` | 0/32 | 33/33 | 100.00% |
| `src/web/historyView.vibe` | 64/73 | 64/73 | 87.67% |
| `src/web/issues.vibe` | 43/49 | 43/49 | 87.76% |
| `src/web/issuesView.vibe` | 63/78 | 63/78 | 80.77% |
| `src/web/main.vibe` | 424/636 | 554/636 | 87.11% |
| `src/web/markdown.vibe` | 94/103 | 101/103 | 98.06% |
| `src/web/media.vibe` | 6/6 | 6/6 | 100.00% |
| `src/web/modeSwitch.vibe` | 2/2 | 2/2 | 100.00% |
| `src/web/modelDecision.vibe` | 39/54 | 43/54 | 79.63% |
| `src/web/roleView.vibe` | 17/24 | 18/24 | 75.00% |
| `src/web/sandboxView.vibe` | 14/17 | 15/17 | 88.24% |
| `src/web/screenDecision.vibe` | 38/41 | 38/41 | 92.68% |
| `src/web/startup.vibe` | 46/50 | 50/50 | 100.00% |
| `src/web/startupDecision.vibe` | 9/9 | 9/9 | 100.00% |
| `src/web/styles.vibe` | 1/1 | 1/1 | 100.00% |
| `src/web/theatre.vibe` | 4/45 | 32/45 | 71.11% |
| `src/web/theatreDecision.vibe` | 18/18 | 18/18 | 100.00% |
| `src/web/view.vibe` | 48/51 | 48/51 | 94.12% |
| `src/web/viewDecision.vibe` | 22/22 | 22/22 | 100.00% |
| `src/web/viewport.vibe` | 16/48 | 46/48 | 95.83% |
| `src/web/wikiView.vibe` | 26/28 | 26/28 | 92.86% |
| `worker/Accounts.vibe` | 14/267 | 173/267 | 64.79% |
| `worker/ActionDirectory.vibe` | 26/36 | 34/36 | 94.44% |
| `worker/ActionIdentity.vibe` | 4/14 | 10/14 | 71.43% |
| `worker/ActionRuns.vibe` | 98/117 | 103/117 | 88.03% |
| `worker/ActionsHttp.vibe` | 3/41 | 40/41 | 97.56% |
| `worker/AgentModel.vibe` | 9/9 | 9/9 | 100.00% |
| `worker/Api.vibe` | 46/231 | 46/231 | 19.91% |
| `worker/Budget.vibe` | 20/22 | 20/22 | 90.91% |
| `worker/HistoryActions.vibe` | 20/33 | 20/33 | 60.61% |
| `worker/HistoryObject.vibe` | 6/60 | 44/60 | 73.33% |
| `worker/HistoryTools.vibe` | 8/8 | 8/8 | 100.00% |
| `worker/Http.vibe` | 65/93 | 77/93 | 82.80% |
| `worker/IssueCredentials.vibe` | 1/16 | 13/16 | 81.25% |
| `worker/Issues.vibe` | 148/271 | 153/271 | 56.46% |
| `worker/MainLog.vibe` | 29/43 | 29/43 | 67.44% |
| `worker/ObjectStorage.vibe` | 10/10 | 10/10 | 100.00% |
| `worker/Objects.vibe` | 61/107 | 88/107 | 82.24% |
| `worker/Reply.vibe` | 87/136 | 121/136 | 88.97% |
| `worker/SandboxAccounts.vibe` | 6/60 | 6/60 | 10.00% |
| `worker/SandboxHttp.vibe` | 4/30 | 26/30 | 86.67% |
| `worker/SandboxMachine.vibe` | 1/66 | 1/66 | 1.52% |
| `worker/SandboxTools.vibe` | 8/11 | 8/11 | 72.73% |
| `worker/Sandboxes.vibe` | 0/22 | 26/26 | 100.00% |
| `worker/Sequencer.vibe` | 101/118 | 106/118 | 89.83% |
| `worker/SpecificationReviewers.vibe` | 10/31 | 29/31 | 93.55% |
| `worker/Tour.vibe` | 4/5 | 5/5 | 100.00% |
| `worker/Unreachable.vibe` | 1/1 | 1/1 | 100.00% |
| `worker/VipDraft.vibe` | 4/30 | 27/30 | 90.00% |
| `worker/Wiki.vibe` | 97/152 | 98/152 | 64.47% |
| `worker/WikiDraft.vibe` | 4/32 | 29/32 | 90.62% |
| `worker/WikiTools.vibe` | 1/9 | 2/9 | 22.22% |
| `worker/agentContext.vibe` | 1/1 | 1/1 | 100.00% |
| `worker/budgetDecision.vibe` | 4/5 | 5/5 | 100.00% |
| `worker/index.vibe` | 13/13 | 13/13 | 100.00% |
| `worker/liveDispatchDecision.vibe` | 7/7 | 7/7 | 100.00% |
| `worker/replyProgressDecision.vibe` | 17/17 | 17/17 | 100.00% |
| `worker/replyReasons.vibe` | 7/7 | 7/7 | 100.00% |

Largest remaining line gaps:

- `worker/Api.vibe`: 185 uncovered of 231.
- `worker/Issues.vibe`: 118 uncovered of 271.
- `worker/Accounts.vibe`: 94 uncovered of 267.
- `src/web/main.vibe`: 82 uncovered of 636.
- `worker/SandboxMachine.vibe`: 65 uncovered of 66.
- `src/surfaces/signin.vibe`: 58 uncovered of 107.
- `worker/SandboxAccounts.vibe`: 54 uncovered of 60.
- `worker/Wiki.vibe`: 54 uncovered of 152.
- `src/surfaces/commands.vibe`: 44 uncovered of 168.
- `src/core/sandboxHost.vibe`: 34 uncovered of 181.
- `src/core/flows.vibe`: 20 uncovered of 165.
- `worker/Objects.vibe`: 19 uncovered of 107.
- `src/core/MockFactory.vibe`: 18 uncovered of 254.
- `src/web/historyApp.vibe`: 17 uncovered of 156.
- `worker/HistoryObject.vibe`: 16 uncovered of 60.

### Complete corrected local timing roster

This table comes only from the complete passing timing window, using explicit sync/async registration. Each row includes assertion cost. Shared nyc-01 host, JIT, GC and OS caches are uncontrolled. Milliseconds are client-observed work, not a server CPU profile. The method and limitations for every artifact follow the table. No instrumented measurement appears here.

| Artifact group / workload | Mean ms | Samples |
| --- | ---: | ---: |
| `account-cookie-admission/account-cookie-admission` | 0.471736 | 212 |
| `accounts-lifecycle/accounts-lifecycle` | 22.194067 | 3 |
| `accounts-transport/accounts-transport-faults` | 7.192893 | 14 |
| `accounts-workerd/workerd-account-session-grants` | 243.029990 | 3 |
| `accounts-workerd-faults/0/workerd-account-disabled` | 10.251943 | 3 |
| `accounts-workerd-faults/1/workerd-account-exchange-failure` | 334.389644 | 3 |
| `action-catalog/action-catalog` | 2.154807 | 47 |
| `action-host/action-host-recovery` | 521.967217 | 3 |
| `action-host-role-downgrade/action-host-role-downgrade` | 89.884919 | 3 |
| `action-kernels/action-kernels` | 0.160836 | 622 |
| `action-prepare/action-prepare` | 0.203448 | 492 |
| `action-tools/action-tools` | 5.890558 | 3 |
| `actions-view-matrix/actions-view-matrix` | 7.228311 | 14 |
| `agent-projection/agent-projection` | 0.079139 | 1264 |
| `budget/budget` | 0.226884 | 441 |
| `cli/0/--mock read --json` | 2207.774112 | 3 |
| `cli/1/--mock ask install --json` | 2481.176284 | 3 |
| `cli/2/--llms` | 1952.311569 | 3 |
| `cli/3/--help` | 2048.773768 | 3 |
| `commands/0/mock-agent-ask` | 278.928017 | 3 |
| `commands/1/read-command` | 0.233670 | 428 |
| `content-workerd/content-workerd` | 16301.414733 | 3 |
| `context-command-policies/context-and-command-decisions` | 0.125203 | 799 |
| `core-10/0/decide` | 0.007470 | 13387 |
| `core-10/1/apply` | 0.013439 | 7442 |
| `core-10/2/receive` | 0.010875 | 9196 |
| `core-10/3/replay-apply` | 0.017702 | 5650 |
| `core-10/4/replay-receive` | 0.014301 | 6993 |
| `core-1000/0/decide` | 0.012700 | 7875 |
| `core-1000/1/apply` | 0.020810 | 4806 |
| `core-1000/2/receive` | 0.018202 | 5494 |
| `core-1000/3/replay-apply` | 0.095601 | 1047 |
| `core-1000/4/replay-receive` | 0.099325 | 1007 |
| `core-100000/0/decide` | 0.735328 | 137 |
| `core-100000/1/apply` | 1.775088 | 58 |
| `core-100000/2/receive` | 1.477202 | 68 |
| `core-100000/3/replay-apply` | 9.931292 | 11 |
| `core-100000/4/replay-receive` | 10.518966 | 10 |
| `dispatcher-decisions/dispatcher-decisions` | 0.316720 | 316 |
| `drafts-workerd/drafts-workerd` | 14692.991923 | 3 |
| `factory-gates/factory-gates` | 0.096026 | 1042 |
| `failure-views/failure-views` | 7.934640 | 13 |
| `history-10/0/history-decide` | 0.007953 | 12574 |
| `history-10/1/history-apply` | 0.025495 | 3923 |
| `history-10/2/history-decode` | 0.067722 | 1477 |
| `history-1000/0/history-decide` | 0.015510 | 6448 |
| `history-1000/1/history-apply` | 0.045745 | 2187 |
| `history-1000/2/history-decode` | 4.419108 | 23 |
| `history-100000/0/history-decide` | 0.808156 | 124 |
| `history-100000/1/history-apply` | 2.600868 | 39 |
| `history-100000/2/history-decode` | 509.017087 | 5 |
| `history-actions/history-actions` | 0.353434 | 284 |
| `history-bootstrap/history-bootstrap-graph` | 0.383465 | 261 |
| `history-browser-actions/history-first-render` | 430.137965 | 1 |
| `history-browser-actions/history-expand-epic` | 44.329085 | 1 |
| `history-browser-actions/history-next-page` | 67.410446 | 1 |
| `history-browser-actions/history-open-commit` | 119.241654 | 1 |
| `history-browser-actions/history-amend-and-escape` | 71.098770 | 1 |
| `history-browser-actions/history-amend-submit` | 101.749166 | 1 |
| `history-browser-actions/history-insert-before` | 114.692844 | 1 |
| `history-browser-actions/history-filter-keystroke` | 74.046392 | 1 |
| `history-browser-actions/history-plan` | 134.977149 | 1 |
| `history-browser-actions/history-start` | 63.385619 | 1 |
| `history-browser-actions/history-add-note` | 68.983812 | 1 |
| `history-browser-actions/history-approve` | 62.666298 | 1 |
| `history-browser-actions/history-fold` | 351.402588 | 1 |
| `history-browser-actions/history-viewer-controls` | 319.614866 | 1 |
| `history-browser-command-faults/history-browser-command-faults` | 1.722879 | 3 |
| `history-browser-commands/history-browser-commands` | 20.222727 | 3 |
| `history-catalog/history-catalog-calls` | 14.188743 | 3 |
| `history-flow-policies/history-flow-ordering` | 3.019593 | 34 |
| `history-flows/history-plan-start-note-approve-fold` | 19.989293 | 3 |
| `history-malformed-replay/history-malformed-replay` | 0.141704 | 706 |
| `history-page-boundaries/history-page-boundaries` | 0.253328 | 395 |
| `history-pages-10/0/history-outline` | 0.026865 | 3723 |
| `history-pages-10/1/history-epic-pages` | 0.027720 | 3609 |
| `history-pages-10/2/history-commit-page` | 0.009888 | 10114 |
| `history-pages-10/3/history-search` | 0.031424 | 3183 |
| `history-pages-10/4/history-page-codecs` | 0.117949 | 848 |
| `history-pages-1000/0/history-outline` | 0.115302 | 868 |
| `history-pages-1000/1/history-epic-pages` | 0.140281 | 713 |
| `history-pages-1000/2/history-commit-page` | 0.026352 | 3796 |
| `history-pages-1000/3/history-search` | 0.277573 | 361 |
| `history-pages-1000/4/history-page-codecs` | 4.926283 | 21 |
| `history-pages-100000/0/history-outline` | 20.223922 | 6 |
| `history-pages-100000/1/history-epic-pages` | 10.355827 | 10 |
| `history-pages-100000/2/history-commit-page` | 1.577167 | 64 |
| `history-pages-100000/3/history-search` | 18.355678 | 6 |
| `history-pages-100000/4/history-page-codecs` | 384.877585 | 5 |
| `history-recovery/history-retelling-recovery` | 0.793690 | 126 |
| `history-roles/history-role-matrix` | 0.069502 | 1439 |
| `history-seed/history-seed-decode` | 205.633854 | 3 |
| `history-surfaces/0/cli-history` | 2169.202141 | 3 |
| `history-surfaces/1/cli-plan` | 2289.097282 | 3 |
| `history-surfaces/2/mcp-history-plan-start-note` | 19.991106 | 3 |
| `history-tools/0/history-tool-lifecycle` | 22.092165 | 3 |
| `history-tools/1/history-tool-faults` | 0.325297 | 308 |
| `history-view-matrix/history-view-matrix` | 22.809711 | 5 |
| `history-web-10/0/history-filter-keystroke` | 0.031398 | 3185 |
| `history-web-10/1/history-open-epic-view` | 13.848631 | 3 |
| `history-web-1000/0/history-filter-keystroke` | 0.051946 | 1926 |
| `history-web-1000/1/history-open-epic-view` | 103.239528 | 3 |
| `history-web-1000/2/history-next-page-update` | 0.080285 | 1246 |
| `history-web-100000/0/history-filter-keystroke` | 0.026352 | 3795 |
| `history-web-100000/1/history-open-epic-view` | 7838.214794 | 3 |
| `history-web-100000/2/history-next-page-update` | 0.080120 | 1249 |
| `history-workerd/0/history-first-outline` | 224.505263 | 1 |
| `history-workerd/1/history-warm-outline` | 6.001445 | 3 |
| `history-workerd/2/history-detail-pages` | 18.469159 | 3 |
| `history-workerd/3/history-viewer-refusals` | 202.336944 | 3 |
| `history-workerd/4/history-protocol-errors` | 7.639265 | 3 |
| `history-workerd/5/history-keyed-call-replay` | 145.711871 | 3 |
| `http/http-boundaries` | 6.421654 | 16 |
| `identity-cli/cli-identity-journey` | 10102.057167 | 3 |
| `identity-labels/identity-labels` | 0.020865 | 4793 |
| `identity-mcp/mcp-identity-journey` | 702.449734 | 3 |
| `issues-commands/0/issues-read` | 7.621217 | 3 |
| `issues-commands/1/issues-new` | 5.944107 | 3 |
| `issues-commands/2/issues-comment` | 5.428311 | 3 |
| `issues-commands/3/issues-link` | 5.644457 | 3 |
| `issues-commands/4/issues-split` | 5.052403 | 3 |
| `issues-commands/5/issues-commit` | 5.710874 | 3 |
| `issues-commands/6/issues-uncommit` | 5.106495 | 3 |
| `issues-commands/7/issues-propose` | 5.598552 | 3 |
| `issues-commands/8/issues-accept` | 4.809969 | 3 |
| `issues-commands/9/issues-decline` | 4.618177 | 3 |
| `issues-commands/10/issues-draft` | 4.981840 | 3 |
| `issues-flows/issue-flow-journey` | 57.172164 | 3 |
| `issues-host-journey/issues-host-journey` | 825.181515 | 3 |
| `issues-host-recovery/issues-host-recovery` | 1698.769463 | 3 |
| `issues-identities/issue-identities` | 0.421206 | 238 |
| `issues-policy/issue-policy-corpus` | 0.337293 | 297 |
| `issues-reducer/issues-reducer` | 0.228007 | 439 |
| `issues-refusals/issue-refusals` | 27.724639 | 3 |
| `issues-view-matrix/issues-view-matrix` | 27.842729 | 5 |
| `local-browser/commandKMs` | 45.109203 | 3 |
| `local-browser/firstRenderMs` | 203.321850 | 3 |
| `local-browser/keystrokeMs` | 28.056398 | 3 |
| `local-browser-actions/hero-ready-frame` | 69.879277 | 1 |
| `local-browser-actions/hero-native-pause` | 14.695471 | 1 |
| `local-browser-actions/hero-native-play` | 6.664148 | 1 |
| `local-browser-actions/ask-button` | 65.735465 | 1 |
| `local-browser-actions/submit-settle-0` | 852.075368 | 1 |
| `local-browser-actions/submit-settle-1` | 808.693083 | 1 |
| `local-browser-actions/submit-settle-2` | 812.961921 | 1 |
| `local-browser-actions/submit-settle-3` | 794.781636 | 1 |
| `local-browser-actions/wheel-pause` | 28.933304 | 1 |
| `local-browser-actions/latest` | 83.294406 | 1 |
| `local-browser-actions/pause-Home` | 117.226148 | 1 |
| `local-browser-actions/pause-PageUp` | 100.947621 | 1 |
| `local-browser-actions/pause-ArrowUp` | 99.929549 | 1 |
| `local-browser-actions/pause-Control+Home` | 87.353845 | 1 |
| `local-browser-actions/pause-Meta+ArrowUp` | 126.213843 | 1 |
| `local-browser-actions/new-input-cancels-latest` | 294.387982 | 1 |
| `local-browser-actions/touch-pause` | 65.329469 | 1 |
| `local-browser-actions/actions-open` | 110.216107 | 1 |
| `local-browser-actions/actions-run-and-trace` | 327.677547 | 1 |
| `local-browser-actions/actions-cancel` | 74.317553 | 1 |
| `local-browser-actions/actions-rerun` | 132.093128 | 1 |
| `local-browser-actions/actions-escape-collapse` | 104.371924 | 1 |
| `local-browser-actions/home-expand-minimize` | 606.694881 | 1 |
| `local-browser-actions/learn-more` | 560.823623 | 1 |
| `local-browser-actions/tour-pause` | 43.067463 | 1 |
| `local-browser-actions/tour-resume` | 59.233666 | 1 |
| `local-browser-actions/tour-skip-2` | 82.973834 | 1 |
| `local-browser-actions/tour-skip-3` | 441.842480 | 1 |
| `local-browser-actions/tour-skip-4` | 558.559179 | 1 |
| `local-browser-actions/tour-skip-5` | 60.205686 | 1 |
| `local-browser-actions/tour-skip-6` | 73.196667 | 1 |
| `local-browser-actions/escape-tour` | 33.564327 | 1 |
| `local-browser-actions/wiki-maximize` | 1068.079480 | 1 |
| `local-browser-actions/wiki-minimize` | 64.276196 | 1 |
| `local-browser-actions/escape-wiki` | 4.074220 | 1 |
| `local-role-actions/role-view-viewer` | 30.040071 | 1 |
| `local-role-actions/role-view-new` | 1180.526794 | 1 |
| `local-role-actions/role-view-community` | 148.632089 | 1 |
| `local-role-actions/role-view-contributor` | 134.131655 | 1 |
| `local-role-actions/role-view-maintainer` | 132.747348 | 1 |
| `local-role-actions/account-menu-keyboard` | 68.131577 | 1 |
| `local-role-actions/promote-member` | 113.152262 | 1 |
| `local-role-actions/cancel-role-change` | 129.147637 | 1 |
| `local-role-actions/escape-role-dialog` | 44.768264 | 1 |
| `local-role-actions/demote-member` | 141.780784 | 1 |
| `local-role-actions/restore-member` | 133.890375 | 1 |
| `local-role-actions/sign-out` | 122.105505 | 1 |
| `local-role-actions/mock-sign-in` | 42.278710 | 1 |
| `local-role-actions/participation-promotes-community` | 477.935102 | 1 |
| `local-role-actions/retry-mock-sign-in` | 154.737603 | 1 |
| `local-wiki-actions/wiki-edit-maintainer` | 107.342450 | 1 |
| `local-wiki-actions/wiki-save` | 86.409738 | 1 |
| `local-wiki-actions/wiki-escape-maintainer` | 42.563383 | 1 |
| `local-wiki-actions/wiki-edit-contributor` | 75.566226 | 1 |
| `local-wiki-actions/wiki-propose` | 82.397851 | 1 |
| `local-wiki-actions/wiki-escape-contributor` | 86.888488 | 1 |
| `local-wiki-actions/wiki-role-change-closes-editor` | 31.678860 | 1 |
| `local-wiki-actions/wiki-agent-draft-review` | 763.025996 | 1 |
| `local-wiki-actions/wiki-agent-draft-propose` | 65.433265 | 1 |
| `machine-boundaries/machine-boundaries` | 0.353239 | 284 |
| `main-reducer-boundaries/main-reducer-boundaries` | 0.349657 | 287 |
| `maintenance-scripts/0/mythical-seed-write` | 432.298347 | 3 |
| `maintenance-scripts/1/mythical-seed-deterministic` | 415.748146 | 3 |
| `maintenance-scripts/2/mythical-seed-read-failures` | 559.980298 | 3 |
| `maintenance-scripts/3/agent-context-write` | 497.219709 | 3 |
| `maintenance-scripts/4/agent-context-check` | 282.151915 | 3 |
| `maintenance-scripts/5/agent-context-stale` | 257.000689 | 3 |
| `markdown/markdown-blocks` | 0.014926 | 6700 |
| `mcp/0/mcp-read` | 2182.724583 | 3 |
| `mcp/1/mcp-ask` | 2463.757276 | 3 |
| `mcp-warm/mcp-warm-read` | 1.001455 | 100 |
| `media-observe/media-observe` | 0.271782 | 368 |
| `mock-actions/mock-actions` | 151.876470 | 3 |
| `mock-close/mock-factory-close` | 0.382338 | 262 |
| `mock-history-agent/mock-agent-history` | 505.132030 | 3 |
| `mock-scripts/mock-scripts` | 0.057374 | 1743 |
| `mock-tour/0/mock-tour-complete` | 134438.476156 | 1 |
| `mock-tour/1/mock-tour-end` | 10.002421 | 3 |
| `model-config/model-config` | 0.543484 | 184 |
| `model-context-10/model-context-select-and-window` | 0.072164 | 1386 |
| `model-context-1000/model-context-select-and-window` | 1.821380 | 55 |
| `model-context-100000/model-context-select-and-window` | 238.444989 | 5 |
| `object-cancelled-receipt/object-cancelled-receipt` | 26.713564 | 3 |
| `object-host/object-post-alarm-recovery` | 266.982602 | 3 |
| `policies/flow-and-budget-policies` | 0.137870 | 726 |
| `protocol/0/event-encode` | 0.016876 | 5926 |
| `protocol/1/event-decode` | 0.009067 | 11029 |
| `protocol/2/snapshot-decode-10` | 0.054370 | 1840 |
| `protocol/3/snapshot-decode-1000` | 4.048015 | 25 |
| `protocol/4/snapshot-decode-100000` | 406.805010 | 5 |
| `protocol/5/route-roundtrip` | 0.034531 | 2897 |
| `provider-guards/provider-guards` | 0.530882 | 189 |
| `provider-host-refusals/provider-host-refusals` | 8.414771 | 3 |
| `reply-progress-decisions/reply-progress-decisions` | 0.243793 | 411 |
| `resources/0/resources-dev` | 18.711571 | 3 |
| `resources/1/resources-production` | 7.849210 | 3 |
| `resources/2/resources-factory.example.test` | 6.523311 | 3 |
| `runtime/runtime-startup-post` | 1142.474404 | 3 |
| `sandbox-agent/sandbox-agent-bindings` | 12.081865 | 3 |
| `sandbox-browser-actions/sandbox-open-pane` | 47.868703 | 1 |
| `sandbox-browser-actions/sandbox-start` | 63.509074 | 1 |
| `sandbox-browser-actions/sandbox-terminal-write` | 121.077500 | 1 |
| `sandbox-browser-actions/sandbox-stop` | 60.505449 | 1 |
| `sandbox-browser-actions/sandbox-restart` | 58.120190 | 1 |
| `sandbox-browser-actions/sandbox-read-retained-bytes` | 18.579743 | 1 |
| `sandbox-browser-actions/sandbox-maximize` | 52.756797 | 1 |
| `sandbox-browser-actions/sandbox-minimize` | 49.067273 | 1 |
| `sandbox-browser-actions/sandbox-escape` | 3.258565 | 1 |
| `sandbox-browser-actions/sandbox-viewer-controls` | 1256.947652 | 1 |
| `sandbox-factory-1/sandbox-file-restart` | 28.087465 | 3 |
| `sandbox-factory-100/sandbox-file-restart` | 432.868402 | 3 |
| `sandbox-meter/sandbox-meter-and-policy` | 0.303186 | 330 |
| `sandbox-public-workerd/workerd-sandbox-viewer` | 9.360908 | 3 |
| `sandbox-surfaces/0/cli-sandboxes` | 2072.024049 | 3 |
| `sandbox-surfaces/1/cli-sandbox-start` | 2258.705838 | 3 |
| `sandbox-surfaces/2/mcp-sandbox-file-restart` | 30.950430 | 3 |
| `screen-protocol-policies/screen-protocol-mock-policies` | 0.360154 | 278 |
| `sequencer/sequencer-lifecycle` | 0.986755 | 102 |
| `session-live-refusals/session-live-refusals` | 357.722188 | 3 |
| `session-runtime/session-runtime` | 394.875019 | 3 |
| `session-settings/session-settings` | 13.715973 | 3 |
| `session-settings-faults/session-settings-faults` | 2.022825 | 3 |
| `shared-decisions/0/shared-decisions` | 0.259165 | 386 |
| `shared-decisions/1/mythical-lookups` | 0.041225 | 2426 |
| `shared-decisions/2/sandbox-policy-layers` | 0.019123 | 5230 |
| `site/site-routing` | 36.921336 | 3 |
| `specification/specification-review-journey` | 50.537699 | 3 |
| `startup-theatre-decisions/startup-theatre-decisions` | 0.214918 | 466 |
| `surface-failures/0/cli-failure---mock ask  ` | 2191.155955 | 3 |
| `surface-failures/1/cli-failure---mock read --after -1` | 2001.339018 | 3 |
| `surface-failures/2/cli-failure---wat` | 2150.135618 | 3 |
| `surface-failures/3/cli-failure-read` | 2038.266134 | 3 |
| `surface-failures/4/mcp-unreachable` | 2142.510270 | 3 |
| `transport/transport-fault-matrix` | 26.331541 | 5 |
| `walkthrough-controls/walkthrough-controls` | 0.541921 | 185 |
| `web-10/0/keystroke-update` | 0.008494 | 11773 |
| `web-10/1/incoming-event-update` | 0.008580 | 11655 |
| `web-10/2/view` | 7.808808 | 3 |
| `web-1000/0/keystroke-update` | 0.008835 | 11319 |
| `web-1000/1/incoming-event-update` | 0.020510 | 4876 |
| `web-1000/2/view` | 47.786283 | 3 |
| `web-100000/0/keystroke-update` | 0.009267 | 10791 |
| `web-100000/1/incoming-event-update` | 1.372686 | 73 |
| `web-100000/2/view` | 3879.485330 | 3 |
| `web-account-state/web-account-state` | 0.383499 | 261 |
| `web-actions/web-actions` | 2.341501 | 43 |
| `web-content-commands/web-content-commands` | 60.343135 | 3 |
| `web-execution-commands/web-execution-commands` | 40.082969 | 3 |
| `web-issue-state/web-issue-state` | 4.909851 | 21 |
| `web-wiki-state/web-wiki-state` | 0.239907 | 417 |
| `wiki-cli/0/cli-wiki-read` | 2318.496244 | 3 |
| `wiki-cli/1/cli-wiki-draft` | 2154.629189 | 3 |
| `wiki-cli/2/cli-wiki-save` | 2408.243648 | 3 |
| `wiki-cli/3/cli-wiki-propose` | 2410.585552 | 3 |
| `wiki-edit-journeys/wiki-edit-journeys` | 33.004269 | 3 |
| `wiki-host-journey/wiki-host-journey` | 392.977706 | 3 |
| `wiki-host-recovery/wiki-host-recovery` | 1145.632396 | 3 |
| `wiki-mcp/0/mcp-wiki-read-readback` | 17.027440 | 3 |
| `wiki-mcp/1/mcp-wiki-draft-readback` | 7.300913 | 3 |
| `wiki-mcp/2/mcp-wiki-save-readback` | 9.108352 | 3 |
| `wiki-mcp/3/mcp-wiki-propose-readback` | 8.119183 | 3 |
| `wiki-script/wiki-script-journey` | 952.581336 | 3 |
| `wiki-view-matrix/wiki-view-matrix` | 10.885279 | 10 |
| `workerd/0/workerd-post-reply-read` | 340.454629 | 3 |
| `workerd/1/workerd-tour` | 135344.044894 | 3 |
| `workerd-actions/workerd-actions` | 2916.732783 | 3 |
| `workerd-sandboxes/0/workerd-sandbox-ledger` | 659.066125 | 3 |
| `workerd-sandboxes/1/workerd-sandbox-meter` | 337.237514 | 3 |
| `workerd-sandboxes/2/workerd-sandbox-public` | 12.020532 | 3 |

Deterministic gate: complete roster of indexed entry reads, `ceil(baseline × 1.05)` tolerance; zero stays zero. It does not gate noisy latency or detect uninstrumented work. Two real-runner controls additionally check exact callback counts and serial execution; they emit no latency artifact. Chromium first-render/Command-K/keystroke rows summarize three raw wall-time samples; individual action rows are single observations, not distributions.

**account-cookie-admission** — `2026-11-09T16-46-45.474Z-account-cookie-admission.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:45.474Z`. Vitest built-in bench; production cookie-name and admission functions. Exact secure/local names, three hosted origins, four loopback origins, 1/4096/4097-character values, eleven invalid/noncanonical origins, invalid characters and line terminators checked in every callback. Setup and assertions included. Limitations: Pure URL/cookie syntax admission; does not establish a valid signature, identity, broker exchange, role, real OAuth or production session. No network, request interception or credential used.

**accounts-lifecycle** — `2026-11-09T16-46-28.114Z-accounts-lifecycle.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:28.114Z`. Vitest built-in bench; actual product MockAccounts, policy and durable role-grant engine. Verify literal five-person fixture, once-only participation, duplicate no-op grant, promotions/demotions, final-maintainer/self-promotion refusals, complete five-event replay, identity schema round trip and sign-out. Three new scoped engines; initialization/assertions included. Limitations: Product fixture identity, not GitHub OAuth, production session cryptography or remote storage. One callback is the complete lifecycle, not a per-command latency.

**accounts-transport** — `2026-11-09T16-46-28.362Z-accounts-transport.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:28.362Z`. Vitest built-in bench; actual LiveAccounts adapter with an injected faulty Effect HttpClient. Seven operations across transport loss, forbidden/unavailable statuses, malformed JSON/protocol/SSE and bodyless 204; exact success/failure tags and bounded typed errors checked. Limitations: No request interception or real network. Invalid upstream answers measure failure handling, not GitHub sign-in success or WAN latency.

**accounts-workerd** — `2026-11-09T16-42-51.034Z-accounts-workerd.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:42:51.034Z`. Vitest built-in bench; real production account service, cookie signatures, SQLite sessions, durable role grants and current sandbox authority in local workerd. Each of three samples uses fresh signed/expired fixture sessions and a unique person; check tamper/expiry, self-promotion refusal, maintainer grant, current role, cross-origin refusal/unchanged state, People and session revocation; browser sign-in remains unavailable without broker configuration. Host startup excluded; requests/assertions included. Limitations: Only the unshipped test host issues fixture sessions with real signatures. This does not benchmark successful GitHub OAuth/consent, provider latency or production credentials. No cookie/token values enter artifacts; all configuration is synthetic.

**accounts-workerd-faults** — `2026-11-09T16-42-54.365Z-accounts-workerd-faults.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:42:54.365Z`. Vitest built-in bench; actual account configuration/router and journaled sign-in/callback flows in local workerd. Three samples each: missing configuration stays viewer/503; configured device route remains usable while missing broker configuration refuses browser sign-in; a real signed fixture person connects credentials with PKCE, then an injected faulty Effect GitHub exchange yields a visible failure redirect, consumed state/refused replay, cleared state cookie and no new session cookie. Original person session survives. Redirect following disabled. Startup excluded; crypto/storage/requests/assertions included. Limitations: The production GitHub service is replaced only by the existing host's explicit failing Effect service. No request interception, GitHub request, real login or successful provider exchange. Synthetic secrets/cookies remain in memory and are omitted from artifacts.

**action-catalog** — `2026-11-09T16-45-46.493Z-action-catalog.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:46.493Z`. Vitest built-in bench; every bundled flow declaration's presentation, command, minimum role and input kind, with the shared mayRun gate evaluated for all five roles per entry. Limitations: Presentation/policy cost only; a run's durable execution is benchmarked through the mock and workerd action surfaces.

**action-host** — `2026-11-09T16-45-58.680Z-action-host.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:58.680Z`. Vitest built-in bench; actual production action index/per-run hosts with real SQLite and product MockAccounts/Mythical services. Check once-only post acceptance, changed-input conflict, correlated terminal Post/Reply traces after two alarms, and cancelling a queued Plan before admission without any history mutation; unknown-commit Start settles failed with its exact refusal while accepted History Plan settles passed, keeps its real id and writes exactly one retained commit. Three new scoped worlds, migrations and assertions included. Limitations: Node SQLite/KV/alarm adapter, no workerd scheduling or remote storage. Deliberately unconfigured model fails the reply; no inference or GitHub mutation. The product mock provides local accounts/history.

**action-host-role-downgrade** — `2026-11-09T16-45-59.062Z-action-host-role-downgrade.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:59.062Z`. Vitest built-in bench; accept a real SQLite-backed history action, revoke its owner's role through product account flows, drive two alarms, then compare the terminal permission refusal and unchanged empty history. Three fresh worlds, setup and assertions included. Limitations: Product mock identities, no OAuth/provider call. Node SQLite/alarm host; measures admission/recovery overhead without a model.

**action-kernels** — `2026-11-09T16-45-46.235Z-action-kernels.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:46.235Z`. Vitest built-in bench; run snapshot/step acceptance orderings, terminal settle and cancellation, engine upsert identity and replay, pending acknowledgement identity, and VIP document authorship/path truth tables. Assertions included. Limitations: Pure in-process decisions; the durable action surface runs in the workerd benchmark.

**action-prepare** — `2026-11-09T16-45-46.756Z-action-prepare.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:46.756Z`. Vitest built-in bench; every invocation kind's schema preparation with client/operation identity defaults, then not-found and invalid-input failures as typed ActionFailures. Limitations: In-process preparation; the dispatch into durable engines is benchmarked through the mock and workerd action surfaces.

**action-tools** — `2026-11-09T16-45-47.482Z-action-tools.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:47.482Z`. Vitest built-in bench; all four actual action FlowBinding handlers invoked with real harness call identities and declaration digests over the product mock actions service; start announces its first run snapshot, read returns it and cancel acknowledges. Limitations: Binding/handler boundary without model selection or QuickJS; the same declarations serve CLI and MCP surfaces.

**actions-view-matrix** — `2026-11-09T16-46-01.856Z-actions-view-matrix.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:01.856Z`. Vitest built-in bench; Foldkit scenes render the actions pane collapsed with its latest badge, open and empty, the failed-run trace, per-selection run control and maximized state; merge/selection/completion decisions checked against slower or terminal snapshots. Limitations: Scene rendering and pure decisions; live runs stream through the mock and workerd action benchmarks.

**agent-projection** — `2026-11-09T16-46-21.963Z-agent-projection.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:21.963Z`. Vitest built-in bench; project partial cell answers, restart, sum token usage, bound input history and classify provider failures without disclosing messages. Limitations: Projection and policy only; actual agent and QuickJS cell execution measured in workerd.

**budget** — `2026-11-09T16-46-17.203Z-budget.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:17.203Z`. Vitest built-in bench; real budget over in-memory ledger; rounding/clamping, duplicate spend, admission at limit and exact ledger asserted. Limitations: In-process ledger; remote Durable Object transport excluded.

**cli** — `2026-11-09T16-37-09.985Z-cli.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:37:09.985Z`. Vitest built-in bench; spawn emitted CLI to exit with stdout/stderr capture; three samples per command, no warmup. Build excluded; loader/process startup included. Limitations: Mock backend for ask/read; no network/model. Source package loading contributes to startup.

**commands** — `2026-11-09T16-36-43.799Z-commands.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:36:43.799Z`. Vitest built-in bench; new scoped MockFactory/engine per call. Ask includes real scripted delays and settled answer; Read includes schema validation and layer lifecycle. Limitations: Product mock mode; no backend/model. Ask timing includes intentional 25ms per scripted chunk.

**content-workerd** — `2026-11-09T16-40-17.271Z-content-workerd.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:40:17.271Z`. Vitest built-in bench; each of three unwarmed samples starts fresh real workerd issue and wiki hosts. HTTP/SQLite commitments replay once; credentials are encrypted/session-bound/current-role/expiring; paid failed drafts charge once; partial write retryFrom adopts exactly one original child. Wiki draft privacy, contributor proposal/replay, forbidden Save, unchanged Markdown and one completed proposal journal row checked. Bundling, server lifecycle and assertions included. Limitations: Existing unshipped host supplies product fixture identities/repository; typed faulty Effect services exercise paid failures and partial recovery. No real GitHub write, OAuth or Container. Whole fresh-host corpus cost includes bundling and startup; it is not per-request latency or model inference.

**context-command-policies** — `2026-11-09T16-46-11.261Z-context-command-policies.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:11.261Z`. Vitest built-in bench; prompt eligibility, first duplicate identity, source-order indexes/windowing and correlated CLI/MCP collection through unrelated events, restart, finish/failure. Complete expected selections, answer fields/event numbers and outcome/error precedence checked. Limitations: Small in-process decision corpus, no model/IPC or service execution. Assertions included; large transcript cost is measured separately.

**core-10** — `2026-11-09T16-45-12.821Z-core-10.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:12.821Z`. Vitest built-in bench; 10 completed posts for single transitions; replay has exactly 10 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**core-1000** — `2026-11-09T16-45-13.615Z-core-1000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:13.615Z`. Vitest built-in bench; 1000 completed posts for single transitions; replay has exactly 1000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**core-100000** — `2026-11-09T16-45-14.429Z-core-100000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:14.429Z`. Vitest built-in bench; 100000 completed posts for single transitions; replay has exactly 100000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**dispatcher-decisions** — `2026-11-09T16-46-14.003Z-dispatcher-decisions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:14.003Z`. Vitest built-in bench; all eight storage-mark combinations for three ordered posts, exact independently listed first candidate, single attempted start/refusal and terminal no-op, plus empty queue. Assertions included. Limitations: Pure dispatcher decisions only; storage probes and durable starts are measured in object-host/workerd workloads.

**drafts-workerd** — `2026-11-09T16-41-02.347Z-drafts-workerd.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:41:02.347Z`. Vitest built-in bench; three fresh native workerd worlds run production VIP draft, wiki draft and specification reviewer AgentActions, SDK model HTTP/SSE, QuickJS and SQLite over one deterministic local model service. Exact schema answers, six metered tokens, three HTTP model calls and cached replay with no further call checked. Bundling/startup/assertions included. Limitations: Deterministic model responses measure flow/agent overhead without inference or WAN. No GitHub write, OAuth, Container or real provider spending. Whole fresh-host corpus is not per-request latency.

**factory-gates** — `2026-11-09T16-46-32.417Z-factory-gates.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:32.417Z`. Both acceptance predicates over the accepted fixture, sixteen single-review refusals including B+, keep and reset revision policies and person/agent approval; assertions included. Limitations: In-process decisions; excludes model inference, transport and storage.

**failure-views** — `2026-11-09T16-46-15.904Z-failure-views.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:15.904Z`. Vitest built-in bench; render every declared post failure and connection/tour failure with accessible retry/reconnect controls. Limitations: Scenes from state-machine client fixtures; no transport interception.

**gate** — `2026-11-09T16-46-18.232Z-gate.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:18.232Z`. Indexed entry reads through a transparent Proxy on completed-post fixtures of 10/1000/100000 entries. Correctness checked after counter capture. Allowed increase: ceil(baseline * 1.05); zero stays zero; exact roster required. Limitations: Counts entry access, not instruction count, allocations, network or latency; additional uninstrumented work requires timing review.

**history-10** — `2026-11-09T16-45-19.689Z-history-10.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:19.689Z`. Vitest built-in bench; 10 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**history-1000** — `2026-11-09T16-45-20.228Z-history-1000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:20.228Z`. Vitest built-in bench; 1000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**history-100000** — `2026-11-09T16-45-24.173Z-history-100000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:24.173Z`. Vitest built-in bench; 100000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**history-actions** — `2026-11-09T16-43-52.301Z-history-actions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:43:52.301Z`. Vitest built-in bench; history reducer corpus for page/read responses, forms, navigation/write intents, success/refusal, retries, late/detached data and events. Independent field, command-count and identity assertions; real commands execute in Chromium separately. Limitations: Reducer/command construction cost, no network or durable execution. Pages are actual projections of a two-commit fixture.

**history-bootstrap** — `2026-11-09T16-46-31.351Z-history-bootstrap.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:31.351Z`. Vitest built-in bench; three-commit first-parent/merge graph with rejected and landed queue entries; exact first-parent incremental order/cursor handling, bucket order/mapping, evidence, complete bootstrap and lossless seed projection/replay checked. Limitations: Small deterministic real-commit fixture; actual large committed snapshot decode measured separately; no GitHub call or repository mutation.

**history-browser-actions** — `2026-11-09T16-39-17.077Z-history-browser-actions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:39:17.077Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial Chromium journey over the full committed history and real MockMythical durable flows. Bootstrap, scripted work and automation included; no percentile. Fold changes only the product mock, never a real repository. Viewer UI omits writes; live writes are benchmarked as actual workerd refusals.

**history-browser-command-faults** — `2026-11-09T16-46-36.264Z-history-browser-command-faults.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:36.264Z`. Vitest built-in bench; typed faulty Effect Mythical service, four browser reads and five writes under both permission and transport failures. All exact message/reason projections and redaction checked. Three full corpora, setup/assertions included. Limitations: Deliberate service failures, no request interception or successful provider simulation; no network, repository writes or model.

**history-browser-commands** — `2026-11-09T16-46-36.155Z-history-browser-commands.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:36.155Z`. Vitest built-in bench; actual History Command effects over MockMythical's memory engine from empty history. Outline, Plan, epic/search, Start/Note/Approve/Fold and commit/missing detail; exact command messages, retained fields, notes, fold SHA and final six-event outline checked. Three fresh scoped engines, assertions included. Limitations: Shipped product mock main, no GitHub mutation, network, OAuth or actual repository fold. Command Effects without browser layout/DOM focus.

**history-catalog** — `2026-11-09T16-45-51.474Z-history-catalog.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:51.474Z`. Vitest built-in bench; real harness call identities/declaration digests invoke all four actual FlowBinding handlers and a populated outline reread after writes, including schema validation and result encoding; fresh product history engine, exact outputs and resulting signed note checked. Three samples. Limitations: No model selection or QuickJS process; this measures the binding/handler boundary directly. Real durable history flows run behind the binding.

**history-flow-policies** — `2026-11-09T16-46-11.031Z-history-flow-policies.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:11.031Z`. Vitest built-in bench; five roles × seven actions × human/agent; independent minimum-role matrix, authorization once, recording forbidden before authorization, single record except repeated fold, and illegal states checked. Limitations: Pure journal/policy decisions; actual durable flows and storage are separate workloads. Assertions included.

**history-flows** — `2026-11-09T16-45-24.346Z-history-flows.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:24.346Z`. Vitest built-in bench; actual MockMythical, sequencer and in-memory durable engine; plan/create epic, start, note, human approval and merge-queue fold; outline/detail composition and complete event replay equality checked. Three fresh engines. Limitations: Explicit human maintainer in a local fixture; product agent permission is measured separately. No real repository write or provider call.

**history-malformed-replay** — `2026-11-09T16-46-24.919Z-history-malformed-replay.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:24.919Z`. Vitest built-in bench; ten invalid event shapes across all seven event kinds, each checked as next, duplicate and gap. Invalid next content advances only the cursor; duplicates/gaps retain the original object and full state. Limitations: Pure replay boundary, deliberately malformed events; not storage transport corruption or authenticated admission.

**history-page-boundaries** — `2026-11-09T16-45-31.364Z-history-page-boundaries.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:31.364Z`. Vitest built-in bench; reversed physical commit array across two epics, notes and three real folds; exact stack order/counts/details, missing/negative cursor behavior, all four valid route/URI round trips, malformed Unicode path refusals and status classes checked. Limitations: Small deterministic projection/protocol corpus; no network or history mutation.

**history-pages-10** — `2026-11-09T16-45-26.759Z-history-pages-10.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:26.759Z`. Vitest built-in bench; 10 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**history-pages-1000** — `2026-11-09T16-45-27.553Z-history-pages-1000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:27.553Z`. Vitest built-in bench; 1000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**history-pages-100000** — `2026-11-09T16-45-31.124Z-history-pages-100000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:31.124Z`. Vitest built-in bench; 100000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**history-recovery** — `2026-11-09T16-46-24.607Z-history-recovery.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:24.607Z`. Vitest built-in bench; bootstrap a landed commit and pending sibling, reopen/amend, insert before sibling, refuse invalid plans, start/note/approve and fold exact trailer. Recreate the real sequencer over the same memory store; compare full independent expected state, every event, replay, schema round trip and duplicate identity. Each callback owns a new store. Limitations: In-memory durable-store contract and sequencer; no SQLite restart, repository write, network or model. Assertions and fresh store construction included.

**history-roles** — `2026-11-09T16-45-25.300Z-history-roles.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:25.300Z`. Vitest built-in bench; all five roles, human and agent; every agent forbidden to approve/fold, every role allowed to read, only human maintainer allowed to approve. Limitations: Pure policy cost; signed-in identity is a separate integration boundary.

**history-seed** — `2026-11-09T16-45-25.068Z-history-seed.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:25.068Z`. Vitest built-in bench; decode the actual committed VibeLang bootstrap projection; validate unique mythical identities, every real-commit mapping and the final main cursor. Three samples; module cached after its first import. Limitations: Snapshot parsing and validation, not a fresh network/GitHub import or bootstrap from an empty durable object.

**history-surfaces** — `2026-11-09T16-38-13.680Z-history-surfaces.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:38:13.680Z`. Vitest built-in bench; emitted CLI history/plan include startup and full committed bootstrap; persistent real MCP plan/start/note/history includes schema/IPC and four flows/calls. Three samples each, no warmup; exact detail, note author and unchanged main checked. Limitations: Product mock history, no repository mutation or model. MCP history grows by one planned commit per sample; handshake/bootstrap excluded from its timing.

**history-tools** — `2026-11-09T16-45-49.559Z-history-tools.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:49.559Z`. Vitest built-in bench; real tool catalog, product MockMythical and durable plan/start/note plus all four paged reads; contributor retell refusal, signed note, missing-input defaults and injected faulty Effect service. Three fresh lifecycle engines; fault handling short-run warmup. Limitations: Tool/flow overhead, no model inference or production storage. No approve/fold binding exists. Actual model choice and calls to these bindings inside QuickJS are not measured here.

**history-view-matrix** — `2026-11-09T16-46-00.742Z-history-view-matrix.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:00.742Z`. Vitest built-in bench; Foldkit scenes render the history list, epic, commit and plan pages across roles, states, filters, errors and dialog variants with exact control presence/absence assertions; refusal wording table included. Limitations: Scene rendering without layout/paint; the same journeys with real events run in Chromium and workerd benchmarks.

**history-web-10** — `2026-11-09T16-43-27.379Z-history-web-10.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:43:27.379Z`. Vitest built-in bench; 10 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**history-web-1000** — `2026-11-09T16-43-28.079Z-history-web-1000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:43:28.079Z`. Vitest built-in bench; 1000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**history-web-100000** — `2026-11-09T16-43-52.026Z-history-web-100000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:43:52.026Z`. Vitest built-in bench; 100000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**history-workerd** — `2026-11-09T16-27-29.692Z-history-workerd.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:27:29.692Z`. Vitest built-in bench; actual History Durable Object with full committed bootstrap, real SQLite durable flows and LiveMythical HTTP. First read measured once on a fresh object; warm outlines, first/second epic pages, commit detail, bounded search, five viewer refusals plus unchanged outline, and protocol errors measured three times. A keyed Plan binding runs twice with the same real cell identity and once with a new ordinal; exact cached response, one/two matching commits and cursor increments asserted across real SQLite flows. Server/bundler startup excluded; schema/assertions included. Limitations: Local workerd, no production network or model. First read is object bootstrap, not a forced cold isolate. Anonymous callers are viewers on this revision, so public writes remain forbidden; the separate keyed replay uses the test host’s trusted maintainer agent and actual production reader/binding/SQLite write path. No sign-in or GitHub write is claimed.

**http** — `2026-11-09T16-46-30.147Z-http.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:30.147Z`. Vitest built-in bench; real handler and sequencer; valid post/read/tour/end/events routing, body size/schema/name checks including lengthless multi-byte history overflow, cursor bounds, duplicate, and injected faulty Effect service returning Unreachable. Exact status and accepted state asserted. Limitations: In-process HTTP objects, no TCP; SQLite/durable engine covered in workerd.

**identity-cli** — `2026-11-09T16-42-10.417Z-identity-cli.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:42:10.417Z`. Vitest built-in bench; three complete journeys, four emitted CLI processes each, fresh scoped private settings. Decode every public schema, check signed fixture identity, settled answer, first/repeated logout and removed session file. Includes startup, durable session actions, scripted reply and assertions; build excluded. Limitations: Product mock sign-in, no OAuth, network, real session or model. This is whole-journey cost, not one-command latency. Private settings paths and contents are not retained.

**identity-labels** — `2026-11-09T16-41-39.970Z-identity-labels.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:41:39.970Z`. Vitest built-in bench; three literal guest/person/agent cases per callback over the production label decision, assertions included. Limitations: Pure presentation rule; does not prove signature validity, provider identity or role authority.

**identity-mcp** — `2026-11-09T16-42-14.763Z-identity-mcp.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:42:14.763Z`. Vitest built-in bench; persistent actual stdio MCP, discovery/startup excluded. Three five-call journeys: login, signed ask, logout, guest ask and full readback; literal author labels and exact settled reply count checked. Durable session actions, private file IO, schema/IPC, scripted replies and assertions included. Limitations: Isolated product mock settings, no OAuth/network/real session/model. Transcript grows by two posts per sample. Whole-journey cost, no percentile claim.

**issues-commands** — `2026-11-09T16-46-09.249Z-issues-commands.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:09.249Z`. Vitest built-in bench; each of eleven real product fixture issue commands from a fresh memory flow engine, nineteen committed fixture rows and maintainer identity. Three unwarmed samples each, with engine initialization, authorization, command, teardown and assertions included; exact affected row, cursor, unrelated rows and creation count checked. Limitations: Local product fixture host, no GitHub request, sign-in, network or model. Fresh-engine costs differ from a persistent UI session and successful writes do not claim production GitHub latency.

**issues-flows** — `2026-11-09T16-46-08.735Z-issues-flows.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:08.735Z`. Vitest built-in bench; fresh real makeIssueFactory, memory flow engine and host per callback; all eleven operations, retained intermediate writes, exact sequence, idempotent replay, literal proposal document, unchanged unrelated issues and complete schema equality. Three unwarmed whole-journey samples; initialization/assertions included. Limitations: Product fixture mode: no GitHub write, sign-in, repository review, network or model. One callback contains the entire journey; its latency is not a per-command latency.

**issues-host-journey** — `2026-11-09T16-44-38.060Z-issues-host-journey.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:44:38.060Z`. Vitest built-in bench; real serveIssues/executeIssues with SQLite, actual fixtureHost and changing Effect identity. Fresh world per sample; public projection strips untrusted approval, new/replay/changed request, human approval, saved receipt, revoked/agent writes, specification revision and missing reviewer checked. Exact HTTP statuses, retained body, once-only creation, approval and revision history asserted. Setup/assertions included. Limitations: Node HTTP values and real in-memory SQLite; no TCP, workerd scheduling, GitHub/OAuth or model. Product fixture host is explicitly injected. Whole journey is not per-command latency.

**issues-host-recovery** — `2026-11-09T16-44-43.283Z-issues-host-recovery.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:44:43.283Z`. Vitest built-in bench; production HTTP/SQLite issue adapter, fifteen injected typed Effect host failures, then a real fixture creation after explicit native retryFrom. Cached failure cannot retry implicitly; changed payload refused; exact matching recovery, replay, saved operation and missing receipt checked against unchanged fixture rows. Three fresh worlds; all assertions included. Phase-only diagnostic logs disabled. Limitations: Fault injection fails before the shipped fixture host; no own-code request interception, GitHub mutation or OAuth. Node SQLite in memory, no network/model. This is a complete fault/recovery corpus cost.

**issues-identities** — `2026-11-09T16-46-09.487Z-issues-identities.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:09.487Z`. Vitest built-in bench; actual Effect WebCrypto durable execution/recovery identity helpers checked against fixed SHA-256 vectors independently calculated with Python hashlib at authoring time of the canonical namespaced actor/operation/key tuples. Three operation identities and one recovery identity per callback. Limitations: Local digest and identity overhead, not a recovered remote execution or GitHub write.

**issues-policy** — `2026-11-09T16-46-08.969Z-issues-policy.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:08.969Z`. Vitest built-in bench; literal five-role by eleven-operation permission table, next/duplicate/gap projection, valid tree and self/missing/cycle refusals, all review label/close recovery states and request schema equality. Assertions included. Limitations: Pure policy/codec overhead with the nineteen-issue committed fixture; no storage, browser, GitHub or model.

**issues-reducer** — `2026-11-09T16-46-01.006Z-issues-reducer.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:01.006Z`. Vitest built-in bench; the full issues control table: navigation, filters, wizard steps with each validation, per-role forms and dialogs, saved-action retry identity and recovery keys, and request construction. Limitations: Pure reducer; the durable flows and views are benchmarked separately.

**issues-refusals** — `2026-11-09T16-46-09.666Z-issues-refusals.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:09.666Z`. Vitest built-in bench; actual product fixture engine with Effect-backed changing identity and participation service. Replay a cached commitment after downgrade to viewer, then assert eight exact domain refusals and unchanged state; successful new/comment call participation twice with exact identity. Three fresh engines; all assertions included. Limitations: Local authorization/domain boundary, no sign-in provider or GitHub request. Identity is a host-injected Effect service; no request interception.

**issues-view-matrix** — `2026-11-09T16-46-01.328Z-issues-view-matrix.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:01.328Z`. Vitest built-in bench; Foldkit scenes over the real app update/view render the issues pane list kinds, state and query filters, detail with notes and VIP review, commit/split/link dialogs, new and VIP wizard steps, the role matrix, connect gating, loading, failure and inline errors. Limitations: Scene rendering without layout/paint or a GitHub call; the write boundary runs in the issues fixture and workerd benchmarks.

**local-browser** — `2026-11-09T16-39-04.481Z-local-browser.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:39:04.481Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: Product mock mode, fresh browser context, shared browser/OS caches and automation overhead; no forced cold cache.

**local-browser-actions** — `2026-11-09T16-39-14.832Z-local-browser-actions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:39:14.832Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native-browser journey with real Foldkit and product MockFactory; timings include scripted delays and automation. External docs content is not asserted; only the correct pane URL and controls. Video timing begins after navigation; ready-state/decoded-frame observation and native programmatic pause/play include automation, browser caches and software decode, without physical control interaction. Touch is dispatched as native synthetic DOM events, not physical hardware. Single observations establish no percentile.

**local-role-actions** — `2026-11-09T16-39-24.614Z-local-role-actions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:39:24.614Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native-browser journey over the real product fixture account/role flows. Each role visit includes selection, identity visibility and (for signed roles) opening/checking/closing People. Other actions include confirmation or cancellation and resulting state. Sign-in/retry use the explicit mock identity host; no GitHub login, production identity, account mutation or model. Scripted reply/automation delays included; one observation per action establishes no percentile.

**local-wiki-actions** — `2026-11-09T16-39-27.395Z-local-wiki-actions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:39:27.395Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native Chromium journey through real product fixture flows. Maintainer Save and contributor Propose each open a review and preserve repository Markdown; reopening checks the original source. Escape, role revocation and a scripted agent draft are checked. No real GitHub writes, OAuth or model. Scripted waits and automation included; one sample per action establishes no percentile.

**machine-boundaries** — `2026-11-09T16-46-34.044Z-machine-boundaries.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:34.044Z`. Vitest built-in bench; complete reply/restart/tour lifecycles, admission boundaries, malformed replay, optimistic failure/retry/confirmation/gap/duplicate delivery; assertions included. Limitations: In-process state machine; not exhaustive input enumeration or proof.

**main-reducer-boundaries** — `2026-11-09T16-46-02.104Z-main-reducer-boundaries.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:02.104Z`. Vitest built-in bench; issue connection state with resume links, durable wiki visits with pane/people restoration and epoch reuse, action dispatch gating by selection and in-flight starts, slash dispatch clearing the draft, and sandbox start/stop/terminal controls with busy and blank-command refusals; exact emitted commands checked. Limitations: Reducer and command construction; the commands' durable execution is benchmarked through the mock factory.

**maintenance-scripts** — `2026-11-09T16-45-11.397Z-maintenance-scripts.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:11.397Z`. Vitest built-in bench; spawn each emitted script to exit over a real fixture jj repository and merge queue (seed) or the real installed vibelang skill (agent context); three samples each, no warmup. Fixture repository/queue construction is untimed setup. Write determinism, failed-read preservation and stale rejection are checked inside timed callbacks; the seed's parsed history content is fully asserted. Limitations: Fixture jj repositories, not VibeLang's real history; the full-history run's cost is dominated by its repository, not this fixture. Scripts write only inside the ignored dist-script-tests tree. Process/loader startup included; build excluded.

**markdown** — `2026-11-09T16-45-03.092Z-markdown.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:03.092Z`. Vitest built-in bench; parse a paragraph/code/paragraph answer; compare complete blocks. Limitations: Small fixed answer; rendering is measured separately.

**mcp** — `2026-11-09T16-37-24.043Z-mcp.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:37:24.043Z`. Vitest built-in bench; new emitted stdio server, real MCP initialize/discovery/call, validated schema and result; three samples, no warmup. Limitations: Includes process startup, handshake and teardown; mock backend; warm persistent-session call latency is measured separately.

**mcp-warm** — `2026-11-09T16-37-58.016Z-mcp-warm.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:37:58.016Z`. Vitest built-in bench; initialize and discover once outside timing; measure read calls on the same real stdio process, asserting the complete empty snapshot. Limitations: Product mock backend; schema/protocol/IPC included, startup/teardown excluded.

**media-observe** — `2026-11-09T16-46-40.900Z-media-observe.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:40.900Z`. Vitest built-in bench; actual media observation service for all image/video loaded/failed outcomes. Each counter dimension increases exactly one; capture and compare complete bounded log messages. Assertions and logger lifecycle included. Limitations: Effect telemetry boundary only; does not measure image download or video decode.

**mock-actions** — `2026-11-09T16-45-47.347Z-mock-actions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:47.347Z`. Vitest built-in bench; product MockActions over MockFactory: catalog, command table, button and slash starts, follow to settlement, per-flow runs, direct read, unknown command, invalid JSON input, missing run, cancellation and rerun; real unknown-commit History refusal settles failed with its exact reason, while an accepted History Plan settles passed with its real id. Three unwarmed samples. Limitations: Product mock backend; no model, network or workerd isolation. The same protocol against the real Worker runs in the workerd actions benchmark.

**mock-close** — `2026-11-09T16-36-36.133Z-mock-close.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:36:36.133Z`. Vitest built-in bench; build and close actual Factory scope, then verify a post is refused as unavailable. Limitations: Lifecycle cost, no model or network.

**mock-history-agent** — `2026-11-09T16-45-51.294Z-mock-history-agent.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:51.294Z`. Vitest built-in bench; fresh real MockFactory per sample, committed history decoded, journaled show tool, naturally streamed answer; exact repository main and epic counts independently composed and checked. Limitations: Product mock mode; three samples include intentional reply delays and history decode. No provider/model or network.

**mock-scripts** — `2026-11-09T16-36-35.880Z-mock-scripts.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:36:35.880Z`. Vitest built-in bench; script selection including fallback, reconstruct every selected reply from chunks. Limitations: Fixed synthetic prompts; syntax compilation remains in the separate unit suite.

**mock-tour** — `2026-11-09T16-36-35.625Z-mock-tour.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:36:35.625Z`. Vitest built-in bench; real MockFactory durable tour; verify each stop, complete exact script, busy refusal, ended-tour refusal and cancellation after first delta. One complete natural-paced run; three cancellations. Limitations: Includes production reading holds, based on each paragraph; one completion establishes no percentile. Product mock mode, no model/backend.

**model-config** — `2026-11-09T16-46-22.213Z-model-config.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:22.213Z`. Vitest built-in bench; actual Config and HostModel planning; default/unconfigured and configured model records, zero/default daily budget; no provider calls. Limitations: Configuration and route construction cost only.

**model-context-10** — `2026-11-09T16-45-52.423Z-model-context-10.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:52.423Z`. Vitest built-in bench; 10 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**model-context-1000** — `2026-11-09T16-45-52.675Z-model-context-1000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:52.675Z`. Vitest built-in bench; 1000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**model-context-100000** — `2026-11-09T16-45-54.294Z-model-context-100000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:54.294Z`. Vitest built-in bench; 100000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**object-cancelled-receipt** — `2026-11-09T16-46-07.623Z-object-cancelled-receipt.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:07.623Z`. Vitest built-in bench; real SQLite journal polling of an absent reply before and after a durable cancellation tombstone. Missing execution must remain an error; only recorded pre-admission cancellation returns no receipt. Three fresh scoped databases, setup and assertions included. Limitations: Deliberate absent-journal recovery boundary; no active model call or remote object.

**object-host** — `2026-11-09T16-46-07.423Z-object-host.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:07.423Z`. Vitest built-in bench; production conversation/request/alarm functions on the existing real node:sqlite host adapter. Two queued posts, malformed input and changed-owner duplicate, five alarms, exact ordered failure events, fresh sequencer recovery and ownership, budget/execution storage read/write/delete/alarm checks. Three fresh databases; initialization, durable migrations and assertions included. Limitations: Node SQLite with in-memory KV/alarm host, not workerd scheduling or disk durability. Deliberately unconfigured model exercises configuration failure, not inference. Actual workerd success paths remain separate workloads.

**policies** — `2026-11-09T16-46-10.566Z-policies.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:10.566Z`. Vitest built-in bench; strict admission, idempotent charging, accepted-only dispatch, reply attempt/offset/empty boundaries, tour terminal identity, retry classification and failure precedence; explicit behavioral truth tables. Limitations: Fixed in-process policy corpus; assertions dominate these small decisions, not an inference/model/storage measurement.

**protocol** — `2026-11-09T16-45-18.181Z-protocol.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:18.181Z`. Vitest built-in bench, Schema JSON codec, validated complete event round trips and snapshot length/tail; URL encode/decode. Setup excluded, assertions included. Limitations: In-process codec cost; no HTTP or network.

**provider-guards** — `2026-11-09T16-46-27.026Z-provider-guards.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:27.026Z`. Vitest built-in bench; exact safe issue/wiki error classification (precedence, retry interval, no provider detail), malformed/mismatched/noncanonical/unsafe VIP markers and invalid author, configured wiki file path and traversal/generated-index refusal. Every callback checks its outputs. Limitations: Pure guards and no-request early returns; no successful GitHub review validation, network, credentials or writes.

**provider-host-refusals** — `2026-11-09T16-46-27.171Z-provider-host-refusals.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:27.171Z`. Vitest built-in bench; actual GitHub issue/wiki host closures with an injected unavailable Effect HttpClient and changing principal. Missing key, credential connection, unavailable draft, unknown page, empty draft and anonymous write failures asserted. Wiki text persists before Connect. All writes make zero requests; one public read reaches the failing transport exactly once. Three fresh SQLite/KV worlds, setup/assertions included. Limitations: No request interception, external request, real credential, OAuth or GitHub mutation. Deliberate transport failure establishes refusal behavior only; successful provider paths remain unmeasured.

**reply-progress-decisions** — `2026-11-09T16-46-14.257Z-reply-progress-decisions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:14.257Z`. Vitest built-in bench; projected/partial/non-text/unknown deltas, retry reset retaining output and usage, exact safe-integer boundary, negative/unsafe/overflow usage latching invalidity, provider failure and completion precedence. Complete state comparisons inside timing. Limitations: SDK event projection policy, no provider decoding or inference. Actual agent/durable execution is separate.

**resources** — `2026-11-09T16-46-44.638Z-resources.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:44.638Z`. Vitest built-in bench; actual Alchemy stack compilation in temporary local state, dev/default production/domain variants; exact resource names, bindings, routes and CPU/observability settings checked. Three samples each, including layer/state-directory lifecycle. Limitations: Resource declarations only; no plan, deploy, provider lifecycle or Cloudflare account operation. Runtime object paths run separately in workerd.

**runtime** — `2026-11-09T16-45-36.260Z-runtime.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:36.260Z`. Vitest built-in bench, happy-dom with the actual startup program, stylesheet, Foldkit subscriptions/commands and MockFactory. Native Command-K and input/Enter; wait for the complete expected installed command. New scoped runtime each sample; 3 samples. Limitations: DOM runtime, no layout or paint; includes scripted reply delays and observer polling. Forced product mock mode, no network/model.

**sandbox-agent** — `2026-11-09T16-46-05.043Z-sandbox-agent.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:05.043Z`. Vitest built-in bench; actual harness bindings and stable cell identities over the real product mock flows. Invoke Start/Command/Stop/Start, replay old Stop, and read retained bytes through Command; verify bound conversation, catalog roster, generations and output. Three fresh engines. Limitations: Agent binding overhead without model selection or QuickJS; no Container. The public viewer boundary is measured separately; the SQLite lifecycle benchmark remains deferred by the compiler reproduction.

**sandbox-browser-actions** — `2026-11-09T16-39-20.947Z-sandbox-browser-actions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:39:20.947Z`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial real Chromium journey over product mock flows and supported terminal commands; exact retained terminal transcript checked across Stop/Start. No model/backend/real Container. Forced mock roles never grant live authority. Automation and scripted waits included; no percentile.

**sandbox-factory-1** — `2026-11-09T16-46-03.499Z-sandbox-factory-1.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:03.499Z`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 1 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**sandbox-factory-100** — `2026-11-09T16-46-04.900Z-sandbox-factory-100.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:04.900Z`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 100 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**sandbox-meter** — `2026-11-09T16-46-03.290Z-sandbox-meter.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:03.290Z`. Vitest built-in bench; five role allowances, distinct identity/lease bounds, exact two-running-box accounting across a UTC boundary, rollback/high-water recovery, snapshot rounding, invalid clock domains and safe-sum overflow. Independent numeric totals checked; assertions included. Limitations: In-process normalized-clock fixtures, not a fake global clock or Container performance. Real-clock host/flow paths are separate workloads.

**sandbox-public-workerd** — `2026-11-09T16-27-29.886Z-sandbox-public-workerd.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:27:29.886Z`. Vitest built-in bench; actual local workerd public sandbox router through LiveFactory: viewer snapshot, Start/Stop/Command forbidden, then unchanged empty state; exact typed refusals and all snapshot fields checked. Three serial five-request samples; bundling/server startup excluded. Limitations: Signed-out deployment boundary only, no trusted compute identity, Container or SQLite lifecycle. The separate sandbox SQLite benchmark is deferred by the nested-Effect compiler reproduction; this case does not substitute for it.

**sandbox-surfaces** — `2026-11-09T16-38-29.492Z-sandbox-surfaces.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:38:29.492Z`. Vitest built-in bench; emitted CLI read/start includes cold process/layer setup. Persistent real stdio MCP starts, writes, stops, restarts, reads retained bytes, stops and verifies snapshot through seven calls; full twenty-command catalog and exact generations/output checked. Three samples; MCP handshake excluded. Limitations: Product mock backend and maintainer surface principal, no real Container, model or repository write. MCP keeps one engine across samples and grows its receipt history; CLI gets a fresh engine each time. Assertions and IPC included.

**screen-protocol-policies** — `2026-11-09T16-46-10.802Z-screen-protocol-policies.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:10.802Z`. Vitest built-in bench; actual extracted screen/protocol/mock decisions, independent truth tables for shortcut priority, scroll revisions, input bounds, routing/status, backend choice and script priority. Module imports/setup excluded, correctness assertions included. Limitations: Fixed policy corpus; assertion overhead dominates. DOM, HTTP and actual agent flows are separate workloads.

**sequencer** — `2026-11-09T16-46-16.952Z-sequencer.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:16.952Z`. Vitest built-in bench; real sequencer on an in-memory append-only log. Post/refusal/duplicate, reply pieces, duplicate/stale pieces, restart, final replacement, tour, follower and fresh sequencer replay. Exact transcript and ordered events asserted; model history excludes tour narration while the transcript retains it. Limitations: In-process log, no storage I/O; SQLite/workerd measured separately.

**session-live-refusals** — `2026-11-09T16-45-43.695Z-session-live-refusals.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:43.695Z`. Vitest built-in bench; actual native signIn/signOutSurface, SDK SQLite journal and real loopback HTTP faulty Effect service. Three invalid origins make no request; local device-route 503 and sign-out 503 produce exact safe failures. Failed revocation still deletes private credentials; repeated logout is false; exactly two requests asserted. Three fresh scoped samples. Limitations: Deliberately refusing loopback service; no request interception, OAuth grant, real token, external network or production write. Measures refusal/validation and durable IO overhead, not successful sign-in.

**session-runtime** — `2026-11-09T16-45-42.512Z-session-runtime.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:42.512Z`. Vitest built-in bench; real platform-node SQLite host for sessionOperation and waitForSignIn. Action succeeds/fails, Poll completes on its first check or injected typed check failure. Exact statuses, propagated safe failure, counter increment and four bounded content-free telemetry records asserted. Three fresh private journals; setup/teardown included. Limitations: Deterministic action/check results measure durable flow overhead, not GitHub authorization, device polling intervals or WAN latency. No provider credential is used.

**session-settings** — `2026-11-09T16-45-41.084Z-session-settings.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:41.084Z`. Vitest built-in bench; real scoped filesystem settings lifecycle: absent/full replacement, separate mock/live session, exact 0700/0600 modes, pending grant retained/expired/deleted, repeated removal, invalid JSON/schema refusal, HOME fallback/missing HOME, explicit credential validation. Three unwarmed full corpora; setup, disk IO and correctness checks included. Limitations: Synthetic fixture values only; no OAuth/network. Local filesystem and process cache, no fsync/crash-durability claim. Private paths/contents omitted from artifacts.

**session-settings-faults** — `2026-11-09T16-45-41.222Z-session-settings-faults.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:41.222Z`. Vitest built-in bench; actual settings functions with an injected faulty Effect FileSystem chmod/remove over real temporary directories. Preparation/write/removal return exact safe reasons and no session file is published. Three fresh scoped samples, assertions included. Limitations: Permission failures are injected, not measured OS permission policy; no credential/OAuth/provider action.

**shared-decisions** — `2026-11-09T16-45-47.996Z-shared-decisions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:47.996Z`. Vitest built-in bench; inline/rich Markdown and safe-link table, build-time HTML with anchors and escaping, wiki path normalization/lookup/request mapping, role standing, VIP document rendering, sandbox pane decisions, media failure memory, mythical miss-path lookups and both sandbox policy layers. Limitations: Pure functions and layer reads; the wiki's durable open flow and workerd surfaces are benchmarked separately.

**site** — `2026-11-09T16-46-40.094Z-site.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:40.094Z`. Vitest built-in bench; production site Worker router over a real loopback HTTP file server serving repository home/logo bytes with SPA fallback, and real API handler health. Exact bodies, mock/live health and every rejection status checked. Three fresh scoped servers; startup/teardown included. Limitations: Local service-binding adapter over HTTP, no Cloudflare PoP or deployed asset cache; API error dependency is a deliberately faulty Effect service. Actual compiled UI/layout measured separately in Chromium.

**specification** — `2026-11-09T16-46-35.074Z-specification.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:35.074Z`. Vitest built-in bench; actual product issue flows and memory durable engine. Revise accepted specification, refuse stale/empty edits, collect all four scripted named reviews with A- grades and an optional second Opus review, verify once-only replay, keep acceptance on another revision and invoke the same review through the mock chat command. Complete review-history tuples and unchanged issues checked. Three fresh engines; setup/assertions included. Limitations: Product scripted reviewer behavior, no real model review, grade quality assessment, GitHub write or network. Named model performance belongs to an explicitly configured live workload.

**startup-theatre-decisions** — `2026-11-09T16-46-14.495Z-startup-theatre-decisions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:14.495Z`. Vitest built-in bench; explicit query/storage precedence and persistence, role/session admission, tutorial resume and auto-start choices, every theatre target, speech state transitions, bounded telemetry labels and keyboard wrap. Literal expected choices asserted inside timing. Limitations: Pure policy decisions; browser DOM, storage, layout and native speech execution are separate runtime boundaries.

**surface-failures** — `2026-11-09T16-37-55.732Z-surface-failures.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:37:55.732Z`. Vitest built-in bench; emitted processes reject blank/invalid input, unknown flags and an actually closed loopback endpoint. Exact exit/status stream and public error checked; three samples each. Limitations: Unreachable loopback, no request interception; process startup and error rendering included.

**transport** — `2026-11-09T16-46-25.647Z-transport.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:25.647Z`. Vitest built-in bench; inject a faulty Effect HttpClient into the actual Factory and Mythical adapters. Measure all chat/history/sandbox/terminal operations across transport errors, status failures, malformed JSON/protocol; exact safe typed error checked, no response body leaks. Limitations: Deliberate faulty service, no request interception; failure handling overhead without network latency. Successful transport paths run through real workerd.

**walkthrough-controls** — `2026-11-09T16-46-33.220Z-walkthrough-controls.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:33.220Z`. Vitest built-in bench; forty real state transitions over the exact ten-step catalog with elapsed reading time, pause and resume. Checks every accepted intent, current destination, preserved agent entry and exact remaining time. Limitations: Pure transition cost with assertions; no browser layout, network or durable SQLite execution.

**web-10** — `2026-11-09T16-44-50.160Z-web-10.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:44:50.160Z`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**web-1000** — `2026-11-09T16-44-50.723Z-web-1000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:44:50.723Z`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**web-100000** — `2026-11-09T16-45-02.774Z-web-100000.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:02.774Z`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**web-account-state** — `2026-11-09T16-46-12.692Z-web-account-state.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:12.692Z`. Vitest built-in bench; account/People/menu/grant/cancel/sign-in/out reducer corpus with all five roles, exact emitted work, three command retries, role-stream recovery and duplicate/gap/demotion fences. Every callback asserts state and ordered command names. Limitations: Pure reducer policy cost, no native dialogs, OAuth, network or persistence; runtime services and browser journeys are separate benchmarks.

**web-actions** — `2026-11-09T16-46-15.634Z-web-actions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:15.634Z`. Vitest built-in bench; all person-facing reducer messages, optimistic post retry, replay gap, connection, scroll, palette, splash and tour controls; scene assertions for retry and Esc. Limitations: Reducer/scene cost, no browser layout; native input and modal focus are covered by Chromium separately.

**web-content-commands** — `2026-11-09T16-46-23.614Z-web-content-commands.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:23.614Z`. Vitest built-in bench; real Foldkit Command effects over one scoped MockFactory, including identity/grant/readback, issue creation/details/projection, wiki editor/private draft/Save/readback and sign-in/out. Exact messages, source, public author/role and once-only review checked. Three fresh engines; setup, flow execution and assertions included. Limitations: Effect command boundary without DOM layout/paint; shipped product fixture services, no network/OAuth/GitHub/model. Full journey cost, not per-keystroke latency.

**web-execution-commands** — `2026-11-09T16-46-23.851Z-web-execution-commands.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:23.851Z`. Vitest built-in bench; actual Command effects over MockActions/Factory: catalog, Tour run/read/cancel and invalid input, sandbox file write/stop/restart/readback, then faulty action discovery/read/cancel. Exact ids, states, generations, retained output and request/epoch fields checked. Three fresh engines, assertions included. Limitations: Product mock runtime, no actual Container, model or network. Command-level journey includes initialization and IO; native browser layout separately benchmarked.

**web-issue-state** — `2026-11-09T16-46-12.947Z-web-issue-state.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:12.947Z`. Vitest built-in bench; saved new/VIP/comment/specification requests across completed/failed/running receipts, unrelated error fence, seven exact failure labels, unwritten correction, selected-detail cursor fences and live detail dispatch. Literal text/identity/state and ordered emitted work checked each callback. Limitations: Reducer/restoration overhead only; no request/transport interception, network, provider write or model.

**web-wiki-state** — `2026-11-09T16-46-13.188Z-web-wiki-state.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:13.188Z`. Vitest built-in bench; wiki editor begin/type/submit/cancel, immutable uncertain request, stale completion/failure fences, five exact failure labels and unwritten correction, unchanged observed source with review, filter/location and page-open failure identity. Exact model fields asserted each callback. Limitations: Pure update-state cost; does not execute emitted services or simulate browser dialogs/network. Native and SQLite wiki journeys run separately.

**wiki-cli** — `2026-11-09T16-43-23.169Z-wiki-cli.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:43:23.169Z`. Vitest built-in bench; three unwarmed samples for each wiki operation, spawning the actual emitted CLI to exit. Validated schema, fixture role, full read/draft bytes and exact first review identity. Build excluded; process startup and assertions included. Limitations: Product mock backend and maintainer principal, fresh engine each call. Save and Propose open fixture reviews; no GitHub mutation, OAuth or model. Command-line source arguments remain in memory and never enter artifacts.

**wiki-edit-journeys** — `2026-11-09T16-46-46.506Z-wiki-edit-journeys.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:46.506Z`. Vitest built-in bench, three whole-journey samples. Each sample initializes two independent real fixture repositories/engines, reads source, drafts, submits by each role, replays and verifies unchanged Markdown and exactly one review per repository. Assertions included. Limitations: Product fixture mode; excludes real GitHub, credentials, model generation and network. Whole-journey latency is not per-command latency or a coverage claim.

**wiki-host-journey** — `2026-11-09T16-44-44.591Z-wiki-host-journey.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:44:44.591Z`. Vitest built-in bench; production serveWiki/executeWiki and SQLite runtime over real fixtureWikiHost. GET/read, private draft/readback, maintainer Save, exact replay and changed-payload refusal, contributor gate/Propose and agent refusal. Original source, literal draft, two distinct review receipts and exact retained proposals checked; three fresh worlds, setup/assertions included. Limitations: Product fixture repository, no GitHub/OAuth/network/model. Node HTTP objects and in-memory SQLite; no claim of actual provider review creation or workerd scheduling. Whole-journey cost.

**wiki-host-recovery** — `2026-11-09T16-44-48.150Z-wiki-host-recovery.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:44:48.150Z`. Vitest built-in bench; nine typed faulty Effect host outcomes through production HTTP/SQLite, failure receipt replay, changed request rejection and native retryFrom into shipped fixtureWikiHost. Exact statuses, original request, once-only review and unchanged Markdown checked; three fresh worlds, assertions included. Limitations: Fault service fails before host writes; no HTTP interception. Local SQLite, no provider/real credentials/model/network. No successful GitHub or OAuth coverage claimed.

**wiki-mcp** — `2026-11-09T16-43-25.499Z-wiki-mcp.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:43:25.499Z`. Vitest built-in bench; one real persistent stdio process, initialization/discovery excluded. Three samples per operation. Each measured callback includes the command plus a source-readback call; Save/Propose also include an identical-request replay and compare the complete result. Full original source, role, draft bytes and cleared submitted draft checked; schema/IPC/assertions included. Limitations: Product fixture wiki; no GitHub mutation, OAuth or model. The persistent engine grows its review history; command-plus-validation roundtrips are not single-call wire latency. No percentile claim.

**wiki-script** — `2026-11-09T16-45-39.731Z-wiki-script.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:45:39.731Z`. Vitest built-in bench; actual emitted wiki generator over fixture files in the compiler's ignored output tree. Build twice, remove a required receipt and then the directory. Check exact page roster/order, nested/absolute/external/hash links, ruling deduplication, status/suite metadata, byte-identical second build and preserved output after both real read failures. Three complete four-process journeys; filesystem setup/assertions included, compilation excluded. Limitations: Small fixture wiki; not a full-site build throughput measurement. Child process startup, source loading and filesystem work included. Run independently of ordinary wiki-process tests, which use the same compiler fixture directory.

**wiki-view-matrix** — `2026-11-09T16-46-01.606Z-wiki-view-matrix.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:46:01.606Z`. Vitest built-in bench; Foldkit scenes over the real update/view render the wiki pane's index, decision chrome, loading skeleton, error with retry, filtered and empty navigation and tour-maximized state. Limitations: Scene rendering without layout/paint; the durable open flow is benchmarked through the mock factory and workerd.

**workerd** — `2026-11-09T16-34-17.094Z-workerd.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:34:17.094Z`. Vitest built-in bench; actual local workerd Durable Objects, SQLite engine, alarms, LiveFactory HTTP/SSE, agent and QuickJS; deterministic HTTP model service. Three new conversations each, unwarmed. Bundling/server startup excluded; post-through-settle/read included. Limitations: Flow/adapter overhead, no model inference, WAN or production contention. Tour includes ten real durable reading holds, totaling 134 seconds. Test host delegates to production Objects/Http; Alchemy's deploy-only wiring is not run.

**workerd-actions** — `2026-11-09T16-44-33.211Z-workerd-actions.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:44:33.211Z`. Vitest built-in bench; real local workerd API Worker with the deterministic model service: LiveActions list/commands/start/cancel/follow/runs/read/rerun/slash and its typed failures, then signed sessions run Post and History Plan to settlement; decode the real History result, require one matching retained commit, replay the exact request and require unchanged readback, with the input/authority/conflict/not-found matrix and cross-origin refusal. Limitations: Flow/adapter overhead over local workerd, no WAN or production contention; model replies are deterministic HTTP fixtures. Three samples per command on one served instance.

**workerd-sandboxes** — `2026-11-09T16-41-38.099Z-workerd-sandboxes.json`; source `0aede2351637910237f39e1304df2ce6599d4952`, UTC `2026-11-09T16:41:38.099Z`. Vitest built-in bench; the per-person sandbox ledger object in real workerd SQLite with the product in-memory machines: start/write/stop/restart with generation fencing, stale and replayed receipts, retained bytes, metering and pruning, plus the public HTTP boundary's signed-out snapshot, forged-role refusal, routing and body admission. Limitations: In-memory machines stand in for the opt-in Cloudflare Container; container latency is not measured. Three samples per journey on one served object.


Publication continuity: after collection on production parent `ca292c70`, main advanced to `bf596767`. No app src/worker/bench/infra or native benchmark host changed. The browser helper only adds exports unused by benchmarks; new ordinary coverage tests and an unused helper are checked by the full post-rebase unit/typecheck run. MVP deployment/analytics changes do not reach the imported broker host; the private-adapter change emits declarations only. Timing and coverage remain attributed to their exact archived pre-rebase source, never relabeled. The intervening patch and validation receipts are retained with the lane report.

## Device sign-in (2026-11-10, nyc-01)

Vitest built-in bench, three fresh scoped samples each, local. `login` and `logout` run the actual `signIn`/`signOutSurface` over real loopback HTTP to the Accounts object and the identity-provider device fixture (`test/support/deviceSignIn.vibe`). No GitHub credential, no request interception.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| signin-device | 1141.9 | 3 | `2026-11-10T03-17-23.024Z-signin-device.json` |
| signin-device-refusals | 1200.6 | 3 | `2026-11-10T03-17-26.828Z-signin-device-refusals.json` |

**signin-device.** Start, a pending poll, an authorized poll, a remembered session, and a revoking sign-out. Exact statuses and an empty settings directory are checked.

**signin-device-refusals.** Declined, expired, slow-down back-off to 30 s, a forged stored session, and a waited sign-in the person declines. Exact sentences and the back-off are checked.

Limitations: the identity provider is a local fixture, so GitHub's latency and rate limits are absent; the fixture's poll interval is 0 s, so no poll waits; the slowed flow is not waited out.

## CLI text mode and sandbox faults (2026-11-10, nyc-01)

Vitest built-in bench, local.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| cli-text | 83387.4 | 3 | `2026-11-10T03-55-52.351Z-cli-text.json` |
| sandbox-faults | 3.7 | 28 | `2026-11-10T03-59-01.249Z-sandbox-faults.json` |
| sandbox-held-command | 3.7 | 27 | `2026-11-10T03-59-01.594Z-sandbox-held-command.json` |

**cli-text.** 24 emitted CLI processes per sample in text mode with `--mock` and fresh private settings: read, ask, history (epic, commit, unknown epic and commit), plan, start, note, the four sandbox commands, actions, run (waited and invalid input), trace, cancel, rerun, issues, issue, wiki, login and logout. Exit status and the exact first output line are checked. Limitations: mock factory, no network or model; the mock's state lives for one process, so trace, cancel and rerun of a real run, and a command on a live sandbox generation, are measured as refusals; process startup dominates (about 3.5 s per command on a loaded machine), so this is whole-journey cost, not one-command latency.

**sandbox-faults.** `makeSandboxHost` over an in-memory store with the product in-memory machines and a faulty machine service, TestClock time: a start, a repeated start answered by receipt, a start whose provisioning fails, a start that outlasts the allowance while it provisions, and a clock outside the calendar that stops what runs. Exact refusals, the stops issued and the fail-closed ledger are checked. Limitations: no Durable Object storage or container latency; the 2 s provisioning delay is simulated.

**sandbox-held-command.** Two hosts over one store: the first host's command is held inside the machine, the second runs the same operation and records its answer, and the released first host returns that answer. Limitation: one process stands in for two hosts.

## Web sign-in (2026-11-10, nyc-01)

Vitest built-in bench, local. The Accounts object on a real loopback server over in-memory object storage, a fresh object per sample, with an injected GitHub auth service (`test/support/accountsWorld.vibe`).

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| accounts-web-sign-in | 284.6 | 5 | `2026-11-10T04-47-52.486Z-accounts-web-sign-in.json` |
| accounts-web-refused | 207.4 | 5 | `2026-11-10T04-47-54.243Z-accounts-web-refused.json` |

**accounts-web-sign-in.** The sign-in redirect, the OAuth callback with the state and code GitHub would carry, the session, anonymous and malformed role-event requests, sign-out and the session after it. Exact statuses, redirect and identity are checked.

**accounts-web-refused.** A GitHub code exchange that refuses: the callback answers with the failure redirect, clears the state cookie and sets no session.

Limitations: GitHub is an injected service, so there is no network or GitHub latency; storage is in memory, not Durable Object SQLite. Issue and wiki routes are measured in the next section.

## Signed-in issue and wiki routes (2026-11-10, nyc-01)

Vitest built-in bench, local, 11:08–11:11 UTC, load average 149–163 on 32 cores. The Accounts object on a real loopback server over in-memory object storage, a fresh object per sample, after web sign-in (`bench/issues-wiki-web.bench.vibe`).

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| issues-wiki-web | 3,961.3 | 5 | `2026-11-10T11-11-19.879Z-issues-wiki-web.json` |

**issues-wiki-web.** Sign-in, the issue list, a new issue, a comment, a wiki page read, a Save and the same Save again, through the durable issue and wiki flows with the product's injectable `IssueHost` (in memory) and `WikiHost` (the fixture repository). Exact statuses, role, issue fields, page source and the idempotent Save's review link are checked. Per request, 7 samples with warmup: 56–1,240 ms.

Limitations: injected services, so no GitHub latency (GitHub unreachable is `accounts-github-offline`); in-memory storage, not Durable Object SQLite; the person has not connected GitHub, so Connect GitHub paths and a connected person's write retry window are not measured (0165). The shared host was 5× oversubscribed, so wall times are observations, not a baseline.

## Broker sign-in and Connect GitHub (2026-11-10, nyc-01)

Vitest built-in bench, local, `bench/accounts-broker.bench.vibe`. Load average about 110 on 32 cores during the run.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| accounts-broker-connect | 7,580.2 | 3 | `2026-11-10T09-55-12.100Z-accounts-broker-connect.json` |
| accounts-connect-refused | 1,341.1 | 5 | `2026-11-10T09-55-23.659Z-accounts-connect-refused.json` |

**accounts-broker-connect.** smithers.sh's broker, the site's Accounts object and the person's connection object in
local workerd on durable SQLite (`test/workerd/authbroker.vibe`), one host for all samples. Each sample signs in
through the broker, reads the session, the handoff page, an unknown route and a malformed callback, checks five
Connect and Disconnect refusals, connects GitHub with a wiki page to return to, disconnects, connects with an issue to
resume, and disconnects. Statuses, return locations, the person's identity and the connection object's revocations
are checked.

**accounts-connect-refused.** The Accounts object on a loopback server over in-memory storage: an agent's device
session presses Connect (403), a person on a site with no broker presses Connect (503), then disconnects (303).

Limitations: GitHub is the host's injected token service, so there is no GitHub request or latency. No issue or wiki
request is made. Broker and site share one workerd process over loopback.

## Account step cost by history (2026-11-10, nyc-01)

Vitest built-in bench, local, `bench/accounts-history.bench.vibe`. Load average about 116.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| accounts-step-after-10 | 226.2 | 3 | `2026-11-10T09-42-10.744Z-accounts-step-history.json` |
| accounts-step-after-150 | 429.1 | 3 | same |

One journaled account step (sign-out without a session) after 10 or 150 earlier steps on a fresh Accounts object.
Each step builds its own engine runtime, and the journal decodes up to 4,096 recent events, with two canonical
fingerprints each, as it opens (`SqlJournal`, `sourceEventCache`). A CPU profile of 30 steps after 270 earlier ones
put 5.3 s in `encodeFingerprint`, against 0.5 s for the first 30. Since `462049cc` Accounts forgets settled steps a
day after they finish (`EXECUTION_RETENTION`; regression test `test/accountsRetention.test.vibe`), which bounds the
history to one day's steps; the per-open decode itself is a `@smthrs/journal` cost and is not changed here.

Limitations: node:sqlite in memory, and the fixture prepares every statement on each call; all steps fall within one
day, so retention deletes nothing in this benchmark; wall time is observational.

## Tour repeat, failed replies and the agent's history tools (2026-11-10, nyc-01)

Vitest built-in bench, local. Load average 115 to 140 during the runs.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| action-tour-repeat | 1,177.7 | 3 | `2026-11-10T11-37-26.712Z-action-tour-repeat.json` |
| reply-outcomes | 7,106.5 | 3 | `2026-11-10T11-33-47.014Z-reply-outcomes.json` |
| agent-history-tools | 3,863.8 | 3 | `2026-11-10T11-35-45.227Z-agent-history-tools.json` |

**action-tour-repeat** (`bench/action-tour-repeat.bench.vibe`). The production action index and per-run hosts over
node:sqlite object storage, a fresh world per sample. A maintainer starts Tour, then starts the same request again
before its alarm: the second press joins the running tour. One running Tour run and one open guide entry are
checked. A press that finds its tour accepted after its host stopped is action-crash-retry.

**reply-outcomes** (`bench/reply-outcomes.bench.vibe`). The API Worker's production objects in workerd with the
deterministic model service. Two posts per sample: the model answers "Bench empty." with an empty result and "Bench
throws." with a cell that throws. Each reply ends in ReplyFailed with the person's reason ("The model returned no
answer.", "The agent failed. Try again.") and a done agent entry carrying it.

**agent-history-tools** (`bench/agent-history.bench.vibe`). Same host. For "Bench history." the model's cell reads the
outline, the first epic's page, that page's first commit and a search for its title, then calls Plan and Note. Each
page is checked against the one before it; both writes are refused `forbidden` for a signed-out guest.

Limitations: deterministic model, so no inference latency; objects reach each other by fetch, not Alchemy RPC; the
guest's Plan and Note measure their refusal, not a history write; the tour itself does not run in action-tour-repeat.

## Runs interrupted partway (2026-11-10, nyc-01)

Vitest built-in bench, local, `bench/action-interrupted.bench.vibe`. Load average about 50.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| action-crash-retry | 314.5 | 3 | `2026-11-10T13-28-37.109Z-action-crash-retry.json` |
| action-reply-interrupted | 719.5 | 3 | `2026-11-10T13-28-39.420Z-action-reply-interrupted.json` |

**action-crash-retry.** The production per-run host over node:sqlite object storage, a fresh world per sample. The
first host incarnation stops right after the conversation accepts a post (or starts a tour): that write commits and
every later write on the incarnation dies (`stopsAfter`, `test/support/actionObjects.vibe`). The person's retry
reaches a fresh incarnation over the same storage. Checked: the first start failed, the retry answers null without
posting twice, the post run settles passed, the tour keeps one open guide entry, and both retries schedule the alarm.

This workload found a bug, fixed with it: the post's first step traces before the post is accepted, so a stopped host
leaves the run `running`, and the retry answered null with no alarm and no settlement. The post's run stayed running
for good and its reply never woke. The retry now recovers a running post or tour as it does a queued one
(`worker/ActionRuns.vibe`; regression tests in `test/actionRuns.coverage.test.vibe`).

**action-reply-interrupted.** Same host with MockFactory, Mythical history and the scripted model service
(`fuzz/model-server.vibe`). One post's reply meets a conversation log that dies on its first settle write: the engine
fails the reply and the host fails its open entry ("Action failed"). Another post's reply is held at spend admission
while the person cancels it, then released: it ends cancelled, not answered.

Limitations: node:sqlite and an alarm field, not workerd scheduling; the stop is an injected sequencer, not an evicted
isolate; scripted model, so no inference latency.

## Held reads, host actions and a second tour (2026-11-10, nyc-01)

Vitest built-in bench, local. Load average about 30.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| tour-again | 1,239.4 | 3 | `2026-11-10T14-44-07.367Z-tour-again.json` |
| budget-corrupt-ledger | 194.7 | 3 | `2026-11-10T14-44-08.378Z-budget-corrupt-ledger.json` |
| history-actions-host | 708.9 | 3 | `2026-11-10T14-44-12.362Z-history-actions-host.json` |
| sandbox-actions-host | 840.8 | 3 | `2026-11-10T14-44-15.023Z-sandbox-actions-host.json` |
| accounts-read-deadline | 6,605.2 | 3 | `2026-11-10T14-44-37.114Z-accounts-read-deadline.json` |

**tour-again** (`bench/tour-again.bench.vibe`). The conversation object's production post, tour, end and alarm over
node:sqlite object storage with the scripted model service. A person asks a question and presses Learn more before the
reply starts (busy), presses it again after the reply (the tour greets them), presses Escape, then Learn more again.
Checked: every answer, the reply's text, and that the second tour greets with the first tour's line.

This workload found a bug, fixed with it: the conversation keeps an ended tour's walkthrough, and a new tour restored
it as its own, so the second tour resumed the old stop and never greeted. `tourWalkthrough`
(`src/core/conversation.vibe`, proved) returns a walkthrough only when the running tour drove it; both hosts read it.
Regression tests: `test/tourAgain.test.vibe` (conversation object and mock mode), both failing without the fix.

**budget-corrupt-ledger** (same file). A day ledger whose spent total no charge could write: admission and a charge both
stop with Invalid budget accounting, the question's reply ends failed with no text, and the ledger is unchanged.

**history-actions-host** and **sandbox-actions-host** (`bench/history-actions-host.bench.vibe`). The production action
index and per-run hosts. A maintainer runs Plan, Start, Note and Show as actions, each admitted, driven by one alarm and
started again as a replay; Show returns the new commit with its note. Then sandbox start, a command that writes a file,
stop, start again and a command that reads it back at generation 2.

**accounts-read-deadline** (`bench/accounts-read-deadline.bench.vibe`). The Accounts object on a loopback server. A
signed-in person's new issue waits in the injected `IssueHost` on a latch, as a write GitHub has not answered does;
the issue list read queued behind it answers 503 `unavailable` after at least 5.9 s, the write then lands, and a later
read answers 200. The time is the deadline: this checks the bound holds, not throughput.

Limitations: node:sqlite and an alarm field, not workerd scheduling; scripted model, so no inference latency; the held
write is a latch, not GitHub; MockFactory's in-memory sandbox, not a Container.

## Issues and wiki with GitHub unreachable (2026-11-10, nyc-01)

Vitest built-in bench, local, `bench/accounts-offline.bench.vibe`. Load average about 120.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| accounts-github-offline | 11,689.8 | 3 | `2026-11-10T12-22-14.023Z-accounts-github-offline.json` |

The Accounts object on a loopback server over in-memory storage, with GitHub an offline HttpClient. Each sample seeds
an abandoned sign-in row, starts a sign-in (which clears it), signs a person in, then sends their GET and POST
`/api/issues` and `/api/wiki` without a GitHub connection. Both reads answer 503 "unavailable" after about 6 s each,
which is most of the sample; the issue write answers 401 `connect`; the wiki save answers 401 `connect`, marked
unwritten, and keeps the person's draft. The bound replaces the earlier finding that these reads stayed open past 5 s
and held server shutdown (decision 0030).

Limitations: no GitHub latency or answer; in-memory storage; the person has no GitHub connection, so writes stop
before GitHub.

## Browser: issues and panel arms (2026-11-10, nyc-01)

Playwright, real Chromium, production build, one serial sample per action, 12:48 UTC, load average 33–37 on 32 cores (`bench/browser.spec.ts`; `bench/browser.bench.vibe` runs all eight workloads and requires eight passes).

| Workload | Artifact | Actions (ms) |
| --- | --- | --- |
| local-issues-actions | `2026-11-10T12-48-25.315Z-local-issues-actions.json` | open 104, list keys 306, search 102, issue 65, commit dialog Escape 74, commit 130, comment 31, uncommit 72, agent VIP draft 1,212, VIP steps and submit 271, specification revision and review 232, Home 70 |
| local-arms-actions | `2026-11-10T12-48-32.640Z-local-arms-actions.json` | tour start 136, Tab focus 14, resize 40, sound 154, Skip and Back 622, Exit 758, Escape with nothing open 19, run and step 1,660, action input 129, Maximize 164, slash arrows 89, Escape on Issues 598, wiki link and Back 686, first-visit tour 1,725 |

**local-issues-actions.** A maintainer's Issues screen through the product fixture flows: list keys, search, an issue's post and links, the commit dialog's Escape and commit, a comment, uncommit, an agent-drafted VIP through its steps to submission, a specification revision and a review request, and Home. Each step checks the resulting screen.

**local-arms-actions.** Tour focus, resize and orientation, sound, Skip and Back, Exit; Escape with nothing open; the Actions panel's run, step, input and Maximize; slash-menu arrows; Escape on Issues; an in-content wiki link with browser Back; and a first visit whose tour starts on its own (1.2 s by design).

Limitations: one sample per action, no percentile; scripted waits and automation included; product mock and fixture flows, no network, OAuth or model.

**Coverage collector fix.** Chromium coverage was dumped once, at the end of each workload. V8 precise coverage reports only the current document's scripts, so every workload that navigates mid-journey (history, sandbox, roles, wiki, issues) lost the counts from before its navigation. Each workload now dumps before every navigation. On the same Node and workerd evidence, this and the two workloads above raise `src/` + `worker/` from 6,660 to 6,778 of 7,551 lines; `src/web/main.vibe` from 71 to 25 uncovered lines, `issuesView.vibe` from 20 to 8, `historyApp.vibe` from 14 to 3.

## ⌘K mode switch (2026-11-10, nyc-01)

| Benchmark | Artifact | Result |
| --- | --- | --- |
| local-arms-actions `command-k-mock-switch` (Playwright, Chromium, production build, one sample, 14:00 UTC, load 27–33) | `2026-11-10T14-00-27.249Z-local-arms-actions.json` | 304 ms from ⌘K to the reloaded page in mock mode |
| web-mode-switch-command (Vitest built-in bench, happy-dom, 3 samples) | `web-mode-switch-command` | 0.16–1.76 ms per `SwitchMode` command |

The browser step opens ⌘K, submits `/mock`, waits for the reloaded document and checks the `agent=mock` parameter, the
Mock mode link and a closed dialog. The Node bench checks the command's `FocusedPrompt` message and the window's
`agent` parameter.

Limitations: one browser sample, no percentile; the reload includes the local preview server. happy-dom changes the
location without loading a document.

**Coverage collector, reloads the page starts.** A dump before `page.goto` cannot precede a navigation the page starts
itself. In coverage mode each document now pauses in its own `beforeunload` while the collector dumps, then resumes;
the request is untouched. Lines that run after `beforeunload` in the navigating command need Node evidence (0017).

## Live issue and wiki clients (2026-11-10, nyc-01)

Vitest built-in bench, local, `bench/live-clients.bench.vibe`, 15:08 UTC, load 30-36. The product's `liveIssues` and
`liveWiki` clients against the Accounts object on a real loopback server, a fresh object per sample, with injected
sign-in, `IssueHost` and `WikiHost`. Each result is decoded and checked. 7 samples, ms, min / median / max.

| Step | ms |
| --- | --- |
| issue list | 76 / 121 / 192 |
| new issue | 125 / 161 / 268 |
| wiki page read | 78 / 91 / 170 |
| wiki Save | 79 / 97 / 191 |
| the same Save again (idempotent, same review link) | 32 / 41 / 84 |
| invalid page name, refused before any request | 0 / 0 / 1 |
| signed-out wiki Save, decoded `sign-in` | 3 / 4 / 5 |
| signed-out new issue, decoded `sign-in` | 2 / 3 / 5 |

Limitations: loopback HTTP in one Node process, no browser, TLS, edge or GitHub latency; injected product fixtures for
GitHub; shared host. Raw HTTP on the same routes: `issues-wiki-web` above.

## Fault-path coverage set (2026-11-10, nyc-01)

Not a timing benchmark. `bench/browser-faults.spec.ts` runs seven Chromium workloads on the `e2e` build, each over one
faulty Effect service, and records which steps passed; its artifacts (`fault-coverage-<name>`, build
`e2e-fault-coverage`) hold no duration, and none is quoted here (0017). Its Chromium counts join the benchmark coverage
gate.

| Workload | Fault | Checked result |
| --- | --- | --- |
| refusals | post `Unavailable`; tour `Refused` busy | "Send failed" then Retry answers; "Agent busy" then Learn more starts the tour |
| disconnect | event stream `Unavailable` before #4 | Disconnected, Reconnect, Connected, answer done |
| tour | tour stream `Unavailable`; tour end `Unavailable` at step 2 | after Exit the composer reads "Send failed"; a second Exit ends the tour |
| media | empty-state image fails to load | composer still answers |
| sandbox | every read fails; first start fails | "Couldn't load the sandbox"; "Couldn't start a sandbox", Retry, Running |
| roles | first role subscription `AccountUnavailable` | "Connection lost." toast, Retry clears it |
| actions | first Actions `list()` fails | "Couldn't load runs", Retry loads the Tour action |

**Defect found and fixed.** A failed sandbox start, stop or command lost its alert and Retry within a second: the open
pane's one-second read ended the operation and cleared its failure. Fixed in `src/web/paneDecision.vibe`
(`polledSandbox`, `polledFailure`); regression `test/sandboxFailure.runtime.test.vibe`.

## CLI startup (2026-11-10, nyc-01)

Vitest built-in bench, local, `bench/cli-startup.bench.vibe`. Five emitted CLI processes per command, no warmup, each
with `--mock` and fresh private settings, to exit; exit status and the first output line are checked. One more process
per command runs with a preload that counts the modules Node resolves and names the workspace packages loaded.

| Command | Modules before | Modules now | Median ms before | Median ms now |
| --- | ---: | ---: | ---: | ---: |
| `--help` | 1,462 | 864 | 3,082 | 1,810 |
| `read` | | 865 | 3,330 | 2,083 |
| `actions` | | 865 | | |
| `login` | | 1,463 | | |

Medians come from ten interleaved runs of each build at 06:50 UTC (load average 51 on 32 cores); the benchmark
artifact `2026-11-10T06-45-47.306Z-cli-startup.json` ran at load 88 and is slower for that reason. Node itself
(`node -e 0`) takes about 40 ms.

**Cause.** Every command loaded the sign-in machinery: `sessionFlow.vibe` imported `@smthrs/platform-node` (the
durable SQLite host, about 600 modules) and `signin.vibe` imported `@smthrs/integrations` (about 330 modules) at the
top of the module. Both now load on first use, inside the effect that needs them. `login` and `logout` still load the
host; no mock command loads the GitHub integration.

**Gate.** The module count, not wall time: each command's count must stay within `ceil(baseline * 1.05)` of
`bench/baseline.json` `startupModules`, `help`, `read` and `actions` must not load `@smthrs/platform-node`, and
`login` must. The gate fails on the old imports.

Limitations: wall time is observational on this shared host; the OS file cache is warm after the first process; the
build is excluded; module counts measure loading, not evaluation cost. What remains per process is mostly module
loading itself: about 860 modules, about 400 of them TypeScript that Node type-strips on every start. Node's compile
cache removes that work (about 400 ms) but a `.vibe` entry cannot enable it
(`~/vl/vibelang-bugs/compile-cache-from-vibe`).

## Decision edges (2026-11-10, nyc-01)

Vitest built-in bench, local, `bench/decision-edges.bench.vibe`.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| decision-edges | 0.597 | 168 | `2026-11-10T07-57-46.278Z-decision-edges.json` |

**decision-edges.** One callback checks the Actions panel steps (load and failure epochs, retry, maximize, input,
slash highlight), account failure text, the issues screen's specification-review action (fresh, saved retry, a
different saved retry, busy, not allowed), default role, assignee and settled load, history read offsets and dialog
keys, tour docs paths and specification review recording, each against a written-out expected value.

Limitations: pure decisions in one process; DOM, Commands and HTTP are measured by the browser and HTTP workloads;
assertion overhead dominates the time.

## Action kinds (2026-11-10, nyc-01)

Vitest built-in bench, local, `bench/action-kinds.bench.vibe`.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| action-kinds | 440.4 | 3 | `2026-11-10T08-06-21.914Z-action-kinds.json` |

**action-kinds.** A fresh product `MockActions` over `MockFactory` per sample, as a contributor: history show (the
outline, then commit m1), a note on m1, and a sandbox's start, command and stop, each started as a button action and
followed to settlement. Settled state and exact results are checked (the sandbox keeps its id across the three
steps; the stop's output holds the command and its answer).

Limitations: the sandbox is the product's in-memory machine, not a container; history is the committed seed in
memory; each sample includes building `MockFactory`, so the first sample (1,116 ms) carries the seed load.


## Remaining-gap workloads (2026-11-10, nyc-01)

Vitest built-in bench, Node 26.5.0, 15:54–15:55 UTC. Launch load 39.48 on the shared host; two cores reserved through
run-heavy. Each callback checks its result. Raw samples, machine, tool versions and exact source revisions are in
`bench/results/` under the artifact names below. Values are ms per whole workload; no tail percentile is claimed.

| Workload | Samples | Min | Median | Max |
| --- | ---: | ---: | ---: | ---: |
| `mock-agent-actions` | 3 | 231.419 | 281.474 | 5054.654 |
| `mock-agent-content` | 3 | 291.146 | 291.296 | 304.106 |
| `history-fold-unannotated` | 282 | 0.275 | 0.313 | 3.806 |
| `object-startup-recovery` | 3 | 6.571 | 8.434 | 17.309 |
| `object-startup-wait-deadline` | 3 | 5027.695 | 5027.798 | 5027.867 |
| `api-objects-health` | 3 | 8.537 | 9.952 | 11.756 |

`mock-agent-actions` runs Plan, an unknown action and a queued command after identity changes through real
BrowserFactory/MockActions and durable replies. `mock-agent-content` files one issue, splits #38 into three linked
children and refuses a draft of the generated decisions index. Both use the shipped scripted agent and memory host;
no backend, inference, GitHub or browser layout. Initialization, streaming waits and assertions are included. The
first action journey took 5,054.654 ms; the next two took 231.419 and 281.474 ms. This includes lazy initialization;
the cause of that cold-sample difference has not been isolated. It remains a finding, not a normal-latency claim.

`history-fold-unannotated` folds a commit with no Mythical trailer and one with an unknown trailer, reuses one scope
epic, repeats the second SHA and reopens the real memory store. It compares the complete retained history and five
ordered events. No GitHub read, repository write or disk IO. Warmup follows `quick` in `bench/artifact.vibe`; each
measured callback gets a fresh store and includes assertions.

`object-startup-recovery` uses the production startup wrapper and budget over the real object-storage ledger. A
faulty ledger read fails startup; health does not restart it, HTTP forwarding answers 503, then restoring the ledger
and calling again recovers and charges a duplicate reply once. `object-startup-wait-deadline` holds an
uninterruptible ledger read through the real five-second call deadline, releases it and retries. Its approximately
five-second duration includes that designed deadline. These are Node memory-host wrapper costs, without workerd
scheduling, disk stalls, network or inference.

`api-objects-health` makes two warm HTTP health reads in local workerd after the other API workloads. It checks all
five production objects are ready, the fixture build identity, and stable object identities. One sample includes
both reads and assertions. Startup, remote RPC, production contention, WAN and model inference are absent.

Artifacts:

- `2026-11-10T15-55-07.638Z-mock-agent-actions.json` (source `17cb9e5345ed`).
- `2026-11-10T15-55-08.706Z-mock-agent-content.json` (source `17cb9e5345ed`).
- `2026-11-10T15-55-00.577Z-history-fold-unannotated.json` (source `17cb9e5345ed`).
- `2026-11-10T15-55-10.800Z-object-startup-recovery.json` (source `17cb9e5345ed`).
- `2026-11-10T15-55-26.021Z-object-startup-wait-deadline.json` (source `17cb9e5345ed`).
- `2026-11-10T15-54-58.609Z-api-objects.json` (source `17cb9e5345ed`).

## Cancellation after the model starts streaming (2026-11-10, nyc-01, Codex)

`bench/action-interrupted.bench.vibe` now holds the loopback HTTP model after its first SSE fragment rather than
holding budget admission. It cancels the registered reply, releases the remaining fragments, rebuilds the action
host over the same SQLite storage, and drives two later alarms. Every sample checks one model request, no completed
answer, a cancelled entry and a cancelled run. This uses the production HTTP adapter, agent and execution host;
the deterministic endpoint supplies no inference latency. The latch and fiber joins have deadlines.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| action-crash-retry | 212.1 | 3 | `2026-11-10T15-40-04.117Z-action-crash-retry.json` |
| action-reply-interrupted | 850.6 | 3 | `2026-11-10T15-40-06.806Z-action-reply-interrupted.json` |

Method: Vitest built-in bench on shared nyc-01 (load about 20); fresh SQLite object stores per sample, exact result
checks included. The second workload also measures a conversation log fault that fails an open reply. These are
observations with three samples, not a regression threshold or an inference benchmark.

The browser overlay failure is a setup race with the intentional automatic tour after 1.2 s. Ordinary browser
workloads visit as returning people; the arms journey explicitly requests a first visit for its last navigation.
The shared init now honors that request and also covers the first-render workload's separately created contexts.
The first-visit regression failed before the correction because no Walkthrough appeared. This corrects the
benchmark setup; the product tour still starts on a first visit.

 
## Agent wiki draft replay (2026-11-10, nyc-01)

`bench/wiki-agent-draft.bench.vibe`, Vitest built-in bench, fresh SQLite action host and product MockFactory wiki
per sample. The scripted model's cell calls the production wiki draft tool twice with the same page and request.
WikiDrafting delegates to the actual wiki edit flows. Every sample checks a finished reply with both review links,
one stored draft containing the addition once, unchanged repository source, no submitted review, pane events
belonging to the active reply, and one model request.

| Workload | Mean ms | Samples | Artifact |
| --- | ---: | ---: | --- |
| wiki-agent-draft-replay | 617.0 | 3 | `2026-11-10T16-11-13.389Z-wiki-agent-draft-replay.json` |

Limitations: product fixture repository and memory wiki engine, not GitHub; scripted model, no inference latency;
Node SQLite/KV/alarm adapter, not workerd scheduling. Shared-host observations, no tail percentile claimed.

Benchmark-only coverage on 0b937f1d plus the continuation patch: full 75-file/156-test run, including all eight
Chromium journeys, plus this instrumented benchmark (one file/one test). Identical production bytes were checked
before exact-location union; combined 2,067/2,321 worker lines (89.06%) and 7,208/7,636 src+worker lines (94.39%).
ActionRuns, Budget and WikiTools have full line coverage; the unchanged strict whole-codebase gate remains red.

Live UI-only run at 2026-11-10 15:42:09 UTC (07:42 PST), deployment `6a3c8b517c`, Chromium 151.0.7922.34:
fresh returning-visitor contexts from nyc-01, shared browser/OS caches, visible heading, focused Command-K prompt
and asserted typed value. No model call. `2026-11-10T15-42-09.996Z-live-browser.json` retains all machine/version data.

| Sample | First render ms | Command-K ms | Keystroke ms |
| --- | ---: | ---: | ---: |
| 1 | 1123.9 | 27.4 | 21.3 |
| 2 | 385.4 | 32.6 | 26.9 |
| 3 | 427.4 | 42.4 | 13.2 |

Network, browser caches and automation are uncontrolled; three observations establish no percentile.


## Worker continuation: method and limitations, 2026-11-10

The issue and wiki repositories are public: their ordinary source reads do not require a person's GitHub sign-in.
`bench/public-github.bench.vibe` opts in with `BENCH_PUBLIC_GITHUB=1` and sends real anonymous GETs through
production GitHub hosts, durable SQLite execution and PublicReads. Untimed native issue/comments and immutable
contents reads are the independent oracles. Every sample checks actual identity/content, ordering, comments,
timeline, revisions and retained storage. One empty application-cache observation and three warm-cache samples
are retained. Native oracle calls warm transport first; this is no DNS/TLS/OS cold-start or isolated cache-speedup
claim. Cold includes migrations; warm reads use new durable keys on the growing journal.

A real GitHub read also primes the cache-eviction case. After the actual TTL expires, faulty Effect services
return an upstream 404 and refuse cache deletion. The operation must remain missing and retain its last-good
page, rather than turn an authoritative missing response into content. The failure phase is injected; no request
is intercepted and no synthetic successful provider response is supplied. Its one observation includes 31 seconds
of intentional waiting. Successful person-owned writes, private draft reads and delegation/reconciliation remain
deferred; the earlier table's blanket deferral of ordinary public issue/source reads is superseded by this receipt.
Matching VIP document/reviewer reads still need a real matching native VIP fixture; current public issues supply none.

Additional worker workloads check the full chunked history snapshot/reopen, malformed event refusal and exact
repair, startup under an expired scope, a caller bounded while critical startup storage waits, safe HTTP refusal
on failed initialization and explicit next-call recovery. Actual workerd sessions cover participation and
cross-origin sandbox refusal, and public health reads cover all five object classes. The real reply/agent/QuickJS
path checks a streamed answer replaced once after its cell fails, all three closed sandbox tools, and a guest's
List/Start/Read/Cancel of the same public Tour action, including its terminal cancelled state and announcement.
A wiki draft with an unreachable charge waits through the real two-minute policy, fails budget, logs/counts once,
charges zero tokens, retains its reservation and makes exactly one model request. Its single observation is dominated by policy waiting.
A separate ledger workload fills a shared day with ten concurrent calls, checks held/refused admissions, exact
reported, unreported and over-ceiling charges, then reopens and replays settlement without charging twice.
A refused action id also keeps its original journal payload on changed-request reuse, with one conflict counter
and no phantom run, after main's native directory fix.

No new dependency, threshold change, production exclusion, GitHub mutation, live inference or deploy. Product
MockFactory/Mythical tools are named where used; scripted model endpoints measure agent/flow overhead only.
Node KV/memory journal cases establish host contracts, not disk durability. Workerd cases bridge objects by fetch
rather than Alchemy RPC. Every callback checks its result; three samples establish no tail percentile.

The completed f765f8ed source-profile receipt is 2,158/2,321 worker lines (92.98%), 7,281/7,639 src+worker lines
(95.31%). It combines the 80-file/166-test full benchmark run with explicitly retained focused collections on
identical source bytes; it is not a single final full-roster run. The strict all-metric gate remains red.
Main subsequently changed worker, browser/history and SDK auth code, so a fresh rebased receipt follows in the
benchmark wiki and lane report; these numbers remain labeled with their measured base.

`BENCH_SITE_READS=1` probes https://vibelang.smithers.sh without credentials, mutation or model. At
2026-11-10 16:49:26 UTC (08:49 PST), deployment 6a3c8b517c returned issues **503 in 5,643 ms** and wiki
**200 in 2,494 ms**; the content assertion fails and a JSON failure artifact retains only health, fixed routes,
statuses and durations. Health separately observed starting/unreachable objects. This is a deployed finding,
not a proved source-level cause; the lead owns deployment and production investigation.


## Worker source receipt: c5bbf81b, 2026-11-10

Measured product base c5bbf81b37eee13665edf28252aa0a52aafd8878 plus the worker benchmark patch:
**2,201/2,374 worker lines (92.71%)**, **7,355/7,716 src+worker lines (95.32%)**.
The canonical full roster is 7,467/7,846 lines (95.17%); all four unchanged 100% thresholds remain red for 112 files.
This is a source receipt for that base. Main later changed public-read deadlines/cache behavior and stale UI;
the landing compatibility checks do not make these counters a measurement of those later changes.

The full benchmark-only collection passed 82 files / 174 tests, with one opt-in deployed-content skip and one
old Budget RPC benchmark failure after main changed its signature. The corrected API-only collection passed
independently in both timing and coverage modes, including an exact remaining-capacity check after replay.
Both failed-case workerd dumps were quarantined; their invalid call earns no coverage. The canonical Node map
joins the corrected collection by complete source range using the repository's mergeByPosition, before the
standard workerd/Chromium gate. The complete canonical file roster is preserved. The 155 tracked src/worker
sources retain SHA-256 faa49b51e12329689c6fa8cb7e679d4258a6a082b2f4803a29aaa76501f72af2;
the generated wiki matches its preserved browser source map, SHA-256
57798ff1e3204e9cfdf589e89c44f839b3f29a0f80d85783805bf8059416bfd1. No source exclusion or threshold change.
This is a full collection plus an explicitly recorded correction, not one green full-roster invocation.

The draft usage-report fallbacks still need a faulty journal-recovery workload: SDK usageOf can fail
AccountingUnavailable during journal recovery. This continuation has not exercised that boundary. The legacy
budgetDecision.charge helper is superseded by reservations. These lines remain counted; no artificial successful service, direct coverage-only call or deletion was introduced. Person-owned
GitHub paths, a matching native VIP fixture, actual Container execution and the previously named unreachable
routing guards remain as recorded above. A fresh full coverage receipt is still needed for later main changes.

| File | Covered/total lines | Missing lines |
| --- | ---: | --- |
| `worker/Accounts.vibe` | 312/312 | — |
| `worker/ActionDirectory.vibe` | 40/40 | — |
| `worker/ActionIdentity.vibe` | 14/14 | — |
| `worker/ActionRuns.vibe` | 120/120 | — |
| `worker/ActionsHttp.vibe` | 41/41 | — |
| `worker/AgentModel.vibe` | 9/9 | — |
| `worker/Api.vibe` | 46/46 | — |
| `worker/Budget.vibe` | 44/46 | 61, 84 |
| `worker/GitHubDelegate.vibe` | 4/4 | — |
| `worker/HistoryActions.vibe` | 30/33 | 26, 39, 44 |
| `worker/HistoryObject.vibe` | 59/59 | — |
| `worker/HistoryTools.vibe` | 8/8 | — |
| `worker/Http.vibe` | 93/93 | — |
| `worker/Issues.vibe` | 207/298 | 55, 56, 57, 103, 104, 105, 147, 148, 149, 150, 151, 152, 155, 156, 157, 159, 160, 161, 166, 167, 173, 174, 175, 176, 177, 178, 179, 180, 181, 183, 185, 186, 188, 189, 190, 191, 192, 193, 194, 197, 198, 199, 200, 201, 202, 203, 204, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 233, 234, 235, 236, 237, 238, 240, 241, 242, 250, 251, 252, 253, 297, 298, 299, 300, 301, 302 |
| `worker/MainLog.vibe` | 42/42 | — |
| `worker/ObjectStartup.vibe` | 60/60 | — |
| `worker/ObjectStorage.vibe` | 10/10 | — |
| `worker/Objects.vibe` | 109/112 | 114, 250, 251 |
| `worker/PublicReads.vibe` | 12/12 | — |
| `worker/Reply.vibe` | 139/142 | 169, 369, 370 |
| `worker/SandboxAccounts.vibe` | 4/11 | 12, 13, 14, 15, 22, 23, 24 |
| `worker/SandboxHttp.vibe` | 30/30 | — |
| `worker/SandboxMachine.vibe` | 1/4 | 11, 12, 13 |
| `worker/SandboxTools.vibe` | 11/11 | — |
| `worker/Sandboxes.vibe` | 22/22 | — |
| `worker/Sequencer.vibe` | 118/118 | — |
| `worker/SpecificationReviewers.vibe` | 34/36 | 54, 55 |
| `worker/Tour.vibe` | 1/2 | 6 |
| `worker/Unreachable.vibe` | 1/1 | — |
| `worker/VipDraft.vibe` | 33/35 | 61, 62 |
| `worker/Wiki.vibe` | 127/175 | 46, 47, 63, 64, 100, 101, 102, 104, 105, 107, 108, 111, 112, 115, 116, 117, 119, 120, 121, 122, 128, 129, 130, 131, 138, 139, 140, 141, 142, 145, 147, 148, 150, 152, 153, 154, 157, 158, 160, 161, 164, 165, 166, 174, 175, 176, 177, 195 |
| `worker/WikiDraft.vibe` | 35/37 | 63, 64 |
| `worker/WikiTools.vibe` | 9/9 | — |
| `worker/accountObject.vibe` | 48/48 | — |
| `worker/agentContext.vibe` | 1/1 | — |
| `worker/apiObjects.vibe` | 210/214 | 122, 252, 253, 254 |
| `worker/budgetDecision.vibe` | 10/12 | 60, 61 |
| `worker/index.vibe` | 13/13 | — |
| `worker/liveDispatchDecision.vibe` | 7/7 | — |
| `worker/machineObject.vibe` | 63/63 | — |
| `worker/replyProgressDecision.vibe` | 17/17 | — |
| `worker/replyReasons.vibe` | 7/7 | — |


A later focused ledger-fault workload on 868ca298 passed (one executed case, two selector skips).
It closes Budget's negative-hold and lost-reservation guards, checks no writes on either failure and exact
remaining capacity after repair/reopening. Budget and both direct app dependencies are byte-identical to
c5bbf81b (hashes in the module receipt); exact-position module-only union reaches **46/46 Budget lines**,
52/53 statements, 7/7 functions and 56/58 branches. This module result does not relabel the overall receipt
as coverage of later main. No changed module's old counters are reused.


## Fresh compatibility and stale-copy observations: 479f05a3

Typecheck and full unit passed: 242 files passed / three skipped; 2,105 cases passed, one expected failure,
four skipped (exit 0). Nine changed benchmark files passed 22 cases with one opt-in production skip (exit 0).
The final expanded issue/wiki stale-copy journey passed independently in both timing and coverage mode:
one executed case / four selector skips each, exit 0. The earlier wiki-only version also passed both modes.

The stale journey primes two real anonymous caches, waits through the actual 30-second TTL, then injects only
upstream 503 responses. Exact pinned native wiki text/blob, the complete issue snapshot and native issue 1,
the unchanged wiki cursor, the next issue read cursor, and both initial confirmation timestamps are checked.
The two failed attempts before the runner's 19:39 UTC GitHub quota reset failed during native oracle setup;
they are not latency observations. The post-reset workload completed and is retained in JSON.

These local timings use nyc-01 under run-heavy (four cores for the latest checks) with a shared host and WAN.
Setup, complete journeys, correctness checks and policy waits are included except the explicit untimed native
oracles and workerd host bootstrap named above and in each JSON artifact. The cache cases include a 31-second
wait; draft settlement expiry includes the real two-minute retry policy. One cold/TTL/deadline observation
or three warm/ordinary samples establish no tail percentile or isolated cache speedup. Scripted model HTTP/SSE
measures native agent/flow overhead without inference. Node object KV/memory journal cases establish host
contracts; actual workerd cases use native objects and SQLite reached through fetch bridges, not Alchemy RPC.
Every artifact retains the exact callback method, limitations, machine, versions, source revision and samples.
The full coverage percentages remain the c5bbf81b source receipt, separate from these later compatibility checks.

| Workload | Samples | Mean ms | Range ms |
| --- | ---: | ---: | ---: |
| public-issues-cold | 1 | 3361.38 | 3361.38–3361.38 |
| public-issues-warm | 3 | 330.05 | 315.83–346.51 |
| public-wiki-cold | 1 | 111.39 | 111.39–111.39 |
| public-wiki-warm | 3 | 72.45 | 69.81–75.14 |
| public-cache-eviction-failure | 1 | 31215.53 | 31215.53–31215.53 |
| workerd-account-session-grants | 3 | 461.23 | 353.58–616.90 |
| workerd-account-disabled | 3 | 15.39 | 5.87–34.00 |
| workerd-account-exchange-failure | 3 | 274.78 | 75.19–657.70 |
| worker-history-snapshot-reopen | 3 | 187.28 | 156.16–247.80 |
| worker-expired-host-recovery | 3 | 109.23 | 97.97–115.96 |
| worker-startup-critical-wait | 3 | 5137.43 | 5108.18–5166.10 |
| worker-startup-failed-storage-retry | 3 | 108.56 | 81.67–139.86 |
| action-host-recovery | 3 | 831.06 | 653.99–1074.85 |
| action-host-role-downgrade | 3 | 100.67 | 98.68–104.16 |
| action-refused-id-conflict | 3 | 79.28 | 76.62–84.05 |
| worker-corrupt-conversation-reopen | 3 | 3.11 | 0.95–7.28 |
| worker-chunked-history-overflow | 3 | 31.66 | 10.91–67.55 |
| wiki-draft-budget-deadline | 1 | 120036.62 | 120036.62–120036.62 |
| budget-concurrent-reservation-reopen | 3 | 11.73 | 8.20–17.15 |
| workerd-agent-action-lifecycle | 3 | 1190.05 | 1046.58–1439.32 |
| reply-stream-restart | 3 | 651.86 | 488.65–968.38 |
| reply-sandbox-refusals | 3 | 400.49 | 378.06–431.37 |
| api-objects-health | 3 | 117.23 | 5.72–338.38 |
| api-objects-conversation | 3 | 414.82 | 344.47–539.11 |
| api-objects-unbound | 3 | 6.36 | 2.54–13.22 |
| api-objects-unconfigured-accounts | 3 | 13.54 | 12.35–14.79 |
| api-objects-sandbox-identity | 3 | 4.15 | 3.87–4.62 |
| api-objects-budget | 3 | 20.32 | 19.43–21.64 |
| api-objects-action-directory | 3 | 11.33 | 9.57–14.46 |
| api-objects-history | 3 | 82.43 | 77.08–88.82 |
| api-objects-tour | 3 | 766.66 | 739.70–799.27 |
| api-objects-agent-tools | 3 | 608.45 | 574.12–657.18 |
| api-objects-history-write | 3 | 65.51 | 60.24–74.98 |
| api-objects-action-runs | 3 | 651.18 | 637.69–664.30 |
| api-objects-signed-in-accounts | 3 | 146.39 | 8.65–420.58 |
| api-objects-owned-action-run | 3 | 435.60 | 414.51–467.02 |
| budget-faulty-ledger-recovery | 3 | 3.05 | 1.49–5.94 |
| public-content-stale-copy | 1 | 36157.02 | 36157.02–36157.02 |


## Public reads and retained-operation workloads (2026-11-10, nyc-01)

Vitest built-in bench, Node 26.5.0, approximately 16:28–16:45 UTC on shared nyc-01, two cores per run through
run-heavy. Exact timestamps, source revisions, machine/tool versions and raw samples are in the named artifacts.
Values are ms per complete workload, including assertions. No tail percentile is claimed.

| Workload | Samples | Min | Median | Max |
| --- | ---: | ---: | ---: | ---: |
| `github-issues-public-read` | 1 | 4978.198 | 4978.198 | 4978.198 |
| `github-wiki-public-read` | 1 | 511.222 | 511.222 | 511.222 |
| `sandbox-host-recovery` | 3 | 7.480 | 8.509 | 25.636 |
| `mock-agent-retained-journal` | 3 | 330.885 | 339.209 | 355.168 |
| `mock-reply-tour-contention` | 3 | 1487.969 | 1504.275 | 1537.397 |
| `post-dispatch-scan 10` | 1807 | 0.033 | 0.047 | 4.126 |
| `active-tour-projection 10` | 4580 | 0.012 | 0.023 | 0.404 |
| `post-dispatch-scan 1000` | 1457 | 0.038 | 0.074 | 0.841 |
| `active-tour-projection 1000` | 1612 | 0.031 | 0.061 | 0.728 |
| `post-dispatch-scan 100000` | 9 | 10.116 | 11.504 | 13.462 |
| `active-tour-projection 100000` | 41 | 1.826 | 2.470 | 3.183 |
| `authorization-journal` | 2620 | 0.023 | 0.025 | 5.546 |
| `api-objects-owned-agent-tools` | 3 | 643.529 | 647.878 | 675.006 |
| `web-wiki-state` | 543 | 0.163 | 0.172 | 1.666 |

Public reads require `BENCH_GITHUB_READS=1`. They use actual anonymous GitHub GETs through the production durable
issue/wiki read flows and product ETag cache, with a local product MockAccounts contributor and real local SQLite/KV.
Issues: list, selected timeline/comments compared with the provider and exact durable receipt replay. Wiki: actual
bytes/revision compared with the provider, retained page projection and restored local draft. No GitHub write, real
login or inference is measured. Public data, rate limits and provider/cache state vary. One callback per provider
journey; only counts are retained. Without the flag these two cases skip and add no coverage.

Sandbox recovery uses the production writer, product memoryMachines, a retained memory store adapter and TestClock.
It checks Stop receipts for exhausted minutes and lost leases, recovery after a failed emergency stop, revoked
pending starts, and one held command whose uncertainty survives replay without another machine call. No real
Container, disk persistence, eviction or billing duration. Three fresh five-case corpora.

The retained-journal workload uses the real MockFactory over a healthy memory journal seeded with retained events.
It checks a half-answer fails visibly before the next post answers, one resumed tour, and an ownerless sandbox
refusal. The contention workload delays real Digest computation to open both Reply/Tour race windows, checks one
ordered reply and actual contention/tour log outcomes, and releases every latch on exit. These are controlled
recovery/fault overhead measurements; no actual process kill, browser localStorage durability, natural race
frequency, backend or inference latency is claimed.

Dispatch inputs are constructed outside timing. One scan workload checks four queues (last/middle/none/all pending);
one projection workload checks started/driven/ended tours at the stated entry count. These measure pure array/Set
scanning and state projection. Authorization replay checks an exact accepted event changes only the cursor and
keeps authority, while refusing a viewer. The owner-bound agent-tool workload runs production workerd objects with
a deterministic HTTP model; it reaches the account draft RPC and refuses an unregistered viewer.
`web-wiki-state` additionally checks Escape preserves a pending Save and emits no work. No network/rendering cost
is represented by the pure state corpora.

Artifacts:

- `2026-11-10T16-26-56.316Z-github-issues-public-read.json` (source `e3694c38d72b`).
- `2026-11-10T16-26-56.965Z-github-wiki-public-read.json` (source `e3694c38d72b`).
- `2026-11-10T16-41-07.087Z-sandbox-host-recovery.json` (source `79b8dd42c639`).
- `2026-11-10T16-41-05.806Z-mock-agent-retained-journal.json` (source `79b8dd42c639`).
- `2026-11-10T16-46-56.996Z-mock-reply-tour-contention.json` (source `9a30c25893d3`).
- `2026-11-10T16-41-08.307Z-dispatch-10.json` (source `79b8dd42c639`).
- `2026-11-10T16-41-08.702Z-dispatch-1000.json` (source `79b8dd42c639`).
- `2026-11-10T16-41-09.177Z-dispatch-100000.json` (source `79b8dd42c639`).
- `2026-11-10T16-46-48.547Z-authorization-journal.json` (source `9a30c25893d3`).
- `2026-11-10T16-26-41.280Z-api-objects.json` (source `e3694c38d72b`).
- `2026-11-10T16-26-45.831Z-web-wiki-state.json` (source `e3694c38d72b`).


**Latest coverage receipt, 2026-11-10.** Full benchmark-only collection at `62cbbccd` on `f765f8ed`, nyc-01,
16:54–17:23 UTC (08:54–09:23 PST), two cores: 83 files / 174 checks passed; strict gate exit 1. Source hashes all
matched during collection. An additive web-state/DOM/action-proxy run at `95de2858` passed 3 files / 13 checks;
all production bytes matched the full-run input before the existing position merge. This combines two runs.
Combined src lines 5,216/5,318 (98.08%), worker 2,138/2,321 (92.12%), total 7,354/7,639 (96.27%). The strict
all-metric requirement remains unmet in 108 files; counts retain the source-map limitations in 0017. Instrumented
and e2e fault-workload durations are not benchmark timings.

The added pure sandbox update corpus checks slash start, exact emitted operation, allowance notices, new-month
reset and stale response fences. Added DOM scenes check issue cards and GitHub connection recovery controls.
The action selection proxy measures a complete binding/recovery journey over product MockActions, with two explicit
20 ms cancellation deadlines and scripted reply delays; it is not proxy CPU cost. Default embedded-device refusals
are measured separately from bound sandbox workflows. Methods and exact result checks are in their artifacts.
Older public-wiki artifact counts named `sourceBytes` are JavaScript UTF-16 string lengths; subsequent artifacts
use `sourceUtf16Length`. Source/revision comparisons are exact; no actual page text is retained in artifacts.

Raw maps, generated source bytes, hashes and per-file metrics are retained in the lane report's evidence directory.
GitHub write success, real Container costs, specification-only functions, source-map shape blockers and remaining
error/invariant paths stay counted and open. Documentation is generated again for publication; coverage receipts
refer to their recorded snapshots, not to the later generated wiki text.


The explicit-session corpus checks malformed/wrong-origin/non-session configuration, live-layer selection against
the real local Worker and a refused local connection. It uses fixture cookie syntax, not an authenticated provider
session. Worker/directory startup is excluded; layer construction, real health/failed connection and assertions are
included. The plain-command corpus runs a fresh product mock backend through reply/read, history Plan/Start/Note,
and sandbox start/replay/stop, checking literal output, exact identity/generation and whole-minute display with fractional usage. Its
settings IO, durable flows and scripted reply delays are included; CLI process/IPC startup, provider writes and
Containers are measured elsewhere or remain unmeasured. Both use three unwarmed callbacks, with no tail-percentile
claim. The issue DOM corpus includes the generic failure alert with no unrelated GitHub action.


The daily-reservation corpora measure concurrent admission under a ten-token cap, exact reported/unknown/excess
settlement, duplicate charging and charged-key refusal; four faulty ledger counts and a retained charged hold
exercise fail-closed recovery. Exact receipts and global spent/reserved/overshoot totals are checked. Real Budget,
semaphore and Node object-storage KV code; three unwarmed complete corpora, including initialization/assertions.
This excludes provider/workerd/UTC-rollover latency and does not claim an actual corruption or crash. The Worker
Budget workload separately performs five real RPCs per callback, checking admission and settlement replay.


**Additional normal observations, 2026-11-10, nyc-01.** These retain their individual artifact timestamps and
source revisions; they are not one simultaneous run. Node 26.5.0, the existing Vitest harness, two reserved cores
on a shared host. Values are min/median/max milliseconds; no tail-percentile claim. Instrumented durations are
excluded. Raw machine/toolchain/method records are retained with each artifact in the lane report's evidence.

| Workload | Callbacks | Min ms | Median ms | Max ms | Artifact |
| --- | ---: | ---: | ---: | ---: | --- |
| `web-sandbox-state` | 538 | 0.085 | 0.176 | 1.154 | `2026-11-10T18-06-13.480Z-web-sandbox-state.json` |
| `issue-chat-cards` | 14 | 5.597 | 7.116 | 10.283 | `2026-11-10T18-33-24.649Z-issue-chat-cards.json` |
| `action-deferred-binding` | 3 | 121.201 | 129.028 | 216.471 | `2026-11-10T18-06-15.622Z-action-deferred-binding.json` |
| `action-device-unbound` | 3 | 0.206 | 0.233 | 0.691 | `2026-11-10T18-06-15.792Z-action-device-unbound.json` |
| `surface-backend-session` | 3 | 7.362 | 8.990 | 48.443 | `2026-11-10T18-31-59.656Z-surface-backend-session.json` |
| `surface-plain-commands` | 3 | 330.825 | 330.955 | 921.401 | `2026-11-10T18-30-48.468Z-surface-plain-commands.json` |
| `budget-reservation-contention` | 3 | 2.836 | 3.335 | 10.565 | `2026-11-10T18-47-12.059Z-budget-reservation-contention.json` |
| `budget-ledger-recovery` | 3 | 1.564 | 1.852 | 2.639 | `2026-11-10T18-47-12.176Z-budget-ledger-recovery.json` |

Sandbox state is pure reduction with exact emitted commands/notices; cards are four Happy DOM/Foldkit scenes,
with fixture/event setup excluded and no browser layout/paint. The deferred-action journey includes two explicit
20 ms cancellation waits and scripted replies; unbound-device cost is three typed default-service refusals.
Backend selection includes malformed configuration, real workerd health and a failed local connection; Worker and
directory setup are excluded. Plain commands include fresh settings/layers, registered flows, replies, history and
sandbox formatting; process/IPC startup and actual Containers are excluded. Budget corpora use real semaphore and
accounting code over the Node KV adapter, including all setup/assertions. Ledger faults produce accounting defects
and leave the backing store unchanged; seeded retained state is not evidence of an actual crash or corruption.
These whole-corpus measurements are not individual operation latencies. Complete correctness checks and additional
limitations are in 0017 and the named artifacts.


The later complete collection at `de20c189` (`c5bbf81b` base), 18:54–19:20 UTC, passed 87 files / 182 checks;
all 265 input hashes matched. Src/worker lines are 7,429/7,716 (96.28%), with the strict gate still failing in
111 files across all source scopes. Its roster adds 77 runtime lines relative to the older receipt. Full maps,
exact inputs and per-file counts are retained; instrumented durations are not timings.

The additive reply recovery corpus checks streamed preview replacement through the actual Reply/agent/QuickJS
pipeline, exact requests/token settlement and safe failure tags, including a revoked native Proxy. Node KV/memory
engine and deterministic HTTP/SSE model; three unwarmed full corpora include setup/assertions and exclude actual
inference/WAN. `fault-coverage-draft-spend` is an opt-in **counts-only** set (BENCH_FAULTS=1, or coverage mode): one
real draft charging policy exhausts against an unreachable Effect settlement service, bounded at four minutes.
It checks requests, admissions, attempts, refusal, warning and ledger state. It retains and publishes no duration.


The mock specification journey requests all four named reviewers through the shipped agent, poster-bound issue
read and registered flows, checking literal replies, matching journal entries, revision, four sequence advances
and unchanged source text. Three unwarmed complete journeys include setup/scripted delays/assertions; the reviewers
are product fixture behavior, without actual model, backend or GitHub latency.


**Combined receipt after two additive collections, 2026-11-10.** The full `de20c189` run passed 87 files / 182
checks. The reply/fault add-on passed 2 files / 3 checks; the mock specification add-on passed 1 file / 1 check.
All 265 original input hashes still match after both collections. The existing position merge joins their real
hits: src 5,252/5,342 (98.32%), worker 2,183/2,374 (91.95%), total **7,435/7,716 (96.36%)**. This combines one
complete run and two additive runs; it is not a single 90-file execution. The strict four-metric goal remains open
in 111 files. No line/threshold/merge rule changed. Later documentation regeneration is outside this frozen receipt.

Additional completed normal observations, nyc-01, Node 26.5.0, two reserved cores/shared host, three unwarmed
callbacks. Min/median/max milliseconds; methods below, no tail-percentile claim. Each raw artifact keeps its own
source revision, machine and toolchain.

| Workload | Callbacks | Min ms | Median ms | Max ms | Artifact |
| --- | ---: | ---: | ---: | ---: | --- |
| `reply-agent-recovery` | 3 | 89.870 | 118.780 | 314.408 | `2026-11-10T19-26-06.552Z-reply-agent-recovery.json` |
| `reply-safe-failure-tags` | 3 | 0.124 | 0.147 | 0.420 | `2026-11-10T19-26-06.706Z-reply-safe-failure-tags.json` |
| `mock-agent-specification` | 3 | 280.045 | 293.491 | 419.984 | `2026-11-10T19-41-04.373Z-mock-agent-specification.json` |

Reply recovery is a two-world corpus through the real memory engine, agent/QuickJS and sequencer over Node KV,
with deterministic HTTP/SSE model responses: preview replacement plus a provider-credit failure and exact reported
or ceiling settlement. Setup, serving, metrics and assertions are included; actual inference/WAN are excluded.
Safe tags include five classifications and native revoked-Proxy allocation. Mock specification review includes
all four product fixture reviewers, exact literal replies/journal changes and scripted delays. These are whole
corpora, not per-token/individual-call latency. Initialization/shared-host/cold-sample variation remains included.

The separately named draft fault artifact contains **counts only**: 12 settlement attempts, one admission, one
model request, one warning, zero charged tokens and the retained 327,680-token ceiling in the instrumented sample.
Its approximately two-minute policy is a configured deadline; no observed fault duration is published.

## Fault and owner workloads for the defensive lines (lane vl-bench2, 2026-11-11, nyc-01)

Vitest built-in bench, local, three unwarmed callbacks each. Host load average 17 to 139 during these runs (nyc-01
shared by many lanes), so the spread is wide; no tail-percentile claim. Decision 0017, "Defensive lines decided".

| Workload | Min ms | Mean ms | Max ms | Samples | Artifact |
| --- | ---: | ---: | ---: | ---: | --- |
| draft-journal-fault | 240.8 | 301.3 | 414.5 | 3 | `2026-11-11T02-20-00.025Z-draft-journal-fault.json` |
| reply-lost-post | 3.4 | 13.2 | 32.0 | 3 | `2026-11-11T02-27-12.702Z-reply-lost-post.json` |
| api-objects-maintainer-action-run | 3,455.1 | 5,074.3 | 7,925.4 | 3 | `bench/owned-action-run.bench.vibe` run at 02:52 UTC, load 139 |
| sandbox-live-replay | 3.2 | 12.2 | 29.1 | 3 | `2026-11-11T07-42-41.625Z-sandbox-live-replay.json` (4-vCPU box) |

**draft-journal-fault** (`bench/draft-journal-fault.bench.vibe`). The production wiki writer, VIP writer and Sol
specification reviewer, each in a fresh durable execution on the Cloudflare runtime over node:sqlite object storage,
with the real Budget object and a scripted HTTP model. A faulty storage service fails the journal's entry read from
admission until the writer answers. Checks the failure answer, zero model calls, one `vibelang.budget.usage` warning
(`unavailable`), the whole ceiling charged once and the reservation freed. A fallback that charges zero fails it.

**reply-lost-post** (`bench/reply-lost-post.bench.vibe`). The production reply registration on the memory engine with
the real sequencer over a conversation store whose reads hold no events, as one restored from an older copy. The
reply's start is refused: the flow answers null, logs `refused` once, writes nothing and asks no budget, history or
model. A reply that composes anyway fails it.

**api-objects-maintainer-action-run** (`bench/owned-action-run.bench.vibe`). The production bodies of worker/Api.vibe
in workerd with sign-in configured and `VIBELANG_INITIAL_MAINTAINER_ID=1`. A `vibelang/Post` run whose trusted props
name owner 1, followed to `ReplyFinished`: History Start answers `unknown` (a viewer gets `forbidden`), the owner's
wiki draft runs the writer, which refuses the deterministic answer as `draft`. Finding, not fixed: under coverage
instrumentation the reply took 3.5 s, of which the owner's wiki draft (a second agent) took 1.05 s, History show
0.45 s and Start 0.27 s; each harness boundary step took 20 to 50 ms. The viewer's tool reply
(`api-objects-owned-agent-tools`) is about 650 ms because its draft is refused before the writer runs.

**sandbox-live-replay** (`bench/sandbox-live-replay.bench.vibe`). The first real Container run
(`test/recordings/sandboxes-live.json`, d7d3245c) replayed by `HttpRecording.replay`, a fresh replay client per sample.
The product's `LiveFactory` runs Start, a write, Stop (checkpoint), Start (restore), a read, Stop and the probe sweep.
Checks every recorded exchange is claimed, both commands answer `saved`, generations 1 and 2, the contributor role and
metered minutes that never decrease. It measures the client's overhead only: the recorded run took 26.7 s live.

Limitations: scripted or deterministic models, so no inference latency; node:sqlite or memory stores, not Durable
Object storage, except the workerd host; injected store faults, not real outages; objects reach each other by fetch,
not Alchemy RPC; the maintainer comes from configuration and trusted props, not a GitHub sign-in.

## Real-app links and keys, sign-in faults (2026-11-11, nyc-01)

Vitest built-in bench, local, three unwarmed samples each, nyc-01 (32 cores) at load 82 to 96, so wall times are
observations only. Method, checks and limitations: [0017](decisions/0017-benchmarks.md), "Source-map lines in Node".

| Workload | Mean ms | Min ms | Max ms | Samples | Artifact |
| --- | ---: | ---: | ---: | ---: | --- |
| `web-wiki-links` | 1,496.22 | 1,247.84 | 1,883.23 | 3 | `2026-11-11T07-10-10.848Z-web-wiki-links.json` |
| `web-account-menu-keys` | 715.23 | 664.48 | 756.85 | 3 | `2026-11-11T07-10-13.424Z-web-account-menu-keys.json` |
| `web-tour-keys` | 673.86 | 645.58 | 691.65 | 3 | `2026-11-11T07-10-15.849Z-web-tour-keys.json` |
| `web-wiki-state` | 0.4013 | 0.2483 | 3.1580 | 250 | `2026-11-11T06-50-03.465Z-web-wiki-state.json` |
| `signin-device-faults` | 2,015.06 | 1,592.54 | 2,419.76 | 3 | `2026-11-11T06-51-56.353Z-signin-device-faults.json` |

Each DOM sample includes a fresh app runtime, its first render and every wait for a step's result (5 ms polling).
`web-wiki-links` includes the mock agent's two scripted answers.

## Tour pause, small source paths, Factory refusals (2026-11-11, nyc-01)

Vitest built-in bench, local, nyc-01 (32 cores) at load 90 to 105, so wall times are observations only. Method,
checks and limitations: [0017](decisions/0017-benchmarks.md), "Small paths, Factory refusals, the Container replay".

| Workload | Mean ms | Min ms | Max ms | Samples | Artifact |
| --- | ---: | ---: | ---: | ---: | --- |
| `web-tour-pause` | 858.13 | 801.18 | 911.28 | 3 | `2026-11-11T07-50-34.174Z-web-tour-pause.json` |
| `src-edge-decisions` | 3.3191 | 0.1416 | 115.94 | 63 | `2026-11-11T07-51-01.703Z-src-edge-decisions.json` |
| `wiki-proposal-restart` | 105.78 | 41.26 | 232.23 | 3 | `2026-11-11T07-51-02.271Z-wiki-proposal-restart.json` |
| `docs-open-flow` | 6.2608 | 2.9718 | 16.7671 | 16 | `2026-11-11T07-51-02.783Z-docs-open-flow.json` |
| `cli-sandbox-run-text` | 15.31 | 11.29 | 23.86 | 7 | `2026-11-11T07-51-03.464Z-cli-sandbox-run-text.json` |
| `client-local-answers` | 63.80 | 43.82 | 79.69 | 5 | `2026-11-11T07-51-10.110Z-client-local-answers.json` |
| `live-factory-refusals` | 2.8614 | 1.8567 | 7.0691 | 35 | `2026-11-11T08-04-04.062Z-live-factory-refusals.json` |

`src-edge-decisions`' 116 ms maximum is its first, cold sample; its median is under 1 ms. `web-tour-pause` includes a
fresh app runtime, its first render and the mock tour's first step.
