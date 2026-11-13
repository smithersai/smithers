/** @jsxImportSource react */
import { afterEach, expect, test } from "bun:test";
import { Context, Effect } from "effect";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type Home } from "@smthrs/views";
import { RepositoryHome, smithersUiCss } from "../src";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

async function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
}

const sections = (blocks: ReadonlyArray<Home.Block>): ReadonlyArray<Home.Section> => [{ audience: "everyone", blocks }];

class Clipboard extends Context.Service<Clipboard, {
  readonly write: (text: string) => Effect.Effect<void, Error>;
}>()("repository-home-test/Clipboard") {}

for (const block of [
  { type: "hero", title: "Install", install: "pnpm add effect" },
  { type: "code", code: "const answer = 42" },
] satisfies Array<Home.Block>) {
  test(`${block.type}: copy failure is visible and announced, and a successful retry clears it`, async () => {
    let denied = true;
    // Fault injection at the host's Effect service; successful writes use the real DOM clipboard.
    const clipboard = Clipboard.of({
      write: (text) => denied
        ? Effect.fail(new Error("permission denied: private diagnostic"))
        : Effect.tryPromise({ try: () => navigator.clipboard.writeText(text), catch: () => new Error("clipboard unavailable") }),
    });
    const onCopy = (text: string | React.ClipboardEvent<HTMLElement>) => Effect.runPromise(
      Effect.flatMap(Clipboard, (service) => typeof text === "string" ? service.write(text) : Effect.fail(new Error("expected copied text"))).pipe(Effect.provideService(Clipboard, clipboard)),
    );
    await render(<RepositoryHome sections={sections([block])} onCopy={onCopy} />);
    const button = container!.querySelector<HTMLButtonElement>(".sui-rh-copy")!;
    // A live region must exist before the failure so its changed text can be announced.
    const status = container!.querySelector("[role='status']");
    await act(async () => button.click());
    expect(button.dataset.copyFailed).toBe("true");
    expect(button.textContent).toBe("Copy failed");
    expect(status).not.toBeNull();
    expect(status!.textContent).toBe("Copy failed");
    expect(status!.getAttribute("aria-live")).toBe("polite");
    expect(container!.textContent).not.toContain("private diagnostic");

    denied = false;
    await act(async () => button.click());
    expect(await navigator.clipboard.readText()).toBe(block.type === "hero" ? block.install : block.code);
    expect(button.hasAttribute("data-copy-failed")).toBe(false);
    expect(button.textContent).toBe("Copied");
    expect(status!.textContent).toBe("Copied");
  });
}

test("copy failures have an error color in the shared stylesheet", () => {
  expect(/\.sui-rh-copy\[data-copy-failed="true"\] \{[^}]*color:/.test(smithersUiCss)).toBe(true);
});

for (const intercept of [false, true]) {
  test(`native prompt, app and live flow links retain the selection (onAsk ${intercept ? "present" : "absent"})`, async () => {
    const selected = "flow.run release notes & checks/✓";
    const base = "/maya/tinyhttp?ask=1&ref=main#composer";
    const destination = (flow: string | undefined) => flow === undefined
      ? base
      : `/maya/tinyhttp?ask=1&ref=main&flow=${encodeURIComponent(flow)}#composer`;
    const asked: Array<string | undefined> = [];
    await render(
      <RepositoryHome
        sections={sections([
          { type: "prompt", flow: selected },
          { type: "app", flow: selected, title: "Release", picture: "review" },
          { type: "flows" },
          { type: "prompt" },
        ])}
        askHref={destination}
        offered={() => true}
        live={{ flows: [{ flow: selected, name: "release", title: "Release" }, { flow: "wiki.ask", name: "wiki", title: "Wiki" }] }}
        onAsk={intercept ? (flow) => asked.push(flow) : undefined}
      />,
    );
    const links = [...container!.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      destination(selected), destination(selected), destination(selected), destination("wiki.ask"), base,
    ]);
    const host = (event: Event) => event.preventDefault();
    document.addEventListener("click", host);
    try {
      for (const link of links) {
        for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
          const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
          // Capture defaultPrevented before the host prevents actual navigation in the shared DOM.
          let prevented = true;
          const capture = (event: Event) => { prevented = event.defaultPrevented; };
          container!.addEventListener("click", capture);
          await act(async () => link.dispatchEvent(event));
          container!.removeEventListener("click", capture);
          expect(prevented).toBe(false);
          expect(new URL(link.getAttribute("href")!, "https://smithers.test").searchParams.get("flow"))
            .toBe(link === links[4] ? null : link === links[3] ? "wiki.ask" : selected);
        }
      }
      expect(asked).toEqual([]);
      await act(async () => links[0]!.click());
      expect(asked).toEqual(intercept ? [selected] : []);
    } finally {
      document.removeEventListener("click", host);
    }
  });
}
