/** @jsxImportSource react */
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { SecretField } from "./SecretField";

export type EnvironmentVariableModel = {
  name: string;
  value?: string;
  secret?: boolean;
};

export type EnvironmentVariablesProps = Omit<ComponentProps<"div">, "children"> & (
  | { variables: readonly EnvironmentVariableModel[]; children?: never }
  | { children: ReactNode; variables?: never }
);

/** Name/value rows for a process environment; secrets go through SecretField. */
export function EnvironmentVariables(props: EnvironmentVariablesProps) {
  useInjectUiCss();
  const p = props as { className?: string; variables?: readonly EnvironmentVariableModel[]; children?: ReactNode } & ComponentProps<"div">;
  const { className, variables, children, ...divProps } = p;
  return (
    <div data-slot="environment-variables" className={cn("sui-envvars", className)} {...divProps}>
      {variables
        ? variables.map((variable) => (
            <EnvironmentVariable
              key={variable.name}
              name={variable.name}
              value={variable.value}
              secret={variable.secret}
            />
          ))
        : children}
    </div>
  );
}

export type EnvironmentVariableProps = Omit<ComponentProps<"div">, "children"> & {
  name: string;
  value?: string;
  secret?: boolean;
};

export function EnvironmentVariable({ name, value, secret = false, className, ...props }: EnvironmentVariableProps) {
  useInjectUiCss();
  return (
    <div data-slot="environment-variable" data-secret={secret ? "true" : "false"} className={cn("sui-envvar", className)} {...props}>
      <span className="sui-envvar-name">{name}</span>
      {value === undefined ? (
        <span className="sui-envvar-value sui-envvar-unset">—</span>
      ) : secret ? (
        <SecretField value={value} label={name} />
      ) : (
        <span className="sui-envvar-value">{value}</span>
      )}
    </div>
  );
}
