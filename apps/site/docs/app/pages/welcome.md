---
title: "Welcome to Smithers"
summary: "What Smithers is, and the two ways to use it."
---

Automate maintaining your codebase with Smithers. On smithers.sh, you open a repository at the path it has on GitHub and read it. On your own Mac, the `smthrs` CLI runs a coding agent on your project on your own subscription.

![The smithers.sh home page with Get started for free](images/welcome-home.webp)

## How Smithers relates to GitHub

GitHub keeps your repository's `main`, issues, pull requests, reviews and checks. Smithers reads them and adds its own layer. A person merges every change. Agents never approve or merge.

Every action in Smithers is a flow: a typed, durable program. A button, a slash command and an agent call all run the same flow. A repository can change its flows by committing files under `.smithers/flows/`. See [What a flow is](flows.md).

## Two ways to use Smithers

| | smithers.sh | Your own Mac |
| --- | --- | --- |
| Where it runs | Hosted at smithers.sh | On your Mac, with the `smthrs` CLI |
| Sign in | With GitHub | Not needed for the CLI |
| Start here | [Quickstart](quickstart.md) | [Run agents on your Mac](local-quickstart.md) |

## Next steps

- [Quickstart](quickstart.md): open a repository on smithers.sh and sign in with GitHub.
- [Run agents on your Mac](local-quickstart.md): have a coding agent change a project on your own Codex subscription.
- [What a flow is](flows.md): how Smithers' actions are built, and how to change them.
