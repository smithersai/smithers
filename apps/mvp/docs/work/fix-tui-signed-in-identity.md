---
title: TUI signed-in identity
status: done
area: tui
owner: Codex sm-b06
updated: 2026-11-05
links:
  - https://github.com/smithersai/smithers/issues/4385
---

The Smithers panel projects the CLI's existing auth status beside its connection.
It shows a verified username or email, distinguishes signed-out from unknown or
offline, and excludes credential metadata. Authentication is independent of the
repository's factory access and works in app-only directories.

Uses the library catalog's `@smthrs/cli` transport and `smithers-tui` panel host.
This repairs an existing built-in plugin's projection; it adds no feature API,
model call, mutation, or workflow. Rulings SDK-1, SDK-7, GH-4 and OBS-5 apply.

Validation: dedicated behavioral regressions fail on the prior projection;
Effect service failure, real auth transport and terminal wiring are checked.


Validation completed: the new projection initially failed all four regressions;
focused identity/panel/factory checks pass, as do real terminal checks and the
remote TUI typecheck. The projection has 100% function and line coverage.
Astra review found an existing omission of cancellation in the auth handler's
initial credential read; its real-session regression failed before the one-line
fix and passes after. Astra's follow-up found no remaining issues.

The TUI retains its existing public `CloudSession` subpath: importing the root
namespace eagerly loads `node:module`'s `registerHooks`, unavailable in Bun.
No import API or loader behavior is changed by this fix.
