// A Durable Object namespace whose lookup throws synchronously, as a missing or invalid binding does.
export function refuseBinding(): never { throw new Error("binding refused") }
