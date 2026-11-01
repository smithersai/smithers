/** Geometry is in scroll-content coordinates. A null target leaves the reader alone. */
export function decideTranscriptScroll(
  previous: { following: boolean },
  viewport: { scrollTop: number; clientHeight: number; scrollHeight: number },
  content: { top: number; height: number },
  actor: "arrival" | "user" | "output",
): { top: number | null; following: boolean } {
  if (actor === "output" && !previous.following) return { top: null, following: false };
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  /*
   * The live edge answers a requested read only when the read IS at the live
   * edge. One transcript entry can be navigated in place and keep its own
   * place — the repository web pane is one card, and a saved conversation
   * holds every private card at its anchored position — so the entry a read
   * refreshed can sit entirely above the bottom. Scrolling to maxTop there
   * shows the person the newest thing in the room instead of the answer they
   * asked for (production 20261015: /issues.create then /issues.list left the
   * view on the composer's form while both results refreshed early in the
   * conversation). Read it where it is, and release follow: the live edge is
   * not what was asked for, and Latest is one click away. An entry that has
   * not been measured yet (height 0) states no position, so it keeps the
   * edge rather than sending the reader to the top of the conversation.
   */
  if (actor === "user" && content.height > 0 && content.top + content.height <= maxTop) {
    return { top: Math.max(0, content.top - 10), following: false };
  }
  const target = actor === "arrival" || content.height > viewport.clientHeight
    ? content.top - 10
    : maxTop;
  return { top: Math.min(maxTop, Math.max(0, target)), following: true };
}

/** A new position away from the live edge is an explicit read, even before the browser delivers its scroll event. */
export const transcriptFollowInterrupted = (
  rememberedTop: number,
  viewport: { readonly scrollTop: number; readonly clientHeight: number; readonly scrollHeight: number },
  threshold: number,
): boolean => Math.abs(viewport.scrollTop - rememberedTop) > 1 &&
  Math.max(0, viewport.scrollHeight - viewport.clientHeight) - viewport.scrollTop > threshold;
