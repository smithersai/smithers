# Library change requests from the apps/ui flow port

`packages/*` was read-only for this port. Each entry below is a place where the
app took a workaround instead of changing a library. Will approves library
changes personally.

## 1. CLOSED: `FlowBinding` public refusals and opaque failures

- **File**: `packages/smithers/agent/harness/src/FlowBinding.ts`
- **Current contract**: unknown handler failures return `Flow <name> failed.`.
  A binding may explicitly publish safe text with `publicError`, which returns
  `Flow <name> failed: <public text>`. Raw diagnostic causes stay host-side.
- **App binding**: `flows/entries/Declare.ts` opts returned refusal strings into
  `publicError` and preserves thrown causes for host inspection without exposing
  them to cells or journals.
- **Workaround retained**: `flows/Commands.ts` uses `unframe(name, message)` to
  strip the exact `Flow <name> failed: ` prefix from public refusals and map
  the bare `Flow <name> failed.` form to `/<name> failed` for humans. Other
  messages pass through. This still depends on the library's framing text.
- **Resolution**: the proposed raw handler-message field is withdrawn because
  it would bypass the explicit disclosure boundary. Any future structured
  detail field must contain only text selected by `publicError`.

## 2. The cell loop's capability envelope refuses any host capability vocabulary

- **Files**: `packages/smithers/agent/harness/src/CellTurn.ts` (the screen at ~line 353) and
  `packages/smithers/flows/capability/src/Capability.ts` (`parse`, `Action`).
- **What**: before dispatching a cell's flow call, `CellTurn` filters the
  descriptor's declared capabilities:

  ```ts
  const refused = descriptor.capabilities.filter((declared) =>
    Option.match(Capability.parse(declared), {
      onNone: () => true, // <- unparseable ⇒ refused
      onSome: (capability) => !CapabilitySet.allows(envelope, capability)
    })
  )
  ```

  `Capability.parse` recognizes only a closed action set — `fs:read`,
  `fs:write`, `net:get`, `net:post`, `model:call`, `proc:spawn`, and the `jj:*`
  operations — and requires a `namespace:operation:resource` shape. Any other
  claim string parses to `None` and takes the `onNone: () => true` branch, so it
  is refused no matter how wide the run's envelope is. There is no envelope
  value, including `{ action: "*", resource: "**" }`, that admits it.
- **Why it matters here**: every flow in this app claims the vocabulary that
  carries DESIGN.md §14's three-tier approval policy — `app:act` (free),
  `session:net-read` (asks once per session), `outbound:launch` (always asks),
  `approve:self` (structurally denied to the agent). These are policy tiers
  about the app's own surface; they have no honest `fs:`/`net:`/`proc:`
  equivalent, and re-labelling `flow.create` as `net:post` would both
  misdescribe it and discard the tier the policy keys on. Under the cell loop
  every app flow is therefore refused, which is what blocks swapping
  ChainRuntime for `CellTurn`/`CellHarness`.
  `apps/ui/src/mainview/chain/AppEngine.test.ts` pins this as a passing test.
- **Workaround taken**: none that preserves the policy. The agent loop stays on
  ChainRuntime, whose `Catalog` carries capability strings opaquely and lets
  `chain/Policy.ts` decide the tier. Declaring the app's flows with empty
  `capabilities` would let the cell loop run, but it would silently drop the
  approval policy, so it was not done.
- **Proposed diff sketch**: let the host supply the vocabulary rather than
  hard-coding it. The smallest version keeps `Capability.parse` as the default
  and makes the unparseable branch a host decision:

  ```diff
   export interface Options {
     ...
  +  /**
  +   * Screens a declared capability the capability package cannot parse.
  +   * Defaults to refusing, which is today's behaviour.
  +   */
  +  readonly admitForeignCapability?: ((claim: string) => boolean) | undefined
   }
  ```

  ```diff
   const refused = descriptor.capabilities.filter((declared) =>
     Option.match(Capability.parse(declared), {
  -    onNone: () => true,
  +    onNone: () => !(input.admitForeignCapability?.(declared) ?? false),
       onSome: (capability) => !CapabilitySet.allows(envelope, capability)
     })
   )
  ```

  A host that says nothing keeps the current strict behaviour; this app would
  admit its four policy claims and keep enforcing their tiers where it already
  does. A larger alternative — extending `Capability.Action` with an
  application-defined namespace — would also work but changes a security-
  relevant closed set, so the host-callback version is proposed first.

## 3. LANDED: `ChatComposer` and `FileTree` accept no pass-through attributes

- **Files**: `@smthrs/ui` `src/chat/ChatComposer.tsx` (the Send and Stop
  buttons) and `src/file-tree.tsx` (the row buttons).
- **What**: both components render their own `<Button>`s from fixed props.
  `ChatComposerProps` carries `submitLabel` / `stopLabel` but no
  `submitProps` / `stopProps`; `FileTree` takes `nodes` and `onSelect` and
  offers no per-node attribute hook.
- **Why it matters here**: the launch law is that every visible affordance
  names the flow behind it, and `data-flow` is how it says so — the launch
  checklist (§6.1), the slash listing and the agent's own manifest all read
  that attribute. Send, Stop and the world file-tree rows ARE registered flows
  (`send`, `chat.stop`, `world.select`), so they were affordances that ran a
  flow while denying they had one.
- **Workaround taken**: `apps/ui/src/mainview/FlowStamp.ts` stamps `data-flow`
  from the host through a React ref callback at the mount point. It is
  idempotent and never overrides an attribute the element already carries, but
  it reaches into a component's rendered DOM from outside — the exact coupling
  a pass-through prop exists to prevent.
- **Proposed diff sketch**:

  ```diff
   export type ChatComposerProps = Omit<ComponentProps<"form">, "onSubmit"> & {
     submitLabel?: string
     stopLabel?: string
  +  /** Extra attributes for the Send button (e.g. a host's `data-*` binding). */
  +  submitProps?: ComponentProps<"button">
  +  /** Extra attributes for the Stop button. */
  +  stopProps?: ComponentProps<"button">
   }
  ```

  and the same shape on `FileTree` as `nodeProps?: (node: FileTreeNode) =>
  ComponentProps<"button">`.
- **Landed**: `submitProps` / `stopProps` on `ChatComposerProps` and
  `nodeProps` on `FileTreeProps`, pinned by
  `packages/smithers/ui/tests/host-pass-through.test.tsx`. Anything the host sets wins
  over the component's own attribute of the same name, so a host can also
  correct one. `apps/ui/src/mainview/FlowStamp.ts` dropped its ref callback
  for these three affordances on 2026-09-09: the composer passes
  `submitProps`/`stopProps` and the Wiki tree passes `nodeProps`. What is left
  in that file is the Wiki graph's node buttons and the Wiki rail's outline and
  backlink rows, which have no pass-through yet.
- **Landed (2026-09-02, sidebar tree lane)**: `FileTree` also takes
  `directoryProps?: (path) => …` for its directory toggles (the sidebar's
  `repo.tree` rows), `data-*` attributes are typed on both pass-throughs
  (`DataAttributes`), and the tree can be lazy and controlled: `directories`,
  `collapsed` + `onToggle(path, expanded)`, `renderDirectoryEmpty(path)`, and
  `renderDirectoryFooter(path)`. Pinned by `packages/smithers/ui/tests/file-tree.test.tsx`
  ("FileTree lazy and controlled").

## 4. LANDED: `MarkdownEditor` traps forward Tab

- **File**: `@smthrs/ui` `src/adapters/markdown-editor/MarkdownEditor.tsx`.
- **What**: the editor is a ProseMirror body and ProseMirror binds Tab to
  "insert indentation", so forward Tab never leaves the editor. A keyboard user
  reaching the world editor could not get past it (checklist §21.2).
- **Why it matters here**: "no focus trap, no unreachable control" is a launch
  bar, and the editor is on a shipped surface.
- **Workaround taken**: `apps/ui/src/mainview/FocusRing.ts` restores the
  document's own Tab order around the region from the mount site, in a capture
  handler above the editor.
- **Proposed diff sketch**: give the editor an `escapeTabOrder` prop (default
  true) that binds Tab/Shift+Tab to the browser's own behaviour, and offer
  indentation on an explicit chord instead — which is what every editor that
  ships inside a form does.
- **Landed**: `escapeTabOrder` on `MarkdownEditorProps`, default true. A
  capture-phase handler above ProseMirror's keymap stops Tab before the editor
  sees it, so the document's own focus order applies; the host reports the
  setting as `data-escape-tab-order` on both the editor and the fallback
  textarea. `apps/ui/src/mainview/FocusRing.ts` was deleted on 2026-09-09; the
  Wiki editor's `.world-editor-region` wrapper is layout only now.

## 5. LANDED: `Markdown` has no table rule

- **File**: `@smthrs/ui` `src/primitives/markdown.tsx`.
- **What**: the renderer handles fences, headings, lists and inline spans. A
  GitHub-flavored table reaches the bubble as one paragraph with `<br>` between
  the rows, so every `|` and every `---|---` is on screen as literal text
  (checklist §4.2).
- **Why it matters here**: a table is one of the shapes a model reaches for
  most — "which repos, how many issues" is a table — and the transcript is the
  product's main surface.
- **Workaround taken**: `apps/ui/src/mainview/RichMarkdown.tsx` splits table
  blocks out of the source and renders them with the library's own `Table`
  primitives, handing everything else to `Markdown` unchanged. Fenced code is
  copied through untouched so a pipe inside a fence stays data. It duplicates
  block-level parsing the library already does, which is exactly the drift a
  rule inside the renderer would prevent.
- **Proposed diff sketch**: add a table branch to `renderBlocks` beside the
  fence branch — a header row, a `:?-+:?` delimiter row with a matching column
  count, then rows until a non-pipe line — emitting the same `Table`/`TableRow`
  primitives, with the delimiter's colons as per-column alignment.
- **Landed**: exactly that, in `renderBlocks` and in `splitBlockSources` so a
  streaming block boundary agrees with the renderer. A header row with no
  delimiter row, a delimiter row of the wrong width, a sentence containing a
  pipe, and a pipe inside a fence all stay what they were.
  `apps/ui/src/mainview/RichMarkdown.tsx` was deleted on 2026-09-09: the
  transcript and the cards now share one renderer, so a table cell renders its
  own inline markdown instead of reaching the screen with its asterisks
  (`src/mainview/MessageMarkdown.test.tsx`).
