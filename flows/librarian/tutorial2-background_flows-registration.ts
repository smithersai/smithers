import { Layer } from "effect"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Wiki, registration as wikiRegistration, type WikiReceipt } from "./wiki/flow.ts"
import { History, registration as historyRegistration } from "./history/flow.ts"

/** Supply to the workspace host's NodeControl.layer(config, modules).
 * root is selected by the authenticated host, never a browser-supplied path.
 * persistWiki must upsert revision-scoped pages in the host's durable Wiki authority.
 */
export const librarianModules = (root: string, persistWiki: (receipt: WikiReceipt) => Promise<void>) =>
  Executable.layer({ delegates: [Wiki, History] }).pipe(
    Layer.provideMerge(wikiRegistration(root, persistWiki)),
    Layer.provideMerge(historyRegistration(root)),
    Layer.provide(Registry.layerProject({ root })),
    Layer.orDie
  )
