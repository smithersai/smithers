/**
 * Reading and rendering GitHub Actions workflow files.
 *
 * A generated CI pipeline is only worth anything if it still runs the gates
 * the repository requires. `GithubCiGen` used to render five hard-coded steps
 * whose whole pipeline was one `pnpm dlx @smthrs/build-cli ci //...` invocation, and it
 * declared `.github/workflows/ci.yml` as its output — so building the root
 * target replaced a multi-job pipeline (typecheck, lint, circular-dependency
 * guard, browser bundle gate, release pack smoke test, Rust fmt/clippy/test,
 * WASM reproducibility, Bun, macOS, Windows) with a single job that ran none
 * of them.
 *
 * This module supplies the two halves of the fix: a renderer that can express a
 * real multi-job pipeline rather than a fixed five-step one, and a workflow
 * reader, so the rendered pipeline can be checked against the gates the
 * repository declared before a single byte is written.
 *
 * The reader is two layers. YAML lexing and structure come from `yaml`, the
 * parser this package already depends on and already reads workspace data
 * with; a hand-written scanner used to do that job and carried its own
 * quoting, indentation, and block-scalar rules, which is where its bugs lived.
 * On top of it sits the part that is this module's own: a workflow validator
 * that refuses anything the gate contract cannot verify — a YAML alias or
 * merge key, an inherited `defaults:` shell, a duplicate top-level key, job
 * id, job field, or step field, a job with no runner or no steps, a step that
 * declares neither or both of `uses` and `run`. Failing closed is the point: a
 * gate this module could not see is reported missing, never assumed present.
 *
 * @since 0.1.0
 */
import type { Workflow } from "../../../src/GithubWorkflow.vibe.platform.js";
export { WorkflowParseError, WorkflowParseReason, maximumWorkflowBytes, parseWorkflow } from "../../../src/GithubWorkflow.vibe.platform.js";
export type { Workflow, WorkflowJob, WorkflowStep } from "../../../src/GithubWorkflow.vibe.platform.js";
/**
 * A command a workflow must still run.
 *
 * `command` is matched as a WHOLE COMMAND at a shell command boundary of some
 * step's `run` body — never as a substring. It must start where the shell would
 * start reading a command (the beginning of the script, or after `\n`, `;`,
 * `&`, `&&`, `|`, `||`, a subshell or command-substitution `(`, or one of the
 * `if`/`then`/`else`/`elif`/`while`/`until`/`do`/`{`/`}`/`!`/`time`/`sudo`/
 * `exec` words that introduce one, across a `\`-newline line continuation), it
 * must sit outside every quoted string, and the character after it must end a
 * shell word. So `echo pnpm run check` and `"pnpm run check"` do not satisfy a
 * `pnpm run check` gate, while `if ! cmp a b; then`, `(cd x && bun …)`,
 * `corepack enable && \` + `pnpm run check`, and
 * `pnpm install --frozen-lockfile --ignore-scripts` still do. Arguments and
 * flags after the declared command are allowed; a longer command name
 * (`pnpm run checkall`) is not.
 *
 * A gate whose command names an action instead matches a step's `uses` value
 * exactly, or the same action at any version (`actions/checkout` matches
 * `actions/checkout@v4`). It never matches a `uses` that merely contains it.
 *
 * `job`, when given, also requires the command to appear in that job, which is
 * how a gate that must run on a specific platform (macOS, Windows, Bun) is
 * pinned to it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Gate {
    readonly name: string;
    readonly command: string;
    readonly job?: string | undefined;
}
/**
 * Strips shell comments from a `run` script, line by line.
 *
 * A gate proves a command still RUNS. Commented-out text is not a command, and
 * a workflow whose only remaining occurrence of `pnpm run check` sits behind a
 * `#` runs no typecheck — so the comment is removed before matching and the
 * gate is reported missing. Quoting state is not carried across lines, which
 * fails closed: a `#` inside a multi-line quoted string is treated as a
 * comment, costing a gate a match rather than inventing one.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const stripShellComments: (script: string) => string;
/**
 * One command the shell would run, as a half-open range of the script.
 *
 * @category models
 * @since 0.1.0
 */
export interface CommandSpan {
    /** The offset of the command's first word. */
    readonly start: number;
    /** The offset just past the command's last word, before its separator. */
    readonly end: number;
}
/**
 * The commands the shell would run, each as the range its words occupy.
 *
 * This is the whole of the fail-closed gate contract: a command is only proof
 * that something RUNS when the shell would run it, so `echo pnpm run check`,
 * `"…; pnpm run check"`, and `xpnpm run check` yield no command span at the
 * gate's text. Constructs this scanner does not model (backticks, `eval`)
 * simply produce no span there, which reports the gate missing rather than
 * accepting text that may not run.
 *
 * A span ends where the shell stops reading the command: at a separator, at a
 * here-document, or at the end of the script. That is what lets a caller hold
 * the WHOLE command to a policy — {@link performsInstall} checks the install's
 * own flags — rather than only its first words.
 *
 * Shell-level control flow is the one thing it deliberately looks THROUGH: a
 * command inside an `if`, a loop body, or a `case` arm is reported as run,
 * because the flows pipeline's own byte-comparison gate lives inside
 * `if ! cmp …; then`. A workflow-level `if:` is the opposite — see
 * {@link alwaysRuns} — because GitHub may skip the whole job or step.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const commandSpans: (script: string) => ReadonlyArray<CommandSpan>;
/**
 * The offsets at which the shell would start reading a command.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const commandStarts: (script: string) => ReadonlyArray<number>;
/**
 * Whether a `run` script runs the given command.
 *
 * The command must begin at a shell command boundary and end at a word
 * boundary, so arguments and flags may follow it but a longer command name may
 * not. Shell comments come off first: commented-out text is not a command.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const runsCommand: (script: string, command: string) => boolean;
/**
 * Whether a step's `uses` value is the action a gate names.
 *
 * The value must BE the action, either at the pinned reference the gate
 * declares or at any version of an unversioned one. A `uses` that merely
 * contains the gate's text — `my-org/actions/checkout@v4` against
 * `actions/checkout@v4` — is a different action and does not satisfy it.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const usesAction: (uses: string, command: string) => boolean;
/**
 * The one step condition that proves a gate as well as no `if:` does, given an
 * earlier unconditional step with `id: setup`: it runs whenever the implicit
 * `success()` would, and also after an earlier gate went red. Generated CI
 * puts it on every gate step.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const independentGateCondition: "!cancelled() && steps.setup.conclusion == 'success'";
/**
 * Whether a parsed `if:` is provably always true.
 *
 * Only the `true` literal is accepted. Anything else — `false`, a context
 * expression, a value the scanner could not read — leaves the job or step
 * conditional, and a conditional job or step is not proof that a required
 * gate runs. {@link missingGates} additionally accepts
 * {@link independentGateCondition} on a step, where it can check the setup step.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const alwaysRuns: (condition: string | undefined) => boolean;
/**
 * Whether GitHub will execute a run body through a shell the scanner models.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const executesRunScript: (shell: string | undefined) => boolean;
/**
 * The declared required jobs a workflow does not unconditionally run.
 *
 * A required job is required to RUN, on the same terms as a gate: a job
 * carrying an `if:` is one GitHub may skip, so `if: false` on a required job is
 * a job the pipeline does not have. A job that exists but is conditional is
 * reported as `id (conditional)`, because "missing" would send an operator
 * looking for a job that is right there in the file.
 *
 * `continue-on-error` stays out of it, exactly as it does for a gate: a
 * required job asserts that the job runs, not that its failure blocks a merge,
 * and the advisory platform lanes are jobs that do run.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const missingRequiredJobs: (workflow: Workflow, requiredJobs: ReadonlyArray<string>) => ReadonlyArray<string>;
/**
 * Reports the declared gates a workflow no longer runs.
 *
 * A gate is satisfied only by an UNCONDITIONAL job and step: `if: false`, and
 * every other condition that is not the always-true literal, is a job or step
 * GitHub may skip, so it cannot prove an unconditional gate. `continue-on-error`
 * is deliberately not treated the same way — a gate asserts that a command is
 * still run, not that its failure blocks a merge, and the advisory macOS and
 * Windows lanes of a real pipeline are exactly the jobs a platform-pinned gate
 * exists to pin.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const missingGates: (workflow: Workflow, gates: ReadonlyArray<Gate>) => ReadonlyArray<Gate>;
/**
 * One supported lockfile install, with the only flags it may carry.
 *
 * @category models
 * @since 0.1.0
 */
export interface SupportedInstall {
    /** The exact install command. */
    readonly command: string;
    /** The workspace-binary runner that install pins. */
    readonly exec: string;
    /** Valueless flags that cannot omit a dependency the lockfile pins. */
    readonly flags: ReadonlyArray<string>;
    /** `--flag=value` flags that cannot omit a dependency the lockfile pins. */
    readonly valueFlags: ReadonlyArray<string>;
}
/**
 * The lockfile installs a generated pipeline may run, and the flags each one
 * may carry.
 *
 * A generated pipeline that installs with anything else — `pnpm dlx`, a bare
 * `npm install`, a fetch-from-the-network one-liner — is not reproducible and
 * is not a supported way to set a workspace up, so the renderer refuses it.
 *
 * The flag lists are ALLOWLISTS, and they are the second half of the same
 * guarantee. `pnpm install --frozen-lockfile --lockfile-only` writes a lockfile
 * and installs nothing; `--prod`, `--production`, and `--omit=dev` drop the dev
 * dependencies the workspace CLI lives in; `--filter=…` installs a slice of the
 * workspace. Each one leaves the install gate satisfied and the pinned binary
 * missing, which is a guaranteed-red or silently incomplete pipeline. Only
 * flags that cannot omit a pinned dependency are listed, and an unrecognized
 * flag is refused rather than guessed at.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const supportedInstalls: ReadonlyArray<SupportedInstall>;
/**
 * Install commands that respect a lockfile.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const supportedInstallCommands: ReadonlyArray<string>;
/**
 * The supported install a command line is, or `undefined` when it is none of
 * them.
 *
 * Extra flags are allowed only when {@link supportedInstalls} lists them for
 * that package manager. An unknown flag, a flag that can omit a pinned
 * dependency, and anything that could reach the shell or the network are all
 * refused, because each of them satisfies an install gate while leaving the
 * workspace incomplete.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const supportedInstallOf: (command: string) => string | undefined;
/**
 * Whether a command line is a supported lockfile install.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const isSupportedInstall: (command: string) => boolean;
/**
 * The command prefix that runs a workspace binary the matching lockfile
 * install already put in the tree.
 *
 * Each one resolves the binary from `node_modules`, so the version that runs is
 * the version the lockfile pinned. `npm exec --no-install` fails rather than
 * fetching. None of them may reach a registry: a generated pipeline that
 * fetched its own CLI would run a package the lockfile never approved, and the
 * install step would be decorative.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const workspaceExecCommands: Readonly<Record<string, string>>;
/**
 * The workspace-binary runner for a supported lockfile install, or `undefined`
 * when the install is not supported.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const workspaceExec: (install: string) => string | undefined;
/**
 * Whether a `run` script actually performs the given lockfile install.
 *
 * The install has to be a command the SHELL RUNS, which is the same boundary
 * target a gate uses: it must occupy a whole {@link commandSpans} span, after
 * shell comments come off. A mention inside a comment, an `echo` argument, a
 * quoted string, or a here-document body installs nothing and does not count,
 * even though every one of them is a line of the script that reads like the
 * install.
 *
 * The WHOLE command is held to the same policy as the declared install, not
 * merely its prefix. `pnpm install --frozen-lockfile --prod` starts with the
 * declared base and installs none of the dev dependencies the pinned workspace
 * CLI lives in, so it does not perform the declared install; the allowlisted
 * `pnpm install --frozen-lockfile --ignore-scripts` does.
 *
 * @category verification
 * @since 0.1.0
 */
export declare const performsInstall: (script: string, install: string) => boolean;
