---
title: "API reference"
description: "Every public export of @smthrs/ui and its subpaths: the styling and theming core, the status vocabulary, every component family, the pure helpers, and the heavy adapters."
sidebar:
  order: 1
---

The `exports` map in `package.json` is the public API. It carries no wildcard,
so anything reachable only through a relative path carries no promise. Every
symbol below is exported from the specifier named in its section heading.

Component props types follow the shape `ComponentProps<"element"> & { ... }`,
so every component also accepts the host attributes and handlers of the element
it renders. Where a component renders a control the host does not own directly,
it takes an explicit props bag instead.

## Entry points

| Specifier                              | Contents                                                      | Heavy dependency |
| -------------------------------------- | ------------------------------------------------------------- | ---------------- |
| `@smthrs/ui`                           | Everything on this page except the adapter sections           | None             |
| `@smthrs/ui/copy` | `copyText`, `canCopyText`, `reserveCopyText`, `CopyResult`, `CopyFailureCode` (clipboard only) | None |
| `@smthrs/ui/status`                    | [The status vocabulary](#the-status-vocabulary)               | None             |
| `@smthrs/ui/time`                      | [Time](#time)                                                 | None             |
| `@smthrs/ui/calendar`                  | [Calendar](#calendar)                                         | None             |
| `@smthrs/ui/vault`                     | [Vault](#vault)                                               | None             |
| `@smthrs/ui/adapters/chart`            | [Chart](#chart)                                               | `recharts`       |
| `@smthrs/ui/adapters/terminal`         | [Terminal](#terminal)                                         | `@xterm/*`       |
| `@smthrs/ui/adapters/knowledge-graph`  | [Knowledge graph](#knowledge-graph)                           | `d3-force`       |

The four non-adapter subpaths are slices of the root barrel, offered for import
ergonomics. Everything they export is also on `@smthrs/ui`.

The repository views (`RepoView`, `CodeFileView`, `PierreDiffView`,
`MarkdownEditor`) are `@smthrs/repo-view`'s, and `TerminalFrame` is
`@smthrs/terminal-frame`'s, each imported from its package root.

## Styling

```ts
function SmithersUiStyles(props?: SmithersUiStylesProps): JSX.Element
function composeSmithersUiStyles(props?: SmithersUiStylesProps): string
function prefersReducedMotion(): boolean
function observeReducedMotion(listener: (reduced: boolean) => void): () => void
function cn(...inputs: ClassValue[]): string

const smithersUiCss: string
const standaloneThemeCss: string
const SMITHERS_UI_STYLE_ATTR: "data-smithers-ui"
const REDUCED_MOTION_MEDIA_QUERY: "(prefers-reduced-motion: reduce)"

type SmithersUiStylesProps = { withTheme?: boolean; extra?: string }
```

| Export                     | Meaning                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `SmithersUiStyles`         | Renders the composed sheet in a `<style>` element. Render exactly once per document. Safe under `renderToStaticMarkup`.           |
| `composeSmithersUiStyles`  | The string behind that element. `withTheme` prepends the styleguide token block; `extra` is appended last, so its rules win.      |
| `smithersUiCss`            | The component sheet alone, with no theme block and no extras.                                                                     |
| `standaloneThemeCss`       | Re-exported from [`@smthrs/ui-styleguide`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui/ui-styleguide).                                                                   |
| `SMITHERS_UI_STYLE_ATTR`   | The marker attribute on rendered and injected style elements. The self-injection fallback stands down when it finds one.          |
| `prefersReducedMotion`     | The current motion preference. Answers `false` with no `window`.                                                                  |
| `observeReducedMotion`     | Subscribes to preference changes. Returns an unsubscribe function; a no-op with no `window`.                                      |
| `cn`                       | `clsx` class composition. No `tailwind-merge`, because every class is `sui-` namespaced.                                          |

`useInjectUiCss` is deliberately not exported from the barrel: components call
it internally, and it is not a consumer styling API.

`DataAttributes` accepts `data-*` keys with `string | number | boolean | undefined` values. Pass-through props intersect it so hosts can supply data attributes without other element props.

## Theming

```ts
const tokens: SmithersUiTokens
const themeRegistry: DeepReadonly<Record<ResolvedPalette, SmithersTheme>>
const DEFAULT_THEME_KEY: "paper"

function resolveTheme(root?: ThemeRoot | null, media?: ThemeMedia | null): ResolvedTheme
function subscribeTheme(onChange: () => void): () => void
function resolvePalette(root?: PaletteRoot | null): ResolvedPalette
function subscribePalette(onChange: () => void): () => void
function useResolvedPalette(): ResolvedPalette
function useResolvedTheme(): ResolvedTheme

type ResolvedTheme = "light" | "dark"
type ResolvedPalette = keyof typeof themeRegistry
type SmithersUiTokens = typeof tokens
```

| Export               | Meaning                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens`             | The semantic token table. Every value is a `var(--house-token, #lightFallback)` expression, not a color.                                 |
| `resolveTheme`       | An explicit `data-theme` on `<html>` wins; otherwise the OS `prefers-color-scheme` decides. Resolves `"light"` outside a browser.        |
| `subscribeTheme`     | Fires on a `data-theme` mutation and on an OS preference change. Returns an unsubscribe function.                                        |
| `resolvePalette`     | Reads `data-palette` on `<html>`, accepting only registered keys and falling back to `DEFAULT_THEME_KEY`.                                |
| `subscribePalette`   | Fires on a `data-palette` mutation. Returns an unsubscribe function.                                                                     |
| `useResolvedPalette` | The hook form of `resolvePalette`, re-rendering on change.                                                                               |
| `useResolvedTheme`   | The hook form of `resolveTheme`, re-rendering on change; `"light"` in a server render.                                                   |
| `themeRegistry`      | Paper light/dark, re-exported from [`@smthrs/ui-styleguide`](https://github.com/smithersai/smithers/tree/main/packages/smithers/ui/ui-styleguide).                                                      |

Both `resolveTheme` and `resolvePalette` take optional injectable roots, which
is how the package tests them without a document.

## The status vocabulary

Also available from `@smthrs/ui/status`, which pulls in no React.

```ts
function normalizeStatus(status: string | undefined): string
function statusClass(status: string | undefined): StatusClass
function statusColor(status: string | undefined): string
function hasStatusTone(status: string | undefined): boolean
function formatStatus(status: string | undefined): string
function isTerminalRunStatus(status: string | undefined): boolean

const statusColors: Readonly<Record<string, string>> & Readonly<Record<StatusClass, string>>

type StatusClass = "ok" | "warn" | "bad" | "muted" | "run"
```

| Export                | Meaning                                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizeStatus`     | Trims, lowercases, and maps `_` to `-`. `undefined` becomes `""`.                                                                                 |
| `statusClass`         | The tone bucket. Any `waiting-*` status is `"warn"`; an unknown status is `"muted"`.                                                              |
| `hasStatusTone`       | Whether the vocabulary knows this status, which distinguishes a deliberately neutral status from an unrecognized one.                             |
| `statusColor`         | The token expression the matching tone paints with.                                                                                              |
| `statusColors`        | Both keyings of the same table: by tone, and by every known normalized status.                                                                    |
| `formatStatus`        | The human label. Falls through to a title-cased rendering of the spelling; `undefined` becomes `"Unknown"`.                                       |
| `isTerminalRunStatus` | Whether the run finished, failed, or was cancelled. Narrower than "not running": a parked run is neither.                                         |

Every lookup table is a frozen null-prototype container, so a status string
sourced from a host cannot resolve through `Object.prototype`.

## Base components

| Export                                                                                     | Props type                     | Notes                                                                                        |
| ------------------------------------------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------- |
| `Button`, `buttonVariants`                                                                 | `ButtonProps`                  | Variants `default` (house tinted brand), `solid`, `secondary`, `outline`, `ghost`, `destructive`, `link`. Sizes `sm`, `default`, `lg`, `icon`. `asChild`, `loading`. Native buttons default to `type="button"`; `asChild` forwards an explicit `type`, with the child's own type taking precedence. |
| `Wordmark`, `WORDMARK`                                                                     | `WordmarkProps`                | The Smithers mark: six rows of box-drawing geometry in a bounded SVG, with an entrance scan and hover ripple. It fits independently of minimum font settings. Decorative (`aria-hidden`); name the surrounding element. |
| `Badge`, `badgeVariants`                                                                   | `BadgeProps`                   | `asChild`.                                                                                    |
| `StatusPill`                                                                               | `StatusPillProps`              | `status`, `label`, `withDot`.                                                                 |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` | Element props               | The panel family.                                                                             |
| `Input`, `Textarea`                                                                        | Element props                  | Themed form controls. `Textarea`'s `code` sets source text: the mono stack, no wrapping, no spelling or autocorrection. |
| `Label`, `Field`                                                                           | Element props                  | `Field` pairs a label with its control.                                                       |
| `Alert`, `AlertTitle`, `AlertDescription`, `alertVariants`                                  | `AlertProps`                   | Tone through the CVA recipe.                                                                  |
| `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`, `TableCaption`   | Element props                  | Themed table anatomy.                                                                         |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`                                            | `TabsTriggerProps`             | Radix Tabs.                                                                                   |
| `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogClose`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription` | `DialogContentProps` | Radix Dialog. Portal content is styled because every rule is document-global. |
| `Tooltip`, `TooltipProvider`, `TooltipTrigger`, `TooltipContent`                            | Element props                  | Radix Tooltip.                                                                                |
| `Select`, `SelectGroup`, `SelectValue`, `SelectTrigger`, `SelectContent`, `SelectLabel`, `SelectItem`, `SelectSeparator` | Element props | Radix Select.                                                       |
| `Progress`                                                                                  | `ProgressProps`                | Radix Progress.                                                                               |
| `Separator`, `Skeleton`                                                                     | Element props                  | Hairline rule, and a placeholder in the place of loading content: hidden for `LOADING_DELAY_MS`, then a gentle pulse, still under reduced motion. |
| `LinkIntent`, `intentPath`                                                                  | `LinkIntentProps`              | Reports the intent to follow a plain same-origin link inside it (`onIntent(path)`) once the pointer or focus has rested on it for `delayMs`, as a router's own links preload on hover; a pointer that leaves first reports nothing. `display: contents`. |
| `LoadingBar`, `LOADING_DELAY_MS`                                                            | `LoadingBarProps`              | The one loading indicator: a thin bar at the top (`placement="page"`) or a container's top edge (`"inline"`), shown once `loading` has lasted `LOADING_DELAY_MS` (300). There is no spinner. |
| `EmptyState`                                                                                | `EmptyStateProps`              | `icon`, `title`, `description`, `action`.                                                     |
| `SectionHeader`, `Eyebrow`                                                                  | `SectionHeaderProps`           | `title`, `eyebrow`, `actions`.                                                                |
| `RowButton`                                                                                 | `RowButtonProps`               | `active` applies the house selected-row recipe.                                               |
| `KpiStat`                                                                                   | `KpiStatProps`                 | `label`, `value`, `hint`.                                                                     |
| `StageStrip`, `stageTone`                                                                   | `StageStripProps`, `StageStripItem`, `StageTone` | `stages`, `showSummary`, `summaryLabel`.                                    |
| `CollapsiblePanel`                                                                          | `CollapsiblePanelProps`        | `title`, `status`, `statusLabel`, `meta`, controlled or uncontrolled `open`.                  |
| `Markdown`                                                                                  | `MarkdownProps`, `MarkdownLinkClick`, `MarkdownVariant`, `MarkdownImageResolver` | Dependency-free renderer. Builds React children rather than `innerHTML`, and scheme-filters link hrefs. `variant="document"` reads a repository file as GitHub does: HTML comments dropped, `<pre>` kept preformatted, other tags reduced to their text, single newlines joined, `>` blockquotes nested, a quote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` drawn as a GitHub alert, and images reduced to their alt text (no `<img>`, no request). `resolveImage` draws a line that is exactly `![alt](https://example.com/image.png)` as the light and dark files it returns, one shown per `html[data-theme]`; on a miss the line renders as it would without it. `baseUrl` resolves relative links (`/x.md`, `./y.md`, `#part`) against the document's own URL, so they open where it lives, not on the host. |
| `FileTree`                                                                                  | `FileTreeProps`, `FileTreeItem`, `FileTreeNode`, `FileTreeNodeProps`, `FileTreeDirectoryProps` | Flat `/`-delimited paths grouped into a nested tree, with controlled single selection. |
| `Breadcrumbs`                                                                               | `BreadcrumbsProps`, `BreadcrumbItem` | A path trail. Every step but the last with a safe URL is an `<a href>`; unsafe URLs stay plain text. The last is `aria-current="page"`. `onNavigate` takes a plain click; a modified click stays the browser's. |
| `Popover`, `PopoverTrigger`, `PopoverContent`                                               | Radix Popover props            | A panel anchored to its trigger, in a portal, on the overlay tokens. `PopoverContent` aligns to the trigger's start, 6px below it, unless `align` or `sideOffset` say otherwise. Escape, a click outside and the trigger close it. |
| `RefPicker`                                                                                 | `RefPickerProps`, `RefPickerRef`, `RefPickerRefs` | A branch and tag picker for a repository view's revision: a button showing `current`, opening a filter over `refs` (`loading`, `ready` with `branches`, `tags` and `truncated`, or `failed` with a `message`) on two tabs counted by length. Each choice is an `<a href>` from `href(ref)` with its short SHA; `selected` is marked and `defaultBranch` badged `default`. A full 40-hex SHA typed in the filter is offered too. `onSelect(ref)` takes a plain click or Enter on the first match; a modified click stays the browser's. |
| `RepoAbout` | `RepoAboutProps`, `RepoAboutRelease`, `RepoAboutContributor`, `RepoAboutLanguage` | A repository's about panel, as GitHub's sidebar: `description`, an `http(s)` `homepage` (anything else isn't drawn), `topics`, `stars`, `watchers`, `forks`, `license`, the latest `release` with `releases` counted, the first `contributors` with `contributorCount`, and `languages` as a bar and legend (`languageShares`; under 0.1% folds into Other). A part the host doesn't pass isn't drawn; `loading` runs the shared `LoadingBar`; `footer` sits under it. Links open in a new tab with no opener. `formatCount` writes counts as GitHub does (`14.1k`). |
| `GeneratedChip` | `GeneratedChipProps`, `GeneratedChipLink` | A quiet Generated chip for a file a flow produced. Pressed, it opens the `flow`, its last `run` and its `sources`, each `{ label, href? }`: a real link where `href` is given, a plain click handed to `onNavigate`, a modified click left to the browser. With nothing to name it is a plain chip. |
| `CopyButton`                                                                                | `CopyButtonProps`              | A `Button` that copies through the host's `onCopy`, which resolves once the text is on the clipboard and rejects when it isn't. Shows `copiedLabel` ("Copied") for `copiedDurationMs` (2,000), sets `data-copy-failed` on a rejection, and ignores clicks while a copy is in flight (`data-copying`). It never touches the clipboard itself. |
| `DirectoryListing`                                                                          | `DirectoryListingProps`, `DirectoryEntry`, `DirectoryTarget` | One directory's entries as links with folder and file icons, under a `..` row when `parent` is set. `href` builds each link, `onOpen` takes a plain click, and `empty` shows when there is nothing to list. |
| `useDialogFocusTrap`                                                                        | `UseDialogFocusTrapOptions`    | `{ active, containerRef, initialFocusRef, onClose }`. Focus containment for a custom overlay. |
| `Kbd`                                                                                       | `KbdProps`                     | A `<kbd>` key chip. See [Keys, choices and the command palette](#keys-choices-and-the-command-palette). |
| `SegmentedControl`                                                                          | `SegmentedControlProps`, `SegmentedControlOption` | A controlled single-choice row of buttons. |
| `CommandPalette`                                                                            | `CommandPaletteProps`, `CommandPaletteItem` | A controlled, stateless modal search list. |
| `isPlainNavigationClick`                                                                    | `(event: MouseEvent<HTMLAnchorElement>) => boolean` | Whether a click on a link is a plain primary click a host may turn into in-app navigation. A modified, middle or already-handled click keeps the browser's behavior. |

## Keys, choices and the command palette

```ts
function Kbd(props: ComponentProps<"kbd">): JSX.Element

type SegmentedControlProps = Omit<ComponentProps<"div">, "children" | "role" | "onChange" | "defaultValue" | "aria-label"> & {
  value: string
  options: ReadonlyArray<{ value: string; label: ReactNode; disabled?: boolean; title?: string }>
  onValueChange: (value: string) => void
  "aria-label": string
  size?: "sm"                  // --ctl-h-sm tall; the default is --ctl-h
}

type CommandPaletteProps = {
  open: boolean
  query: string
  onQueryChange: (query: string) => void
  items: ReadonlyArray<{ id: string; label: ReactNode; detail?: ReactNode; badge?: ReactNode }>
  highlighted: number          // out of range highlights nothing
  onHighlight: (index: number) => void
  onChoose: (id: string) => void
  onClose: () => void
  placeholder?: string
  footer?: ReactNode
  "aria-label"?: string        // default "Command palette"
  className?: string
}
```

- `Kbd` renders `<kbd class="sui-kbd">` with the host's props.
- `SegmentedControl` is a `radiogroup` of `radio` buttons with
  `aria-checked`. Only the checked option is in the tab order. The arrow
  keys check and focus the next enabled option, wrapping; a click checks the
  one clicked. A `disabled` option is skipped and struck through.
- `CommandPalette` holds no state. Its input is a `combobox` whose
  `aria-activedescendant` is the highlighted `option` in a `listbox`.
  ArrowUp and ArrowDown call `onHighlight` with the index clamped to `items`,
  Enter and a click call `onChoose(id)`, and Escape and a click on the
  backdrop call `onClose`. It is built on `Dialog`, so focus stays inside
  while it is open. During IME composition, ArrowUp, ArrowDown and Enter stay
  with the input method.

```tsx
const [open, setOpen] = useState(false)
const [query, setQuery] = useState("")
const [highlighted, setHighlighted] = useState(0)
const items = exports.filter((item) => item.name.includes(query)).map((item) => ({
  id: item.name,
  label: item.name,
  detail: item.packageName,
}))

<CommandPalette
  open={open}
  query={query}
  onQueryChange={(next) => { setQuery(next); setHighlighted(0) }}
  items={items}
  highlighted={highlighted}
  onHighlight={setHighlighted}
  onChoose={(id) => { setOpen(false); navigate(id) }}
  onClose={() => setOpen(false)}
  placeholder="Jump to an export"
  footer={<span><Kbd>↵</Kbd> open</span>}
/>

<SegmentedControl
  aria-label="Format"
  size="sm"
  value={format}
  onValueChange={setFormat}
  options={[{ value: "json", label: "JSON" }, { value: "table", label: "Table" }]}
/>
```

`kbdCss`, `segmentedControlCss` and `commandPaletteCss` are part of
`smithersUiCss`.

## Diffs

```ts
function parseUnifiedFile(diffText: string, overrides?: ParseUnifiedFileOverrides): DiffFile
function parseHunks(diffText: string): { lines: DiffLine[]; add: number; del: number; partial: boolean }
function groupHunks(file: DiffFile): Hunk[]
function paginateHunks(file: DiffFile, visibleCount: number): { hunks: Hunk[]; hidden: number }
function diffTotals(diff: Diff): { files: number; add: number; del: number }
function totalBytes(diff: Diff): number
function fileLineCount(file: DiffFile): number
function fileStatus(file: DiffFile): DiffFileStatus
function statusLetter(file: DiffFile): string
function detectBinary(file: DiffFile): boolean
function binaryBodyLabel(file: DiffFile): string
function byteCountString(bytes: number): string
function decodeGitPath(quoted: string): string
function isLargeDiff(diff: Diff): boolean
function initialExpanded(diff: Diff): string[]

const LARGE_FILE_COUNT: 50
const LARGE_BYTE_LIMIT: 1000000
const PAGINATE_THRESHOLD: 2000
const PAGINATE_VISIBLE: 1000

type Diff, DiffFile, DiffFileStatus, DiffLine, DiffLineKind, Hunk, ParseUnifiedFileOverrides
```

`DiffHunks` (`DiffHunksProps`) is the renderer over that model, with no
third-party dependency. `decodeGitPath` decodes the inside of git's quoted path
form, octal escapes included. `byteCountString` answers `"unknown size"` for a
negative or non-finite count rather than rendering `NaN`. The four constants are
the pagination policy documented in
[Failure codes and limits](./reference/contracts.md).

`parseHunks` reports `partial: true` when a hunk body ends before it spends both
of the line budgets its `@@` header declares, whether the body is cut by the end
of the text, by the next header, or by a row that is not hunk content. It also
reports `partial` when the text mentions hunks but none parse. `parseUnifiedFile`
carries the flag onto `DiffFile.partial`, and `DiffHunks` renders a
`sui-diff-partial` warning above the hunks for such a file.

`detectBinary` reads the `GIT binary patch` and `Binary files ` markers off
patch metadata rows only: an unnumbered context line that is not a hunk header.
Hunk body rows carry a line number, so a text diff whose own content reads
`GIT binary patch` still renders its hunks instead of the binary placeholder.

## Time

Also available from `@smthrs/ui/time`.

```ts
function formatRelativeTime(ts: number, now?: number): string
function useRelativeTime(ts: number): string

type RelativeTimeProps // { ts: number; title?: string; relativeUntilMs?: number }
```

`RelativeTime` renders a `<time>` element that re-renders off one ref-counted
one-second interval shared by every mounted instance and hook. A timestamp
outside the range `Date` can hold still renders its label and omits `dateTime`
and `title` rather than throwing.

## Conversation

| Export                                                                                                                                                   | Types                                                                                       | Notes                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `ChatMessage`                                                                                                                                            | `ChatMessageProps`, `ChatMessageRole`                                                       | One message with an optional label, `meta` (delivery state, always shown), `actions` (its time and controls, shown while the pointer is over it, focus is inside it, or a touch taps it) and pending state. |
| `ChatTranscript`                                                                                                                                         | `ChatTranscriptProps`                                                                       | The drop-in transcript surface.                    |
| `ChatComposer`                                                                                                                                           | `ChatComposerProps`, `ChatComposerStatus`, `ChatComposerError`, `ChatComposerCompletions`   | Controlled glass composer. `submitProps` and `stopProps` stamp host attributes on the two buttons. `onError` receives a failed `onSubmit` as `submit-failed`. `completions` lists rows above the input, such as slash commands: arrows move, Enter accepts, Tab completes, Escape dismisses ([complete slash commands](./guides/complete-slash-commands.md)). |
| `CompletionList`                                                                                                                                         | `CompletionListProps`, `ComposerCompletion`                                                 | The listbox `completions` renders, for a host composing its own input. |
| `Message`, `MessageAvatar`, `MessageHeader`, `MessageContent`, `MessageFooter`, `MessageActions`, `MessageGroup`                                          | `MessageProps`, `MessageRole`, `MessageAvatarProps`, `MessageActionsProps`                  | The compound message anatomy.                      |
| `MessageBranch`, `MessageBranchContent`, `MessageBranchSelector`, `MessageBranchPrevious`, `MessageBranchNext`, `MessageBranchPage`                       | `MessageBranchProps`                                                                        | Alternate responses with a pager.                  |
| `MessageScrollerProvider`, `MessageScrollerViewport`, `MessageScrollerContent`, `MessageScrollerItem`, `MessageScrollerButton`                            | `MessageScrollerProviderProps`, `MessageScrollerViewportProps`, `MessageScrollerContentProps`, `MessageScrollerItemProps`, `MessageScrollerButtonProps` | Stick-to-bottom scrolling anatomy. |
| `useMessageScroller`, `useMessageVisibility`, `useMessageScrollerState`                                                                                  | `MessageScrollerCommands`                                                                   | Imperative commands, per-message visibility, and viewport state. |
| `Bubble`, `BubbleContent`, `BubbleActions`, `BubbleReactions`, `bubbleVariants`                                                                          | `BubbleProps`, `BubbleReaction`, `BubbleReactionsProps`                                     | The bubble surface family.                         |
| `Attachment`, `AttachmentMedia`, `AttachmentContent`, `AttachmentTitle`, `AttachmentDescription`, `AttachmentActions`, `AttachmentAction`, `AttachmentTrigger`, `AttachmentGroup`, `AttachmentPreview`, `AttachmentRemove` | `AttachmentProps`, `AttachmentState`, `AttachmentActionProps`, `AttachmentPreviewProps` | Attachment chips and previews. |
| `CompactGroup`, `ConversationCheckpoint`                                                                                                                 | `CompactGroupProps`, `ConversationCheckpointProps`                                          | Collapsed history and a conversation marker.       |
| `Marker`, `Shimmer`                                                                                                                                      | `MarkerProps`, `ShimmerProps`                                                               | Inline divider and the text shimmer.               |

`useMessageBand(order, onBand?)` requires a `MessageScrollerProvider` and
returns the first and last visible message ids, or `undefined`. `onBand`
receives the same band when visibility changes.

`ChatTimelineProps` supplies `entries`, optional `onJump`, `onActivate`,
`groupSummaries` and `onGroupsChange`. Each `ChatTimelineEntry` has `id`,
`kind` (`ask`, `answer`, `tool`, `flow`) and `state` (`done`, `working`,
`waiting`, `failed`, `queued`), with optional summary, label, actor, time,
duration, tokens and cost. See [conversation navigation](./chat-timeline.md).

| Helper | Contract |
| --- | --- |
| `timelineCapacity(height, rowHeight = 32)` | Number of rows that fit, at least two. |
| `timelineLevelCount(count, height, rowHeight = 32)` | Zoom levels needed; zero for an empty list. |
| `timelineLevels(ids, height, first, last, rowHeight = 32)` | `ReadonlyArray<TimelineLevel>` around the inclusive visible entry range. |
| `TimelineBlock` | `{ id, start, end }`; entry indices form a half-open range. |
| `TimelineLevel` | `{ level, start, end, blocks, band: { top, height } }`; band values are proportions. |

## Prompt input

| Export                                                                                                                                                                                                              | Types                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PromptInput`, `PromptInputHeader`, `PromptInputBody`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputTools`, `PromptInputButton`, `PromptInputSubmit`, `PromptInputStop`, `PromptInputActionMenu`, `PromptInputActionMenuTrigger`, `PromptInputActionMenuContent`, `PromptInputActionAddAttachments` | `PromptInputProps`, `PromptInputTextareaProps`, `PromptInputActionMenuProps`, `PromptInputStatus` |
| `usePromptInputAttachments`                                                                                                                                                                                          | Returns `{ attachments, add, remove, clear, openFileDialog }`                                                |
|                                                                                                                                                                                                                      | `PromptInputMessage`, `PromptInputAttachmentItem`, `PromptInputError`                                       |

`onSubmit` receives `(message: PromptInputMessage, event)`. Returning a promise
holds the draft and its blob URLs until it settles. Every refusal reports a
`PromptInputError` through `onError`; the codes and the object-URL ownership
rule are in [Failure codes and limits](./reference/contracts.md).

## Reasoning and tools

```ts
function parseAgentOutput(value: unknown): AgentOutputModel | null
function formatJsonSafe(value: unknown): string
function formatPartialJson(text: string): { text: string; complete: boolean }
function toolCallStatus(state: ToolCallState): "running" | "pending" | "waiting-approval" | "complete" | "error" | "denied"
function chainOfThoughtStepStatus(status: ChainOfThoughtStepStatus | undefined): "pending" | "running" | "complete"

const TOOL_CALL_STATE_LABELS: Readonly<Record<ToolCallState, string>>
```

| Export                                                                                                            | Types                                                                                                                       | Notes                                                                              |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Reasoning`, `ReasoningTrigger`, `ReasoningContent`, `ReasoningSummary`                                            | `ReasoningProps`, `ReasoningTriggerProps`, `ReasoningContentProps`, `ReasoningSummaryProps`                                  | Provider-disclosed summaries only. The parts throw outside `<Reasoning composed>`. |
| `ChainOfThought`, `ChainOfThoughtStep`                                                                             | `ChainOfThoughtProps`, `ChainOfThoughtStepProps`, `ChainOfThoughtStepStatus`                                                | Ordered thought steps.                                                             |
| `ToolCall`, `ToolCallHeader`, `ToolCallContent`, `ToolCallInput`, `ToolCallOutput`, `ToolCallError`, `ToolCallApproval` | `ToolCallProps`, `ToolCallState`, `ToolResultPart`, `ToolCallHeaderProps`, `ToolCallContentProps`, `ToolCallInputProps`, `ToolCallOutputProps`, `ToolCallErrorProps`, `ToolCallApprovalProps` | Eight lifecycle states from `input-streaming` to `output-denied`.                  |
| `CodeBlock`, `CodeBlockHeader`, `CodeBlockFilename`, `CodeBlockGroup`, `CodeBlockTabs`                              | `CodeBlockProps`, `CodeBlockHighlighter`, `HighlightLine`, `HighlightedToken`, `CodeBlockGroupItem`, `CodeBlockHeaderProps`, `CodeBlockFilenameProps`, `CodeBlockGroupProps`, `CodeBlockTabsProps` | Copy, wrapping, line numbers, and a `highlight` seam that needs no adapter.     |
| `MessageResponse`                                                                                                  | `MessageResponseProps`                                                                                                      | Streaming markdown over the `Markdown` primitive.                                  |
| `AgentOutput`                                                                                                      | `AgentOutputProps`, `AgentOutputModel`, `AgentOutputToolCall`                                                               | Renders a parsed model: response, reasoning summary, and tool calls.               |

`CodeBlockHighlighter` is
`(code: string, language: string | undefined) => readonly HighlightLine[] | null`.

The tool parts use `<div>` attributes. `ToolCallHeaderProps`,
`ToolCallContentProps` and `ToolCallApprovalProps` add no fields.
`ToolCallInputProps` adds optional `args`, `argsText`, `partial` and `children`;
`ToolCallOutputProps` adds `result`, `resultText`, `parts` and `children`;
`ToolCallErrorProps` adds `message` and `children`.

`CodeBlockHeaderProps` is `<div>` attributes. `CodeBlockFilenameProps` replaces
`<span>` children with required `name` and optional `icon`. `CodeBlockTabsProps`
replaces `<div>` children with `items: readonly { id, label }[]`, `activeId`
and `onActiveIdChange`. `CodeBlockGroupProps` replaces `<div>` children with
`items: readonly CodeBlockGroupItem[]`, optional `activeId`, `defaultActiveId`,
`onActiveIdChange`, `showLineNumbers` and `highlight`.

## Plans, tasks, and queues

| Export                                                                                                            | Types                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Plan`, `PlanHeader`, `PlanTitle`, `PlanDescription`, `PlanTrigger`, `PlanContent`, `PlanStep`, `PlanAction`, `PlanFooter`, `planStepStatus` | `PlanProps`, `PlanStepProps`, `PlanStepStatus`                |
| `TaskItem`, `TaskItemFile`                                                                                        | `TaskItemProps`, `TaskItemFileProps`                                             |
| `AgentTask`, `AgentTaskTrigger`, `AgentTaskContent`, `AgentTaskGroup`                                             | `AgentTaskProps`, `AgentTaskContentProps`                                        |
| `Queue`, `QueueSection`, `QueueSectionTrigger`, `QueueSectionLabel`, `QueueSectionContent`, `QueueList`, `QueueItem`, `QueueItemIndicator`, `QueueItemContent`, `QueueItemDescription` | `QueueSectionProps`, `QueueSectionLabelProps`, `QueueItemProps`, `QueueItemIndicatorProps` |
| `ActivityTimeline`, `ActivityItem`, `ActivityGroup`                                                               | `ActivityTimelineProps`, `ActivityItemProps`, `ActivityGroupProps`, `ActivityKind`, `ActivityItemModel` |

`planStepStatus` maps a plan step onto
`"pending" | "running" | "complete" | "failed" | "skipped"`.

## Approvals and checkpoints

```ts
function approvalStateToStatus(state: ApprovalState): string
function approvalStateLabel(state: ApprovalState): string
function useCheckpoint(): CheckpointContextValue

const CHECKPOINT_ACTION_KINDS: readonly CheckpointActionKind[]
```

| Export                                                                                                                          | Types                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Confirmation`, `ConfirmationTitle`, `ConfirmationRequest`, `ConfirmationAccepted`, `ConfirmationRejected`, `ConfirmationActions`, `ConfirmationAction` | `ConfirmationProps`, `ConfirmationActionProps`, `ApprovalState`                       |
| `ApprovalCard`, `ApprovalRisk`, `ApprovalResources`, `ApprovalNote`                                                             | `ApprovalCardProps`, `ApprovalRiskProps`, `ApprovalResourcesProps`, `ApprovalNoteProps`, `ApprovalRiskLevel`, `ApprovalResource` |
| `Checkpoint`, `CheckpointIcon`, `CheckpointMetadata`, `CheckpointTrigger`, `CheckpointActions`                                  | `CheckpointProps`, `CheckpointModel`, `CheckpointActionKind`, `CheckpointTriggerProps`, `CheckpointActionsProps` |

`approvalStateToStatus` returns a string from the shared status vocabulary, so
an approval and a run agree on tone.

## Sources and citations

| Export                                                              | Types                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Sources`, `SourcesTrigger`, `SourcesContent`, `Source`             | `SourcesProps`, `SourceItem`, `SourcesTriggerProps`, `SourcesContentProps`, `SourceProps`         |
| `InlineCitation`, `CitationCard`, `CitationCarousel`, `CitationQuote` | `InlineCitationProps`, `CitationSource`, `CitationCardProps`, `CitationCarouselProps`, `CitationQuoteProps` |
| `Suggestion`, `SuggestionGroup`                                     | `SuggestionProps`, `SuggestionGroupProps`                                                         |
| `OpenInChat`                                                        | `OpenInChatProps`, `OpenInChatSubject`, `OpenInChatSubjectKind`                                   |

## Agents and context

```ts
function availabilityLabel(availability: AgentAvailability): string
function contextUsagePercent(usage: TokenUsageModel): number | undefined
```

| Export                                                                                                                                 | Types                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AgentDefinition`, `AgentHeader`, `AgentContent`, `AgentInstructions`, `AgentTools`, `AgentTool`, `AgentOutputSchema`, `AgentAvailabilityBadge` | `AgentDefinitionProps`, `AgentAvailability`, `AgentToolDescriptorModel`, `AgentAvailabilityBadgeProps`, `AgentInstructionsProps`, `AgentToolProps`, `AgentOutputSchemaProps` |
| `AgentCard`                                                                                                                            | `AgentCardProps`                                                                                                         |
| `ModelSelector`, `ModelSelectorTrigger`, `ModelSelectorContent`, `ModelSelectorGroup`, `ModelSelectorItem`                              | `ModelSelectorProps`, `ModelOption`, `ModelSelectorItemProps`                                                            |
| `ModelBadge`, `ProviderBadge`                                                                                                          | `ModelBadgeProps`, `ProviderBadgeProps`                                                                                  |
| `ContextUsage`, `ContextTrigger`, `ContextContent`, `ContextContentHeader`, `ContextContentBody`, `ContextContentFooter`, `ContextInputUsage`, `ContextOutputUsage`, `ContextReasoningUsage`, `ContextCacheUsage` | `ContextUsageProps`, `TokenUsageModel`                        |

`contextUsagePercent` answers `undefined` when `usedTokens` or `maxTokens` is
absent, or when `maxTokens` is not positive, rather than guessing at a
denominator. Otherwise it rounds and clamps to 100.

## Coding artifacts

```ts
function parseStackTrace(text: string): StackFrameData[]
function testCaseStatusToStatus(status: TestCaseStatus): string
function formatTestDuration(durationMs: number): string
function useCommitModel(): CommitModel | null
```

| Export                                                                                                                                                                       | Types                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `Artifact`, `ArtifactHeader`, `ArtifactTitle`, `ArtifactDescription`, `ArtifactActions`, `ArtifactAction`, `ArtifactClose`, `ArtifactContent`                                 | `ArtifactActionProps`, `ArtifactCloseProps`                                                      |
| `Snippet`                                                                                                                                                                    | `SnippetProps`                                                                                   |
| `PackageInfo`                                                                                                                                                                | `PackageInfoProps`                                                                               |
| `SchemaDisplay`                                                                                                                                                              | `SchemaDisplayProps`                                                                             |
| `StackTrace`, `StackFrame`                                                                                                                                                   | `StackTraceProps`, `StackFrameProps`, `StackFrameData`                                           |
| `TestResults`, `TestResultsHeader`, `TestResultsSummary`, `TestResultsDuration`, `TestResultsProgress`, `TestResultsContent`, `TestSuite`, `TestSuiteName`, `TestSuiteStats`, `TestSuiteContent`, `TestRow`, `TestStatus`, `TestName` | `TestResultsProps`, `TestResultsDurationProps`, `TestSuiteProps`, `TestRowProps`, `TestStatusProps`, `TestCaseStatus`, `TestCaseModel`, `TestSuiteModel` |
| `Commit`, `CommitHeader`, `CommitAuthor`, `CommitInfo`, `CommitMessage`, `CommitMetadata`, `CommitHash`, `CommitTimestamp`, `CommitActions`, `CommitFiles`, `CommitFile`, `CommitFileStatus`, `CommitFilePath` | `CommitProps`, `CommitModel`, `CommitFileModel`, `CommitFileStatusKind`, `CommitHashProps`, `CommitTimestampProps`, `CommitFileProps`, `CommitFileStatusProps`, `CommitFilePathProps` |
| `ChangeSummary`                                                                                                                                                              | `ChangeSummaryProps`                                                                             |
| `EnvironmentVariables`, `EnvironmentVariable`                                                                                                                                | `EnvironmentVariablesProps`, `EnvironmentVariableProps`, `EnvironmentVariableModel`              |
| `SecretField`                                                                                                                                                                | `SecretFieldProps`                                                                               |

`SchemaDisplay` and `SecretField` enforce bounds documented in
[Failure codes and limits](./reference/contracts.md).

The commit part props replace host children. `CommitHashProps` adds required
`hash`, optional `changeId` and `short` (default `true`) to `<span>` attributes;
`changeId` takes precedence. `CommitTimestampProps` adds `timestampMs`.
`CommitFileStatusProps` adds `status: CommitFileStatusKind` and
`CommitFilePathProps` adds `path` and optional `oldPath`, all on `<span>`.
`CommitFileProps` adds `file: CommitFileModel` to `<li>` attributes.

## Sandbox previews

```ts
function sandboxStateToStatus(state: SandboxState): string
```

| Export                                                                        | Types                                                                                                        |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Sandbox`, `SandboxHeader`, `SandboxStatus`, `SandboxActions`, `SandboxContent` | `SandboxProps`, `SandboxStatusProps`, `SandboxActionsProps`, `SandboxState`                                  |
| `WebPreview`, `WebPreviewToolbar`, `WebPreviewAddress`, `WebPreviewContent`     | `WebPreviewProps`, `WebPreviewToolbarProps`, `WebPreviewAddressProps`, `WebPreviewContentProps`, `WebPreviewSandboxToken` |
| `JSXPreview`                                                                   | `JSXPreviewProps`                                                                                            |

`WebPreviewContent` takes `sandboxAllow`, a list of `WebPreviewSandboxToken`
values, defaulting to `["allow-scripts", "allow-forms"]`. It renders the iframe
`sandbox` attribute from that list under three rules it enforces itself:

- Each entry is trimmed, lowercased, and accepted only when the whole entry is
  one of the five known keywords. An unknown or packed entry is rejected
  wholesale with a console warning rather than salvaged into a capability.
- `allow-same-origin` is dropped whenever `allow-scripts` is also present. The
  pair would let the framed page remove its own sandbox.
- `src` must be an absolute `http` or `https` URL or a root-relative
  same-origin path. Anything else, including `javascript:`, `data:`, `blob:`,
  protocol-relative, and backslash network-path forms, is refused, and the
  sanitized string is what gets rendered.

## Workflow canvas

| Export                                                                                                                                                                | Types                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `WorkflowCanvas`, `WorkflowNode`, `WorkflowNodeHeader`, `WorkflowNodeContent`, `WorkflowNodeStatus`, `WorkflowEdge`, `WorkflowConnection`, `WorkflowControls`, `WorkflowPanel`, `WorkflowToolbar`, `WorkflowMinimap` | `WorkflowCanvasProps`, `WorkflowNodeProps`, `WorkflowNodeStatusProps`, `WorkflowEdgeProps`, `WorkflowConnectionProps`, `WorkflowControlsProps`, `WorkflowPanelProps` |

## Calendar

Also available from `@smthrs/ui/calendar`.

```ts
function monthGridDays(anchorMs: number, weekStartsOn?: number): number[]
function weekDays(anchorMs: number, weekStartsOn?: number): number[]
function eventsOnDay(events: CalendarEvent[], dayMs: number): CalendarEvent[]
function agendaGroups(events: CalendarEvent[]): AgendaDayGroup[]
function startOfDay(ms: number): number
function addDays(ms: number, days: number): number
function addMonths(ms: number, months: number): number
function daysInMonth(year: number, month: number): number
function isSameDay(a: number, b: number): boolean
function minutesIntoDay(ms: number): number
function atMinutesIntoDay(dayMs: number, minutes: number): number
function snapUp30(minutes: number): number
function snapDown30(minutes: number): number
function dayKey(ms: number): string
function monthLabel(ms: number): string
function weekLabel(days: number[]): string
function weekdayLabel(ms: number): string
function fullDayLabel(ms: number): string
function timeLabel(ms: number): string
function hourLabel(hour: number): string
function hashSource(source: string | undefined): number

const DAY_MS: 86400000
const HOUR_MS: 3600000
const MINUTE_MS: 60000
const CALENDAR_CSS_ID: "calendar"
const calendarCss: string
```

`Calendar` (`CalendarProps`) renders month, week, and agenda views over
`CalendarEvent` values, with `CalendarView` naming the three. Every timestamp is
Unix epoch milliseconds. `hashSource` is the per-source tint rotation, which is
what gives an event without an explicit `color` a stable one.

The week grid is a wall clock, not elapsed time. `atMinutesIntoDay` inverts
`minutesIntoDay` to turn a row offset back into an instant, and `hourLabel`
formats a gutter hour off a transition-free reference day. On a daylight-saving
transition day a slot inside the spring-forward gap resolves to the instant the
clock jumps to (02:30 becomes 03:30 local), and a slot inside the autumn
fall-back hour resolves to its first, still-daylight occurrence.

## Vault

Also available from `@smthrs/ui/vault`.

```ts
function parseWikilinks(markdown: string): Wikilink[]
function wikilinksToMarkdown(body: string, resolve: (target: string) => string): string
function restoreWikilinks(markdown: string): string
function noteHref(path: string): string
function pathFromHref(href: string): string
function noteLabel(path: string): string
function splitFrontmatter(source: string): { frontmatter: string | null; body: string }
function joinFrontmatter(frontmatter: string | null, body: string): string

function computeGraphModel(notes: readonly VaultNoteMeta[], links: readonly VaultLink[]): { nodes: VaultGraphNode[]; links: VaultGraphEdge[] }
function neighbourSet(hover: string | null, links: readonly VaultGraphEdge[]): Set<string> | null
function nodeRadius(degree: number): number
function shouldShowLabel(degree: number, threshold?: number): boolean
function noteFolder(path: string): string
function folderTint(folder: string): GraphFolderTint
function folderTintIndex(folder: string): number
function folderHue(folder: string): number

function parseOutline(markdown: string): OutlineHeading[]
function createAutosaveDoc(options: AutosaveDocOptions): AutosaveDoc
function useAutosaveDoc(options: UseAutosaveDocOptions): UseAutosaveDocResult
function autosaveStatusText(state: AutosaveState): string
function useVaultCss(): void

const NOTE_HREF: "#note/"
const GRAPH_FOLDER_TINTS: readonly ["brand", "success", "info", "warning"]
const HUB_LABEL_MIN_DEGREE: 6
const AUTOSAVE_STATUS_TEXT: Record<AutosaveState, string>
const VAULT_CSS_ID: "vault"
const vaultCss: string
```

`BacklinksPanel` (`BacklinksPanelProps`) and `OutlineView` (`OutlineViewProps`,
`OutlineHeading`) are the two panels. `VaultAdapter`, `VaultNoteMeta`, and
`VaultLink` are the host contract: `tree`, `read`, and `write` are required, and
`links` and `graph` are optional bulk reads.

`AutosaveState` is `"clean" | "dirty" | "saving" | "saved" | "conflict"`, and
`AutosaveSnapshot.failure` and readonly `UseAutosaveDocResult.failure` expose
`AutosaveFailure` (`code`, `cause`). `AutosaveFailureCode` is `"read-failed"`,
`"write-failed"`, or `"conflict"` (a refused conditional commit).

`save(value, expected)` receives the `AutosaveRevision` captured by
`readExternal`. The backend must atomically compare its content and revision
and write only on a match. Return `AutosaveSaveResult`: `{ mtimeMs? }` or
`{ status: "conflict", cause? }`. A successful writer may resolve `void`.
Reporting `mtimeMs` advances the conflict baseline. Without `readExternal`,
`expected` is undefined and the writer provides its own concurrency control.

`useAutosaveDoc` retains unsaved machines by `resetKey` across document switches
and unmounts. Use a stable, unique document key to reopen a retained draft;
omitting it gives the hook a private identity that cannot be reopened after
unmount. An optional stable `owner` object scopes keys to a vault or session;
keep it outside the component to recover drafts after remount. The default
owner is shared by browser hooks in this module. Server renders use private
owners. Retention is in memory, not across a page reload. Retired writes keep
retrying; conflicts and read failures wait for reopening and `saveNow()` or `discardExternal()`. Only clean or saved retired
machines are disposed.

`KnowledgeGraph` is not here. It ships from
[`@smthrs/ui/adapters/knowledge-graph`](#knowledge-graph).

## Chart

`@smthrs/ui/adapters/chart`. Pulls in `recharts`.

```ts
function chartConfig(series: ReadonlyArray<{ key: string; label?: ReactNode }>): ChartConfig
function chartSeriesColor(index: number, theme?: "light" | "dark"): string

const CHART_SERIES: ReadonlyArray<{ readonly light: string; readonly dark: string }>
```

`ChartProvider`, `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`,
`ChartLegend`, and `ChartLegendContent` are the shadcn chart contract over
Recharts. `ChartConfig` maps a series key to a label, an icon, and either a
color or a light and dark pair.

`CHART_SERIES` is eight validated slots in fixed order. `chartSeriesColor`
clamps an index past the palette to the last slot rather than cycling: fold
extra series into an "Other" bucket or facet the chart.

## Terminal

`@smthrs/ui/adapters/terminal`. Pulls in `@xterm/xterm` and `@xterm/addon-fit`.

```ts
function terminalThemeFor(palette: ResolvedPalette, mode: TerminalColorTheme): ITheme

type TerminalWriter = (data: string | Uint8Array) => void
type TerminalStream = (write: TerminalWriter) => void | (() => void)
type TerminalColorTheme = "dark" | "light"
type TerminalInstance = XTerminal
type TerminalModules = { Terminal: typeof XTerminal; FitAddon: typeof FitAddon }
type TerminalError = { code: "terminal-start-failed"; cause: unknown }
```

`Terminal` (`TerminalProps`) owns the emulator, the fit addon, theming, and
resize. `lines` writes a snapshot once; `stream` subscribes to live output and
may return a teardown; `onData` carries keystrokes out; `onResize` fires after
every fit; `onReady` hands back the raw xterm.js instance. `theme`, `palette`,
and `colors` override the theme resolved from the document. `readOnly`,
`scrollback`, `fontSize`, `fontFamily`, and `cursorBlink` configure the
emulator.

When the emulator cannot start, `onError` receives a `TerminalError` with the
original cause. If no emulator opened, the surface sets `data-state="failed"`
and renders a `role="alert"` message instead of staying blank. `loadModules`
replaces the dynamic `@xterm/*` imports.

The xterm base stylesheet is vendored as a string and injected through the same
seam as the rest of the library, so a host must not import
`@xterm/xterm/css/xterm.css`. The root exports it as `xtermBaseCss` for
`@smthrs/terminal-frame`, whose frame carries the same sheet.

## Knowledge graph

`@smthrs/ui/adapters/knowledge-graph`. Pulls in `d3-force`.

`KnowledgeGraph` (`KnowledgeGraphProps`) renders the vault graph over a force
simulation. The graph math it draws is not behind this subpath:
`computeGraphModel`, `nodeRadius`, `folderTint`, and `neighbourSet` are on the
base barrel, so a host can compute a graph without loading the renderer.

Under `prefers-reduced-motion: reduce` the graph skips the animated frames and
settles the layout in batches with an 8 ms budget checked after each tick,
yielding between batches and painting once the layout is settled. A single
tick can exceed the budget. Unmounting or changing the graph cancels pending
batches. `scheduleSettle` replaces the yield
(`requestIdleCallback`, falling back to `setTimeout`) and `loadPhysics`
replaces the lazy `d3-force` import; a rejecting loader renders the hub list.

## App operations

`@smthrs/ui/app-operations` declares Smithers acts apart from any host that
runs them. It is not on the root barrel.

An `Operation` is a name, an Effect Schema `input`, and the rules every host
applies: `summary`, `args`, `requires`, `confirm`, `userOnly` with its
`userOnlyReason`, `runtime`, `hosts`, and `form` hints. It has no handler.
`operation(declaration)` returns the declaration with its literal type, so a
host binding reads the exact input schema. `NoInput` is the input of an
operation that takes nothing.

A host binds its own implementation to each operation. The app binds
controller calls with an exhaustive handler map, so an operation without a
handler does not compile. A user-only operation is never offered to a model
or a robot; a consequential one sets `confirm` instead, so a model may ask and
the human confirms.

`@smthrs/ui/app-operations/wiki` exports `wikiSurfaceOperations` and
`wikiOperations`, the Wiki acts in registration order, with
`WIKI_DISPLAY_NAME` and the user-only reasons they quote.

## Generated views

Decision 0004's UI: views an agent writes, shown without running its code in
the page. See [show a generated view](./guides/show-a-generated-view.md) and
[`@smthrs/views`](../views/docs/api.md).

```ts
function GeneratedView(props: GeneratedViewProps): JSX.Element

type GeneratedViewProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  html: string
  interactions: Interactions.Declared
  title: string
  theme: "light" | "dark"
  size?: "inline" | "full"                    // default "inline"
  onInteraction: (interaction: GeneratedViewInteraction) => void
  onRefused?: (reason: Bridge.Refusal) => void
  runtime?: string                            // default frameRuntime
  styles?: string                             // default the component sheet with its theme
  now?: () => number                          // default Date.now
}

type GeneratedViewInteraction =
  | { _tag: "State"; event: { name: string; arg?: string } }
  | { _tag: "Message"; event: { name: string; arg?: string }; label: string; values: Record<string, string | number | boolean> }
```

`GeneratedView` shows `html` in `<iframe sandbox="allow-scripts" srcdoc>`,
written by `ViewCsp.frameDocument` with a fresh nonce on each mount. It
answers one `ui/initialize`, from its own frame with that nonce, with the
HTML, theme and size and a `MessagePort`; every later message passes
`Bridge.receive`. A changed `html` or `theme` goes to the frame as
`ui/notifications/host-context-changed`. `inline` takes the reported height,
80 to 480 pixels; `full` fills its container. The frame mounts only while it
is near the screen.

| Export | What it is |
| --- | --- |
| `frameRuntime` | the frame runtime as one script, generated by `scripts/build-views.mjs` from `src/generated-view/runtime.ts` |
| `newNonce()`, `useNearScreen(element)` | a fresh per-mount handshake secret, and whether an element is within 200 px of the screen; `GeneratedView` and `@smthrs/terminal-frame` mount their frames with them |
| `sanitizeViewHtml(html, document, parser)` | the frame's sanitizer: an inert `DOMParser` parse, then an allowlist copy into `document` |
| `generatedViewCss` | the component's sheet, part of `smithersUiCss` |
| `loadPresentationBundle()` | `Promise<string>`: the presentation bundle a `PresentationRealm` loads, imported on first use |
| `presentationComponents`, `presentationComponentNames` | the presentation subset, by the name a view imports, and its sorted names |

`node scripts/build-views.mjs` regenerates `frameRuntime` and the presentation
bundle; `tests/views-generated.test.ts` fails while either is stale.

## Templates: forms and issues

```ts
function FlowFormView(props: FlowFormViewProps): JSX.Element

type FlowFormViewProps = Omit<ComponentProps<"section">, "title" | "onSubmit"> & {
  title: string
  schema: unknown                     // a JSON Schema object, or a { schema, definitions } document
  submitLabel: string
  submitted?: boolean
  values?: Readonly<Record<string, unknown>>
  size?: "inline" | "full"
  onSubmit: (submission: FlowFormSubmission) => void
}

type FlowFormSubmission = { text: string; data: Readonly<Record<string, string | number | boolean>>; writeOnly: ReadonlyArray<string> }
```

The `form` template. Its fields come from `schema` through `declaredInput` and
`formFieldsFor`. Submit calls `onSubmit` once with `text` as the submit label;
a required field left blank blocks it. `writeOnly` names the secret fields.
`submitted` disables the form and shows `values`, never a write-only one. A
schema it cannot read shows `Form unavailable`.

```ts
function IssuesView(props: IssuesViewProps): JSX.Element
function ItemStateIcon(props: ItemStateIconProps): JSX.Element

type IssuesViewProps = Omit<ComponentProps<"section">, "children"> & {
  repo: string
  issues: ReadonlyArray<IssuesViewIssue>
  size?: "inline" | "full"
  href?: (issue: IssuesViewIssue) => string | undefined    // the title becomes an <a href>
  onNavigate?: (issue: IssuesViewIssue, href: string) => void
  loading?: boolean                                        // first sync not complete
  unknown?: boolean                                        // rows not known yet, and no loading state
  actions?: ReactNode                                      // in the header, such as New issue
  filter?: IssuesViewFilter                                // Open and Closed tabs with counts
  numberPrefix?: string                                    // default "#"; "T" for T4
  emptyTitle?: string                                      // default "No issues"
  ordered?: boolean                                        // an ol, for a list whose order means something
}

type IssuesViewFilter = {
  state: "open" | "closed"                                 // the rows shown
  href: (state: "open" | "closed") => string
  onSelect?: (state: "open" | "closed", href: string) => void
}

type IssuesViewIssue = {
  id?: string                                              // the row key; default the number
  number: number | null                                    // null: not numbered yet, shows #–
  title: string
  state: "open" | "closed"
  status?: ItemStatus                                      // the icon and word; default Open or Closed
  labels?: ReadonlyArray<string>
  author?: string
  comments?: number
  updatedAt?: string                                       // shown relative to now
  pending?: "requested" | "not_sent"                       // a Requested or Not sent chip
  triage?: IssuesViewTriage                                // a triage chip; absent: none
  links?: ReadonlyArray<IssuesViewLink>                    // { label, href }: its branch, pull request, issue
  menu?: ReadonlyArray<ActionMenuItem>                     // the row's ⋯ menu
}

type ItemStateKind = "open" | "closed" | "requested" | "queued" | "running" | "needs_you" | "in_review" | "merged" | "dropped" | "failed"
type ItemStatus = { kind: ItemStateKind; label: string; live?: boolean }   // live: work under way now
type ItemStateIconProps = Omit<ComponentProps<"svg">, "children"> & { kind: ItemStateKind; label: string; live?: boolean }
const ITEM_STATE_VARIANTS: Readonly<Record<ItemStateKind, "success" | "muted" | "outline" | "default" | "warning" | "destructive">>

type IssuesViewTriage = "proposed" | "accepted" | "not_accepted" | "conflict"

const TRIAGE_WORDS: Readonly<Record<IssuesViewTriage, string>>   // Proposed, Accepted for discussion, Not accepted, Conflict
```

The `issues` template, and the issue list (`/issues`) of apps/mvp decision
0012. Without `href` it shows the issues the host passed in, with no
navigation. With `href`, each title is a link whose href passes `safeHref`; a
plain click calls `onNavigate` after `preventDefault`, and a modified click
(⌘, Ctrl, Shift, Alt, middle button) keeps the browser's behavior. `loading`
sets `aria-busy`, replaces the counts with a `Loading issues` status and, with
no rows, shows placeholders instead of `EmptyState`. A row carries
`data-pending`. `triage` adds a chip (`sui-issues-triage`, `data-triage`) after
the number: `Proposed` outline, `Accepted for discussion` success, `Not accepted` muted,
`Conflict` warning. An empty list shows `EmptyState`. `inline` scrolls inside
320 pixels.

Lists as GitHub draws them: each row (`data-slot="issues-row"`, `data-state`,
`data-status`) leads with `ItemStateIcon`, a 16-pixel image named by
`status.label` and colored for its kind (`ITEM_STATE_VARIANTS`). A `live`
status marks work under way that a person can go and watch: the row carries
`data-live` and its icon blinks slowly, one calm 2-second cycle, and holds
steady under `prefers-reduced-motion: reduce`. The meta line
ends with `links`, an `http(s)` one in a new tab and an in-app one calling
`onNavigate` on a plain click; `menu` adds an `ActionMenu` named
`<number> actions`. With `href`, ArrowDown, ArrowUp, Home and End move focus
between the rows' links. `filter` replaces the name and counts with Open and
Closed tabs (`nav` `Filter`, the current one `aria-current="page"`), each with
its icon and count, and shows only that state's rows; a plain click on a tab
calls `onSelect`. `unknown` hides the counts and shows nothing for an empty
list: no empty state, placeholders or busy state.

`declaredInput(document)` and `formFieldsFor(input, hints?, payload?)`, with
their `FieldKind`, `FieldValue`, `FormDraft`, `FormField` and `FormHints`
types, are on the root as well as `@smthrs/ui/flow-form`.

`slashMenu(draft, commands)` and `slashSubmit(text, commands)`, with their
`SlashCommand`, `SlashCompletion`, `SlashMenu` and `SlashSubmit` types, list
what a composer's draft completes to and read a submitted line as a command
run, a refusal or a prompt
([complete slash commands](./guides/complete-slash-commands.md)).

`flowFormViewCss` and `issuesViewCss` are the templates' CSS strings, already
included in `smithersUiCss`. `IssuesViewState` is `"open" | "closed"`, the
state of an `IssuesViewIssue` and its Open/Closed filter.

## Issues

One issue's page and the new-issue form (apps/mvp decision 0012). Both are
controlled: the host owns every value and draft, and the components fetch
nothing.

```ts
function ItemConversation(props: ItemConversationProps): JSX.Element
function IssueForm(props: IssueFormProps): JSX.Element

function ItemAsideSection(props: ItemAsideSectionProps): JSX.Element

type ItemConversationProps = Omit<ComponentProps<"article">, "children" | "title"> & {
  title: string
  number: number | null                         // null shows #–
  numberPrefix?: string                         // default "#"; "T" for T4
  state: "open" | "closed"
  status?: ItemStatus                           // the pill's icon and word; default Open or Closed
  author?: string
  createdAt?: string                            // ISO 8601
  body: string                                  // Markdown
  pending?: "requested" | "not_sent"
  comments: ReadonlyArray<ItemConversationComment>
  events?: ReadonlyArray<ItemConversationEvent> // the timeline, after the body
  aside?: ReactNode                             // a side column of ItemAsideSections and actions
  externalHref?: string                         // Open on GitHub ↗
  loading?: boolean
  composer?: ItemConversationComposer           // absent: no composer at all
  headingLevel?: 1 | 2 | 3                      // default 1
  headerActions?: ReactNode                     // end of the header's meta row, such as TriageControl
}

type ItemConversationComment = {
  id: string
  author?: string
  createdAt?: string
  body: string
  pending?: "requested" | "not_sent"
  reason?: string                               // shown only when not_sent
  actions?: ReactNode                           // such as Edit and Discard
}

type ItemConversationEvent = {
  id: string
  kind: ItemStateKind                           // its icon
  author?: string                               // bold before text
  text: string                                  // such as `committed`, or `Dropped` alone
  createdAt?: string
}

type ItemAsideSectionProps = Omit<ComponentProps<"section">, "title"> & {
  title: string
  links?: ReadonlyArray<IssuesViewLink>         // one per line
  onNavigate?: (href: string) => void           // a plain click on an in-app link
}

type ItemConversationComposer = {
  draft: string
  onDraft: (text: string) => void
  onSubmit: () => void
  disabled?: boolean
  label?: string                                // the textarea's name; default "Comment"
}

type IssueFormProps = Omit<ComponentProps<"form">, "children" | "onSubmit"> & {
  title: string
  body: string
  onTitle: (text: string) => void
  onBody: (text: string) => void
  onSubmit: () => void                          // called with the event prevented
  disabled?: boolean
  error?: string                                // an alert under the fields
  submitLabel?: string                          // default "Create issue"
}
```

`ItemConversation` renders an `article` (`data-slot="item-conversation"`,
`data-state`, `data-status`, `data-pending`) named by its title heading: the
title with `#12` or `#–` (`numberPrefix`), a pill with the state's icon and
word (`status`, else `Open` or `Closed`), a `Requested` or `Not sent` chip,
the author, a `RelativeTime`, `Open on GitHub ↗` in a new tab when
`externalHref` passes `safeHref`, and `headerActions` at the row's end. The body and each comment render through
`Markdown` with `variant="document"`, so an HTML comment is dropped and no tag
in the text, a `<script>` included, becomes an element. Comments are an `ol`
labelled `Comments`, each `li` with `data-pending`. The composer is a labelled
`Textarea` and a `Comment` button; the button, ⌘Enter and Ctrl+Enter submit
only while the trimmed draft is non-empty and `disabled` is unset. `loading`
shows a `Loading` status and placeholders, with no header, header actions,
comments or composer.

`events` is an `ol` named `Timeline` after the body: each event's icon, its
author and text, and when. `aside` adds a side column (`data-aside` on the
article): beside the main column from 768 pixels, under it below. An
`ItemAsideSection` is a `section` named by its `title`, with its `links` and
its children.

`IssueForm` labels a `Title` input and a `Description` textarea. The submit
button, Enter in the title, and ⌘Enter or Ctrl+Enter in either field submit
only while the trimmed title is non-empty and `disabled` is unset. `error` is a
`role="alert"` paragraph that describes both fields.

`itemConversationCss` is part of `smithersUiCss`.

## Triage

An issue's triage state and the buttons a person may press (apps/mvp decision
0012 §5). Controlled: the host owns the state and the writes.

```ts
function TriageControl(props: TriageControlProps): JSX.Element

type TriageControlProps = Omit<ComponentProps<"div">, "children"> & {
  state: IssuesViewTriage
  pending?: "requested" | "not_sent"            // a Requested or Not sent chip
  onAccept?: () => void                         // Accept, unless accepted
  onReject?: () => void                         // Not accepted, unless not_accepted
  onRunAgain?: () => void                       // Run triage again
  disabled?: boolean                            // disables every button shown
}
```

`TriageControl` renders a `div` with `role="group"` and `aria-label="Triage"`
(a host `aria-label` replaces it), `data-slot="triage-control"`,
`data-triage` and `data-pending`. It shows the state chip in the words and
variants of `IssuesView`'s triage chip, the pending chip, then small outline
`Accept` and `Not accepted` buttons and a ghost `Run triage again`. A button
whose handler is absent is not rendered, so a person who can't act sees the
state only.

| `state` | Buttons, with every handler |
|---|---|
| `proposed` | Accept · Not accepted · Run triage again |
| `accepted` | Not accepted · Run triage again |
| `not_accepted` | Accept · Run triage again |
| `conflict` | Accept · Not accepted · Run triage again |

`triageControlCss` is part of `smithersUiCss`.

## Shared carets

```ts
type FieldSelection = { readonly anchor: number; readonly head: number }
type Collaborator = FieldSelection & { readonly id: string; readonly name: string }
type CollaboratorCaretsProps = {
  readonly field: RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  readonly value: string
  readonly collaborators: ReadonlyArray<Collaborator>
}
function CollaboratorCarets(props: CollaboratorCaretsProps): JSX.Element | null
function selectionOf(field: HTMLTextAreaElement | HTMLInputElement): FieldSelection
function useSharedSelection(
  field: RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
  value: string,
  selection: FieldSelection | undefined
): (typed: string) => void
const PERSON_LANES: 6
function personLane(id: string): number
const collaboratorsCss: string
```

Render `CollaboratorCarets` beside its field in a positioned parent. It draws
other people's carets and selections; an empty list renders nothing.
`selectionOf` preserves selection direction. `useSharedSelection` restores a
focused field's supplied selection after an outside edit; call its returned
function for each locally typed value. `personLane` maps a stable id to one
of `PERSON_LANES` colors (`0`–`5`). `collaboratorsCss` is included in
`smithersUiCss`.

## Sharing

Who is on a branch, and who may open it (apps/mvp decision 0013 §5), after
Google Docs and Figma. Both are controlled: the host owns the people, the
access and the writes.

```ts
function AvatarStack(props: AvatarStackProps): JSX.Element | null
function ShareDialog(props: ShareDialogProps): JSX.Element

interface AvatarStackPerson {
  id: string                                    // stable key; also picks the color
  name: string                                  // such as a GitHub login; the initial comes from it
  title?: string                                // the tooltip, such as "maya · Terminal"; default name
}

type AvatarStackProps = Omit<ComponentProps<"ul">, "children" | "onSelect"> & {
  people: ReadonlyArray<AvatarStackPerson>
  max?: number                                  // default 4; the rest fold into one +N
  onSelect?: (id: string) => void               // present: each avatar is a button
  label?: string                                // the list's name; default "People here"
}

type ShareAccess = "view" | "edit"
type ShareGeneral = "restricted" | ShareAccess  // restricted: only people added

interface SharePerson { id: string; name: string; access: ShareAccess | "owner" }

interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string                                 // such as "Share test-branch"
  people: ReadonlyArray<SharePerson>            // in order, owner first
  self?: string                                 // the viewer's id: "<name> (you)"
  general: ShareGeneral
  groupLabel: string                            // such as "Anyone in this repository with the link"
  link: string                                  // what Copy link copies
  onAdd: (name: string, access: ShareAccess) => void
  onAccessChange: (id: string, access: ShareAccess) => void
  onRemove: (id: string) => void
  onGeneralChange: (general: ShareGeneral) => void
  error?: string                                // under the add row, such as "No such person"
  pending?: ReadonlyArray<string>               // people being changed: their controls disabled
}
```

`AvatarStack` renders a `ul` (`data-slot="avatar-stack"`) named by `label`,
or renders nothing for no people. Each avatar is a 24px circle with the
name's first letter or digit, named by the name, with a tooltip of its
`title`. Without `onSelect` it is `role="img"`; with it, a button that calls
`onSelect(id)` on click, Enter or Space. Past `max`, one focusable `+N` is named
by, and tooltips, the rest's names. Avatars overlap, each ringed in
`--sui-avatar-ring` (default the page background, `--bg`); a host on a card
surface sets it to `var(--surface)`.

An avatar's color is a lane picked by hashing its `id` with FNV-1a, so one
person has one color everywhere. Lanes
paint with the host's `--lane-0` to `--lane-5` and `--avatar-ink` when it
defines them, and with the theme's danger, info, muted, warning, brand and
success hues otherwise, which follow light and dark.

`ShareDialog` is a Radix `Dialog` titled `title`, with no close button: Done,
Escape and a click outside call `onOpenChange(false)`. Top to bottom:

- The add row: an `Add people` input, an access select (`Can view`, the default,
  or `Can edit`) and `Share`. `Share` and Enter call `onAdd` with the trimmed
  text, only while it isn't blank, then clear the input and keep focus there.
- `error`, a `role="alert"` paragraph that describes the input.
- `People with access`: a row per person with the same avatar as
  `AvatarStack`, the name (`<name> (you)` for `self`), and `Owner` for the owner,
  else an access select named `Access for <name>` and `Remove`, named
  `Remove <name>`. A `pending` person's select and `Remove` are disabled.
- `General access`: a select between `Restricted` and `groupLabel`, named by
  that heading; choosing the group calls `onGeneralChange("view")`. Past
  `Restricted`, a `Link access` select picks `view` or `edit`.
- `Copy link`, a `CopyButton` that copies `link` through `copyText`, and `Done`.

`avatarStackCss` and `shareDialogCss` are part of `smithersUiCss`.

## Web pages

An outside web page, framed or as a card that opens a new tab. See
[show a web page](./guides/show-a-web-page.md).

```ts
function WebPageView(props: WebPageViewProps): JSX.Element
function WebLinkCard(props: WebLinkCardProps): JSX.Element
function webPageTarget(url: string, hostOrigin?: string): WebPageTarget | null
function framedPageTarget(url: string, hostOrigin?: string): WebPageTarget | null

const WEB_PAGE_SANDBOX: "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
const webPageCss: string

type WebPageViewProps = Omit<ComponentProps<"figure">, "children" | "title" | "ref" | "dangerouslySetInnerHTML"> & {
  url: string
  size?: "inline" | "full"     // default "inline"
  title?: string               // the frame's title; default `Web page from ${host}`
  actions?: ReactNode          // in the bar, before Open in new tab
  preview?: WebPagePreview     // covers the frame until it loads
}

type WebLinkCardProps = Omit<ComponentProps<"section">, "children" | "ref" | "dangerouslySetInnerHTML" | "title"> &
  WebPagePreview & {
    url: string
    openLabel?: string         // default "Open in new tab"
    onOpen?: () => void        // on click or Enter; never prevents it
  }

type WebPagePreview = { readonly title?: string; readonly description?: string; readonly icon?: string }
type WebPageTarget = { readonly href: string; readonly origin: string; readonly host: string }
```

`WebPageView` renders a `figure` (`data-slot="web-page-view"`, `data-size`,
`data-state` `loading` or `loaded`): a `figcaption` with the origin
(`web-page-origin`), `actions` and an `Open in new tab` link
(`web-page-open`), then the `iframe` (`web-page-frame`) with `sandbox` set to
`WEB_PAGE_SANDBOX`, `referrerPolicy="no-referrer"`, `loading="lazy"` and no
`allow` attribute. Until the frame's `load` event, the page's preview
(`web-page-pending`, `aria-hidden`) covers it, fading in after 600 ms; a new
`url` covers it again. `inline` is 28rem high; `full` fills its container.

`WebLinkCard` renders a `Card` (`web-link-card`) with the page's preview and
an anchor styled as a `Button` (`web-link-open`): `Open in new tab` and a
`↵` key (`aria-keyshortcuts="Enter"`), named `Open in new tab: <title or
host>`. The preview (`web-page-preview`) is the icon (`web-page-icon`: the
`https:` `icon`, else the host's first letter, also when the image fails to
load), the title (`web-page-title`), the description
(`web-page-description`) and the domain (`web-page-domain`): the host for an
`https:` page, the whole origin for any other. Without a title, the domain is
the title and isn't repeated. Blank text counts as none. Both links have
`target="_blank"` and `rel="noopener noreferrer"`.

`webPageTarget`, `WebLinkCard`'s guard, accepts only an absolute `https:` or
`http:` URL with no credentials, and refuses one on `hostOrigin`.
`framedPageTarget`, `WebPageView`'s guard, also refuses `http:` and every page
on the site of `hostOrigin` (its last two labels, or the hostname for an IP
address or a single label); under a public suffix such as `pages.dev` that
over-refuses. An unknown host origin refuses framing, including during SSR;
an explicitly opaque origin (`"null"`) shares no host site. Both components pass `window.location.origin` and, on `null`,
render `EmptyState` titled `Can't show this page` with `data-refused="true"`
and no frame or link. `webPageCss` is part of `smithersUiCss`.

## Docs pages

One page of a docs site, read from its Markdown. See
[show a docs page](./guides/show-a-docs-page.md).

```ts
function DocsPageView(props: DocsPageViewProps): JSX.Element
function docsPageTarget(url: string): WebPageTarget | null
const docsPageCss: string

type DocsPageViewProps = Omit<ComponentProps<"article">, "children" | "title" | "ref" | "dangerouslySetInnerHTML"> & {
  title: string                 // the heading
  url: string                   // the page on its docs site
  text: string                  // the page's Markdown
  truncated?: boolean           // a `Shortened` line after the text
  size?: "inline" | "full"      // default "inline"
  headingLevel?: 1 | 2 | 3      // default 2
  actions?: ReactNode           // in the bar, before Open on site
  onLinkClick?: MarkdownLinkClick
}
```

`DocsPageView` renders an `article` (`data-slot="docs-page-view"`,
`data-size`): a bar with the site's origin (`docs-page-origin`), `actions` and
an `Open on site` link (`docs-page-open`, `target="_blank"`,
`rel="noopener noreferrer"`), then the title as a heading and the text as
`Markdown variant="document"` with `baseUrl` set to the page, so relative
links open on the docs site and no HTML in the text becomes an element.
`truncated` adds `Shortened` (`docs-page-truncated`). `inline` bounds the body
to 28rem and scrolls it; `full` fills its container. `docsPageTarget` accepts
an absolute `https:` or `http:` URL with no credentials; on `null` the view is
`EmptyState` titled `Can't show this page` with `data-refused="true"`.
`docsPageCss` is part of `smithersUiCss`.

## Agent status

What the agent is doing, and whether it needs the person (apps/mvp decision
0015). Five states, one word and glyph each: `working` (`◌ Working`, brand,
pulsing), `waiting` (`○ Waiting`, quiet), `needs_you` (`◆ Needs you`, gold:
`--warning`), `failed` (`✕ Failed`, ember: `--danger`) and `done` (`✓ Done`).

| Export | Props type | Notes |
| --- | --- | --- |
| `AgentStatusPill` | `AgentStatusPillProps` | `state`, `count` (shown above 1), `onClick` (renders a button), `label` (the button's name). Host props, including refs and event handlers, reach the rendered span or button. `data-slot="agent-status"`, `data-state`. |
| `NeedsYouCard` | `NeedsYouCardProps` | `kind` (`question` or `approval`), `prompt`, `options`, `value` and `onValueChange` (the app keeps the draft), `onAnswer` (the words or option, or `true` for Approve and `false` for Deny), `sending`, `answered` (collapses to the answer), `focusRequest` (each new value focuses the field and scrolls the card into view), `compact` (only the controls, `data-compact`: no pill, no box, the prompt for screen readers only, where the question shows already). |
| `ToastStack`, `Toast` | `ToastStackProps`, `ToastProps` | The stack is a polite live region, `max` toasts (3) then `+N`. With `onMore`, `+N` counts the toasts past `max` plus `moreCount` and calls `onMore` (`aria-haspopup="dialog"`, `data-notifications-trigger`), such as to open a `NotificationPanel`. Without it, `more` holds the person's other entries, shown only while expanded, after the toasts: `+N` counts the toasts past `max` plus the `more` entries; expanded, it reads `Less` (`aria-expanded`) and collapses the stack. `+N` shows even with no toasts; the stack renders nothing with nothing to show. `placement` `fixed` (the default) floats at the bottom-left, full width on a phone; `inline` sits where it is rendered, such as above a composer. Alt+T focuses its first toast from anywhere; arrows, J and K, Home and End move between toasts; Escape gives focus back. A toast has a `tone` (a notice state), `word` (shown in bold in place of the state's word), a one-line `detail`, at most one `action`, optional Hide (`onHide`, named by `hideLabel`, default `Hide`; omitted together with its H shortcut when no handler is supplied), `unread` (`data-unread`, a brand dot and `Unread` for screen readers), and `delayed`, which fades it in after 300 ms. With `onOpen` its words are one button (`data-slot="toast-open"`) that opens what it is about. Focused, it takes O (`onOpen`), E (`onExpand`), A (`onAnswer`), H (`onHide`) and R (`onRead`). |
| `NotificationPanel` | `NotificationPanelProps` | The person's notifications at the window's top-right, full width on a phone: a non-modal dialog (`data-slot="notification-panel"`) with a heading (`label`, default `Notifications`), ×, and its entries in a list that scrolls, or `No notifications`. Controlled by `open` and `onOpenChange`. Alt+N toggles it from anywhere while it is mounted. Opening focuses `focus`'s entry or the first; arrows, J and K, Home and End move between entries; Escape, × or a pointer down outside it close it and give focus back. A pointer down inside an element marked `data-notifications-trigger` isn't outside. |
| `NotificationEntry` | `NotificationEntryProps` | One notification (`data-slot="notification"`, `data-entry`, `data-tone`, `data-unread`, `data-expanded`): a row button with the unread dot, glyph, word, detail and `time`, and × (`onHide`, `hideLabel`). Clicking the row, Enter or Space toggles `expanded` (`onExpandedChange`); expanded, the body shows the whole detail, `meta`, the last `steps` (`NotificationStep`: `running`, `done`, `failed`), a `note`, `children`, then `actions` and Open (`onOpen`, `openLabel`). The focused row takes O, E, A (`onAnswer`), H and R (`onRead`). |
| `NotificationBell` | `NotificationBellProps` | The top bar's one way in to the person's notifications: a bell button that opens the panel. `unread` shows as a count (`99+` past 99); `needsYou`, above 0, adds `◆ Needs you` in gold (`data-needs-you`, the count above 1); both are in its name (`Notifications: 1 needs you, 3 unread`). `expanded` is its `aria-expanded`; `aria-keyshortcuts="Alt+N"`, `data-notifications-trigger`. |
| `NOTICE_KEYS`, `noticeKeyAction(event)`, `isNoticeHotkey(event, hotkey)`, `isTypingTarget(target)` | `NoticeKeyAction`, `NoticeKeyEvent` | The keys notices answer to: Alt+T (`toasts`), Alt+N (`notifications`), O, E, A, H and R. `noticeKeyAction` maps a key to `open`, `expand`, `answer`, `hide`, `read`, `next`, `previous`, `first`, `last` or `close`; any key held with Alt, Ctrl or ⌘ is none. `isNoticeHotkey` reads Alt+T and Alt+N by the key's `code`. `isTypingTarget` says a field keeps its letters. |
| `AGENT_STATES`, `AGENT_STATUS_WORDS`, `AGENT_STATUS_GLYPHS`, `isAgentState` | `AgentState` | The vocabulary, most urgent first. |
| `NOTICE_WORDS`, `NOTICE_GLYPHS` | `NoticeState` | A notice's states: the agent's five plus `update` (`● Updated`, muted), an event such as a repository's main moving. |
| `noticeDismissDelay(state)` | `NoticeState` | Milliseconds a toast shows before it hides on its own: 4000 for `done` and `update`, `Infinity` for the rest. |
| `workNoticeVisible(notice, nowMs)` | | Whether a notice's toast shows (decision 0009 §4): `open`, not `hidden`, and `nowMs < updatedAtMs + noticeDismissDelay(state)`. Pure, so a view keeps no timers. |
| `agentStatusTitle(base, count)` | | The tab title: `(2) Smithers` while 2 runs need the person. |
| `answerText(answer)` | `NeedsYouAnswer` | An answer as it reads: the words, `Approved` or `Denied`. |

`agentStatusCss` is part of `smithersUiCss`.

`NeedsYouKind` is `"question" | "approval"`, the `kind` of a `NeedsYouCard`.

## Runs and flows

A run's page and the card a flow is drafted in (apps/mvp decision 0014). The
host reads the run, redacts and clips each value; these components only show
what they are given, as text. See [show a run](./guides/show-a-run.md).

| Export | Props type | Notes |
| --- | --- | --- |
| `JsonValue` | `JsonValueProps` | `value` (`JsonValueData`: `text`, `bytes` before any clip, `clipped`), `label`, `defaultOpen`. A `<details>` (`data-slot="json-value"`, `data-clipped`) named by the label and size, with a `Clipped` marker; the text in a `<pre>`, pretty-printed when it is whole JSON. Never rendered as markup. |
| `RunHeader` | `RunHeaderProps` | `title`, `state`, `cancelRequested`, `word` (an override such as `On another device`), `startedAtMs`, `finishedAtMs`, `now`, `host`, `actions`, `headingLevel` (1 to 3, default 1). One line: title, the status pill in a polite `role="status"` live region, the elapsed clock (`aria-label="Elapsed"`) and the host. |
| `RunList` | `RunListProps` | `runs` (`RunRow`: `id`, `flow`, `state`, `cancelRequested`, `startedAtMs`, `finishedAtMs`, `href`, and optionally `trigger`, `branch`, `actor`, `where`, `toggleHref`, `expanded`), `now`, `renderLink(href, children)` (the router's link; a plain `<a>` takes only an href `safeHref` passes), `empty` (default `EmptyState` titled `No runs`), `renderDetails(run)` (an expanded run's details, full width under its row). A table labelled `Runs`, like a CI system's runs: flow (with a `where` tag), status, then trigger, branch and actor once any row has them, started, duration; a row with `toggleHref` gets a toggle labelled `Show <flow>` or `Hide <flow>`. |
| `RunDetails` | `RunDetailsProps` | `jobs` (`RunDetailsJob`: `id`, `label`, `state`, `href`, `steps`; `RunDetailsStep`: `id`, `label`, `state`, `startedAtMs`, `endedAtMs`, `error`, `logs` (a count)), `now`, `renderLogs(job, step)`, `renderLink(href, children)`, `empty`. A run's jobs and their steps, like a CI run's: each step a native disclosure that opens to its log lines (`No logs` without), a failed step open with its error code. |
| `RunStatusPill` | `RunStatusPillProps` | `state`, `cancelRequested`, `word`. A `Badge` (`data-slot="run-status"`, `data-state`, `data-word`) with the word's glyph and tone. |
| `SpanTree` | `SpanTreeProps` | `steps` (`StepRow`), `selected`, `onSelect`, `now`. A listbox labelled `Steps`, one option per step indented by `depth`: glyph, label, `N attempts` above one, duration. One row takes Tab; arrows, Home and End move; Enter, Space or a click selects. |
| `SpanDetail` | `SpanDetailProps` | `label`, `state`, `attempts` (`AttemptRow`), `input` and `output` (`JsonValueData` or `null`; open), `wait` (`WaitData`: `kind`, `sinceMs`, `wakeAtMs`), `now`, `actions`. Attempts read `1 ✕ unavailable · 2 ✓`. |
| `RunWaterfall` | `RunWaterfallProps` | `steps`, `now`, `selected`, `onSelect` (each bar becomes a button). A list labelled `Timeline`: one bar per step on one axis; an open step runs to `now`, an instant step is a marker. |
| `RunJournal` | `RunJournalProps` | `events` (`JournalRow`: `seq`, `eventType`, `emittedAtMs`, `payload`), `originMs` (default the first record's time), `hasMore`, `onMore` (`More`). A table labelled `Journal`: seq, type, time from the origin, payload collapsed. |
| `FlowDraftView` | `FlowDraftViewProps` | `where`, `name`, `request`, `status` (`DraftStatus` or `null` for the form), `round`, `questions` (`DraftQuestion`: `id`, `text`, `assumed`, `blocking`, `answer`), `answers` (the person's unsent answers; the app keeps them), `files`, `checks` (`DraftCheck`), `failure` (why it failed, in a few words), and `onNameChange`, `onRequestChange`, `onStart` (`Draft`), `onAnswerChange`, `onAnswer` (`Answer`, on while `answersToSend` has something to send), `onRetry` (`Draft again`), `onSave` and `saveDisabled` (`Save`), `onTry` (`Try`), `onPropose` (`Propose`), `onDelete` (`Delete`). A button shows only with its handler. Inputs are labelled `Name`, `What it should do` and each question's text; the status line is a polite `role="status"`. |

The pure helpers the components use, for a terminal or a test:

| Export | What it does |
| --- | --- |
| `runWord(state, { cancelRequested })` | `pending` → `Queued`, `running` → `Working`, `suspended` → `Waiting`, each `Stopping` once a stop is requested; `completed` → `Done`, `failed` → `Failed`, `cancelled` → `Stopped`. |
| `RUN_WORDS`, `RUN_WORD_GLYPHS`, `RUN_WORD_TONES`, `isSettled` | The closed vocabulary (`RunWord`), adding `On another device`, `Expired` and `No access`; a glyph and a badge tone per word. `Failed` and `No access` are ember; `Done` is success; `Working` is brand and pulses; the rest are quiet. |
| `STEP_GLYPHS`, `STEP_WORDS` | A step's state (`StepState`: `running`, `completed`, `failed`, `waiting`, `skipped`) as a glyph and a word. |
| `clockDuration(ms)`, `stepDuration(ms)`, `untilWords(atMs, now)`, `offsetWords(atMs, originMs)`, `stepElapsed(step, now)` | `0:42` and `1:02:03`; `12 ms`, `1.2 s`, `42 s`, then a clock; `in 8 s`; `+1.2 s`; a step's elapsed time, to `now` while open. |
| `waterfallBars(steps, now)`, `waterfallAxis(steps, now)` | Each step's bar (`WaterfallBar`: `left` and `width` in percent, `instant`, `open`) on the shared axis. A zero-width axis makes every bar a marker at the start. |
| `attemptWords`, `waitWords` | One attempt (`2 ✓`, `1 ✕ unavailable`); a wait (`timer · since 10s ago · wakes in 1 m`). |
| `jsonValueText`, `formatBytes` | A value's text as shown; `512 B`, `1.5 KB`, `16 KB`. |
| `draftStatusLine`, `questionValue`, `isAssumed`, `changedAnswers`, `answersToSend` | `◌ Drafting · round 2`, `◆ Needs you`, `✓ Ready`, `✕ Failed`, `✓ Saved`, `✓ Proposed`; what a question's field shows; whether it shows the assumed default; the answers that change the draft; what Answer sends: the changed answers and each unanswered blocking question at the value its field shows (its default until a person types), never an empty field. |

`jsonValueCss`, `runPageCss` and `flowDraftViewCss` are part of `smithersUiCss`.

`RunState` is `"pending" | "running" | "suspended" | "completed" | "failed" | "cancelled"`.
`RunTone` is `"default" | "muted" | "warning" | "destructive" | "success"`,
the value selected by `RUN_WORD_TONES`. `DraftFile` is the immutable
`{ path: string, text: string }` file in a flow draft.

## Repository home

The sections a repository declares in `.smithers/home.json`, as `Home.read`
from `@smthrs/views` answers them, or a host's curated home (apps/mvp decision
0014). See [show a repository home](./guides/show-a-repository-home.md).

```ts
function RepositoryHome(props: RepositoryHomeProps): JSX.Element | null

const repositoryHomeCss: string

type RepositoryHomeFile =
  | { readonly state: "loading" }
  | { readonly state: "text"; readonly text: string }
  | { readonly state: "failed" }

type RepositoryHomeProps = Omit<ComponentProps<"section">, "children"> & {
  sections: ReadonlyArray<Home.Section>                  // from @smthrs/views: the ones the viewer may see
  files?: Readonly<Record<string, RepositoryHomeFile>>   // by path; absent shows as loading
  askHref?: string | ((flow: string | undefined) => string) // resolve each flow's native URL; without it none draws
  onAsk?: (flow: string | undefined) => void             // a plain click: default prevented, the host navigates
  offered?: (flow: string) => boolean                    // an app or action block draws only when true; default none
  live?: RepositoryHomeLive                              // the live blocks' rows; a live block without them doesn't draw
  onNavigate?: (href: string) => void                    // a plain click on a link in the app
  onCopy?: (text: string) => void | Promise<void>        // Copy, the host's way; default the browser's clipboard
  onRun?: (flow: string) => void                         // an action block's button or key; without it none draws
  running?: ReadonlyArray<string>                        // action flows running: disabled, their keys idle
}

type RepositoryHomeLive = {
  issues?: RepositoryHomeIssues | RepositoryHomeNotice   // { proposed, accepted, notAccepted, triage, pulls, href }
  stack?: RepositoryHomeList | RepositoryHomeNotice      // { entries, total, href? }
  runs?: RepositoryHomeRuns | RepositoryHomeNotice       // the list and how many failed
  flows?: ReadonlyArray<RepositoryHomeFlow>              // { flow, name, title }
}

type RepositoryHomeEntry = { key: string; label?: string; title: string; href: string; status?: { status: string; label: string }; at?: number }
type RepositoryHomeNotice = { notice: string }
```

`RepositoryHome` renders a `section` (`data-slot="repository-home"`) holding a
`section` per given section with something to draw
(`repository-home-section`, `data-audience`, named by its title), headed by
its `<h2>` title and its audience's label, `Contributors` or `Maintainers`,
with leading action blocks in the heading. Each drawn block is a `div`
(`repository-home-block`, `data-kind` its `type`) under its optional `title`
as an `<h3>`. `hero` is the name as a large `<h2>`, a tagline, a line, up to
three links (the first primary) and the install command with Copy; `code` a
`<figure>` with Copy, colored for TypeScript, JavaScript and VibeLang, beside a
`hero` right before it; `cards` a grid of cards (`<h4>`); `stats` a `<dl>`;
`releases` a list of links with `<time>` dates; `text` a pre-wrapped paragraph,
never markup; `links` links with `target="_blank"` and
`rel="noopener noreferrer"`, absolute `http` and `https` only; `markdown` a
spinner named `Loading <path>`, `Markdown variant="document"`, or the status
line `Couldn't read <path>`; `prompt` a band with a link to `askHref`; `app` a
`Button asChild variant="outline"` link with `data-picture`, adjacent ones in
one row (`repository-home-apps`); `action` a primary button that calls
`onRun(flow)`, its key in a `<kbd>` and `aria-keyshortcuts`, pressed by that
key anywhere while the person isn't typing; and the live blocks the rows in
`live`, `stack` and `runs` sharing one grid (`repository-home-panels`), a
notice as the block's heading and one status line. Copy buttons show and
announce `Copy failed` on failure and `Copied` on success. Use an `askHref`
resolver to preserve a selected flow in native navigation. With `onAsk` or
`onNavigate`, a plain click prevents its default and calls it; a modified or
non-primary click keeps the browser's behavior. `view` is not drawn yet. When
nothing draws, it renders `null`. `repositoryHomeCss` is part of
`smithersUiCss`.

```ts
type LinkTabsProps = ComponentProps<"nav">
function LinkTabs(props: LinkTabsProps): JSX.Element
```

`LinkTabs` is a row of page tabs that are links, such as a repository's Home
and Code: a `<nav>` (`data-slot="link-tabs"`) whose child links, the host's
router's own, draw as tabs, the one with `aria-current="page"` underlined.
Name it with `aria-label`.

```ts
type FileTab = { key: string; label: string; title?: string; href: string; active: boolean }
type FileTabsProps = Omit<ComponentProps<"div">, "children" | "role"> & {
  tabs: ReadonlyArray<FileTab>
  onOpen: (tab: FileTab) => void
  onClose: (tab: FileTab) => void
  onFocusLifecycle?: (event: FileTabsFocusEvent) => void
}
function FileTabs(props: FileTabsProps): JSX.Element | null
```

`FileTabs` is a strip of open files above a code view, as an editor's tabs. Each
tab is a link (`role="tab"`, `aria-selected` on the active file) with a close
button. A plain click, Enter or Space calls `onOpen`; a modified or middle click
is the browser's. ←, →, Home and End move focus between tabs; Delete or
Backspace calls `onClose` and focuses the tab that takes its place. A strip hidden
by a pending route restores its focused tab when revealed, unless another control
has focus. Only the
active tab, else the first, is in the Tab order. It holds no state, and renders
nothing without tabs. The tablist is named "Open files" unless `aria-label` says
otherwise. `onFocusLifecycle` reports content-free `{ phase, reason }` diagnostics:
`requested` and `consumed` for keyboard movement or Suspense restoration, and
`dropped` when the strip detaches or another control owns focus. Reasons are
`keyboard`, `restored`, `disconnected`, or `outside`; no file identity is included.

## TODOs and the stack

A TODO's private draft, which a person edits and commits (apps/mvp decision
0016 §3). A repository's stack is an `IssuesView` (`ordered`, `numberPrefix="T"`,
`filter`), and one TODO an `ItemConversation`. See
[show a stack](./guides/show-a-stack.md).

```ts
function TodoDraftCard(props: TodoDraftCardProps): JSX.Element

type TodoDraftCardProps = Omit<ComponentProps<"form">, "children" | "onSubmit" | "title"> & {
  repo?: string
  source?: string                              // where it came from, such as its issue #12: a chip
  title: string
  prompt: string
  acceptance?: ReadonlyArray<string>           // read only
  onTitleChange: (title: string) => void
  onPromptChange: (prompt: string) => void
  onCommit: () => void
  onDiscard: () => void
  committing?: boolean                         // disables Commit
  refused?: string                             // a chip, such as Stack full
  maxTitleLength?: number                      // default 120
}
```

`TodoDraftCard` renders a `form` (`data-slot="todo-draft-card"`) named
`TODO draft`: a header with `Draft`, a muted `Only you` badge, an outline
`source` chip and `repo`; a labelled `Title` input (`maxLength`) and `Prompt`
textarea; the acceptance criteria; then `Commit` (submit) and `Discard`
(ghost). Commit is disabled while `committing`, when the trimmed title or prompt
is empty, or when the title is longer than `maxTitleLength`. Submitting, Enter
in the title, and ⌘Enter or Ctrl+Enter in the prompt always prevent the default
and call `onCommit` only while Commit is enabled. `refused` is a destructive
`role="alert"` chip.

`todoDraftCardCss` is part of `smithersUiCss`.

## Menus and confirmations

A quiet menu of actions, and a button that asks before it acts. Both confirm in
the same dialog.

```ts
function ActionMenu(props: ActionMenuProps): JSX.Element
function ConfirmButton(props: ConfirmButtonProps): JSX.Element

type ActionConfirm = { title: string; description?: string; action: string }
type ActionMenuItem = { label: string; onSelect: () => void; destructive?: boolean; confirm?: ActionConfirm }

type ActionMenuProps = Omit<ButtonProps, "children" | "onSelect"> & {
  label: string                                 // the trigger's name, such as `T4 actions`
  items: ReadonlyArray<ActionMenuItem>
}

type ConfirmButtonProps = Omit<ButtonProps, "onClick" | "children"> & {
  children: ReactNode
  confirm: ActionConfirm
  onConfirm: () => void
  destructive?: boolean                         // the dialog's action is destructive
}
```

`ActionMenu` is a ghost `⋯` icon button (`data-slot="action-menu-trigger"`)
that opens a Radix menu (`data-slot="action-menu"`) of `menuitem`s; Enter,
Space and ArrowDown open it on its first item, and Escape closes it. A
`destructive` item carries `data-destructive`. An item without `confirm` runs
`onSelect` at once. One with `confirm` opens a dialog: `confirm.title`,
`confirm.description`, `Cancel` (focused) and `confirm.action`, destructive or
default. Only the action runs `onSelect`, once, and focus returns to the
trigger; `Cancel`, Escape or a click outside run nothing.

`ConfirmButton` is a `Button` (`data-slot="confirm-button"`) whose press opens
the same dialog; only its action runs `onConfirm`.

`actionMenuCss` is part of `smithersUiCss`.

`NotFoundProps` supplies optional `title` (default `"Not found"`) and required
`back: ReactNode`, the recovery link rendered by `NotFound`.

## Related

- [Failure codes and limits](./reference/contracts.md): the codes and bounds
  referenced throughout this page.
- [The adapters boundary](./concepts/adapters.md): what the adapter
  subpaths cost.
- [Troubleshooting](./troubleshooting.md): symptoms and fixes.

## Clipboard (`@smthrs/ui/copy`)

This isolated entry point exports `copyText`, `canCopyText`, `reserveCopyText`, `CopyResult`, and `CopyFailureCode` without importing Vault or autosave. Views import `copyText` from this subpath. The root export remains available. See [clipboard contracts](./reference/contracts.md#clipboard).

`canCopyText(): boolean` reports whether the browser offers Clipboard
`writeText` or the `execCommand` fallback. It does not guarantee permission.
`reserveCopyText()` reserves native clipboard activation synchronously, before
asynchronous admission. It returns `{ copyText(text): Promise<void>, release(): void }`
or `undefined` when ClipboardItem/write is unavailable. Copy the admitted text;
call `release()` if admission is refused. The copy promise reports clipboard
failure.

### Read-only run graphs

`FlowGraphProps` replaces `<div>` children and `onSelect` with required
`nodes: ReadonlyArray<GraphNode>` and `edges: ReadonlyArray<GraphEdge>`, plus
optional `selected: string | null`, `onSelect(id)` and `onInspect(id)`.
`FlowGraph` takes these props. Nodes use the canonical monitor's `next`, `current`, `done`, `failed`, `waiting`, `cancelled` and `skipped` states. Edges optionally carry the recorded `value`, `continuation` or `failure` reason; an unknown reason remains unspecified. Arrow keys follow dependencies, Enter or `i` inspects, and the canvas supports pan, zoom and fit. `graphLayout` and `fitGraph` are pure, deterministic longest-path/barycenter layout functions. The layout follows the approved small-DAG exception: there is no catalogued layout library, and adding a second node-state store is unnecessary for tens of nodes.

| Export | Contract |
| --- | --- |
| `GraphDirection` | `"LR" \| "TB"`; left-to-right or top-to-bottom layout. |
| `GraphPosition` | Immutable `{ id: string, x: number, y: number }`. |
| `GraphLayout` | Immutable `nodes: ReadonlyArray<GraphPosition>`, ranked id arrays in `ranks`, `width`, `height` and `direction`. |
| `graphNeighbour(nodes, edges, selected, forward)` | Follow a dependency, else the adjacent node in list order; `undefined` for an empty list. |
| `StepInspectorProps` | `<section>` attributes without children, plus required `step`, `input`, `output`, `logs`, `attempts`, `now`, and optional `wait` and `actions`. |
| `StepLogLine` | A parsed `record` with time, level, message, fields, error and attempt; an `attempt` marker; or a `text` line. Returned by `stepLogLines`. |
| `JournalTick` | Immutable `{ seq: number, emittedAtMs: number, eventType: string }`. |
| `JournalScrubberProps` | `<div>` attributes without children or `onChange`, plus `events: ReadonlyArray<JournalTick>`, `at: number \| null` and `onChange(at)`. |

`StepInspector` accepts a `StepRow`, redacted `input`, `output`, `logs`, `attempts`, `now` and optional wait/actions. Its tabs are Output, Input, Logs and Attempts. It renders input and output through `JsonValue` and the Logs tab through `StepLogs`, and never executes them.

`StepLogs` (`StepLogsProps`: `lines: ReadonlyArray<JsonValueData>`, `now: number`, plus `<ol>` attributes) reads a step's log like a CI log. Each line is a `telemetry.log` payload (`@smthrs/journal`'s `TelemetryLog.Log`) or printed text. A record shows its time (with the day when it isn't `now`'s), its level, its message, then `key=value` fields from a structured message part and its annotations, the engine's attribution (`runId`, `stepKeyDigest`, `stepKey`, `attempt`, `tier`) left out; a record's failure follows on its own line. Records from more than one attempt start each attempt with `Attempt N`. Anything else shows as its text. An empty log renders nothing. `stepLogLines` and `stepLogTime` are the same projection without React, for a terminal. `JournalScrubber` accepts ordered journal ticks, a nullable `at` and `onChange`; null follows live. `journalPosition` moves through sparse event sequences or recorded step boundaries. Selection and replay position belong to the host, so plugins need no private interface.

`RunWaterfall` additionally accepts `cursorMs` and `segments` (`stepId`, `startedAtMs`, `endedAtMs`, `state`). Waiting segments are hatched; failed segments use the failure color. Nested rows use the existing `StepRow.depth`. Existing callers retain their behavior.

Repository hero install commands preserve one line and scroll inside their code field. The field accepts keyboard focus; Copy remains beside it at phone widths.

`NotificationEntry.onActivate` makes the row open its subject directly; Details and E expand it. O and the body's Open button require `onOpen`; omit it when there is no destination.
