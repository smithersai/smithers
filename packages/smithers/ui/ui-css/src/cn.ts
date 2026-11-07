import { clsx, type ClassValue } from "clsx";

/**
 * Compose class names, shadcn-style. Just `clsx` here: this library styles via
 * namespaced `sui-*` classes rather than utility classes, so there are no
 * Tailwind conflicts for `tailwind-merge` to resolve.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
