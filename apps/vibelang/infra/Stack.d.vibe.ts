import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
export declare const STATE_STORE = "smithers-vibelang-state";
declare const _default: Alchemy.ConfiguredStack<{
    url: Alchemy.Output<string | undefined, never>;
}, NoInfer<Cloudflare.Providers>>;
export default _default;
