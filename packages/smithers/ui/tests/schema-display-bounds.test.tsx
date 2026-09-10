/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SchemaDisplay } from "../src/artifacts/SchemaDisplay";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; }).IS_REACT_ACT_ENVIRONMENT = true;

const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_PROPERTIES = 200;

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
});

async function render(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const current = root;
  await act(async () => current.render(element));
}

function nestedSchema(levels: number): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: "object", properties: {} };
  let cursor = schema;
  for (let index = 1; index <= levels; index += 1) {
    const properties = cursor.properties as Record<string, unknown>;
    if (index === levels) {
      properties[`level-${index}`] = { type: "string" };
    } else {
      const child: Record<string, unknown> = { type: "object", properties: {} };
      properties[`level-${index}`] = child;
      cursor = child;
    }
  }
  return schema;
}

describe("SchemaDisplay traversal bounds", () => {
  test("renders a self-referential property as circular without throwing", async () => {
    const schema: Record<string, unknown> = { type: "object", properties: {} };
    (schema.properties as Record<string, unknown>).self = schema;

    await render(<SchemaDisplay schema={schema} />);

    expect(container!.querySelector(".sui-schema-type")!.textContent).toBe("[circular]");
  });

  test("renders a shared schema normally in both sibling branches", async () => {
    const shared = { type: "object", properties: { value: { type: "string" } } };
    await render(
      <SchemaDisplay schema={{ type: "object", properties: { left: shared, right: shared } }} />,
    );

    const names = [...container!.querySelectorAll(".sui-schema-name")].map((element) => element.textContent);
    expect(names.filter((name) => name === "value")).toHaveLength(2);
    expect(container!.textContent).not.toContain("[circular]");
  });

  test("renders at the depth boundary and truncates just past it", async () => {
    await render(<SchemaDisplay schema={nestedSchema(MAX_SCHEMA_DEPTH)} />);
    expect(container!.textContent).toContain(`level-${MAX_SCHEMA_DEPTH}`);
    expect(container!.textContent).not.toContain("[truncated]");

    const current = root!;
    await act(async () => current.render(<SchemaDisplay schema={nestedSchema(MAX_SCHEMA_DEPTH + 1)} />));
    expect(container!.textContent).toContain("[truncated]");
    expect(container!.textContent).not.toContain(`level-${MAX_SCHEMA_DEPTH + 1}`);
  });

  test("bounds schemas with thousands of properties", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 2_500 }, (_, index) => [`field-${index}`, { type: "string" }]),
    );

    await render(<SchemaDisplay schema={{ type: "object", properties }} />);

    expect(container!.querySelectorAll(".sui-schema-row")).toHaveLength(MAX_SCHEMA_PROPERTIES + 1);
    expect(container!.textContent).toContain("[truncated: 2300 more properties]");
  });

  test("bounds a self-referential items chain in the rendered type", async () => {
    const arraySchema: Record<string, unknown> = { type: "array" };
    arraySchema.items = arraySchema;

    await render(
      <SchemaDisplay schema={{ type: "object", properties: { values: arraySchema } }} />,
    );

    expect(container!.querySelector(".sui-schema-type")!.textContent).toBe("array<[circular]>");
  });
});
