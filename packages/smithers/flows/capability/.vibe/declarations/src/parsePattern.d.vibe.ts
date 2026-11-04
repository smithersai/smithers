/**
 * The capability pattern parser, including the bare `*` sentinel.
 *
 * @since 0.1.0
 */
import { Option } from "effect";
import { CapabilityPattern } from "./CapabilityPattern.vibe";
/**
 * Parses a formatted capability pattern.
 *
 * The wildcard action `*` occupies the first component. Every other action
 * occupies the first two components. All remaining text belongs to the
 * resource, including colons and an empty string. Missing components and
 * unknown actions return `Option.none()`, with one single-token exception:
 * the bare `*` is the whole-authority sentinel that `@smthrs/registry`
 * markdown discovery emits for a flow whose frontmatter declares no
 * `capabilities:`. Plans persist that string in durable key material, so the
 * emitted form cannot change; this parser owns its meaning instead and reads
 * it as `{ action: "*", resource: "**" }`. The resource is `**` and not `*`
 * because `subsumes` recognises only `**` as recursive, so a grant
 * written `*` could be proven to cover only the identical `*` resource and
 * never any other. Every other missing component remains a rejection, not a
 * default.
 *
 * @since 0.1.0
 * @category parsing
 * @slop
 */
export declare const parsePattern: (input: string) => Option.Option<CapabilityPattern>;
