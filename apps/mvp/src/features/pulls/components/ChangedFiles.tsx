import { Card, DiffHunks, parseUnifiedFile } from "@smthrs/ui"
import type { ChangedFile } from "../schema"
import { fileStatusOf, unifiedOf } from "../view"
import "./changes.css"

// Each file two commits differ by, a card each: its name in a header that stays while its diff scrolls, then the
// diff. A pull request's Files tab and a branch's Compare.
export function ChangedFiles({ files }: { readonly files: ReadonlyArray<ChangedFile> }) {
  return (
    <div className="changed-files">
      {files.map((file) => (
        <Card key={file.filename} className="changed-file">
          <h3 className="changed-file-name">{file.filename}</h3>
          <DiffHunks file={parseUnifiedFile(unifiedOf(file), { path: file.filename, status: fileStatusOf(file.status) })} />
        </Card>
      ))}
    </div>
  )
}
