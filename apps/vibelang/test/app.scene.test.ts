// The web app's real view and update, driven the way a person drives them, with Foldkit scenes (no browser).
import { Command, click, expect, given, placeholder, role, scene, Subscription, text, type } from "foldkit/scene"
import { describe, test } from "vitest"
import { newClient } from "../src/core/conversation.ts"
import { ShowPalette, ClosePalette, FocusComposer, HOME_CONVERSATION, Message, type Model, PostMessage, update } from "../src/web/main.vibe"
import { view } from "../src/web/view.ts"

const home: Model = {
  surface: "splash",
  palette: false,
  draft: "",
  session: "s1",
  name: "Ada",
  reducedMotion: false,
  sent: 0,
  conversation: HOME_CONVERSATION,
  client: newClient,
  mode: "mock",
  stream: "closed",
  epoch: 0,
  from: 0,
  following: true,
  followIntent: 0,
  answer: "",
  announced: 0,
  connection: "",
}

describe("the splash", () => {
  test("is VibeLang's home page with one action and routes to the docs and the source", () => {
    scene(
      { update, view },
      given(home),
      expect(role("heading", { name: "VibeLang" })).toExist(),
      expect(role("button", { name: "Ask the agent" })).toExist(),
      expect(role("link", { name: "Docs" })).toExist(),
      expect(role("link", { name: "Source" })).toExist(),
      expect(text("Mock")).toExist(),
    )
  })

  test("⌘K opens the prompt; a question turns the page into the chat with the splash as its first pane", () => {
    scene(
      { update, view },
      given(home),
      Subscription.emit(Message.ScrolledTranscript({ bottom: false })),
      Subscription.emit(Message.PressedCommandK()),
      Command.expectExact(ShowPalette({})),
      Command.resolve(ShowPalette, Message.FocusedPrompt()),
      expect(role("dialog", { name: "Ask the agent" })).toExist(),
      type(placeholder("Ask about VibeLang, or describe what to change"), "How do I install it?"),
      click(role("button", { name: "Send" })),
      Command.expectExact(PostMessage({ conversation: HOME_CONVERSATION, clientId: "s1-1", name: "Ada", text: "How do I install it?" }), ClosePalette({ dock: true })),
      Command.resolve(ClosePalette, Message.FocusedPrompt()),
      Command.resolve(PostMessage, Message.SucceededPost({ clientId: "s1-1" })),
      expect(role("dialog", { name: "Ask the agent" })).toHaveAttr("data-state", "closed"),
      expect(role("button", { name: "Expand the VibeLang home page" })).toExist(),
      expect(text("How do I install it?")).toExist(),
    )
  })

  test("Escape closes the prompt without sending", () => {
    scene(
      { update, view },
      given({ ...home, palette: true }),
      Subscription.emit(Message.PressedEscape()),
      Command.expectExact(ClosePalette({ dock: false })),
      Command.resolve(ClosePalette, Message.FocusedPrompt()),
      expect(role("dialog", { name: "Ask the agent" })).toHaveAttr("data-state", "closed"),
    )
  })
})

describe("the chat", () => {
  const chatting: Model = { ...home, surface: "chat", stream: "open", sent: 1 }

  test("shows the agent's streamed reply as it arrives and confirms the pending post", () => {
    scene(
      { update, view },
      given({ ...chatting, client: { ...newClient, pending: [{ clientId: "s1-1", text: "hi", error: "" }] } }),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "Posted", seq: 1, id: "m1", clientId: "s1-1", name: "Ada", text: "hi" } })),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyStarted", seq: 2, id: "r1", inReplyTo: "m1" } })),
      expect(role("status", { name: "Thinking" })).toExist(),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyDelta", seq: 3, id: "r1", text: "Use `npm create`" } })),
      expect(text("npm create")).toExist(),
      expect(role("log", { name: "Conversation" })).toExist(),
      expect(role("status", { name: "Answer" })).toHaveText(""),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyFinished", seq: 4, id: "r1" } })),
      expect(text("VibeLang agent")).toExist(),
      expect(role("status", { name: "Answer" })).toHaveText("Answer 1: Use `npm create`"),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyFinished", seq: 4, id: "r1" } })),
      Command.expectNone(),
      expect(role("status", { name: "Answer" })).toHaveText("Answer 1: Use `npm create`"),
    )
  })

  test("a failed answer is announced once, without announcing its streamed pieces", () => {
    scene(
      { update, view },
      given({ ...chatting, following: false }),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "Posted", seq: 1, id: "m1", clientId: "s1-1", name: "Ada", text: "hi" } })),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyStarted", seq: 2, id: "r1", inReplyTo: "m1" } })),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyDelta", seq: 3, id: "r1", text: "partial" } })),
      expect(role("status", { name: "Answer" })).toHaveText(""),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyFailed", seq: 4, id: "r1", reason: "interrupted" } })),
      expect(role("status", { name: "Answer" })).toHaveText("Answer 1: Answer failed"),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyFailed", seq: 4, id: "r1", reason: "interrupted" } })),
      Command.expectNone(),
      expect(role("status", { name: "Answer" })).toHaveText("Answer 1: Answer failed"),
    )
  })

  test("a failed answer says why, in the agent's words, and live mode shows no Mock pill", () => {
    const reason = "The agent's daily budget is spent. It resets at 00:00 UTC."
    scene(
      { update, view },
      given({ ...chatting, mode: "live" }),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "Posted", seq: 1, id: "m1", clientId: "s1-1", name: "Ada", text: "hi" } })),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyStarted", seq: 2, id: "r1", inReplyTo: "m1" } })),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyFailed", seq: 3, id: "r1", reason } })),
      expect(text(reason)).toExist(),
      expect(text("Answer failed")).not.toExist(),
      expect(role("status", { name: "Thinking" })).not.toExist(),
      expect(text("Mock")).not.toExist(),
    )
  })

  test("scrolling up pauses following; Latest follows the transcript again", () => {
    scene(
      { update, view },
      given(chatting),
      Subscription.emit(Message.ScrolledTranscript({ bottom: false })),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "Posted", seq: 1, id: "m1", clientId: "other", name: "Grace", text: "hi" } })),
      Command.expectNone(),
      expect(role("button", { name: "Latest" })).toExist(),
      click(role("button", { name: "Latest" })),
      Command.expectExact(FocusComposer({})),
      Command.resolve(FocusComposer, Message.FocusedPrompt()),
      expect(role("button", { name: "Latest" })).toBeAbsent(),
      Subscription.emit(Message.ScrolledTranscript({ bottom: false })),
      Subscription.emit(Message.ScrolledTranscript({ bottom: true })),
      expect(role("button", { name: "Latest" })).toBeAbsent(),
    )
  })

  test("a refused post stays, marked with why", () => {
    scene(
      { update, view },
      given({ ...chatting, client: { ...newClient, pending: [{ clientId: "s1-1", text: "hi", error: "" }] } }),
      Subscription.emit(Message.FailedPost({ clientId: "s1-1", reason: "too-long" })),
      expect(text("too-long")).toBeAbsent(),
      expect(text("Message too long")).toExist(),
      click(role("button", { name: "Retry" })),
      Command.expectExact(PostMessage({ conversation: HOME_CONVERSATION, clientId: "s1-1", name: "Ada", text: "hi" }), FocusComposer({})),
      expect(text("Message too long")).toBeAbsent(),
      Command.resolve(PostMessage, Message.SucceededPost({ clientId: "s1-1" })),
      Command.resolve(FocusComposer, Message.FocusedPrompt()),
    )
  })

  test("a broken event stream offers to reconnect", () => {
    scene(
      { update, view },
      given(chatting),
      Subscription.emit(Message.FailedEvents({ reason: "network" })),
      expect(text("Disconnected")).toExist(),
      expect(role("status", { name: "Connection" })).toHaveText("Disconnected"),
      click(role("button", { name: "Reconnect" })),
      Command.resolve(FocusComposer, Message.FocusedPrompt()),
      expect(role("button", { name: "Reconnect" })).toBeAbsent(),
      expect(role("status", { name: "Connection" })).toHaveText("Reconnecting"),
    )
  })

  test("the pane maximizes the splash again, and Chat returns to the conversation", () => {
    scene(
      { update, view },
      given({ ...chatting, client: { ...newClient, pending: [{ clientId: "s1-1", text: "hi", error: "" }] } }),
      click(role("button", { name: "Expand the VibeLang home page" })),
      expect(role("heading", { name: "VibeLang" })).toExist(),
      click(role("button", { name: "Chat" })),
      expect(text("hi")).toExist(),
    )
  })
})

describe("product language and authors", () => {
  test("labels this tab's posts You and keeps another visitor's neutral name", () => {
    scene({ update, view }, given({ ...home, surface: "chat", sent: 1 }),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "Posted", seq: 1, id: "m1", clientId: "s1-1", name: "Guest", text: "mine" } })),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "Posted", seq: 2, id: "m2", clientId: "other-1", name: "Guest", text: "theirs" } })),
      expect(text("You")).toExist(), expect(text("Guest")).toExist())
  })
  for (const [reason, label] of [["empty", "Empty message"], ["duplicate", "Already sent"], ["busy", "Agent busy"], ["not-replying", "Answer unavailable"], ["Factory closed", "Send failed"]]) {
    test(`a refused post uses product words for ${reason}`, () => {
      scene({ update, view }, given({ ...home, surface: "chat", client: { ...newClient, pending: [{ clientId: "s1-1", text: "hi", error: reason! }] } }),
        expect(text(label!)).toExist(), expect(role("button", { name: "Retry" })).toExist())
    })
  }
  test("has no mock explanation tooltip or repeated answer-failure sentence", () => {
    scene({ update, view }, given({ ...home, surface: "chat", client: { ...newClient, conversation: { ...newClient.conversation, agent: "failed" } } }),
      expect(text("Mock")).not.toHaveAttr("title", "No backend or model: answers are scripted"),
      expect(text("The last answer failed")).toBeAbsent())
  })
})
