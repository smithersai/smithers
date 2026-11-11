/** Paths a check must never read back as reviewable source. */

/** A job's own retained configuration. `writeCandidate` commits it into the
 * repository, and no check may read it back as reviewable source. */
export const privatePath = (path: string): boolean => /^\.smithers\/repository-jobs(?:\/|$)/i.test(path)
