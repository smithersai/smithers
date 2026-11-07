import { Context, type Effect, Layer, Option, Schema } from "effect";
import type { CertificateState, DnsRecord, VerificationState } from "../../../../src/features/domains/contract.ts";
/** A domain as its provider sees it. */
export interface Registration {
    /** The provider's id for the domain: what `status` and `remove` take. */
    readonly id: string;
    /** The records the maintainer adds at their DNS provider, the routing record first. */
    readonly records: ReadonlyArray<DnsRecord>;
    readonly verification: VerificationState;
    readonly certificate: CertificateState;
    /** Why verification or the certificate is stuck, in the provider's short words; none when nothing is. */
    readonly problem?: string;
}
declare const ProviderUnavailable_base: Schema.Class<ProviderUnavailable, Schema.TaggedStruct<"@smthrs/mvp/domains/ProviderUnavailable", {
    readonly code: Schema.String;
}>, import("effect/Cause").YieldableError>;
/** The provider couldn't be reached, timed out or failed: the step tries again. `code` names it, never a token. */
export declare class ProviderUnavailable extends ProviderUnavailable_base {
}
declare const HostnameTaken_base: Schema.Class<HostnameTaken, Schema.TaggedStruct<"@smthrs/mvp/domains/HostnameTaken", {}>, import("effect/Cause").YieldableError>;
/** The provider holds the hostname for someone else, such as another Cloudflare account. Final. */
export declare class HostnameTaken extends HostnameTaken_base {
}
declare const HostnameRejected_base: Schema.Class<HostnameRejected, Schema.TaggedStruct<"@smthrs/mvp/domains/HostnameRejected", {
    readonly reason: Schema.String;
}>, import("effect/Cause").YieldableError>;
/** The provider refuses the hostname for good, such as one it blocks. `reason` is its short word for why. Final. */
export declare class HostnameRejected extends HostnameRejected_base {
}
/** A provider's operations. */
export interface Provider {
    /** Its name in records: `cloudflare` or `dns`. */
    readonly name: string;
    /** The name every domain's routing record points at, such as `domains.smithers.sh`. */
    readonly target: string;
    /** The deployment's own zone: neither it nor a name under it can be a custom domain. */
    readonly zone: string;
    /** Registers `hostname`, or finds it when an earlier attempt already did, so a step run again registers once. */
    readonly ensure: (hostname: string) => Effect.Effect<Registration, ProviderUnavailable | HostnameTaken | HostnameRejected>;
    /** The registration `id` of `hostname` now; none when the provider no longer has it. */
    readonly status: (id: string, hostname: string) => Effect.Effect<Option.Option<Registration>, ProviderUnavailable>;
    /** Forgets registration `id`; one the provider no longer has is already forgotten. */
    readonly remove: (id: string) => Effect.Effect<void, ProviderUnavailable>;
}
declare const DomainProvider_base: Context.ServiceClass<DomainProvider, "@smthrs/mvp/domains/DomainProvider", Option.Option<Provider>>;
/** The deployment's provider, or none when custom domains are off (`DOMAINS_PROVIDER` unset). */
export declare class DomainProvider extends DomainProvider_base {
    /** Custom domains off: every route answers `off`. */
    static readonly off: Layer.Layer<DomainProvider>;
    /** `provider`. */
    static readonly layer: (provider: Provider) => Layer.Layer<DomainProvider>;
}
export {};
