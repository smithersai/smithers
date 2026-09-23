# Custom agent example

One custom agent, `flows/review/flow.mdx`: a markdown flow whose body is the
agent's prompt and whose frontmatter picks its model, effort and envelope.

```sh
bun run tui apps/tui/examples/custom-agent   # from the repository root
```

Type `/agent review look at the last change`. The tab opens at once and chat
stays usable while the agent runs on GPT-6 Sol under the envelope its
frontmatter declares.
The `metadata.tui` block declares an `alt+r` key; the TUI binds contributed
keys once the UI-ELEMENTS track of `.plans/tui-extensions.md` lands.

`e2e/tui.test.ts` ("custom agents") runs this agent under the replay seat.
