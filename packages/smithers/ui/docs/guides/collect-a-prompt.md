---
title: "Collect a prompt with attachments"
description: "Wire PromptInput's compound anatomy, handle every refusal code from its single admission point, and respect the blob URL lifetime the component owns."
---

`PromptInput` is the composer surface: a textarea, a tool row, a submit and stop
pair, and an attachment strip fed by the file picker, paste, and drag and drop.
This guide covers the three things a host has to get right: the anatomy, the
refusal codes, and who owns the preview URLs.

## Assemble the anatomy

The parts are exported individually and share state through the form's context:

```tsx
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage
} from "@smthrs/ui"

export function Composer({ onSend }: { readonly onSend: (message: PromptInputMessage) => Promise<void> }) {
  return (
    <PromptInput accept="image/*" maxFileSizeBytes={5_000_000} maxFiles={4} multiple onSubmit={onSend}>
      <PromptInputBody>
        <PromptInputTextarea placeholder="Ask for a change" />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger />
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
        </PromptInputTools>
        <PromptInputSubmit />
      </PromptInputFooter>
    </PromptInput>
  )
}
```

`onSubmit` receives a `PromptInputMessage`: the text and the accepted
attachments. Return a promise to keep the draft alive until the send settles.

## Read and drive the attachments

`usePromptInputAttachments` is the hook inside the form. It exposes the current
list and the same `add` entry point the picker uses, so a custom affordance
admits files through the identical checks:

```tsx
import { usePromptInputAttachments } from "@smthrs/ui"

function AttachmentCount() {
  const { attachments } = usePromptInputAttachments()
  return <span>{attachments.length} attached</span>
}
```

## Handle every refusal

Five intake paths reach one admission point, `addFiles`: the hidden file input,
the hook's `add`, a paste, a drop on the form, and the document-level drop
registry. Every limit therefore applies to every path, and every refusal reports
the same code through `onError`:

| Code            | Cause                                                          |
| --------------- | -------------------------------------------------------------- |
| `disabled`      | A file arrived while the prompt was disabled                    |
| `multiple`      | `multiple` is false and one file is already attached            |
| `max-files`     | The attachment count is already at `maxFiles`                   |
| `max-file-size` | `file.size` exceeds `maxFileSizeBytes`                          |
| `accept`        | The file does not match the `accept` pattern                    |
| `submit-failed` | An async `onSubmit` rejected. The only code that carries `cause` |

```tsx
<PromptInput
  onError={(error) => {
    if (error.code === "submit-failed") reportToTelemetry(error.cause)
    else showToast(error.message)
  }}
  onSubmit={onSend}
>
  {/* ... */}
</PromptInput>
```

`message` is user-presentable prose. `code` is what you branch on. A rejected
submit keeps the draft and its attachments: erasing what the user typed because
the network failed is the worst outcome available.

## Respect the blob URL lifetime

The component mints one blob URL per image attachment, stores it as that
attachment's `url` and `thumbnailUrl`, and owns it. The rule:

**The component revokes the URLs it created. Never revoke a URL you did not
create, and never hold one past the handler it arrived in.**

What that means for your `onSubmit`:

- A synchronous handler settles synchronously and the draft clears immediately.
- An async handler holds the draft and its URLs until the returned promise
  settles, so you may `await` and still read the URLs you were handed. Acceptance
  clears uncontrolled text only if it has not been edited since submission.
  Only submitted attachments are removed and their URLs revoked; files added
  while the submit was in flight remain attached and keep their previews.
- A rejected handler revokes nothing and clears nothing.
- Anything you need after the handler settles must be copied from the
  attachment's `file`, which the component does not own.

```tsx
async function onSend(message: PromptInputMessage): Promise<void> {
  // Correct: upload from the File, which outlives the handler.
  await Promise.all(message.attachments.map((item) => item.file && upload(item.file)))
  // Wrong: storing item.url anywhere. It is revoked when this promise settles.
}
```

A host that supplies `attachments` and `onAttachmentsChange` controls the
collection and clears submitted items itself. When the host removes an item,
the component revokes the preview URL it created, after any pending `onSubmit`
handler settles. URLs supplied by the host remain the host's responsibility.

## Related

- [Failure codes and limits](../reference/contracts.md): the same codes, plus
  the other failure surfaces in this package.
- [Render agent output](./render-agent-output.md): the other half of a chat
  surface.
- [API reference](../api.md): every part of the family.
