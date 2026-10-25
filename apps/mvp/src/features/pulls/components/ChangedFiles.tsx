import { DiffHunks, parseUnifiedFile } from "@smthrs/ui"
import type { ChangedFile } from "../schema"
import { fileStatusOf, unifiedOf } from "../view"
import "./changes.css"

// Each file two commits differ by, its name over its diff: a pull request's Files tab and a branch's Compare.
export function ChangedFiles({ files }: { readonly files: ReadonlyArray<ChangedFile> }) {
  return (
    <div className="changed-files">
      {files.map((file) => (
        <div key={file.filename}>
          <h3 className="changed-file-name">{file.filename}</h3>
          <DiffHunks file={parseUnifiedFile(unifiedOf(file), { path: file.filename, status: fileStatusOf(file.status) })} />
        </div>
      ))}
    </div>
  )
}
