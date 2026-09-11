import { defineTools } from "@smthrs/create-app/app"
import { ui } from "./tools/ui.ts"

// The root tool layer: the FlowBinding sources every flow below this directory
// reaches as ctx.call("<source>/<flow>", input). The ui bindings declare no
// capability, so the grant is empty; grant what a tool you add declares.
export const Tools = defineTools({ sources: [ui], grant: [] })
