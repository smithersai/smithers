/** Align the start of the current read, never the tail of its embedded card. */
export function transcriptScrollTop({ scrollTop, viewportTop, messageTop, cardTop }: {
  scrollTop: number; viewportTop: number; messageTop?: number; cardTop?: number
}): number {
  const top = messageTop ?? cardTop
  return top === undefined ? 0 : Math.max(0, scrollTop + top - viewportTop)
}

export function scrollToGuideRead(viewport: HTMLElement, step: number, chatMessageId?: string) {
  const chat = [...viewport.querySelectorAll<HTMLElement>('[data-chat-message-id]')]
    .find(node => node.dataset.chatMessageId === chatMessageId)
  const message = chat ?? viewport.querySelector<HTMLElement>(`[data-message-step="${step}"]`)
  const card = viewport.querySelector<HTMLElement>(`[data-entry-step="${step}"] .smithers-card`)
  viewport.scrollTo({ top: transcriptScrollTop({ scrollTop: viewport.scrollTop,
    viewportTop: viewport.getBoundingClientRect().top + 10,
    messageTop: message?.getBoundingClientRect().top, cardTop: card?.getBoundingClientRect().top,
  }), behavior: "instant" })
}
