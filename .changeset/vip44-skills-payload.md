---
"@smthrs/targets": minor
---

`Skills.InstallAction` takes the new `Skills.InstallPayload` (library, agents, selection) instead of the target's whole attributes, so its durable payload holds no `Target.Target` reference and has a JSON codec (VIP-44). A target's `deps` still order its graph. The host rule never read `deps`. Uses the library catalog's `@smthrs/flow` entry.
