---
title: VibeLang desktop host
status: done
area: vibelang
owner: Codex vl-desktop
updated: 2026-11-08
links:
  - apps/vibelang/wiki/decisions/0025-desktop.md
---

Roadmap brick 7 runs the shared Foldkit app in Electrobun. Local models are injected loopback OpenAI-compatible
services; selected folders use confined Bun host services. Model calls, settings and edits use the local SQLite
flow engine. Mock needs no model or backend. The supplied design archive and ruling departures are in decision 0025.

Linux evidence: 20 desktop units, ten real native cases, five marked policy functions with ten verified Dafny
obligations and five negative controls. The Bun SDK wrapper has 141 passing tests, one skip and 100% of all four V8
coverage metrics; its native APIs run in a real Electrobun fixture. Browser screenshots and full command receipts
are in the lane report. These counts do not claim whole-app benchmark, fuzz or proof coverage.

Astra's final review found no actionable findings. Fable could not run: the collaboration provider lacks the model
and the installed Claude CLI is signed out. Mac build/signing and native smoke-test commands are in the desktop README;
no Mac artifact or deployment is claimed.
