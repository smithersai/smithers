/** Both answers need visible text and must fit the form field limits. */
export const validProfileAnswers = (heard: string, project: string): boolean =>
  [heard, project].every(answer => answer.trim().length > 0 && answer.length <= 500)
