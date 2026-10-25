import { ChatMessage, ChatTranscript } from "@smthrs/ui"
import { createElement as h } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "./fixtures"
import { answerTo, messageIn, questionIn } from "./messages"

// A browser regression for the test harness, rendered with the actual UI components, without a backend or model.
test("message locators: Timeline copies and quoted questions do not select extra bubbles", async ({ page }) => {
  const question = "Reply with exactly the word: locator-regression"
  const markup = renderToStaticMarkup(h("section", { "aria-label": "Conversation" },
    h(ChatTranscript, { rail: h("div", null, h("span", null, question), h("strong", null, question)) },
      h(ChatMessage, { role: "user" }, question),
      h(ChatMessage, { role: "assistant" }, `You asked: ${question}. Answer: locator-regression`),
      h(ChatMessage, { role: "user" }, "Another question"),
      h(ChatMessage, { role: "assistant" }, "Another answer"),
    ),
  ))
  await page.goto("data:text/html,<title>Message locator regression</title>")
  await page.setContent(markup)
  const conversation = page.getByRole("region", { name: "Conversation", exact: true })
  await expect(conversation.getByText(question, { exact: true })).toHaveCount(3)
  await expect(questionIn(conversation, question)).toHaveCount(1)
  await expect(questionIn(conversation, question)).toBeVisible()
  await expect(answerTo(conversation, question)).toHaveCount(1)
  await expect(answerTo(conversation, question)).toHaveText(`You asked: ${question}. Answer: locator-regression`)
  await expect(messageIn(conversation, "Another answer")).toHaveCount(1)
  await expect(questionIn(conversation, "Another answer")).toHaveCount(0)
  await expect(questionIn(conversation, "Absent question")).toHaveCount(0)
  await expect(answerTo(conversation, "Absent question")).toHaveCount(0)
})
