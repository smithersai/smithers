// LemmaScript reads TypeScript defect reproductions.
//@ verify
//@ ensures \result ==> !href.startsWith("javascript:")
export function safeLink(href: string): boolean {
  if (/[\\\u0000-\u0020]/.test(href)) return false
  return !/^[a-z][a-z0-9+.-]*:/i.test(href) ? !href.startsWith("//") : /^https?:\/\//i.test(href)
}
