/**
 * The one line an unknown verb earns, decided by Jev.
 *
 * A verb the parser does not know is a closed question: the answer is one of
 * the verbs `Verb.shipped` lists, or none of them. So it is asked as a
 * classifier `choice` over that table, each option described by the same help
 * line `--help` prints, rather than measured by a string distance that knows
 * nothing about what the verbs do. A shipped verb, one of its aliases, and a
 * removed verb are never asked about: the first two run, and the third has its
 * own migration sentence in {@link Unsupported}.
 *
 * There is no fallback. Below {@link floor} the suggestion is withheld, and a
 * transport that cannot answer says so by name, because a guess an operator
 * cannot tell from an answer is worse than no line at all.
 *
 * @since 1.0.0
 */
import * as Classifier from "@smthrs/model/Classifier"
import type * as Evaluator from "@smthrs/model/Evaluator"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Unsupported from "./Unsupported.ts"
import * as Verb from "./Verb.ts"

/** The option that means no shipped verb is what the person typed. */
const none = "none"

/** The confidence a suggestion reaches before an operator is shown it. */
const floor = 0.7

/** Every spelling the parser already answers, canonical names and aliases. */
const spellings = new Set(Verb.shipped.flatMap((verb) => [verb.name, ...verb.aliases]))

const meant = Classifier.make("cli/did-you-mean", {
  description: "Judge one unknown command line against the shipped verbs: which one, if any, the person meant.",
  state: Schema.Struct({
    typed: Schema.String.annotate({ description: "The verb the person typed, which no command answers" }),
    args: Schema.String.annotate({ description: "The rest of the command line, as they typed it" })
  }),
  questions: {
    meant: Classifier.choice({
      instructions: "Which shipped verb did the person mean?",
      criteria: {
        ...Object.fromEntries(Verb.shipped.map((verb) => [verb.name, verb.help])),
        [none]: "No shipped verb is what they meant"
      }
    })
  }
})

/**
 * The suggestion line for a typed verb, or `undefined` when there is none to
 * give.
 *
 * The line is appended to the refusal the parser already prints; it never
 * changes the exit code and never runs the verb it names.
 *
 * @category getters
 * @since 1.0.0
 */
export const didYouMean = (
  typed: string,
  args: ReadonlyArray<string>
): Effect.Effect<string | undefined, never, Evaluator.Evaluator> => {
  if (spellings.has(typed) || Unsupported.removedVerbs.some((verb) => verb.name === typed)) {
    return Effect.succeed(undefined)
  }
  return meant.evaluate({ typed, args: args.join(" ") }).pipe(
    Effect.map((answers) =>
      answers.meant.value === none || answers.meant.confidence < floor
        ? undefined
        : `Did you mean: smithers ${answers.meant.value}?`
    ),
    Effect.catch((error) => Effect.succeed(`Could not ask Jev for a suggestion: ${error.code}`))
  )
}
