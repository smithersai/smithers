---
"@smthrs/harness": minor
---

`@smthrs/harness/Intake` screens an inbound repository event's author text with Jev before any model reads it. `Intake.screen(repo, payload)` asks one batch of questions per text of a GitHub-shaped payload (issue, pull request, comment, author replies): whether it carries instructions aimed at an AI agent, its kind and its urgency. A text at injection probability 0.9 is replaced by `Intake.withheldPlaceholder` on its own, an event whose subject is spam or irrelevant at confidence 0.9 is `ignored`, and any unanswered text, more than 64 texts, or a state over 32 KiB fails the screen as `Intake.Unscreened`.
