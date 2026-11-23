# Welcome to Smithers

> What Smithers is, how it layers on GitHub, and where to start.

Automate maintaining your codebase with Smithers. Browse repositories, configure your own models, and collaborate with coding agents at [smithers.sh](https://smithers.sh), or run agents locally on your Mac and subscription with the `smthrs` CLI.

```text
+-----------------------+    reads    +------------------------------+    +---------------------+
| GitHub (Truth)        | ----------> | Smithers Engine              | -> | Hosted: smithers.sh |
| - main (append-only)  |             | .smithers/flows/<name>/      |    | Browse & sign in    |
| - Issues & PRs        | <---------- | [Button] [/cmd] [Agent]      |    +---------------------+
| - People merge        |   draft PR  | All run the same typed flow  | -> | Local: smthrs CLI   |
+-----------------------+             | with durable SQLite journal  |    | Your Mac & Codex    |
                                      +------------------------------+    +---------------------+

HARD TRUST BOUNDARY: Agents propose diffs and receipts. People approve and merge every change.
```

_How Smithers sits beside GitHub, runs typed flows through three doors, and keeps humans as the merge boundary_

## Three rules Smithers enforces

1. **GitHub stays the source of truth.** Your repository's `main` branch, issues, pull requests, and reviews remain on GitHub. Smithers reads them and writes changes back as branches and pull requests.
2. **People merge; agents propose.** An agent writes code, runs tests, and attaches evidence. A person approves and merges every change to `main`. System flows are protected actions and cannot be replaced by personal revisions.
3. **Every action is a durable flow.** A UI button, a chat `/` command, and an agent tool call all invoke the same typed program. Every step is journaled to SQLite, so a crash resumes rather than starts over.

![The smithers.sh home page with Get started for free](https://smithers.sh/images/docs/welcome-home.light.webp)

## Pick your starting point

| If you want to... | Run on | Sign-in required | Start with |
| --- | --- | --- | --- |
| Explore a repo, sign in with GitHub, add your model, and ask Smithers | Hosted at `smithers.sh` | Optional to read; GitHub to act | [Quickstart](https://smithers.sh/docs/quickstart/) |
| Configure personal model keys, spend alerts, or sandbox limits | Hosted at `smithers.sh` | Member / Admin | [Settings](https://smithers.sh/docs/settings/) |
| Have a coding agent edit a local project on your Codex subscription | Your Mac (`smthrs` CLI) | Local Codex login only | [Run agents on your Mac](https://smithers.sh/docs/local-quickstart/) |
| Understand why flows plan before running and survive crashes | Concepts | None | [How durable flows work](https://smithers.sh/docs/durable-flows/) |
| Create and run personal flows or author SDK file flows | Web app & `.smithers/flows/` | Member (web) / None (CLI) | [Flows reference](https://smithers.sh/docs/flows/) |
| Look up every chat `/` command and minimum role | Hosted at `smithers.sh` | Varies by command | [Chat commands](https://smithers.sh/docs/commands/) |
| Configure Cloudflare deployment model and sandbox limits | Operators | Admin / Operator | [Operator configuration](https://smithers.sh/docs/operator/) |
| Install the CLI or read the planned Mac host setup | Local or LAN Mac | None | [Install Smithers](https://smithers.sh/docs/installation/) |
