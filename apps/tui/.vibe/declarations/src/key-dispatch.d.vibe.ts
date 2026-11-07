/**
 * Key handling by layer. The app's `handleKey` tries the layers in the order
 * `keys.ts` documents for its contexts; each layer here sees only its own
 * state and the acts it may take. Every key a layer compares is registered
 * in `keys.ts` (see `test/keys.test.ts`).
 */
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import * as Form from "@smthrs/ui/flow-form";
import type { Schema } from "effect";
import type * as Activity from "./activity.vibe";
import type * as Complete from "../../../src/complete.ts";
import type * as Editor from "../../../src/editor.ts";
import type * as Extension from "../../../src/extension.ts";
import * as Keys from "../../../src/keys.ts";
import * as Panels from "./panels.vibe";
import type * as Subagents from "../../../src/subagents.ts";
import * as Tabs from "../../../src/tabs.ts";
import type { Tab } from "../../../src/workspace.ts";
/** A flow run's inline form for its missing input, or the answer form for a worker's ask. */
export interface FlowForm {
    readonly id: string;
    readonly flow: string;
    readonly fields: ReadonlyArray<Form.FormField>;
    readonly draft: Record<string, Form.FieldValue>;
    readonly focus: number;
    readonly error?: string;
    /** An ask: its whole question, one choice per line, `other…` last; `draft.answer` holds typed words. */
    readonly ask?: AskChoices;
}
/** An ask's choices and the one under the cursor; without options the answer is typed. */
export interface AskChoices {
    readonly question: string;
    readonly options: ReadonlyArray<string>;
    /** Index into `options`; `options.length` is `other…`, where the answer is typed. */
    readonly choice: number;
    /**
     * Until then, unless the cursor moved, numbers wait, as does enter in a
     * deliberately opened form: keys typed ahead are not an answer.
     */
    readonly armedAt: number;
    /** An arrow or tab selected the answer input or moved the cursor. */
    readonly moved?: true;
    /** The chat key that opened the form; until answer selection, typing returns it to the chat. */
    readonly lead?: string;
}
/** The answer form's lines under the question: the options, then `other…`; none when the answer is typed. */
export declare const choices: (ask: AskChoices) => ReadonlyArray<string>;
/** Whether the answer is typed here: no options, or `other…` chosen. */
export declare const typed: (ask: AskChoices) => boolean;
/** The answer the form would send now, or undefined while a typed one is blank. */
export declare const answerOf: (ask: AskChoices, draft: FlowForm["draft"]) => string | undefined;
/** Which keys act right now, in the order `handleKey` tries them. */
export declare const context: (state: {
    /** The undo checklist is open. */
    readonly checklist: boolean;
    readonly picker: boolean;
    /** A run's full-height diff shows. */
    readonly review: boolean;
    readonly inspecting: boolean;
    readonly form: boolean;
    readonly approvals: boolean;
    /** The composer is empty. */
    readonly empty: boolean;
    /** A panel shows and has the keys. */
    readonly panel: boolean;
    /** The Summary overview has the keys: its tree, or a branch's cards. */
    readonly overview: boolean;
    readonly completion: boolean;
    readonly card: boolean;
    /** A `!` command runs, or the draft starts with `!`. */
    readonly shell: boolean;
    readonly turn: boolean;
}) => Keys.KeyContext;
/** The terminal parser emits one Unicode code point per text key, not one UTF-16 unit. */
export declare const typing: (key: KeyEvent) => string | undefined;
/**
 * The `?` popup. Page keys scroll it; esc and `?` close it, a listed key then
 * acts, and other typing becomes `?` plus that character, so a message that
 * starts with `?` is never lost. True when the key was consumed.
 */
export declare const whichKeyKey: (key: KeyEvent, binding: Keys.Binding | undefined, act: {
    readonly close: () => void;
    readonly type: (text: string) => void;
    readonly scroll: (direction: -1 | 1) => void;
}) => boolean;
/** The activity scrubber while a step is selected; true when the key was consumed. */
export declare const scrubberKey: (key: KeyEvent, activity: Activity.Activity, seq: number, act: {
    readonly follow: () => void;
    readonly inspect: (seq: number) => void;
}) => boolean;
/**
 * A focused chat card: enter opens it, esc leaves it, arrows and tab move
 * between cards. On a subagent card, `a` answers the ask it shows `a Answer`
 * for, `d` its run's diff, `u` undoes the run, and the
 * worker keys act on its worker. Anything else unfocuses it and goes on to
 * the composer; false then.
 */
export declare const cardKey: (key: KeyEvent, act: {
    readonly move: (direction: Subagents.Direction) => void;
    readonly leave: () => void;
    readonly open: () => void;
    /** The focused subagent card's worker; undefined on a panel card. */
    readonly worker: Tab | undefined;
    readonly workerAction: (tab: Tab, action: Tabs.ActionId) => void;
    /** Present only when the worker settled with captured changes. */
    readonly diff?: (() => void) | undefined;
    /** Present only when those changes can be undone now. */
    readonly undo?: (() => void) | undefined;
    /** Present only when the card shows `a Answer`: opens its ask's answer form. */
    readonly answer?: (() => void) | undefined;
}) => boolean;
/**
 * The Summary overview: arrows or hjkl move in the pane (right leaves the
 * tree), enter opens, esc closes; `app.tsx` switches panes with tab. The
 * worker keys act on the selected worker, `x` stops a selected monitor;
 * `d` and `u` show and undo its run.
 */
export declare const overviewKey: (key: KeyEvent, state: {
    readonly pane: "tree" | "cards";
    /** The worker the keys act on: the tree's selection, or the focused card's. */
    readonly worker: Tab | undefined;
    /** The selected monitor's id. */
    readonly monitor?: string | undefined;
    readonly run?: string | undefined;
}, act: {
    readonly close: () => void;
    readonly stopMonitor: (id: string) => void;
    readonly stopRun?: (id: string) => void;
    readonly release: () => void;
    readonly pane: () => void;
    readonly tree: (step: -1 | 1) => void;
    readonly peek: () => void;
    /** `a`: the selected row's form, when it waits on the person. */
    readonly answer: () => void;
    /** `g`: the graph of the selected row's run forest, or back to the tree. */
    readonly graph: () => void;
    readonly card: (direction: Subagents.Direction) => void;
    readonly open: () => void;
    readonly scroll: (direction: number) => void;
    readonly workerAction: (tab: Tab, action: Tabs.ActionId) => void;
    /** `d`: the selected worker's run diff, when it settled with captured changes. */
    readonly diff?: (() => void) | undefined;
    /** `u`: undo the selected worker's run, when it can be undone now. */
    readonly undo?: (() => void) | undefined;
    /** `y` and `n`: approve or deny the selected build target. */
    readonly decideTarget?: ((decision: "approve" | "deny") => void) | undefined;
}) => void;
/** Keys while a flow form is open; its focused input takes the typing. */
export declare const formKey: (key: KeyEvent, open: FlowForm, act: {
    readonly change: (next: FlowForm | undefined) => void;
    readonly schema: (id: string) => Schema.Top | undefined;
    readonly input: (id: string) => Record<string, unknown> | undefined;
    readonly fill: (id: string, payload: Record<string, unknown>) => void;
    /** Puts `text` in the chat composer. */
    readonly chat: (text: string) => void;
}) => void;
/** A run's full-height diff: `u` undoes the run, esc goes back, arrows and page keys scroll. Takes every key. */
export declare const reviewKey: (key: KeyEvent, act: {
    /** Present only when the run can be undone now. */
    readonly undo: (() => void) | undefined;
    readonly close: () => void;
    /** Lines, or a half page with `page`. */
    readonly scroll: (by: number, page: boolean) => void;
}) => void;
/** The undo checklist: arrows move, space checks a file, enter undoes the checked ones, esc goes back. */
export declare const checklistKey: (key: KeyEvent, state: {
    readonly rows: number;
}, act: {
    readonly close: () => void;
    readonly select: (update: (selected: number) => number) => void;
    readonly toggle: () => void;
    readonly undo: () => void;
}) => void;
/** Keys while a dialog is open: its filter input takes the typing, these move and pick. */
export declare const dialogKey: (key: KeyEvent, open: {
    readonly kind: string;
    readonly selected: number;
}, state: {
    readonly rows: number;
    /** The composer still has focus: the dialog's input has not mounted yet. */
    readonly composerFocused: boolean;
}, act: {
    readonly close: () => void;
    readonly select: (update: (selected: number) => number) => void;
    readonly type: (text: string) => void;
    /** Picks the row at `index`, if there is one. */
    readonly pick: (index: number) => void;
}) => void;
/** Keys while the completion menu is open; true when the menu took the key. */
export declare const menuKey: (key: KeyEvent, open: Complete.Completion, act: {
    readonly select: (update: (index: number) => number) => void;
    readonly dismiss: () => void;
    /** Inserts the selected item; `run` also submits a whole command. */
    readonly accept: (run: boolean) => void;
}) => boolean;
/** Keys while a panel has focus. Worker letters are handled by the composer first. */
export declare const panelKey: (key: KeyEvent, panel: Panels.Panel, state: {
    readonly surface: string;
    readonly navigation: Panels.Navigation;
    /** The shown worker tab, whose actions are its own keys. */
    readonly worker: Tab | undefined;
    readonly flow: {
        readonly retry: boolean;
        readonly continue: boolean;
        readonly stop: boolean;
    };
}, act: {
    /** Back to the chat. */
    readonly close: () => void;
    /** Keys back to the composer, the panel still shown. */
    readonly release: () => void;
    readonly retryRun: (id: string) => void;
    /** Approves a parked run's open request and resumes it. */
    readonly continueRun: (id: string) => void;
    readonly cancelRun: (id: string) => void;
    readonly fillRun: (id: string) => void;
    /** Undo the chat turn of the selected Summary row. */
    readonly undo: (row: Panels.Row | undefined) => void;
    readonly scroll: (direction: number) => void;
    readonly navigate: (update: (current: Panels.Navigation) => Panels.Navigation) => void;
    /** An agent-written prompt, sent as text. */
    readonly send: (prompt: string) => void;
    readonly perform: (action: Extension.Action) => void;
}) => void;
/** The composer's own keys, once no dialog, menu or panel took the key. */
export declare const composerKey: (key: KeyEvent, state: {
    readonly text: string;
    readonly steering: boolean;
    readonly turn: {
        readonly stop: () => void;
    } | undefined;
    readonly shell: {
        readonly cancel: () => void;
    } | undefined;
    readonly history: Editor.History;
    readonly scroll: ScrollBoxRenderable | null;
}, act: {
    /** Back to the steered worker's tab. */
    readonly stopSteering: () => void;
    readonly setText: (text: string) => void;
    readonly quit: () => void;
    readonly submit: (followUp: boolean) => void;
    readonly restoreQueued: () => void;
    readonly pickModel: () => void;
    readonly cycleModel: (step: number) => void;
    readonly toggleExpanded: () => void;
    readonly externalEditor: () => void;
}) => void;
