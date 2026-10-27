/** Hide only a complete YAML metadata block at the start of a repository document. */
export const markdownDocumentBody = (source: string): string =>
  source.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");
