---
title: Production proof of branch sharing and coediting
status: blocked
area: app
owner: Codex GPT-6 Astra (e2e-sharing)
updated: 2026-11-04
links: [branch-sharing.md, branch-coediting.md, production-e2e.md, ../features/branch-workspace.md, ../features/coedit.md, ../decisions/0161-production-sharing-identities.md]
---

Production sharing is not proved. The real deployment run passed six setup checks and blocked all three two/three-person journeys for missing `sharingPeople`; the runner exited 1. A single account on two devices is not acceptance evidence.

The harness now accepts separately provisioned real test sessions, verifies live identities and repository roles, preserves explicit WebKit identity, and checks model readiness before composer journeys. Tests use dedicated scratch branches, direct API authorization probes and independent sockets across revocation. Cleanup settles the asker's questions before revocation and attempts known revocations even when Electric discovery fails. Local developer identities retain their existing local-only restriction.

Every saved identity under `~/.smithers-e2e` names `codeplanesmithers`. The QA and audit test browser profiles are signed out of GitHub. TEST-6 approved another account; the decision queue assigns creation to Will, with no subsequent username/session receipt found.

To unblock: provision another real test account with Member access on the scratch repository, and a separate Guest identity there for the existing three-person role-ceiling journey. Each Member who uses the composer needs a saved and tested model. Configure the explicit logins and private app-session paths described in [the e2e setup](../../e2e/README.md#distinct-people), then run the production sharing/coediting specs. No permission widening, role changes or deployment was performed by this lane.
