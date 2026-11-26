import { HttpClientRequest } from "effect/http"
import type { DomainsClient } from "./api.vibe"
import { domainRoute, domainsRoute } from "./contract"

/** Supplies methods that encode their routes before returning an Effect. */
export const domainRequests = (
  options: { readonly origin: string },
  send: (op: "add" | "remove", request: HttpClientRequest.HttpClientRequest) =>
    ReturnType<DomainsClient["Service"]["add"]>,
): DomainsClient["Service"] => ({
  add: ({ owner, name, hostname }) =>
    send(
      "add",
      HttpClientRequest.post(`${options.origin}${domainsRoute(owner, name)}`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ hostname }),
      ),
    ),
  remove: ({ owner, name, hostname }) =>
    send("remove", HttpClientRequest.delete(`${options.origin}${domainRoute(owner, name, hostname)}`)),
})
