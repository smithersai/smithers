# @mr-burns/web

React + Vite frontend for the Mr. Burns local control plane.

## What this app does

- Renders the workspace-first UI shell
- Manages active workspace context
- Lists and previews workflows from daemon API
- Supports AI-assisted workflow generation and editing flows
- Shows runs, approvals, and settings views

## Run locally

From repository root:

```bash
bun run dev:web
```

The app expects daemon API at `http://localhost:7332` by default.

Override API base URL with:

```bash
VITE_BURNS_API_URL=http://localhost:7332
```

## Scripts

- `bun run dev`: start Vite dev server
- `bun run build`: typecheck + production build
- `bun run typecheck`: TypeScript build mode check
- `bun run lint`: ESLint
- `bun run preview`: serve built output

## Key implementation notes

- Uses React Router for route-level navigation
- Uses TanStack Query for server state
- Uses `@mr-burns/client` as the typed API layer
- Uses shadcn/base-ui components and ai-elements primitives for UI building blocks
