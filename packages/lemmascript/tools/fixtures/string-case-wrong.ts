// JavaScript lowers U+03A3 to U+03C3; the old ASCII-only model proved that it stays.
//@ verify
//@ ensures \result == String.fromCharCode(931)
export function sigma(): string { return String.fromCharCode(931).toLowerCase() }
