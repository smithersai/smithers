# @smthrs/ui

**Documentation:** https://ui.smithers.sh

Shared component library for Smithers UIs: shadcn component anatomy (compound
slots, CVA variant APIs, `asChild`, `data-slot` attributes) and Radix behavior,
styled entirely through theme tokens so every component is correct in light and
dark and honors `prefers-reduced-motion`.

`@smthrs/ui` is `private: true` and workspace-only: `apps/mvp` and
`.smithers/flows/review` consume it through the workspace. npm has only the earlier
0.35.0 release, which these docs do not describe.
Import it by its scoped name, `@smthrs/ui`; the unscoped `smthrs` package
publishes only a deprecation notice whose module throws on import.

Styling ships as CSS-in-TS (`smithersUiCss`) because the bundler this package is
built for drops `.css` imports. Render `<SmithersUiStyles />` once at the root;
every component also self-injects the composed sheet plus its lane CSS fragment
as a fallback. All classes are namespaced `sui-*`.

```tsx
import { Button, SmithersUiStyles, StatusPill } from "@smthrs/ui";
```

## Families

- Base primitives: `Button`, `Badge`, `Card`, `Input`, `Label`, `Alert`,
  `Table`, `Tabs`, `Dialog`, `Tooltip`, `Select`, `Progress`, `Separator`,
  `Skeleton`, `LoadingBar`, `EmptyState`, `SectionHeader`, `RowButton`, `KpiStat`,
  `StageStrip`, `CollapsiblePanel`, `DiffHunks`, `FileTree`, `Markdown`,
  `Kbd`, `SegmentedControl`, `CommandPalette`.
- Conversation: `Message` family, `MessageBranch` family, `Bubble` family,
  `MessageScroller` (drop-in and compound anatomy plus hooks), `CompactGroup`,
  `ConversationCheckpoint`, `ChatMessage`, `ChatTranscript`, `ChatComposer`,
  `Marker`, `Shimmer`.
- Prompt and attachments: `PromptInput` family with
  `usePromptInputAttachments`, and the `Attachment` compound.
- Reasoning and tools: `Reasoning`, `ChainOfThought`, `ToolCall`, `CodeBlock`
  (with header/filename/group/tabs), `AgentOutput`, `MessageResponse`,
  `parseAgentOutput`, `formatPartialJson`.
- Plans, tasks, queues: `Plan` family, `TaskItem`, `AgentTask` family,
  `Queue` family, `ActivityTimeline`.
- Approvals and checkpoints: `Confirmation` family, `ApprovalCard`,
  `Checkpoint` family.
- Sources and citations: `Sources`, `InlineCitation` with card/carousel/quote,
  `Suggestion`, `OpenInChat`.
- Agents and context: `AgentDefinition`, `AgentCard`, `ModelSelector`,
  `ModelBadge`, `ProviderBadge`, `ContextUsage` family.
- Coding artifacts: `Artifact`, `Snippet`, `PackageInfo`, `SchemaDisplay`,
  `StackTrace`, `TestResults`, `Commit`, `ChangeSummary`,
  `EnvironmentVariables`, `SecretField`.
- Sandbox previews: `Sandbox`/`SandboxHeader`/`SandboxStatus`/`SandboxActions`/`SandboxContent`,
  `WebPreview`, `JSXPreview`.
- Web pages: `WebPageView` (an outside page in a sandboxed frame),
  `WebLinkCard` (a card that opens it in a new tab), and their URL guards
  `framedPageTarget` and `webPageTarget`.
- Repository home: `RepositoryHome`, the blocks a repository declares in
  `.smithers/home.json`.
- Lists and item pages as GitHub draws them: `IssuesView` (state icons,
  Open and Closed tabs, a row's `⋯` menu), `ItemConversation` (a state pill,
  a timeline and a side column of `ItemAsideSection`s), `ItemStateIcon`,
  `ActionMenu` and `ConfirmButton`; a TODO's private draft, `TodoDraftCard`.
- Sharing: `AvatarStack` (presence avatars with `+N`) and `ShareDialog`
  (people with access, general access and Copy link).
- Workflow canvas: `WorkflowCanvas` node/edge/controls/panel/toolbar/minimap
  anatomy.
- Vault: `BacklinksPanel`, `OutlineView`, the `wikilinks` and `graphModel`
  helpers, and the `createAutosaveDoc` / `useAutosaveDoc` autosave machine.
- Time: `RelativeTime`, `useRelativeTime`, `formatRelativeTime`.
- Calendar: `Calendar` with month, week, and agenda views.

`ChatTimeline` shows a generated summary when available. Each entry's accessible
name also retains its recorded `label` when different, preserving its object and
outcome; `aria-controls` links to its transcript anchor. Group names stay grouped.

`ItemConversation` and `ItemAsideSection` preserve their generated accessibility and
data attributes when forwarding host props; host IDs, classes and other props
still pass through.

Through 960px, file-close buttons, file-tree controls and item external links
provide at least 32px tap targets.

Heavy renderers stay behind `@smthrs/ui/adapters/*` subpaths so the base barrel
tree-shakes clean: `terminal`, `chart`, `knowledge-graph`.
`tests/barrel-weight.test.ts` is the ratchet that keeps them out of
`src/index.ts`. The repository views (`RepoView`, `CodeFileView`,
`PierreDiffView`, `MarkdownEditor`) live in `@smthrs/repo-view`, and
`TerminalFrame` in `@smthrs/terminal-frame`.

## Documentation

The published site at https://ui.smithers.sh is built from `docs/`.

- [`docs/README.md`](./docs/README.md) - the overview and the family index.
- [`docs/installation.md`](./docs/installation.md) - entry points and peer
  requirements.
- [`docs/quickstart.md`](./docs/quickstart.md) - one surface, end to end.
- [`docs/concepts/`](./docs/concepts/styling.md) - how styling ships, theme
  tokens, component anatomy, and the adapters boundary.
- [`docs/guides/`](./docs/guides/style-a-host-application.md) - task-shaped
  how-tos.
- [`docs/api.md`](./docs/api.md) - every public export.
- [`docs/reference/contracts.md`](./docs/reference/contracts.md) - failure
  codes, resource limits, and the object-URL ownership rule.
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) - symptoms, causes,
  and fixes.
- [`CHANGELOG.md`](./CHANGELOG.md) - release history.

JSDoc on each exported symbol in `src/` is the per-symbol source of truth. The
pages above are hand-written; no generator produces them.
`tests/docs-links.test.ts` is the gate over them: every relative link has to
resolve, and no file in this package may name the unscoped specifier.

## Gates

```sh
pnpm --filter @smthrs/ui test    # bun test tests
pnpm --filter @smthrs/ui run check    # vibelang checks src/ and tests/
```

Both are declared in `PACKAGE.ts` as `//packages/smithers/ui:unitTests` and
`//packages/smithers/ui:check`. The latter depends on `checkTests`, which checks
all of `src/` and `tests/` using `tsconfig.test.json`. This package does not run
vitest, coverage thresholds, eslint or dprint; `PACKAGE.ts` records the package-specific tooling boundary.

Every export condition points at a `.ts` or `.tsx` source, so `vibelang --noEmit` is
the only thing between a type error and a consumer's build.

Four suites hold the invariants the docs promise:

- `tests/barrel-weight.test.ts` bundles `src/index.ts` in a fresh Bun
  subprocess and fails when `recharts`, `@xterm`, `@milkdown`, `@pierre/diffs`,
  or `d3-force` reaches the output. It also asserts a minimum bundle size, the
  presence of `node_modules/react`, and a control entry point (the
  knowledge-graph adapter) that must contain its dependency, because a negative
  assertion passes against an empty bundle.
  The subprocess is load-bearing: Bun's bundler shares its file cache with the
  test runner's module registry, so an in-process `Bun.build` after another
  suite imported the same modules reads crossed content.
- `tests/css-contract.test.ts` reads the shipped string and enforces the
  namespace, the absence of a `:root` block, the token-only color rule, the
  byte-equal light fallbacks, and the geometry scales.
- `tests/provenance.test.ts` holds the shadcn catalog: every lane file on disk
  must be listed, and every export a lane declares must resolve in the module
  it names.
- `tests/docs-links.test.ts` resolves every relative link in the package's
  Markdown and fails on any file that names the unscoped specifier.

`bunfig.toml` preloads `tests/happy-dom-preload.ts`. Radix resolves its
SSR-safe `useLayoutEffect` shim at module load, so happy-dom has to be
registered before any test file imports `radix-ui`.

## Shared client logic

DOM and OpenTUI clients import renderer-neutral logic through explicit subpaths:

- `@smthrs/ui/flow-form`: schema fields, hints, drafts, required inputs, and typed submission.
- `@smthrs/ui/flow-arguments`: file-flow JSON and quoted `key=value` arguments.
- `@smthrs/ui/command-line`: repository tokens, command normalization, slash parsing, and submit routing.
- `@smthrs/ui/clock`: stable React clock subscriptions for wall and observed engine time.
- `@smthrs/ui/notification-policy`: work debounce, completion timing, and persistent failures.
- `@smthrs/ui/run-command`: opaque run references and source-card routing.

These entrypoints do not import the DOM component barrel. Forms retain one
schema-derived model; each client owns its controls and persistence. File-flow
arrays use JSON to preserve spaces and structured values. Positional command
lists retain their space-separated grammar.

`PromptInput` ignores submission attempts while its handler is pending. Owned
attachment URLs remain readable until that handler settles, even after removal
or unmount. Action menu wrappers forward Enter and Space to their button child.

At widths up to 960px, `ItemAsideSection` links (TODO numbers, branches and Watch)
have a 32px minimum touch target. Longer labels wrap within the side column.

The transcript rail uses `MessageScrollerCommands.scrollByReader(delta)` (CSS pixels) to release follow, pending jumps and read anchors before scrolling. Native wheel input uses the same reader-release path. Bottom-bound downward input and pinch zoom preserve follow.

`ToastStack` with `placement="anchored"` accepts `avoid`, a CSS selector for
page headers and primary actions. It keeps the existing anchor as its start,
clears their visible bounds across wrapping, mounting and scrolling, and uses
a scrollable gap in a crowded viewport. It takes no layout space. Include
plugin headers and custom primary controls in the host's selector.
# Notification focus

`Alt+N` toggles `NotificationPanel` and `Alt+T` focuses the first toast in `ToastStack`. Both shortcuts leave inputs, textareas, selects, and editable content alone so Option characters can be typed without losing focus.

`NotificationPanel` closes on Escape even when completion removed its focused answer field. A nested control that prevents the key keeps ownership of it; closing returns focus to the opener.
