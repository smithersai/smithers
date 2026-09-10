/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import {
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
  ContextUsage,
  contextUsagePercent,
  contextUsageSummary,
} from "../src/agents/ContextUsage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
  document.querySelectorAll(`style[${SMITHERS_UI_STYLE_ATTR}]`).forEach((el) => el.remove());
});

async function render(element: ReactElement) {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  await act(async () => root!.render(element));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("contextUsagePercent", () => {
  test("derives a percentage only from used+max", () => {
    expect(contextUsagePercent({ usedTokens: 50, maxTokens: 200 })).toBe(25);
    expect(contextUsagePercent({ usedTokens: 50 })).toBeUndefined();
    expect(contextUsagePercent({ maxTokens: 200 })).toBeUndefined();
    expect(contextUsagePercent({})).toBeUndefined();
    expect(contextUsagePercent({ usedTokens: 10, maxTokens: 0 })).toBeUndefined();
  });
});

describe("contextUsageSummary", () => {
  test("summarizes used+max with the derived percentage", () => {
    expect(contextUsageSummary({ usedTokens: 8000, maxTokens: 32000 })).toBe(
      "Context usage: 8.0K of 32.0K tokens (25%)",
    );
  });

  test("summarizes used-only and empty models", () => {
    expect(contextUsageSummary({ usedTokens: 12000 })).toBe("Context usage: 12.0K tokens used");
    expect(contextUsageSummary({})).toBe("Context usage: unknown");
  });
});

describe("ContextUsage", () => {
  test("trigger shows the derived percentage when used+max are present", () => {
    const html = renderToStaticMarkup(<ContextUsage usage={{ usedTokens: 8000, maxTokens: 32000 }} />);
    expect(html).toContain('data-slot="context-trigger"');
    expect(html).toContain("25%");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls");
  });

  test("trigger shows the used count when no max is known", () => {
    const html = renderToStaticMarkup(<ContextUsage usage={{ usedTokens: 12000 }} />);
    expect(html).toContain("12.0K");
    expect(html).not.toContain("%");
  });

  test("trigger shows an honest em-dash when nothing is known", () => {
    const html = renderToStaticMarkup(<ContextUsage usage={{}} />);
    expect(html).toContain("—");
    expect(html).not.toContain("%");
  });

  test("closed by default; default open composition shows all rows", () => {
    const html = renderToStaticMarkup(
      <ContextUsage
        defaultOpen
        usage={{
          modelId: "claude-opus-4",
          usedTokens: 8000,
          maxTokens: 32000,
          inputTokens: 5000,
          outputTokens: 3000,
          costUsd: 0.42,
        }}
      />,
    );
    expect(html).toContain('data-slot="context-content"');
    expect(html).toContain('role="region"');
    expect(html).toContain("claude-opus-4");
    expect(html).toContain("8.0K / 32.0K (25%)");
    expect(html).toContain("Input");
    expect(html).toContain("5.0K");
    expect(html).toContain("Output");
    expect(html).toContain("3.0K");
    expect(html).toContain("Reasoning");
    expect(html).toContain("Cache");
    expect(html).toContain("Cost $0.42");
  });

  test("undefined token rows render an honest em-dash", () => {
    const html = renderToStaticMarkup(<ContextUsage defaultOpen usage={{ inputTokens: 100 }} />);
    expect(html).toContain("100");
    expect(html.match(/—/g)!.length).toBeGreaterThanOrEqual(3);
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const html = renderToStaticMarkup(<ContextUsage defaultOpen usage={{ usedTokens: 1, maxTokens: 4 }} />);
    expect(html).toContain('data-slot="context-content"');
  });

  test("default trigger exposes the usage summary as its accessible name", () => {
    const html = renderToStaticMarkup(<ContextUsage usage={{ usedTokens: 8000, maxTokens: 32000 }} />);
    expect(html).toContain('aria-label="Context usage: 8.0K of 32.0K tokens (25%)"');
    const usedOnly = renderToStaticMarkup(<ContextUsage usage={{ usedTokens: 12000 }} />);
    expect(usedOnly).toContain('aria-label="Context usage: 12.0K tokens used"');
    const empty = renderToStaticMarkup(<ContextUsage usage={{}} />);
    expect(empty).toContain('aria-label="Context usage: unknown"');
  });

  test("a custom aria-label on the trigger wins over the summary", () => {
    const html = renderToStaticMarkup(
      <ContextUsage usage={{ usedTokens: 8000, maxTokens: 32000 }}>
        <ContextTrigger aria-label="My usage" />
        <ContextContent />
      </ContextUsage>,
    );
    expect(html).toContain('aria-label="My usage"');
    expect(html).not.toContain("Context usage: 8.0K");
  });

  test("pending hover timer is cleared on unmount and never fires", async () => {
    const changes: boolean[] = [];
    await render(<ContextUsage usage={{}} onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => sleep(400));
    expect(changes).toEqual([]);
  });

  test("click toggles and reports onOpenChange", async () => {
    const changes: boolean[] = [];
    await render(<ContextUsage usage={{}} onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => trigger.click());
    expect(changes).toEqual([true]);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
    await act(async () => trigger.click());
    expect(changes).toEqual([true, false]);
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
  });

  test("controlled open never self-toggles", async () => {
    const changes: boolean[] = [];
    await render(<ContextUsage open usage={{}} onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => trigger.click());
    expect(changes).toEqual([false]);
    expect(container!.querySelector('[data-slot="context-usage"]')!.getAttribute("data-state")).toBe("open");
  });

  test("Escape closes and restores focus to the trigger", async () => {
    await render(<ContextUsage usage={{}} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => trigger.click());
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
    await act(async () => {
      container!
        .querySelector('[data-slot="context-usage"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("hover does not open synchronously but opens after the delay", async () => {
    await render(<ContextUsage usage={{}} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
    await act(async () => sleep(400));
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
  });

  test("mouseleave before the delay cancels the hover open", async () => {
    await render(<ContextUsage usage={{}} />);
    const rootEl = container!.querySelector('[data-slot="context-usage"]')!;
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => {
      rootEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    await act(async () => sleep(400));
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
  });

  test("openOnHover=false disables the hover open", async () => {
    await render(<ContextUsage usage={{}} openOnHover={false} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => sleep(400));
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
  });

  test("controlled mode emits hover open/close intents without self-toggling", async () => {
    const changes: boolean[] = [];
    await render(<ContextUsage open={false} usage={{}} onOpenChange={(open) => changes.push(open)} />);
    const rootEl = container!.querySelector('[data-slot="context-usage"]')!;
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => sleep(400));
    expect(changes).toEqual([true]);
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
    await act(async () => {
      rootEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(changes).toEqual([true, false]);
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
  });

  test("a controlled external close clears the hover-open state (no spurious close on mouseleave)", async () => {
    const changes: boolean[] = [];
    function Controlled({ open }: { open: boolean }) {
      return <ContextUsage open={open} usage={{}} onOpenChange={(next) => changes.push(next)} />;
    }
    await render(<Controlled open={false} />);
    const rootEl = container!.querySelector('[data-slot="context-usage"]')!;
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => sleep(400));
    expect(changes).toEqual([true]);
    await act(async () => root!.render(<Controlled open={true} />));
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
    await act(async () => root!.render(<Controlled open={false} />));
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
    await act(async () => {
      rootEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(changes).toEqual([true]);
  });

  test("click during a pending hover timer wins over hover close", async () => {
    await render(<ContextUsage usage={{}} />);
    const rootEl = container!.querySelector('[data-slot="context-usage"]')!;
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => trigger.click());
    await act(async () => sleep(400));
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
    await act(async () => {
      rootEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
  });

  test("trigger composes host mouse/focus handlers with internal ones", async () => {
    const calls: string[] = [];
    await render(
      <ContextUsage usage={{}}>
        <ContextTrigger
          onMouseEnter={() => calls.push("enter")}
          onFocus={() => calls.push("focus")}
          onBlur={() => calls.push("blur")}
        />
        <ContextContent />
      </ContextUsage>,
    );
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(calls).toEqual(["enter", "focus", "blur"]);
    await act(async () => sleep(400));
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
  });

  test("blur closes a focus-opened panel and clears the auto-open state", async () => {
    const changes: boolean[] = [];
    await render(<ContextUsage usage={{}} onOpenChange={(open) => changes.push(open)} />);
    const rootEl = container!.querySelector('[data-slot="context-usage"]')!;
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await act(async () => sleep(400));
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
    expect(changes).toEqual([true]);
    await act(async () => {
      trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
    expect(changes).toEqual([true, false]);
    await act(async () => {
      rootEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      rootEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    await act(async () => sleep(400));
    expect(changes).toEqual([true, false]);
  });

  test("focus moving from the trigger into the content keeps the panel open", async () => {
    await render(<ContextUsage usage={{}} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await act(async () => sleep(400));
    const content = container!.querySelector('[data-slot="context-content"]')!;
    await act(async () => {
      trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: content }));
    });
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
  });

  test("focus leaving the content to outside the root closes the panel", async () => {
    const changes: boolean[] = [];
    await render(<ContextUsage usage={{}} onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await act(async () => sleep(400));
    const content = container!.querySelector('[data-slot="context-content"]')!;
    await act(async () => {
      trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: content }));
    });
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
    await act(async () => {
      content.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
    expect(changes).toEqual([true, false]);
  });

  test("a click-opened panel stays open across blur", async () => {
    await render(<ContextUsage usage={{}} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => trigger.click());
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
    await act(async () => {
      trigger.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
  });

  test("root composes host onMouseLeave with hover-close behavior", async () => {
    let leaves = 0;
    await render(<ContextUsage usage={{}} onMouseLeave={() => leaves++} />);
    const rootEl = container!.querySelector('[data-slot="context-usage"]')!;
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="context-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await act(async () => sleep(400));
    expect(container!.querySelector('[data-slot="context-content"]')).not.toBeNull();
    await act(async () => {
      rootEl.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(leaves).toBe(1);
    expect(container!.querySelector('[data-slot="context-content"]')).toBeNull();
  });

  test("compound children compose the parts", () => {
    const html = renderToStaticMarkup(
      <ContextUsage defaultOpen usage={{ inputTokens: 10, costUsd: 0.0042 }}>
        <ContextTrigger />
        <ContextContent>
          <ContextContentHeader />
          <ContextContentBody>
            <ContextInputUsage />
            <ContextOutputUsage />
            <ContextReasoningUsage />
            <ContextCacheUsage />
          </ContextContentBody>
          <ContextContentFooter />
        </ContextContent>
      </ContextUsage>,
    );
    expect(html).toContain('data-slot="context-input-usage"');
    expect(html).toContain('data-slot="context-output-usage"');
    expect(html).toContain('data-slot="context-reasoning-usage"');
    expect(html).toContain('data-slot="context-cache-usage"');
    expect(html).toContain("Cost $0.0042");
  });

  test("parts throw outside ContextUsage", () => {
    expect(() => renderToStaticMarkup(<ContextTrigger />)).toThrow();
  });
});
