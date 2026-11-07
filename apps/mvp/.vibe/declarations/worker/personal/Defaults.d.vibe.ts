import { Effect } from "effect";
import { type Defaults } from "../../../../src/features/personal-model/contract.ts";
/**
 * `MOONSHOT_BASE_URL` and `MOONSHOT_MODEL`: the endpoint a `moonshot` connection goes to and the model its tiers use,
 * Moonshot's international endpoint and Kimi K3 unless set (platform.moonshot.ai/docs/api/chat, read 2026-10-31).
 */
export declare const connectionDefaults: Effect.Effect<Defaults>;
