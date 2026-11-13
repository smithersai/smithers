import type { Route } from "../../../core/router"
import { BlameView } from "./Blame"
import { FileView } from "./File"
import { TreeView } from "./Tree"

export const routes: Route[] = [
  {
    pattern: "smithers.sh/:owner/:repo/tree/:ref",
    name: "Repository root",
    render: ({ params }) => <TreeView path="" revision={params.ref} />,
    screens: [
      { id: "code-tree-root", route: "smithers.sh/maya/tinyhttp/tree/main?as=in&role=member&net=ok&data=full", label: "Root directory" },
      { id: "code-tree-root-signed-out", route: "smithers.sh/maya/tinyhttp/tree/main?as=out&net=ok&data=full", label: "Read root signed out" },
      { id: "code-tree-root-reader", route: "smithers.sh/maya/tinyhttp/tree/main?as=in&role=reader&net=ok&data=full", label: "Read root as reader" },
      { id: "code-tree-root-empty", route: "smithers.sh/maya/tinyhttp/tree/main?as=in&net=ok&data=empty", label: "Empty root" }
    ]
  },
  {
    pattern: "smithers.sh/:owner/:repo/tree/:ref/*",
    name: "Directory",
    render: ({ params }) => <TreeView path={params["*"]} revision={params.ref} />,
    screens: [
      { id: "code-tree-src", route: "smithers.sh/maya/tinyhttp/tree/main/src?as=in&role=member&net=ok&data=full", label: "Source directory" },
      { id: "code-tree-middleware", route: "smithers.sh/maya/tinyhttp/tree/main/src/middleware?as=in&role=member&net=ok&data=full", label: "Middleware directory" },
      { id: "code-tree-empty", route: "smithers.sh/maya/tinyhttp/tree/main/src/middleware?as=in&net=ok&data=empty", label: "Empty folder" },
      { id: "code-tree-loading", route: "smithers.sh/maya/tinyhttp/tree/main/src?as=in&net=slow&data=full", label: "Loading directory", wait: 120 },
      { id: "code-tree-error", route: "smithers.sh/maya/tinyhttp/tree/main/src?as=in&net=error&data=full", label: "Directory sync failed" },
      { id: "code-tree-signed-out", route: "smithers.sh/maya/tinyhttp/tree/main/src?as=out&net=ok&data=full", label: "Read directory signed out" },
      { id: "code-tree-reader", route: "smithers.sh/maya/tinyhttp/tree/main/src?as=in&role=reader&net=ok&data=full", label: "Read directory as reader" },
      { id: "code-tree-not-found", route: "smithers.sh/maya/tinyhttp/tree/main/src/missing?as=in&net=ok&data=full", label: "Missing directory" }
    ]
  },
  {
    pattern: "smithers.sh/:owner/:repo/blob/:ref/*",
    name: "File",
    render: ({ params }) => <FileView path={params["*"]} revision={params.ref} />,
    screens: [
      { id: "code-blob-router", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?as=in&role=member&net=ok&data=full", label: "Router source" },
      { id: "code-blob-tag", route: "smithers.sh/maya/tinyhttp/blob/v0.4.2/src/router.ts?as=out&net=ok&data=full", label: "File at a tag" },
      { id: "code-blob-smithers-omitted", route: "smithers.sh/smithers-canary/smithers/blob/main/.dockerignore?as=out&net=ok&data=full", label: "File contents omitted from mock" },
      { id: "code-blob-effect-omitted", route: "smithers.sh/Effect-TS/effect/blob/main/.envrc?as=out&net=ok&data=full", label: "Monorepo environment file" },
      { id: "code-blob-lines", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?L=40-52&as=in&role=member&net=ok&data=full", label: "Selected router lines" },
      { id: "code-blob-diagnostic", route: "smithers.sh/maya/tinyhttp/blob/main/src/middleware/cors.ts?as=in&role=member&net=ok&data=full", label: "CORS warning" },
      { id: "code-blob-readme", route: "smithers.sh/maya/tinyhttp/blob/main/README.md?as=in&net=ok&data=full&view=preview", label: "Markdown preview" },
      { id: "code-blob-readme-code", route: "smithers.sh/maya/tinyhttp/blob/main/README.md?as=in&net=ok&data=full&view=code", label: "Markdown source" },
      { id: "code-blob-raw", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?as=in&net=ok&data=full&raw=1", label: "Raw file" },
      { id: "code-blob-loading", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?as=in&net=slow&data=full", label: "Loading file", wait: 120 },
      { id: "code-blob-error", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?as=in&net=error&data=full", label: "File sync failed" },
      { id: "code-blob-empty", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?as=in&net=ok&data=empty", label: "Empty file" },
      { id: "code-blob-not-found", route: "smithers.sh/maya/tinyhttp/blob/main/src/foo.ts?as=in&net=ok&data=full", label: "Missing path" },
      { id: "code-blob-image-not-found", route: "smithers.sh/maya/tinyhttp/blob/main/assets/router.png?as=in&net=ok&data=full", label: "Missing image path" },
      { id: "code-blob-todo", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?L=40-52&todo=1&as=in&role=member&net=ok&data=full", label: "Make TODO from lines" },
      { id: "code-blob-signed-out", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?as=out&role=reader&net=ok&data=full", label: "Read signed out" },
      { id: "code-blob-signin-wall", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?L=40-52&todo=1&as=out&net=ok&data=full", label: "Sign in to make TODO" },
      { id: "code-blob-reader", route: "smithers.sh/maya/tinyhttp/blob/main/src/router.ts?L=40-52&todo=1&as=in&role=reader&net=ok&data=full", label: "Reader cannot make TODO" }
    ]
  },
  {
    pattern: "smithers.sh/:owner/:repo/blame/:ref/*",
    name: "Line history",
    render: ({ params }) => <BlameView path={params["*"]} revision={params.ref} />,
    screens: [
      { id: "code-blame-router", route: "smithers.sh/maya/tinyhttp/blame/main/src/router.ts?as=in&role=member&net=ok&data=full", label: "Router blame" },
      { id: "code-blame-agent", route: "smithers.sh/maya/tinyhttp/blame/main/src/router.ts?L=16-20&as=in&role=member&net=ok&data=full", label: "Agent range and linked run" },
      { id: "code-blame-readme", route: "smithers.sh/maya/tinyhttp/blame/main/README.md?as=in&net=ok&data=full", label: "README blame" },
      { id: "code-blame-loading", route: "smithers.sh/maya/tinyhttp/blame/main/src/router.ts?as=in&net=slow&data=full", label: "Loading blame", wait: 120 },
      { id: "code-blame-error", route: "smithers.sh/maya/tinyhttp/blame/main/src/router.ts?as=in&net=error&data=full", label: "Blame sync failed" },
      { id: "code-blame-empty", route: "smithers.sh/maya/tinyhttp/blame/main/src/router.ts?as=in&net=ok&data=empty", label: "No line history" },
      { id: "code-blame-reader", route: "smithers.sh/maya/tinyhttp/blame/main/src/router.ts?as=in&role=reader&net=ok&data=full", label: "Read blame as reader" },
      { id: "code-blame-signed-out", route: "smithers.sh/maya/tinyhttp/blame/main/README.md?as=out&net=ok&data=full", label: "Read blame signed out" }
    ]
  }
]
