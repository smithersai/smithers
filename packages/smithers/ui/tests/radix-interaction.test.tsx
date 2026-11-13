// Radix behavior under happy-dom: real createRoot + act, the gateway-react
// convention. happy-dom has no layout engine, so these tests assert
// open/close/aria state only -- never floating-ui placement.
//
// The DOM comes from tests/happy-dom-preload.ts (bunfig `[test] preload`):
// Radix decides whether layout effects run by checking `globalThis.document`
// at module-load time, so registering happy-dom here (after hoisted imports)
// would be too late and portals would render nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Button,
  CollapsiblePanel,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  SMITHERS_UI_STYLE_ATTR,
  SmithersUiStyles,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../src/index";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const r = root;
  await act(async () => r.render(element));
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

/** Radix Tabs activates on mousedown; happy-dom's .click() emits only `click`. */
async function press(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    (el as HTMLElement).click();
  });
}

describe("style auto-injection", () => {
  test("mounting any component injects the sheet exactly once", async () => {
    await render(
      <div>
        <Button>a</Button>
        <Button>b</Button>
      </div>,
    );
    const styles = document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`);
    expect(styles.length).toBe(1);
    expect(styles[0]!.textContent).toContain(".sui-button");
  });

  test("a rendered sheet makes a later component injection stand down", async () => {
    await render(
      <>
        <SmithersUiStyles />
        <Button>after sheet</Button>
      </>,
    );
    const styles = document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`);
    expect(styles).toHaveLength(1);
    expect(container!.contains(styles[0]!)).toBe(true);
  });

  test("a rendered sheet added later does not remove the injected copy", async () => {
    await render(<Button>before sheet</Button>);
    const injected = document.head.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)!;
    expect(injected).not.toBeNull();

    const current = root!;
    await act(async () =>
      current.render(
        <>
          <Button>before sheet</Button>
          <SmithersUiStyles />
        </>,
      )
    );

    const styles = document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`);
    expect(styles).toHaveLength(2);
    expect(document.head.contains(injected)).toBe(true);
    expect(container!.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)).not.toBeNull();
  });
});

describe("Dialog", () => {
  function harness() {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open ticket</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ticket 42</DialogTitle>
            <DialogDescription>Full details</DialogDescription>
          </DialogHeader>
          <p>body text</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button data-testid="dialog-done">Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  test("opens through the trigger, portals to body, closes on Escape", async () => {
    await render(harness());
    expect(document.querySelector(".sui-dialog-content")).toBeNull();

    const trigger = document.querySelector('[data-slot="dialog-trigger"]');
    expect(trigger).not.toBeNull();
    await click(trigger!);

    const content = document.querySelector(".sui-dialog-content");
    expect(content).not.toBeNull();
    expect(content!.getAttribute("role")).toBe("dialog");
    expect(content!.getAttribute("data-state")).toBe("open");
    expect(document.body.textContent).toContain("Ticket 42");
    expect(document.querySelector(".sui-dialog-overlay")).not.toBeNull();
    // Portaled content escapes the render container -- styling must be
    // document-global, which the injected sheet is.
    expect(container!.contains(content)).toBe(false);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector(".sui-dialog-content")).toBeNull();
  });

  test("closes through the built-in close button", async () => {
    await render(harness());
    await click(document.querySelector('[data-slot="dialog-trigger"]')!);
    expect(document.querySelector(".sui-dialog-content")).not.toBeNull();

    await click(document.querySelector(".sui-dialog-close")!);
    expect(document.querySelector(".sui-dialog-content")).toBeNull();
  });

  test("closes through a DialogClose in the footer", async () => {
    await render(harness());
    await click(document.querySelector('[data-slot="dialog-trigger"]')!);
    const footer = document.querySelector('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    const done = document.querySelector('[data-testid="dialog-done"]');
    expect(done).not.toBeNull();
    expect(done!.getAttribute("data-slot")).toBe("dialog-close");

    await click(done!);
    expect(document.querySelector(".sui-dialog-content")).toBeNull();
  });
});

describe("Select", () => {
  test("renders trigger, value, and the open listbox with items", async () => {
    await render(
      <Select defaultOpen defaultValue="fast">
        <SelectTrigger>
          <SelectValue placeholder="Model" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Models</SelectLabel>
            <SelectItem value="fast">Fast</SelectItem>
            <SelectSeparator />
            <SelectItem value="strong">Strong</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    const trigger = document.querySelector('[data-slot="select-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.className).toContain("sui-select-trigger");

    const content = document.querySelector('[data-slot="select-content"]');
    expect(content).not.toBeNull();
    expect(content!.className).toContain("sui-select-content");

    expect(document.querySelector('[data-slot="select-label"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="select-separator"]')).not.toBeNull();
    const items = document.querySelectorAll('[data-slot="select-item"]');
    expect(items.length).toBe(2);
    expect(document.body.textContent).toContain("Fast");
    expect(document.body.textContent).toContain("Strong");
  });
});

describe("Tooltip", () => {
  test("renders the content when open through the provider", async () => {
    await render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger asChild>
            <Button size="icon">?</Button>
          </TooltipTrigger>
          <TooltipContent>Explain the thing</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const trigger = document.querySelector('[data-slot="tooltip-trigger"]');
    expect(trigger).not.toBeNull();

    const content = document.querySelector('[data-slot="tooltip-content"]');
    expect(content).not.toBeNull();
    expect(content!.className).toContain("sui-tooltip-content");
    expect(document.body.textContent).toContain("Explain the thing");
  });
});

describe("CollapsiblePanel", () => {
  const panel = () => document.querySelector('[data-slot="collapsible-panel"]');
  const header = () => document.querySelector('[data-slot="collapsible-panel"] .sui-collapsible-header');

  test("toggles children visibility on header click", async () => {
    await render(
      <CollapsiblePanel title="Implementation" status="ok">
        <div>implementation body</div>
      </CollapsiblePanel>,
    );
    expect(document.body.textContent).toContain("implementation body");
    expect(panel()!.getAttribute("data-state")).toBe("open");
    expect(header()!.getAttribute("aria-expanded")).toBe("true");

    await click(header()!);
    expect(document.body.textContent).not.toContain("implementation body");
    expect(panel()!.getAttribute("data-state")).toBe("closed");
    expect(header()!.getAttribute("aria-expanded")).toBe("false");

    await click(header()!);
    expect(document.body.textContent).toContain("implementation body");
    expect(panel()!.getAttribute("data-state")).toBe("open");
  });

  test("toggles when the visible title text is clicked", async () => {
    await render(
      <CollapsiblePanel title="Visible title">
        <div>panel body</div>
      </CollapsiblePanel>,
    );

    await click(document.querySelector(".sui-collapsible-title")!);
    expect(panel()!.getAttribute("data-state")).toBe("closed");
    expect(document.body.textContent).not.toContain("panel body");
  });

  test("does not toggle when a button in the title is activated", async () => {
    let activations = 0;
    await render(
      <CollapsiblePanel title={<button onClick={() => activations++}>Title action</button>}>
        <div>panel body</div>
      </CollapsiblePanel>,
    );

    const titleButton = document.querySelector(".sui-collapsible-title button");
    await click(titleButton!);

    expect(activations).toBe(1);
    expect(panel()!.getAttribute("data-state")).toBe("open");
    expect(document.body.textContent).toContain("panel body");
  });

  test("toggles on Enter and Space from the focused header", async () => {
    await render(
      <CollapsiblePanel title="Keyboard">
        <div>keyboard body</div>
      </CollapsiblePanel>,
    );

    const panelHeader = header() as HTMLElement;
    panelHeader.focus();
    expect(document.activeElement).toBe(panelHeader);

    await act(async () => {
      panelHeader.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(panel()!.getAttribute("data-state")).toBe("closed");

    await act(async () => {
      panelHeader.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    });
    expect(panel()!.getAttribute("data-state")).toBe("open");
  });

  test("controlled panel defers to onOpenChange and does not self-toggle", async () => {
    const changes: boolean[] = [];
    await render(
      <CollapsiblePanel title="Merge" open={false} onOpenChange={(next) => changes.push(next)}>
        <div>merge body</div>
      </CollapsiblePanel>,
    );
    expect(document.body.textContent).not.toContain("merge body");

    await click(header()!);
    // Controlled: still closed (parent owns state), but the request fired as `true`.
    expect(panel()!.getAttribute("data-state")).toBe("closed");
    expect(changes).toEqual([true]);
  });
});

describe("Tabs", () => {
  test("switches content and active state on click", async () => {
    await render(
      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs" count={2}>
            Runs
          </TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>
        <TabsContent value="runs">run list</TabsContent>
        <TabsContent value="events">event list</TabsContent>
      </Tabs>,
    );

    const triggers = Array.from(document.querySelectorAll(".sui-tabs-trigger"));
    expect(triggers.length).toBe(2);
    expect(triggers[0]!.getAttribute("data-state")).toBe("active");
    expect(document.body.textContent).toContain("run list");
    expect(document.body.textContent).not.toContain("event list");

    await press(triggers[1]!);
    expect(triggers[1]!.getAttribute("data-state")).toBe("active");
    expect(triggers[0]!.getAttribute("data-state")).toBe("inactive");
    expect(document.body.textContent).toContain("event list");
    expect(document.body.textContent).not.toContain("run list");
  });
});
