/** @jsxImportSource react */
import { type ComponentProps, type ReactNode, useId, useState } from "react";
import { formatJsonSafe } from "../agentic/formatJsonSafe";
import { cn } from "../cn";
import { CodeBlock } from "../primitives/CodeBlock";
import { useInjectUiCss } from "../styles";

export type SchemaDisplayProps = Omit<ComponentProps<"div">, "children"> & {
  schema: unknown;
  name?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

type JsonSchemaObject = {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  description?: unknown;
  items?: unknown;
  enum?: unknown;
};

/** Maximum property nesting rendered below the root schema. */
export const MAX_SCHEMA_DEPTH = 12;

/** Maximum property rows rendered across one schema display. */
export const MAX_SCHEMA_PROPERTIES = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaTypeOf(schema: JsonSchemaObject, seen: WeakSet<object>, depth: number): string {
  if (depth > MAX_SCHEMA_DEPTH) return "[truncated]";
  if (seen.has(schema)) return "[circular]";
  seen.add(schema);
  try {
    if (typeof schema.type === "string") {
      if (schema.type === "array" && isRecord(schema.items)) {
        return `array<${schemaTypeOf(schema.items as JsonSchemaObject, seen, depth + 1)}>`;
      }
      return schema.type;
    }
    if (Array.isArray(schema.enum)) return "enum";
    if (isRecord(schema.properties)) return "object";
    return "unknown";
  } finally {
    seen.delete(schema);
  }
}

type SchemaTraversalBudget = { remainingProperties: number; };

function SchemaMarkerRow({ text }: { text: string; }) {
  return (
    <div className="sui-schema-row" data-schema-truncated="true">
      <dt className="sui-schema-name">{text}</dt>
    </div>
  );
}

function renderSchemaPropertyList(
  schema: JsonSchemaObject,
  seen: WeakSet<object>,
  depth: number,
  budget: SchemaTraversalBudget,
): ReactNode {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const entries = Object.entries(properties);
  if (entries.length > 0 && depth >= MAX_SCHEMA_DEPTH) {
    return (
      <dl className="sui-schema-list">
        <SchemaMarkerRow text="[truncated]" />
      </dl>
    );
  }
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((v): v is string => typeof v === "string") : [],
  );
  const rows: ReactNode[] = [];
  seen.add(schema);
  try {
    for (let index = 0; index < entries.length; index += 1) {
      if (budget.remainingProperties === 0) {
        rows.push(
          <SchemaMarkerRow
            key="schema-property-limit"
            text={`[truncated: ${entries.length - index} more properties]`}
          />,
        );
        break;
      }
      budget.remainingProperties -= 1;
      const [propName, propSchema] = entries[index]!;
      const prop: JsonSchemaObject = isRecord(propSchema) ? propSchema : {};
      const circular = isRecord(propSchema) && seen.has(propSchema);
      const nested = !circular && isRecord(prop.properties);
      const description = typeof prop.description === "string" ? prop.description : undefined;
      rows.push(
        <div className="sui-schema-row" key={propName}>
          <dt className="sui-schema-name">
            {propName}
            {required.has(propName) ?
              (
                <span className="sui-schema-required" aria-label="required" title="required">
                  *
                </span>
              ) :
              null}
          </dt>
          <dd className="sui-schema-type">
            {circular ? "[circular]" : schemaTypeOf(prop, seen, depth + 1)}
          </dd>
          {description !== undefined ? <dd className="sui-schema-description">{description}</dd> : null}
          {nested ?
            (
              <dd style={{ flexBasis: "100%", margin: 0 }}>
                {renderSchemaPropertyList(prop, seen, depth + 1, budget)}
              </dd>
            ) :
            null}
        </div>,
      );
    }
  } finally {
    seen.delete(schema);
  }
  return <dl className="sui-schema-list">{rows}</dl>;
}

function SchemaPropertyList({ schema }: { schema: JsonSchemaObject; }) {
  return renderSchemaPropertyList(schema, new WeakSet<object>(), 0, {
    remainingProperties: MAX_SCHEMA_PROPERTIES,
  });
}

/**
 * JSON-Schema renderer: object schemas become a nested definition list
 * (name, type, required marker, description); anything else falls back to a
 * CodeBlock of the raw JSON. Collapsible; defaultOpen true.
 */
export function SchemaDisplay({
  schema,
  name,
  open: controlledOpen,
  defaultOpen = true,
  onOpenChange,
  className,
  ...props
}: SchemaDisplayProps) {
  useInjectUiCss();
  const triggerId = useId();
  const contentId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  function toggle() {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  const isObjectSchema = isRecord(schema) && (schema.type === "object" || isRecord(schema.properties)) &&
    isRecord((schema as JsonSchemaObject).properties);
  let body: ReactNode;
  if (isObjectSchema) {
    body = <SchemaPropertyList schema={schema as JsonSchemaObject} />;
  } else {
    body = <CodeBlock code={formatJsonSafe(schema)} language="json" showCopy={false} />;
  }

  return (
    <div
      data-slot="schema-display"
      data-state={open ? "open" : "closed"}
      className={cn("sui-schema", className)}
      {...props}
    >
      <button
        type="button"
        id={triggerId}
        data-slot="schema-display-trigger"
        className="sui-schema-trigger"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
      >
        {name ?? "Schema"}
      </button>
      {open ?
        (
          <div
            data-slot="schema-display-content"
            id={contentId}
            role="region"
            aria-labelledby={triggerId}
            className="sui-schema-content"
          >
            {body}
          </div>
        ) :
        null}
    </div>
  );
}
