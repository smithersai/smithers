---
title: Prove the VibeLang app decisions
status: in-progress
area: vibelang
owner: Codex (vl-proveall)
updated: 2026-11-08
---

Will's VL-29 proof lane: inventory every executable function, extract and prove decisions, reject executable mutations,
and record every tool boundary. [Decision0018](../../../vibelang/wiki/decisions/0018-proofs.md) holds the current
inventory and claims. The app's normal CI includes proof, mutation and inventory gates.

The fifth module batch adds exact conversation/role frames, pending order, mock dispatch selection and stored
event decoding. Its gate covers twelve modules and 435 rejected mutations. Follow-up work covers remaining web
and flow decisions, live dispatch order, history capacity replay, issue acyclicity, and new functionality from other lanes.
The host receipt is `~/vl/vl-proveall.REPORT.md`. No deployment is part of this lane.
