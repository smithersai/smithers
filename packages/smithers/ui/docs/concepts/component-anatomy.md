---
title: "Component anatomy"
description: "The shadcn conventions every component in this package follows: compound slots, data-slot attributes, CVA variant APIs, asChild, host prop pass-through, and where the house recipes differ from upstream shadcn."
sidebar:
  order: 3
---

Every component here follows shadcn/ui anatomy on Radix behavior. If you have
used shadcn, you already know the shapes; this page names the four conventions
and the three places the house recipes differ from upstream.

## Two component shapes

**Drop-ins** take props and render a finished thing: `Button`, `StatusPill`,
`KpiStat`, `EmptyState`, `RelativeTime`, `Markdown`, `FileTree`.

**Compound families** are a set of parts you assemble, sharing state through
context. `Card` with `CardHeader`, `CardTitle`, `CardContent`, `CardFooter` is
the simplest. `ToolCall`, `Plan`, `Commit`, `TestResults`, `PromptInput`,
`WorkflowCanvas`, and the conversation families are the same idea with more
parts. A family's parts are exported individually, and its hook, where it has
one, reads the shared state: `usePromptInputAttachments`, `useCommitModel`,
`useCheckpoint`, `useMessageScroller`.

Several families ship both shapes. `MessageScroller` has a compound anatomy and
a hook set; `ChatTranscript` is the drop-in over the same machinery.

## `data-slot` marks every part

Each rendered element carries a `data-slot` attribute naming its role, so a host
can target a part from CSS or find it in a test without depending on a class
name:

```tsx
<Button>Launch</Button>
// renders <button data-slot="button" type="button" class="sui-button sui-button-default">
```

Class names are also stable and namespaced, but `data-slot` is the contract that
survives a restyle.

## Variants come from CVA

Variant APIs are `class-variance-authority` recipes, exported next to their
component so a host can compose the same classes onto a different element:

```tsx
import { buttonVariants } from "@smthrs/ui"

// Style a link like a ghost button without rendering a <button>.
const className: string = buttonVariants({ variant: "ghost", size: "sm" })
```

The exported recipes are `buttonVariants`, `badgeVariants`, `alertVariants`,
`spinnerVariants`, and `bubbleVariants`.

## `asChild` renders your element

Components with an `asChild` prop render their child through Radix's `Slot`
instead of their own tag, merging classes, attributes, and handlers onto it.
Reach for it when the semantics have to change but the styling should not:

```tsx
import { Button } from "@smthrs/ui"

<Button asChild>
  <a href="/runs">Open runs</a>
</Button>
```

One limit is worth knowing. Under `asChild`, `Button` forwards its disabled,
`aria-disabled`, and `aria-busy` state onto the child, and `disabled` or
`loading` make the child inert: clicks and Enter or Space are cancelled in the
capture phase, so the child's handlers and link navigation never run, while
the element stays focusable. It does not inject a `Spinner` for `loading`:
`Slot` merges props onto an arbitrary element and cannot add a child to it.
Render your own indicator in that case.

## Host props pass through

Every component spreads the remaining props onto the element it renders, so
`className`, `id`, `data-*`, ARIA attributes, and event handlers reach the DOM.
Where a component renders a control the host does not own directly, it accepts
an explicit props bag instead: `ChatComposer` takes `submitProps` and
`stopProps`, which is how an application stamps its own attributes onto the Send
and Stop buttons. A host attribute overrides the one the component set.

## Where the house differs from shadcn

**`Button variant="default"` is tinted, not filled.** The house primary is a 10
percent brand surface with brand text, matching the styleguide's `.button.primary`
so the two vocabularies can share a page. `variant="solid"` is shadcn's filled
look.

**`Button` defaults to `type="button"`.** A button inside a form never submits
by accident. Pass `type="submit"` when you mean it.

**`cn` is `clsx` alone.** There is no `tailwind-merge`, because every class is
`sui-` namespaced and there are no utility-class conflicts to resolve.

## Provenance

Each ported family records where it came from. Per-family manifests under
`provenance/`, aggregated into `shadcn-provenance.json`, name the upstream
collection, the registry item, the exports kept, and the deliberate divergences.
Read them when you want to know which upstream component a family started as,
and what changed on the way in. A test keeps the record honest: every family
file on disk must appear in the catalog, and every export a manifest declares
must resolve in the module it names.

## Related

- [How styling ships](./styling.md): the sheet those class names live in.
- [Theme tokens](./theming.md): what the colors in those classes resolve to.
- [API reference](../api.md): every part of every family.
