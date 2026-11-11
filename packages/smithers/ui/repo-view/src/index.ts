/**
 * `@smthrs/repo-view`
 *
 * The heavy views of a repository: the repository browser (`RepoView`), one
 * file highlighted by Shiki (`CodeFileView`), a highlighted diff
 * (`PierreDiffView`), the Milkdown Markdown editor (`MarkdownEditor`) and a
 * file's text in CodeMirror, edited together (`CodeEditor`).
 * They live apart from `@smthrs/ui` so a page that shows no code never pays
 * for `@pierre/diffs`, Shiki or Milkdown. Grammars, themes and the editor's
 * modules still load only when a view needs them.
 */
export {
  RepoView,
  type RepoViewCode,
  type RepoViewFile,
  type RepoViewHtmlMode,
  type RepoViewLocation,
  type RepoViewMarkdownMode,
  type RepoViewProps,
  type RepoViewSize,
  type RepoViewTree,
} from "./RepoView";
export {
  guardDocument,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SANDBOX,
  HtmlPreview,
  type HtmlPreviewProps,
  previewDocument,
} from "./HtmlPreview";
export {
  CODE_VIEW_REST_MS,
  CodeFileView,
  codeMarksCss,
  languageForFile,
  type CodeFileViewProps,
  type CodeHover,
  type CodeLineAnnotation,
  type CodeMark,
  type CodeProblem,
  type CodeTokenPosition,
  type CodeViewMode,
} from "./CodeFileView";
export { type CodeSymbol, type CursorKey, isSymbolText, moveCursor } from "./symbols";
export {
  SymbolsPane,
  type SymbolsPaneLocation,
  type SymbolsPaneOutlineItem,
  type SymbolsPaneProps,
  type SymbolsPaneSymbol,
} from "./SymbolsPane";
export {
  CODE_VIEW_POOL_DEADLINE_MS,
  currentCodeViewPool,
  disposeCodeViewPool,
  subscribeCodeViewPool,
  type CodeViewPool,
  type CodeViewPoolState,
} from "./workerPool";
export {
  diffStyleForLayout,
  diffsThemeForMode,
  normalizeDiffPath,
  patchToCodeViewItems,
  PierreDiffView,
  type PierreDiffLayout,
  type PierreDiffMode,
  type PierreDiffViewProps,
} from "./PierreDiffView";
export { CodeEditor, type CodeEditorProps } from "./CodeEditor";
export { LiveMarkdownEditor, type LiveMarkdownEditorProps } from "./LiveMarkdownEditor";
export {
  MarkdownEditor,
  MarkdownEditorStyles,
  markdownEditorCss,
  MARKDOWN_EDITOR_STYLE_ATTR,
  supportsRichTextEditing,
  type MarkdownEditorError,
  type MarkdownEditorErrorCode,
  type MarkdownEditorHandle,
  type MarkdownEditorModule,
  type MarkdownEditorProps,
} from "./MarkdownEditor";
export { REPO_VIEW_STYLE_ATTR, repoViewCss, RepoViewStyles } from "./styles";
