/** Private receipt projections of Plue's existing landing service. Browser safe. */
import { Schema } from "effect";
export declare const AppendPreparationInput: Schema.Struct<{
    readonly target_bookmark: Schema.Literal<"main">;
    readonly expected_commit_id: Schema.String;
    readonly source_commit_id: Schema.String;
    readonly source_base_commit_id: Schema.String;
}>;
export type AppendPreparationInput = typeof AppendPreparationInput.Type;
export declare const AppendPreparation: Schema.Struct<{
    readonly target_bookmark: Schema.Literal<"main">;
    readonly expected_commit_id: Schema.String;
    readonly source_commit_id: Schema.String;
    readonly source_base_commit_id: Schema.String;
    readonly status: Schema.Literal<"prepared">;
    readonly changes: Schema.$Array<Schema.Struct<{
        readonly change_id: Schema.String;
        readonly commit_id: Schema.String;
    }>>;
}>;
export type AppendPreparation = typeof AppendPreparation.Type;
export declare const LandingIdentity: Schema.Struct<{
    readonly requestId: Schema.String;
    readonly number: Schema.Int;
}>;
export type LandingIdentity = typeof LandingIdentity.Type;
export declare const AppendRequest: Schema.Struct<{
    readonly commit_id: Schema.String;
    readonly expected_commit_id: Schema.String;
    readonly source_base_commit_id: Schema.String;
    readonly description: Schema.NonEmptyString;
}>;
export type AppendRequest = typeof AppendRequest.Type;
export declare const QueuedAppend: Schema.Struct<{
    readonly requestId: Schema.String;
    readonly number: Schema.Int;
    readonly taskId: Schema.Int;
    readonly preparation: Schema.Struct<{
        readonly target_bookmark: Schema.Literal<"main">;
        readonly expected_commit_id: Schema.String;
        readonly source_commit_id: Schema.String;
        readonly source_base_commit_id: Schema.String;
        readonly status: Schema.Literal<"prepared">;
        readonly changes: Schema.$Array<Schema.Struct<{
            readonly change_id: Schema.String;
            readonly commit_id: Schema.String;
        }>>;
    }>;
    readonly request: Schema.Struct<{
        readonly commit_id: Schema.String;
        readonly expected_commit_id: Schema.String;
        readonly source_base_commit_id: Schema.String;
        readonly description: Schema.NonEmptyString;
    }>;
}>;
export type QueuedAppend = typeof QueuedAppend.Type;
export declare const AppendObservation: Schema.Union<readonly [Schema.Struct<{
    readonly status: Schema.Literals<readonly ["pending", "running", "failed"]>;
    readonly task_id: Schema.Int;
    readonly request: Schema.Struct<{
        readonly change_ids: Schema.$Array<Schema.String>;
        readonly target_bookmark: Schema.Literal<"main">;
        readonly expected_commit_id: Schema.String;
        readonly operation_key: Schema.NonEmptyString;
        readonly lookup_only: Schema.optionalKey<Schema.Literal<false>>;
        readonly append: Schema.Struct<{
            readonly source_commit_id: Schema.String;
            readonly source_base_commit_id: Schema.String;
            readonly description: Schema.NonEmptyString;
        }>;
    }>;
    readonly result: Schema.optionalKey<Schema.Never>;
}>, Schema.Struct<{
    readonly status: Schema.Literal<"landed">;
    readonly task_id: Schema.Int;
    readonly request: Schema.Struct<{
        readonly change_ids: Schema.$Array<Schema.String>;
        readonly target_bookmark: Schema.Literal<"main">;
        readonly expected_commit_id: Schema.String;
        readonly operation_key: Schema.NonEmptyString;
        readonly lookup_only: Schema.optionalKey<Schema.Literal<false>>;
        readonly append: Schema.Struct<{
            readonly source_commit_id: Schema.String;
            readonly source_base_commit_id: Schema.String;
            readonly description: Schema.NonEmptyString;
        }>;
    }>;
    readonly result: Schema.Struct<{
        readonly landed_count: Schema.Int;
        readonly target_bookmark: Schema.Literal<"main">;
        readonly target_commit_id: Schema.String;
    }>;
}>]>;
export type AppendObservation = typeof AppendObservation.Type;
/** What the repository's declared GitHub policy does with a Change. */
export declare const Delivery: Schema.Literals<readonly ["append", "pull-request"]>;
export type Delivery = typeof Delivery.Type;
/** GitHub's pull request for one landing, keyed by its smithers/landing-<n> head branch. */
export declare const GitHubPull: Schema.Struct<{
    readonly landing_number: Schema.Int;
    readonly repository: Schema.String;
    readonly number: Schema.Int;
    readonly url: Schema.String;
    readonly state: Schema.Literals<readonly ["open", "closed"]>;
    readonly merged: Schema.Boolean;
    readonly head_ref: Schema.String;
    readonly head_sha: Schema.String;
    readonly base_ref: Schema.Literal<"main">;
    readonly created: Schema.Boolean;
}>;
export type GitHubPull = typeof GitHubPull.Type;
/** The repository's mythical stack as `coding/vibe` needs it: only whether it is active. */
export declare const StackState: Schema.Struct<{
    readonly state: Schema.Literals<readonly ["absent", "bootstrapping", "active", "frozen"]>;
}>;
/** A lane result handed to the stack service (PUT /mythical/lanes). */
export declare const LaneSubmission: Schema.Struct<{
    readonly workspaceId: Schema.String;
    readonly base: Schema.String;
    readonly source: Schema.String;
    readonly requestRunId: Schema.NonEmptyString;
    readonly summary: Schema.NonEmptyString;
    readonly plan: Schema.optionalKey<Schema.Struct<{
        readonly prompt: Schema.NonEmptyString;
        readonly memoryRevision: Schema.NonEmptyString;
        readonly wikiCitations: Schema.optionalKey<Schema.$Array<Schema.Struct<{
            readonly slug: Schema.NonEmptyString;
            readonly pageID: Schema.NonEmptyString;
            readonly revision: Schema.Int;
            readonly digest: Schema.String;
        }>>>;
        readonly memory: Schema.optionalKey<Schema.$Array<Schema.Struct<{
            readonly origin: Schema.Literal<"recall">;
            readonly bank: Schema.NonEmptyString;
            readonly key: Schema.NonEmptyString;
            readonly text: Schema.NonEmptyString;
        }>>>;
        readonly base: Schema.Struct<{
            readonly changeId: Schema.NonEmptyString;
            readonly commitId: Schema.NonEmptyString;
            readonly treeId: Schema.NonEmptyString;
            readonly operationId: Schema.NonEmptyString;
            readonly parentCommitIds: Schema.$Array<Schema.NonEmptyString>;
        }>;
        readonly observedHead: Schema.optionalKey<Schema.Struct<{
            readonly changeId: Schema.NonEmptyString;
            readonly commitId: Schema.NonEmptyString;
            readonly treeId: Schema.NonEmptyString;
            readonly operationId: Schema.NonEmptyString;
            readonly parentCommitIds: Schema.$Array<Schema.NonEmptyString>;
        }>>;
        readonly changes: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly title: Schema.NonEmptyString;
            readonly intent: Schema.NonEmptyString;
            readonly implementation: Schema.NonEmptyString;
            readonly implementationDigest: Schema.NonEmptyString;
            readonly atoms: Schema.$Array<Schema.Struct<{
                readonly changeId: Schema.NullOr<Schema.NonEmptyString>;
                readonly message: Schema.NonEmptyString;
                readonly intent: Schema.NonEmptyString;
                readonly reads: Schema.$Array<Schema.NonEmptyString>;
                readonly writes: Schema.$Array<Schema.NonEmptyString>;
            }>>;
            readonly checks: Schema.$Array<Schema.Struct<{
                readonly id: Schema.String;
                readonly target: Schema.NonEmptyString;
                readonly flow: Schema.NonEmptyString;
                readonly flowDigest: Schema.NonEmptyString;
                readonly tier: Schema.Literals<readonly ["fast", "slow", "delivery"]>;
                readonly required: Schema.Boolean;
            }>>;
        }>>;
    }>>;
}>;
export type LaneSubmission = typeof LaneSubmission.Type;
/** The stack service's receipt: the item that now carries this candidate. */
export declare const LaneReceipt: Schema.Struct<{
    readonly itemId: Schema.NonEmptyString;
    readonly state: Schema.NonEmptyString;
    readonly source: Schema.String;
}>;
export type LaneReceipt = typeof LaneReceipt.Type;
/**
 * Landing without the backend: `.smithers/coding-project.json` `landing`
 * selects it for a host that has no provisioned repository binding.
 */
export declare const LocalLander: Schema.Literals<readonly ["pull-request", "fast-forward"]>;
export type LocalLander = typeof LocalLander.Type;
/** Which lander a vibe run delivers through; recorded once per run. */
export declare const Lander: Schema.Literals<readonly ["backend", "pull-request", "fast-forward"]>;
export type Lander = typeof Lander.Type;
export declare const LandingCandidate: Schema.Struct<{
    readonly lander: Schema.Literals<readonly ["pull-request", "fast-forward"]>;
    /** Main as the candidate was built on it. */
    readonly main: Schema.Struct<{
        readonly changeId: Schema.String;
        readonly commitId: Schema.String;
        readonly treeId: Schema.String;
        readonly operationId: Schema.NonEmptyString;
        readonly parentCommitIds: Schema.$Array<Schema.String>;
    }>;
    /** The candidate's commit message: the cleanup summary. */
    readonly summary: Schema.NonEmptyString;
    readonly candidate: Schema.Struct<{
        readonly changeId: Schema.String;
        readonly commitId: Schema.String;
        readonly treeId: Schema.String;
        readonly operationId: Schema.NonEmptyString;
        readonly parentCommitIds: Schema.$Array<Schema.String>;
    }>;
}>;
export type LandingCandidate = typeof LandingCandidate.Type;
/** GitHub's pull request for a candidate, keyed by its `smithers/landing-<request>` head branch. */
export declare const LocalPull: Schema.Struct<{
    readonly number: Schema.Int;
    readonly url: Schema.String;
    readonly state: Schema.Literals<readonly ["open", "closed", "merged"]>;
    readonly headRef: Schema.String;
    readonly headSha: Schema.String;
    readonly baseRef: Schema.String;
    readonly mergeCommitId: Schema.NullOr<Schema.String>;
}>;
export type LocalPull = typeof LocalPull.Type;
/** One observation of a pull request's required checks (`gh pr checks --required`). */
export declare const PullChecks: Schema.Struct<{
    readonly status: Schema.Literals<readonly ["passed", "failed", "pending"]>;
    readonly checks: Schema.$Array<Schema.Struct<{
        readonly name: Schema.String;
        readonly bucket: Schema.String;
    }>>;
}>;
export type PullChecks = typeof PullChecks.Type;
/** GitHub merged the candidate, or keeps the pull request open and says why. */
export declare const MergeOutcome: Schema.Union<readonly [Schema.Struct<{
    readonly status: Schema.Literal<"merged">;
    readonly mainCommitId: Schema.String;
}>, Schema.Struct<{
    readonly status: Schema.Literal<"open">;
    readonly reason: Schema.String;
}>]>;
export type MergeOutcome = typeof MergeOutcome.Type;
