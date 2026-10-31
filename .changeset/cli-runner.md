---
"@smthrs/cli": minor
"@smthrs/agent": patch
---

Adds `smthrs runner`, which attaches a machine to a Smithers host as a runner for external agents.

- `smthrs runner token` writes the runner's token (`0600`) and prints only its SHA-256, for an admin to register.
- `smthrs runner serve --config runner.json` claims jobs over HTTPS and does each one as a durable `runner/Job` on the
  runner's own journal: a jj checkout of the job's repository at its base commit, the agent the job's opaque profile
  maps to, driven over the Agent Client Protocol, and the changed files settled back to the host. Profiles, logins and
  accounts are the runner's own configuration; the host names a profile only.
- A cancel stops the agent's whole process tree, detached tools included, and reports whether any process was left. A
  restarted runner reclaims its jobs and resumes each session from its checkpoint with `session/load`.
- The runner scrubs known secret values and credential shapes from the summary it uploads.

`@smthrs/agent`: `Acp.make` now fails every request still pending when the agent's output ends; it captured the
pending requests when the client was built, so a request in flight when the agent exited never answered.
