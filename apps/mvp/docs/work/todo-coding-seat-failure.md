---
title: Show why TODO coding cannot start
status: done
area: todos
owner: codex-todo-route
updated: 2026-11-27
links:
  - ../decisions/0132-model-connections.md
---

One hosted attempt failed during coding-route selection in five seconds. The engine journal recorded `NoSeat`. The writer saved `implement`, so the stack displayed “Implementation failed.” No runner job had started.

The stack’s existing writer preserves `no_seat` from both the durable route selection and a typed model `no_route` after admission. The failure event reads “Coding model unavailable.” Existing generic failures remain valid since they can have other causes. The catalog’s `@smthrs/flow`, `@smthrs/harness` and `@smthrs/model` supply the durable steps and typed errors.

The isolated browser check also caught three loading skeletons on a direct TODO load. The detail now shows its existing sync status until the first authorized shape is ready. The fixture exercises the same retryable failure with its Code Storage binding disabled and verifies the header’s actual `not_configured` receipt.

A compiled Chromium run traced an uncached promise to the repository header’s History contribution. The built-in loader accepted an uncalled factory where the plugin contract requires an Effect. History now exports the Effect and the registry checks that type at compile time. React now loads the named export and its tab through one lazy component, retained outside its Suspense boundary. The host continues to share each plugin’s chunk and tab.

Two consecutive local Chromium Stack runs showed the recorded cause, Retry and History, survived reload, and passed the console and accessibility checks. A compiled app build also passed the cold-load and reload regression against the isolated ChatApi and Electric. All 248 checks in the combined suite and all five app typecheck projects passed. The integration test adds an eligible coding connection after a failed attempt and retries through the stack writer.
