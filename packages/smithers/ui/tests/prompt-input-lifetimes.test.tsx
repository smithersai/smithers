/** @jsxImportSource react */
// Attachment lifetimes and the flags every intake path has to honor.
//
// `addFiles` is the single admission point: the hook, paste, form drop and the
// document-level drop registry all reach it without passing the hidden file
// input, so anything the input enforces has to be enforced there too.
import { afterEach, describe, expect, test } from "bun:test";
import { File as NativeFile, resolveObjectURL } from "node:buffer";
import { act, useEffect, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  PromptInput,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  type PromptInputAttachmentItem,
  type PromptInputError,
  type PromptInputMessage,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "../src/prompt/PromptInput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const mounted = root;
  await act(async () => mounted.render(element));
}

const makeFile = (name: string, type: string) => new NativeFile(["x"], name, { type }) as unknown as File;

function pressEnter(el: HTMLTextAreaElement): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function typeText(text: string): void {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function textarea(): HTMLTextAreaElement {
  const el = container?.querySelector<HTMLTextAreaElement>("textarea");
  if (!el) throw new Error("textarea not found");
  return el;
}

/** Record real object URLs and observe their actual registry lifetime. */
async function withObjectUrls<T>(body: (log: { created: string[]; revoked: () => string[] }) => Promise<T>): Promise<T> {
  const created: string[] = [];
  const originalCreate = URL.createObjectURL;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (file: File) => {
      const url = originalCreate(file);
      created.push(url);
      return url;
    },
  });
  try {
    return await body({ created, revoked: () => created.filter((url) => resolveObjectURL(url) === undefined) });
  } finally {
    for (const url of created) URL.revokeObjectURL(url);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreate });
  }
}

describe("an async onSubmit borrows attachments for its whole lifetime", () => {
  test("the object URL is still live inside the handler and revoked only after it resolves", async () => {
    await withObjectUrls(async ({ created, revoked }) => {
      let hook!: ReturnType<typeof usePromptInputAttachments>;
      let release!: () => void;
      const seenInsideHandler: Array<string | undefined> = [];
      const revokedAtResume: string[][] = [];

      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      await render(
        <PromptInput
          defaultValue="submitted draft"
          onSubmit={async (message: PromptInputMessage) => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            // After the first await: this is exactly where a real consumer
            // uploads the blob. The URL must not have been revoked yet.
            seenInsideHandler.push(message.attachments[0]?.url);
            revokedAtResume.push([...revoked()]);
          }}
        >
          <Harness />
        </PromptInput>,
      );

      await act(async () => hook.add([makeFile("shot.png", "image/png")]));
      await act(async () => pressEnter(textarea()));
      expect(revoked()).toEqual([]);

      await act(async () => {
        release();
        await Promise.resolve();
      });

      expect(seenInsideHandler).toEqual([created[0]!]);
      expect(revokedAtResume).toEqual([[]]);
      expect(revoked()).toEqual([created[0]!]);
      expect(textarea().value).toBe("");
      expect(hook.attachments).toEqual([]);
    });
  });

  test("a rejecting onSubmit keeps the draft and reports submit-failed with the cause", async () => {
    const cause = new Error("network down");
    const errors: PromptInputError[] = [];
    await render(
      <PromptInput
        defaultValue="keep me"
        onSubmit={async () => {
          throw cause;
        }}
        onError={(error) => errors.push(error)}
      >
        <PromptInputTextarea />
      </PromptInput>,
    );

    await act(async () => {
      pressEnter(textarea());
      await Promise.resolve();
    });

    expect(textarea().value).toBe("keep me");
    expect(errors).toEqual([
      { code: "submit-failed", message: "The prompt could not be submitted.", cause },
    ]);
  });

  test("a synchronously throwing onSubmit keeps the draft and attachments and reports submit-failed", async () => {
    await withObjectUrls(async ({ created, revoked }) => {
      const cause = new Error("host threw");
      const errors: PromptInputError[] = [];
      let hook!: ReturnType<typeof usePromptInputAttachments>;
      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      await render(
        <PromptInput
          defaultValue="keep me"
          onSubmit={() => {
            throw cause;
          }}
          onError={(error) => errors.push(error)}
        >
          <Harness />
        </PromptInput>,
      );
      await act(async () => hook.add([makeFile("shot.png", "image/png")]));

      await act(async () => {
        pressEnter(textarea());
        await Promise.resolve();
      });

      expect(textarea().value).toBe("keep me");
      expect(hook.attachments.map((item) => item.name)).toEqual(["shot.png"]);
      expect(revoked()).toEqual([]);
      expect(errors).toEqual([
        { code: "submit-failed", message: "The prompt could not be submitted.", cause },
      ]);
    });
  });

  test.each(["unsent second draft", "submitted draft"])("pending acceptance preserves edited text (%s) and later attachments", async (laterText) => {
    await withObjectUrls(async ({ created, revoked }) => {
      let hook!: ReturnType<typeof usePromptInputAttachments>;
      let release!: () => void;
      const submitted: PromptInputMessage[] = [];
      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      const view = (status: "ready" | "submitted") => (
        <PromptInput
          multiple
          defaultValue="submitted draft"
          status={status}
          onSubmit={async (message) => {
            submitted.push(message);
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }}
        >
          <Harness />
        </PromptInput>
      );

      await render(view("ready"));

      await act(async () => hook.add([makeFile("first.png", "image/png")]));
      await act(async () => pressEnter(textarea()));
      await act(async () => root!.render(view("submitted")));
      await act(async () => typeText("intermediate edit"));
      await act(async () => typeText(laterText));
      await act(async () => hook.add([makeFile("second.png", "image/png")]));
      const laterAttachment = hook.attachments[1]!;
      expect(submitted.map((message) => ({
        text: message.text,
        files: message.attachments.map((item) => item.name),
      }))).toEqual([{ text: "submitted draft", files: ["first.png"] }]);
      expect(textarea().value).toBe(laterText);
      expect(hook.attachments.map((item) => item.name)).toEqual(["first.png", "second.png"]);
      await act(async () => {
        release();
        await Promise.resolve();
      });

      // Only the submitted attachment's URL is released.
      expect(revoked()).toEqual([created[0]!]);
      expect({ text: textarea().value, attachments: hook.attachments }).toEqual({
        text: laterText,
        attachments: [laterAttachment],
      });
      expect(laterAttachment.url).toBe(created[1]!);
      await act(async () => hook.remove(laterAttachment.id));
      expect(hook.attachments).toEqual([]);
      expect(revoked()).toEqual([created[0]!, created[1]!]);

      await act(async () => root!.unmount());
      root = undefined;
      expect(revoked()).toEqual([created[0]!, created[1]!]);
    });
  });
});

describe("removing an attachment while a submission is pending", () => {
  type Hook = ReturnType<typeof usePromptInputAttachments>;

  async function pendingSubmission(
    revoked: string[],
    settle: { current?: (outcome: "resolve" | "reject") => void },
    files: File[],
  ): Promise<() => Hook> {
    let hook!: Hook;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput
        defaultValue="draft"
        multiple
        onSubmit={() =>
          new Promise<void>((resolve, reject) => {
            settle.current = (outcome) => (outcome === "resolve" ? resolve() : reject(new Error("boom")));
          })
        }
        onError={() => {}}
      >
        <Harness />
      </PromptInput>,
    );
    await act(async () => hook.add(files));
    await act(async () => pressEnter(textarea()));
    expect(revoked).toEqual([]);
    return () => hook;
  }

  test.each(["resolve", "reject"] as const)("removal defers the revoke until the handler %ss", async (outcome) => {
    await withObjectUrls(async ({ created, revoked }) => {
      const settle: { current?: (outcome: "resolve" | "reject") => void } = {};
      const hook = await pendingSubmission(revoked(), settle, [makeFile("a.png", "image/png"), makeFile("b.png", "image/png")]);

      const [first] = hook().attachments;
      await act(async () => hook().remove(first!.id));
      expect(hook().attachments.map((item) => item.name)).toEqual(["b.png"]);
      expect(revoked()).toEqual([]);

      await act(async () => {
        settle.current!(outcome);
        await Promise.resolve();
        await Promise.resolve();
      });
      // Resolve accepts the whole submission; reject keeps the surviving draft
      // attachment alive and revokes only the one the user removed.
      expect(revoked()).toEqual(outcome === "resolve" ? [created[0]!, created[1]!] : [created[0]!]);
    });
  });

  test("clearing the draft defers the revoke until the handler settles", async () => {
    await withObjectUrls(async ({ created, revoked }) => {
      const settle: { current?: (outcome: "resolve" | "reject") => void } = {};
      const hook = await pendingSubmission(revoked(), settle, [makeFile("a.png", "image/png")]);

      await act(async () => hook().clear());
      expect(hook().attachments).toEqual([]);
      expect(revoked()).toEqual([]);

      await act(async () => {
        settle.current!("resolve");
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(revoked()).toEqual([created[0]!]);
    });
  });

  test.each(["resolve", "reject"] as const)("unmounting retains a leased URL until %s", async (outcome) => {
    await withObjectUrls(async ({ created, revoked }) => {
      const settle: { current?: (outcome: "resolve" | "reject") => void } = {};
      await pendingSubmission(revoked(), settle, [makeFile("a.png", "image/png")]);
      const mounted = root!;
      root = undefined;
      await act(async () => mounted.unmount());
      expect(revoked()).toEqual([]);
      await act(async () => {
        settle.current!(outcome);
        await Promise.resolve();
      });
      expect(revoked()).toEqual([created[0]!]);
    });
  });

  test("with no submission pending, removal revokes immediately", async () => {
    await withObjectUrls(async ({ created, revoked }) => {
      let hook!: Hook;
      function Harness() {
        hook = usePromptInputAttachments();
        return <PromptInputTextarea />;
      }
      await render(
        <PromptInput onSubmit={() => {}}>
          <Harness />
        </PromptInput>,
      );
      await act(async () => hook.add([makeFile("a.png", "image/png")]));
      await act(async () => hook.remove(hook.attachments[0]!.id));
      expect(revoked()).toEqual([created[0]!]);
    });
  });
});

describe("disabled and multiple bind every intake path, not just the picker", () => {
  test("a disabled prompt refuses files from the hook and reports the code", async () => {
    const errors: PromptInputError[] = [];
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput disabled onSubmit={() => {}} onError={(error) => errors.push(error)}>
        <Harness />
      </PromptInput>,
    );

    await act(async () => hook.add([makeFile("blocked.txt", "text/plain")]));
    expect(hook.attachments).toEqual([]);
    expect(errors.map((error) => error.code)).toEqual(["disabled"]);
  });

  test("a disabled prompt refuses a paste and a form drop", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput disabled onSubmit={() => {}}>
        <Harness />
      </PromptInput>,
    );
    const form = container!.querySelector("form")!;

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { files: [makeFile("pasted.txt", "text/plain")] } });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(drop, { dataTransfer: { files: [makeFile("dropped.txt", "text/plain")] } });
    await act(async () => {
      form.dispatchEvent(paste);
      form.dispatchEvent(drop);
    });

    expect(hook.attachments).toEqual([]);
  });

  test("a disabled prompt claims no document drop registration", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput disabled globalDrop onSubmit={() => {}}>
        <Harness />
      </PromptInput>,
    );

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.assign(drop, { dataTransfer: { files: [makeFile("dropped.txt", "text/plain")] } });
    await act(async () => {
      document.dispatchEvent(drop);
    });

    expect(hook.attachments).toEqual([]);
  });

  test("multiple=false accepts exactly one file from a batch and reports the rest", async () => {
    const errors: PromptInputError[] = [];
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput onSubmit={() => {}} onError={(error) => errors.push(error)}>
        <Harness />
      </PromptInput>,
    );

    await act(async () =>
      hook.add([makeFile("one.txt", "text/plain"), makeFile("two.txt", "text/plain")])
    );
    expect(hook.attachments.map((item) => item.name)).toEqual(["one.txt"]);
    expect(errors.map((error) => error.code)).toEqual(["multiple"]);

    // A second call is refused too: the single slot is already taken.
    await act(async () => hook.add([makeFile("three.txt", "text/plain")]));
    expect(hook.attachments.map((item) => item.name)).toEqual(["one.txt"]);
    expect(errors.map((error) => error.code)).toEqual(["multiple", "multiple"]);
  });

  test("a consumer onPaste that calls preventDefault suppresses the built-in intake", async () => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput onSubmit={() => {}} onPaste={(event) => event.preventDefault()}>
        <Harness />
      </PromptInput>,
    );
    const form = container!.querySelector("form")!;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(paste, { clipboardData: { files: [makeFile("pasted.txt", "text/plain")] } });
    await act(async () => {
      form.dispatchEvent(paste);
    });

    expect(hook.attachments).toEqual([]);
  });
});


test("pending submission ignores repeated Enter and direct form submissions without revoking its URL", async () => {
  await withObjectUrls(async ({ created, revoked }) => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    let release!: () => void;
    let calls = 0;
    function Harness() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(<PromptInput defaultValue="draft" onSubmit={() => {
      calls += 1;
      if (calls === 1) return new Promise<void>((resolve) => { release = resolve; });
    }}><Harness /></PromptInput>);
    await act(async () => hook.add([makeFile("a.png", "image/png")]));
    await act(async () => {
      pressEnter(textarea());
      pressEnter(textarea());
      container!.querySelector("form")!.requestSubmit();
    });
    // A synchronous later acceptance must never invalidate the pending borrow.
    expect(revoked()).toEqual([]);
    expect(calls).toBe(1);
    await act(async () => { release(); });
    expect(revoked()).toEqual([created[0]!]);
    await act(async () => typeText("next"));
    await act(async () => pressEnter(textarea()));
    expect(calls).toBe(2);
  });
});

test.each(["Enter", " "])("action wrapper activates an ordinary button with %s", async (key) => {
  let calls = 0;
  await render(<PromptInputActionMenu defaultOpen>
    <PromptInputActionMenuContent><button type="button" onClick={() => { calls += 1; }}>Action</button></PromptInputActionMenuContent>
  </PromptInputActionMenu>);
  const item = container!.querySelector<HTMLElement>('[role="menuitem"]')!;
  expect(document.activeElement).toBe(item);
  await act(async () => item.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
  expect(calls).toBe(1);
  expect(container!.querySelector('[role="menu"]')).toBeNull();
});


test.each(["resolve", "reject"] as const)("pending submission blocks duplicates and unlocks after %s", async (outcome) => {
  let calls = 0;
  let settle!: () => void;
  await render(<PromptInput value="draft" onError={() => {}} onSubmit={() => {
    calls += 1;
    return new Promise<void>((resolve, reject) => {
      settle = () => outcome === "resolve" ? resolve() : reject(new Error("rejected"));
    });
  }}><PromptInputTextarea /></PromptInput>);
  await act(async () => {
    pressEnter(textarea());
    pressEnter(textarea());
    container!.querySelector("form")!.requestSubmit();
  });
  expect(calls).toBe(1);
  await act(async () => { settle(); });
  await act(async () => pressEnter(textarea()));
  expect(calls).toBe(2);
  await act(async () => { settle(); });
});

describe("controlled attachment URL ownership", () => {
  async function controlled(onSubmit: (message: PromptInputMessage) => void | Promise<void> = () => {}) {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    let update!: (items: readonly PromptInputAttachmentItem[]) => void;
    function Contents() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    function Host() {
      const [items, setItems] = useState<readonly PromptInputAttachmentItem[]>([]);
      update = setItems;
      return (
        <PromptInput value="draft" multiple attachments={items} onAttachmentsChange={setItems}
          onSubmit={onSubmit} onError={() => {}}>
          <Contents />
        </PromptInput>
      );
    }
    await render(<Host />);
    return {
      current: () => hook,
      update: async (items: readonly PromptInputAttachmentItem[]) => {
        await act(async () => update(items));
      },
    };
  }

  test.each(["before submission", "after synchronous submission"])("host clearing revokes URLs %s", async (when) => {
    await withObjectUrls(async ({ created, revoked }) => {
      const messages: PromptInputMessage[] = [];
      const host = await controlled((message) => { messages.push(message); });
      await act(async () => host.current().add([makeFile("image.png", "image/png")]));
      const attachment = host.current().attachments[0]!;
      if (when === "after synchronous submission") {
        await act(async () => pressEnter(textarea()));
        expect(messages[0]!.attachments).toEqual([attachment]);
      }
      expect(revoked()).toEqual([]);
      expect(host.current().attachments).toEqual([attachment]);
      await host.update([]);
      expect(host.current().attachments).toEqual([]);
      expect(revoked()).toEqual([created[0]!]);
    });
  });

  test("host removal releases only the removed URL and leaves caller-owned URLs alone", async () => {
    await withObjectUrls(async ({ created, revoked }) => {
      const host = await controlled();
      await act(async () => host.current().add([makeFile("first.png", "image/png"), makeFile("second.png", "image/png")]));
      const retained = host.current().attachments[1]!;
      const externalUrl = URL.createObjectURL(makeFile("external.png", "image/png"));
      const external: PromptInputAttachmentItem = { id: "external", name: "external.png", url: externalUrl };
      await host.update([retained, external]);
      expect(revoked()).toEqual([created[0]!]);
      expect(resolveObjectURL(retained.url!)).toBeDefined();
      await host.update([]);
      expect(revoked()).toEqual([created[0]!, created[1]!]);
      expect(resolveObjectURL(externalUrl)).toBeDefined();
    });
  });

  test.each(["resolve", "reject"] as const)("host removal preserves the async borrow until %s", async (outcome) => {
    await withObjectUrls(async ({ created, revoked }) => {
      let settle!: () => void;
      let submitted!: PromptInputMessage;
      const host = await controlled((message) => {
        submitted = message;
        return new Promise<void>((resolve, reject) => {
          settle = () => outcome === "resolve" ? resolve() : reject(new Error("upload failed"));
        });
      });
      await act(async () => host.current().add([makeFile("submitted.png", "image/png")]));
      await act(async () => pressEnter(textarea()));
      await host.update([]);
      await act(async () => host.current().add([makeFile("next.png", "image/png")]));
      const next = host.current().attachments[0]!;
      expect(resolveObjectURL(submitted.attachments[0]!.url!)).toBeDefined();
      expect(revoked()).toEqual([]);
      await act(async () => settle());
      expect(revoked()).toEqual([created[0]!]);
      expect(host.current().attachments).toEqual([next]);
      expect(resolveObjectURL(next.url!)).toBeDefined();
    });
  });

  test("host clearing after async acceptance releases the retained URL", async () => {
    await withObjectUrls(async ({ created, revoked }) => {
      let settle!: () => void;
      const host = await controlled(() => new Promise<void>((resolve) => { settle = resolve; }));
      await act(async () => host.current().add([makeFile("image.png", "image/png")]));
      await act(async () => pressEnter(textarea()));
      await act(async () => settle());
      expect(host.current().attachments).toHaveLength(1);
      expect(revoked()).toEqual([]);
      await host.update([]);
      expect(revoked()).toEqual([created[0]!]);
    });
  });
});

test.each([false, true])("attachment intake from a descendant mount effect keeps its URL (controlled=%s)", async (controlled) => {
  await withObjectUrls(async ({ created, revoked }) => {
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    const file = makeFile("mounted.png", "image/png");
    function Contents() {
      hook = usePromptInputAttachments();
      const { add } = hook;
      useEffect(() => { add([file]); }, [add]);
      return <PromptInputTextarea />;
    }
    function Host() {
      const [items, setItems] = useState<readonly PromptInputAttachmentItem[]>([]);
      return (
        <PromptInput attachments={controlled ? items : undefined} onAttachmentsChange={setItems} onSubmit={() => {}}>
          <Contents />
        </PromptInput>
      );
    }
    await render(<Host />);
    expect(hook.attachments).toHaveLength(1);
    expect(hook.attachments[0]!.url).toBe(created[0]!);
    expect(revoked()).toEqual([]);
    expect(resolveObjectURL(created[0]!)).toBeDefined();
    await act(async () => hook.clear());
    expect(revoked()).toEqual([created[0]!]);
  });
});

describe("accepted uncontrolled drafts notify their host", () => {
  test.each([false, true])("acceptance reports cleared text and attachments (async=%s)", async (asynchronous) => {
    const values: string[] = [];
    const attachments: Array<readonly PromptInputAttachmentItem[]> = [];
    let settle!: () => void;
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Contents() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput defaultValue="send me" onValueChange={(value) => values.push(value)}
        onAttachmentsChange={(items) => attachments.push(items)}
        onSubmit={() => asynchronous ? new Promise<void>((resolve) => { settle = resolve; }) : undefined}>
        <Contents />
      </PromptInput>,
    );
    await act(async () => hook.add([makeFile("note.txt", "text/plain")]));
    attachments.length = 0;
    await act(async () => pressEnter(textarea()));
    if (asynchronous) {
      expect(values).toEqual([]);
      expect(attachments).toEqual([]);
      await act(async () => settle());
    }
    expect(textarea().value).toBe("");
    expect(hook.attachments).toEqual([]);
    expect(values).toEqual([""]);
    expect(attachments).toEqual([[]]);
  });

  test("acceptance reports surviving attachments without clearing a newer text draft", async () => {
    const values: string[] = [];
    const attachments: Array<readonly PromptInputAttachmentItem[]> = [];
    let settle!: () => void;
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Contents() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    await render(
      <PromptInput defaultValue="send me" multiple onValueChange={(value) => values.push(value)}
        onAttachmentsChange={(items) => attachments.push(items)}
        onSubmit={() => new Promise<void>((resolve) => { settle = resolve; })}>
        <Contents />
      </PromptInput>,
    );
    await act(async () => hook.add([makeFile("submitted.txt", "text/plain")]));
    await act(async () => pressEnter(textarea()));
    await act(async () => typeText("next draft"));
    await act(async () => hook.add([makeFile("later.txt", "text/plain")]));
    const later = hook.attachments[1]!;
    attachments.length = 0;
    await act(async () => settle());
    expect(values).toEqual(["next draft"]);
    expect(textarea().value).toBe("next draft");
    expect(attachments).toEqual([[later]]);
    expect(hook.attachments).toEqual([later]);
  });

  test.each(["throw", "reject"] as const)("failed submission does not report a cleared draft (%s)", async (failure) => {
    const values: string[] = [];
    const attachments: Array<readonly PromptInputAttachmentItem[]> = [];
    await render(
      <PromptInput defaultValue="keep me" onValueChange={(value) => values.push(value)}
        onAttachmentsChange={(items) => attachments.push(items)} onError={() => {}}
        onSubmit={() => {
          if (failure === "throw") throw new Error("failed");
          return Promise.reject(new Error("failed"));
        }}>
        <PromptInputTextarea />
      </PromptInput>,
    );
    await act(async () => pressEnter(textarea()));
    expect(textarea().value).toBe("keep me");
    expect(values).toEqual([]);
    expect(attachments).toEqual([]);
  });
});

describe("draft notification failures and callback changes", () => {
  test.each([
    { asynchronous: false, callback: "value" },
    { asynchronous: false, callback: "attachments" },
    { asynchronous: true, callback: "value" },
    { asynchronous: true, callback: "attachments" },
    { asynchronous: false, callback: "both" },
    { asynchronous: true, callback: "both" },
  ] as const)("throwing %j notifications still release submission resources", async ({ asynchronous, callback }) => {
    const reported: unknown[] = [];
    const original = globalThis.reportError;
    globalThis.reportError = (cause: unknown) => { reported.push(cause); };
    try {
      await withObjectUrls(async ({ created, revoked }) => {
        let hook!: ReturnType<typeof usePromptInputAttachments>;
        let settle!: () => void;
        let submissions = 0;
        const cause = new Error("notification failed");
        const errors: PromptInputError[] = [];
        const values: string[] = [];
        const attachments: Array<readonly PromptInputAttachmentItem[]> = [];
        function Contents() {
          hook = usePromptInputAttachments();
          return <PromptInputTextarea />;
        }
        await render(
          <PromptInput defaultValue="send me" onError={(error) => errors.push(error)}
            onValueChange={(value) => {
              values.push(value);
              if ((callback === "value" || callback === "both") && value === "") throw cause;
            }}
            onAttachmentsChange={(items) => {
              attachments.push(items);
              if ((callback === "attachments" || callback === "both") && items.length === 0) throw cause;
            }}
            onSubmit={() => {
              submissions += 1;
              return asynchronous ? new Promise<void>((resolve) => { settle = resolve; }) : undefined;
            }}>
            <Contents />
          </PromptInput>,
        );
        await act(async () => hook.add([makeFile("image.png", "image/png")]));
        attachments.length = 0;
        await act(async () => pressEnter(textarea()));
        if (asynchronous) await act(async () => settle());
        expect(textarea().value).toBe("");
        expect(hook.attachments).toEqual([]);
        expect(values).toEqual([""]);
        expect(attachments).toEqual([[]]);
        expect(revoked()).toEqual([created[0]!]);
        expect(errors).toEqual([]);
        expect(reported).toEqual(callback === "both" ? [cause, cause] : [cause]);
        await act(async () => typeText("next"));
        await act(async () => pressEnter(textarea()));
        if (asynchronous) await act(async () => settle());
        expect(submissions).toBe(2);
      });
    } finally {
      globalThis.reportError = original;
    }
  });

  test("pending acceptance notifies the latest host callbacks", async () => {
    const events: string[] = [];
    let settle!: () => void;
    let hook!: ReturnType<typeof usePromptInputAttachments>;
    function Contents() {
      hook = usePromptInputAttachments();
      return <PromptInputTextarea />;
    }
    const view = (host: string) => (
      <PromptInput defaultValue="send me"
        onValueChange={(value) => events.push(`${host}:text:${value}`)}
        onAttachmentsChange={(items) => events.push(`${host}:files:${items.length}`)}
        onSubmit={() => new Promise<void>((resolve) => { settle = resolve; })}>
        <Contents />
      </PromptInput>
    );
    await render(view("previous"));
    await act(async () => hook.add([makeFile("note.txt", "text/plain")]));
    await act(async () => pressEnter(textarea()));
    await act(async () => root!.render(view("current")));
    events.length = 0;
    await act(async () => settle());
    expect(events).toEqual(["current:text:", "current:files:0"]);
    expect(textarea().value).toBe("");
    expect(hook.attachments).toEqual([]);
  });
});

test.each(["text", "attachments"] as const)("acceptance notifies only the changed draft side (%s)", async (side) => {
  const values: string[] = [];
  const attachments: Array<readonly PromptInputAttachmentItem[]> = [];
  let hook!: ReturnType<typeof usePromptInputAttachments>;
  function Contents() {
    hook = usePromptInputAttachments();
    return <PromptInputTextarea />;
  }
  await render(
    <PromptInput defaultValue={side === "text" ? "send me" : ""}
      onValueChange={(value) => values.push(value)} onAttachmentsChange={(items) => attachments.push(items)}
      onSubmit={() => {}}>
      <Contents />
    </PromptInput>,
  );
  if (side === "attachments") await act(async () => hook.add([makeFile("note.txt", "text/plain")]));
  attachments.length = 0;
  await act(async () => pressEnter(textarea()));
  expect(values).toEqual(side === "text" ? [""] : []);
  expect(attachments).toEqual(side === "attachments" ? [[]] : []);
  expect(textarea().value).toBe("");
  expect(hook.attachments).toEqual([]);
});
