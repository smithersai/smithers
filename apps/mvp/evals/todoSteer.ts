/** Whether the merged README keeps both requested lines: the word on a line of its own and `steered <word>` on the next. */
export const todoSteerLines = (readme: string, word: string) => {
  const lines = readme.split(/\r?\n/).map((line) => line.trim())
  const steered = `steered ${word}`
  return {
    todoLine: lines.includes(word),
    steeredLine: lines.includes(steered),
    orderedLines: lines.some((line, index) => line === word && lines[index + 1] === steered),
  }
}
