import * as AgentAction from "@smthrs/agent/AgentAction";
import { Action } from "@smthrs/flow";
import { Schema } from "effect";
import { ReleaseError } from "../../../release-support/schema.ts";
export declare const Collect: Action.Declared<"release-content/collect", Schema.Struct<{
    version: Schema.String;
    from: Schema.String;
}>, Schema.Struct<{
    readonly version: Schema.String;
    readonly currentVersion: Schema.String;
    readonly sourceSha: Schema.String;
    readonly from: Schema.String;
    readonly date: Schema.String;
    readonly commits: Schema.String;
    readonly changes: Schema.String;
    readonly documents: Schema.String;
    readonly recordings: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly digest: Schema.String;
    }>>;
    readonly sources: Schema.$Array<Schema.String>;
    readonly gates: Schema.optionalKey<Schema.Struct<{
        readonly ran: Schema.$Array<Schema.String>;
        readonly exceptions: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly command: Schema.String;
            readonly reason: Schema.String;
        }>>;
    }>>;
}>, typeof ReleaseError, Action.Requirement<"release-content/collect">>;
export declare const RecordUi: Action.Declared<"release-content/record-ui", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly version: Schema.String;
    readonly currentVersion: Schema.String;
    readonly sourceSha: Schema.String;
    readonly from: Schema.String;
    readonly date: Schema.String;
    readonly commits: Schema.String;
    readonly changes: Schema.String;
    readonly documents: Schema.String;
    readonly recordings: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly digest: Schema.String;
    }>>;
    readonly sources: Schema.$Array<Schema.String>;
    readonly gates: Schema.optionalKey<Schema.Struct<{
        readonly ran: Schema.$Array<Schema.String>;
        readonly exceptions: Schema.$Array<Schema.Struct<{
            readonly name: Schema.String;
            readonly command: Schema.String;
            readonly reason: Schema.String;
        }>>;
    }>>;
}>, typeof ReleaseError, Action.Requirement<"release-content/record-ui">>;
export declare const Analyze: AgentAction.AgentAction<"release-content/analyze", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly title: Schema.String;
    readonly summary: Schema.String;
    readonly highlights: Schema.$Array<Schema.String>;
    readonly risks: Schema.$Array<Schema.String>;
    readonly migration: Schema.$Array<Schema.String>;
    readonly claims: Schema.$Array<Schema.Struct<{
        readonly id: Schema.String;
        readonly text: Schema.String;
        readonly sources: Schema.$Array<Schema.String>;
    }>>;
}>>;
/** Which of four write-ups the release calls for is an enumerated choice, so
 * Jev makes it and its answer is the brief's narrative. An answer below the
 * floor and an evaluator that could not answer at all both fail this action
 * with a typed `ReleaseError`. There is no second model behind it. */
export declare const PickTemplate: Action.Declared<"release-content/pick-template", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
}>, Schema.Struct<{
    readonly template: Schema.Literals<readonly ["feature deep dive", "migration guide", "reliability report", "release roundup"]>;
    readonly confidence: Schema.Number;
}>, typeof ReleaseError, Action.Requirement<"release-content/pick-template">>;
/** The seat outlines the narrative it was handed. Its output has no narrative
 * field, so the only writer of `brief.template` is `PickTemplate`. */
export declare const OutlineTemplate: AgentAction.AgentAction<"release-content/outline-template", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
    template: Schema.Literals<readonly ["feature deep dive", "migration guide", "reliability report", "release roundup"]>;
}>, Schema.Struct<{
    readonly angle: Schema.String;
    readonly outline: Schema.$Array<Schema.String>;
}>>;
export declare const DraftChangelog: AgentAction.AgentAction<"release-content/draft-changelog", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
    brief: Schema.Struct<{
        readonly angle: Schema.String;
        readonly outline: Schema.$Array<Schema.String>;
        readonly template: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly text: Schema.String;
    readonly claimIds: Schema.$Array<Schema.String>;
}>>;
export declare const DraftThread: AgentAction.AgentAction<"release-content/draft-thread", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
    brief: Schema.Struct<{
        readonly angle: Schema.String;
        readonly outline: Schema.$Array<Schema.String>;
        readonly template: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly tweets: Schema.$Array<Schema.Struct<{
        readonly text: Schema.String;
        readonly claimIds: Schema.$Array<Schema.String>;
    }>>;
}>>;
export declare const OutlineBlog: AgentAction.AgentAction<"release-content/outline-blog", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
    brief: Schema.Struct<{
        readonly angle: Schema.String;
        readonly outline: Schema.$Array<Schema.String>;
        readonly template: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly angle: Schema.String;
    readonly outline: Schema.$Array<Schema.String>;
    readonly template: Schema.String;
}>>;
export declare const DraftBlog: AgentAction.AgentAction<"release-content/draft-blog", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
    brief: Schema.Struct<{
        readonly angle: Schema.String;
        readonly outline: Schema.$Array<Schema.String>;
        readonly template: Schema.String;
    }>;
    outline: Schema.Struct<{
        readonly angle: Schema.String;
        readonly outline: Schema.$Array<Schema.String>;
        readonly template: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly text: Schema.String;
    readonly claimIds: Schema.$Array<Schema.String>;
}>>;
export declare const Score: AgentAction.AgentAction<"release-content/score", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
    draft: Schema.Struct<{
        readonly changelog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly blog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly thread: Schema.Struct<{
            readonly tweets: Schema.$Array<Schema.Struct<{
                readonly text: Schema.String;
                readonly claimIds: Schema.$Array<Schema.String>;
            }>>;
        }>;
    }>;
    round: Schema.Int;
}>, Schema.Struct<{
    readonly passed: Schema.Boolean;
    readonly score: Schema.Number;
    readonly feedback: Schema.$Array<Schema.String>;
}>>;
export declare const Check: Action.Declared<"release-content/check", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
    draft: Schema.Struct<{
        readonly changelog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly blog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly thread: Schema.Struct<{
            readonly tweets: Schema.$Array<Schema.Struct<{
                readonly text: Schema.String;
                readonly claimIds: Schema.$Array<Schema.String>;
            }>>;
        }>;
    }>;
    review: Schema.Struct<{
        readonly passed: Schema.Boolean;
        readonly score: Schema.Number;
        readonly feedback: Schema.$Array<Schema.String>;
    }>;
}>, Schema.Struct<{
    readonly passed: Schema.Boolean;
    readonly score: Schema.Number;
    readonly feedback: Schema.$Array<Schema.String>;
}>, typeof ReleaseError, Action.Requirement<"release-content/check">>;
export declare const Revise: AgentAction.AgentAction<"release-content/revise", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
    brief: Schema.Struct<{
        readonly angle: Schema.String;
        readonly outline: Schema.$Array<Schema.String>;
        readonly template: Schema.String;
    }>;
    draft: Schema.Struct<{
        readonly changelog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly blog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly thread: Schema.Struct<{
            readonly tweets: Schema.$Array<Schema.Struct<{
                readonly text: Schema.String;
                readonly claimIds: Schema.$Array<Schema.String>;
            }>>;
        }>;
    }>;
    review: Schema.Struct<{
        readonly passed: Schema.Boolean;
        readonly score: Schema.Number;
        readonly feedback: Schema.$Array<Schema.String>;
    }>;
    round: Schema.Int;
}>, Schema.Struct<{
    readonly changelog: Schema.Struct<{
        readonly text: Schema.String;
        readonly claimIds: Schema.$Array<Schema.String>;
    }>;
    readonly blog: Schema.Struct<{
        readonly text: Schema.String;
        readonly claimIds: Schema.$Array<Schema.String>;
    }>;
    readonly thread: Schema.Struct<{
        readonly tweets: Schema.$Array<Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>>;
    }>;
}>>;
export declare const QualityGate: Action.Declared<"release-content/quality-gate", Schema.Struct<{
    review: Schema.Struct<{
        readonly passed: Schema.Boolean;
        readonly score: Schema.Number;
        readonly feedback: Schema.$Array<Schema.String>;
    }>;
    draft: Schema.Struct<{
        readonly changelog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly blog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly thread: Schema.Struct<{
            readonly tweets: Schema.$Array<Schema.Struct<{
                readonly text: Schema.String;
                readonly claimIds: Schema.$Array<Schema.String>;
            }>>;
        }>;
    }>;
}>, Schema.Struct<{
    readonly changelog: Schema.Struct<{
        readonly text: Schema.String;
        readonly claimIds: Schema.$Array<Schema.String>;
    }>;
    readonly blog: Schema.Struct<{
        readonly text: Schema.String;
        readonly claimIds: Schema.$Array<Schema.String>;
    }>;
    readonly thread: Schema.Struct<{
        readonly tweets: Schema.$Array<Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>>;
    }>;
}>, typeof ReleaseError, Action.Requirement<"release-content/quality-gate">>;
export declare const Preview: Action.Declared<"release-content/write-preview", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly dryRun: Schema.Boolean;
        readonly publish: Schema.Boolean;
        readonly postX: Schema.Boolean;
        readonly autoCommit: Schema.Boolean;
        readonly recording: Schema.NullOr<Schema.Struct<{
            readonly url: Schema.NonEmptyString;
            readonly readySelector: Schema.NonEmptyString;
            readonly steps: Schema.$Array<Schema.Struct<{
                readonly kind: Schema.Literals<readonly ["click", "fill", "wait-text"]>;
                readonly selector: Schema.NonEmptyString;
                readonly value: Schema.String;
            }>>;
        }>>;
        readonly channels: Schema.Struct<{
            readonly changelog: Schema.Boolean;
            readonly blog: Schema.Boolean;
            readonly thread: Schema.Boolean;
            readonly media: Schema.Boolean;
        }>;
        readonly title: Schema.String;
        readonly notes: Schema.String;
        readonly minScore: Schema.Finite;
        readonly maxRevisions: Schema.Int;
        readonly maxTweets: Schema.Int;
        readonly maxTweetChars: Schema.Int;
    }>;
    evidence: Schema.Struct<{
        readonly version: Schema.String;
        readonly currentVersion: Schema.String;
        readonly sourceSha: Schema.String;
        readonly from: Schema.String;
        readonly date: Schema.String;
        readonly commits: Schema.String;
        readonly changes: Schema.String;
        readonly documents: Schema.String;
        readonly recordings: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly sources: Schema.$Array<Schema.String>;
        readonly gates: Schema.optionalKey<Schema.Struct<{
            readonly ran: Schema.$Array<Schema.String>;
            readonly exceptions: Schema.$Array<Schema.Struct<{
                readonly name: Schema.String;
                readonly command: Schema.String;
                readonly reason: Schema.String;
            }>>;
        }>>;
    }>;
    analysis: Schema.Struct<{
        readonly title: Schema.String;
        readonly summary: Schema.String;
        readonly highlights: Schema.$Array<Schema.String>;
        readonly risks: Schema.$Array<Schema.String>;
        readonly migration: Schema.$Array<Schema.String>;
        readonly claims: Schema.$Array<Schema.Struct<{
            readonly id: Schema.String;
            readonly text: Schema.String;
            readonly sources: Schema.$Array<Schema.String>;
        }>>;
    }>;
    brief: Schema.Struct<{
        readonly angle: Schema.String;
        readonly outline: Schema.$Array<Schema.String>;
        readonly template: Schema.String;
    }>;
    draft: Schema.Struct<{
        readonly changelog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly blog: Schema.Struct<{
            readonly text: Schema.String;
            readonly claimIds: Schema.$Array<Schema.String>;
        }>;
        readonly thread: Schema.Struct<{
            readonly tweets: Schema.$Array<Schema.Struct<{
                readonly text: Schema.String;
                readonly claimIds: Schema.$Array<Schema.String>;
            }>>;
        }>;
    }>;
    review: Schema.Struct<{
        readonly passed: Schema.Boolean;
        readonly score: Schema.Number;
        readonly feedback: Schema.$Array<Schema.String>;
    }>;
}>, Schema.Struct<{
    readonly directory: Schema.String;
    readonly digest: Schema.String;
    readonly version: Schema.String;
    readonly sourceSha: Schema.String;
    readonly files: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly digest: Schema.String;
    }>>;
    readonly approvalPrompt: Schema.String;
}>, typeof ReleaseError, Action.Requirement<"release-content/write-preview">>;
export declare const RecordApproval: Action.Declared<"release-content/record-approval", Schema.Struct<{
    artifact: Schema.Struct<{
        readonly directory: Schema.String;
        readonly digest: Schema.String;
        readonly version: Schema.String;
        readonly sourceSha: Schema.String;
        readonly files: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly approvalPrompt: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly directory: Schema.String;
    readonly digest: Schema.String;
    readonly version: Schema.String;
    readonly sourceSha: Schema.String;
    readonly files: Schema.$Array<Schema.Struct<{
        readonly path: Schema.String;
        readonly digest: Schema.String;
    }>>;
    readonly approvalPrompt: Schema.String;
}>, typeof ReleaseError, Action.Requirement<"release-content/record-approval">>;
export declare const PublishFiles: Action.Declared<"release-content/publish-files", Schema.Struct<{
    artifact: Schema.Struct<{
        readonly directory: Schema.String;
        readonly digest: Schema.String;
        readonly version: Schema.String;
        readonly sourceSha: Schema.String;
        readonly files: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly approvalPrompt: Schema.String;
    }>;
}>, Schema.$Array<Schema.String>, typeof ReleaseError, Action.Requirement<"release-content/publish-files">>;
export declare const PostThread: Action.Declared<"release-content/post-thread", Schema.Struct<{
    artifact: Schema.Struct<{
        readonly directory: Schema.String;
        readonly digest: Schema.String;
        readonly version: Schema.String;
        readonly sourceSha: Schema.String;
        readonly files: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly approvalPrompt: Schema.String;
    }>;
}>, Schema.$Array<Schema.String>, typeof ReleaseError, Action.Requirement<"release-content/post-thread">>;
export declare const CommitFiles: Action.Declared<"release-content/commit-files", Schema.Struct<{
    artifact: Schema.Struct<{
        readonly directory: Schema.String;
        readonly digest: Schema.String;
        readonly version: Schema.String;
        readonly sourceSha: Schema.String;
        readonly files: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly approvalPrompt: Schema.String;
    }>;
    files: Schema.$Array<Schema.String>;
}>, Schema.$Array<Schema.String>, typeof ReleaseError, Action.Requirement<"release-content/commit-files">>;
export declare const Outcome: Action.Declared<"release-content/outcome", Schema.Struct<{
    readonly status: Schema.Literals<readonly ["preview", "approved", "declined", "published"]>;
    readonly artifact: Schema.Struct<{
        readonly directory: Schema.String;
        readonly digest: Schema.String;
        readonly version: Schema.String;
        readonly sourceSha: Schema.String;
        readonly files: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly approvalPrompt: Schema.String;
    }>;
    readonly files: Schema.$Array<Schema.String>;
    readonly tweetIds: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["preview", "approved", "declined", "published"]>;
    readonly artifact: Schema.Struct<{
        readonly directory: Schema.String;
        readonly digest: Schema.String;
        readonly version: Schema.String;
        readonly sourceSha: Schema.String;
        readonly files: Schema.$Array<Schema.Struct<{
            readonly path: Schema.String;
            readonly digest: Schema.String;
        }>>;
        readonly approvalPrompt: Schema.String;
    }>;
    readonly files: Schema.$Array<Schema.String>;
    readonly tweetIds: Schema.$Array<Schema.String>;
}>, Schema.Never, Action.Requirement<"release-content/outcome">>;
