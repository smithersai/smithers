import * as Config from "effect/Config"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const hostname = Schema.String.check(Schema.isPattern(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/))
const workerName = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/))

export const optionalHost = (key: string) =>
  Config.option(Config.schema(hostname, key)).pipe(Config.map(Option.getOrUndefined))

export const physicalName = (key: string, fallback: string) =>
  Config.schema(workerName, key).pipe(Config.withDefault(fallback))
