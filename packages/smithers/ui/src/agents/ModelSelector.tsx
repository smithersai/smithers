/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../select";
import { ProviderBadge } from "./badges";

export type ModelOption = {
  id: string;
  name: string;
  provider?: string;
  description?: string;
  disabled?: boolean;
};

export type ModelSelectorProps = {
  value?: string;
  defaultValue?: string;
  onValueChange?: (id: string) => void;
  placeholder?: string;
  disabled?: boolean;
  options?: readonly ModelOption[];
  groups?: readonly { label: string; options: readonly ModelOption[] }[];
  children?: ReactNode;
};

/**
 * Model picker composed over the existing Radix Select primitives (no cmdk
 * dependency). Pass `options`/`groups` for the model-driven path or compound
 * children (ModelSelectorTrigger/Content/Group/Item) for full control.
 */
export function ModelSelector({
  value,
  defaultValue,
  onValueChange,
  placeholder = "Select a model",
  disabled,
  options,
  groups,
  children,
}: ModelSelectorProps) {
  useInjectUiCss();
  return (
    <Select value={value} defaultValue={defaultValue} onValueChange={onValueChange} disabled={disabled}>
      {children ?? (
        <>
          <ModelSelectorTrigger aria-label="Model">
            <SelectValue placeholder={placeholder} />
          </ModelSelectorTrigger>
          <ModelSelectorContent>
            {groups
              ? groups.map((group) => (
                  <ModelSelectorGroup key={group.label}>
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.options.map((option) => (
                      <ModelSelectorItem key={option.id} value={option.id} option={option} />
                    ))}
                  </ModelSelectorGroup>
                ))
              : (options ?? []).map((option) => (
                  <ModelSelectorItem key={option.id} value={option.id} option={option} />
                ))}
          </ModelSelectorContent>
        </>
      )}
    </Select>
  );
}

export function ModelSelectorTrigger({ className, ...props }: ComponentProps<typeof SelectTrigger>) {
  useInjectUiCss();
  return (
    <SelectTrigger data-slot="model-selector-trigger" className={cn("sui-model-sel-trigger", className)} {...props} />
  );
}

export function ModelSelectorContent({ className, ...props }: ComponentProps<typeof SelectContent>) {
  useInjectUiCss();
  return (
    <SelectContent data-slot="model-selector-content" className={cn("sui-model-sel-content", className)} {...props} />
  );
}

export function ModelSelectorGroup({ className, ...props }: ComponentProps<typeof SelectGroup>) {
  useInjectUiCss();
  return <SelectGroup data-slot="model-selector-group" className={cn("sui-model-sel-group", className)} {...props} />;
}

export type ModelSelectorItemProps = ComponentProps<typeof SelectItem> & { option: ModelOption };

export function ModelSelectorItem({ option, className, children, value, disabled, ...props }: ModelSelectorItemProps) {
  useInjectUiCss();
  return (
    <SelectItem
      data-slot="model-selector-item"
      value={value ?? option.id}
      disabled={disabled ?? option.disabled}
      className={cn("sui-model-sel-item", className)}
      {...props}
    >
      {children ?? (
        <span className="sui-model-sel-item-body">
          <span className="sui-model-sel-item-row">
            {option.provider ? <ProviderBadge provider={option.provider} /> : null}
            <span className="sui-model-sel-item-name">{option.name}</span>
          </span>
          {option.description ? <span className="sui-model-sel-item-description">{option.description}</span> : null}
        </span>
      )}
    </SelectItem>
  );
}
