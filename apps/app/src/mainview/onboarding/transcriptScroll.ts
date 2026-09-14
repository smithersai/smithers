/** Keep the message and card preview together when they fit; otherwise show the card's start. */
export function transcriptScrollTop({ scrollTop, viewportTop, viewportHeight, messageTop, cardTop, cardHeight }: {
  scrollTop: number; viewportTop: number; viewportHeight: number; messageTop?: number; cardTop?: number; cardHeight?: number
}): number {
  // Reserve the header and first row, not the full height of a long embedded card.
  const previewHeight = Math.min(cardHeight ?? 0, 120)
  const showCard = cardTop !== undefined && messageTop !== undefined && cardTop > messageTop
    && cardTop - messageTop + previewHeight > viewportHeight
  const top = showCard ? cardTop : messageTop ?? cardTop
  return top === undefined ? 0 : Math.max(0, scrollTop + top - viewportTop)
}

export function scrollToGuideRead(viewport: HTMLElement, step: number, chatMessageId?: string) {
  const chat = [...viewport.querySelectorAll<HTMLElement>('[data-chat-message-id]')]
    .find(node => node.dataset.chatMessageId === chatMessageId)
  const message = chat ?? viewport.querySelector<HTMLElement>(`[data-message-step="${step}"]`)
  // A chat read belongs to its own message, not an earlier lesson card.
  const card = chat ? undefined : viewport.querySelector<HTMLElement>(`[data-entry-step="${step}"] .smithers-card`)
  const cardBounds = card?.getBoundingClientRect()
  viewport.scrollTo({ top: transcriptScrollTop({ scrollTop: viewport.scrollTop,
    viewportTop: viewport.getBoundingClientRect().top + 10,
    viewportHeight: Math.max(0, viewport.clientHeight - 20),
    messageTop: message?.getBoundingClientRect().top, cardTop: cardBounds?.top, cardHeight: cardBounds?.height,
  }), behavior: "instant" })
}
