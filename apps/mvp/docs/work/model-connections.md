---
title: Model connections exactly like Amp (AUTH-10)
status: in-progress
area: models
owner: amp-models builder (Claude Opus)
updated: 2026-10-31 15:20 PDT
links: [../decisions/0132-model-connections.md, ../features/personal-model.md, ../rulings.md]
---

Turning a person's single model into Amp-style ordered connections: API key or custom URL, Kimi K3 through Moonshot,
Jev, Claude subscription, Codex subscription. Design and what Amp actually does: decision 0132.

## State

- Backend, Settings and docs are written; decision 0132 records the design and what Amp's link steps do.
- `worker/personal/AgentCli.docker.test.ts` passes on nyc-02 under rootless Podman (`SANDBOX_TEST_ENGINE=podman`,
  `SANDBOX_TEST_HOST_NETWORK=1`, `SANDBOX_TEST_USER=1000:2000`). Those hosts can't map the production person's UID.
- Next: e2e on the Mac mini, the full suite on Latitude, landing, deploy, Fable review.
