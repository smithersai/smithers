/*
 * The service-log card kind is declared on the wire (@smthrs/rpc Cards.ts) but
 * no host emits it and the chat has never rendered a body for it. The entry
 * keeps the renderer map complete without inventing a surface: the shell
 * renders the header and an empty body, exactly as the switch it replaced did.
 */
import type { CardFamily } from "./CardFamily"
import { defaultPill } from "./CardFamily"

export const serviceLogCardFamily: CardFamily<"service-log"> = {
  "service-log": { render: () => null, pill: defaultPill }
}
