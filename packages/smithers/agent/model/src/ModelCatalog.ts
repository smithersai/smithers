/**
 * Static facts about known provider models.
 *
 * A model id is the only thing a caller has before it reaches a provider, and
 * some decisions have to be made from it alone. This module is where those
 * facts live, beside the protocols that produce the ids, so a consumer that is
 * deliberately provider-neutral never has to carry a provider table of its own.
 *
 * @since 1.0.0-rc.0
 */

/** The default window for a model this catalog has not met. */
const unknownModelTokens = 128_000

const contextWindows: ReadonlyArray<readonly [RegExp, number]> = [
  [/claude.*haiku/i, 200_000],
  // Native 1M windows; older Claude and cloud-prefixed ids stay conservative.
  // https://platform.claude.com/docs/en/build-with-claude/context-windows
  [/^claude-(?:opus-5|sonnet-5|opus-4-[678]|sonnet-4-6)$/i, 1_000_000],
  [/^claude-(?:fable|mythos)-5(?:-[0-9]+)*$/i, 1_000_000],
  [/claude/i, 200_000],
  [/gpt-5/i, 400_000],
  [/gpt-4\.1/i, 1_000_000],
  [/gpt-4o/i, 128_000],
  [/^o[134]/i, 200_000]
]

/**
 * The context window, in tokens, of a known model id, with a conservative
 * floor for models the catalog has not met. Never zero: a consumer that reads
 * zero as "compaction disabled" must not have it disabled by a resolver that
 * did resolve a window.
 *
 * @category resolvers
 * @since 1.0.0-rc.0
 */
export const contextWindowTokensFor = (modelId: string): number => {
  for (const [pattern, tokens] of contextWindows) {
    if (pattern.test(modelId)) return tokens
  }
  return unknownModelTokens
}
