---
title: "Failure codes"
description: "The stable failure codes MarkdownEditor reports, what the editor shows after one, and the three values of data-mode."
sidebar:
  order: 2
---

## `MarkdownEditor`

`src/MarkdownEditor.tsx` reports through `onError` with
`MarkdownEditorError = { code, cause }`, where `cause` is the original
rejection. Each code is a stable string a caller may branch on.

| Code                   | Emitted when                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `editor-load-failed`   | The `@milkdown/*` modules could not be loaded. With the default `loadEditor` seam that is the dynamic import rejecting. |
| `editor-create-failed` | The modules loaded, but constructing the Crepe editor or awaiting its `create()` threw or rejected.              |

The component tracks an `EditorState` of `"loading"`, `"ready"`, or `"failed"`.
Either code moves it to `"failed"`, and a failed editor renders the seeded
textarea with `data-mode="failed"`. The textarea carries the current markdown,
so a load failure degrades to a plain editing surface instead of losing the
document. A consumer that renders its own fallback can key on `onError`; one
that does not still gets a working textarea.

`setMarkdown` received while modules load or `create()` is pending replaces the
seed before the editor becomes ready. Only the latest value is applied, without
an `onChange` echo. Failed attempts release their editor and ignore stale
callbacks. Retries wait for pending creation and teardown before reusing the
host; teardown rejection does not prevent recovery.

`data-mode` has three values: `"wysiwyg"` for the real editor, `"fallback"` when
the caller passed `fallback` or the host failed the rich-text capability probe,
and `"failed"` after one of the codes above. The probe measures a hidden
element once per document and removes it, even when the measurement throws.

## The code view's worker pool

`CodeFileView` highlights in a worker wherever one exists. The pool falls back
to the main thread, and logs one warning that names the reason, when its worker
errors, fails to start (a page policy that refuses workers included), or does
not answer `initialize` within `CODE_VIEW_POOL_DEADLINE_MS` (15 seconds), which
the pool passes to pierre as its `workerInitializationTimeout`. A fallen-back
page keeps the main thread until `disposeCodeViewPool` releases the pool.
