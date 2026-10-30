import { Button, Table, TableBody, TableCell, TableRow } from "@smthrs/ui"
import { Frame } from "./Frame"
import { Section, type ViewProps } from "./parts"

// Commits: main's newest commits; a commit opens its diff beside the view (`diff/<id>`).
export function Commits({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/commits">
      {(status) => (
        <Section title="Commits" wide>
          <Table aria-label="Commits">
            <TableBody>
              {status.commits.map((commit) => (
                <TableRow key={commit.id} data-commit={commit.id}>
                  <TableCell className="factory-mono">
                    {commit.at === null ? null : new Date(commit.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="link"
                      className="factory-open"
                      onClick={() => tab.actions.read(repository!, "diff", `diff/${commit.id}`, commit.title || commit.id)}
                    >
                      {commit.title || commit.id}
                    </Button>
                    <div className="factory-mono factory-muted">{commit.id} · {commit.author}</div>
                  </TableCell>
                  <TableCell className="factory-muted factory-work">{commit.lane}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </Frame>
  )
}
