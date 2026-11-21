import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Eyebrow,
  Kbd,
  Progress,
  StageStrip,
  StatusPill,
} from "@smthrs/ui"
import { useSyncExternalStore } from "react"
import { STOPS } from "../model"
import type { TourTab } from "../tab"
import "./tour.css"

// Full-screen interactive Smithers walkthrough (/app/tour). Driven by the tour tab and the host keymap (←/→, j/k).
export function Tour({ tab }: { readonly tab: TourTab }) {
  const state = useSyncExternalStore(tab.queries.state.subscribe, tab.queries.state.current)
  const { stop, activeChoice } = state

  return (
    <section className="tour" aria-label="Smithers guided tour" data-stop={stop.id}>
      <div className="tour-top">
        <Eyebrow>{`${state.index + 1} of ${state.total} · ${stop.eyebrow}`}</Eyebrow>
        <div className="tour-keys" aria-label="Keyboard shortcuts">
          <Kbd>←</Kbd>
          <Kbd>→</Kbd>
          <span>Navigate</span>
        </div>
      </div>

      <Progress value={state.percent} aria-label="Tour progress" />

      <nav className="tour-steps" aria-label="Tour stops">
        {STOPS.map((item, idx) => (
          <Button
            key={item.id}
            size="sm"
            variant={idx === state.index ? "solid" : "ghost"}
            aria-current={idx === state.index ? "step" : undefined}
            onClick={() => tab.actions.select(idx)}
          >
            {`${idx + 1}. ${item.title.split(" ")[0]}`}
          </Button>
        ))}
      </nav>

      <Card>
        <CardHeader>
          <div className="tour-card-header">
            <div>
              <CardTitle>{stop.title}</CardTitle>
              <p className="tour-subtitle">{stop.subtitle}</p>
            </div>
            <Kbd>{stop.shortcut}</Kbd>
          </div>
        </CardHeader>

        <CardContent className="tour-body">
          {stop.stages === undefined ? null : (
            <StageStrip
              stages={stop.stages.map((stage) => ({
                label: stage.label,
                status: stage.status,
              }))}
            />
          )}

          <div className="tour-choices" role="group" aria-label="Interactive preview options">
            {stop.choices.map((choice) => (
              <Button
                key={choice.id}
                size="sm"
                variant={choice.id === activeChoice.id ? "solid" : "outline"}
                aria-pressed={choice.id === activeChoice.id}
                onClick={() => tab.actions.choose(choice.id)}
              >
                {choice.label}
              </Button>
            ))}
          </div>

          <div className="tour-preview" role="region" aria-label="Preview">
            <div className="tour-preview-head">
              {activeChoice.badge === undefined ? <span /> : <Badge variant="muted">{activeChoice.badge}</Badge>}
              <StatusPill status={activeChoice.status} />
            </div>
            <p className="tour-preview-text">{activeChoice.preview}</p>
          </div>
        </CardContent>

        <CardFooter className="tour-footer">
          <div className="tour-nav">
            <Button variant="outline" size="sm" disabled={!state.hasPrevious} onClick={tab.actions.previous}>
              Previous
            </Button>
            {state.hasNext ? (
              <Button variant="solid" size="sm" onClick={tab.actions.next}>
                Next
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={tab.actions.restart}>
                Restart tour
              </Button>
            )}
          </div>

          <div className="tour-nav">
            {stop.action === undefined ? null : (
              <Button variant="solid" size="sm" onClick={() => tab.actions.go(stop.action!.to)}>
                {stop.action.label}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => tab.actions.go("/app")}>
              Open Smithers
            </Button>
          </div>
        </CardFooter>
      </Card>
    </section>
  )
}
