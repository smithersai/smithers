import { highlightCode } from "@smthrs/ui";

/** A read-only Crepe fence uses the same tokens as repository homes and lightweight Markdown. */
export function markdownCode(language: string, source: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "sui-markdown-code";
  pre.tabIndex = 0;
  pre.setAttribute("role", "region");
  pre.setAttribute("aria-label", language ? `${language} code` : "Code");
  const code = document.createElement("code");
  const lines = highlightCode(source, language.toLowerCase());
  lines.forEach((line, index) => {
    if (index > 0) code.append("\n");
    for (const token of line) {
      const span = document.createElement("span");
      if (token.kind) span.className = `sui-rh-tok-${token.kind}`;
      span.textContent = token.text;
      code.append(span);
    }
  });
  pre.append(code);
  return pre;
}
