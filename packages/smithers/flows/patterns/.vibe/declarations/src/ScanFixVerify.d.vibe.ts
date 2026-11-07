/**
 * Scan for issues, fix them in parallel, verify, and repeat until clean.
 *
 * This is the shape of every lint-fix, test-repair, and audit-remediation
 * workflow: the number of issues is a runtime fact, and so is the number of
 * rounds. {@link ReviewLoop} cannot express it, because a review loop revises
 * one artifact; here each issue gets its own fix.
 *
 * The retry bound and fan-out bound are declared, so the plan shows the worst
 * case. The engine fixes only issues the scanner returned.
 *
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow";
import * as Schema from "effect/Schema";
import type { Member } from "../../../src/internal/Member.ts";
import { OpaqueInput } from "./internal/Payload.vibe";
/**
 * Configuration for {@link make}.
 *
 * `maxIssues` is the declared fan-out bound: a plan cannot know how many
 * issues a scan will find, so the declaration carries the largest fan-out the
 * author will admit. `concurrency` batches those calls exactly as
 * `MapReduce.make` does, so the declared topology never fans out wider than
 * the bound.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions<R = never> {
    readonly name?: string | undefined;
    readonly description?: string | undefined;
    readonly scan: Member<R>;
    readonly fix: Member<R>;
    readonly verify: Member<R>;
    readonly maxRetries: number;
    readonly maxIssues: number;
    readonly concurrency: number;
}
/**
 * Reads the signals a verifier uses to report that nothing is left to fix.
 *
 * A verifier answers with `true` or an object carrying its own `resolved: true`.
 * A symbolic plan-time value is neither, which keeps the declared unrolling
 * conservative.
 *
 * The flow records every verification and stops on an empty scan. Callers
 * read the recorded verdicts with this function.
 *
 * @category predicates
 * @since 0.1.0
 */
export declare const resolved: (value: unknown) => boolean;
/**
 * The declared form of a scan-fix-verify loop.
 *
 * @category models
 * @since 1.0.0
 */
export type ScanFixVerifyFlow<R = never> = Flow.Flow<string, typeof OpaqueInput, typeof Schema.Unknown, typeof Schema.Unknown, R>;
/**
 * Declares the bounded scan-fix-verify topology and its runtime decisions.
 *
 * Every retry is unrolled, and every retry declares `maxIssues` fix slots in
 * `concurrency`-sized batches, so the plan shows the worst case. Each scan is
 * the subject of a `Node.branch`: an empty scan settles `resolved: true`.
 * Each fix slot is its own `Node.branch` on whether the scan
 * returned an issue at that index, so a run pays for exactly the fixes the
 * scan asked for, and `verify` is handed the fixes of the issues that exist.
 * Issues past `maxIssues` wait for the next round's rescan. Very large retry
 * and issue bounds build a very large graph before anything runs.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: <R = never>(options: MakeOptions<R>) => ScanFixVerifyFlow<R>;
