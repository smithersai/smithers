---
title: Role refusals explain themselves
status: done
area: observability
owner: Codex GPT-6.1 Sol (smithers-ws-sol-503)
updated: 2026-11-02
links: [../observability.md]
---

Record role refusals with their stage, upstream status, retry wait, cooldown source and request ray. Extend the existing github.repo_role outcome record and smithers_github_repo_roles metric; keep route admission and read behavior unchanged. Return x-smithers-ray on API errors and retain each undeclared e2e failure's body code and ray without bodies or credentials.

Library catalog: @smthrs/observability structured Effect logs and @smthrs/integrations GitHub failure classification. No new dependency or runtime.


Implemented: existing role and route outcome records carry finite refusal fields and request rays; error responses return `x-smithers-ray`. Held cooldowns report unknown original upstream status explicitly. No database migration, authorization, response body or read policy changed. Declared e2e lines retain their grouping and shape; undeclared failures retain each code/ray.

Validation: 289 relevant tests passed across Latitude and mini runs (RepoRoles 65, HomeApi 42, StackApi 39, RepoApi 62, GitHub flows 44, RequestRay 2, Problems 34, real HTTP/Chromium watcher 1). Worker and frontend VibeLang typechecks passed. Changed production files passed ESLint with zero warnings. The new request-ray helpers each have executed 100% line, statement, branch and function coverage; this is not a whole-app coverage claim. No production e2e run was invoked.

Astra review found converted refusals losing route metadata and a teardown arrival race; both have regression tests and its follow-up found no remaining findings. Fable review found no blocking issues. Its header-scope note was addressed by limiting response headers to /api/ errors, with a regression; broad request log correlation is intentional and documented.
