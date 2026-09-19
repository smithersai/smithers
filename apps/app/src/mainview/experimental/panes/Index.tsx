/*
 * Mock: Index. Behind VITE_SMITHERS_EXPERIMENTAL, reached by
 * `/experimental.index`. The one pane that is not a drawing of an
 * abstraction: it is the gallery, so a demo reaches all of them from one
 * screen instead of remembering thirty leaf names.
 *
 * It reads the manifest rather than a list of its own, so a pane added or
 * promoted away changes this pane without editing it — and each row opens its
 * pane through the same flow the slash door runs, which is the only act a
 * mock is allowed to raise. The manifest, not the registry: a gallery that
 * imported every pane's drawing would undo the split that keeps them out of
 * the boot path.
 */
import { pane } from "../Pane"
import { EXPERIMENTAL_MANIFEST } from "../Manifest"
import { Section, Table } from "../Primitives"

export const Pane = pane({
  id: "index",
  title: "Experimental",
  summary: "Every hidden mock, and the abstraction each one draws",
  packages: ["@smthrs/*"],
  render: ({ onRunCommand }) => (
    <Section title="Panes" right={`${EXPERIMENTAL_MANIFEST.length}`}>
      <Table
        columns={[
          { key: "title", label: "Pane" },
          { key: "leaf", label: "Command", mono: true },
          { key: "packages", label: "Packages", mono: true }
        ]}
        rows={EXPERIMENTAL_MANIFEST.filter((entry) => entry.id !== "index").map((entry) => ({
          id: entry.id,
          title: entry.title,
          leaf: `/experimental.${entry.id}`,
          packages: entry.packages.join(" ")
        }))}
        onSelect={(id) => onRunCommand(`experimental.${id}`)}
      />
    </Section>
  )
})
