import { expect, test } from "vitest"
import { router } from "../../router"
import { FlowPendingScreen } from "./FlowPendingScreen"

// A flow's editor routes wait on device storage and the engine in `beforeLoad`; without a pending screen a direct
// visit painted a blank window for seconds (docs/work/ui-polish.md). Each keeps its frame while it waits.
test.each(["/app/flows/new", "/app/flows/drafts/$draftId", "/app/flows/code/$name"] as const)(
  "%s shows the flow pending screen while it opens",
  (id) => {
    expect(router.routesById[id].options.pendingComponent).toBe(FlowPendingScreen)
  },
)
