import { mediaOf } from "../model"
import { Frame } from "./Frame"
import { Pill, Section, type ViewProps } from "./parts"

// Media: the videos and assets the factory made, newest first, with what each is. Playing them needs blob storage, a
// later slice of decision 0126.
export function Media({ tab, repository }: ViewProps) {
  return (
    <Frame tab={tab} repository={repository} view="factory/media">
      {(status) => (
        <Section title="Media" wide>
          {mediaOf(status).map((item) => (
            <article key={item.file} className="factory-item" aria-label={item.title}>
              <div className="factory-item-header">
                <b>{item.title}</b> <Pill tone="muted">{item.kind}</Pill> <span className="factory-muted">{item.updated}</span>
              </div>
              <p className="factory-muted">{item.description}</p>
            </article>
          ))}
        </Section>
      )}
    </Frame>
  )
}
