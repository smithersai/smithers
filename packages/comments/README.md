# smithers-comments

Agentic comment workflows powered by [Smithers](https://github.com/smithersai/smithers).

`smithers-comments` keeps codebase comments accurate and incremental across two modes:

1. **Inline mode** — comments live in your source files; Smithers continuously lints structure, verifies symbol references, and runs cached agent validation only on comments whose text or anchored code changed.
2. **External mode** — prose comments live outside source code in `.comments/` (or any configured folder); source files stay clean (preserving compiler/linter pragmas), and Smithers virtual files and workflows generate commented files on demand.

## Quickstart

```sh
# Check comments in inline mode (zero config)
bunx smithers-comments check

# Initialize external mode with a custom folder
bunx smithers-comments init --mode external --dir .comments

# Move inline comments into .comments/
bunx smithers-comments extract

# Project source + .comments/ into virtual commented files
bunx smithers-comments render --out .smithers/comments-view
```

## Documentation

- [1-Pager Splash Page](./docs/splash/index.html)
- [Documentation Home](./docs/README.md)
- [Quickstart](./docs/getting-started/quickstart.md)
- [Inline and External Modes](./docs/concepts/modes.md)
- [External Sidecar Format](./docs/concepts/sidecar-format.md)
- [Smithers Virtual Files](./docs/concepts/virtual-files.md)
- [Caching and Workflows](./docs/concepts/caching-and-workflows.md)
- [CLI Reference](./docs/reference/cli.md)
- [Configuration Reference](./docs/reference/config.md)
- [TypeScript API Reference](./docs/reference/api.md)

## License

MIT
