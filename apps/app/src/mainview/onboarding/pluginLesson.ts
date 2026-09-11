/*
 * The lesson the plugin shelf owns, and what it advances on.
 *
 * The guided introduction teaches plugins with the REAL flows: the lesson is
 * finished by opening the Library and installing from it, not by a
 * tutorial-only button. So the plugins controller has to know which lesson a
 * person is standing in, and the guide controller has to agree with it — this
 * module is the one place that decides, and both read it.
 *
 * The step number is derived from the stage table's completion signal rather
 * than written down (or read out of the prose, which the button copy no longer
 * carries), because lessons get inserted and removed and a renumbering must
 * not silently point this at the wrong lesson. `pluginLesson.test.ts` pins
 * that the lesson is still found in its intended position.
 */
import { completeGuide } from "./completion"
import { GUIDE_STAGES } from "./lessons"
import type { GuideState } from "../state/AppState"

/** The lesson that installs the Librarian from the Library; opening it is the same lesson. */
export const LIBRARIAN_LESSON_STEP = GUIDE_STAGES.findIndex((stage) => stage.kind === "do" && stage.completion === "librarian")

/** The Library opens inside that same lesson. */
export const PLUGINS_LESSON_STEP = LIBRARIAN_LESSON_STEP

/** The plugin the librarian lesson installs; installing it finishes the lesson. */
export const LESSON_PLUGIN = "librarian"

/**
 * The guide after the Library was opened during its lesson, or undefined when
 * the reader is somewhere else and the flow is just a flow.
 */
export const libraryOpened = (guide: GuideState): GuideState | undefined =>
  guide.step === PLUGINS_LESSON_STEP && !guide.library
    ? { ...completeGuide(guide, "library"), library: true, conversationOpen: false }
    : undefined

/** The guide after the lesson's plugin was installed, or undefined otherwise. */
export const pluginInstalled = (guide: GuideState, id: string): GuideState | undefined =>
  id === LESSON_PLUGIN && guide.step === LIBRARIAN_LESSON_STEP && !guide.completed?.includes("librarian")
    ? { ...completeGuide(guide, "librarian"), library: true, librarian: true }
    : undefined
