/** @jsxImportSource react */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@smthrs/ui-css";
import { useInjectUiCss } from "../styles";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";
import { isPlainNavigationClick } from "../internal/navigationClick";
import { safeHref } from "../internal/safeHref";
import { safeImageSrc } from "../internal/safeImageSrc";

export type CitationSource = {
  id: string;
  title: string;
  url?: string;
  domain?: string;
  excerpt?: string;
  faviconUrl?: string;
  quote?: string;
};

export type InlineCitationProps = Omit<ComponentProps<"a">, "href" | "children" | "onClick"> & {
  index: number;
  label: string;
  href?: string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => void;
  sources?: readonly CitationSource[];
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  openOnHover?: boolean;
};

const HOVER_OPEN_DELAY_MS = 300;
const HOVER_CLOSE_DELAY_MS = 300;

/** Focusable superscript citation with a source-label tooltip or a rich source preview. */
export function InlineCitation({
  index,
  label,
  href: rawHref,
  onNavigate,
  sources,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  openOnHover = true,
  className,
  ...props
}: InlineCitationProps) {
  useInjectUiCss();
  const href = rawHref === undefined ? undefined : safeHref(rawHref);
  const accessibleName = `Source ${index}: ${label}`;

  const contentId = useId();
  const citationRef = useRef<HTMLElement | null>(null);
  const pinned = useRef(defaultOpen);
  const pressedInside = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const openTimer = useRef<number | undefined>(undefined);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  useEffect(() => {
    const release = () => { pressedInside.current = false; };
    document.addEventListener("pointerup", release, true);
    document.addEventListener("pointercancel", release, true);
    return () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
      document.removeEventListener("pointerup", release, true);
      document.removeEventListener("pointercancel", release, true);
    };
  }, []);
  useEffect(() => {
    if (!open || sources === undefined) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !citationRef.current?.contains(event.target)) closePreview();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (!event.defaultPrevented) handleEscape(event);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  });

  function setOpen(next: boolean) {
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }

  function scheduleOpen() {
    window.clearTimeout(closeTimer.current);
    if (!openOnHover || isControlled || open) return;
    window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  }

  function cancelScheduledOpen() {
    window.clearTimeout(openTimer.current);
    openTimer.current = undefined;
  }

  function closePreview() {
    window.clearTimeout(closeTimer.current);
    cancelScheduledOpen();
    if (!isControlled && !pinned.current && open) setOpen(false);
  }

  function scheduleClose() {
    if (citationRef.current?.contains(document.activeElement)) return;
    cancelScheduledOpen();
    if (isControlled || pinned.current || !open) return;
    window.clearTimeout(closeTimer.current);
    // Inline previews have a line-box gap; allow the pointer to cross it.
    closeTimer.current = window.setTimeout(closePreview, HOVER_CLOSE_DELAY_MS);
  }

  function handleEscape(event: KeyboardEvent | globalThis.KeyboardEvent) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    event.stopPropagation();
    window.clearTimeout(closeTimer.current);
    cancelScheduledOpen();
    pinned.current = false;
    setOpen(false);
    if (citationRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
  }

  if (sources !== undefined) {
    return (
      <sup
        ref={citationRef}
        data-slot="inline-citation"
        className={cn("sui-citation", className)}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={scheduleOpen}
        onPointerDownCapture={() => { pressedInside.current = true; }}
        onBlur={(event) => {
          // Selecting preview text can blur its trigger to body before click.
          if (pressedInside.current && event.relatedTarget === null) return;
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) closePreview();
        }}
      >
        <button
          {...(props as ComponentProps<"button">)}
          ref={triggerRef}
          type="button"
          data-slot="inline-citation-trigger"
          aria-label={accessibleName}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => {
            cancelScheduledOpen();
            pinned.current = !open;
            setOpen(!open);
          }}
          onKeyDown={handleEscape}
        >
          [{index}]
        </button>
        {open ? (
          <span
            data-slot="inline-citation-content"
            id={contentId}
            role="region"
            aria-label={`Sources for citation ${index}`}
            className="sui-citation-content"
            onKeyDown={handleEscape}
          >
            {sources.length === 1 ? <CitationCard source={sources[0]!} onNavigate={onNavigate} /> : <CitationCarousel sources={sources} onNavigate={onNavigate} />}
          </span>
        ) : null}
      </sup>
    );
  }

  return (
    <sup data-slot="inline-citation" className={cn("sui-citation", className)}>
      <TooltipProvider delayDuration={250}>
        <Tooltip>
          <TooltipTrigger asChild>
            {href !== undefined ? (
              <a
                {...props}
                href={href}
                aria-label={accessibleName}
                onClick={
                  onNavigate
                    ? (event) => {
                        if (!isPlainNavigationClick(event)) return;
                        event.preventDefault();
                        onNavigate(href, event);
                      }
                    : undefined
                }
              >
                [{index}]
              </a>
            ) : (
              <button {...(props as ComponentProps<"button">)} type="button" aria-label={accessibleName}>
                [{index}]
              </button>
            )}
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </sup>
  );
}

function CitationFavicon({ source }: { source: CitationSource }) {
  const faviconSrc = source.faviconUrl === undefined ? undefined : safeImageSrc(source.faviconUrl);
  if (faviconSrc !== undefined) {
    return <img className="sui-citation-favicon" src={faviconSrc} alt="" width={16} height={16} />;
  }
  const initial =
    (source.domain ?? "").trim().charAt(0).toUpperCase() || source.title.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="sui-citation-favicon-fallback" aria-hidden="true">
      {initial}
    </span>
  );
}

export type CitationCardProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  source: CitationSource;
  onNavigate?: InlineCitationProps["onNavigate"];
  children?: ReactNode;
};

/** Single-source preview card: favicon, title link, domain, excerpt, optional quote. */
export function CitationCard({ source, children, className, onNavigate, ...props }: CitationCardProps) {
  useInjectUiCss();
  const href = source.url === undefined ? undefined : safeHref(source.url);

  return (
    <div data-slot="citation-card" className={cn("sui-citation-card", className)} {...props}>
      <div className="sui-citation-card-header">
        <CitationFavicon source={source} />
        <span className="sui-citation-card-title">
          {href !== undefined ? (
            <a
              className="sui-citation-card-link"
              href={href}
              onClick={onNavigate === undefined ? undefined : (event) => {
                if (!isPlainNavigationClick(event)) return;
                event.preventDefault();
                onNavigate(href, event);
              }}
            >
              {source.title}
            </a>
          ) : (
            source.title
          )}
        </span>
        {source.domain !== undefined ? <span className="sui-citation-card-domain">{source.domain}</span> : null}
      </div>
      {source.excerpt !== undefined ? <div className="sui-citation-card-excerpt">{source.excerpt}</div> : null}
      {source.quote !== undefined ? <CitationQuote quote={source.quote} /> : null}
      {children}
    </div>
  );
}

export type CitationCarouselProps = Omit<ComponentProps<"div">, "children"> & {
  sources: readonly CitationSource[];
  onNavigate?: InlineCitationProps["onNavigate"];
  index?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
};

/** Keyboard-accessible multi-source preview for one claim (Left/Right arrows, prev/next). */
export function CitationCarousel({
  sources,
  index: controlledIndex,
  defaultIndex = 0,
  onIndexChange,
  onNavigate,
  className,
  onKeyDown,
  ...props
}: CitationCarouselProps) {
  useInjectUiCss();
  const [uncontrolledIndex, setUncontrolledIndex] = useState(defaultIndex);
  const isControlled = controlledIndex !== undefined;
  const max = Math.max(sources.length - 1, 0);
  const index = Math.min(Math.max(isControlled ? controlledIndex : uncontrolledIndex, 0), max);

  if (sources.length === 0) return null;

  function go(next: number) {
    const clamped = Math.min(Math.max(next, 0), max);
    if (!isControlled) setUncontrolledIndex(clamped);
    onIndexChange?.(clamped);
  }

  return (
    <div
      data-slot="citation-carousel"
      className={cn("sui-citation-carousel", className)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          go(index - 1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          go(index + 1);
        }
        onKeyDown?.(event);
      }}
      {...props}
    >
      <div className="sui-citation-carousel-nav">
        <button
          type="button"
          data-slot="citation-carousel-previous"
          className="sui-citation-carousel-button"
          aria-label="Previous source"
          disabled={index <= 0}
          onClick={() => go(index - 1)}
        >
          ‹
        </button>
        <span data-slot="citation-carousel-index" className="sui-citation-carousel-index" aria-live="polite">
          {index + 1} of {sources.length}
        </span>
        <button
          type="button"
          data-slot="citation-carousel-next"
          className="sui-citation-carousel-button"
          aria-label="Next source"
          disabled={index >= max}
          onClick={() => go(index + 1)}
        >
          ›
        </button>
      </div>
      <CitationCard source={sources[index]!} onNavigate={onNavigate} />
    </div>
  );
}

export type CitationQuoteProps = Omit<ComponentProps<"blockquote">, "children"> & {
  quote: string;
  children?: ReactNode;
};

/** Verbatim quoted passage from a cited source. */
export function CitationQuote({ quote, children, className, ...props }: CitationQuoteProps) {
  useInjectUiCss();
  return (
    <blockquote data-slot="citation-quote" className={cn("sui-citation-quote", className)} {...props}>
      <p>{quote}</p>
      {children}
    </blockquote>
  );
}
