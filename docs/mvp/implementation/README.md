# Application captures

Captured on 2026-09-16 from the actual Vite application bundle in the shared MVP working copy, based on main `7bf6c1167dc4`. The pending MVP changes are included; that base revision alone does not reproduce these screens.

Run from `apps/app`: `pnpm exec playwright test e2e/playwright/repository-setup.spec.ts --project=chromium --workers=1`. The recorded run passed all six scenarios in 24.6 seconds. Its raw log is [browser-results.txt](browser-results.txt).

The separate [frontend verification record](verification.md) preserves the final suite, isolated timeout recheck, typecheck and transport results.

| Capture | Exercised behavior |
| --- | --- |
| [Mobile prompt](setup-preview-320.png) | Five starting actions, signed-out preview without setup requests, 320px form bounds, drawer close on same-repository selection, focus return, fast typing and SQLite reload. |
| [Chat](setup-composer.png) | One top composer, transparent surrounding layer, retained draft, keyboard/outside close and focus return. |
| [Manual work](setup-manual-work.png) | Required current eval/trial before activation, explicit source/issue/prompt, immediately queued edits included in Run, separate observed wrapper/job IDs. |
| [Paused evals](setup-paused-evals.png) | Pause advances the candidate revision; old results remain inspectable, and new passing evals still require a matching live trial. |
| [CI trial](setup-ci-trial.png) | Trial requires a selected PR source and number; queued edits produce the exact reviewed trial input. |
| [PR review trial](setup-review-trial.png) | The independent review setup uses the same explicit PR selector and execution door. |

The suite also holds setup admission unresolved, verifies Chat stays usable, and shows execution links only after backend responses contain run IDs. Backend identity, repository, setup and Control responses are explicit test fixtures. No model, issue creation, registry activation, host execution or production deployment is proved by this suite. Those gates are tracked in [ENGINEERING.md](../ENGINEERING.md).

These PNGs are unmodified browser captures, separate from the design-only figures in [mockups](../mockups/README.md). The shared HelpBubble still wraps too narrowly at 320px; the setup controls themselves fit.
