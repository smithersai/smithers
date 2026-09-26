# Collaborative repository Wiki

The app's repository Wiki reuses the existing conversation card, Milkdown Markdown editor, frame graph and `worldDocuments` TanStack DB collection. Its backend contract is the repository Wiki API. The cloud connection is an internal Effect service over the controller's existing `fetch` and cloud proxy URL; it adds no public gateway mechanism, database interface or Node sidecar.

## One document, two revision domains

A local Wiki row keeps its ordinary app `revision`, which is never used as the remote page revision. The optional `cloud` state on the same row records the repository, numeric page ID, current slug, remote revision, author and update time, base64 Yjs state, account, branch, phase (`cached`, `live`, `offline` or `deleted`), error and pending updates. Each pending update has a UUID, the update bytes and a `user` or `smithers` actor.

The row's stable ID contains the repository and page ID, so reusing a deleted slug cannot retarget pending updates to a new page.

## Persist before sending, acknowledge exact edits

Local Markdown edits splice the changed range into `Y.Text("markdown")`. The dispatcher persists the updated state and the UUID, exact delta bytes and actor before posting. Only one post per page is outstanding. An acknowledgement must match the UUID and page ID, and its causal state must contain the submitted delta, including deletions; it removes only that pending entry and merges with newer local edits. A lost response keeps the original UUID and bytes for retry. A timer, an unrelated revision or a newer page body never counts as an acknowledgement.

The revision stream resumes from the last applied page revision, and its events trigger a refresh. Reconnection does not resend a pending edit; Refresh or a subsequent edit retries the queue. After reload or a branch change, an explicit refresh resumes collaboration. Deletion keeps unsent edits locally and disables writes to the removed page.

## App flow doors

These are app flow registrations with typed inputs:

- `wiki.cloud` `{repo, page?}` browses a repository Wiki.
- `wiki.cloud.open` `{slug, repo}` opens a page in the conversation.
- `wiki.sync` `{documentId}` refreshes a page and retries its saved edits.
- `wiki.edit` `{documentId, body}` edits a page as Markdown.
- `wiki.card.select` `{cardId, documentId}` and `wiki.card.view` `{cardId, view}` are hidden flows that change an embedded card's selection and its `outline` or `document` view.

## Limits of this slice

Transport success does not make a page semantically fresh; semantic freshness belongs to the dependency-bound Wiki workflow. Client fixtures do not establish deployment readiness or a deployed two-client canary. Presence cursors, collaborative selection or undo, and a ProseMirror operation binding are not implemented, and a peer update can move the caret.
