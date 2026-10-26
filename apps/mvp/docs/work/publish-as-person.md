---
title: Publish as the person
status: done
area: github
owner: codex-publish-as-person
updated: 2026-10-26
links: [../features/branch-publish.md]
---

Guard a person's Publish against a session credential that acts as the App. Verify the GitHub identity before writing; refuse sign_in_required and retain refresh handling. Use the catalog entries @smthrs/integrations and @smthrs/flow.

Cause: Publish/Update execute the compiled branch-operation subflow as a nested run. RunCredentials minted it a flow credential, and github/Api classifies every credential-backed write as the agent's (App). Preserve the session only for those exact compiled parent/child flows, only when the parent itself used a session; agents and unrelated nested flows retain credentials.

Defense: verify the opened session credential with GitHub /user and the actor's numeric account id before any branch write. Missing, rejected, wrong-account and bot credentials refuse sign_in_required. The existing durable refresh remains the only token redeemer.

Validation: Latitude typecheck, importRules and lint passed; 163 focused tests passed with 100% statements, branches, functions and lines in Publish.ts and credentials.ts. Original-code regressions fail for credential/session identity and misbound tokens. E2E now checks commit and PR author; no production requests or deployment were made. Standard Astra/Fable review remains for the lander: the local smthrs launcher fails loading the missing devalue package.
