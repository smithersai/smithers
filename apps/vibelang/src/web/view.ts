// The web app's view. Chat parts use @smthrs/ui's classes (`sui-chat-*`, `sui-cmd-*`), so the conversation looks the
// way it does on smithers.sh; the splash and the frame are this app's (`vl-*`, styles.css).
import { Option } from "effect"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import type { Entry, Pending } from "../core/conversation.ts"
import { hasConversation, type Message as AppMessage, Message, type Model, PALETTE_ID, PALETTE_PROMPT_ID, PROMPT_ID } from "./main.vibe"
import { render } from "./markdown.ts"

type H = HtmlBuilder<AppMessage>

export const DOCS_URL = "https://vibelang.sh"
export const SOURCE_URL = "https://github.com/smithersai/vibelang"
export const INSTALL = "npm create vibelang@latest my-app"

export function view(model: Model, h: H): Document {
  return {
    title: model.surface === "splash" ? "VibeLang" : "VibeLang · Chat",
    body: h.div(
      [h.Class("vl-app"), h.DataAttribute("surface", model.surface), h.DataAttribute("mode", model.mode)],
      [
        top(model, h),
        model.surface === "splash" ? splash(h) : chat(model, h),
        palette(model, h),
      ],
    ),
  }
}

/** The wordmark; styles.css shows the version whose text suits the theme. */
function logo(h: H): Html {
  return h.span([h.Class("vl-logo")], [
    h.img([h.Class("vl-logo-on-dark"), h.Src("/media/logo-dark.svg"), h.Alt("VibeLang")]),
    h.img([h.Class("vl-logo-on-light"), h.Src("/media/logo-light.svg"), h.Alt("VibeLang")]),
  ])
}

function top(model: Model, h: H): Html {
  return h.header([h.Class("vl-top")], [
    h.button([h.Class("vl-home"), h.Type("button"), h.AriaLabel("Home"), h.OnClick(Message.ClickedSplash())], [logo(h)]),
    h.nav([h.Class("vl-nav")], [
      ...(model.mode === "mock" ? [h.span([h.Class("vl-pill"), h.Title("No backend or model: answers are scripted")], ["Mock"])] : []),
      ...(model.surface === "splash" && hasConversation(model)
        ? [h.button([h.Class("vl-link"), h.Type("button"), h.OnClick(Message.ClickedChat())], ["Chat"])]
        : []),
      h.a([h.Class("vl-link"), h.Href(DOCS_URL)], ["Docs"]),
      h.a([h.Class("vl-link"), h.Href(SOURCE_URL)], ["Source"]),
    ]),
  ])
}

// ── splash ───────────────────────────────────────────────────────────────────────────────────────────────────────

function splash(h: H): Html {
  return h.main([h.Class("vl-splash"), h.Style({ viewTransitionName: "splash" })], [
    h.section([h.Class("vl-hero")], [
      h.div([h.Class("vl-eyebrow")], ["Effect, as a language"]),
      h.h1([h.Class("vl-title")], [h.span([h.Class("vl-gradient")], ["Vibe"]), "Lang"]),
      h.p([h.Class("vl-tagline")], [
        "VibeLang gives Effect a simple, readable syntax that compiles to JavaScript with TypeScript declarations.",
      ]),
      h.div([h.Class("vl-actions")], [
        h.button([h.Class("vl-ask"), h.Type("button"), h.AriaLabel("Ask the agent"), h.AriaKeyshortcuts("Meta+K"), h.OnClick(Message.ClickedAsk())], [
          "Ask the agent",
          h.kbd([h.Class("vl-kbd"), h.AriaHidden(true)], ["⌘K"]),
        ]),
      ]),
      h.pre([h.Class("vl-install")], [h.code([], [INSTALL])]),
    ]),
    h.figure([h.Class("vl-media")], [
      h.video(
        [h.Src("/media/contract.mp4"), h.Poster("/media/contract-poster.jpg"), h.Autoplay(true), h.Muted(true), h.Loop(true), h.Playsinline(true), h.AriaLabel("A!E!R: what a function returns, how it fails, what it needs")],
        [],
      ),
    ]),
  ])
}

/** The splash, shrunk to the chat's first pane; clicking it maximizes it again. */
function splashPane(h: H): Html {
  return h.button(
    [h.Class("vl-pane"), h.Type("button"), h.Style({ viewTransitionName: "splash" }), h.OnClick(Message.ClickedSplash()), h.AriaLabel("Expand the VibeLang home page")],
    [logo(h), h.span([h.Class("vl-pane-text")], ["Effect, as a language"]), h.span([h.Class("vl-pane-expand")], ["⤢"])],
  )
}

// ── chat ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function chat(model: Model, h: H): Html {
  const { conversation, pending } = model.client
  return h.main([h.Class("vl-chat")], [
    h.div([h.Class("sui-chat-messages")], [
      splashPane(h),
      ...conversation.entries.map((entry) => entryView(entry, h)),
      ...pending.map((post) => pendingView(post, model.name, h)),
      ...(model.stream === "failed"
        ? [h.div([h.Class("sui-chat-message"), h.DataAttribute("role", "system")], [
          h.div([h.Class("sui-chat-bubble")], [
            "Lost the connection. ",
            h.button([h.Class("vl-link"), h.Type("button"), h.OnClick(Message.ClickedReconnect())], ["Reconnect"]),
          ]),
        ])]
        : []),
      h.div([h.Id("vl-newest"), h.AriaHidden(true)], []),
    ]),
    ...(!model.following ? [h.button([h.Class("sui-msg-scroller-jump vl-latest"), h.Type("button"), h.AriaLabel("Latest"), h.OnClick(Message.ClickedLatest())], ["↓"])] : []),
    composer(model, h),
  ])
}

function entryView(entry: Entry, h: H): Html {
  const role = entry.author === "person" ? "user" : "assistant"
  const body = entry.author === "agent" ? render(h, entry.text) : [entry.text]
  return h.article(
    [h.Class("sui-chat-message"), h.DataAttribute("role", role), h.DataAttribute("done", String(entry.done)), h.Key(entry.id)],
    [
      h.div([h.Class("sui-chat-message-label")], [entry.name]),
      h.div(
        [h.Class(entry.text === "" && !entry.done ? "sui-chat-bubble vl-thinking" : "sui-chat-bubble")],
        entry.text === "" && !entry.done ? [h.span([h.Class("vl-dots"), h.Role("status"), h.AriaLabel("Thinking")], [])] : body,
      ),
      ...(entry.error === "" ? [] : [h.div([h.Class("sui-chat-message-meta vl-error")], [entry.error])]),
    ],
  )
}

function pendingView(post: Pending, name: string, h: H): Html {
  return h.article(
    [h.Class("sui-chat-message"), h.DataAttribute("role", "user"), h.DataAttribute("pending", "true"), h.Key(post.clientId)],
    [
      h.div([h.Class("sui-chat-message-label")], [name]),
      h.div([h.Class("sui-chat-bubble")], [post.text]),
      ...(post.error === "" ? [] : [h.div([h.Class("sui-chat-message-meta vl-error")], [post.error])]),
    ],
  )
}

function promptInput(model: Model, h: H, placeholder: string, id = PROMPT_ID): Html {
  return h.textarea([
    h.Id(id),
    h.Class("sui-chat-composer-input"),
    h.Rows(1),
    h.Placeholder(placeholder),
    h.AriaLabel("Message"),
    h.Value(model.draft),
    h.OnInput((value) => Message.UpdatedDraft({ value })),
    h.OnKeyDownPreventDefault((key, modifiers) =>
      key === "Enter" && !modifiers.shiftKey ? Option.some(Message.SubmittedDraft()) : Option.none()
    ),
  ])
}

function composer(model: Model, h: H): Html {
  return h.form(
    [h.Class("sui-chat-composer"), h.DataAttribute("docked", "true"), h.Style({ viewTransitionName: model.palette ? "none" : "prompt" }), h.OnSubmit(Message.SubmittedDraft())],
    [
      promptInput(model, h, "Ask about VibeLang"),
      h.div([h.Class("sui-chat-composer-toolbar")], [
        h.span([h.Class("sui-chat-composer-status")], [statusText(model)]),
        h.div([h.Class("sui-chat-composer-actions")], [
          h.button([h.Class("vl-send sui-chat-composer-send"), h.Type("submit"), h.AriaLabel("Send"), h.Disabled(model.draft.trim() === "")], ["↑"]),
        ]),
      ]),
    ],
  )
}

function statusText(model: Model): string {
  const { conversation } = model.client
  if (model.stream === "failed") return "Disconnected"
  if (conversation.agent === "working") return "Agent is answering"
  if (conversation.agent === "failed") return "The last answer failed"
  return ""
}

// ── ⌘K ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function palette(model: Model, h: H): Html {
  return h.dialog([h.Id(PALETTE_ID), h.Class("vl-palette-layer"), h.AriaLabel("Ask the agent"), h.AriaModal(true), h.AriaHidden(!model.palette), h.OnCancelPreventDefault(Message.PressedEscape())], [
    h.div([h.Class("vl-palette-scrim"), h.OnClick(Message.PressedEscape())], []),
    h.form(
      [
        h.Class("vl-palette sui-chat-composer"),
        h.Style({ viewTransitionName: model.palette ? "prompt" : "none" }),
        h.OnSubmit(Message.SubmittedDraft()),
      ],
      [
        promptInput(model, h, "Ask about VibeLang, or describe what to change", PALETTE_PROMPT_ID),
        h.div([h.Class("sui-chat-composer-toolbar")], [
          h.span([h.Class("sui-chat-composer-status")], [h.kbd([h.Class("vl-kbd")], ["⏎"]), " to send · ", h.kbd([h.Class("vl-kbd")], ["esc"]), " to close"]),
          h.div([h.Class("sui-chat-composer-actions")], [
            h.button([h.Class("vl-send sui-chat-composer-send"), h.Type("submit"), h.AriaLabel("Send"), h.Disabled(model.draft.trim() === "")], ["↑"]),
          ]),
        ]),
      ],
    ),
  ])
}
