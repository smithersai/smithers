import { renderToStaticMarkup } from "react-dom/server"
import { HomeViewFrame } from "./components/HomeViewFrame.tsx"

export function renderHomeViewFrame(flow: string): string {
  return renderToStaticMarkup(<HomeViewFrame flow={flow} onOpen={() => {}} />)
}
