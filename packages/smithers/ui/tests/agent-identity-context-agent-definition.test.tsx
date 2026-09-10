/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type MouseEvent, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import {
  AgentContent,
  AgentDefinition,
  AgentHeader,
  AgentInstructions,
  AgentOutputSchema,
  AgentTool,
  AgentTools,
} from "../src/agents/AgentDefinition";
import { AgentCard } from "../src/agents/AgentCard";
import { agentsCss } from "../src/agents/agentsCss";

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

describe("AgentDefinition", () => {
  test("renders default header with identity and availability", () => {
    const html = renderToStaticMarkup(
      <AgentDefinition name="reviewer" provider="anthropic" model="claude-opus-4" availability="available" />,
    );
    expect(html).toContain('data-slot="agent-definition"');
    expect(html).toContain('data-availability="available"');
    expect(html).toContain("reviewer");
    expect(html).toContain("anthropic");
    expect(html).toContain("claude-opus-4");
    expect(html).toContain("Available");
  });

  test("defaults availability to an honest unknown", () => {
    const html = renderToStaticMarkup(<AgentDefinition name="a" />);
    expect(html).toContain('data-availability="unknown"');
    expect(html).toContain("Unknown");
  });

  test("composed children render verbatim", () => {
    const html = renderToStaticMarkup(
      <AgentDefinition name="a">
        <AgentHeader>
          <span>Custom header</span>
        </AgentHeader>
        <AgentContent>
          <p>Body</p>
        </AgentContent>
      </AgentDefinition>,
    );
    expect(html).toContain("Custom header");
    expect(html).toContain("Body");
    expect(html).not.toContain("sui-agentdef-availability");
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const html = renderToStaticMarkup(<AgentDefinition name="a" availability="unauthenticated" />);
    expect(html).toContain("Unauthenticated");
  });

  test("injects the composed sheet carrying the lane css fragment", async () => {
    await render(<AgentDefinition name="a" />);
    expect(document.querySelector(`style[${SMITHERS_UI_STYLE_ATTR}]`)?.textContent).toContain(agentsCss.trim());
  });
});

describe("AgentInstructions", () => {
  test("closed by default; trigger carries the disclosure contract", () => {
    const html = renderToStaticMarkup(<AgentInstructions text="Be terse." />);
    expect(html).toContain('data-slot="agent-instructions"');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls");
    expect(html).not.toContain("Be terse.");
  });

  test("renders text through Markdown when open", async () => {
    await render(<AgentInstructions defaultOpen text={"**Bold** rule"} />);
    const region = container!.querySelector('[data-slot="agent-instructions-content"]')!;
    expect(region.getAttribute("role")).toBe("region");
    expect(region.innerHTML).toContain("<strong>Bold</strong>");
  });

  test("toggle is uncontrolled by default and reports onOpenChange", async () => {
    const changes: boolean[] = [];
    await render(<AgentInstructions text="Hi" onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="agent-instructions-trigger"]')!;
    await act(async () => trigger.click());
    expect(changes).toEqual([true]);
    expect(container!.querySelector('[data-slot="agent-instructions"]')!.getAttribute("data-state")).toBe("open");
  });

  test("controlled open never self-toggles", async () => {
    const changes: boolean[] = [];
    await render(<AgentInstructions open={false} text="Hi" onOpenChange={(open) => changes.push(open)} />);
    const trigger = container!.querySelector<HTMLButtonElement>('[data-slot="agent-instructions-trigger"]')!;
    await act(async () => trigger.click());
    expect(changes).toEqual([true]);
    expect(container!.querySelector('[data-slot="agent-instructions"]')!.getAttribute("data-state")).toBe("closed");
  });
});

describe("AgentTools / AgentTool", () => {
  const tool = {
    name: "read_file",
    description: "Read a file from disk",
    permissions: ["fs:read"],
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  };

  test("tools container is a list of collapsible items", () => {
    const html = renderToStaticMarkup(
      <AgentTools>
        <AgentTool tool={tool} />
      </AgentTools>,
    );
    expect(html).toContain('role="list"');
    expect(html).toContain('data-slot="agent-tool"');
    expect(html).toContain("read_file");
    expect(html).not.toContain("Read a file from disk");
  });

  test("open tool shows description, permissions, and formatted schema", () => {
    const html = renderToStaticMarkup(
      <AgentTools>
        <AgentTool tool={tool} defaultOpen />
      </AgentTools>,
    );
    expect(html).toContain("Read a file from disk");
    expect(html).toContain("Permissions:");
    expect(html).toContain("fs:read");
    expect(html).toContain("&quot;path&quot;");
    expect(html).toContain('role="region"');
  });

  test("tool without optional fields renders honestly", () => {
    const html = renderToStaticMarkup(
      <AgentTools>
        <AgentTool tool={{ name: "noop" }} defaultOpen />
      </AgentTools>,
    );
    expect(html).toContain("noop");
    expect(html).not.toContain("Permissions:");
    expect(html).not.toContain("sui-agentdef-schema");
  });
});

describe("AgentOutputSchema", () => {
  test("renders the declared schema in a scrollable region when open", () => {
    const html = renderToStaticMarkup(
      <AgentOutputSchema defaultOpen schema={{ type: "object", properties: { ok: { type: "boolean" } } }} />,
    );
    expect(html).toContain('data-slot="agent-output-schema"');
    expect(html).toContain("&quot;ok&quot;");
    expect(html).toContain('tabindex="0"');
  });

  test("closed by default", () => {
    const html = renderToStaticMarkup(<AgentOutputSchema schema={{ type: "string" }} />);
    expect(html).toContain('data-state="closed"');
    expect(html).not.toContain('"string"');
  });
});

describe("AgentCard", () => {
  test("renders identity, description, and availability", () => {
    const html = renderToStaticMarkup(
      <AgentCard name="coder" provider="openai" model="gpt-5" description="Writes code" availability="unavailable" />,
    );
    expect(html).toContain('data-slot="agent-card"');
    expect(html).toContain("coder");
    expect(html).toContain("gpt-5");
    expect(html).toContain("Writes code");
    expect(html).toContain('data-availability="unavailable"');
    expect(html).not.toContain("<button");
  });

  test("onSelect renders a real toggle button with aria-pressed", async () => {
    let selected = 0;
    await render(<AgentCard name="coder" selected onSelect={() => selected++} />);
    const button = container!.querySelector<HTMLButtonElement>('[data-slot="agent-card"]')!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("data-selected")).toBe("true");
    await act(async () => button.click());
    expect(selected).toBe(1);
  });

  test("disabled selectable card does not fire onSelect", async () => {
    let selected = 0;
    await render(<AgentCard name="coder" disabled onSelect={() => selected++} />);
    const button = container!.querySelector<HTMLButtonElement>('[data-slot="agent-card"]')!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(selected).toBe(0);
  });

  test("host onClick composes with onSelect instead of replacing it", async () => {
    const calls: string[] = [];
    const onClick = (event: MouseEvent<HTMLDivElement>) => {
      calls.push(event.currentTarget.tagName === "BUTTON" ? "click" : "unexpected");
    };
    await render(<AgentCard name="coder" onSelect={() => calls.push("select")} onClick={onClick} />);
    const button = container!.querySelector<HTMLButtonElement>('[data-slot="agent-card"]')!;
    await act(async () => button.click());
    expect(calls).toEqual(["select", "click"]);
  });

  test("non-selectable card still forwards host onClick", async () => {
    let clicks = 0;
    await render(<AgentCard name="coder" onClick={() => clicks++} />);
    const card = container!.querySelector<HTMLElement>('[data-slot="agent-card"]')!;
    expect(card.tagName).toBe("DIV");
    await act(async () => card.click());
    expect(clicks).toBe(1);
  });
});
