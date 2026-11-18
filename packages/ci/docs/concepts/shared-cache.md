---
title: "The shared cache"
description: "How smithers-ci reuses target results across runs and machines through a Smithers build remote cache, and what it never stores."
---

A target's result is stored under its content key. When a later run plans the
same target with the same key, it takes the stored result, a cache hit, instead
of running the target again. An equal key means an equal verdict.

Without a shared cache, results stay on the machine that produced them. With
one, every machine and every run that points at it reuses them.

## Use a shared cache

Pass the cache's URL with `--cache`:

```sh
bunx smithers-ci --cache https://cache.example.com
bunx smithers-ci replay --cache https://cache.example.com
bunx smithers-ci apply --cache https://cache.example.com
```

`smithers-ci`, `replay` and `apply` accept it. The cache speaks the Smithers
build remote cache protocol: `/ac` for results and `/cas` for file contents,
over HTTP. See [Remote caching](../../../smithers/build/docs/workspace/remote-caching.md)
for the protocol and its read and write credentials.

## What the cache never holds

- **A fast-mode skip.** A target fast mode skipped did not run, so it has no
  result to store. It is never written to the cache and never becomes a cache
  hit.
- **A secret's value.** Smithers CI records the secrets a CI step uses by name
  only.

## Across machines

One run can be divided across machines. Every machine computes the same plan
and takes the targets whose label hashes to its index, so the machines agree
on the split without talking to each other. A machine runs its own targets and
any dependency that is not already a cache hit. Machines share results only
through the cache.

## See also

- [How it works](how-it-works.md)
- [Caching in Smithers build](../../../smithers/build/docs/workspace/caching.md)
