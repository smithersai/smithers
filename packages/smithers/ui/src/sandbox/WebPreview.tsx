/** @jsxImportSource react */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "../cn";
import { EmptyState } from "../empty-state";
import { Input } from "../input";
import { composeRefs } from "../internal/composeRefs";
import { Skeleton } from "../skeleton";
import { useInjectUiCss } from "../styles";

export type WebPreviewSandboxToken =
  | "allow-scripts"
  | "allow-forms"
  | "allow-popups"
  | "allow-downloads"
  | "allow-same-origin";

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const CONTROL_CHARS = /[\t\r\n]/g;

/**
 * Root-relative means "exactly one leading `/` followed by a path
 * character" — not a second `/` or `\`. Browsers collapse backslashes to
 * forward slashes when parsing special-scheme (http/https) URLs, so a value
 * like "/\evil.com" or "/\\evil.com" is a network-path reference that
 * resolves to `//evil.com` — a DIFFERENT origin — not a same-origin path.
 */
function isRootRelativeSameOriginPath(trimmed: string): boolean {
  if (trimmed[0] !== "/") return false;
  const second = trimmed[1];
  return second !== "/" && second !== "\\";
}

/**
 * A preview src may only be an absolute http(s) URL or a root-relative
 * same-origin path. Anything else (javascript:, data:, blob:, file:,
 * protocol-relative, backslash network-path tricks, blank) is refused so the
 * sandbox boundary cannot be bypassed through the frame source. Returns the
 * SANITIZED src so the exact string that was validated is the string that
 * gets rendered — never the raw caller input.
 */
function sanitizePreviewSrc(src: string | undefined): string | null {
  if (src === undefined) return null;
  // Browsers strip ASCII tab/CR/LF from a URL before parsing it, so
  // "/\t/evil.com" reaches the parser as "//evil.com" even though its literal
  // second character isn't a separator. Strip the same way before
  // classifying so that trick can't slip past the check below.
  const trimmed = src.replace(CONTROL_CHARS, "").trim();
  if (trimmed === "") return null;
  if (isRootRelativeSameOriginPath(trimmed)) return trimmed;
  return isHttpUrl(trimmed) ? trimmed : null;
}

const KNOWN_SANDBOX_TOKENS: ReadonlySet<string> = new Set<WebPreviewSandboxToken>([
  "allow-scripts",
  "allow-forms",
  "allow-popups",
  "allow-downloads",
  "allow-same-origin",
]);

/**
 * Sandbox tokens are only meaningful to browsers as case-insensitive,
 * whitespace-trimmed keywords, so comparing raw array entries with `===`
 * can miss a forbidden token in disguise: wrong case ("ALLOW-SAME-ORIGIN"),
 * stray whitespace (" allow-same-origin"), or a duplicate. Normalize each
 * entry by trimming and lowercasing, then accept it only when the WHOLE
 * entry is an exact known keyword. Anything else — an unknown token or a
 * malformed entry with several tokens packed behind an escaped separator
 * such as a tab or semicolon ("allow-same-origin;drop-table") — is rejected
 * wholesale: a malformed entry must never be salvaged into an active iframe
 * capability, and unknown tokens fail closed.
 */
function normalizeSandboxTokens(tokens: readonly string[]): WebPreviewSandboxToken[] {
  const seen = new Set<WebPreviewSandboxToken>();
  const ordered: WebPreviewSandboxToken[] = [];
  for (const raw of tokens) {
    if (typeof raw !== "string") continue;
    const candidate = raw.trim().toLowerCase();
    if (!KNOWN_SANDBOX_TOKENS.has(candidate as WebPreviewSandboxToken)) {
      if (candidate !== "") {
        console.warn(
          `WebPreviewContent: rejecting malformed sandbox token entry ${JSON.stringify(raw)}; only exact known tokens are granted.`,
        );
      }
      continue;
    }
    const token = candidate as WebPreviewSandboxToken;
    if (seen.has(token)) continue;
    seen.add(token);
    ordered.push(token);
  }
  return ordered;
}

/** The hard rule: allow-same-origin + allow-scripts never render together. */
function resolveSandboxTokens(tokens: readonly WebPreviewSandboxToken[]): readonly WebPreviewSandboxToken[] {
  const normalized = normalizeSandboxTokens(tokens);
  if (normalized.includes("allow-same-origin") && normalized.includes("allow-scripts")) {
    console.warn(
      "WebPreviewContent: dropping the allow-same-origin sandbox token because it is combined with allow-scripts; the pair would let the framed page remove its own sandbox.",
    );
    return normalized.filter((token) => token !== "allow-same-origin");
  }
  return normalized;
}

type WebPreviewContextValue = {
  url: string | undefined;
  commitUrl: (url: string) => boolean;
  loading: boolean;
};

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null);

/**
 * Roving tabindex applies ONLY to the toolbar's own buttons. The address
 * input and any consumer-supplied children keep their natural tab order —
 * stomping their tabIndex would strand them from keyboard users.
 */
const ROVING_BUTTONS = ".sui-webpreview-toolbar-button";

function useRovingTabIndex(ref: RefObject<HTMLElement | null>) {
  // The current tab stop survives re-renders: without this ref the effect
  // (which runs every render) would reset the stop to the first button and
  // stomp keyboard position.
  const currentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(ROVING_BUTTONS));
    if (items.length === 0) return;
    let index = currentRef.current ? items.indexOf(currentRef.current) : -1;
    if (index === -1) index = 0;
    items.forEach((el, i) => {
      el.tabIndex = i === index ? 0 : -1;
    });
    currentRef.current = items[index]!;
  });

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
    ) {
      return;
    }
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(ROVING_BUTTONS));
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    event.preventDefault();
    const next =
      event.key === "ArrowRight" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items.forEach((el, index) => {
      el.tabIndex = index === next ? 0 : -1;
    });
    currentRef.current = items[next]!;
    items[next]!.focus();
  }

  return onKeyDown;
}

export type WebPreviewProps = Omit<ComponentProps<"div">, "children"> & {
  url?: string;
  defaultUrl?: string;
  onUrlChange?: (url: string) => void;
  loading?: boolean;
  children?: ReactNode;
};

/**
 * Sandboxed web preview frame with an honest navigation model: back/forward/
 * refresh are host callbacks, the address bar only commits http(s) URLs, and
 * the iframe sandbox attribute is always rendered from an explicit token list.
 */
export function WebPreview({
  url: controlledUrl,
  defaultUrl,
  onUrlChange,
  loading = false,
  className,
  children,
  ...props
}: WebPreviewProps) {
  useInjectUiCss();
  const [uncontrolledUrl, setUncontrolledUrl] = useState(defaultUrl);
  const isControlled = controlledUrl !== undefined;
  const url = isControlled ? controlledUrl : uncontrolledUrl;

  // Preview lifecycle (navigation + loading transitions) is announced through
  // a persistent visually-hidden live region so screen-reader users hear what
  // sighted users see in the frame. Mounting is not announced.
  const [announcement, setAnnouncement] = useState("");
  const previousLifecycle = useRef<{ url: string | undefined; loading: boolean }>({ url, loading });
  useEffect(() => {
    const previous = previousLifecycle.current;
    if (previous.url === url && previous.loading === loading) return;
    previousLifecycle.current = { url, loading };
    if (loading) {
      setAnnouncement("Loading preview");
    } else if (previous.loading) {
      setAnnouncement("Preview loaded");
    } else if (url !== undefined && url !== "") {
      setAnnouncement(`Preview address ${url}`);
    } else {
      setAnnouncement("Preview cleared");
    }
  }, [url, loading]);

  function commitUrl(next: string): boolean {
    if (!isHttpUrl(next)) return false;
    if (!isControlled) setUncontrolledUrl(next);
    onUrlChange?.(next);
    return true;
  }

  return (
    <div
      data-slot="web-preview"
      data-loading={loading ? "true" : "false"}
      className={cn("sui-webpreview", className)}
      {...props}
    >
      <span data-slot="web-preview-live" role="status" aria-live="polite" className="sui-sr-only">
        {announcement}
      </span>
      <WebPreviewContext.Provider value={{ url, commitUrl, loading }}>
        {children ?? (
          <>
            <WebPreviewToolbar>
              <WebPreviewAddress />
            </WebPreviewToolbar>
            <WebPreviewContent />
          </>
        )}
      </WebPreviewContext.Provider>
    </div>
  );
}

export type WebPreviewToolbarProps = Omit<ComponentProps<"div">, "children"> & {
  onBack?: () => void;
  onForward?: () => void;
  onRefresh?: () => void;
  children?: ReactNode;
};

export function WebPreviewToolbar({
  onBack,
  onForward,
  onRefresh,
  className,
  children,
  onKeyDown,
  ref: callerRef,
  ...props
}: WebPreviewToolbarProps) {
  useInjectUiCss();
  const ref = useRef<HTMLDivElement | null>(null);
  const rovingKeyDown = useRovingTabIndex(ref);
  return (
    <div
      ref={composeRefs(ref, callerRef)}
      data-slot="web-preview-toolbar"
      role="toolbar"
      aria-label="Preview controls"
      className={cn("sui-webpreview-toolbar", className)}
      onKeyDown={(event) => {
        rovingKeyDown(event);
        onKeyDown?.(event);
      }}
      {...props}
    >
      {onBack ? (
        <button
          type="button"
          data-slot="web-preview-back"
          className="sui-webpreview-toolbar-button"
          aria-label="Back"
          onClick={onBack}
        >
          <span aria-hidden="true">←</span>
        </button>
      ) : null}
      {onForward ? (
        <button
          type="button"
          data-slot="web-preview-forward"
          className="sui-webpreview-toolbar-button"
          aria-label="Forward"
          onClick={onForward}
        >
          <span aria-hidden="true">→</span>
        </button>
      ) : null}
      {onRefresh ? (
        <button
          type="button"
          data-slot="web-preview-refresh"
          className="sui-webpreview-toolbar-button"
          aria-label="Refresh"
          onClick={onRefresh}
        >
          <span aria-hidden="true">⟳</span>
        </button>
      ) : null}
      {children}
    </div>
  );
}

export type WebPreviewAddressProps = Omit<ComponentProps<"input">, "value" | "onChange" | "type">;

export function WebPreviewAddress({
  className,
  onKeyDown,
  "aria-label": ariaLabel = "Preview address",
  ...props
}: WebPreviewAddressProps) {
  useInjectUiCss();
  const ctx = useContext(WebPreviewContext);
  const errorId = useId();
  const [draft, setDraft] = useState(ctx?.url ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(ctx?.url ?? "");
    // A URL committed elsewhere (controlled `url` prop, another address bar)
    // makes any stale validation error on the old draft a lie — clear it.
    setError(null);
  }, [ctx?.url]);

  function commit() {
    if (ctx !== null) {
      setError(ctx.commitUrl(draft) ? null : "Enter a valid http:// or https:// URL.");
    } else {
      setError(isHttpUrl(draft) ? null : "Enter a valid http:// or https:// URL.");
    }
  }

  return (
    <span data-slot="web-preview-address" className="sui-webpreview-address-row">
      <Input
        type="url"
        value={draft}
        aria-label={ariaLabel}
        aria-invalid={error !== null ? true : undefined}
        aria-describedby={error !== null ? errorId : undefined}
        className={cn("sui-webpreview-address", className)}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          onKeyDown?.(event);
        }}
        {...props}
      />
      {error !== null ? (
        <span id={errorId} role="alert" data-slot="web-preview-address-error" className="sui-webpreview-address-error">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export type WebPreviewContentProps = Omit<ComponentProps<"iframe">, "src" | "sandbox"> & {
  src?: string;
  sandboxAllow?: readonly WebPreviewSandboxToken[];
};

export function WebPreviewContent({
  src,
  sandboxAllow = ["allow-scripts", "allow-forms"],
  title = "Web preview",
  className,
  ...props
}: WebPreviewContentProps) {
  useInjectUiCss();
  const ctx = useContext(WebPreviewContext);
  const safeSrc = sanitizePreviewSrc(src ?? ctx?.url);
  const loading = ctx?.loading ?? false;
  if (safeSrc === null) {
    return (
      <div data-slot="web-preview-content" className={cn("sui-webpreview-content", className)}>
        <EmptyState title="No preview available" />
      </div>
    );
  }
  const sandboxTokens = resolveSandboxTokens(sandboxAllow);
  return (
    <div
      data-slot="web-preview-content"
      data-loading={loading ? "true" : "false"}
      aria-busy={loading ? true : undefined}
      className="sui-webpreview-content"
    >
      {loading ? <Skeleton data-slot="web-preview-loading" className="sui-webpreview-loading" /> : null}
      <iframe
        {...props}
        // Security-critical attributes come AFTER the spread: the prop types
        // omit src/sandbox, but that is compile-time only — a runtime caller
        // passing them through must never override the hardened values.
        title={title}
        src={safeSrc}
        sandbox={sandboxTokens.join(" ")}
        className={cn("sui-webpreview-frame", className)}
      />
    </div>
  );
}
