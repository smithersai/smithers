import type { MDXContent } from "mdx/types";
/**
 * Render an MDX component to plain markdown text.
 *
 * Injects `markdownComponents` so headings, paragraphs, code blocks, etc.
 * render as markdown-formatted text instead of HTML tags.
 */
export declare function renderMdx(Component: MDXContent, props?: Record<string, any>): string;
