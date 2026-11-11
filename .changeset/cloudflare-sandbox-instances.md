---
"@smthrs/sandbox": minor
---

`CloudflareSandbox.make` sizes machines. Declare the instance types the Worker deployed as `instances`, each with its own Durable Object binding, and `limits.cpus` and `limits.memoryMib` select the smallest one that holds both; `selectInstance` exposes the choice and the instance name prefixes the remote id. `retained: true` keeps the sandbox running after its scope closes and adds `attach` and an idempotent `destroy`, so one Worker request can acquire a machine, later requests attach to it, and a last one destroys it. `binding` keeps working unchanged.
