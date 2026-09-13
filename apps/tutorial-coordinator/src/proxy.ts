import { Effect } from "effect"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { ModelError } from "@smthrs/model/ModelError"
import { TUTORIAL_PROVIDER_PROXY_PATH, TUTORIAL_PROXY_TOKEN_HEADER, tutorialProviderDestinations } from "@smthrs/rpc/TutorialProviderProxy"

export interface TutorialProxySettings { readonly url: string; readonly token: string }
export const proxySettings = (environment: Readonly<Record<string, string | undefined>>): TutorialProxySettings => {
  const url = environment.TUTORIAL_PROVIDER_PROXY_URL ?? `https://smithers.sh${TUTORIAL_PROVIDER_PROXY_PATH}`
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Configure an HTTPS tutorial provider proxy URL")
  if (!environment.TUTORIAL_SERVICE_TOKEN) throw new Error("Configure tutorial provider proxy authentication")
  return { url: url.replace(/\/$/, ""), token: environment.TUTORIAL_SERVICE_TOKEN }
}

/** All provider traffic, including CodexAuth refresh, enters this executor. */
export const throughProxy = (executor: RequestExecutor.RequestExecutor, proxy: TutorialProxySettings): RequestExecutor.RequestExecutor => RequestExecutor.RequestExecutor.of({
  execute: (request, options) => {
    const destination = Object.entries(tutorialProviderDestinations).find(([, url]) => request.url === url)?.[0]
    if (!destination || request.method !== "POST" || request.urlParams.params.length > 0) return Effect.fail(new ModelError({ code: "invalid_request", message: "This provider request has no configured Cloudflare proxy route" }))
    return executor.execute(request.pipe(
      HttpClientRequest.setUrl(new URL(`${proxy.url}/${destination}`)),
      HttpClientRequest.setHeader(TUTORIAL_PROXY_TOKEN_HEADER, proxy.token),
    ), options)
  },
})
