<!-- Generated from apps/site/src/data/project.json by apps/site/scripts/generate-project-copy.mjs. -->

<pre align="center">
███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗
██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝
███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗
╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║
███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║
╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝
</pre>

<p align="center"><strong>Automate maintaining your codebase</strong></p>

Smithers maintains your codebase. It turns issues into tested changes for you to review and, when enabled, keeps the project wiki current. Flows beside your code define how.

## Fast CI for agents (`smithers-ci`)

Speed up existing GitHub Actions and local test loops with syscall-verified caching (`smthrs-observe`), Lean 4 reference specs, and zero stale passes ([ci.smithers.sh](https://ci.smithers.sh)):

```bash
bunx smithers-ci --commits 5
```

## Open Smithers (`smithers.sh`)

Open [the Smithers repository](https://smithers.sh/smithersai/smithers) in your browser.
Explore files, inspect Uphill continuous metrics, review diffs and runs, fork in one click, or attach your own agent (Claude Code, Codex, Antigravity, Cursor) over BYOA MCP.
Follow the [app quickstart](https://smithers.sh/docs/quickstart/).

For local execution and authoring, use the CLI and libraries described below.

## Supported platforms

Smithers needs Node.js 22.19 or later. The release candidate is certified on Linux with Node 26.4.0. See the [support matrix](https://smithers.sh/docs/reference/support-matrix/).

## Install

The libraries install from npm; start with the
[Flows quickstart](./packages/smithers/flows/docs/quickstart.md). Install the CLI from npm
([Installation](https://smithers.sh/docs/installation/#install-the-cli)):

```bash
npm install -g smthrs@next
```

## Get started

Run these commands from your project directory. Before launching, edit the
scaffolded flow and configure the credential its `model:` field requires.
The [CLI quickstart](https://smithers.sh/docs/cli-quickstart/) covers each step.

```bash
smthrs init change
smthrs flow start change
```

> [!TIP]
> Ask your agent to help you figure out how Smithers can help you and your project, based on everything it knows about you.

## Documentation

Read the [Smithers documentation](https://smithers.sh/docs/) for tutorials, guides, and the full reference. For the top-level build API, keep the [Smithers API cheat sheet](./packages/smithers/build/targets/docs/reference/cheat-sheet.md) handy: one file of TypeScript examples covering the whole `Smithers.*` surface.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, testing, and pull request guidance.

## License

Smithers is MIT licensed. See [LICENSE](./LICENSE) for details.

## Join our community

Join the [Smithers community on Telegram](https://t.me/+ANThR9bHDLAwMjUx).
