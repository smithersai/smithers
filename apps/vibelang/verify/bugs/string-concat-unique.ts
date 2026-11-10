//@ verify
//@ ensures \result == host + ":" + reply
export function chargeKeyOf(host: string, reply: string): string {
  return host + ":" + reply
}

// Concat-cancellation exceeds the backend's string reasoning: this uniqueness theorem is true of
// every string, yet the backend cannot prove it, with or without length hints. The production
// contract states exact construction; the two-conversation workerd regression demonstrates uniqueness.
//@ verify
//@ ensures \result
export function chargeKeyHostUnique(hostA: string, hostB: string, reply: string): boolean {
  return hostA === hostB || chargeKeyOf(hostA, reply) !== chargeKeyOf(hostB, reply)
}
