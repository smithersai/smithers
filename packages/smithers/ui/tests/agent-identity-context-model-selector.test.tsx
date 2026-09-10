/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SMITHERS_UI_STYLE_ATTR } from "../src/index";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorItem,
  ModelSelectorTrigger,
} from "../src/agents/ModelSelector";
import { Select, SelectValue } from "../src/select";
import { ModelBadge, ProviderBadge } from "../src/agents/badges";

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

describe("ModelSelector", () => {
  test("flat options render a trigger with the placeholder", () => {
    const html = renderToStaticMarkup(
      <ModelSelector placeholder="Pick a model" options={[{ id: "a", name: "Alpha" }]} />,
    );
    expect(html).toContain('data-slot="model-selector-trigger"');
    expect(html).toContain("Pick a model");
  });

  test("groups render group structure in the trigger composition", () => {
    const html = renderToStaticMarkup(
      <ModelSelector
        groups={[{ label: "Anthropic", options: [{ id: "claude", name: "Claude", provider: "anthropic" }] }]}
      />,
    );
    expect(html).toContain('data-slot="model-selector-trigger"');
  });

  test("disabled passes through to the trigger", () => {
    const html = renderToStaticMarkup(<ModelSelector disabled options={[]} />);
    expect(html).toContain("disabled");
  });

  test("compound children render verbatim", () => {
    const html = renderToStaticMarkup(
      <ModelSelector>
        <ModelSelectorTrigger>
          <SelectValue placeholder="Custom" />
        </ModelSelectorTrigger>
        <ModelSelectorContent>
          <ModelSelectorItem option={{ id: "x", name: "X-Ray", provider: "acme", description: "Fast" }} />
        </ModelSelectorContent>
      </ModelSelector>,
    );
    expect(html).toContain("Custom");
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const html = renderToStaticMarkup(<ModelSelector options={[{ id: "a", name: "Alpha" }]} />);
    expect(html).toContain('data-slot="model-selector-trigger"');
  });

  test("item renders provider badge, name, and description", async () => {
    await render(
      <Select open>
        <ModelSelectorTrigger>
          <SelectValue placeholder="Models" />
        </ModelSelectorTrigger>
        <ModelSelectorContent>
          <ModelSelectorItem option={{ id: "x", name: "X-Ray", provider: "acme", description: "Fast" }} />
        </ModelSelectorContent>
      </Select>,
    );
    const item = document.querySelector('[data-slot="model-selector-item"]');
    expect(item).not.toBeNull();
    expect(item!.textContent).toContain("X-Ray");
    expect(item!.textContent).toContain("acme");
    expect(item!.textContent).toContain("Fast");
  });

  test("disabled option is not selectable", async () => {
    await render(
      <Select open>
        <ModelSelectorTrigger>
          <SelectValue placeholder="Models" />
        </ModelSelectorTrigger>
        <ModelSelectorContent>
          <ModelSelectorItem option={{ id: "x", name: "X-Ray", disabled: true }} />
        </ModelSelectorContent>
      </Select>,
    );
    const item = document.querySelector('[data-slot="model-selector-item"]')!;
    expect(item.getAttribute("data-disabled")).not.toBeNull();
  });
});

describe("ModelBadge / ProviderBadge", () => {
  test("ModelBadge renders model text with optional provider", () => {
    const html = renderToStaticMarkup(<ModelBadge model="claude-opus-4" provider="anthropic" />);
    expect(html).toContain('data-slot="model-badge"');
    expect(html).toContain("claude-opus-4");
    expect(html).toContain("anthropic");
    expect(html).toContain('data-provider="anthropic"');
  });

  test("ModelBadge without provider stays honest", () => {
    const html = renderToStaticMarkup(<ModelBadge model="local-model" />);
    expect(html).toContain("local-model");
    expect(html).not.toContain("sui-model-badge-provider");
  });

  test("ProviderBadge renders provider text and icon slot", () => {
    const html = renderToStaticMarkup(<ProviderBadge provider="openai" icon={<svg data-testid="icon" />} />);
    expect(html).toContain('data-slot="provider-badge"');
    expect(html).toContain("openai");
    expect(html).toContain('data-testid="icon"');
  });
});
