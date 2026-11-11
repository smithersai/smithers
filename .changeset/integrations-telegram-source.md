---
"@smthrs/integrations": minor
---

Telegram receiving is back as `Telegram.Source`: a `getUpdates` long-poll source that turns messages and edits from allowed chats into events, so a bot can start a flow or signal a run through `Core.Channel.fromSource` without a public webhook URL. The offset is committed to `Core.CursorStore` only after the batch was handled, each poll is one request whose failure says whether another poll can clear it, and the token never reaches an error, a span or a log. Approvals, Mini App data, Markdown, chunking, issue sync and the Bot API client stay removed; sending is `@smthrs/notifications`.
