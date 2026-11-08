/**
 * How long a load may take before anything says so. A load that settles
 * sooner shows nothing at all; a longer one shows a thin bar at the top
 * (`LoadingBar`) or a skeleton in place (`Skeleton`). Both wait this long in
 * CSS, so a component only says whether it is loading.
 */
export const LOADING_DELAY_MS = 300;
