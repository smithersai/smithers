# Benchmarks

This complete receipt measured source `7d66df9f` on parent `186575ce`, before the later issue flows and UUID/body-limit fixes. Its exact tracked source is archived with `receipt-7d66df9f/`; artifacts are not relabeled after rebasing. Later focused observations and a new coverage receipt follow separately. The historical coverage table below does not certify the newer source.

Decision [0017](decisions/0017-benchmarks.md). Run on shared nyc-01, Linux x86_64, Node 26.5.0, VibeLang 0.0.12, Effect 4.1.1, Vitest 5.0.0 and Chromium 151 via Playwright 1.62.1. JSON artifacts retain machine/CPU, versions, source revision and UTC timestamp under `bench/results/`; the lane report archives them outside the disposable workspace. Production does not expose its deployed revision; the live artifact records that identity as unknown.

`pnpm bench` uses Vitest built-in bench. Correctness assertions are inside timing; setup is outside unless the workload method says otherwise. Short cases use 30ms warmup and at least five iterations across 100ms. Slow cases take three unwarmed samples, except one complete naturally paced mock tour, one fresh history-object read and one browser journey. Means and callback throughput below include assertions; three samples establish no tail percentile. Replay events/s is callback throughput multiplied by the exact event count. Wall-clock values are observations on a contended host, not gate thresholds.

Every timing row references its exact method, limitations and artifact below. Instrumented coverage artifacts and unsuccessful observations are omitted.

## Local validated workloads

| Suite | Callback | Mean ms | Samples | Callbacks/s | Replay events/s | Method |
| --- | --- | --- | --- | --- | --- | --- |
| agent-projection | agent-projection | 0.1304 | 767 | 7666.6 |  | M1 |
| budget | budget | 0.4794 | 209 | 2085.8 |  | M2 |
| cli | --mock read --json | 11551.6754 | 3 | 0.1 |  | M3 |
| cli | --mock ask install --json | 4515.0361 | 3 | 0.2 |  | M3 |
| cli | --llms | 5375.8197 | 3 | 0.2 |  | M3 |
| cli | --help | 6269.4480 | 3 | 0.2 |  | M3 |
| commands | mock-agent-ask | 560.4919 | 3 | 1.8 |  | M4 |
| commands | read-command | 6.6320 | 22 | 150.8 |  | M4 |
| context-command-policies | context-and-command-decisions | 0.4135 | 242 | 2418.4 |  | M5 |
| core-10 | decide | 0.0191 | 5242 | 52419.6 |  | M6 |
| core-10 | apply | 0.0174 | 5741 | 57405.6 |  | M6 |
| core-10 | receive | 0.0179 | 5585 | 55847.1 |  | M6 |
| core-10 | replay-apply | 0.0273 | 3658 | 36573.3 | 365733.2 | M6 |
| core-10 | replay-receive | 0.0195 | 5143 | 51302.8 | 513027.5 | M6 |
| core-1000 | decide | 0.0159 | 6282 | 62812.6 |  | M7 |
| core-1000 | apply | 0.0288 | 3474 | 34735.0 |  | M7 |
| core-1000 | receive | 0.0234 | 4275 | 42747.6 |  | M7 |
| core-1000 | replay-apply | 0.1149 | 871 | 8706.5 | 8706523.3 | M7 |
| core-1000 | replay-receive | 0.1580 | 642 | 6330.7 | 6330686.1 | M7 |
| core-100000 | decide | 2.2774 | 45 | 439.1 |  | M8 |
| core-100000 | apply | 4.2155 | 24 | 237.2 |  | M8 |
| core-100000 | receive | 3.2692 | 31 | 305.9 |  | M8 |
| core-100000 | replay-apply | 10.6243 | 10 | 94.1 | 9412375.7 | M8 |
| core-100000 | replay-receive | 13.3120 | 8 | 75.1 | 7512023.0 | M8 |
| failure-views | failure-views | 11.4859 | 9 | 87.1 |  | M9 |
| history-10 | history-decide | 0.0176 | 5710 | 56883.9 |  | M11 |
| history-10 | history-apply | 0.0295 | 3391 | 33908.0 |  | M11 |
| history-10 | history-decode | 0.2152 | 465 | 4647.7 |  | M11 |
| history-1000 | history-decide | 0.0367 | 2723 | 27228.6 |  | M12 |
| history-1000 | history-apply | 0.0896 | 1117 | 11166.2 |  | M12 |
| history-1000 | history-decode | 14.3988 | 7 | 69.5 |  | M12 |
| history-100000 | history-decide | 2.8695 | 35 | 348.5 |  | M13 |
| history-100000 | history-apply | 5.4592 | 19 | 183.2 |  | M13 |
| history-100000 | history-decode | 803.3196 | 5 | 1.2 |  | M13 |
| history-actions | history-actions | 1.9780 | 51 | 505.5 |  | M14 |
| history-bootstrap | history-bootstrap-graph | 0.5077 | 197 | 1969.7 |  | M15 |
| history-catalog | history-catalog-calls | 26.2380 | 3 | 38.1 |  | M17 |
| history-flow-policies | history-flow-ordering | 6.6768 | 15 | 149.8 |  | M18 |
| history-flows | history-plan-start-note-approve-fold | 45.2774 | 3 | 22.1 |  | M19 |
| history-malformed-replay | history-malformed-replay | 0.7085 | 152 | 1411.4 |  | M20 |
| history-page-boundaries | history-page-boundaries | 0.2196 | 456 | 4554.2 |  | M21 |
| history-pages-10 | history-outline | 0.0293 | 3509 | 34099.8 |  | M22 |
| history-pages-10 | history-epic-pages | 0.0482 | 2074 | 20729.5 |  | M22 |
| history-pages-10 | history-commit-page | 0.0174 | 5760 | 57335.0 |  | M22 |
| history-pages-10 | history-search | 0.0332 | 3016 | 30154.6 |  | M22 |
| history-pages-10 | history-page-codecs | 0.1262 | 793 | 7923.0 |  | M22 |
| history-pages-1000 | history-outline | 0.1130 | 885 | 8850.0 |  | M23 |
| history-pages-1000 | history-epic-pages | 0.1842 | 549 | 5427.8 |  | M23 |
| history-pages-1000 | history-commit-page | 0.0300 | 3339 | 33386.5 |  | M23 |
| history-pages-1000 | history-search | 0.2552 | 392 | 3918.7 |  | M23 |
| history-pages-1000 | history-page-codecs | 4.3894 | 23 | 227.8 |  | M23 |
| history-pages-100000 | history-outline | 27.5701 | 5 | 36.3 |  | M24 |
| history-pages-100000 | history-epic-pages | 17.2415 | 6 | 58.0 |  | M24 |
| history-pages-100000 | history-commit-page | 4.0805 | 25 | 245.1 |  | M24 |
| history-pages-100000 | history-search | 32.4016 | 5 | 30.9 |  | M24 |
| history-pages-100000 | history-page-codecs | 626.8926 | 5 | 1.6 |  | M24 |
| history-recovery | history-retelling-recovery | 10.3695 | 10 | 96.4 |  | M25 |
| history-roles | history-role-matrix | 0.3096 | 323 | 3229.9 |  | M26 |
| history-seed | history-seed-decode | 368.9434 | 3 | 2.7 |  | M27 |
| history-surfaces | cli-history | 4483.2179 | 3 | 0.2 |  | M28 |
| history-surfaces | cli-plan | 5693.4962 | 3 | 0.2 |  | M28 |
| history-surfaces | mcp-history-plan-start-note | 203.7390 | 3 | 4.9 |  | M28 |
| history-tools | history-tool-lifecycle | 45.7806 | 3 | 21.8 |  | M29 |
| history-tools | history-tool-faults | 0.5082 | 199 | 1967.8 |  | M29 |
| history-web-10 | history-filter-keystroke | 0.1783 | 561 | 5608.2 |  | M30 |
| history-web-10 | history-open-epic-view | 64.7939 | 3 | 15.4 |  | M30 |
| history-web-1000 | history-filter-keystroke | 0.0462 | 2407 | 21656.6 |  | M31 |
| history-web-1000 | history-open-epic-view | 364.7814 | 3 | 2.7 |  | M31 |
| history-web-1000 | history-next-page-update | 0.9226 | 132 | 1083.9 |  | M31 |
| history-web-100000 | history-filter-keystroke | 0.2767 | 421 | 3613.7 |  | M32 |
| history-web-100000 | history-open-epic-view | 20103.1186 | 3 | 0.0 |  | M32 |
| history-web-100000 | history-next-page-update | 0.2722 | 374 | 3674.3 |  | M32 |
| history-workerd | history-first-outline | 639.3253 | 1 | 1.6 |  | M33 |
| history-workerd | history-warm-outline | 16.2349 | 3 | 61.6 |  | M33 |
| history-workerd | history-detail-pages | 85.5618 | 3 | 11.7 |  | M33 |
| history-workerd | history-viewer-refusals | 565.9189 | 3 | 1.8 |  | M33 |
| history-workerd | history-protocol-errors | 30.8185 | 3 | 32.4 |  | M33 |
| http | http-boundaries | 8.6005 | 12 | 116.3 |  | M34 |
| machine-boundaries | machine-boundaries | 1.4637 | 69 | 683.2 |  | M39 |
| markdown | markdown-blocks | 0.0122 | 8208 | 82073.5 |  | M40 |
| mcp | mcp-read | 6644.7263 | 3 | 0.2 |  | M41 |
| mcp | mcp-ask | 4255.7309 | 3 | 0.2 |  | M41 |
| mcp-warm | mcp-warm-read | 51.0135 | 5 | 19.6 |  | M42 |
| mock-close | mock-factory-close | 6.8761 | 15 | 145.4 |  | M43 |
| mock-history-agent | mock-agent-history | 624.0935 | 3 | 1.6 |  | M44 |
| mock-scripts | mock-scripts | 0.4275 | 234 | 2339.2 |  | M45 |
| mock-tour | mock-tour-complete | 61540.4279 | 1 | 0.0 |  | M46 |
| mock-tour | mock-tour-end | 57.1874 | 3 | 17.5 |  | M46 |
| model-config | model-config | 1.8955 | 53 | 527.6 |  | M47 |
| model-context-10 | model-context-select-and-window | 0.1143 | 875 | 8747.6 |  | M48 |
| model-context-1000 | model-context-select-and-window | 2.8491 | 36 | 351.0 |  | M49 |
| model-context-100000 | model-context-select-and-window | 192.5792 | 5 | 5.2 |  | M50 |
| policies | flow-and-budget-policies | 0.4292 | 234 | 2330.2 |  | M51 |
| protocol | event-encode | 0.0305 | 3289 | 32733.3 |  | M52 |
| protocol | event-decode | 0.0188 | 5313 | 53128.3 |  | M52 |
| protocol | snapshot-decode-10 | 0.0764 | 1310 | 13093.4 |  | M52 |
| protocol | snapshot-decode-1000 | 4.4354 | 23 | 225.5 |  | M52 |
| protocol | snapshot-decode-100000 | 529.0272 | 5 | 1.9 |  | M52 |
| protocol | route-roundtrip | 0.0174 | 5761 | 57601.1 |  | M52 |
| resources | resources-dev | 30.5372 | 3 | 32.7 |  | M53 |
| resources | resources-production | 12.0282 | 3 | 83.1 |  | M53 |
| resources | resources-factory.example.test | 18.8422 | 3 | 53.1 |  | M53 |
| runtime | runtime-startup-post | 1163.6115 | 3 | 0.9 |  | M54 |
| sandbox-agent | sandbox-agent-bindings | 19.2358 | 3 | 52.0 |  | M55 |
| sandbox-factory-1 | sandbox-file-restart | 49.5310 | 3 | 20.2 |  | M57 |
| sandbox-factory-100 | sandbox-file-restart | 1016.9812 | 3 | 1.0 |  | M58 |
| sandbox-meter | sandbox-meter-and-policy | 0.7325 | 137 | 1365.1 |  | M59 |
| sandbox-public-workerd | workerd-sandbox-viewer | 41.6994 | 3 | 24.0 |  | M60 |
| sandbox-surfaces | cli-sandboxes | 4370.7255 | 3 | 0.2 |  | M61 |
| sandbox-surfaces | cli-sandbox-start | 3013.0806 | 3 | 0.3 |  | M61 |
| sandbox-surfaces | mcp-sandbox-file-restart | 67.2673 | 3 | 14.9 |  | M61 |
| screen-protocol-policies | screen-protocol-mock-policies | 0.7478 | 136 | 1337.3 |  | M62 |
| sequencer | sequencer-lifecycle | 1.7862 | 56 | 559.9 |  | M63 |
| site | site-routing | 72.5706 | 3 | 13.8 |  | M64 |
| surface-failures | cli-failure---mock ask   | 4877.6985 | 3 | 0.2 |  | M65 |
| surface-failures | cli-failure---mock read --after -1 | 3415.0197 | 3 | 0.3 |  | M65 |
| surface-failures | cli-failure---wat | 3801.0158 | 3 | 0.3 |  | M65 |
| surface-failures | cli-failure-read | 6200.6397 | 3 | 0.2 |  | M65 |
| surface-failures | mcp-unreachable | 5042.7982 | 3 | 0.2 |  | M65 |
| transport | transport-fault-matrix | 39.7732 | 5 | 25.1 |  | M66 |
| web-10 | keystroke-update | 0.0346 | 3103 | 28941.1 |  | M67 |
| web-10 | incoming-event-update | 0.0174 | 5753 | 57428.1 |  | M67 |
| web-10 | view | 5.6831 | 3 | 176.0 |  | M67 |
| web-1000 | keystroke-update | 0.0144 | 6989 | 69662.2 |  | M68 |
| web-1000 | incoming-event-update | 0.0334 | 2993 | 29927.6 |  | M68 |
| web-1000 | view | 75.2446 | 3 | 13.3 |  | M68 |
| web-100000 | keystroke-update | 0.0139 | 7188 | 71876.1 |  | M69 |
| web-100000 | incoming-event-update | 3.9233 | 26 | 254.9 |  | M69 |
| web-100000 | view | 5219.6984 | 3 | 0.2 |  | M69 |
| web-actions | web-actions | 6.4751 | 16 | 154.4 |  | M70 |
| workerd | workerd-post-reply-read | 811.6462 | 3 | 1.2 |  | M71 |
| workerd | workerd-tour | 24802.2742 | 3 | 0.0 |  | M71 |

## Methods, limitations and artifacts

**M1 — agent-projection.** `2026-11-08T10-30-46.720Z-agent-projection.json`; UTC `2026-11-08T10:30:46.720Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; project partial cell answers, restart, sum token usage, bound input history and classify provider failures without disclosing messages. Limitations: Projection and policy only; actual agent and QuickJS cell execution measured in workerd.

**M2 — budget.** `2026-11-08T10-30-48.756Z-budget.json`; UTC `2026-11-08T10:30:48.756Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; real budget over in-memory ledger; rounding/clamping, duplicate spend, admission at limit and exact ledger asserted. Limitations: In-process ledger; remote Durable Object transport excluded.

**M3 — cli.** `2026-11-08T10-22-37.834Z-cli.json`; UTC `2026-11-08T10:22:37.834Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; spawn emitted CLI to exit with stdout/stderr capture; three samples per command, no warmup. Build excluded; loader/process startup included. Limitations: Mock backend for ask/read; no network/model. Source package loading contributes to startup.

**M4 — commands.** `2026-11-08T10-21-13.238Z-commands.json`; UTC `2026-11-08T10:21:13.238Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; new scoped MockFactory/engine per call. Ask includes real scripted delays and settled answer; Read includes schema validation and layer lifecycle. Limitations: Product mock mode; no backend/model. Ask timing includes intentional 25ms per scripted chunk.

**M5 — context-command-policies.** `2026-11-08T10-30-36.129Z-context-command-policies.json`; UTC `2026-11-08T10:30:36.129Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; prompt eligibility, first duplicate identity, source-order indexes/windowing and correlated CLI/MCP collection through unrelated events, restart, finish/failure. Complete expected selections, answer fields/event numbers and outcome/error precedence checked. Limitations: Small in-process decision corpus, no model/IPC or service execution. Assertions included; large transcript cost is measured separately.

**M6 — core-10.** `2026-11-08T10-29-39.634Z-core-10.json`; UTC `2026-11-08T10:29:39.634Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 10 completed posts for single transitions; replay has exactly 10 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**M7 — core-1000.** `2026-11-08T10-29-40.487Z-core-1000.json`; UTC `2026-11-08T10:29:40.487Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 1000 completed posts for single transitions; replay has exactly 1000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**M8 — core-100000.** `2026-11-08T10-29-41.422Z-core-100000.json`; UTC `2026-11-08T10:29:41.422Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 100000 completed posts for single transitions; replay has exactly 100000 events (post/start/deltas/finish). Setup excluded; assertions included; {"time":100,"warmupTime":30,"iterations":5,"warmupIterations":2}. Limitations: Shared nyc-01 host; JIT/GC and assertion overhead included. Replay is a long streamed reply with two entries; it does not measure 100,000 distinct posts. Single-transition fixtures cover the growing entry scan separately.

**M9 — failure-views.** `2026-11-08T10-30-50.741Z-failure-views.json`; UTC `2026-11-08T10:30:50.741Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; render every declared post failure and connection/tour failure with accessible retry/reconnect controls. Limitations: Scenes from state-machine client fixtures; no transport interception.

**M10 — gate.** `2026-11-08T10-30-38.312Z-gate.json`; UTC `2026-11-08T10:30:38.312Z`; source `7d66df9f78317490982142327d45b468a5542173`. Indexed entry reads through a transparent Proxy on completed-post fixtures of 10/1000/100000 entries. Correctness checked after counter capture. Allowed increase: ceil(baseline * 1.05); zero stays zero; exact roster required. Limitations: Counts entry access, not instruction count, allocations, network or latency; additional uninstrumented work requires timing review.

**M11 — history-10.** `2026-11-08T10-30-06.610Z-history-10.json`; UTC `2026-11-08T10:30:06.610Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 10 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**M12 — history-1000.** `2026-11-08T10-30-07.297Z-history-1000.json`; UTC `2026-11-08T10:30:07.297Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 1000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**M13 — history-100000.** `2026-11-08T10-30-14.360Z-history-100000.json`; UTC `2026-11-08T10:30:14.360Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 100000 valid planned commits in one epic; decide/apply one append and Schema JSON decode, checking assigned rank, identity, count, tail and full decoded snapshot equality. Setup excluded; assertions included. Limitations: In-process history/codec cost; no storage, network or model.

**M14 — history-actions.** `2026-11-08T10-28-21.187Z-history-actions.json`; UTC `2026-11-08T10:28:21.187Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; history reducer corpus for page/read responses, forms, navigation/write intents, success/refusal, retries, late/detached data and events. Independent field, command-count and identity assertions; real commands execute in Chromium separately. Limitations: Reducer/command construction cost, no network or durable execution. Pages are actual projections of a two-commit fixture.

**M15 — history-bootstrap.** `2026-11-08T10-31-10.065Z-history-bootstrap.json`; UTC `2026-11-08T10:31:10.065Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; three-commit first-parent/merge graph with rejected and landed queue entries; exact first-parent incremental order/cursor handling, bucket order/mapping, evidence, complete bootstrap and lossless seed projection/replay checked. Limitations: Small deterministic real-commit fixture; actual large committed snapshot decode measured separately; no GitHub call or repository mutation.

**M16 — history-browser-actions.** `2026-11-08T10-29-06.727Z-history-browser-actions.json`; UTC `2026-11-08T10:29:06.727Z`; source `7d66df9f78317490982142327d45b468a5542173`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial Chromium journey over the full committed history and real MockMythical durable flows. Bootstrap, scripted work and automation included; no percentile. Fold changes only the product mock, never a real repository. Viewer UI omits writes; live writes are benchmarked as actual workerd refusals.

**M17 — history-catalog.** `2026-11-08T10-30-27.849Z-history-catalog.json`; UTC `2026-11-08T10:30:27.849Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; real harness call identities/declaration digests invoke all four actual FlowBinding handlers and a populated outline reread after writes, including schema validation and result encoding; fresh product history engine, exact outputs and resulting signed note checked. Three samples. Limitations: No model selection or QuickJS process; this measures the binding/handler boundary directly. Real durable history flows run behind the binding.

**M18 — history-flow-policies.** `2026-11-08T10-30-35.789Z-history-flow-policies.json`; UTC `2026-11-08T10:30:35.789Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; five roles × seven actions × human/agent; independent minimum-role matrix, authorization once, recording forbidden before authorization, single record except repeated fold, and illegal states checked. Limitations: Pure journal/policy decisions; actual durable flows and storage are separate workloads. Assertions included.

**M19 — history-flows.** `2026-11-08T10-30-14.678Z-history-flows.json`; UTC `2026-11-08T10:30:14.678Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; actual MockMythical, sequencer and in-memory durable engine; plan/create epic, start, note, human approval and merge-queue fold; outline/detail composition and complete event replay equality checked. Three fresh engines. Limitations: Explicit human maintainer in a local fixture; product agent permission is measured separately. No real repository write or provider call.

**M20 — history-malformed-replay.** `2026-11-08T10-25-37.048Z-history-malformed-replay.json`; UTC `2026-11-08T10:25:37.048Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; ten invalid event shapes across all seven event kinds, each checked as next, duplicate and gap. Invalid next content advances only the cursor; duplicates/gaps retain the original object and full state. Limitations: Pure replay boundary, deliberately malformed events; not storage transport corruption or authenticated admission.

**M21 — history-page-boundaries.** `2026-11-08T10-29-55.571Z-history-page-boundaries.json`; UTC `2026-11-08T10:29:55.571Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; reversed physical commit array across two epics, notes and three real folds; exact stack order/counts/details, missing/negative cursor behavior, all four route/URI round trips and status classes checked. Limitations: Small deterministic projection/protocol corpus; no network or history mutation.

**M22 — history-pages-10.** `2026-11-08T10-29-48.213Z-history-pages-10.json`; UTC `2026-11-08T10:29:48.213Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 10 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**M23 — history-pages-1000.** `2026-11-08T10-29-49.074Z-history-pages-1000.json`; UTC `2026-11-08T10:29:49.074Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 1000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**M24 — history-pages-100000.** `2026-11-08T10-29-55.206Z-history-pages-100000.json`; UTC `2026-11-08T10:29:55.206Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 100000 planned commits in one epic. Outline checks every open identity/rank/count; first/tail/past-end epic pages check complete IDs and totals; detail, bounded search and complete JSON round trips checked. Setup/encoding excluded from decode; assertions included. Limitations: In-process projections and codecs, no network/storage. Outline intentionally includes every open commit, so this all-planned worst case remains large; epic reads cap at 50 and search at 100. Actual committed-history browser and workerd paths are separate.

**M25 — history-recovery.** `2026-11-08T10-25-36.308Z-history-recovery.json`; UTC `2026-11-08T10:25:36.308Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; bootstrap a landed commit and pending sibling, reopen/amend, insert before sibling, refuse invalid plans, start/note/approve and fold exact trailer. Recreate the real sequencer over the same memory store; compare full independent expected state, every event, replay, schema round trip and duplicate identity. Each callback owns a new store. Limitations: In-memory durable-store contract and sequencer; no SQLite restart, repository write, network or model. Assertions and fresh store construction included.

**M26 — history-roles.** `2026-11-08T10-30-16.349Z-history-roles.json`; UTC `2026-11-08T10:30:16.349Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; all five roles, human and agent; every agent forbidden to approve/fold, every role allowed to read, only human maintainer allowed to approve. Limitations: Pure policy cost; signed-in identity is a separate integration boundary.

**M27 — history-seed.** `2026-11-08T10-30-16.000Z-history-seed.json`; UTC `2026-11-08T10:30:16.000Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; decode the actual committed VibeLang bootstrap projection; validate unique mythical identities, every real-commit mapping and the final main cursor. Three samples; module cached after its first import. Limitations: Snapshot parsing and validation, not a fresh network/GitHub import or bootstrap from an empty durable object.

**M28 — history-surfaces.** `2026-11-08T10-25-06.662Z-history-surfaces.json`; UTC `2026-11-08T10:25:06.662Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; emitted CLI history/plan include startup and full committed bootstrap; persistent real MCP plan/start/note/history includes schema/IPC and four flows/calls. Three samples each, no warmup; exact detail, note author and unchanged main checked. Limitations: Product mock history, no repository mutation or model. MCP history grows by one planned commit per sample; handshake/bootstrap excluded from its timing.

**M29 — history-tools.** `2026-11-08T10-30-25.206Z-history-tools.json`; UTC `2026-11-08T10:30:25.206Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; real tool catalog, product MockMythical and durable plan/start/note plus all four paged reads; contributor retell refusal, signed note, missing-input defaults and injected faulty Effect service. Three fresh lifecycle engines; fault handling short-run warmup. Limitations: Tool/flow overhead, no model inference or production storage. No approve/fold binding exists. Actual model choice and calls to these bindings inside QuickJS are not measured here.

**M30 — history-web-10.** `2026-11-08T10-26-54.835Z-history-web-10.json`; UTC `2026-11-08T10:26:54.835Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 10 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**M31 — history-web-1000.** `2026-11-08T10-26-57.924Z-history-web-1000.json`; UTC `2026-11-08T10:26:57.924Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 1000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**M32 — history-web-100000.** `2026-11-08T10-28-20.650Z-history-web-100000.json`; UTC `2026-11-08T10:28:20.650Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 100000 internal planned commits projected outside timing. Filter keystroke constructs one read command without copying outline; exact scoped 50-row count/tail in open-epic scene; second-page update preserves outline and all 100 IDs. Three unwarmed view samples; assertions/query cost included. Limitations: No layout/paint or service execution. Outline includes every planned commit in this worst case, so the separate Planned list still scales with the full fixture. Normal committed-history browser workload pages 50 at a time.

**M33 — history-workerd.** `2026-11-08T10-19-47.354Z-history-workerd.json`; UTC `2026-11-08T10:19:47.354Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; actual History Durable Object with full committed bootstrap, real SQLite durable flows and LiveMythical HTTP. First read measured once on a fresh object; warm outlines, first/second epic pages, commit detail, bounded search, five viewer refusals plus unchanged outline, and protocol errors measured three times. Server/bundler startup excluded; schema/assertions included. Limitations: Local workerd, no production network or model. First read is object bootstrap, not a forced cold isolate. Anonymous callers are viewers on this revision, so successful history writes are benchmarked through real MockMythical flows separately.

**M34 — http.** `2026-11-08T10-31-08.466Z-http.json`; UTC `2026-11-08T10:31:08.466Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; real handler and sequencer; valid post/read/tour/end/events routing, body size/schema/name checks, cursor bounds, duplicate, and injected faulty Effect service returning Unreachable. Exact status and accepted state asserted. Limitations: In-process HTTP objects, no TCP; SQLite/durable engine covered in workerd.

**M35 — live-api.** `2026-11-08T08-32-13.149Z-live-api.json`; UTC `2026-11-08T08:32:13.149Z`; source `e1ac046298b2b50f954513bc9cee877811d85812`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: Real model tokens, opt in. Fresh object vs repeated read cannot force a cold Worker isolate; network/PoP/provider/cache/budget contention are uncontrolled. First answer delta is the first projected visible token, not the provider's first raw token (the protocol does not expose that). Three samples do not establish percentiles. A failure field is unsuccessful evidence, not a latency claim.

**M36 — live-browser.** `2026-11-08T08-32-06.472Z-live-browser.json`; UTC `2026-11-08T08:32:06.472Z`; source `e1ac046298b2b50f954513bc9cee877811d85812`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: Default production backend selection; UI-only navigation and keys make no model call. Fresh context, shared browser/OS caches and automation overhead; no forced cold cache.

**M37 — local-browser.** `2026-11-08T10-28-52.197Z-local-browser.json`; UTC `2026-11-08T10:28:52.197Z`; source `7d66df9f78317490982142327d45b468a5542173`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: Product mock mode, fresh browser context, shared browser/OS caches and automation overhead; no forced cold cache.

**M38 — local-browser-actions.** `2026-11-08T10-29-02.227Z-local-browser-actions.json`; UTC `2026-11-08T10:29:02.227Z`; source `7d66df9f78317490982142327d45b468a5542173`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial native-browser journey with real Foldkit and product MockFactory; timings include scripted delays and automation. External docs content is not asserted; only the correct pane URL and controls. Touch is dispatched as native synthetic DOM events, not physical hardware. Single observations establish no percentile.

**M39 — machine-boundaries.** `2026-11-08T10-30-51.970Z-machine-boundaries.json`; UTC `2026-11-08T10:30:51.970Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; complete reply/restart/tour lifecycles, admission boundaries, malformed replay, optimistic failure/retry/confirmation/gap/duplicate delivery; assertions included. Limitations: In-process state machine; not exhaustive input enumeration or proof.

**M40 — markdown.** `2026-11-08T10-29-37.871Z-markdown.json`; UTC `2026-11-08T10:29:37.871Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; parse a paragraph/code/paragraph answer; compare complete blocks. Limitations: Small fixed answer; rendering is measured separately.

**M41 — mcp.** `2026-11-08T10-23-11.094Z-mcp.json`; UTC `2026-11-08T10:23:11.094Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; new emitted stdio server, real MCP initialize/discovery/call, validated schema and result; three samples, no warmup. Limitations: Includes process startup, handshake and teardown; mock backend; warm persistent-session call latency is measured separately.

**M42 — mcp-warm.** `2026-11-08T10-24-30.010Z-mcp-warm.json`; UTC `2026-11-08T10:24:30.010Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; initialize and discover once outside timing; measure read calls on the same real stdio process, asserting the complete empty snapshot. Limitations: Product mock backend; schema/protocol/IPC included, startup/teardown excluded.

**M43 — mock-close.** `2026-11-08T10-26-48.985Z-mock-close.json`; UTC `2026-11-08T10:26:48.985Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; build and close actual Factory scope, then verify a post is refused as unavailable. Limitations: Lifecycle cost, no model or network.

**M44 — mock-history-agent.** `2026-11-08T10-30-27.516Z-mock-history-agent.json`; UTC `2026-11-08T10:30:27.516Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; fresh real MockFactory per sample, committed history decoded, journaled show tool, naturally streamed answer; exact repository main and epic counts independently composed and checked. Limitations: Product mock mode; three samples include intentional reply delays and history decode. No provider/model or network.

**M45 — mock-scripts.** `2026-11-08T10-26-48.260Z-mock-scripts.json`; UTC `2026-11-08T10:26:48.260Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; script selection including fallback, reconstruct every selected reply from chunks. Limitations: Fixed synthetic prompts; syntax compilation remains in the separate unit suite.

**M46 — mock-tour.** `2026-11-08T10-26-47.679Z-mock-tour.json`; UTC `2026-11-08T10:26:47.679Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; real MockFactory durable tour; verify each stop, complete exact script, busy refusal, ended-tour refusal and cancellation after first delta. One complete natural-paced run; three cancellations. Limitations: Includes production reading holds, based on each paragraph; one completion establishes no percentile. Product mock mode, no model/backend.

**M47 — model-config.** `2026-11-08T10-30-47.053Z-model-config.json`; UTC `2026-11-08T10:30:47.053Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; actual Config and HostModel planning; default/unconfigured and configured model records, zero/default daily budget; no provider calls. Limitations: Configuration and route construction cost only.

**M48 — model-context-10.** `2026-11-08T10-30-17.913Z-model-context-10.json`; UTC `2026-11-08T10:30:17.913Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 10 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**M49 — model-context-1000.** `2026-11-08T10-30-18.298Z-model-context-1000.json`; UTC `2026-11-08T10:30:18.298Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 1000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**M50 — model-context-100000.** `2026-11-08T10-30-20.209Z-model-context-100000.json`; UTC `2026-11-08T10:30:20.209Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; 100000 completed person posts; select through the last post, preserve every ordered index/turn, then take the final 12. Full independent expected arrays and window checked. Setup excluded; assertions included. Limitations: In-process collection/scan/allocation plus full equality checks, no model tokenization/inference or network. The selection scans the full prefix before windowing.

**M51 — policies.** `2026-11-08T10-30-35.070Z-policies.json`; UTC `2026-11-08T10:30:35.070Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; strict admission, idempotent charging, accepted-only dispatch, reply attempt/offset/empty boundaries, tour terminal identity, retry classification and failure precedence; explicit behavioral truth tables. Limitations: Fixed in-process policy corpus; assertions dominate these small decisions, not an inference/model/storage measurement.

**M52 — protocol.** `2026-11-08T10-29-46.669Z-protocol.json`; UTC `2026-11-08T10:29:46.669Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench, Schema JSON codec, validated complete event round trips and snapshot length/tail; URL encode/decode. Setup excluded, assertions included. Limitations: In-process codec cost; no HTTP or network.

**M53 — resources.** `2026-11-08T10-31-06.044Z-resources.json`; UTC `2026-11-08T10:31:06.044Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; actual Alchemy stack compilation in temporary local state, dev/default production/domain variants; exact resource names, bindings, routes and CPU/observability settings checked. Three samples each, including layer/state-directory lifecycle. Limitations: Resource declarations only; no plan, deploy, provider lifecycle or Cloudflare account operation. Runtime object paths run separately in workerd.

**M54 — runtime.** `2026-11-08T10-30-33.597Z-runtime.json`; UTC `2026-11-08T10:30:33.597Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench, happy-dom with the actual startup program, stylesheet, Foldkit subscriptions/commands and MockFactory. Native Command-K and input/Enter; wait for the complete expected installed command. New scoped runtime each sample; 3 samples. Limitations: DOM runtime, no layout or paint; includes scripted reply delays and observer polling. Forced product mock mode, no network/model.

**M55 — sandbox-agent.** `2026-11-08T10-30-04.139Z-sandbox-agent.json`; UTC `2026-11-08T10:30:04.139Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; actual harness bindings and stable cell identities over the real product mock flows. Invoke Start/Command/Stop/Start, replay old Stop, and read retained bytes through Command; verify bound conversation, catalog roster, generations and output. Three fresh engines. Limitations: Agent binding overhead without model selection or QuickJS; no Container. The public viewer boundary is measured separately; the SQLite lifecycle benchmark remains deferred by the compiler reproduction.

**M56 — sandbox-browser-actions.** `2026-11-08T10-29-11.626Z-sandbox-browser-actions.json`; UTC `2026-11-08T10:29:11.626Z`; source `7d66df9f78317490982142327d45b468a5542173`. Serial Chromium desktop runs from nyc-01. First render: fresh context navigation to visible heading. Command-K: key dispatch to visible modal and focused textbox. Keystroke: key dispatch to input value. API: wall time at client; first event/visible answer delta and settlement from numbered SSE events. All raw samples retained; assertions included; no tail percentile claimed. Limitations: One serial real Chromium journey over product mock flows and supported terminal commands; exact retained terminal transcript checked across Stop/Start. No model/backend/real Container. Forced mock roles never grant live authority. Automation and scripted waits included; no percentile.

**M57 — sandbox-factory-1.** `2026-11-08T10-30-00.689Z-sandbox-factory-1.json`; UTC `2026-11-08T10:30:00.689Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 1 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**M58 — sandbox-factory-100.** `2026-11-08T10-30-03.895Z-sandbox-factory-100.json`; UTC `2026-11-08T10:30:03.895Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; fresh contributor product MockFactory and durable engine; 100 write/Stop/Start/read cycles, exact retained bytes and generation checked each time. A/B/A stop replay cannot stop a new generation; a fresh stale stop is refused; another conversation stays empty. Three samples; layer lifecycle, actual clock and correctness included. Limitations: Product mock filesystem and supported shell, no backend/model/OS Container. One measured callback includes the whole cycle batch, not one command.

**M59 — sandbox-meter.** `2026-11-08T10-30-00.301Z-sandbox-meter.json`; UTC `2026-11-08T10:30:00.301Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; five role allowances, distinct identity/lease bounds, exact two-running-box accounting across a UTC boundary, rollback/high-water recovery, snapshot rounding, invalid clock domains and safe-sum overflow. Independent numeric totals checked; assertions included. Limitations: In-process normalized-clock fixtures, not a fake global clock or Container performance. Real-clock host/flow paths are separate workloads.

**M60 — sandbox-public-workerd.** `2026-11-08T10-19-47.828Z-sandbox-public-workerd.json`; UTC `2026-11-08T10:19:47.828Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; actual local workerd public sandbox router through LiveFactory: viewer snapshot, Start/Stop/Command forbidden, then unchanged empty state; exact typed refusals and all snapshot fields checked. Three serial five-request samples; bundling/server startup excluded. Limitations: Signed-out deployment boundary only, no trusted compute identity, Container or SQLite lifecycle. The separate sandbox SQLite benchmark is deferred by the nested-Effect compiler reproduction; this case does not substitute for it.

**M61 — sandbox-surfaces.** `2026-11-08T10-25-32.718Z-sandbox-surfaces.json`; UTC `2026-11-08T10:25:32.718Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; emitted CLI read/start includes cold process/layer setup. Persistent real stdio MCP starts, writes, stops, restarts, reads retained bytes, stops and verifies snapshot through seven calls; full ten-command catalog and exact generations/output checked. Three samples; MCP handshake excluded. Limitations: Product mock backend and maintainer surface principal, no real Container, model or repository write. MCP keeps one engine across samples and grows its receipt history; CLI gets a fresh engine each time. Assertions and IPC included.

**M62 — screen-protocol-policies.** `2026-11-08T10-30-35.412Z-screen-protocol-policies.json`; UTC `2026-11-08T10:30:35.412Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; actual extracted screen/protocol/mock decisions, independent truth tables for shortcut priority, scroll revisions, input bounds, routing/status, backend choice and script priority. Module imports/setup excluded, correctness assertions included. Limitations: Fixed policy corpus; assertion overhead dominates. DOM, HTTP and actual agent flows are separate workloads.

**M63 — sequencer.** `2026-11-08T10-30-48.421Z-sequencer.json`; UTC `2026-11-08T10:30:48.421Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; real sequencer on an in-memory append-only log. Post/refusal/duplicate, reply pieces, duplicate/stale pieces, restart, final replacement, tour, follower and fresh sequencer replay. Exact transcript and ordered events asserted; model history excludes tour narration while the transcript retains it. Limitations: In-process log, no storage I/O; SQLite/workerd measured separately.

**M64 — site.** `2026-11-08T10-31-12.802Z-site.json`; UTC `2026-11-08T10:31:12.802Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; production site Worker router over a real loopback HTTP file server serving repository home/logo bytes with SPA fallback, and real API handler health. Exact bodies, mock/live health and every rejection status checked. Three fresh scoped servers; startup/teardown included. Limitations: Local service-binding adapter over HTTP, no Cloudflare PoP or deployed asset cache; API error dependency is a deliberately faulty Effect service. Actual compiled UI/layout measured separately in Chromium.

**M65 — surface-failures.** `2026-11-08T10-24-21.603Z-surface-failures.json`; UTC `2026-11-08T10:24:21.603Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; emitted processes reject blank/invalid input, unknown flags and an actually closed loopback endpoint. Exact exit/status stream and public error checked; three samples each. Limitations: Unreachable loopback, no request interception; process startup and error rendering included.

**M66 — transport.** `2026-11-08T10-31-07.223Z-transport.json`; UTC `2026-11-08T10:31:07.223Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; inject a faulty Effect HttpClient into the actual Factory and Mythical adapters. Measure all chat/history/sandbox/terminal operations across transport errors, status failures, malformed JSON/protocol; exact safe typed error checked, no response body leaks. Limitations: Deliberate faulty service, no request interception; failure handling overhead without network latency. Successful transport paths run through real workerd.

**M67 — web-10.** `2026-11-08T10-29-14.587Z-web-10.json`; UTC `2026-11-08T10:29:14.587Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**M68 — web-1000.** `2026-11-08T10-29-15.438Z-web-1000.json`; UTC `2026-11-08T10:29:15.438Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**M69 — web-100000.** `2026-11-08T10-29-37.579Z-web-100000.json`; UTC `2026-11-08T10:29:37.579Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench. Immutable update on one draft keystroke and one received event; Foldkit scene renders the whole transcript and checks its exact scoped article count and tail. Setup excluded; assertions included; view 3 unwarmed samples. Limitations: Scene view includes serialization/query cost, no DOM patch/layout/paint. 100,000 entries may exceed a usable browser transcript; no virtualization exists.

**M70 — web-actions.** `2026-11-08T10-30-50.412Z-web-actions.json`; UTC `2026-11-08T10:30:50.412Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; all person-facing reducer messages, optimistic post retry, replay gap, connection, scroll, palette, splash and tour controls; scene assertions for retry and Esc. Limitations: Reducer/scene cost, no browser layout; native input and modal focus are covered by Chromium separately.

**M71 — workerd.** `2026-11-08T10-21-04.992Z-workerd.json`; UTC `2026-11-08T10:21:04.992Z`; source `7d66df9f78317490982142327d45b468a5542173`. Vitest built-in bench; actual local workerd Durable Objects, SQLite engine, alarms, LiveFactory HTTP/SSE, agent and QuickJS; deterministic HTTP model service. Three new conversations each, unwarmed. Bundling/server startup excluded; post-through-settle/read included. Limitations: Flow/adapter overhead, no model inference, WAN or production contention. Tour includes five real durable reading holds. Test host delegates to production Objects/Http; Alchemy's deploy-only wiring is not run.

## local-browser

Artifact `2026-11-08T10-28-52.197Z-local-browser.json`; UTC `2026-11-08T10:28:52.197Z`. Three fresh browser contexts, shared Chromium process/OS caches; navigation-to-visible-heading, native Meta+K-to-visible-modal/focused-prompt, and one character-to-actual-value. Locator/automation overhead included. No forced cold cache or layout-only timing. Product mock mode, fresh browser context, shared browser/OS caches and automation overhead; no forced cold cache.

| Run | First visible render ms | Command-K ms | Keystroke ms |
| --- | --- | --- | --- |
| 0 | 349.3762 | 162.9575 | 32.7349 |
| 1 | 359.6115 | 190.3224 | 94.0314 |
| 2 | 299.7414 | 109.3394 | 39.6248 |

## live-browser

Artifact `2026-11-08T08-32-06.472Z-live-browser.json`; UTC `2026-11-08T08:32:06.472Z`. Three fresh browser contexts, shared Chromium process/OS caches; navigation-to-visible-heading, native Meta+K-to-visible-modal/focused-prompt, and one character-to-actual-value. Locator/automation overhead included. No forced cold cache or layout-only timing. Default production backend selection; UI-only navigation and keys make no model call. Fresh context, shared browser/OS caches and automation overhead; no forced cold cache.

| Run | First visible render ms | Command-K ms | Keystroke ms |
| --- | --- | --- | --- |
| 0 | 347.2042 | 74.6880 | 41.1892 |
| 1 | 482.5347 | 63.3535 | 36.3387 |
| 2 | 384.1010 | 73.0577 | 24.8848 |

## Live API

Artifact `2026-11-08T08-32-13.149Z-live-api.json`; first sample `2026-11-08T00:32:07.548000-08:00` in America/Los_Angeles. Three real model posts; complete reply/event sequence and final snapshot equality checked. All post metrics start at post dispatch. SSE subscription begins after acceptance, following the command client. First answer delta is the public projected delta, not the provider’s raw first token. Fresh means a unique object’s first read, warm its next read; neither forces a cold isolate. WAN/PoP/provider/budget/cache and shared-host contention included. No percentile claim.

| UTC sample | Fresh object ms | Warm read ms | Acceptance ms | First event ms | First answer delta ms | Settled ms |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-08T08:32:07.548Z | 750.93 | 26.33 | 311.23 | 338.94 | 1602.46 | 1832.85 |
| 2026-11-08T08:32:10.236Z | 779.38 | 25.12 | 287.02 | 504.05 | 683.90 | 961.56 |
| 2026-11-08T08:32:11.961Z | 673.90 | 23.53 | 337.56 | 582.10 | 815.30 | 1120.07 |

## history-browser-actions

Artifact `2026-11-08T10-29-06.727Z-history-browser-actions.json`. One serial native-browser journey; every action passed its behavioral assertion. Scripted waits, automation and the existing mock delays are included. Single observations establish no percentile. One serial Chromium journey over the full committed history and real MockMythical durable flows. Bootstrap, scripted work and automation included; no percentile. Fold changes only the product mock, never a real repository. Viewer UI omits writes; live writes are benchmarked as actual workerd refusals.

| Action | ms | Correctness passed |
| --- | --- | --- |
| history-first-render | 775.90 | true |
| history-expand-epic | 116.87 | true |
| history-next-page | 141.85 | true |
| history-open-commit | 128.74 | true |
| history-amend-and-escape | 103.91 | true |
| history-amend-submit | 263.48 | true |
| history-insert-before | 157.00 | true |
| history-filter-keystroke | 295.76 | true |
| history-plan | 462.33 | true |
| history-start | 162.76 | true |
| history-add-note | 184.02 | true |
| history-approve | 72.47 | true |
| history-fold | 548.36 | true |
| history-viewer-controls | 622.99 | true |

## local-browser-actions

Artifact `2026-11-08T10-29-02.227Z-local-browser-actions.json`. One serial native-browser journey; every action passed its behavioral assertion. Scripted waits, automation and the existing mock delays are included. Single observations establish no percentile. One serial native-browser journey with real Foldkit and product MockFactory; timings include scripted delays and automation. External docs content is not asserted; only the correct pane URL and controls. Touch is dispatched as native synthetic DOM events, not physical hardware. Single observations establish no percentile.

| Action | ms | Correctness passed |
| --- | --- | --- |
| ask-button | 115.27 | true |
| submit-settle-0 | 974.07 | true |
| submit-settle-1 | 901.23 | true |
| submit-settle-2 | 865.27 | true |
| submit-settle-3 | 911.19 | true |
| wheel-pause | 53.96 | true |
| latest | 142.83 | true |
| pause-Home | 350.65 | true |
| pause-PageUp | 205.67 | true |
| pause-ArrowUp | 159.93 | true |
| pause-Control+Home | 308.06 | true |
| pause-Meta+ArrowUp | 124.97 | true |
| new-input-cancels-latest | 392.33 | true |
| touch-pause | 103.06 | true |
| home-expand-minimize | 901.14 | true |
| learn-more-open-docs | 823.70 | true |
| escape-tour | 56.77 | true |
| docs-maximize | 564.09 | true |
| docs-minimize | 248.74 | true |
| escape-docs | 68.92 | true |

## sandbox-browser-actions

Artifact `2026-11-08T10-29-11.626Z-sandbox-browser-actions.json`. One serial native-browser journey; every action passed its behavioral assertion. Scripted waits, automation and the existing mock delays are included. Single observations establish no percentile. One serial real Chromium journey over product mock flows and supported terminal commands; exact retained terminal transcript checked across Stop/Start. No model/backend/real Container. Forced mock roles never grant live authority. Automation and scripted waits included; no percentile.

| Action | ms | Correctness passed |
| --- | --- | --- |
| sandbox-open-pane | 99.88 | true |
| sandbox-start | 98.81 | true |
| sandbox-terminal-write | 81.02 | true |
| sandbox-stop | 141.24 | true |
| sandbox-restart | 101.29 | true |
| sandbox-read-retained-bytes | 116.73 | true |
| sandbox-maximize | 84.86 | true |
| sandbox-minimize | 53.94 | true |
| sandbox-escape | 20.47 | true |
| sandbox-viewer-controls | 773.83 | true |

## Regression gate

`bench/baseline.json` fixes an exact nine-case roster of actual indexed entry reads for decide/apply/receive at 10/1,000/100,000 entries. At most 5% more work, rounded up; zero stays zero. Each output preserves the complete prefix, new post and pending confirmation. Missing-roster and beyond-tolerance controls both fail. Timing values never update the baseline automatically. This work gate detects entry-scan regressions; it does not gate CPU instruction cost or network latency.

## Findings

- Full transcript scene rendering has no virtualization; vnode construction, serialization and correctness queries take seconds at 100,000 entries. `web-100000/view`: 5219.698ms mean, 3 samples; `2026-11-08T10-29-37.579Z-web-100000.json`. Its method and limitations are recorded above.
- The epic list is paged, but this worst-case fixture has every commit planned; its separate Planned list still scales with the entire outline. `history-web-100000/history-open-epic-view`: 20103.119ms mean, 3 samples; `2026-11-08T10-28-20.650Z-history-web-100000.json`. Its method and limitations are recorded above.
- Full snapshot schema decode and complete equality assertion cost remains substantial. `protocol/snapshot-decode-100000`: 529.027ms mean, 5 samples; `2026-11-08T10-29-46.669Z-protocol.json`. Its method and limitations are recorded above.
- Cold CLI startup dominates a small read. `cli/--mock read --json`: 11551.675ms mean, 3 samples; `2026-11-08T10-22-37.834Z-cli.json`. Its method and limitations are recorded above.
- Cold MCP startup/initialize/discovery dominates a small call. `mcp/mcp-read`: 6644.726ms mean, 3 samples; `2026-11-08T10-23-11.094Z-mcp.json`. Its method and limitations are recorded above.
- Persistent-session MCP removes cold startup from the timed boundary. `mcp-warm/mcp-warm-read`: 51.014ms mean, 5 samples; `2026-11-08T10-24-30.010Z-mcp-warm.json`. Its method and limitations are recorded above.
- This includes five real reading holds, with deterministic inference; it is intentional presentation time, not pure CPU overhead. `workerd/workerd-tour`: 24802.274ms mean, 3 samples; `2026-11-08T10-21-04.992Z-workerd.json`. Its method and limitations are recorded above.
- Strengthened the recovered-history benchmark with literal event payloads and intermediate amendment/start snapshots: fold clears task/lane, so final-state equality alone could miss corruption.
- Fixed the native page-key/Latest race and kept Ctrl+Home/Meta+ArrowUp in the synchronous follow veto; the native benchmark checks actual position, pause and resumption. Hosts without a Document retain repeated reports.
- Fixed the production site Worker’s `/history` and nested-route 404, demonstrated by a real file/HTTP-backed failing benchmark and Worker regression.
- The tour browser test now observes real rendered stop/narration snapshots before asynchronous geometry work, retaining exact five-stop order and final state. The independently landed product pacing changes are preserved.
- Fixed a unit test’s invalid global person/reply interleaving assumption; it now verifies person order, complete correlated answers, contiguous events and serialized reply starts/finishes. The actual product interleaving is unchanged.
- Existing clocked backend tests preload the real mock compiler before advancing test time (landed commit 0809c07d959c4c47dd2be728800abc7189109db6).

## Benchmark-only coverage

`pnpm bench:coverage` runs only the same benchmark workloads, once each, with the coverage lane’s patched V8 5.0.0 provider and matching Vitest. No unit/fuzz suite is imported. Strict 100% per-file thresholds remain red. Scope is all `src/`, `worker/`, `infra/` and `scripts/`; generated bundler bootstrap is excluded for the reason in 0017, with no production exclusion.

**These are diagnostic measurements, not 100% verified execution coverage.** Chromium’s retained source-range negative control (0016) credits an unexecuted return after bundling; workerd’s precise V8 profiler is unsupported and its execution remains uncredited by the parent Node collector. Changing VibeLang compilation or its source-map behavior requires Will’s prior decision; this lane makes no such change. Main’s coverage-provider end-column merge fix is reused without changing product compilation. No workaround or fictitious worker hits are used. Source coverage still needs additional benchmark paths as well as trustworthy collection. Raw per-file counters, original uncovered lines and command exits are archived with the report.

| File | Covered / executable lines | Diagnostic percent |
| --- | --- | --- |
| total (expanded scope) | 2675 / 3575 | 74.82% |
| infra/SandboxImage.vibe | 0 / 2 | 0% |
| infra/Stack.vibe | 8 / 8 | 100% |
| infra/WorkerBuild.vibe | 1 / 1 | 100% |
| scripts/agent-context.vibe | 0 / 22 | 0% |
| scripts/mythical-seed.vibe | 0 / 51 | 0% |
| src/core/Factory.vibe | 4 / 4 | 100% |
| src/core/LiveFactory.vibe | 72 / 74 | 97.29% |
| src/core/MockFactory.vibe | 154 / 160 | 96.25% |
| src/core/conversation.vibe | 121 / 161 | 75.15% |
| src/core/flowDecision.vibe | 6 / 7 | 85.71% |
| src/core/flows.vibe | 108 / 120 | 90% |
| src/core/mockDecision.vibe | 10 / 11 | 90.9% |
| src/core/mockReplies.vibe | 20 / 20 | 100% |
| src/core/protocolDecision.vibe | 14 / 14 | 100% |
| src/core/sandboxDecision.vibe | 54 / 55 | 98.18% |
| src/core/sandboxHost.vibe | 147 / 183 | 80.32% |
| src/core/sandboxMeter.vibe | 31 / 32 | 96.87% |
| src/core/sandboxMock.vibe | 45 / 50 | 90% |
| src/core/sandboxPolicy.vibe | 3 / 5 | 60% |
| src/core/schemas.vibe | 20 / 20 | 100% |
| src/core/sequenceDecision.vibe | 20 / 20 | 100% |
| src/core/wire.vibe | 21 / 21 | 100% |
| src/history/LiveMythical.vibe | 38 / 40 | 95% |
| src/history/MockMythical.vibe | 45 / 49 | 91.83% |
| src/history/MythicalHistory.vibe | 3 / 3 | 100% |
| src/history/Sequencer.vibe | 100 / 108 | 92.59% |
| src/history/flowMachine.vibe | 27 / 28 | 96.42% |
| src/history/flows.vibe | 74 / 87 | 85.05% |
| src/history/mythical.vibe | 129 / 133 | 96.99% |
| src/history/pages.vibe | 36 / 42 | 85.71% |
| src/history/roles.vibe | 6 / 7 | 85.71% |
| src/history/schemas.vibe | 31 / 32 | 96.87% |
| src/history/seed.vibe | 166 / 172 | 96.51% |
| src/history/tools.vibe | 28 / 30 | 93.33% |
| src/history/wire.vibe | 35 / 35 | 100% |
| src/history/seed/vibelang.vibe | 2 / 2 | 100% |
| src/surfaces/backend.vibe | 10 / 13 | 76.92% |
| src/surfaces/cli-entry.vibe | 8 / 8 | 100% |
| src/surfaces/cli.vibe | 16 / 16 | 100% |
| src/surfaces/commandDecision.vibe | 9 / 9 | 100% |
| src/surfaces/commands.vibe | 92 / 108 | 85.18% |
| src/surfaces/manifest.vibe | 4 / 4 | 100% |
| src/surfaces/mcp-entry.vibe | 6 / 6 | 100% |
| src/surfaces/mcp.vibe | 14 / 14 | 100% |
| src/web/backend.vibe | 35 / 38 | 92.1% |
| src/web/entry.vibe | 6 / 8 | 75% |
| src/web/historyApp.vibe | 101 / 166 | 60.84% |
| src/web/historyBackend.vibe | 23 / 26 | 88.46% |
| src/web/historyStartup.vibe | 25 / 25 | 100% |
| src/web/historyView.vibe | 49 / 91 | 53.84% |
| src/web/main.vibe | 173 / 198 | 87.37% |
| src/web/markdown.vibe | 27 / 27 | 100% |
| src/web/sandboxView.vibe | 14 / 17 | 82.35% |
| src/web/screenDecision.vibe | 28 / 30 | 93.33% |
| src/web/startup.vibe | 28 / 29 | 96.55% |
| src/web/styles.vibe | 1 / 1 | 100% |
| src/web/view.vibe | 47 / 47 | 100% |
| src/web/viewport.vibe | 49 / 50 | 98% |
| worker/AgentModel.vibe | 9 / 9 | 100% |
| worker/Api.vibe | 23 / 91 | 25.27% |
| worker/Budget.vibe | 20 / 22 | 90.9% |
| worker/HistoryObject.vibe | 5 / 60 | 8.33% |
| worker/HistoryTools.vibe | 8 / 8 | 100% |
| worker/Http.vibe | 51 / 66 | 77.27% |
| worker/MainLog.vibe | 29 / 43 | 67.44% |
| worker/ObjectStorage.vibe | 1 / 10 | 10% |
| worker/Objects.vibe | 3 / 72 | 4.16% |
| worker/Reply.vibe | 33 / 103 | 32.03% |
| worker/SandboxAccounts.vibe | 6 / 60 | 10% |
| worker/SandboxHttp.vibe | 4 / 30 | 13.33% |
| worker/SandboxMachine.vibe | 1 / 66 | 1.51% |
| worker/SandboxTools.vibe | 8 / 11 | 72.72% |
| worker/Sandboxes.vibe | 0 / 22 | 0% |
| worker/Sequencer.vibe | 99 / 100 | 99% |
| worker/Tour.vibe | 6 / 37 | 16.21% |
| worker/Unreachable.vibe | 1 / 1 | 100% |
| worker/agentContext.vibe | 1 / 1 | 100% |
| worker/budgetDecision.vibe | 4 / 4 | 100% |
| worker/index.vibe | 12 / 12 | 100% |
| worker/replyReasons.vibe | 7 / 7 | 100% |
