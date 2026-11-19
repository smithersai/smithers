---
"@smthrs/build-infra": patch
---

Deploy-state redaction reads every Alchemy state file of the stage being deployed, so the sandbox Worker's raw `SANDBOX_TOKEN` in `SandboxWorker.json` is replaced before the state is published. It no longer reads other stages: their verifiers derive from tokens the deploying shell does not hold, and the wrapper used to overwrite them with the redaction placeholder. A redacted value (`{"__redacted__": …}`) under any name but the four credential bindings now fails the publish instead of reaching R2 in clear, and an empty or truncated state file is refused with its path and the remedy. The wrapper refuses a stage named twice or a stage name Alchemy would refuse, before it touches any state.
