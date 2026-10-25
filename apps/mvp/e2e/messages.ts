import type { Locator } from "@playwright/test"

/** Transcript bubbles only: Timeline repeats message text, including in hidden descendants. */
export const messageIn = (conversation: Locator, text: string | RegExp) =>
  conversation.locator(".sui-chat-messages .sui-chat-message", { hasText: text })

/** The person's bubble, never an answer that quotes their question. */
export const questionIn = (conversation: Locator, text: string) =>
  messageIn(conversation, text).and(conversation.locator('[data-role="user"]'))

/** The first answer to the first matching question, preserving chronological pairing. */
export const answerTo = (conversation: Locator, question: string) =>
  questionIn(conversation, question).first().locator('xpath=following-sibling::*[@data-role="assistant"][1]')
