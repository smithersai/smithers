let counter = 0;

export function resetCounter() {
  counter = 0;
}

export function getCounter() {
  return counter;
}

export async function compute(ctx: { input: { key: string } }) {
  counter += 1;
  return { count: counter, key: ctx.input.key };
}
