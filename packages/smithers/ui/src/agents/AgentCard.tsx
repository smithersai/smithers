/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { AgentAvailabilityBadge, type AgentAvailability } from "./AgentDefinition";

type AgentCardIdentity = {
  name: string;
  provider?: string;
  model?: string;
  description?: ReactNode;
  availability?: AgentAvailability;
  selected?: boolean;
  disabled?: boolean;
  children?: ReactNode;
};

/**
 * With `onSelect` the card renders a `<button>` and takes button props; without
 * it the card renders a `<div>` and takes div props.
 */
export type AgentCardProps =
  | (Omit<ComponentProps<"button">, keyof AgentCardIdentity | "title" | "onSelect" | "type"> &
    AgentCardIdentity & { onSelect: () => void })
  | (Omit<ComponentProps<"div">, keyof AgentCardIdentity | "title" | "onSelect"> &
    AgentCardIdentity & { onSelect?: undefined });

/**
 * Compact agent identity card. When `onSelect` is provided the card renders
 * as a real `<button aria-pressed>` toggle; otherwise it is a plain div.
 */
export function AgentCard(props: AgentCardProps) {
  useInjectUiCss();
  const { name, provider, model, description, availability = "unknown", selected = false, children } = props;
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
  if (props.onSelect) {
    const {
      name: _name,
      provider: _provider,
      model: _model,
      description: _description,
      availability: _availability,
      selected: _selected,
      disabled = false,
      onSelect,
      onClick,
      className,
      children: _children,
      ...rest
    } = props;
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
          onClick?.(event);
        }}
        className={cn("sui-agentcard sui-agentcard-selectable", className)}
        {...rest}
      >
        {body}
      </button>
    );
  }
  const {
    name: _name,
    provider: _provider,
    model: _model,
    description: _description,
    availability: _availability,
    selected: _selected,
    disabled = false,
    onSelect: _onSelect,
    className,
    children: _children,
    ...rest
  } = props;
  return (
    <div
      data-slot="agent-card"
      data-availability={availability}
      data-selected={selected ? "true" : "false"}
      aria-disabled={disabled || undefined}
      className={cn("sui-agentcard", className)}
      {...rest}
    >
      {body}
    </div>
  );
}
