# Web pages

`app/web/open { url, mode? }` opens an outside web page for the person. A person runs it with `/web <url> [embed|tab]`; the agent calls it from a cell when someone asks to see a page ("show me the Effect docs", "open https://… in a new tab"). It never navigates the app and never opens a tab on its own: it adds a view to the conversation that shows the page's origin. Will, 2026-10-20: "Add a flow where an agent can open a webpage in the chat iframe view or in a new tab too". Decisions: [0003](../decisions/0003-flows-and-the-agent.md), [0004](../decisions/0004-agent-ui-codemode-and-rendering.md), [0011](../decisions/0011-the-agent-runs-in-the-browser.md).

Will, 2026-10-20, 18:18: "some web pages don't allow us to embed as an iframe and we should gracefully handle that". So the flow asks the page first, from the server, and shows a card in place of a frame the page would refuse.

```
person: /web <url> [tab]  ──(Enter, in the keypress)──▶ tab mode and the browser allows it: window.open, no flow, nothing added
          │ refused by the policy ─▶ the composer keeps the line and says why
          └─▶ FlowDispatch("app/web/open", door slash)
agent:  ctx.call("app/web/open", { url, mode }) ─▶ child execution on the same engine
                                   │
app/web/open ─ app/web/check   (sealed: the URL against the policy, and the view's id)
             ─ app/web/preview ─ POST /api/web/preview { url, mode } ─▶ ChatApi requests the page as a frame would
             │                     (WebPage.check, @smthrs/views) ◀─ { framing, reason?, title?, description?, icon? }
             ─ app/web/show    ─ POST /api/views { id, template, props: { url, title, description, icon } }
                                   ─▶ Postgres `views` ─▶ Electric ─▶ every device
conversation: view row ─ webpage (embed, framing allowed): WebPageView (origin · Full screen · Open in new tab, then the
                         sandboxed frame, under the page's preview until it loads)
                         link (tab, or embed of a page that refuses or couldn't be checked): WebLinkCard (icon · title ·
                         description · domain · Open in new tab ↵, a real link the person clicks)
/app/views/<id> ─ the same view at full size
```

## Modes

| Mode | What the person sees |
|---|---|
| `embed` (the default) | When the page allows framing: the page in a sandboxed frame inside the chat, with its origin above it, a **Full screen** link to `/app/views/<id>`, and an always-visible **Open in new tab** link. Until the frame loads, the page's preview covers it (fading in after 600 ms), so a page that never loads still says what it is. When the page refuses framing, or couldn't be checked: the `tab` card instead, never a blank frame. |
| `tab` | A card with the page's icon, title, short description and domain, and an **Open in new tab** button with its key (`↵`: Enter on the focused button). Browsers open a tab only from a person's click or key, and flows run in the engine worker, so the flow never opens one: the person's click or Enter does, through a real link with `rel="noopener noreferrer"`. |

A person's own `/web <url> tab` is different: it runs synchronously in their Enter (the slash command's `submit`), and when the browser still allows it (`navigator.userActivation.isActive`), opens the tab right there, with `noopener,noreferrer`, and runs no flow. `window.open` takes the keypress's activation when it opens a tab, so an activation still there afterwards means the browser refused; then, or when the browser can't say, the flow runs and adds the card instead. The app never claims a tab it didn't open.

## Well-known docs

"Show me the Effect docs" opens `https://effect.website/docs`. The flow's description names the page for each well-known docs site (`KNOWN_DOCS` in `src/features/web/contract.ts`: Effect, React, TypeScript, TanStack and Cloudflare Workers), and the agent opens exactly that page; for any other site it picks the URL itself. Before 2026-10-20 it guessed, and three of eight [agent eval](agent-evals.md) runs opened `effect-ts.dev`, `docs.effect.website` or `effect-ts.github.io`; after, eight of eight opened `effect.website/docs`. Each listed page opens embedded under the production policy (`src/features/web/url.test.ts`).

## Which pages

`checkUrl(url, mode, policy)` (`src/features/web/url.ts`) is the one check. The flow's step, a person's `/web` and ChatApi all run it. An unparseable or non-HTTP(S) application origin refuses every page as `invalid`, because its host and site cannot be checked.

| Refusal | When |
|---|---|
| `invalid` | not an absolute URL, or longer than 2,048 characters |
| `scheme` | anything but `https:` or `http:`: `javascript:`, `data:`, `file:`, `blob:`, `about:` and the rest, however written (ASCII tab and newline are dropped first, as browsers do) |
| `insecure` | `http:`, except a new tab of `localhost` while the app runs under the dev server |
| `credentials` | the URL names a user or a password |
| `same_origin` | the app's own host, whatever the scheme: `/navigate` opens app pages (`app/navigate`) |
| `same_site` | `embed` of the app's site or any of its subdomains |

The agent gets the failure's kind (`WebPageRefused`), never its reason or the URL. A person's `/web` refused by the policy stays in the composer with one line saying what to do (`CANT_OPEN` in `src/features/web/contract.ts`), and nothing runs.

## Before a page is framed

A browser never tells the app why a frame of another site stays blank: a page that refuses framing with `X-Frame-Options` or a Content Security Policy `frame-ancestors` shows the browser's error, which the app can't read. So `app/web/preview` asks ChatApi, and ChatApi asks the page, as a frame would, before anything is shown: `POST /api/web/preview { url, mode }` (`worker/WebPreview.ts`), through `@smthrs/views`' `WebPage.check` ([check a web page before framing it](../../../../packages/smithers/ui/views/docs/check-a-web-page.md)).

| `framing` | When | What the conversation shows |
|---|---|---|
| `allowed` | No enforced `frame-ancestors` refuses the app's origin, and, without one, no `X-Frame-Options` `DENY` or `SAMEORIGIN` | `embed`: the page in its frame |
| `refused` | `frame_ancestors`, `x_frame_options`; `insecure` (an `http:` page under the `https:` app); `content` (a PDF, a download or an attachment, which a sandboxed frame never shows) | the card |
| `unknown` | `status` (400 or above), `timeout`, `unreachable`, `redirects`, `private_host`, `invalid_url` | the card |

Real sites as of 2026-10-20: `tanstack.com` sends `X-Frame-Options: DENY` and `developers.cloudflare.com` `frame-ancestors 'self' cloudflare.com *.cloudflare.com`, so both are cards; `effect.website`, `react.dev`, `typescriptlang.org` and `example.com` frame.

- **What it reads.** The final response's headers after up to five redirects, each guarded, and the head of an HTML page, up to `</head>` or 256 KiB: `og:title` or `<title>`, `og:description`, `description` or `twitter:description`, and the first icon link or `/favicon.ico`, kept only when `https:`. The request carries `Sec-Fetch-Dest: iframe`, so a site that answers frames differently answers this one the same way, and no cookie or credential.
- **The guard (SSRF).** The URL is someone else's choice, so ChatApi checks it against the same policy first, then `WebPage.check` refuses, before anything is sent and on every redirect: anything but `https:` or `http:`, a user or a password, every IP address literal however it is spelled (`2130706433`, `0x7f.1`, `[::ffff:127.0.0.1]`), `localhost`, single-label names, and `.localhost`, `.local`, `.internal`, `.home.arpa` and `.lan` names (`private_host`). A public name whose DNS answer is a private address is Cloudflare's to refuse: a Worker's fetch reaches public addresses only. Under `alchemy dev` (`WEB_PAGES_LOCAL_HTTP`), it also reads this machine's pages (`localhost`, `127.0.0.1`, `[::1]`). One 8 s deadline covers the response, 3 s more the head, and the step gives ChatApi 20 s (`PREVIEW_WITHIN`).
- **Kept briefly.** An answer is kept in the Worker's edge cache (`EdgeCache`, named `web`) for `WEB_PAGE_CHECK_KEPT` (5 minutes by default), by the page's URL and the app's origin, in windows of that length, so the same page asked again soon isn't requested again. By URL, not origin: one site can frame some paths and refuse others (YouTube's `/embed/` and `/watch`). The cache sees only a hash of the URL. A zero duration bypasses the cache and checks the page on every request.
- **Who asks.** Anyone signed in: a preview adds nothing anywhere, and only someone who may ask in a conversation adds it there as a view (ruling AUTH-8): `401` signed out. `400 { code: "refused" }` a page the policy won't open, `400 { code: "invalid" }` not `{ url, mode }`, `413` over 4 KiB, `405`, and `503` when the request can't be decided (sessions unreadable). A page that can't be read is never a failure: it is `200 { framing: "unknown", reason }`.
- **Journaled.** The step's answer is in the flow's journal, so a run resumed after a crash shows what it decided before, and its retry policy (`SHOW_RETRY`) tries ChatApi again while it is unreachable.
- **Pages that pass and then fail.** A page can pass the check and still fail in the frame: one that answers the browser differently, or navigates itself to a page that refuses. The frame's bar keeps **Open in new tab** always visible, and the preview covers the frame until it loads, so a frame that never loads still shows what the page is.

## What the agent hears

`app/web/open` answers `{ viewId, origin, mode, shown, framing, title? }`. `shown` is `page` only when the page is in the chat; `card` means a card with **Open in new tab** was added, because the site refuses embedding (`framing: "refused"`) or couldn't be checked (`framing: "unknown"`). The flow's description tells the agent to say it added a card that opens the page in a new tab, never that the page shows in the chat.

## Security

- **The frame.** `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"`, `referrerpolicy="no-referrer"`, `loading="lazy"`, no `allow` delegation, no top navigation and no downloads (`WEB_PAGE_SANDBOX` in `@smthrs/ui`). `allow-same-origin` gives the page its own origin, so its own cookies and storage work.
- **Why only another site, over https.** A framed page with `allow-scripts allow-same-origin` that is same-origin with the app can remove its own sandbox and reach the app's storage, session and DOM. A page on the app's site, such as a subdomain, shares its cookies. `http://localhost` on another port shares them too: cookies aren't kept apart by port. So `embed` takes `https:` pages of other sites only, and the app's own origin is refused for both modes.
- **Every side checks.** The step refuses before it adds anything; ChatApi checks again against the host the request came to before it keeps a row; and `@smthrs/ui` checks once more when it renders, against the page's own origin (`framedPageTarget` for the frame: https, not the host's site; `webPageTarget` for a card: http(s), not the host's origin). A row that slipped through still renders no frame.
- **Redirects.** A framed page may redirect anywhere, the app's own origin included, and the frame can't be inspected after it loads. So only the requested URL is checked, and the app's own pages refuse every frame: `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on every page (`public/_headers` on Cloudflare; a dev-server middleware in `vite.config.ts`, because Cloudflare's Vite plugin skips `_headers` in dev). A redirect to another page of the app's site lands under that site's own framing rules.
- **What the app frames.** `index.html` carries `Content-Security-Policy: frame-src https:` (`FRAME_POLICY`, `src/pwa.ts`), so no `javascript:`, `data:`, `blob:`, `file:` or `http:` frame loads, whatever reaches the page.
- **The service worker.** It keeps only the app's own shell (`shellCaches`, `src/pwa.ts`): never a frame's document, never another origin. An embedded page is another origin's, which this worker never sees.
- **The person sees what and where.** Every view shows the page's origin as text, and every card its domain: the host for an `https:` page, the whole origin otherwise. Nothing navigates the app away.
- **What a card loads.** Its icon only, as an `<img>` with no referrer, and only for an `https:` URL with no user or password, which ChatApi and the views schema check too (`PageProps`, `src/features/views/schema.ts`). A Member could name any https image as well as any https page, so this widens nothing.
- **`http://localhost` links.** The browser allows them only under the dev server (`import.meta.env.DEV`); ChatApi keeps them only where `WEB_PAGES_LOCAL_HTTP` says so. `alchemy dev` passes `true` as its default (`worker/DevChatApi.ts`); a deployment refuses them unless it sets the variable.

## The flow

`src/features/web/flows.ts` declares it; `src/features/web/steps.ts` runs its steps, so only an engine's host imports that.

| Step | Does |
|---|---|
| `app/web/check` | sealed: checks the URL against the host's `WebPolicy` and picks the view's id, so a run resumed after a crash adds the very view it chose before. Fails `WebPageRefused { reason }` |
| `app/web/preview` | asks ChatApi to check the page through `PreviewClient` (`POST /api/web/preview`, `src/features/web/api.ts`), and answers `@smthrs/views`' `WebPage.Checked`. Failures map as `app/web/show`'s |
| `app/web/show` | adds the view through `ViewsClient` (`POST /api/views`): `webpage` for an `embed` whose `framing` is `allowed`, else `link`, with the check's title, description and icon in `props`. A `400` from ChatApi is `WebPageRefused { reason: "invalid" }`, `401` or `403` `WebPageForbidden`, anything else `WebPageUnavailable`, which its retry policy tries again (500 ms doubling to 8 s, for at most 2 minutes) |

It answers `{ viewId, origin, mode, shown, framing, title? }`. Placement is `client`: the device asks ChatApi to read the page, so it holds no other site's response.

| Host | `WebPolicy` |
|---|---|
| the engine worker | `{ localHttp: import.meta.env.DEV, appOrigin: self.location.origin }` (`src/flows/engine.worker.ts`) |
| Node hosts in the tests | `localHttp: false` unless set (`src/flows/registrations.ts` `HostOptions`) |

## The views table

Views are conversation rows (decision 0004 §8): synced like the messages to every device and every person in the conversation. This is the table's first slice, template views; generated views add their own columns with their own migration.

| Column | |
|---|---|
| `id` | uuid, chosen by the writer, so the same add again changes nothing |
| `template` | `webpage`, `link`, or `docs`: a page of a repository's docs ([docs](docs.md#the-docs-view), migration `0039_docs_views`) |
| `props` | jsonb object: `{ url, title?, description?, icon? }`, the check's preview bounded to 200, 300 and 2,048 characters, the icon `https:` only; a `docs` view's `{ url, title, repository, path, text, truncated? }`, its Markdown read by ChatApi |
| `position` | from the messages' own sequence (`messages_position_seq`), so one number orders views and messages, in the order they were added |
| `created_at` | |

`db/migrations/0010_views.ts` creates it with `REPLICA IDENTITY FULL`.

| Route | Answers |
|---|---|
| `POST /api/views { id, template, props: { url, title?, description?, icon? } }` | `202 { txid }` added; `200 { txid: null }` the same view again; `400 { code: "invalid" }` not a view; `400 { code: "refused" }` a page it won't keep; `401`, `403 { code: "forbidden" }` for a Guest or no role on the conversation's repository, or one who may only view its branch (adding is Member or above there, like asking, ruling AUTH-8); `405`; `409 { code: "id_taken" }`; `413 { code: "too_large" }` over 8 KiB; `503 { code: "unavailable" }` |
| `GET /api/shapes/views` | Electric's `views`, through `ShapeProxy` |

| `POST /api/web/preview { url, mode }` | `200` the page's `WebPage.Checked`; `400 { code: "refused" \| "invalid" }`; `401`; `403 { code: "forbidden" }`; `405`; `413 { code: "too_large" }` over 4 KiB; `503 { code: "unavailable" }` ([before a page is framed](#before-a-page-is-framed)) |

All live in ChatApi (`worker/Views.ts` and `worker/WebPreview.ts`, routed by `worker/Chat.ts`).

## The browser

Concurrent first opens share one conversation collection and its shown query. A full-screen navigation selects its view before waiting for conversation initialization, so an earlier open cannot overwrite a later selection. `src/features/views/concurrency.test.ts` covers both races and the app-opening helper’s documentation.

| File | Holds |
|---|---|
| `src/features/views/store.ts` | `ViewsStore`: the `views` Electric collection, kept on the device, and the one view the full-screen route shows |
| `src/features/views/views.ts` | the `Views` layer: `queries.shown`, `actions.show(viewId)` (the route's navigation) |
| `src/features/views/components/ConversationView.tsx` | one view in the conversation: `WebPageView` inline with the page's preview, or `WebLinkCard` with its icon, title, description and domain |
| `src/screens/view/ViewScreen.tsx` | `/app/views/$viewId`: `WebPageView` at full size, with **Back to chat** |
| `src/features/chat/queries.ts` | the conversation: `messages ∪ views ∪ …`, a view as role `view` with its `template`, `url`, `title`, `description` and `icon`, ordered by position |
| `src/features/web/api.ts` | `PreviewClient`: `app/web/preview`'s client of `POST /api/web/preview` |
| `src/features/web/actions.ts` | a person's door: `refusedPage`, `openFromGesture`, `openWebPage`, `cardOpened`; `WebTab` is the browser's `WebHost` (`policy`, `openTab`) |
| `src/features/commands/actions.ts` | `/web` runs through `openWebPage`, door `slash` |

`WebPageView` and `WebLinkCard` come from `@smthrs/ui` ([show a web page](../../../../packages/smithers/ui/docs/guides/show-a-web-page.md)).

## Observability

One count and one log line per opening, written where its door is known: the agent's by the flow's steps in the engine worker (the agent's call is a child execution, so its id isn't its own requester, `src/flows/requests.ts`); a person's by the tab that dispatched it, once the flow answers, or at once when their `/web` opened the tab or was refused. None carries the URL, its origin or its path.

| Record | Kind | Fields |
|---|---|---|
| `web.page.open` | log | `web_mode` (`embed`, `tab`), `door`, `outcome`, `reason` on a refusal, `web_framing` once the page was checked, `feature: web`; Info when something showed, Warn otherwise |
| `web.page.open` | span, one per step and per person's opening | `smithers.web.mode`, `smithers.web.outcome`, `smithers.web.framing` |
| `smithers_web_pages_opened` | counter | `web_mode`, `door`, `outcome`: `embedded`, `card` (a `tab`, or an `embed` of a page that refused or couldn't be checked), `opened` (a person's own tab, from `/web` or a card's Open, door `view`), `refused`, `forbidden`, `unavailable` (per failed attempt); `web_framing` (`allowed`, `refused`, `unknown`) once checked |
| `chat.web.preview`, `smithers_web_previews`, `WebPage.check` | ChatApi | [observability](../observability.md#chatapi-worker): status, mode, framing and its reason, whether the answer was kept, never the URL |
| `execute_tool app/web/open` | span | the agent's call |
| `chat.view.add`, `chat.view.request`, `smithers_view_requests`, `chat.views.shape`, `smithers_view_shape_requests` | ChatApi | [observability](../observability.md#chatapi-worker) |

`WEB_TELEMETRY` (`src/features/web/contract.ts`) adds them to the relay's allowlist. The field is `web_mode`, not `mode`, because the relay keeps a field by name for every record, and `mode` is the theme flow's input.

## Tests

| Test | Proves |
|---|---|
| `src/features/web/url.test.ts` | every refusal in both modes, the app's own origin and site (`localhost:1337` included), `http://localhost` only for a dev tab, and a host's site |
| `src/features/web/web.test.ts` | the steps on the Node host's engine against ChatApi's real routes: both modes, an embed of a page that refuses framing or can't be checked becoming a card, refusals, ChatApi refusing and forbidding, a failed check and a failed add tried again once, records by door and framing with no page in them; the agent's `ctx.call` as a journaled step, a refused call failing, and the agent hearing `shown: "card"`; both clients' own failures; the gesture rules |
| `worker/WebPreview.test.ts` | `POST /api/web/preview` through `@smthrs/views`' real check: allowed, refused by `X-Frame-Options` and `frame-ancestors` against the app's origin, unreadable pages as answers, the answer kept by page and origin and asked again past `WEB_PAGE_CHECK_KEPT`, private and local hosts never requested, this machine's pages only under development (a real local server), every refusal, 503, and no page in any record |
| `packages/smithers/ui/views/test/WebPage.test.ts`, `WebPageCheck.test.ts` | the header rules, the preview reader in linear time, and the check against a real HTTP server: redirects, the SSRF guard, deadlines and the body cap |
| `src/features/views/views.test.ts` | the whole app in Node: `/web` embeds a view after the messages and a second device shows it; `tab` adds a card, or opens straight from the keypress when the browser allows it; refusals stay in the composer; a signed-out person is forbidden; the full-screen query shows only a `webpage`; a card's Open is counted |
| `worker/Views.test.ts` | every status of `POST /api/views`, the server's own check, `WEB_PAGES_LOCAL_HTTP` (production refuses `http://localhost`), and no page in any record |
| `db/Database.test.ts` "0010_views" | positions from the messages' sequence, after the messages before them, and the table's checks |
| `src/pwa.test.ts` | the service worker keeps no frame and no other origin; the page headers and the frame policy |
| `e2e/web-page.spec.ts` | the real app, against the test's own HTTPS pages on `127.0.0.1` (never an outside site): a page that allows framing shows in the chat, rendered, on a second device and at full size; one that sends `X-Frame-Options: DENY` is a card with its title, description, domain and icon, whose **Open in new tab** opens on Enter; with the real model, the agent asked to embed the refusing page adds the card, and its tab card opens a local page; a person's `/web … tab` opens straight from Enter; `javascript:` and the app's own origin are refused in the composer; the app's pages refuse framing |

Run them with the compose Postgres and Electric up (`pnpm db:up`): `pnpm exec vitest run src/features/web src/features/views worker/Views.test.ts worker/WebPreview.test.ts src/pwa.test.ts`, and `pnpm exec playwright test e2e/web-page.spec.ts` against `pnpm dev` on `:1337`. The spec's HTTPS pages use the dev certificate, which the dev Worker trusts when it is self-signed ([infrastructure](../infrastructure.md#https-and-http2)); the agent's two cases need the real model.

View writes hold the branch row lock shared with share changes, then read edit access and insert in the same transaction. A pending revocation completes before the waiting writer checks access.
