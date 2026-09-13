---
title: "Scorer identity"
description: "How a scorer key is derived from the declaration alone, why the score function is not part of it, and why a configuration canonical JSON would lose is refused."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/scorers/docs/concepts/scorer-identity.md"
---

Every observation this package stores carries a `scorerKey`. It is the answer
to one question a reader asks months later: which grader produced this number?
Getting that answer right is the reason a scorer is a declaration and not just
a function.

## The key is the declaration, hashed

`Scorer.make` derives the key from three fields and nothing else:

```text
scorerKey = sha256(canonical({ id, version, config: config ?? null }))
```

`canonical` is the canonical JSON encoder from [`@smthrs/core`](https://core.smithers.sh/reference/api/), so
key order does not matter: `{b: 2, a: 1}` and `{a: 1, b: 2}` hash identically.
The result is 64 lowercase hex characters. A fixed declaration produces a fixed
key forever, and a golden key freezes that, so a change to canonicalization or
hashing fails a test rather than silently starting a second identity for the
same scorer.

Three consequences follow directly:

- **Refactoring `score` does not move the key.** The function body is not
  hashed. Rewriting the implementation, renaming a local, or extracting a
  helper leaves every stored observation attributable.
- **Changing behavior requires changing `version`.** Nothing detects a
  behavioral change for you. When a scorer starts grading differently, bump
  `version` so the new numbers land under a new key and the old ones stay
  comparable among themselves.
- **`config` is part of the contract.** A rubric string, a threshold, or a
  judge model id belongs in `config`, where it changes the key. The same
  scorer at two thresholds is two scorer keys, which is what makes the two
  score histories separable.

## A scorer declares, it does not implement a flow body

`Scorer.Scorer` extends `Flow.Flow` with a fixed input schema
(`Scorer.Input`) and a fixed output schema (`Scorer.Result`), so a caller can
read the contract off the value. Its `MakeOptions` omits `input`, `output`,
`body`, `model`, and `flows`: the schemas are owned by this module, and `score`
is the single implementation. `Scorer.make` rejects `body` and the dynamic-body
options `model` and `flows` with `ScorerError` code `invalid_declaration`, even
when their value is `undefined`.

That omission is deliberate. A scorer that could declare both a `body` and a
`score` could declare two implementations that disagree, and nothing downstream
would know which one produced a given observation. Calling the flow value
itself raises `FlowError` with code `missing_body`, as any body-less flow does.
Run a scorer through `scorer.score(input)`, or hand it to a
[`Runner`](/guides/run-a-batch-of-scorers/).

## Why a lossy configuration is refused

Canonical JSON mirrors `JSON.stringify`: a function, a symbol, an explicit
`undefined` member, a symbol-keyed property, a `bigint`, or a non-finite number
disappears before the hash is taken. If `Scorer.make` accepted those,
`{rubric: fn}` and `{}` would be one scorer forever, and every observation
under that key would be unattributable.

So `make` refuses instead, throwing a `ScorerError` with code
`invalid_declaration` at plan time. It reports a path, never the value, so a
declaration failure cannot leak a configuration into an error message:

```text
A scorer configuration must be representable as canonical JSON: config.nested.deep[1] is function
```

A `toJSON` member, a `Date` included, is refused for a related reason. Canonical
JSON hashes what `toJSON` returns, so anything the replacement loses is absent
from the identity. Calling `toJSON` here to inspect the replacement would run
caller code a second time with no promise that the two calls agree, and refusal
is the only decidable answer. The full list of refusals is in the
[API reference](/reference/api/#a-scorer-is-a-declaration-not-a-flow-body) and in
[Declare a scorer](/guides/declare-a-scorer/).

## The identity a scorer key does not cover

`scorerKey` covers `{id, version, config}` and nothing more. In particular it
says nothing about the `context` and `groundTruth` a
[binding](/guides/attach-a-scorer-to-a-flow/) supplies, which are retained
by reference and can change between binding and scoring. A durable record gives
no way to notice that difference, so pass values that do not change, or copy
before binding.
