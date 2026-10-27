/** @jsxImportSource react */
import type { ReactNode } from "react";
import { EmptyState } from "./empty-state";

export interface NotFoundProps {
  /** The absent resource, when known. */
  title?: string;
  /** A real link back to an existing page. */
  back: ReactNode;
}

/** One recovery view for absent routes and resources. */
export function NotFound({ title = "Not found", back }: NotFoundProps) {
  return <EmptyState title={title} action={back} />;
}
