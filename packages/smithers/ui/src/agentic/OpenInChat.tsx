/** @jsxImportSource react */
import type { ComponentProps } from "react";
import { cn } from "../cn";
import { useInjectUiCss } from "../styles";

export type OpenInChatSubjectKind = "file" | "diff" | "issue" | "test" | "run" | "log" | "error" | "artifact";

export type OpenInChatSubject = {
  kind: OpenInChatSubjectKind;
  label: string;
  ref?: string;
  excerpt?: string;
};

export type OpenInChatProps = Omit<ComponentProps<"button">, "onClick" | "children"> & {
  subject: OpenInChatSubject;
  onOpen: (subject: OpenInChatSubject) => void;
  label?: string;
};

function KindIcon({ kind }: { kind: OpenInChatSubjectKind }) {
  const common = {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true as const,
  } as const;
  switch (kind) {
    case "file":
      return (
        <svg {...common}>
          <path d="M4 1.5h5l3 3v10H4z" />
          <path d="M9 1.5v3h3" />
        </svg>
      );
    case "diff":
      return (
        <svg {...common}>
          <path d="M3.5 5.5h4M5.5 3.5v4" />
          <path d="M8.5 11h4" />
        </svg>
      );
    case "issue":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "test":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M5.5 8l1.8 1.8 3.2-3.6" />
        </svg>
      );
    case "run":
      return (
        <svg {...common}>
          <path d="M5.5 4l6 4-6 4z" />
        </svg>
      );
    case "log":
      return (
        <svg {...common}>
          <path d="M4 4.5h8M4 8h8M4 11.5h5" />
        </svg>
      );
    case "error":
      return (
        <svg {...common}>
          <path d="M8 2.5l6 11H2z" />
          <path d="M8 6.5v3" />
          <circle cx="8" cy="11.4" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "artifact":
      return (
        <svg {...common}>
          <path d="M3 5.5l5-2.7 5 2.7v5L8 13.2l-5-2.7z" />
          <path d="M3 5.5l5 2.7 5-2.7M8 8.2v5" />
        </svg>
      );
  }
}

/**
 * 'Ask Smithers about this' affordance. Strictly props-driven: the subject
 * descriptor goes in, the onOpen callback comes out; the host owns routing
 * and transport.
 */
export function OpenInChat({ subject, onOpen, label = "Ask Smithers", className, type, ...props }: OpenInChatProps) {
  useInjectUiCss();
  return (
    <button
      type={type ?? "button"}
      data-slot="open-in-chat"
      data-kind={subject.kind}
      className={cn("sui-open-in-chat", className)}
      aria-label={`${label}: ${subject.label}`}
      onClick={() => onOpen(subject)}
      {...props}
    >
      <span className="sui-open-in-chat-icon" aria-hidden="true">
        <KindIcon kind={subject.kind} />
      </span>
      {label}
    </button>
  );
}
