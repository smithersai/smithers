---
title: "How a grant decision is made"
description: "The order GrantStore.check consults authority in: the fiber ceiling, four rulesets under last-match-wins, the ask default, and what an attended and an unattended store each do with ask."
sidebar:
  order: 2
---

Every decorated host operation ends in one call: `grants.check(capability)`.
That call either returns void, in which case the operation proceeds, or fails
with a typed permission error. Everything the kernel decides happens inside
it, in a fixed order.

## The order of the check

1. **Is the store open?** A closed store fails every check with
   `store_closed`. Closing a store also rejects every request already parked
   on it, so no waiter is stranded.
2. **Is the capability inside the fiber's ceiling?** `CapabilitySet` is the
   ambient authority of the current fiber. A capability outside it fails
   immediately with `permission_denied` and the reason
   `"outside capability ceiling"`. No rule and no operator can override the
   ceiling.
3. **What do the rules say?** `Permission.evaluate` reduces four rulesets into
   `allow`, `deny`, or `ask`.
4. **`allow` proceeds. `deny` fails** with `permission_denied` and the reason
   `"denied by permission policy"`.
5. **`ask` depends on who is there.** An unattended store fails with
   `permission_required`, carrying the request id, the capability, its effect
   tier, and the display metadata. An attended store parks the fiber on a
   pending request and waits for a reply.

The default decision is `ask`, so a capability no rule mentions is never
allowed. What differs between a headless host and an operator-driven one is
only what `ask` becomes.

## The ceiling is monotone

`CapabilitySet` is a normalized conjunction of any-of pattern groups: a
capability is allowed only when every group contains a pattern matching it.
`CapabilitySet.attenuate(patterns)` runs an effect with the parent authority
**intersected** with one more group, which is the only way authority ever
moves. There is no public widening constructor and no unrestricted value, so a
scoped fiber can hand a narrower ceiling to work it delegates and can never
recover what it gave up.

A fiber that never passed through `attenuate` allows every capability, because
unrestricted authority is the identity element of intersection and a
permanently closed default would leave no operation able to widen a fiber
again. The ceiling is not what makes the kernel fail closed. The ruleset is:
its default verdict is `ask`, and an unattended store turns `ask` into a
refusal. The ceiling's job is to bound what a _scoped_ fiber may ask for.

## Four rulesets, last match wins

`GrantStore` evaluates these in order:

| Ruleset    | Where it comes from                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| Configured | `MakeOptions.rules`, or the first ruleset of a nested `rules` value. The operator's written policy.            |
| Envelope   | Patterns activated by `grantEnvelope`, or the construction `envelope`, with run scope.                         |
| Run        | `MakeOptions.runRules` and every `"run"` reply, each remembered alongside the ceiling of the fiber that asked. |
| Remembered | Replayed remembered grants, and every `"remembered"` reply.                                                    |

Matching rules are last-match-wins across all four. The configured ruleset gets
one extra power: after it is reduced by the same last-match rule, an effective
denial is a hard veto that no later ruleset can lift. A configured deny that a
later configured allow or ask supersedes _within that ruleset_ is not a veto,
so an operator can still write an exception after a broad denial.

Run rules carry the ceiling of the fiber that requested them and are filtered
out for any capability that ceiling would not allow. A grant handed to an
attenuated fiber therefore cannot leak back up to a broader one, including after
restart. Each `flows.kernel.grant.run.v2` event persists the normalized captured
ceiling as a conjunction of any-of pattern groups. Replay intersects it with
the constructor's ceiling; reopening under a broader parent cannot widen it.

Trusted legacy `flows.kernel.grant.run.v1` events have no captured ceiling.
The journal store refuses construction with `invalid_resolution` when it finds
one. Their original boundary cannot be recovered, so obtain fresh approval in
a new run instead of replaying legacy authority.

A bare rule in `MakeOptions.runRules` uses the constructor's ceiling. A
`{ rule, ceiling }` entry carries captured pattern groups and intersects them
with that ceiling, as journal replay does.

## The four resolutions

`store.reply(requestId, resolution, pattern?)` takes one of four answers:

| Resolution   | Effect                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `once`       | Authorizes this request alone. Nothing is added to the rules.                                                              |
| `run`        | Adds an allow rule for the rest of the run. Requires a plan digest; without one the reply fails with `invalid_resolution`. |
| `remembered` | Adds an allow rule that a journal-backed store replays into later processes.                                               |
| `deny`       | Fails the parked request with `permission_denied`.                                                                         |

For `run` and `remembered`, the pattern is the caller's if one is supplied and
otherwise derived from the exact capability. A resource containing glob
metacharacters has no unambiguous derived pattern, so the reply fails and says
to supply a pattern explicitly or resolve `once`.

A supplied pattern is checked before it is stored. `isValidGrantPattern`
refuses a pattern that names a different action, reaches a more dangerous
effect tier than the request displayed, or is a wildcard-bearing pattern
identical to the resource: the grammar has no escape, so that pattern's
wildcard reading would silently widen access. The refusal is
`invalid_resolution` with `"grant pattern exceeds the requested authority"`.

Adding a rule wakes every other parked request the new rule now allows, so one
`run` grant for `/workspace/**` resolves the queue behind it rather than
asking again per file.

A reply records its decision in the journal before anything activates, but the
write never holds the store's mutation permit. A slow or dead journal stalls
only the reply that issued it: checks, `list`, waiter cancellation, and store
closure all proceed while a write is stuck, and a write that exceeds
`maximumPersistMillis` (30 seconds) fails the reply with `journal_failed`,
leaving the request parked for a retry. A second reply to the same request
while its decision is mid-write fails fast with `request_not_found` rather
than queueing behind the journal. Envelope admissions follow the same rule,
and a concurrent identical envelope adopts the in-flight outcome instead of
writing a duplicate record.

## Envelope approvals

`grantEnvelope` approves a whole set of patterns at once, which is what a plan
approval is: the operator says yes to everything the plan declared, before it
starts. An envelope is a **set**, so `canonicalEnvelopePatterns` deduplicates
its predicates and sorts them by formatted identity, and `envelopeSignature`
computes `sha256:` followed by the 64 lowercase hexadecimal digits of the
SHA-256 digest of that canonical JSON encoding (plan digest, scope, sorted
formatted predicates). Existing v1 journal events keep their format: replay
recomputes the digest from their fields. Legacy full-JSON signature seeds are
normalized to the same digest before comparison.
Two approvals listing the same predicates in a different order are the same
approval, and the second one is a no-op rather than a second durable record.

Envelope patterns are checked by `isValidEnvelopePattern`, which preserves
exact action and filesystem effect-tier boundaries, so an envelope cannot turn
a read approval into a write one.

## Bounds are part of the contract

One store retains at most 1,024 policy rules across all four rulesets, 1,024
activated envelope signatures, 256 patterns per envelope, and 1,024 parked
requests. Metadata is limited to 16 levels of nesting, 1,024 members, and
64 KiB of canonical JSON, and one encoded event to 256 KiB. Run, plan,
and request identities are limited to 4,096 UTF-16 code units. Generated
envelope signatures occupy 71 ASCII characters; legacy signature seeds must
fit the 256 KiB event bound before normalization. Other supplied signature
identities retain the 4,096-unit limit. Capability resources share the
capability package's own 4,096-unit limit.

Construction and runtime envelopes use the same admission check. Incoming
canonical patterns count toward the combined rule ceiling; rules already
replayed for the same envelope are counted once. Journal reconstruction uses
this admission check before appending a construction envelope.

Every bound failure is `invalid_resolution` and happens **before** any state
or journal authority changes, so a refused write never half-applies. The
constants are exported (`GrantStore.maximumRules` and its siblings) so a host
can check against the same numbers rather than guessing them.

## Identity is exact text

Capability actions and resources, patterns, run ids, plan digests, request
ids, and grant metadata are identity-bearing values. Smithers validates
well-formed text but does not apply Unicode normalization: matching,
signatures, and journal replay all use the exact JavaScript string and its
UTF-16 code-unit sequence. A caller that wants NFC applies it before
constructing the value. Identity fields whose contract forbids it reject lone
surrogates and NUL.

## Related

- [Write a capability policy](../guides/write-a-capability-policy.md): rules
  and ceilings in practice.
- [Answer permission requests](../guides/answer-permission-requests.md): the
  attended surface.
- [The authorization model](/pkg/capability/concepts/authorization-model): the
  vocabulary and the evaluation function this page drives.
