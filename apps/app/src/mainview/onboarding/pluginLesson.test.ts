import { expect, test } from "bun:test"
import { initialGuide } from "../state/AppState"
import { GUIDE_STAGES } from "./lessons"
import { LESSON_PLUGIN, LIBRARIAN_LESSON_STEP, libraryOpened, PLUGINS_LESSON_STEP, pluginInstalled } from "./pluginLesson"

const at = (step: number, over: Partial<ReturnType<typeof initialGuide>> = {}) => ({ ...initialGuide(), step, ...over })

test("the Library and Librarian share lesson six, found by its completion signal", () => {
  expect(PLUGINS_LESSON_STEP).toBe(5)
  expect(LIBRARIAN_LESSON_STEP).toBe(5)
  const stage = GUIDE_STAGES[LIBRARIAN_LESSON_STEP]
  expect(stage?.kind === "do" && stage.completion).toBe("librarian")
  /* The copy names the button, never a command to type (apps/app/BUTTONS.md). */
  expect(GUIDE_STAGES[LIBRARIAN_LESSON_STEP]?.message).not.toContain("/")
})

test("opening the Library finishes its lesson and tucks the conversation away", () => {
  const advanced = libraryOpened(at(PLUGINS_LESSON_STEP, { conversationOpen: true }))
  expect(advanced?.library).toBe(true)
  expect(advanced?.step).toBe(PLUGINS_LESSON_STEP)
  expect(advanced?.completed).toContain("library")
  expect(advanced?.conversationOpen).toBe(false)
})

test("opening the Library anywhere else is just a flow", () => {
  expect(libraryOpened(at(0))).toBeUndefined()
  expect(libraryOpened(at(PLUGINS_LESSON_STEP, { library: true }))).toBeUndefined()
})

test("the lesson's plugin advances the librarian lesson; another plugin does not", () => {
  const guide = at(LIBRARIAN_LESSON_STEP, { library: true })
  expect(pluginInstalled(guide, LESSON_PLUGIN)?.step).toBe(LIBRARIAN_LESSON_STEP)
  expect(pluginInstalled(guide, LESSON_PLUGIN)?.completed).toContain("librarian")
  expect(pluginInstalled(guide, LESSON_PLUGIN)?.librarian).toBe(true)
  expect(pluginInstalled(guide, "dispatcher")).toBeUndefined()
  // Migrated readers may not have reached the old Library opening yet.
  expect(pluginInstalled(at(LIBRARIAN_LESSON_STEP), LESSON_PLUGIN)?.completed).toContain("librarian")
})
