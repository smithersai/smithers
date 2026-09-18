import { Badge, Button } from "@smthrs/ui"
import { BookOpen, Box, Check, Compass, Factory, History, KeyRound, Library, Puzzle, RadioTower } from "lucide-react"
import type { ReactNode } from "react"
import { shelfOrder } from "./catalog"
import type { PluginIcon, PluginManifest } from "./AppPlugin"
import { flowProps } from "../flows/FlowAction"

/*
 * The Library: the shelf a person browses before this workspace can do
 * something new.
 *
 * The grammar is an extension store's, the one ConnectorsSurface already
 * uses here: a row is an icon, a name, ONE line, and ONE action. What a
 * store adds on top is the reason to trust the row — who publishes it, what
 * it adds, what to do once it is installed — so the recommended rows carry
 * their description and their first steps, and the rest stay one line.
 *
 * The component is presentational on purpose: it renders the catalog and
 * calls back. Both binding sites (the Library pane and the guided
 * introduction) bind those callbacks to the SAME registered flows, so the
 * button, the slash command and the agent's ask are one act.
 */

const GLYPHS: Readonly<Record<PluginIcon, ReactNode>> = {
  "book-open": <BookOpen size={20} aria-hidden="true" />,
  history: <History size={20} aria-hidden="true" />,
  library: <Library size={20} aria-hidden="true" />,
  "radio-tower": <RadioTower size={20} aria-hidden="true" />,
  "key-round": <KeyRound size={20} aria-hidden="true" />,
  box: <Box size={20} aria-hidden="true" />,
  factory: <Factory size={20} aria-hidden="true" />,
  compass: <Compass size={20} aria-hidden="true" />,
  puzzle: <Puzzle size={20} aria-hidden="true" />
}

/** The plugins the catalog recommends, in the rank it states. */
const recommended = (shelf: ReadonlyArray<PluginManifest>): ReadonlyArray<PluginManifest> =>
  shelf.filter((manifest) => manifest.recommended !== undefined)

export interface PluginGalleryProps {
  /** The ids on this workspace's shelf. */
  readonly installed: ReadonlyArray<string>
  /** Bound by the caller to `plugins.install`. */
  readonly onInstall: (id: string) => void
  /** Bound by the caller to `plugins.remove`; absent while a lesson is running. */
  readonly onRemove?: (id: string) => void
  /**
   * The plugin the reader was asked to install (the guided introduction's
   * lesson). It leads the shelf and says so; everywhere else nothing is
   * singled out.
   */
  readonly asked?: string
}

export function PluginGallery({ installed, onInstall, onRemove, asked }: PluginGalleryProps) {
  const shelf = shelfOrder().map((plugin) => plugin.manifest).filter((manifest) => asked === undefined || manifest.id === asked)
  const lead = recommended(shelf)
  return (
    <div className="plugin-gallery">
      {/*
        * What to install first, said in words rather than implied by the
        * order: a shelf a person meets for the first time needs a reading
        * order more than it needs a filter.
        */}
      {asked === undefined && <section className="plugin-start" aria-label="Where to start">
        <h2>Start here</h2>
        <ol>
          {lead.map((manifest) => (
            <li key={manifest.id} data-installed={installed.includes(manifest.id)}>
              <strong>{manifest.name}</strong>
              <span>{manifest.gettingStarted[0] ?? manifest.summary}</span>
            </li>
          ))}
        </ol>
        <p>
          {shelf.length} plugins on the shelf. Everything a plugin adds is a flow you can also type,
          and removing one takes its flows back off the workspace.
        </p>
      </section>}

      <section className="plugin-shelf" aria-label="Plugins">
        {shelf.map((manifest) => {
          const isInstalled = installed.includes(manifest.id)
          const missing = (manifest.dependsOn ?? []).filter((required) => !installed.includes(required))
          return (
            <article
              key={manifest.id}
              className="plugin-card"
              data-plugin={manifest.id}
              data-installed={isInstalled}
              data-asked={asked === manifest.id}
              data-recommended={manifest.recommended !== undefined}
            >
              <div className="plugin-icon">{GLYPHS[manifest.icon]}</div>
              <div className="plugin-body">
                <h3>
                  {manifest.name}
                  <span className="plugin-publisher">{manifest.publisher}</span>
                  {asked !== undefined || manifest.recommended === undefined ? null : <Badge variant="outline">Recommended</Badge>}
                </h3>
                <p className="plugin-summary">{manifest.summary}</p>
                {manifest.recommended === undefined ? null : (
                  <p className="plugin-description">{manifest.description}</p>
                )}
                <ul className="plugin-tags" aria-label={`${manifest.name} tags`}>
                  {manifest.tags.map((tag) => <li key={tag}>{tag}</li>)}
                </ul>
                {isInstalled ? (
                  <ol className="plugin-steps" aria-label={`First steps with ${manifest.name}`}>
                    {manifest.gettingStarted.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                ) : missing.length === 0 ? null : (
                  <p className="plugin-requires">Installs {missing.join(", ")} with it.</p>
                )}
              </div>
              <div className="plugin-action">
                {isInstalled ?
                  (
                    <>
                      <span className="plugin-installed">
                        <Check size={14} aria-hidden="true" />
                        Installed
                      </span>
                      {onRemove === undefined ?
                        null :
                        (
                          <Button
                            variant="ghost"
                            size="sm"
                            {...flowProps("plugins.remove")}
                            data-testid={`plugin-remove-${manifest.id}`}
                            onClick={() => onRemove(manifest.id)}
                          >
                            Remove
                          </Button>
                        )}
                    </>
                  ) :
                  (
                    <Button
                      size="sm"
                      {...flowProps("plugins.install")}
                      data-testid={`plugin-install-${manifest.id}`}
                      aria-label={`Install the ${manifest.name}`}
                      onClick={() => onInstall(manifest.id)}
                    >
                      Install
                    </Button>
                  )}
                <span className="plugin-version">v{manifest.version}</span>
              </div>
            </article>
          )
        })}
      </section>
    </div>
  )
}
