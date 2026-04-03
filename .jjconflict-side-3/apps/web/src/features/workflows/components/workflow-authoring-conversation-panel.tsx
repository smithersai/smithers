import { BrainIcon } from "lucide-react"

import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@/components/ai-elements/chain-of-thought"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import type { WorkflowAuthoringConversationItem } from "@/features/workflows/lib/workflow-authoring-conversation"

export type WorkflowAuthoringConversationPanelProps = {
  items: WorkflowAuthoringConversationItem[]
  isStreaming: boolean
}

export function WorkflowAuthoringConversationPanel({
  items,
  isStreaming,
}: WorkflowAuthoringConversationPanelProps) {
  return (
    <div className="h-full min-h-0 w-full min-w-0 overflow-hidden rounded-xl border bg-background">
      <Conversation className="h-full">
        <ConversationContent>
          {items.length === 0 ? (
            <ConversationEmptyState
              description="Waiting for agent output..."
              icon={<BrainIcon className="size-8 text-muted-foreground/70" />}
              title="Authoring workflow"
            />
          ) : (
            items.map((item) => {
              if (item.type === "chain") {
                const thoughtLabel = "Chain of thought"
                return (
                  <ChainOfThought
                    defaultOpen
                    isStreaming={item.isStreaming && isStreaming}
                    key={item.id}
                  >
                    <ChainOfThoughtHeader title={thoughtLabel} />
                    <ChainOfThoughtContent>
                      <MessageResponse isAnimating={item.isStreaming && isStreaming}>
                        {item.text}
                      </MessageResponse>
                    </ChainOfThoughtContent>
                  </ChainOfThought>
                )
              }

              return (
                <Message from="assistant" key={item.id}>
                  <MessageContent>
                    <MessageResponse>{item.text}</MessageResponse>
                  </MessageContent>
                </Message>
              )
            })
          )}
        </ConversationContent>
        <ConversationScrollButton aria-label="Scroll to latest output" />
      </Conversation>
    </div>
  )
}
