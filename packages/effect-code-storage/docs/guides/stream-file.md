# Stream an original file

Use `client.streamFile(repo, { path, ref, namespace? })` for downloads. It returns
`{ stream, blobSha }`, using the same repository-scoped `git:read` token as
`readFile`. The Effect stream consumes chunks on demand, counts consumed bytes,
and reports body failures as `CodeStorageError` with code `transport`.

Unlike `readFile`, it does not buffer or impose a preview cap. The consumer owns
its byte budget and cancellation; stopping the stream cancels the response body.
Use `readFile` for a bounded, buffered preview.
