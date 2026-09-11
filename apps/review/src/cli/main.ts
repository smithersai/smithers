/**
 * The `smithers-review` command.
 *
 * `review` is not an rc.0 engine verb, so this package ships its own bin. This
 * module is deliberately the light half: argument parsing, the usage text, and
 * the version. `--help` and `--version` must answer immediately, and importing
 * the review flow to print a usage string costs nine seconds of module
 * loading, so the heavy half lives in `runReview.ts` behind a dynamic import.
 *
 * @since 1.0.0
 */
import { readFileSync } from "node:fs";
import { Option, Schema } from "effect";
import { Quiz as QuizSchema, type Quiz } from "../quiz/quizSchema.ts";
import { parseReviewArgs, type ReviewArgs } from "./parseReviewArgs.ts";

const decodeQuiz = Schema.decodeUnknownOption(QuizSchema);

/**
 * Decodes a quiz out of the JSON column a run summary carries.
 *
 * Anything that is not a valid quiz answers `null` rather than throwing: the
 * column is written by a previous run and a summary line must still print when
 * it is absent, truncated, or from an older shape.
 *
 * @since 1.0.0
 * @category parsing
 */
export function parseQuizColumn(value: unknown): Quiz | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return Option.getOrNull(decodeQuiz(JSON.parse(value)));
  } catch {
    return null;
  }
}

/**
 * Builds the one line a finished review prints to stderr.
 *
 * A review that did not complete says so and withholds the breakdown, because
 * "0 findings" from a run whose file reviews all failed reads exactly like a
 * clean pass.
 *
 * @since 1.0.0
 * @category constructors
 */
export function buildRunSummaryLine(summary: {
  filesChanged: number;
  elapsed: string;
  breakdown: string;
  reviewFailed: boolean;
  failedFileReviews: number;
}): string {
  const { filesChanged, elapsed, breakdown, reviewFailed, failedFileReviews } = summary;
  const filesLabel = `${filesChanged} file${filesChanged === 1 ? "" : "s"}`;
  const failedLabel = `${failedFileReviews} file review${failedFileReviews === 1 ? "" : "s"} failed`;
  if (reviewFailed) {
    const cause = failedFileReviews > 0 ? ` (${failedLabel})` : "";
    return `reviewed ${filesLabel} in ${elapsed} — review did not complete${cause}; findings unavailable`;
  }
  const partial = failedFileReviews > 0 ? ` (incomplete: ${failedLabel})` : "";
  return `reviewed ${filesLabel} in ${elapsed} — findings: ${breakdown}${partial}`;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function usage(command: string): string {
  return `smithers review — code review + story-form HTML walkthrough

Usage: ${command} [repo] [options]

What to review (default: workspace changes, tracked + untracked)
  --from <ref> --to <ref>   review a ref range (merge-base diff)
  --commit <sha>            review a single commit
  --pr <number|url>         review a GitHub PR and post the review onto it (via gh)

Review behavior
  --background <text>       requirement background for review + narrator
                            (--pr runs default to the PR title + description)
  --no-review               skip review agents; walkthrough only
  --no-narrate              skip the narrator agent; deterministic story order
  --no-verify               skip the adversarial verification pass over findings
  --quiz <off|auto|on>      reviewer comprehension quiz (default auto: only for
                            high/critical impact changes); the impact reasons
                            behind the assessment appear in the walkthrough.
                            Independent of --no-review and --no-narrate; use
                            --quiz off with both flags for offline use
  --concurrency <n>         maximum simultaneous file reviews (default 8)
  --timeout <min>           per-agent-task timeout in minutes (default 10)

Output
  --title <text>            walkthrough title (default: narrator headline)
  --out <file>              output HTML path (default: <repo>/.smithers-review/walkthrough.html)
  --db <file>               smithers db path (default: <repo>/.smithers-review/review.db)
  --execution-id <id>       start or resume this ID in --db; repeat the same review options
  --split                   side-by-side diffs instead of unified
  --publish                 upload to the share service and print the share URL
  --open                    open the walkthrough in the default browser

Misc
  --version                 print the version
  -h, --help                show this help

Environment
  Seats are "provider:model" strings; the provider decides which key is read.
  SMITHERS_REVIEW_SEAT      reviewing and verifying seat (default anthropic:claude-sonnet-4-5)
  SMITHERS_REVIEW_CHEAP_SEAT   narrating and quizzing seat (default anthropic:claude-haiku-4-5)
  SMITHERS_REVIEW_VERIFY_SEAT  override the verifying seat only
  SMITHERS_REVIEW_NARRATE_SEAT override the narrating seat only
  SMITHERS_REVIEW_QUIZ_SEAT    override the quizzing seat only
  ANTHROPIC_API_KEY         credential for anthropic: seats
  OPENAI_API_KEY            credential for openai: seats
  OPENROUTER_API_KEY        credential for openrouter: seats
  SMITHERS_REVIEW_PUBLISH_URL    share service base URL for --publish
  SMITHERS_REVIEW_PUBLISH_TOKEN  share service token for --publish
  SMITHERS_REVIEW_SUMMARY_PATH   write a machine-readable JSON run summary here

Examples
  ${command}                              review the working tree
  ${command} --from main --to HEAD        review a branch against main
  ${command} --pr 42 --publish            review PR #42 and post it
  ${command} --no-review --no-narrate --quiz off     walkthrough only, no agents`;
}

/**
 * Runs the command.
 *
 * Parsing, help, and version are answered here. Everything past them is one
 * dynamic import away, so a run that never gets that far never loads the flow.
 *
 * @since 1.0.0
 * @category constructors
 */
export async function runReviewCli(
  argv: string[] = process.argv.slice(2),
  options: { command?: string; usageExitCode?: number } = {},
): Promise<void> {
  const command = options.command ?? "smithers-review";
  const helpText = usage(command);
  let args: ReviewArgs;
  try {
    args = parseReviewArgs(argv);
  } catch (error) {
    console.error(`${command}: ${(error as Error).message}\n`);
    console.error(helpText);
    process.exit(options.usageExitCode ?? 1);
    return;
  }
  if (args.help) {
    console.log(helpText);
    return;
  }
  if (args.version) {
    console.log(packageVersion());
    return;
  }
  const { runReview } = await import("./runReview.ts");
  await runReview(args);
}
