import { Context, Effect, Layer } from "effect"
import { runners } from "../../boundary"
import type { FlowDispatch } from "../../flows/dispatch"
import type { RunsNavigation } from "../runs/actions"
import {
  answer,
  deleteDraft,
  draftAgain,
  edit,
  editCode,
  openCode,
  openDraft,
  openNew,
  remove,
  run,
  save,
  saveCode,
  setAnswer,
  setForm,
  startDraft,
} from "./actions"
import { FlowsUiStore } from "./store"

// Your own flows as a frontend sees them (docs/features/flows.md#the-browser): live queries to read and plain functions
// to act, with no Effect in sight. The routes' loaders call `openNew` and `openDraft`.

type Store = FlowsUiStore["Service"]

/**
 * What a frontend reads live: the person's flows and drafts, the form, the shown draft, the unsent answers, the code it
 * shows, and whether the editors may write.
 */
export interface FlowsUiQueries {
  readonly flows: Store["flowList"]["tanstack"]
  readonly drafts: Store["draftList"]["tanstack"]
  readonly form: Store["formRow"]["tanstack"]
  readonly draft: Store["draft"]["tanstack"]
  readonly answers: Store["answerList"]["tanstack"]
  readonly code: Store["codeRow"]["tanstack"]
  /** The shown draft's round on this device's engine. */
  readonly round: Store["roundRow"]["tanstack"]
  /** Whether the editors may write: `restoring`, `available` or `unavailable` (src/features/flows-ui/store.ts `Editor`). */
  readonly editor: Store["editorRow"]["tanstack"]
}

/** What a person does, as plain functions. Each returns at once, or with a promise a route loader awaits. */
export interface FlowsUiActions {
  readonly openNew: (name: string | undefined) => Promise<void>
  readonly openDraft: (draftId: string) => Promise<void>
  readonly openCode: (name: string) => Promise<void>
  readonly setName: (name: string) => void
  readonly setRequest: (request: string) => void
  readonly startDraft: () => void
  readonly setAnswer: (draftId: string, questionId: string, value: string) => void
  readonly answer: () => void
  readonly draftAgain: () => void
  readonly deleteDraft: (draftId: string) => void
  readonly save: () => void
  readonly editCode: (name: string, text: string) => void
  readonly saveCode: (confirmStale?: boolean) => Promise<void>
  readonly run: (name: string, revision: number) => void
  readonly edit: (name: string) => void
  readonly remove: (flowId: string) => void
}

type Services = FlowsUiStore | FlowDispatch | RunsNavigation

export class FlowsUi extends Context.Service<
  FlowsUi,
  { readonly queries: FlowsUiQueries; readonly actions: FlowsUiActions }
>()("@smthrs/mvp/flows/FlowsUi") {
  /** Binds the store's queries and the actions, run with the services this layer was built with. */
  static readonly layer = Layer.effect(
    FlowsUi,
    Effect.gen(function* () {
      const store = yield* FlowsUiStore
      const context = yield* Effect.context<Services>()
      const { runPromise: promise, runFork } = runners(context, "flows")
      const fork = (effect: Effect.Effect<void, never, Services>) => void runFork(effect)
      const editor = (effect: Effect.Effect<void, never, Services>): Promise<void> => {
        return promise(effect)
      }
      const changeForm = (fields: Parameters<typeof setForm>[0]) => {
        const current = store.formRow.tanstack.toArray[0]
        const token = current === undefined ? undefined : store.formSnapshot?.stage({ ...current, ...fields })
        void editor(setForm(fields)).then(() => {
          if (token !== undefined) store.formSnapshot!.acknowledge(token)
        }, () => undefined)
      }
      return FlowsUi.of({
        queries: {
          flows: store.flowList.tanstack,
          drafts: store.draftList.tanstack,
          form: store.formRow.tanstack,
          draft: store.draft.tanstack,
          answers: store.answerList.tanstack,
          code: store.codeRow.tanstack,
          round: store.roundRow.tanstack,
          editor: store.editorRow.tanstack,
        },
        actions: {
          openNew: (name) => editor(openNew(name)),
          openDraft: (draftId) => promise(openDraft(draftId)),
          openCode: (name) => editor(openCode(name)),
          setName: (name) => changeForm({ name, seeded: false }),
          setRequest: (request) => changeForm({ request }),
          startDraft: () => void editor(startDraft),
          setAnswer: (draftId, questionId, value) => void editor(setAnswer(draftId, questionId, value)),
          answer: () => void editor(answer),
          draftAgain: () => fork(draftAgain),
          deleteDraft: (draftId) => fork(deleteDraft(draftId)),
          save: () => fork(save),
          editCode: (name, text) => {
            const epoch = store.codeEpoch.current
            void editor(editCode(name, text, epoch))
          },
          saveCode: (confirmStale) => editor(saveCode(confirmStale)),
          run: (name, revision) => fork(run(name, revision)),
          edit: (name) => fork(edit(name)),
          remove: (flowId) => fork(remove(flowId)),
        },
      })
    }),
  )
}

/** The flows layer's value: what frontends get. */
export type FlowsUiView = FlowsUi["Service"]
