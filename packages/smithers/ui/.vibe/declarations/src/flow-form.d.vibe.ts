import type { Schema } from "effect";
/** Reuse Effect's importer; unsupported declarations keep their existing JSON launch path. */
export declare const declaredInput: (document: unknown) => Schema.Top | undefined;
export type FieldKind = "text" | "textarea" | "number" | "boolean" | "select" | "write-only";
/**
 * The seams a select may draw its options from (NO INVENTION: an option is a
 * fact a seam reported, never a guess). Resolved by controller/forms.ts.
 */
export declare const OPTION_PROVIDERS: readonly [
/** Smithers Cloud repositories the session has loaded. */
"cloud-repos", 
/** Bookmarks loaded onto a branches card. */
"bookmarks", 
/** Cloud workspaces the session has loaded. */
"workspaces", 
/** The plugin catalog, with the ones already on this workspace's shelf marked. */
"plugins", 
/** The selected repository's real files, read from the file seam at render. */
"files", 
/** The configured models; with a seat in the draft, only the ones that seat takes. */
"models", 
/** The credential NAMES the host listed on the Models card. Never a value. */
"credentials", 
/** The seats the host listed on the Models card. */
"seats", 
/** The target repository's open issues (the Fix an issue app's picker). */
"issues", 
/** The target repository's open pull requests (the Review a PR app's picker). */
"pull-requests", 
/** The flows the target repository declares (`.smithers/factory.json`). */
"repository-flows"];
export type OptionProvider = (typeof OPTION_PROVIDERS)[number];
export interface FieldOption {
    readonly value: string;
    readonly label: string;
    /** The human cannot pick it; `reason` says why (not installed, no credential). */
    readonly disabled?: boolean;
    readonly reason?: string;
}
/** What a flow may say about one of its fields beyond what the schema already says. */
export interface FieldHint {
    /** Internal optional routing data supplied by an action, never asked of the person. */
    readonly hidden?: boolean;
    readonly label?: string;
    readonly placeholder?: string;
    readonly optionsFrom?: OptionProvider;
    /** Overrides the derived control (a provider-fed field that must stay free text keeps `text` and gets a datalist). */
    readonly kind?: FieldKind;
    /** Overrides the schema's requiredness (a schema-required string the grammar accepts blank). */
    readonly required?: boolean;
}
/** A flow's `form` declaration: per-field hints, and the two grammar inverses when the positional default is wrong. */
export interface FormHints {
    readonly submitLabel?: string;
    readonly fields?: Readonly<Record<string, FieldHint>>;
    /** The filled payload back to the one slash line the flow's grammar parses. */
    readonly args?: (payload: Readonly<Record<string, unknown>>) => string;
    /** What a slash line that failed to parse still gave, by field. */
    readonly partial?: (args: string) => Readonly<Record<string, unknown>>;
    /**
     * The flow's OWN rule over what the invocation already named, stated on the
     * card before the form asks for the rest.
     *
     * A value the line carried is the same value the field carries, so it earns
     * the same refusal — `/triggers.register --tokens 500000` reached the Tokens
     * field and was told nothing, while 500000 typed into that field and
     * prepared was refused with the range (walk W1). The sentence is the rule's
     * own: a door routes here, it never writes a second copy of the copy.
     */
    readonly refuse?: (payload: Readonly<Record<string, unknown>>) => string | undefined;
    /**
     * The optional fields what the invocation already named makes required
     * (a setup step that needs its own inputs). The form then asks for those
     * that are missing, and only those.
     */
    readonly requires?: (payload: Readonly<Record<string, unknown>>) => ReadonlyArray<string> | undefined;
    /** Optional controls to retain when a variant asks only for missing required inputs. */
    readonly optionalFields?: (payload: Readonly<Record<string, unknown>>) => ReadonlyArray<string>;
}
export interface FormField {
    readonly name: string;
    readonly label: string;
    readonly kind: FieldKind;
    readonly required: boolean;
    readonly placeholder?: string;
    readonly disabledReason?: string;
    readonly options?: ReadonlyArray<FieldOption>;
    readonly optionsFrom?: OptionProvider;
}
/** One field's value as the draft holds it. */
export type FieldValue = string | number | boolean;
export type FormDraft = Readonly<Record<string, FieldValue>>;
/** Array text follows the flow grammar: command lists use words, file payloads use JSON.
 * @category models
 * @since 0.1.0
 */
export type ArrayEncoding = "words" | "json";
/** A payload value as trimmed text for an assembler; undefined when absent or blank. */
export declare const text: (payload: Readonly<Record<string, unknown>>, key: string) => string | undefined;
/** `--name value` when the value is present, for the flag grammars. */
export declare const flag: (payload: Readonly<Record<string, unknown>>, key: string, name?: string) => string | undefined;
/** The present parts as one slash line. */
export declare const line: (...parts: ReadonlyArray<string | undefined>) => string;
/** "runId" → "Run id", "confirmName" → "Confirm name". */
export declare const humanize: (name: string) => string;
export declare const formFieldsFor: (input: Schema.Top, hints?: FormHints | undefined, payload?: Readonly<Record<string, unknown>>) => ReadonlyArray<FormField>;
/** What the positional read made of a line the grammar refused. */
export interface PositionalRead {
    /** The values it placed, by field. */
    readonly payload: Readonly<Record<string, unknown>>;
    /**
     * The optional slots it passed over so the required slots behind them could
     * have the tokens that were left — the fields the line never named.
     */
    readonly skipped: ReadonlyArray<string>;
}
/**
 * What a slash line that did not parse still gave, by field: the tokens fill
 * the non-boolean fields positionally in schema order, a `--flag` ends the
 * positional read, a token that is not a number ends it at a number field,
 * and whatever is left over rides the last text field filled (the grammars
 * take "the rest of the line" for their last text). A flow whose grammar is
 * not positional supplies its own `partial`.
 *
 * Which slot a token lands in is decided by the declaration, not by position
 * alone: an OPTIONAL slot only takes a token the required slots behind it can
 * spare. `/triggers.pause canary-w1-not-registered` spent its one token on the
 * optional repository that leads `ScheduleTarget`, so the form came back
 * asking for the schedule name the person had just typed and holding it under
 * Repo instead (walk W1, W1-d-doors.json `pauseFormFields`). Counting the
 * required slots ahead is the same rule every trailing-`owner/repo` grammar
 * applies, derived from the input schema rather than written per door.
 *
 * A slot passed over that way is reported in `skipped`, because it is a field
 * the line did not name: the card still has something to ask for, whatever
 * `missingFields` says about the required ones (controller/forms.ts).
 *
 * @category derivation
 */
export declare const positionalRead: (fields: ReadonlyArray<FormField>, hints: FormHints | undefined, args: string | undefined) => PositionalRead;
/** `positionalRead`'s values alone, for the callers that only place them. */
export declare const partialPayload: (fields: ReadonlyArray<FormField>, hints: FormHints | undefined, args: string | undefined) => Readonly<Record<string, unknown>>;
/** A filled form as the flow's named payload, or the honest refusal one of its controls earned. */
export type Submission = {
    readonly payload: Record<string, unknown>;
} | {
    readonly error: string;
};
/**
 * The filled form as the flow's OWN named payload — the record a submission
 * runs with, validated by the declaration's input schema.
 *
 * Field identity survives here, which the positional line cannot promise: a
 * value the human left blank is ABSENT rather than shifting the next field's
 * value into it, a prefilled free-text field the human cleared submits as the
 * clear it shows, a field the schema requires and a `required: false` hint
 * lets stand blank submits as the empty string that hint means, and a
 * structured field parses back out of the text its control holds.
 * `assembleArgs` still writes the slash line, but only as display copy —
 * nothing reparses it into the payload.
 *
 * @category derivation
 */
export declare const submissionPayload: (input: Schema.Top, fields: ReadonlyArray<FormField>, given: Readonly<Record<string, unknown>>, draft: FormDraft, arrays?: ArrayEncoding) => Submission;
/**
 * The draft the card starts with: every given field coerced to its control's
 * value. Anything the form cannot represent stays only in `given`.
 *
 * @category derivation
 */
export declare const draftFrom: (fields: ReadonlyArray<FormField>, given: Readonly<Record<string, unknown>>, arrays?: ArrayEncoding) => Record<string, FieldValue>;
/** The required fields the draft has not filled, in schema order. */
export declare const missingFields: (fields: ReadonlyArray<FormField>, draft: FormDraft) => Array<string>;
/** The slash line a filled form assembles to, and the values it could not carry. */
export interface AssembledLine {
    /** The line the flow's grammar parses. */
    readonly args: string;
    /**
     * The fields whose values the line left out because the grammar would not
     * read them back as themselves. A caller that runs the line re-parsed as
     * text loses these; a caller that shows the line beside a named payload
     * must name them (`displayLine`).
     */
    readonly withheld: ReadonlyArray<string>;
}
/**
 * The filled form as the one slash line the flow's grammar parses. The
 * default is positional in schema order — blanks skipped, an array
 * space-joined, every true boolean as a trailing `--name` — which is the shape
 * most grammars in SlashPayload.ts take; a flow whose grammar differs supplies
 * `args`.
 *
 * The grammars split on whitespace and have no quoting, so the line carries a
 * value only when it reads back as itself. On the default path a value
 * carrying a `--flag` or `sourceCard=` token, a `sourceCard` or list item that
 * is not one token, and any value the positional read (`positionalRead`, with
 * the flow's `partial`) would place in another field ends the line before it:
 * a multi-word value short of the final slot (JSON included, unless the flow's
 * `partial` reads it balanced), a value behind an unset slot, or a value an
 * optional slot would pass to a required one. Everything from the first such
 * value on is `withheld`.
 *
 * A flow's own `args` builder gets the same refusal: a value whose `--flag` or
 * `sourceCard=` token, or whose whitespace in a `sourceCard`, the builder
 * writes unquoted (not as its JSON string literal) is withheld; a value with a
 * `name=` binding or a `from:<ref>` token is withheld however it is quoted;
 * and when the flow declares `partial` every carried value must read back
 * through it.
 *
 * These checks know the grammars' shared tokens, not every flow's grammar: a
 * value ending in an `owner/repo` token can still be read as a trailing
 * repository by that flow's grammar. A caller that re-runs the line as text
 * must compare the grammar's read of it with the named payload.
 *
 * @category derivation
 */
export declare const assembleLine: (fields: ReadonlyArray<FormField>, hints: FormHints | undefined, payload: Readonly<Record<string, unknown>>) => AssembledLine;
/**
 * `assembleLine`'s line alone.
 *
 * @category derivation
 */
export declare const assembleArgs: (fields: ReadonlyArray<FormField>, hints: FormHints | undefined, payload: Readonly<Record<string, unknown>>) => string;
/**
 * The line as display copy beside a named payload: the withheld fields named
 * after it, so the echo never hides a value the run carried.
 *
 * @category derivation
 */
export declare const displayLine: (line: AssembledLine) => string;
/** Write-only properties are never an input to a durable command or form. */
export declare const publicFormPayload: (fields: ReadonlyArray<FormField>, payload: Readonly<Record<string, unknown>>, payloadField?: string) => Record<string, unknown>;
/** Required fields with the labels shown by either renderer.
 * @category derivation
 * @since 0.1.0
 */
export declare const missingLabels: (fields: ReadonlyArray<FormField>, draft: FormDraft) => Array<string>;
/** Prepare a file-flow payload after checking the form's required inputs.
 * @category derivation
 * @since 0.1.0
 */
export declare const fileSubmission: (input: Schema.Top, fields: ReadonlyArray<FormField>, given: Readonly<Record<string, unknown>>, draft: FormDraft) => Submission;
