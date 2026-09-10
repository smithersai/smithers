# Coding progression and validation

The coding progression graph is a repository recipe made from ordinary `Flow.make`, `Action.make`, and Effect layers. Its policy actions validate a predicted plan and the results returned by registered project flows. The recipe does not create a database, queue, lease, or second event log.

## Predict a linear plan

`Plan` contains a prompt, memory revision, base revision, and ordered Changes. Each Change groups planned atoms and declares implementation and check flows with pinned executable digests. An existing atom uses its native JJ change ID; a planned new atom uses `changeId: null` until implementation supplies a revision. The product Change ID groups work; it is not a replacement identity for every atom.

`Revision` records change, commit, tree, operation, and parent commit IDs. Plan validation rejects duplicate grouping IDs, duplicate check IDs within each Change, and repeated non-null atom IDs. Every Change must declare a required fast check and a required slow check.

## Advance after fast acceptance

Implementation runs first, followed by that Change's fast checks. The fast gate checks the exact supplied parent, a single linear chain of reported atom revisions, retained existing atom IDs, and receipts matching the implemented head. A required fast check must pass before the next Change can begin.

After acceptance, slow checks and the next implementation share a `Node.all` branch. The final assessment checks receipts again and binds findings to an existing owner at or before the reviewed Change and its actual source commit. Its result is `validated` or `changes-requested`. Delivery-tier checks belong to a later stage.

## Delegate through the existing catalog

The catalog adapter resolves the plan's implementation and check flow names through the injected executable registry and compares their pinned definition digests. It invokes the registered project flow with the full input, using an identity derived from that payload and the executable digest. Unavailable, unverified, or changed definitions are refused.

`checkInputDigest` uses the existing canonical digest primitive to bind a check receipt to its delegated implementation and check inputs. This fingerprint cannot prove that a test ran; the delegate must return measured evidence. Host registration supplies the project catalog and action implementations. Within that composition, another flow can use `yield* ImplementPlan.execute({ plan })`.

## Current boundary

This graph validates one implementation pass. The [request lifecycle](coding-request.md) composes memory, two planning passes and a retained disposable POC around the separate [bounded owner correction](coding-correction.md) recipe. It does not itself perform the subsequent correction, restacking, final-history cleanup, vibing, landing, or shipping stages. Project delegates own the actual repository and build operations. The integration test source defines cases for failed fast gates, stale receipts, incorrect parents, overlapping slow review, earlier-owner findings, and child replay after restart. Those fixture definitions are evidence of test coverage intent; this page makes no assertion that a particular test run or deployment passed.
