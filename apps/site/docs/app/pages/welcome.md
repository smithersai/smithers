---
title: "Welcome to Smithers"
summary: "What Smithers is, how it layers on GitHub, and where to start."
---

Automate maintaining your codebase with Smithers. Browse repositories, configure your own models, and collaborate with coding agents at [smithers.sh](https://smithers.sh), or run agents locally on your Mac and subscription with the `smthrs` CLI.

![How Smithers sits beside GitHub, runs typed flows through three doors, and keeps humans as the merge boundary](diagrams/smithers-overview.svg)

## Three rules Smithers enforces

1. **GitHub stays the source of truth.** Your repository's `main` branch, issues, pull requests, and reviews remain on GitHub. Smithers reads them and writes changes back as branches and pull requests.
2. **People merge; agents propose.** An agent writes code, runs tests, and attaches evidence. A person approves and merges every change to `main`. System flows are protected actions and cannot be replaced by personal revisions.
3. **Every action is a durable flow.** A UI button, a chat `/` command, and an agent tool call all invoke the same typed program. Every step is journaled to SQLite, so a crash resumes rather than starts over.

![The smithers.sh home page with Get started for free](images/welcome-home.webp)

## Pick your starting point

| If you want to... | Run on | Sign-in required | Start with |
| --- | --- | --- | --- |
| Explore a repo, sign in with GitHub, add your model, and ask Smithers | Hosted at `smithers.sh` | Optional to read; GitHub to act | [Quickstart](quickstart.md) |
| Configure personal model keys, spend alerts, or sandbox limits | Hosted at `smithers.sh` | Member / Admin | [Settings](settings.md) |
| Have a coding agent edit a local project on your Codex subscription | Your Mac (`smthrs` CLI) | Local Codex login only | [Run agents on your Mac](local-quickstart.md) |
| Understand why flows plan before running and survive crashes | Concepts | None | [How durable flows work](durable-flows.md) |
| Create and run personal flows or author SDK file flows | Web app & `.smithers/flows/` | Member (web) / None (CLI) | [Flows reference](flows.md) |
| Look up every chat `/` command and minimum role | Hosted at `smithers.sh` | Varies by command | [Chat commands](commands.md) |
| Configure Cloudflare deployment model and sandbox limits | Operators | Admin / Operator | [Operator configuration](operator.md) |
| Install the CLI or read the planned Mac host setup | Local or LAN Mac | None | [Install Smithers](https://smithers.sh/docs/installation/) |
