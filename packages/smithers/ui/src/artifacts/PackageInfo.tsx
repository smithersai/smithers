/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";
import { safeHref } from "../internal/safeHref";
import { Snippet } from "./Snippet";

export type PackageInfoProps = Omit<ComponentProps<"div">, "children"> & {
  name: string;
  version?: string;
  description?: string;
  registryUrl?: string;
  installCommand?: string;
  onCopyCode?: (code: string) => void;
};

/** Package identity card: name (optionally registry-linked), version, install snippet. */
export function PackageInfo({
  name,
  version,
  description,
  registryUrl,
  installCommand,
  onCopyCode,
  className,
  ...props
}: PackageInfoProps) {
  useInjectUiCss();
  const href = registryUrl === undefined ? undefined : safeHref(registryUrl);
  return (
    <div data-slot="package-info" className={cn("sui-pkginfo", className)} {...props}>
      <div className="sui-pkginfo-header">
        {href !== undefined ? (
          <a className="sui-pkginfo-name" href={href} target="_blank" rel="noreferrer">
            {name}
          </a>
        ) : (
          <span className="sui-pkginfo-name">{name}</span>
        )}
        {version !== undefined ? <span className="sui-pkginfo-version">{version}</span> : null}
      </div>
      {description !== undefined ? <p className="sui-pkginfo-description">{description}</p> : null}
      {installCommand !== undefined ? (
        <Snippet code={installCommand} language="sh" onCopyCode={onCopyCode} />
      ) : null}
    </div>
  );
}
