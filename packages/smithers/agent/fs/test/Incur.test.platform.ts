// Generated platform helpers for this VibeLang module.
import { sync } from "vibelang-runtime";
export function $platform() { return process.stdout; }
export function $platform$1() { return process; }
/** @throws {never} */
export function $platform$2() { return sync(() => process.env.COMPLETE); }
/** @throws {never} */
export function $platform$3() { return sync(() => {
        process.env.COMPLETE = ""
      }); }
/** @throws {never} */
export function $platform$4() { return sync(() => {
        process.env.COMPLETE = "zsh"
      }); }
