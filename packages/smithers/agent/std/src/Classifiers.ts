/**
 * The curated classifiers a host binds beside the ad-hoc `classify` flow.
 *
 * Each one is a `Classifier.make` declaration: a state schema the model fills
 * from what its cells already hold, and questions whose instructions are one
 * atomic judgment each, with every criterion spelled out. They cover the
 * three judgments the trace program found cells paying whole frames for: is
 * this file worth reading further, did this check fail for the reason the
 * task names, and how much could this edit break.
 *
 * @since 1.0.0
 */
import * as Classifier from "@smthrs/model/Classifier"
import * as Schema from "effect/Schema"
import type { AnyClassifier } from "./Classify.ts"

/**
 * Whether a file matters to the task, what role it plays, and how risky
 * editing it would be.
 *
 * @category classifiers
 * @since 1.0.0
 */
export const relevance = Classifier.make("triage/relevance", {
  description:
    "Judge one file against the task: whether it must change, whether it is implementation, fixture, or unrelated, and how risky editing it is.",
  state: Schema.Struct({
    task: Schema.String.annotate({ description: "The task, as the person stated it" }),
    file: Schema.String.annotate({ description: "The file's path" }),
    excerpt: Schema.String.annotate({ description: "The part of the file to judge, raw text" })
  }),
  questions: {
    relevant: Classifier.boolean({
      instructions: "Does this file need to change for the task to be done?",
      criteria: {
        true: "the change the task asks for, or the test that proves it, belongs in this file",
        false: "the file is unrelated, or only imports or is imported by the code that changes"
      }
    }),
    role: Classifier.choice({
      instructions: "What is this file's role with respect to the task?",
      criteria: {
        implementation: "code the task is about, or code that calls it",
        fixture: "test data, test setup, configuration, or generated output",
        unrelated: "nothing in the excerpt bears on the task"
      }
    }),
    risk: Classifier.score({
      instructions: "How much could an edit to this excerpt break elsewhere?",
      criteria: ["none", "low", "medium", "high"]
    })
  }
})

/**
 * Whether a command's failure is the bug the task names, or a probe that
 * could not find what it named.
 *
 * @category classifiers
 * @since 1.0.0
 */
export const checkVerdict = Classifier.make("check/verdict", {
  description:
    "Judge one command result against the task: whether it failed because of the bug the task names, and whether it failed because a name, file, module, or environment does not exist.",
  state: Schema.Struct({
    task: Schema.String.annotate({ description: "The task, as the person stated it" }),
    command: Schema.String.annotate({ description: "The command that ran" }),
    exitCode: Schema.Int.annotate({ description: "Its exit code" }),
    output: Schema.String.annotate({ description: "Its captured stdout and stderr, tail first if truncated" })
  }),
  questions: {
    rightReason: Classifier.boolean({
      instructions: "Did this command fail because of the bug `task` describes?",
      criteria: {
        true: "the output shows the wrong behavior, wrong value, or assertion `task` describes",
        false: "the output shows another failure, or the command passed"
      }
    }),
    invalidProbe: Classifier.boolean({
      instructions: "Did this command fail because a name, file, module, or environment it relies on does not exist?",
      criteria: {
        true: "the output reports a missing command, test id, file, module, import, package, interpreter, or service",
        false: "everything the command named was found, and it ran to a verdict"
      }
    })
  }
})

/**
 * How much a hunk could break, and whether it can be undone.
 *
 * @category classifiers
 * @since 1.0.0
 */
export const editRisk = Classifier.make("edit/risk", {
  description:
    "Judge one applied hunk against the task: how much it could break beyond its file, and whether reverting it restores the previous behavior.",
  state: Schema.Struct({
    task: Schema.String.annotate({ description: "The task, as the person stated it" }),
    path: Schema.String.annotate({ description: "The edited file's path" }),
    hunk: Schema.String.annotate({ description: "The applied hunk, as edit returned it" })
  }),
  questions: {
    risk: Classifier.score({
      instructions: "How much could this hunk break beyond the lines it changes?",
      criteria: ["none", "low", "medium", "high"]
    }),
    reversible: Classifier.boolean({
      instructions: "Does reverting this hunk restore the previous behavior completely?",
      criteria: {
        true: "the hunk changes only code or text, with no migration, deletion, or external effect",
        false: "the hunk deletes, migrates, renames across files, or triggers an effect a revert does not undo"
      }
    })
  }
})

/**
 * The three curated classifiers, in catalog order.
 *
 * @category classifiers
 * @since 1.0.0
 */
export const all: ReadonlyArray<AnyClassifier> = [relevance, checkVerdict, editRisk]
