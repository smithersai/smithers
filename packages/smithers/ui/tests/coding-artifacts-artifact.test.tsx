/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Artifact,
  ArtifactActions,
  ArtifactAction,
  ArtifactClose,
  ArtifactContent,
  ArtifactDescription,
  ArtifactHeader,
  ArtifactTitle,
} from "../src/artifacts/Artifact";
import { Snippet } from "../src/artifacts/Snippet";
import { PackageInfo } from "../src/artifacts/PackageInfo";
import { SchemaDisplay } from "../src/artifacts/SchemaDisplay";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => current.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  delete document.documentElement.dataset.theme;
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

describe("Artifact family", () => {
  test("composes header/title/description/actions/content with data slots", async () => {
    await render(
      <Artifact>
        <ArtifactHeader>
          <ArtifactTitle>report.html</ArtifactTitle>
          <ArtifactActions>
            <ArtifactAction label="Copy link" />
            <ArtifactClose onClose={() => {}} />
          </ArtifactActions>
        </ArtifactHeader>
        <ArtifactDescription>Generated report</ArtifactDescription>
        <ArtifactContent>body</ArtifactContent>
      </Artifact>,
    );
    expect(container!.querySelector('[data-slot="artifact"]')).not.toBeNull();
    expect(container!.querySelector('[data-slot="artifact-title"]')!.tagName).toBe("H3");
    expect(container!.querySelector('[data-slot="artifact-description"]')!.tagName).toBe("P");
    expect(container!.querySelector('[data-slot="artifact-actions"]')!.getAttribute("role")).toBe("toolbar");
    expect(container!.querySelector('[data-slot="artifact-actions"]')!.getAttribute("aria-label")).toBe(
      "Artifact actions",
    );
    expect(container!.querySelector('[data-slot="artifact-content"]')!.textContent).toBe("body");
  });

  test("ArtifactAction is a labelled icon button; ArtifactClose defaults its label and fires onClose", async () => {
    let closed = 0;
    await render(
      <ArtifactActions>
        <ArtifactAction label="Download" tooltip="Download file" icon={<svg />} />
        <ArtifactClose
          onClose={() => {
            closed += 1;
          }}
        />
      </ArtifactActions>,
    );
    const action = container!.querySelector('[data-slot="artifact-action"]') as HTMLButtonElement;
    expect(action.getAttribute("aria-label")).toBe("Download");
    expect(action.type).toBe("button");
    const close = container!.querySelector('[data-slot="artifact-close"]') as HTMLButtonElement;
    expect(close.getAttribute("aria-label")).toBe("Close artifact");
    await act(async () => close.click());
    expect(closed).toBe(1);
  });

  test("renders under data-theme=dark", async () => {
    document.documentElement.dataset.theme = "dark";
    await render(
      <Artifact>
        <ArtifactContent>dark</ArtifactContent>
      </Artifact>,
    );
    expect(container!.querySelector('[data-slot="artifact"]')!.textContent).toContain("dark");
  });
});

describe("Snippet", () => {
  test("renders code and routes copies through onCopyCode", async () => {
    const copied: string[] = [];
    await render(<Snippet code="pnpm add react" language="sh" onCopyCode={(code) => copied.push(code)} />);
    expect(container!.querySelector(".sui-snippet-code")!.textContent).toBe("pnpm add react");
    const button = container!.querySelector('[data-slot="snippet-copy"]') as HTMLButtonElement;
    await act(async () => button.click());
    expect(copied).toEqual(["pnpm add react"]);
    expect(button.textContent).toBe("Copied");
  });

  test("hides the copy button without a callback or clipboard", async () => {
    const original =
      Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard") ??
      Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    try {
      await render(<Snippet code="no-copy" />);
      expect(container!.querySelector('[data-slot="snippet-copy"]')).toBeNull();
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
    }
  });
});

describe("PackageInfo", () => {
  test("renders name, version, description, and install command snippet", async () => {
    await render(
      <PackageInfo
        name="@smthrs/ui"
        version="0.29.0"
        description="Shared component library"
        registryUrl="https://www.npmjs.com/package/@smthrs/ui"
        installCommand="pnpm add @smthrs/ui"
      />,
    );
    const link = container!.querySelector("a.sui-pkginfo-name") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("npmjs.com");
    expect(container!.querySelector(".sui-pkginfo-version")!.textContent).toBe("0.29.0");
    expect(container!.querySelector(".sui-snippet-code")!.textContent).toBe("pnpm add @smthrs/ui");
  });

  test("drops unsafe registry URLs to plain text", async () => {
    await render(<PackageInfo name="pkg" registryUrl="javascript:alert(1)" />);
    expect(container!.querySelector("a.sui-pkginfo-name")).toBeNull();
    expect(container!.querySelector("span.sui-pkginfo-name")!.textContent).toBe("pkg");
  });
});

describe("SchemaDisplay", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Display name" },
      meta: { type: "object", properties: { count: { type: "number" } } },
    },
  };

  test("renders object schemas as a nested definition list with required markers", async () => {
    await render(<SchemaDisplay schema={schema} name="Output" />);
    expect(container!.querySelector('[data-slot="schema-display"]')!.getAttribute("data-state")).toBe("open");
    const names = [...container!.querySelectorAll(".sui-schema-name")].map((el) => el.textContent);
    expect(names.some((n) => n?.startsWith("name"))).toBe(true);
    expect(names.some((n) => n?.startsWith("meta"))).toBe(true);
    expect(container!.querySelector(".sui-schema-required")!.getAttribute("aria-label")).toBe("required");
    expect(container!.textContent).toContain("Display name");
    // nested property rendered inside a nested list
    expect(container!.querySelectorAll(".sui-schema-list .sui-schema-list").length).toBe(1);
  });

  test("collapses via a native disclosure and honors controlled open", async () => {
    await render(<SchemaDisplay schema={schema} defaultOpen={false} />);
    const trigger = container!.querySelector('[data-slot="schema-display-trigger"]') as HTMLButtonElement;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container!.querySelector('[data-slot="schema-display-content"]')).toBeNull();
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector('[data-slot="schema-display-content"]')!.getAttribute("role")).toBe("region");
  });

  test("falls back to a CodeBlock for non-object schemas", async () => {
    await render(<SchemaDisplay schema={{ type: "string" }} />);
    expect(container!.querySelector('[data-slot="code-block"]')).not.toBeNull();
    expect(container!.textContent).toContain('"type": "string"');
  });
});
