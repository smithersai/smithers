/** GitHub repository names are case-insensitive; billing keeps the stored key. */
export const sameRepoName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
