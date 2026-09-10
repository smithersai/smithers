/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type ModelBadgeProps = Omit<ComponentProps<"span">, "children"> & {
  model: string;
  provider?: string;
  icon?: ReactNode;
};

/** Text-first model identity chip; `icon` is a slot, no logo assets bundled. */
export function ModelBadge({ model, provider, icon, className, ...props }: ModelBadgeProps) {
  useInjectUiCss();
  return (
    <span data-slot="model-badge" data-provider={provider} className={cn("sui-model-badge", className)} {...props}>
      {icon ? (
        <span className="sui-model-badge-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="sui-model-badge-name">{model}</span>
      {provider ? <span className="sui-model-badge-provider">{provider}</span> : null}
    </span>
  );
}

export type ProviderBadgeProps = Omit<ComponentProps<"span">, "children"> & {
  provider: string;
  icon?: ReactNode;
};

/** Text-first provider identity chip; `icon` is a slot, no logo assets bundled. */
export function ProviderBadge({ provider, icon, className, ...props }: ProviderBadgeProps) {
  useInjectUiCss();
  return (
    <span data-slot="provider-badge" className={cn("sui-provider-badge", className)} {...props}>
      {icon ? (
        <span className="sui-provider-badge-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="sui-provider-badge-name">{provider}</span>
    </span>
  );
}
