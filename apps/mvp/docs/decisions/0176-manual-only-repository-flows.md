# 0176. Admit repository flows for manual runs independently

A deployment can set `REPO_FLOWS_MANUAL_REPOSITORIES` to additional comma-separated repository names. The default is empty. The manual route still requires the global switch, a repository role of Member or above and a default-branch manual trigger. A retry on a manual-only repository requires a recorded manual event and a current manual declaration, including on a resend. Withdrawing the declaration closes admission for subsequent requests and preserves any already accepted execution.

Pushes, pull requests, schedules and automatic start steps use only the existing `REPO_FLOWS_REPOSITORIES` setting. This lets an operator offer a single manual check without enabling the repository’s automatic jobs. Each admission refusal retains its public code and records its stage in the Worker log and span.

The library catalog supplies `@smthrs/flow` and `@smthrs/sandbox` for the bounded landing check. It uses the same numbering and migration-registration checks as landing.
