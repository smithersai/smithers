import type { MarkdownNode } from "./markdownHtml";

/** GitHub alerts occur only in a top-level quote whose first line is a whole marker. */
export function markdownAlerts(tree: MarkdownNode): void {
  for (const quote of tree.children ?? []) {
    if (quote.type !== "blockquote") continue;
    const paragraph = quote.children?.[0];
    const first = paragraph?.children?.[0];
    if (paragraph?.type !== "paragraph" || first?.type !== "text") continue;
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|$)/.exec(first.value ?? "");
    if (!match) continue;
    const kind = match[1]!.toLowerCase();
    first.value = first.value!.slice(match[0].length);
    quote.children!.unshift({ type: "paragraph", children: [{
      type: "html", value: `<strong data-github-alert="${kind}">${kind[0]!.toUpperCase()}${kind.slice(1)}</strong>`,
    }] });
  }
}
