/** @jsxImportSource react */
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { Markdown } from "../primitives/markdown";
import { formatJsonSafe } from "../agentic/formatJsonSafe";

export type AgentAvailability = "available" | "unauthenticated" | "unavailable" | "unknown";

export type AgentToolDescriptorModel = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  permissions?: readonly string[];
};

const AVAILABILITY_LABEL: Record<AgentAvailability, string> = {
  available: "Available",
  unauthenticated: "Unauthenticated",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

export function availabilityLabel(availability: AgentAvailability): string {
  return AVAILABILITY_LABEL[availability];
}

export type AgentAvailabilityBadgeProps = Omit<ComponentProps<"span">, "children"> & {
  availability: AgentAvailability;
};

export function AgentAvailabilityBadge({ availability, className, ...props }: AgentAvailabilityBadgeProps) {
  useInjectUiCss();
  return (
    <span
      data-slot="agent-availability"
      data-availability={availability}
      className={cn("sui-agentdef-availability", className)}
      {...props}
    >
      {AVAILABILITY_LABEL[availability]}
    </span>
  );
}

export type AgentDefinitionProps = Omit<ComponentProps<"div">, "children"> & {
  name: string;
  provider?: string;
  model?: string;
  availability?: AgentAvailability;
  children?: ReactNode;
};

/**
 * Agent identity card root. The bare name `Agent` is frozen out (too
 * collision-prone with runtime SDK exports), so the presentation root is
 * `AgentDefinition`. With no children it renders a default header (name,
 * provider/model, availability); with children it renders them verbatim.
 */
export function AgentDefinition({
  name,
  provider,
  model,
  availability = "unknown",
  className,
  children,
  ...props
}: AgentDefinitionProps) {
  useInjectUiCss();
  return (
    <div
      data-slot="agent-definition"
      data-availability={availability}
      className={cn("sui-agentdef", className)}
      {...props}
    >
      {children ?? (
        <AgentHeader>
          <span className="sui-agentdef-name">{name}</span>
          {provider || model ? (
            <span className="sui-agentdef-identity">
              {provider ? <span className="sui-agentdef-provider">{provider}</span> : null}
              {provider && model ? (
                <span className="sui-agentdef-identity-sep" aria-hidden="true">
                  /
                </span>
              ) : null}
              {model ? <span className="sui-agentdef-model">{model}</span> : null}
            </span>
          ) : null}
          <AgentAvailabilityBadge availability={availability} />
        </AgentHeader>
      )}
    </div>
  );
}

export function AgentHeader({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="agent-header" className={cn("sui-agentdef-header", className)} {...props} />;
}

export function AgentContent({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="agent-content" className={cn("sui-agentdef-content", className)} {...props} />;
}

type Openable = { open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void };

function useDisclosure({ open, defaultOpen = false, onOpenChange }: Openable) {
  const isControlled = open !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isOpen = isControlled ? open : uncontrolledOpen;
  function toggle() {
    const next = !isOpen;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }
  return { isOpen, toggle };
}

export type AgentInstructionsProps = Omit<ComponentProps<"div">, "children"> &
  Openable & { text?: string; children?: ReactNode };

/**
 * Collapsible agent instructions/system prompt. Renders `text` through the
 * Markdown primitive when given, else children verbatim.
 */
export function AgentInstructions({
  text,
  className,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: AgentInstructionsProps) {
  useInjectUiCss();
  const triggerId = `${useId()}-agentdef-instructions-trigger`;
  const contentId = `${useId()}-agentdef-instructions-content`;
  const { isOpen, toggle } = useDisclosure({ open, defaultOpen, onOpenChange });
  return (
    <div
      data-slot="agent-instructions"
      data-state={isOpen ? "open" : "closed"}
      className={cn("sui-agentdef-instructions", className)}
      {...props}
    >
      <button
        type="button"
        id={triggerId}
        data-slot="agent-instructions-trigger"
        className="sui-agentdef-trigger"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={toggle}
      >
        <span className="sui-agentdef-chevron" aria-hidden="true">
          ›
        </span>
        <span className="sui-agentdef-trigger-label">Instructions</span>
      </button>
      {isOpen ? (
        <div
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
          data-slot="agent-instructions-content"
          className="sui-agentdef-region"
        >
          {text !== undefined ? <Markdown content={text} /> : children}
        </div>
      ) : null}
    </div>
  );
}

export function AgentTools({ className, ...props }: ComponentProps<"div">) {
  useInjectUiCss();
  return <div data-slot="agent-tools" role="list" className={cn("sui-agentdef-tools", className)} {...props} />;
}

export type AgentToolProps = Omit<ComponentProps<"li">, "children" | "title"> &
  Openable & { tool: AgentToolDescriptorModel; children?: ReactNode };

/**
 * Collapsible tool descriptor row: name, description, permissions, and the
 * tool input schema pretty-printed via formatJsonSafe.
 */
export function AgentTool({
  tool,
  className,
  children,
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: AgentToolProps) {
  useInjectUiCss();
  const triggerId = `${useId()}-agentdef-tool-trigger`;
  const contentId = `${useId()}-agentdef-tool-content`;
  const { isOpen, toggle } = useDisclosure({ open, defaultOpen, onOpenChange });
  return (
    <li
      data-slot="agent-tool"
      data-state={isOpen ? "open" : "closed"}
      className={cn("sui-agentdef-tool", className)}
      {...props}
    >
      <button
        type="button"
        id={triggerId}
        data-slot="agent-tool-trigger"
        className="sui-agentdef-trigger"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={toggle}
      >
        <span className="sui-agentdef-chevron" aria-hidden="true">
          ›
        </span>
        <span className="sui-agentdef-tool-name">{tool.name}</span>
      </button>
      {isOpen ? (
        <div
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
          data-slot="agent-tool-content"
          className="sui-agentdef-region"
        >
          {tool.description ? <p className="sui-agentdef-tool-description">{tool.description}</p> : null}
          {tool.permissions && tool.permissions.length > 0 ? (
            <p className="sui-agentdef-tool-permissions">
              <span className="sui-agentdef-tool-permissions-label">Permissions: </span>
              {tool.permissions.join(", ")}
            </p>
          ) : null}
          {tool.inputSchema !== undefined ? (
            <pre
              role="region"
              tabIndex={0}
              aria-label={`Input schema for ${tool.name}`}
              className="sui-agentdef-schema"
            >
              {formatJsonSafe(tool.inputSchema)}
            </pre>
          ) : null}
          {children}
        </div>
      ) : null}
    </li>
  );
}

export type AgentOutputSchemaProps = Omit<ComponentProps<"div">, "children"> & Openable & { schema: unknown };

/**
 * Collapsible view of the agent's DECLARED output schema. Named
 * AgentOutputSchema per the frozen program surface; it is unrelated to the
 * agentic `AgentOutput` message renderer (which composes parsed response
 * models, not schemas).
 */
export function AgentOutputSchema({
  schema,
  className,
  open,
  defaultOpen = false,
  onOpenChange,
  ...props
}: AgentOutputSchemaProps) {
  useInjectUiCss();
  const triggerId = `${useId()}-agentdef-output-schema-trigger`;
  const contentId = `${useId()}-agentdef-output-schema-content`;
  const { isOpen, toggle } = useDisclosure({ open, defaultOpen, onOpenChange });
  return (
    <div
      data-slot="agent-output-schema"
      data-state={isOpen ? "open" : "closed"}
      className={cn("sui-agentdef-output-schema", className)}
      {...props}
    >
      <button
        type="button"
        id={triggerId}
        data-slot="agent-output-schema-trigger"
        className="sui-agentdef-trigger"
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={toggle}
      >
        <span className="sui-agentdef-chevron" aria-hidden="true">
          ›
        </span>
        <span className="sui-agentdef-trigger-label">Output schema</span>
      </button>
      {isOpen ? (
        <div
          id={contentId}
          role="region"
          aria-labelledby={triggerId}
          data-slot="agent-output-schema-content"
          className="sui-agentdef-region"
        >
          <pre role="region" tabIndex={0} aria-label="Agent output schema" className="sui-agentdef-schema">
            {formatJsonSafe(schema)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
