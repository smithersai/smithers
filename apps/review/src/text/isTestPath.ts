// One test-path rule for the whole app: the review checklist selector, the quiz
// impact score, and the walkthrough's chapter ordering all read it, so a file
// that is a test for one of them is a test for all three.
const testDirPattern = /(^|\/)(tests?|__tests__|e2e|spec)\//;
const testNamePattern = /(\.(test|spec|e2e)\.[^/]+|_test\.[^/]+|_spec\.[^/]+)$/;

/** Whether a repository path names a test file, by directory or by filename. */
export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  const name = lower.split("/").pop() ?? lower;
  return testDirPattern.test(lower) || testNamePattern.test(name);
}
