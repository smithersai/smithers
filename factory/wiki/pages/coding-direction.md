# Mythical coding product contract

This page records intended product behavior from the maintainer's release brief. It is a design contract, not a statement that these features are shipped or fully implemented.

## Intended memory and planning

Coding should begin by gathering relevant memory through workflows, then clarify or push back where the evidence warrants it. Memory should include a clean linear mythical history and a separate wiki. A logical product Change should group small atomic changes; planned file reads and writes should help schedule parallel work.

Native JJ change identities should survive history rewriting, and validation receipts should separately pin the exact JJ commit revision they evaluated. The product should place a thin opinionated grouping over existing JJ capabilities instead of inventing another identity for every atomic change. Human intent and future direction should remain distinct from current behavior.

## Intended three builds and optimistic progress

First, the product should build a disposable proof of concept quickly, save it for feedback and hindsight, and throw away its implementation. Second, it should implement for real: fast checks block immediately, while slow suites and agent reviews run asynchronously as later work proceeds. A correction to earlier ownership should rewrite the earlier change and rebase dependents, invalidating their relevant checks. Third, once validation has passed and the work is marked vibed, it should rebuild the clean final history and deliver it.

Parallel execution should still project one linear mythical history. The UI should make predicted Changes, atomic steps, file ownership and pending validation easy to inspect, with cheap turn explanations for orientation and recursive debugger-like detail for evidence.

## Intended meaning of vibed

Marking work vibed should start final cleanup of changes, notes and plans, and delivery to main according to the project's policy. Additional checks or a canary may run before shipping. Vibed, landed and shipped should remain different recorded states.

## Intended implementation style

Implementation should be an opinionated composition of existing primitives: Effect services, durable flows, build targets, existing JJ infrastructure and the existing embedded UI. Runtime portability is required; a Node sidecar is not an acceptable workaround for a Bun compatibility defect.
