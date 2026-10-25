---
"@smthrs/repo-view": minor
---

`RepoView` takes `markdownPreview`: a host's preview of a Markdown file, shown in place of the read-only document in preview mode once the file's text has loaded, an empty file included. Pass a `LiveMarkdownEditor` for a person who may change the file and leave it out for anyone else; Code still shows the source, and a directory's README stays the read-only document.
