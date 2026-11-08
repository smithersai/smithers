/**
 * Deterministic bundle of the production step cache service.
 *
 * See the {@link https://github.com/smithersai/smithers/blob/main/packages/smithers/flows/plan/docs/concepts/step-keys.md | step-key contract}.
 *
 * @since 0.1.0
 */

import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Layer from "effect/Layer"
import * as CacheStore from "../CacheStore.vibe"
import * as Migrations from "../Migrations.vibe"

/**
 * Provides the production SQLite step cache over an in-memory database.
 * Migrations run before the cache is exposed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = CacheStore.layer.pipe(
  Layer.provide(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)
