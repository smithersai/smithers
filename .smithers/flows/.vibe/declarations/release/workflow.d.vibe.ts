import { Schema } from "effect";
import * as AgentAction from "@smthrs/agent/AgentAction";
import { Action } from "@smthrs/flow";
import { ReleaseError } from "../../../release-support/schema.ts";
export declare const AuditDocs: AgentAction.AgentAction<"release/audit-documentation", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly phase: Schema.Literals<readonly ["prepare", "publish"]>;
        readonly dryRun: Schema.Boolean;
        readonly contentArtifact: Schema.String;
        readonly requireContentApproval: Schema.Boolean;
        readonly provenance: Schema.Boolean;
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
    readonly passed: Schema.Boolean;
    readonly missing: Schema.$Array<Schema.String>;
    readonly explanation: Schema.String;
}>>;
export declare const PreparePlan: Action.Declared<"release/prepare-plan", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly phase: Schema.Literals<readonly ["prepare", "publish"]>;
        readonly dryRun: Schema.Boolean;
        readonly contentArtifact: Schema.String;
        readonly requireContentApproval: Schema.Boolean;
        readonly provenance: Schema.Boolean;
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
    audit: Schema.Struct<{
        readonly passed: Schema.Boolean;
        readonly missing: Schema.$Array<Schema.String>;
        readonly explanation: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly directory: Schema.String;
    readonly approvalPrompt: Schema.String;
}>, typeof ReleaseError, Action.Requirement<"release/prepare-plan">>;
export declare const WritePreparation: Action.Declared<"release/write-preparation", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly phase: Schema.Literals<readonly ["prepare", "publish"]>;
        readonly dryRun: Schema.Boolean;
        readonly contentArtifact: Schema.String;
        readonly requireContentApproval: Schema.Boolean;
        readonly provenance: Schema.Boolean;
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
    directory: Schema.String;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["preview", "prepared", "declined", "published"]>;
    readonly version: Schema.String;
    readonly artifact: Schema.String;
    readonly published: Schema.$Array<Schema.String>;
}>, typeof ReleaseError, Action.Requirement<"release/write-preparation">>;
export declare const Validate: Action.Declared<"release/validate", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly phase: Schema.Literals<readonly ["prepare", "publish"]>;
        readonly dryRun: Schema.Boolean;
        readonly contentArtifact: Schema.String;
        readonly requireContentApproval: Schema.Boolean;
        readonly provenance: Schema.Boolean;
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
    audit: Schema.Struct<{
        readonly passed: Schema.Boolean;
        readonly missing: Schema.$Array<Schema.String>;
        readonly explanation: Schema.String;
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
}>, typeof ReleaseError, Action.Requirement<"release/validate">>;
export declare const Checks: Action.Declared<"release/checks", Schema.Struct<{
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
}>, typeof ReleaseError, Action.Requirement<"release/checks">>;
export declare const Build: Action.Declared<"release/build", Schema.Struct<{
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
}>, typeof ReleaseError, Action.Requirement<"release/build">>;
export declare const Pack: Action.Declared<"release/pack", Schema.Struct<{
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
    readonly directory: Schema.String;
    readonly digest: Schema.String;
    readonly sourceSha: Schema.String;
    readonly version: Schema.String;
    readonly packageCount: Schema.Number;
    readonly approvalPrompt: Schema.String;
}>, typeof ReleaseError, Action.Requirement<"release/pack">>;
export declare const Smoke: Action.Declared<"release/smoke", Schema.Struct<{
    candidate: Schema.Struct<{
        readonly directory: Schema.String;
        readonly digest: Schema.String;
        readonly sourceSha: Schema.String;
        readonly version: Schema.String;
        readonly packageCount: Schema.Number;
        readonly approvalPrompt: Schema.String;
    }>;
    runtime: Schema.Literals<readonly ["26.4.0"]>;
}>, Schema.Struct<{
    readonly directory: Schema.String;
    readonly digest: Schema.String;
    readonly sourceSha: Schema.String;
    readonly version: Schema.String;
    readonly packageCount: Schema.Number;
    readonly approvalPrompt: Schema.String;
}>, typeof ReleaseError, Action.Requirement<"release/smoke">>;
export declare const VerifyCandidate: Action.Declared<"release/verify-candidate", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly phase: Schema.Literals<readonly ["prepare", "publish"]>;
        readonly dryRun: Schema.Boolean;
        readonly contentArtifact: Schema.String;
        readonly requireContentApproval: Schema.Boolean;
        readonly provenance: Schema.Boolean;
    }>;
    candidate: Schema.Struct<{
        readonly directory: Schema.String;
        readonly digest: Schema.String;
        readonly sourceSha: Schema.String;
        readonly version: Schema.String;
        readonly packageCount: Schema.Number;
        readonly approvalPrompt: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly directory: Schema.String;
    readonly digest: Schema.String;
    readonly sourceSha: Schema.String;
    readonly version: Schema.String;
    readonly packageCount: Schema.Number;
    readonly approvalPrompt: Schema.String;
}>, typeof ReleaseError, Action.Requirement<"release/verify-candidate">>;
export declare const Publish: Action.Declared<"release/publish", Schema.Struct<{
    input: Schema.Struct<{
        readonly version: Schema.NonEmptyString;
        readonly from: Schema.NonEmptyString;
        readonly phase: Schema.Literals<readonly ["prepare", "publish"]>;
        readonly dryRun: Schema.Boolean;
        readonly contentArtifact: Schema.String;
        readonly requireContentApproval: Schema.Boolean;
        readonly provenance: Schema.Boolean;
    }>;
    candidate: Schema.Struct<{
        readonly directory: Schema.String;
        readonly digest: Schema.String;
        readonly sourceSha: Schema.String;
        readonly version: Schema.String;
        readonly packageCount: Schema.Number;
        readonly approvalPrompt: Schema.String;
    }>;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["preview", "prepared", "declined", "published"]>;
    readonly version: Schema.String;
    readonly artifact: Schema.String;
    readonly published: Schema.$Array<Schema.String>;
}>, typeof ReleaseError, Action.Requirement<"release/publish">>;
export declare const Outcome: Action.Declared<"release/outcome", Schema.Struct<{
    readonly status: Schema.Literals<readonly ["preview", "prepared", "declined", "published"]>;
    readonly version: Schema.String;
    readonly artifact: Schema.String;
    readonly published: Schema.$Array<Schema.String>;
}>, Schema.Struct<{
    readonly status: Schema.Literals<readonly ["preview", "prepared", "declined", "published"]>;
    readonly version: Schema.String;
    readonly artifact: Schema.String;
    readonly published: Schema.$Array<Schema.String>;
}>, Schema.Never, Action.Requirement<"release/outcome">>;
