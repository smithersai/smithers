/** @jsxImportSource react */
import { Badge } from "../badge";
import { Button } from "../button";
import { cn } from "@smthrs/ui-css";
import { safeHref } from "../internal/safeHref";
import { useInjectUiCss } from "../styles";

export type ForkBadgeProps = {
  readonly forkOrg: string;
  readonly upstreamRepo: string;
  readonly upstreamHref?: string;
  readonly className?: string;
};

function safeWebUrl(raw: string | undefined): { readonly href: string; readonly display: string } | undefined {
  if (!raw) return undefined;
  const checked = safeHref(raw);
  if (!checked) return undefined;
  try {
    const parsed = new URL(checked);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    return { href: parsed.href, display: `${parsed.host}${cleanPath}` };
  } catch {
    return undefined;
  }
}

/**
 * Host-drawn badge clearly marking example forks under smithersai/ as non-official upstream forks.
 */
export function ForkBadge({ forkOrg, upstreamRepo, upstreamHref, className }: ForkBadgeProps) {
  useInjectUiCss();
  const safeUpstream = safeWebUrl(upstreamHref);

  return (
    <span
      data-slot="fork-badge"
      className={cn("sui-fork-badge", className)}
      style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
    >
      <Badge variant="warning">{forkOrg}/ example fork</Badge>
      {safeUpstream ? (
        <a
          href={safeUpstream.href}
          target="_blank"
          rel="noreferrer noopener"
          title={safeUpstream.href}
          style={{ fontSize: "12px", color: "inherit", opacity: 0.78 }}
        >
          Upstream: {safeUpstream.display}
        </a>
      ) : (
        <span style={{ fontSize: "12px", opacity: 0.78 }}>Upstream: {upstreamRepo}</span>
      )}
    </span>
  );
}

export type AudienceRole = "maintainer" | "contributor" | "visitor";

const ROLE_ORDER: ReadonlyArray<AudienceRole> = ["maintainer", "contributor", "visitor"];

const ROLE_LABEL: Record<AudienceRole, string> = {
  maintainer: "Maintainer",
  contributor: "Contributor",
  visitor: "Visitor",
};

export type AudienceSwitchProps = {
  readonly maxRole: AudienceRole;
  readonly activeRole: AudienceRole;
  readonly onChange: (role: AudienceRole) => void;
  readonly className?: string;
};

/**
 * Downward-only audience view switcher. Only renders roles at or below maxRole.
 * Display lens only, server authorization remains unchanged.
 */
export function AudienceSwitch({ maxRole, activeRole, onChange, className }: AudienceSwitchProps) {
  useInjectUiCss();
  const minIndex = ROLE_ORDER.indexOf(maxRole);
  const allowed = ROLE_ORDER.slice(minIndex);

  return (
    <div
      data-slot="audience-switch"
      role="group"
      aria-label="Audience view"
      className={cn(className)}
      style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
    >
      {allowed.map((role) => (
        <Button
          key={role}
          type="button"
          size="sm"
          variant={role === activeRole ? "default" : "ghost"}
          aria-pressed={role === activeRole}
          onClick={() => onChange(role)}
        >
          {ROLE_LABEL[role]}
        </Button>
      ))}
    </div>
  );
}
