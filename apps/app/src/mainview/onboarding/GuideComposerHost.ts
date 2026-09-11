import { createContext } from "react"

/*
 * Where the summoned composer goes. The guide renders the app full-screen
 * with the composer hidden; Command-K summons ONLY the composer into the
 * top command palette — the chat history stays in the workspace beneath.
 * `undefined` outside the guide (the bare app keeps its docked composer),
 * null until the persistent portal host mounts.
 */
export const GuideComposerHost = createContext<HTMLDivElement | null | undefined>(undefined)
