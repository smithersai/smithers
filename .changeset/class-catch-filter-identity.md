---
"@smthrs/plan": patch
"@smthrs/flow": patch
"@smthrs/agent": patch
---

Admit `Schema.Class` and `Schema.TaggedError` catch filters under stable callback
validation by identifying Effect's generated class callbacks with the class
nominal identifier and encoded field representation. Schema annotation names
do not replace that nominal identity; unverified rebuilt classes and custom
`Symbol.hasInstance` hooks retain process-local identity. Checks applied to the class
still contribute their own identities. This re-keys class-filter catches once;
let existing runs settle before upgrading or explicitly start a new execution.
Run the agent use-case examples through `Interpreter.layerWithImplementations`
so their tests enforce the same callback policy as durable hosts.

Register `HumanTask.DecodeIdentityError` as a construction bug alongside the
other human-answer errors.
