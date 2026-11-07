/** A scroll event measures the reader's position, independently of later transcript growth. */
export function atBottom(document: Document): boolean {
  const viewport = document.documentElement
  return viewport.scrollHeight - viewport.clientHeight - (document.defaultView?.scrollY ?? 0) <= 48
}
