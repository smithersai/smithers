---
"@smthrs/flow": minor
"@smthrs/harness": patch
---

When no declared payload schema explains a recorded plan's uncanonical
payload, it now fails with `InterpreterError` code `uncanonical_payload` at the offending node.
It previously reported `incomplete_graph` at the root. Successful plan
identities and validation on non-recording runtimes are unchanged.

The flow test and typecheck targets now include the engine sources and their
journal dependency in their cache identities.
