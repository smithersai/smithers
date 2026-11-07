import { layerMemory } from "./host.vibe";
import { type FixtureOutcome } from "../../baseline.ts";
import { type PlantedBugLabel } from "./labels.vibe";
import { type ReviewFinding } from "../../score.ts";
interface FixtureRun extends FixtureOutcome {
    findings: ReviewFinding[];
}
/** @throws {never} */
export declare function runFixture(label: PlantedBugLabel, layer: ReturnType<typeof layerMemory>): Promise<FixtureRun>;
/**
 * Runs the suite. Returns the process exit code.
 *
 * @since 1.0.0
 * @category constructors
 * @throws {never}
 */
export declare function main(argv?: readonly string[]): Promise<number>;
export {};
