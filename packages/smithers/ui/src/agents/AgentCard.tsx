/** @jsxImportSource react */
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { AgentAvailabilityBadge, type AgentAvailability } from "./AgentDefinition";

export type AgentCardProps = Omit<ComponentProps<"div">, "children" | "title" | "onSelect"> & {
  name: string;
  provider?: string;
  model?: string;
  description?: ReactNode;
  availability?: AgentAvailability;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: ReactNode;
};

/**
 * Compact agent identity card. When `onSelect` is provided the card renders
 * as a real `<button aria-pressed>` toggle; otherwise it is a plain div.
 */
export function AgentCard({
  name,
  provider,
  model,
  description,
  availability = "unknown",
  selected = false,
  disabled = false,
  onSelect,
  onClick,
  className,
  children,
  ...props
}: AgentCardProps) {
  useInjectUiCss();
  const body = (
    <>
      <span className="sui-agentcard-header">
        <span className="sui-agentcard-name">{name}</span>
        <AgentAvailabilityBadge availability={availability} />
      </span>
      {provider || model ? (
        <span className="sui-agentcard-identity">
          {provider ? <span className="sui-agentcard-provider">{provider}</span> : null}
          {provider && model ? (
            <span className="sui-agentcard-identity-sep" aria-hidden="true">
              /
            </span>
          ) : null}
          {model ? <span className="sui-agentcard-model">{model}</span> : null}
        </span>
      ) : null}
      {description ? <span className="sui-agentcard-description">{description}</span> : null}
      {children}
    </>
  );
  if (onSelect) {
    return (
      <button
        type="button"
        data-slot="agent-card"
        data-availability={availability}
        data-selected={selected ? "true" : "false"}
        aria-pressed={selected}
        disabled={disabled}
        onClick={(event) => {
          onSelect();
          onClick?.(event as unknown as MouseEvent<HTMLDivElement>);
        }}
        className={cn("sui-agentcard sui-agentcard-selectable", className)}
        {...(props as ComponentProps<"button">)}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      data-slot="agent-card"
      data-availability={availability}
      data-selected={selected ? "true" : "false"}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={cn("sui-agentcard", className)}
      {...props}
    >
      {body}
    </div>
  );
}
