import React from "react";

/**
 * React Fragment wrapper — returns a Fragment element containing the given parts.
 * When passed to renderToStaticMarkup, fragments render as bare text with no HTML tags.
 */
function fragment(...parts: any[]) {
  return React.createElement(React.Fragment, null, ...parts);
}

/**
 * MDX component overrides that render markdown-formatted text via React Fragments.
 *
 * When used with renderToStaticMarkup, these components produce clean markdown output
 * instead of HTML — no regex stripping needed.
 *
 * Usage: pass as the `components` prop to an MDX component, or wrap with MDXProvider.
 *
 * @example
 * ```ts
 * import { markdownComponents } from "smithers";
 * const md = renderToStaticMarkup(<MyMdxDoc components={markdownComponents} />);
 * // md is clean markdown, not HTML
 * ```
 */
export const markdownComponents: Record<string, React.FC<any>> = {
  // Headings
  h1: ({ children }: any) => fragment("# ", children, "\n\n"),
  h2: ({ children }: any) => fragment("## ", children, "\n\n"),
  h3: ({ children }: any) => fragment("### ", children, "\n\n"),
  h4: ({ children }: any) => fragment("#### ", children, "\n\n"),
  h5: ({ children }: any) => fragment("##### ", children, "\n\n"),
  h6: ({ children }: any) => fragment("###### ", children, "\n\n"),

  // Block elements
  p: ({ children }: any) => fragment(children, "\n\n"),
  blockquote: ({ children }: any) => fragment("> ", children, "\n"),
  hr: () => fragment("---\n\n"),

  // Lists
  ul: ({ children }: any) => fragment(children, "\n"),
  ol: ({ children }: any) => fragment(children, "\n"),
  li: ({ children }: any) => fragment("- ", children, "\n"),

  // Code
  code: ({ children, className }: any) => {
    if (className) {
      const lang = className.replace("language-", "");
      return fragment("```", lang, "\n", children, "\n```\n\n");
    }
    return fragment("`", children, "`");
  },
  pre: ({ children }: any) => fragment(children),

  // Inline formatting
  strong: ({ children }: any) => fragment("**", children, "**"),
  em: ({ children }: any) => fragment("*", children, "*"),
  a: ({ href, children }: any) => fragment("[", children, "](", href, ")"),

  // Line break
  br: () => fragment("\n"),

  // Images
  img: ({ alt, src }: any) => fragment("![", alt ?? "", "](", src, ")"),

  // Tables
  table: ({ children }: any) => fragment(children, "\n"),
  thead: ({ children }: any) => fragment(children),
  tbody: ({ children }: any) => fragment(children),
  tr: ({ children }: any) => fragment("| ", children, "\n"),
  th: ({ children }: any) => fragment(children, " | "),
  td: ({ children }: any) => fragment(children, " | "),

  // Pass-through containers (no HTML wrapper, just content)
  div: ({ children }: any) => fragment(children, "\n"),
  section: ({ children }: any) => fragment(children, "\n"),
  span: ({ children }: any) => fragment(children),
};
