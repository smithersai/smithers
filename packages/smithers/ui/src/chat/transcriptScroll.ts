/** Geometry is in scroll-content coordinates. A null target leaves the reader alone. */
export function decideTranscriptScroll(
  previous: { following: boolean },
  viewport: { scrollTop: number; clientHeight: number; scrollHeight: number },
  content: { top: number; height: number },
  actor: "arrival" | "user" | "output",
): { top: number | null; following: boolean } {
  if (actor === "output" && !previous.following) return { top: null, following: false };
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const target = actor === "arrival" || content.height > viewport.clientHeight
    ? content.top - 10
    : maxTop;
  return { top: Math.min(maxTop, Math.max(0, target)), following: true };
}
