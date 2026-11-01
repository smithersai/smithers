/**
 * Schemas for the GitHub webhook payloads this package types.
 *
 * GitHub payloads are large and evolve without notice, so every schema here
 * validates the fields a caller is likely to read and passes everything else
 * through untouched. A real delivery is never rejected for carrying a field
 * this package has not heard of.
 *
 * @since 1.0.0
 */
import { Schema } from "effect";
/**
 * A GitHub account.
 *
 * `type` distinguishes a person from a GitHub App, so the field is modelled
 * rather than left to the open rest.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const User: Schema.StructWithRest<Schema.Struct<{
    login: Schema.String;
    id: Schema.optional<Schema.Number>;
    type: Schema.optional<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
/**
 * How the author of a comment, issue, or pull request relates to the
 * repository, as GitHub sends it on every author-attributed delivery. It names
 * the author's standing, not who last edited the text, so it is not an
 * authorization signal.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const AuthorAssociation: Schema.String;
/**
 * A repository, as embedded in a webhook payload.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Repository: Schema.StructWithRest<Schema.Struct<{
    full_name: Schema.String;
    name: Schema.optional<Schema.String>;
    owner: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        login: Schema.String;
        id: Schema.optional<Schema.Number>;
        type: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
    default_branch: Schema.optional<Schema.String>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
/**
 * A pull request.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PullRequest: Schema.StructWithRest<Schema.Struct<{
    number: Schema.Number;
    author_association: Schema.optional<Schema.String>;
    title: Schema.optional<Schema.String>;
    state: Schema.optional<Schema.String>;
    html_url: Schema.optional<Schema.String>;
    body: Schema.optional<Schema.NullOr<Schema.String>>;
    draft: Schema.optional<Schema.Boolean>;
    merged: Schema.optional<Schema.Boolean>;
    user: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        login: Schema.String;
        id: Schema.optional<Schema.Number>;
        type: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
    head: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        ref: Schema.String;
        sha: Schema.String;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
    base: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        ref: Schema.String;
        sha: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
/**
 * An issue.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Issue: Schema.StructWithRest<Schema.Struct<{
    number: Schema.Number;
    author_association: Schema.optional<Schema.String>;
    title: Schema.optional<Schema.String>;
    state: Schema.optional<Schema.String>;
    html_url: Schema.optional<Schema.String>;
    body: Schema.optional<Schema.NullOr<Schema.String>>;
    user: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        login: Schema.String;
        id: Schema.optional<Schema.Number>;
        type: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
    labels: Schema.optional<Schema.$Array<Schema.Unknown>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
/**
 * An issue or pull-request comment.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Comment: Schema.StructWithRest<Schema.Struct<{
    id: Schema.optional<Schema.Number>;
    author_association: Schema.optional<Schema.String>;
    body: Schema.optional<Schema.String>;
    html_url: Schema.optional<Schema.String>;
    user: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        login: Schema.String;
        id: Schema.optional<Schema.Number>;
        type: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
/**
 * A `pull_request` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PullRequestEvent: Schema.StructWithRest<Schema.Struct<{
    action: Schema.String;
    number: Schema.optional<Schema.Number>;
    pull_request: Schema.StructWithRest<Schema.Struct<{
        number: Schema.Number;
        author_association: Schema.optional<Schema.String>;
        title: Schema.optional<Schema.String>;
        state: Schema.optional<Schema.String>;
        html_url: Schema.optional<Schema.String>;
        body: Schema.optional<Schema.NullOr<Schema.String>>;
        draft: Schema.optional<Schema.Boolean>;
        merged: Schema.optional<Schema.Boolean>;
        user: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            login: Schema.String;
            id: Schema.optional<Schema.Number>;
            type: Schema.optional<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
        head: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            ref: Schema.String;
            sha: Schema.String;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
        base: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            ref: Schema.String;
            sha: Schema.optional<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
    repository: Schema.StructWithRest<Schema.Struct<{
        full_name: Schema.String;
        name: Schema.optional<Schema.String>;
        owner: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            login: Schema.String;
            id: Schema.optional<Schema.Number>;
            type: Schema.optional<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
        default_branch: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
    sender: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        login: Schema.String;
        id: Schema.optional<Schema.Number>;
        type: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
/**
 * An `issues` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const IssuesEvent: Schema.StructWithRest<Schema.Struct<{
    action: Schema.String;
    issue: Schema.StructWithRest<Schema.Struct<{
        number: Schema.Number;
        author_association: Schema.optional<Schema.String>;
        title: Schema.optional<Schema.String>;
        state: Schema.optional<Schema.String>;
        html_url: Schema.optional<Schema.String>;
        body: Schema.optional<Schema.NullOr<Schema.String>>;
        user: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            login: Schema.String;
            id: Schema.optional<Schema.Number>;
            type: Schema.optional<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
        labels: Schema.optional<Schema.$Array<Schema.Unknown>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
    repository: Schema.StructWithRest<Schema.Struct<{
        full_name: Schema.String;
        name: Schema.optional<Schema.String>;
        owner: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            login: Schema.String;
            id: Schema.optional<Schema.Number>;
            type: Schema.optional<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
        default_branch: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
    sender: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        login: Schema.String;
        id: Schema.optional<Schema.Number>;
        type: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
/**
 * An `issue_comment` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const IssueCommentEvent: Schema.StructWithRest<Schema.Struct<{
    action: Schema.String;
    issue: Schema.StructWithRest<Schema.Struct<{
        number: Schema.Number;
        author_association: Schema.optional<Schema.String>;
        title: Schema.optional<Schema.String>;
        state: Schema.optional<Schema.String>;
        html_url: Schema.optional<Schema.String>;
        body: Schema.optional<Schema.NullOr<Schema.String>>;
        user: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            login: Schema.String;
            id: Schema.optional<Schema.Number>;
            type: Schema.optional<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
        labels: Schema.optional<Schema.$Array<Schema.Unknown>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
    comment: Schema.StructWithRest<Schema.Struct<{
        id: Schema.optional<Schema.Number>;
        author_association: Schema.optional<Schema.String>;
        body: Schema.optional<Schema.String>;
        html_url: Schema.optional<Schema.String>;
        user: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            login: Schema.String;
            id: Schema.optional<Schema.Number>;
            type: Schema.optional<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
    repository: Schema.StructWithRest<Schema.Struct<{
        full_name: Schema.String;
        name: Schema.optional<Schema.String>;
        owner: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            login: Schema.String;
            id: Schema.optional<Schema.Number>;
            type: Schema.optional<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
        default_branch: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
    sender: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        login: Schema.String;
        id: Schema.optional<Schema.Number>;
        type: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
/**
 * A `push` delivery.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const PushEvent: Schema.StructWithRest<Schema.Struct<{
    ref: Schema.String;
    before: Schema.optional<Schema.String>;
    after: Schema.optional<Schema.String>;
    repository: Schema.StructWithRest<Schema.Struct<{
        full_name: Schema.String;
        name: Schema.optional<Schema.String>;
        owner: Schema.optional<Schema.StructWithRest<Schema.Struct<{
            login: Schema.String;
            id: Schema.optional<Schema.Number>;
            type: Schema.optional<Schema.String>;
        }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
        default_branch: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
    commits: Schema.optional<Schema.$Array<Schema.StructWithRest<Schema.Struct<{
        id: Schema.optional<Schema.String>;
        message: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>>;
    pusher: Schema.optional<Schema.StructWithRest<Schema.Struct<{
        name: Schema.optional<Schema.String>;
    }>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>>;
}>, readonly [Schema.$Record<Schema.String, Schema.Unknown>]>;
