<!-- Generated from apps/site/src/data/project.json by apps/site/scripts/generate-project-copy.mjs. -->

<pre align="center">
███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗
██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝
███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗
╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║
███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║
╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝
</pre>

<p align="center"><strong>The codebase maintainer agent</strong></p>

Smithers instruments and automates a code repository so changes get cheaper, faster, and smarter. Agents plan, run, and review changes through flows declared beside the code.

## Open Smithers

Open [the Smithers repository](https://smithers.sh/smithersai/smithers) in your browser.
Explore its files, ask for a task in chat, and inspect runs and changes in the conversation.
The hosted private alpha is free for selected public repositories. Sign in with GitHub
when you are ready to contribute. Follow the [app quickstart](https://smithers.sh/docs/quickstart/).

![The Smithers app with its repository home, featured flows, and conversation.](apps/site/public/images/app/home.png)

For local execution and authoring, use the CLI and libraries described below.

## Supported platforms

The release candidate's required package platform is Linux with Node 22.19.0. macOS and Windows package checks are advisory and do not establish a support guarantee.

Offline Chromium tests cover the included web UI. Packaged desktop and hosted deployments require separate acceptance evidence.

## Install

The 1.0 release candidate is not on npm yet. Use the
[source-checkout installation](https://smithers.sh/docs/installation/#use-the-source-checkout-before-publication)
until publication. After publication, install it with:

```bash
npm install --global @smthrs/cli@next
```

## Get started

Run these commands from your project directory. Before launching, edit the
scaffolded flow and configure the credential its `model:` field requires.
The [CLI quickstart](https://smithers.sh/docs/cli-quickstart/) covers each step.

```bash
smthrs init change
smthrs up change
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
