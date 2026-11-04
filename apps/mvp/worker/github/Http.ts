import { GitHub } from "@smthrs/integrations"
import { Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

const githubHosts = new Set(["api.github.com", "github.com", "uploads.github.com"])

/** Identify Worker calls to GitHub even when fetch supplies no User-Agent. Mixed egress keeps other hosts' headers. */
export const withUserAgent = <A, E, R>(effect: Effect.Effect<A, E, R>, githubHostsOnly = false) =>
  Effect.provideServiceEffect(
    effect,
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (http) => HttpClient.mapRequest(http, (request) =>
      !githubHostsOnly || githubHosts.has(new URL(request.url).hostname)
        ? HttpClientRequest.setHeader(request, "user-agent", GitHub.GitHubClient.USER_AGENT)
        : request)),
  )
