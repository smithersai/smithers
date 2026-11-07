// The web app's real view and update, driven the way a person drives them, with Foldkit scenes (no browser).
import { Command, click, expect, given, placeholder, role, scene, Subscription, text, type } from "foldkit/scene"
import { describe, test } from "vitest"
import { newClient } from "../src/core/conversation.ts"
import { ShowPalette, ClosePalette, FollowLatest, HOME_CONVERSATION, Message, type Model, PostMessage, update } from "../src/web/main.vibe"
import { view } from "../src/web/view.ts"

const home: Model = {
  surface: "splash",
  palette: false,
  draft: "",
  session: "s1",
  name: "Ada",
  sent: 0,
  conversation: HOME_CONVERSATION,
  client: newClient,
  mode: "mock",
  stream: "closed",
  epoch: 0,
  from: 0,
  following: true,
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
      Subscription.emit(Message.PressedCommandK()),
      Command.expectExact(ShowPalette({})),
      Command.resolve(ShowPalette, Message.FocusedPrompt()),
      expect(role("dialog", { name: "Ask the agent" })).toExist(),
      type(placeholder("Ask about VibeLang, or describe what to change"), "How do I install it?"),
      click(role("button", { name: "Send" })),
      Command.expectExact(PostMessage({ conversation: HOME_CONVERSATION, clientId: "s1-1", name: "Ada", text: "How do I install it?" }), ClosePalette({ dock: true }), FollowLatest({})),
      Command.resolve(ClosePalette, Message.FocusedPrompt()),
      Command.resolve(FollowLatest, Message.ScrolledLatest()),
      Command.resolve(PostMessage, Message.SucceededPost({ clientId: "s1-1" })),
      expect(role("dialog", { name: "Ask the agent" })).toHaveAttr("aria-hidden", "true"),
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
      expect(role("dialog", { name: "Ask the agent" })).toHaveAttr("aria-hidden", "true"),
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
      Command.resolve(FollowLatest, Message.ScrolledLatest()),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyStarted", seq: 2, id: "r1" } })),
      Command.resolve(FollowLatest, Message.ScrolledLatest()),
      expect(role("status", { name: "Thinking" })).toExist(),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyDelta", seq: 3, id: "r1", text: "Use `npm create`" } })),
      Command.resolve(FollowLatest, Message.ScrolledLatest()),
      expect(text("npm create")).toExist(),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "ReplyFinished", seq: 4, id: "r1" } })),
      Command.resolve(FollowLatest, Message.ScrolledLatest()),
      expect(text("VibeLang agent")).toExist(),
    )
  })

  test("scrolling up pauses following; Latest follows the transcript again", () => {
    scene(
      { update, view },
      given(chatting),
      Subscription.emit(Message.ScrolledTranscript({ bottom: false })),
      Command.resolve(FollowLatest.Interrupt(() => Message.CompletedCancelFollowLatest()), Message.CompletedCancelFollowLatest()),
      Subscription.emit(Message.ReceivedEvent({ event: { type: "Posted", seq: 1, id: "m1", clientId: "other", name: "Grace", text: "hi" } })),
      Command.expectNone(),
      expect(role("button", { name: "Latest" })).toExist(),
      click(role("button", { name: "Latest" })),
      Command.expectExact(FollowLatest({})),
      Command.resolve(FollowLatest, Message.ScrolledLatest()),
      expect(role("button", { name: "Latest" })).toBeAbsent(),
      Subscription.emit(Message.ScrolledTranscript({ bottom: false })),
      Command.resolve(FollowLatest.Interrupt(() => Message.CompletedCancelFollowLatest()), Message.CompletedCancelFollowLatest()),
      Subscription.emit(Message.ScrolledTranscript({ bottom: true })),
      expect(role("button", { name: "Latest" })).toBeAbsent(),
    )
  })

  test("a refused post stays, marked with why", () => {
    scene(
      { update, view },
      given({ ...chatting, client: { ...newClient, pending: [{ clientId: "s1-1", text: "hi", error: "" }] } }),
      Subscription.emit(Message.FailedPost({ clientId: "s1-1", reason: "too-long" })),
      expect(text("too-long")).toExist(),
    )
  })

  test("a broken event stream offers to reconnect", () => {
    scene(
      { update, view },
      given(chatting),
      Subscription.emit(Message.FailedEvents({ reason: "network" })),
      expect(text("Disconnected")).toExist(),
      click(role("button", { name: "Reconnect" })),
      expect(role("button", { name: "Reconnect" })).toBeAbsent(),
    )
  })

  test("the pane maximizes the splash again, and Chat returns to the conversation", () => {
    scene(
      { update, view },
      given({ ...chatting, client: { ...newClient, pending: [{ clientId: "s1-1", text: "hi", error: "" }] } }),
      click(role("button", { name: "Expand the VibeLang home page" })),
      expect(role("heading", { name: "VibeLang" })).toExist(),
      click(role("button", { name: "Chat" })),
      Command.resolve(FollowLatest, Message.ScrolledLatest()),
      expect(text("hi")).toExist(),
    )
  })
})
