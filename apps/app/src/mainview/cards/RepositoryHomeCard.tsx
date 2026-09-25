import { Button, ChatComposer, Markdown } from "@smthrs/ui"
import { useLiveQuery } from "@tanstack/react-db"
import type { Card } from "../state/AppState"
import { useController } from "../ControllerContext"
import { dynamicFlowAction, flowProps } from "../flows/FlowAction"
import { repositoryFlowName } from "../flows/entries/flow"
import type { CardFamily } from "./CardFamily"
import "./RepositoryHomeCard.css"

type HomeCard = Extract<Card, { kind: "factory.home" }>

/*
 * The shared markdown renderer builds React nodes and filters unsafe link
 * schemes; raw HTML outside code fences is dropped so it never shows as text.
 * Fenced code keeps its angle brackets (`Array<string>`, JSX examples).
 */
const stripHtml = (value: string): string => value
  .replace(/<!--[^]*?-->/g, "")
  .replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, "")
  .replace(/<\/?[A-Za-z][^>]*>/g, "")

export const stripHomeHtml = (value: string): string =>
  value.split(/(^ {0,3}```[^]*?^ {0,3}```[^\n]*$)/m).map((part, index) => index % 2 === 1 ? part : stripHtml(part)).join("")

const HomePrompt = ({ flow, placeholder, onRunCommand }: {
  readonly flow?: string; readonly placeholder?: string; readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const controller = useController()
  const { data: rows } = useLiveQuery((q) => q.from({ session: controller.store.collections.sessions })
    .select(({ session }) => ({ id: session.id, draft: session.draft })))
  const draft = rows[0]?.draft ?? controller.store.session().draft
  return <ChatComposer
    value={draft}
    onValueChange={controller.changeDraft}
    placeholder={placeholder}
    inputAriaLabel={placeholder ?? "Message"}
    lifecycleStatus={controller.store.session().phase === "responding" ? "submitted" : "ready"}
    submitProps={flowProps("chat.send")}
    onSubmit={() => {
      const text = controller.store.session().draft.trim()
      if (!text) return
      const line = flow ? `/${repositoryFlowName(flow)} ${text}` : text
      if (flow) controller.changeDraft(line)
      onRunCommand("chat.send", line)
    }} />
}

export const RepositoryHomeCard = ({ card, onRunCommand }: {
  readonly card: HomeCard
  readonly onRunCommand: (name: string, args?: string) => void
}) => {
  const { home, flows } = card.payload
  const featuredFlows = flows.filter((flow) => flow.featured)
  if (home.kind === "error") return <p role="alert">{home.message}</p>
  if (home.kind === "none") return null
  if (home.kind === "readme") return <Markdown className="message-markdown" content={stripHomeHtml(home.markdown)} />
  return <div className="factory-home">{home.blocks.map((block, index) => {
    switch (block.type) {
      case "prompt": return <HomePrompt key={index} flow={block.flow} placeholder={block.placeholder}
        onRunCommand={onRunCommand} />
      case "flows": return featuredFlows.length === 0 ? null : <div key={index}>
        {block.title && <h2>{block.title}</h2>}
        <div className="factory-home-row">{featuredFlows.map((flow) => <Button key={flow.id} type="button"
          {...dynamicFlowAction(onRunCommand, repositoryFlowName(flow.id))}>{flow.summary ?? flow.id}</Button>)}</div>
      </div>
      case "markdown": return <div key={index}>{block.title && <h2>{block.title}</h2>}
        <Markdown className="message-markdown" content={stripHomeHtml(block.markdown)} /></div>
      case "text": return <div key={index}>{block.title && <h2>{block.title}</h2>}<p>{block.text}</p></div>
      case "links": return <div key={index}>{block.title && <h2>{block.title}</h2>}
        <div className="factory-home-row">{block.links.map((link) => <a key={link.url} href={link.url}>{link.label}</a>)}</div></div>
    }
  })}</div>
}

export const repositoryHomeCardFamily: CardFamily<"factory.home"> = {
  "factory.home": { render: (card, actions) => <RepositoryHomeCard card={card} onRunCommand={actions.onRunCommand} />, pill: () => "" }
}
