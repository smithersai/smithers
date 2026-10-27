/** Name image-only links even when an upstream README omits its badge alt. */
export function markdownLinkNames(root: ParentNode): void {
  for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (link.getAttribute("aria-label") || link.textContent?.trim()) continue;
    const image = link.querySelector("img");
    if (!image) continue;
    const href = link.getAttribute("href")!;
    const name = image.getAttribute("alt")?.trim() || link.getAttribute("title")?.trim() ||
      image.getAttribute("title")?.trim() || href.split(/[/?#]/).filter(Boolean).pop() || "Link";
    link.setAttribute("aria-label", name);
  }
}
