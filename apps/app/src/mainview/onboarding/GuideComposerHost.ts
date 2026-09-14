import { createContext } from "react"

/*
 * Where the summoned composer goes. The guide renders the app full-screen
 * with the composer hidden; Command-K summons ONLY the composer into the
 * bottom dock — chat history is projected into the visible guide transcript.
 * `undefined` outside the guide (the bare app keeps its docked composer),
 * null until the persistent portal host mounts.
 */
export const GuideComposerHost = createContext<HTMLDivElement | null | undefined>(undefined)
