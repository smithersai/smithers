// The page's one stylesheet: the Smithers theme, @smthrs/ui's component styles (the same CSS smithers.sh's React chat
// uses) and this app's frame.
import { smithersUiCss } from "@smthrs/ui-css"
import { themeCss } from "@smthrs/ui-styleguide"
import appCss from "./styles.css?raw"

export function stylesheet(): string {
  return [themeCss(), smithersUiCss(), appCss].join("\n")
}
