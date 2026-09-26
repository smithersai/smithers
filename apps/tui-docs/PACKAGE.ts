/** Executable TUI docs: Markdown -> cached terminal recordings -> Astro site. */
import { Smithers } from "@smthrs/targets"
import { Package as tui } from "../tui/PACKAGE.ts"
import * as Docs from "./scripts/targets.ts"
const recordings = Docs.recordings(tui.docsFiles, tui.recordingSources)
const build = Docs.site(recordings, tui.docsFiles)
export const Package = Smithers.Package({
  targets: {
    recordings,
    build,
    check: Docs.check(tui.docsFiles),
    test: Docs.test(tui.docsFiles),
    browserTests: Docs.browserTest(build),
    sources: Docs.sourceFiles
  }
})
