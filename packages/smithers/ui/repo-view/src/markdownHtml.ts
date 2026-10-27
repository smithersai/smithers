/** Read-only HTML policy. Parse into an inert template, then construct only allowlisted nodes. */
const allowed = new Set("a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img kbd li ol p pre s samp small span strong sub summary sup table tbody td th thead tr ul".split(" "));
const discard = new Set("script style iframe object embed template svg math form input button link meta base".split(" "));

/** URLs keep repository-relative paths and the protocols GitHub Markdown needs. */
const safeUrl = (value: string) => !/^[\s\u0000-\u0020]*[^/?#]*:/.test(value) || /^(https?:|mailto:)/i.test(value);

export function markdownHtml(source: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = source;
  const result = document.createElement("span");
  result.className = "sui-markdown-html";
  const append = (parent: Node, node: Node): void => {
    if (node.nodeType === 3) { parent.appendChild(document.createTextNode(node.textContent ?? "")); return; }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const name = element.localName.toLowerCase();
    if (discard.has(name)) return;
    const target = allowed.has(name) ? document.createElement(name) : document.createDocumentFragment();
    if (target instanceof HTMLElement) {
      for (const attr of ["title", "alt"]) {
        const value = element.getAttribute(attr);
        if (value !== null && (attr === "title" || name === "img")) target.setAttribute(attr, value);
      }
      for (const attr of ["href", "src"]) {
        const value = element.getAttribute(attr);
        if (value !== null && ((name === "a" && attr === "href") || (name === "img" && attr === "src")) && safeUrl(value)) target.setAttribute(attr, value);
      }
      const alert = element.getAttribute("data-github-alert");
      if (name === "strong" && alert !== null && /^(note|tip|important|warning|caution)$/.test(alert)) {
        target.className = "sui-markdown-alert-title";
        target.dataset.kind = alert;
      }
      const align = element.getAttribute("align");
      if (align !== null && /^(left|center|right)$/i.test(align)) target.style.textAlign = align.toLowerCase();
      if (name === "a") target.setAttribute("rel", "noopener noreferrer");
    }
    for (const child of element.childNodes) append(target, child);
    parent.appendChild(target);
  };
  for (const child of template.content.childNodes) append(result, child);
  return result;
}

/** The subset of mdast needed to join split inline HTML tags before sanitizing them. */
export type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  alt?: string | null;
  children?: MarkdownNode[];
};
const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inlineHtml = (node: MarkdownNode): string => {
  const children = () => (node.children ?? []).map(inlineHtml).join("");
  switch (node.type) {
    case "html": return node.value ?? "";
    case "text": return escape(node.value ?? "");
    case "inlineCode": return `<code>${escape(node.value ?? "")}</code>`;
    case "strong": return `<strong>${children()}</strong>`;
    case "emphasis": return `<em>${children()}</em>`;
    case "delete": return `<del>${children()}</del>`;
    case "break": return "<br>";
    case "link": return `<a href="${escape(node.url ?? "")}" title="${escape(node.title ?? "")}">${children()}</a>`;
    case "image": return `<img src="${escape(node.url ?? "")}" alt="${escape(node.alt ?? "")}" title="${escape(node.title ?? "")}">`;
    default: return children();
  }
};

/** CommonMark splits inline tags into separate nodes. Join the paragraph so bold and links retain their children. */
export function joinMarkdownHtml(node: MarkdownNode): void {
  if (node.children === undefined) return;
  if (["paragraph", "heading"].includes(node.type) && node.children.some(child => child.type === "html")) {
    node.children = [{ type: "html", value: node.children.map(inlineHtml).join("") }];
  } else node.children.forEach(joinMarkdownHtml);
}
