---
title: "The Cloudflare Host surface"
description: "What each closed Host service does in a Worker, which ones refuse, and why a refusal is a typed failure rather than a missing service."
---

The durable engine composes over a closed set of host services. `NodeHost`,
`BunHost` and `BrowserHost` provide them on their platforms, and
`CloudflareHost.layer` provides the same tags in a Worker or a Durable Object,
plus `effect/crypto/Digest` and the engine's `OwnerIdentity`:

| Service               | On Cloudflare                                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Crypto`              | WebCrypto (`WebCrypto.layer` from `@smthrs/crypto`): `crypto.getRandomValues` in chunks of at most 65,536 bytes, and `crypto.subtle.digest`.                                |
| `OwnerIdentity`       | `OwnerIdentity.layerWithoutPid`: every owner minted carries a drawn incarnation number and a fresh nonce, never a process id. The engine mints one owner per runtime build. |
| `Path`                | Effect's POSIX path service.                                                                                                                                                |
| `HttpClient`          | Effect's fetch client with `redirect: "manual"`.                                                                                                                            |
| `FileSystem`          | Refuses every call, `exists` included, with a `PermissionDenied` `PlatformError`.                                                                                           |
| `ChildProcessSpawner` | Refuses every spawn with a `NotFound` `PlatformError`.                                                                                                                      |
| `Jj`                  | Refuses every operation with `JjError` code `not_installed`.                                                                                                                |

## Refusing services are present on purpose

A Worker has no filesystem, cannot start a process and has no jj. Leaving the
three tags out would make every program that names them fail to compose, even
one that never calls them. Present and refusing, they let the engine compose and
make a flow that does reach for one meet a typed failure at the call, which it
can catch, rather than a defect at startup.

Each refusal describes itself as `not_installed`. The tags are chosen so that a
caller's ordinary branch does the safe thing:

- The filesystem answers `PermissionDenied`, never `NotFound`. A caller that
  reads `NotFound` as "absent" would go on to create the file, and a guarded
  path must fail closed. `exists` fails rather than answering `false` for the
  same reason.
- The spawner answers `NotFound`, the tag Node and Bun report for a program
  that is not installed, so code that falls back when a tool is missing does so
  here too.

The runtime pairs these with `StepBoundary.layerUnsupported` and
`WorkspaceSandbox.layerUnsupported` from `@smthrs/engine-store`: a step that
declares a file boundary fails its attempt with `unsupported_boundary` before
its body runs. Run file and process work on a sandbox host from
`@smthrs/sandbox` instead.

## The network slot never follows a redirect

`redirect: "manual"` hands a `3xx` back to the caller with its `location`, and
the second origin is not contacted. Following a redirect is the job of
`@smthrs/kernel`'s guarded `HttpClient`, which checks every hop against the
flow's capabilities.

## Randomness is read on demand

Cloudflare refuses to deploy a script that calls `crypto.getRandomValues` while
the module evaluates. Nothing in this package reads randomness at module scope:
`WebCrypto.layer` reads it when a caller asks, and the incarnation number is drawn
when a runtime is built.
