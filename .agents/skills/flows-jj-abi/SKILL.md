---
name: flows-jj-abi
description: Change or verify the flows-jj native/WASM ABI, committed artifact, or reproducibility campaign.
---

# flows-jj ABI

Read [the ABI campaign](../../../crates/flows-jj/ABI_CAMPAIGN.md), [WASM build script](../../../crates/flows-jj/build-wasm.mjs), and [CONTRIBUTING.md](../../../CONTRIBUTING.md) on the revision under test before editing this crate or its committed WASM artifact.

Use a fresh artifact directory for each campaign. The native and committed real-WASM tiers must consume the same deterministic malformed-request corpus; review the reports and hashes, not merely exit status. A smaller local run and an uninstrumented run are narrower evidence than the scheduled campaign and parser ASAN tier. Neither is an exhaustive ABI proof.

The committed WASM bytes have a pinned Rust toolchain and canonical Linux host contract. `node crates/flows-jj/build-wasm.mjs --verify` compares without writing; the script refuses unsupported hosts. Build on the canonical host before committing artifact bytes and run the required gate for the files changed. Retain the seed, case/step counts, artifact hashes, host, and tier status with any reproducibility claim.
