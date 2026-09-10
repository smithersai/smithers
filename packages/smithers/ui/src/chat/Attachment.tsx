/** @jsxImportSource react */
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { cn } from "../cn";
import { byteCountString } from "../diff-paginate";
import { useInjectUiCss } from "../styles";

export type AttachmentState = "uploading" | "processing" | "ready" | "error";

export type AttachmentProps = Omit<ComponentProps<"div">, "children"> & {
  name: string;
  state?: AttachmentState;
  sizeBytes?: number;
  mediaType?: string;
  thumbnailUrl?: string;
  progress?: number | null;
  onRemove?: () => void;
  /** Compound card mode: when given, children render verbatim inside the card. */
  children?: ReactNode;
};

type AttachmentContextValue = {
  name: string;
  state: AttachmentState;
  sizeBytes?: number;
  mediaType?: string;
  thumbnailUrl?: string;
  onRemove?: () => void;
};

const AttachmentContext = createContext<AttachmentContextValue | null>(null);
const AttachmentGroupContext = createContext(false);

function useAttachmentContext(component: string): AttachmentContextValue {
  const context = useContext(AttachmentContext);
  if (!context) throw new Error(`${component} must be used within an Attachment`);
  return context;
}

const stateLabels: Record<Exclude<AttachmentState, "ready">, string> = {
  uploading: "Uploading…",
  processing: "Processing…",
  error: "Failed",
};

function extensionLabel(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "FILE";
  return (
    name
      .slice(dot + 1)
      .toUpperCase()
      .slice(0, 4) || "FILE"
  );
}

function attachmentMeta(context: AttachmentContextValue): string {
  if (context.state !== "ready") return stateLabels[context.state];
  return [typeof context.sizeBytes === "number" ? byteCountString(context.sizeBytes) : undefined, context.mediaType]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

function useInjectAttachmentCss(): void {
  useInjectUiCss();
}

/** File or image attachment chip with upload and processing state. */
export function Attachment({
  name,
  state = "ready",
  sizeBytes,
  mediaType,
  thumbnailUrl,
  progress,
  onRemove,
  className,
  children,
  ...props
}: AttachmentProps) {
  useInjectAttachmentCss();
  const inGroup = useContext(AttachmentGroupContext);
  const groupProps = inGroup ? { role: "listitem" } : {};
  const contextValue: AttachmentContextValue = { name, state, sizeBytes, mediaType, thumbnailUrl, onRemove };

  if (children !== undefined) {
    return (
      <AttachmentContext.Provider value={contextValue}>
        <div
          data-slot="attachment"
          data-state={state}
          className={cn("sui-attachment", className)}
          {...groupProps}
          {...props}
        >
          {children}
        </div>
      </AttachmentContext.Provider>
    );
  }

  const progressLabel = `${state === "processing" ? "Processing" : state === "error" ? "Failed" : state === "ready" ? "Ready" : "Uploading"} ${name}`;
  const numericProgress = typeof progress === "number" ? Math.max(0, Math.min(100, progress)) : undefined;
  const readyMeta = [typeof sizeBytes === "number" ? byteCountString(sizeBytes) : undefined, mediaType].filter(
    (value): value is string => Boolean(value),
  );
  const meta = state === "ready" ? readyMeta.join(" · ") : stateLabels[state];

  return (
    <div
      data-slot="attachment"
      data-state={state}
      className={cn("sui-attachment", className)}
      {...groupProps}
      {...props}
    >
      <div data-slot="attachment-thumb" className="sui-attachment-thumb">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" />
        ) : (
          <span className="sui-attachment-ext" aria-hidden="true">
            {extensionLabel(name)}
          </span>
        )}
      </div>
      <div className="sui-attachment-details">
        <div data-slot="attachment-name" className="sui-attachment-name" title={name}>
          {name}
        </div>
        {meta ? (
          <div data-slot="attachment-meta" className="sui-attachment-meta">
            {meta}
          </div>
        ) : null}
        {progress !== undefined ? (
          <div
            data-slot="attachment-progress"
            className="sui-attachment-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={numericProgress}
            aria-label={progressLabel}
          >
            <span
              className={cn(
                "sui-attachment-progress-bar",
                progress === null && "sui-attachment-progress-indeterminate",
              )}
              style={numericProgress === undefined ? undefined : { width: `${numericProgress}%` }}
            />
          </div>
        ) : null}
      </div>
      {onRemove ? (
        <button
          type="button"
          data-slot="attachment-remove"
          className="sui-attachment-remove"
          aria-label={`Remove ${name}`}
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}

/** Thumbnail/media area of a compound Attachment card. */
export function AttachmentMedia({ className, children, ...props }: ComponentProps<"div">) {
  useInjectAttachmentCss();
  const context = useAttachmentContext("AttachmentMedia");
  return (
    <div data-slot="attachment-media" className={cn("sui-attachment-media", className)} {...props}>
      {children ??
        (context.thumbnailUrl ? (
          <img src={context.thumbnailUrl} alt="" />
        ) : (
          <span className="sui-attachment-ext" aria-hidden="true">
            {extensionLabel(context.name)}
          </span>
        ))}
    </div>
  );
}

/** Text column of a compound Attachment card. */
export function AttachmentContent({ className, ...props }: ComponentProps<"div">) {
  useInjectAttachmentCss();
  return <div data-slot="attachment-content" className={cn("sui-attachment-content", className)} {...props} />;
}

/** Attachment name; defaults to the context name. */
export function AttachmentTitle({ className, children, ...props }: ComponentProps<"div">) {
  useInjectAttachmentCss();
  const context = useAttachmentContext("AttachmentTitle");
  return (
    <div data-slot="attachment-title" className={cn("sui-attachment-title", className)} {...props}>
      {children ?? context.name}
    </div>
  );
}

/** Secondary line; defaults to the state/size metadata of the context. */
export function AttachmentDescription({ className, children, ...props }: ComponentProps<"div">) {
  useInjectAttachmentCss();
  const context = useAttachmentContext("AttachmentDescription");
  return (
    <div data-slot="attachment-description" className={cn("sui-attachment-description", className)} {...props}>
      {children ?? attachmentMeta(context)}
    </div>
  );
}

/** Toolbar row of attachment actions. */
export function AttachmentActions({ className, "aria-label": ariaLabel, ...props }: ComponentProps<"div">) {
  useInjectAttachmentCss();
  return (
    <div
      data-slot="attachment-actions"
      role="toolbar"
      aria-label={ariaLabel ?? "Attachment actions"}
      className={cn("sui-attachment-actions", className)}
      {...props}
    />
  );
}

export type AttachmentActionProps = Omit<ComponentProps<"button">, "children"> & {
  label: string;
  tooltip?: string;
  icon?: ReactNode;
};

/** Icon button inside AttachmentActions; the sr label is required. */
export function AttachmentAction({
  label,
  tooltip,
  icon,
  className,
  type = "button",
  ...props
}: AttachmentActionProps) {
  useInjectAttachmentCss();
  return (
    <button
      type={type}
      data-slot="attachment-action"
      className={cn("sui-attachment-action", className)}
      aria-label={label}
      title={tooltip}
      {...props}
    >
      {icon}
      <span className="sui-sr-only">{label}</span>
    </button>
  );
}

/** Full-card button wrapper making the whole attachment clickable. */
export function AttachmentTrigger({ className, type = "button", ...props }: ComponentProps<"button">) {
  useInjectAttachmentCss();
  return (
    <button type={type} data-slot="attachment-trigger" className={cn("sui-attachment-trigger", className)} {...props} />
  );
}

export type AttachmentPreviewProps = Omit<ComponentProps<"div">, "children"> & {
  src?: string;
  alt?: string;
  mediaType?: string;
};

/**
 * Image preview or extension tile. Never fabricates a preview: without a src
 * it renders the extension tile instead of guessing at the file's content.
 */
export function AttachmentPreview({ src, alt, mediaType, className, ...props }: AttachmentPreviewProps) {
  useInjectAttachmentCss();
  const context = useAttachmentContext("AttachmentPreview");
  const showImage = src && (!mediaType || mediaType.startsWith("image/"));
  return (
    <div data-slot="attachment-preview" className={cn("sui-attachment-preview", className)} {...props}>
      {showImage ? (
        <img src={src} alt={alt ?? ""} />
      ) : (
        <span className="sui-attachment-preview-tile" aria-hidden="true">
          {extensionLabel(context.name)}
        </span>
      )}
    </div>
  );
}

/** Remove button; its aria-label comes from the attachment name in context. */
export function AttachmentRemove({ className, onClick, ...props }: ComponentProps<"button">) {
  useInjectAttachmentCss();
  const context = useAttachmentContext("AttachmentRemove");
  return (
    <button
      type="button"
      data-slot="attachment-remove"
      className={cn("sui-attachment-remove", className)}
      aria-label={`Remove ${context.name}`}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context.onRemove?.();
      }}
      {...props}
    >
      <span aria-hidden="true">×</span>
    </button>
  );
}

/** List of attachments; child Attachments render as listitems. */
export function AttachmentGroup({ className, children, ...props }: ComponentProps<"div">) {
  useInjectAttachmentCss();
  return (
    <AttachmentGroupContext.Provider value={true}>
      <div data-slot="attachment-group" role="list" className={cn("sui-attachment-group", className)} {...props}>
        {children}
      </div>
    </AttachmentGroupContext.Provider>
  );
}
