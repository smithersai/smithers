import { createContext, useContext } from "react"
import type { ChatView } from "./features/chat/chat"

// What React components get: the chat layer's live queries to render and plain actions to call (features/chat/chat.ts).

const ChatContext = createContext<ChatView | null>(null)

export const ChatProvider = ChatContext.Provider

export const useChat = (): ChatView => {
  const chat = useContext(ChatContext)
  if (chat === null) throw new Error("useChat needs a ChatProvider: main.tsx renders one")
  return chat
}

/** Returns `ChatView` when inside `ChatProvider`, or `null` in minimal test harnesses. */
export const useOptionalChat = () => useContext(ChatContext)
