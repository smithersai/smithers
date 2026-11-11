---
"@smthrs/capability": minor
"@smthrs/sandbox": minor
"@smthrs/cli": minor
---

Module flows on the `smthrs` host reach the machines `WORKSPACE.ts` declares in `S.Remotes`. `Remotes.Remotes.acquire(remote, session)` from `@smthrs/sandbox` opens a session on a declared remote once the action's ceiling admits the new capability `remote:acquire:<name>`, and the host starts the remote's transport (an `ssh` prefix, an HTTP service) outside the confinement the action's own commands run under. Adding `remote:acquire` to the `Action` union moves the sealed model step key, as earlier actions did: runs already in flight finish on their original revision.
