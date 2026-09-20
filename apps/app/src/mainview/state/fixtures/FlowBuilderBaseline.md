Recorded from pre-feature `main@origin` at
`16a391284f38ed39ff305ec8adead8f17d48d04a`, and re-recorded unchanged from
pre-feature `main@origin` at `51cf05666542a5e43e2f36247a2c1561b8afbe57` and at
`394ada6a3fb815b4b62cfc7bc2242e238d42ff44`, each time in a jj scratch workspace
created for it and removed afterwards. No revision named here has a
FlowRunGraph import or a flowBuilder feature in AppController.
The capture harness was copied unchanged into that workspace and run with Bun
and `VITE_SMITHERS_FLOW_BUILDER=false`. Workspace package links pointed at the
scratch checkout; external dependencies came from an install of that checkout's
own lockfile. No feature implementation supplied the output.

Both re-recordings are byte-identical to the first. Two hundred and six commits
of `main` moved nothing this fixture measures, so the witness below is the same
file it was, now carrying the revisions it was verified against rather than a
claim that the first still applies.

Inputs: one flow listing, a running trace without events, and the real app
controller's Plan → Approval.Submit → Run path over a deterministic unit-test
transport. The snapshot contains both DOM strings, the resulting run payload,
request bodies, the flow/run registry, and the complete flow/run agent entries.
Only generated request UUIDs are normalized to `<uuid>`. The harness waits for
the durable launch receipt and locates its card by recorded run ID; the
acknowledgment returns before the launch. The prior frozen baseline at
`7e30df62cf786834a26507f05b5d22f377641f20` fails identically on this main and the
integrated tree after main changed the RunTrace surface and launch lifecycle.

To re-record intentionally, copy `FlowBuilderBaseline.tsx` to the same relative
path in a scratch workspace at the desired **pre-feature** revision. Invoke
`captureFlowBuilderBaseline()` there from a Bun test and write its result with
the full commit ID. Never regenerate this fixture from the feature workspace.
