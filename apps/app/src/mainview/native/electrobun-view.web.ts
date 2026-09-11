/*
 * What `electrobun/view` resolves to in a build that has no Electrobun SDK:
 * the smithers.sh site aliases the specifier here (apps/site/astro.config.mjs).
 * NativeBridge.ts reaches `Electroview` only when the native bridge is
 * loaded, which a web host never does, so the bundler drops this module;
 * should a host ever reach it, it throws instead of pretending to be a shell.
 * The Vite build in this package keeps the Hutch devkit alias and never sees
 * this file.
 */
export class Electroview {
  static defineRPC(): never {
    throw new Error("web build")
  }
  constructor() {
    throw new Error("web build")
  }
}
