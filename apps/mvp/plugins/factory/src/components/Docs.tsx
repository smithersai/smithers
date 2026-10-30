import { Button } from "@smthrs/ui"
import { Frame } from "./Frame"
import { Section, type ViewProps } from "./parts"

// Docs: the repository's own docs pane, one press away.
export function Docs({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/docs">
      {() => (
        <Section title="Docs" wide>
          <Button onClick={() => tab.actions.go("factory/docs", `/${repository!.owner}/${repository!.name}/docs`)}>Open docs</Button>
        </Section>
      )}
    </Frame>
  )
}
