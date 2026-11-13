import { GitHub } from "@smthrs/integrations"
import { Effect, Option } from "effect"
import { HttpClient } from "effect/http"
import * as SessionStore from "../../SessionStore.ts"
import { roleOf } from "../../GitHubAuth.ts"
import type { Services } from "../Apply.ts"
import { withToken } from "../Calls.ts"
import type { Repository } from "../Config.ts"
import { permissionOf } from "../RepoRoles.ts"

/** Record the live test's acting person with the identity and permission GitHub actually reports. */
export const livePerson = (services: Services, repository: Repository, login: string) =>
  Effect.gen(function* () {
    const token = yield* services.tokens.forInstallation(repository, "metadata")
    const permission = yield* GitHub.Collaborators.permission(repository.owner, repository.name, login).pipe(
      withToken(token, services.apiBaseUrl),
    )
    if (Option.isNone(permission) || permission.value.userId === undefined ||
      !["member", "maintainer", "admin"].includes(roleOf(permissionOf(permission.value)) ?? "")) {
      return yield* Effect.fail(new Error("GITHUB_LIVE_MAINTAINER must name a repository member with a GitHub account id"))
    }
    return yield* SessionStore.upsertPerson({ id: crypto.randomUUID(), githubId: permission.value.userId, login })
  }).pipe(Effect.provide(services.database), Effect.provideService(HttpClient.HttpClient, services.http))
