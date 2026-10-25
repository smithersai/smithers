Deployment model tests use the test account's own saved model. Supply `E2E_PERSONAL_MODEL_KEY` securely in the runner environment. Optional settings:

- `E2E_PERSONAL_MODEL_PROTOCOL`: `openai-chat` (default) or `anthropic-messages`.
- `E2E_PERSONAL_MODEL_BASE_URL`: defaults to `https://api.openai.com`.
- `E2E_PERSONAL_MODEL_ID`: defaults to `gpt-4.1-mini`.

The deployment-auth setup saves through Settings' `PUT /api/me/model` and verifies through `POST /api/me/model/test`. A rejected key fails setup before specs run. No deployment or hosted provider credential is used as a fallback. Without the explicit key, `requires("personalModel")` skips answering tests with a reason; `liveModel` also requires this key on deployments. The shared device helper declares `personalModel` before sending questions, including specs that reach it indirectly.

Deployment specs run with one worker because they share an account. Tests that remove or replace the model must disable traces and restore it in `afterEach`, including on failure. Personal-model tests exercise Remove without asking the hosted model afterward. Setup has video and trace disabled; the restoration helper never reports credential-bearing request diagnostics or provider bodies. Never pass keys on a command line or print them.

For a deployment: `BASE_URL=https://your-deployment.example pnpm exec playwright test agent.spec.ts --grep 'ask:'` runs deployment setup first. For collection only: `pnpm exec playwright test --list`. Run the prerequisite regression with `pnpm vitest run e2e/target.test.ts --coverage.enabled=false`.
