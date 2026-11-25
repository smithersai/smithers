import { renderToStaticMarkup } from "react-dom/server"
import { WaitlistPrompt, type WaitlistPromptProps } from "./WaitlistPrompt.tsx"

export function renderWaitlistPrompt(props: WaitlistPromptProps): string {
  return renderToStaticMarkup(<WaitlistPrompt {...props} />)
}
