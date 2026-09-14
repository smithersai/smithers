/** Keep the message and card preview together when they fit; otherwise show the card's start. A chat turn that outgrows the viewport follows its streaming text. */
export function transcriptScrollTop({ scrollTop, viewportTop, viewportHeight, messageTop, cardTop, cardHeight, viewportBottom, contentBottom }: {
  scrollTop: number; viewportTop: number; viewportHeight: number; messageTop?: number; cardTop?: number; cardHeight?: number; viewportBottom?: number; contentBottom?: number
}): number {
  // Reserve the header and first row, not the full height of a long embedded card.
  const previewHeight = Math.min(cardHeight ?? 0, 120)
  const showCard = cardTop !== undefined && messageTop !== undefined && cardTop > messageTop
    && cardTop - messageTop + previewHeight > viewportHeight
  const top = showCard ? cardTop : messageTop ?? cardTop
  const start = top === undefined ? 0 : Math.max(0, scrollTop + top - viewportTop)
  // Lessons anchor their beginning; an overflowing chat turn follows streaming text.
  return viewportBottom === undefined || contentBottom === undefined ? start
    : Math.max(start, scrollTop + contentBottom - viewportBottom)
}

export function scrollToGuideRead(viewport: HTMLElement, step: number, chatMessageId?: string) {
  const chatMessages = [...viewport.querySelectorAll<HTMLElement>('[data-chat-message-id]')]
  const chat = chatMessages.find(node => node.dataset.chatMessageId === chatMessageId)
  const message = chat ?? viewport.querySelector<HTMLElement>(`[data-message-step="${step}"]`)
  // A chat read belongs to its own message, not an earlier lesson card.
  const card = chat ? undefined : viewport.querySelector<HTMLElement>(`[data-entry-step="${step}"] .smithers-card`)
  const cardBounds = card?.getBoundingClientRect()
  viewport.scrollTo({ top: transcriptScrollTop({ scrollTop: viewport.scrollTop,
    viewportTop: viewport.getBoundingClientRect().top + 10,
    viewportHeight: Math.max(0, viewport.clientHeight - 20),
    messageTop: message?.getBoundingClientRect().top, cardTop: cardBounds?.top, cardHeight: cardBounds?.height,
    viewportBottom: chat ? viewport.getBoundingClientRect().bottom - 10 : undefined,
    contentBottom: chat ? chatMessages.at(-1)?.getBoundingClientRect().bottom : undefined,
  }), behavior: "instant" })
}
