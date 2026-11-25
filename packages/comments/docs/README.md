---
title: "Smithers Comments Documentation"
description: "Keep code comments accurate inline, or store them in .comments/ and generate commented virtual files with Smithers workflows."
---

# Smithers Comments

Smithers Comments is an agentic workflow for managing code comments, built on [Smithers](https://github.com/smithersai/smithers).

It runs in two modes:

- **Inline mode** keeps comments inside your source files and validates them structurally and semantically on every run, caching unchanged comments so model checks run only when a comment or the code beneath it changes.
- **External mode** stores prose comments outside your source files in `.comments/` (or any folder you configure), keeps compiler and linter pragmas in code, and projects commented files on demand through Smithers virtual files and workflows.

## Start here

- [Quickstart](./getting-started/quickstart.md) — validate inline comments, extract to `.comments/`, and render virtual files in five minutes.
- [Splash Page](./splash/index.html) — one-page product overview.

## Concepts

- [Inline and External Modes](./concepts/modes.md) — choosing a mode, pragma preservation, and switching between modes.
- [External Sidecar Format](./concepts/sidecar-format.md) — the `.comments/<path>.md` file grammar, anchors, and canonical formatting.
- [Smithers Virtual Files](./concepts/virtual-files.md) — generating commented files via `VirtualFileTree`, `Smithers.Generate`, `Smithers.Overlay`, and `Smithers.Materialize`.
- [Caching and Workflows](./concepts/caching-and-workflows.md) — content-addressed comment keys, durable Smithers flows, and zero-token cache hits.

## Reference

- [CLI Reference](./reference/cli.md) — commands, flags, JSON schemas, and exit codes.
- [Configuration Reference](./reference/config.md) — `.smithers/comments.json` fields, defaults, and supported languages.
- [TypeScript API Reference](./reference/api.md) — programmatic Effect and Smithers target exports.
