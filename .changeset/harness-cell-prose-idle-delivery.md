---
"@smthrs/harness": major
---

Keep cell source out of supervisor prose and memory mining, including replies
whose cells contain inline backticks. Deliver queued follow-ups when a turn
would otherwise go idle, and name the current `verification` variable in
invalid-probe notices.

Remove the unused `Transcript.projectStateResult` and
`Transcript.projectResult` exports and their projection-only
`TranscriptErrorCode`, `TranscriptError`, `ProjectedMessage`,
`ProjectedState`, and `CellEvidence` types. Resume validation and external
transcript decoders remain available. Remove `Steering.Drain.queued`;
older `DrainRecord` values carrying `queued` still decode.
