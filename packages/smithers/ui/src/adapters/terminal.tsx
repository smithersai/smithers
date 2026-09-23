/** @jsxImportSource react */
import { useEffect, useInsertionEffect, useRef, useState, type ComponentProps } from "react";
import type { IDisposable, ITheme, Terminal as XTerminal } from "@xterm/xterm";
import { cn } from "../cn";
import { useResolvedTheme } from "../internal/useResolvedTheme";
import { useResolvedPalette } from "../internal/useResolvedPalette";
import type { ResolvedPalette } from "../internal/resolvePalette";
import { observeReducedMotion, prefersReducedMotion, themeRegistry } from "../styles";
import { tokens as t } from "../tokens";
import { xtermBaseCss } from "./xtermCss";

/**
 * `<Terminal>` — a generic xterm.js render surface for any Smithers workflow UI.
 *
 * This is the app-store-free port of Multi's `TerminalSession`: the data source
 * is lifted entirely onto props. Pass a `lines` snapshot and/or a `stream`
 * subscription (the imperative write seam) and the component owns the emulator,
 * the fit addon, theming, and resize. It imports nothing from any app store,
 * router, or gateway hook, so it drops into a report page, a styleguide, or a
 * live run UI unchanged.
 *
 * It lives in the `adapters/` layer because it pulls the heavy `@xterm/*`
 * widgets; reach it through the `@smthrs/ui/adapters/terminal`
 * subpath (never the base barrel, which the UI-architecture guard keeps free of
 * heavy dependencies).
 */

/** Receives bytes to render. Accepts UTF-8 strings or raw `Uint8Array` chunks. */
export type TerminalWriter = (data: string | Uint8Array) => void;

/**
 * Incremental output seam. Called once, right after the emulator opens, with a
 * `write` function that pushes bytes into the terminal. Return an optional
 * teardown that runs on unmount (unsubscribe a socket, clear a timer). This is
 * how a live source (PTY socket, SSE text, agent log) streams into the surface
 * without the component knowing anything about the transport.
 */
export type TerminalStream = (write: TerminalWriter) => void | (() => void);

/** The xterm.js modules the emulator is built from. */
export type TerminalModules = {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
};

/** Typed startup failure: the modules did not load, or the emulator did not open. */
export type TerminalError = { code: "terminal-start-failed"; cause: unknown };

async function loadXterm(): Promise<TerminalModules> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
  return { Terminal, FitAddon };
}

/** Built-in palettes. Pass a `colors` override for anything more specific. */
export type TerminalColorTheme = "dark" | "light";

/** The underlying xterm.js instance, handed back through {@link TerminalProps.onReady}. */
export type TerminalInstance = XTerminal;

/** Literal xterm palette for a registry key and light/dark mode. */
export function terminalThemeFor(palette: ResolvedPalette, mode: TerminalColorTheme): ITheme {
  return themeRegistry[palette].terminal[mode];
}

/** Idempotent marker for the injected xterm + surface stylesheet. */
const STYLE_ATTR = "data-smithers-ui-terminal";

/**
 * The surface chrome (padding, hairline border, radius) themes through the ui
 * tokens, so the frame around the terminal follows light/dark with the rest of
 * the UI. The terminal's own colors come from the resolved palette below.
 *
 * The vendored xterm sheet hardcodes `#000`/`#FFF` for the scroll viewport and
 * the IME composition view; the two overrides below retie them to the active
 * house palette (the viewport goes transparent so the themed xterm canvas and
 * surface background show through). Cursor and selection colors are already
 * theme-derived through the selected registry palette.
 */
const surfaceCss = `
.sui-terminal { position:relative; box-sizing:border-box; display:flex; flex-direction:column; min-height:0; width:100%; height:100%; padding:12px; border:1px solid ${t.border}; border-radius:${t.radius}; overflow:hidden; font-family:${t.fontMono}; }
.sui-terminal-error { color:${t.destructive}; font-size:13px; }
.sui-terminal-screen { flex:1 1 auto; min-height:0; width:100%; }
.sui-terminal-screen .xterm { height:100%; }
.sui-terminal-screen .xterm-viewport { overflow-y:auto; background-color:transparent; }
.sui-terminal-screen .composition-view { background:${t.codeBg}; color:${t.codeText}; border:1px solid ${t.border}; border-radius:${t.radiusControl}; }
`;

export type TerminalProps = Omit<ComponentProps<"div">, "onResize"> & {
  /** Initial content written once when the emulator opens (newlines honored). */
  lines?: readonly string[];
  /** Incremental output subscription; see {@link TerminalStream}. */
  stream?: TerminalStream;
  /** User keystrokes / input bytes out of the emulator (interactive sessions). */
  onData?: (data: string) => void;
  /** Fired after every fit, with the current terminal geometry. */
  onResize?: (size: { cols: number; rows: number }) => void;
  /** Escape hatch to the raw xterm.js instance (load addons, search, read buffer). */
  onReady?: (terminal: TerminalInstance) => void;
  /** Built-in palette selection. Defaults to the active house theme. */
  theme?: TerminalColorTheme;
  /** Palette override. Defaults to the active `data-palette` value. */
  palette?: ResolvedPalette;
  /** Per-color overrides merged onto the selected palette. */
  colors?: Partial<ITheme>;
  fontSize?: number;
  fontFamily?: string;
  cursorBlink?: boolean;
  /** Render-only surface: ignore keyboard input (`disableStdin`). */
  readOnly?: boolean;
  /** Scrollback buffer size in lines. */
  scrollback?: number;
  /** Called once when the emulator cannot start, with the original cause. */
  onError?: (error: TerminalError) => void;
  /** Module loader seam. Defaults to the dynamic `@xterm/*` imports. */
  loadModules?: () => Promise<TerminalModules>;
};

const DEFAULT_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Inject the xterm base sheet + surface chrome once per document (browser only). */
function injectTerminalStyles(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[${STYLE_ATTR}]`)) return;
  const el = document.createElement("style");
  el.setAttribute(STYLE_ATTR, "");
  el.textContent = `${xtermBaseCss}\n${surfaceCss}`;
  document.head.appendChild(el);
}

/** Fit can throw on a zero-size host (headless/first paint); never let it escape. */
function safeFit(fit: { fit(): void }): void {
  try {
    fit.fit();
  } catch {
    /* container not measurable yet; the ResizeObserver will fit once it is. */
  }
}

export function Terminal({
  lines,
  stream,
  onData,
  onResize,
  onReady,
  theme,
  palette,
  colors,
  fontSize = 13,
  fontFamily = DEFAULT_FONT_FAMILY,
  cursorBlink = true,
  readOnly = false,
  scrollback = 1000,
  onError,
  loadModules,
  className,
  style,
  ...rest
}: TerminalProps) {
  useInsertionEffect(injectTerminalStyles, []);
  const houseTheme = useResolvedTheme();
  const housePalette = useResolvedPalette();
  const resolvedTheme = theme ?? houseTheme;
  const resolvedPalette = palette ?? housePalette;
  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;
  const resolvedPaletteRef = useRef(resolvedPalette);
  resolvedPaletteRef.current = resolvedPalette;

  // Latest-value refs keep the mount effect stable (it only re-runs on config
  // that requires rebuilding the emulator) while still calling current props.
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const streamRef = useRef(stream);
  streamRef.current = stream;
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const colorsRef = useRef(colors);
  colorsRef.current = colors;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const loadModulesRef = useRef(loadModules);
  loadModulesRef.current = loadModules;
  // True when startup failed before an emulator existed to print the error.
  const [blank, setBlank] = useState(false);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerminal | null>(null);

  // Palette changes do not rebuild the emulator (or lose its buffer). xterm
  // accepts live option updates, so a root data-theme toggle repaints the
  // existing adapter in place.
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.theme = {
      ...terminalThemeFor(resolvedPalette, resolvedTheme),
      ...colors,
    };
  }, [resolvedPalette, resolvedTheme, colors]);

  useEffect(() => {
    const host = mountRef.current;
    if (!host) return;

    // Every resource is hoisted to effect scope and assigned the moment it is
    // created, so the cleanup below disposes whatever exists, including a
    // teardown that fires while mount() is still awaiting the dynamic import
    // (mirrors Multi's TerminalSession discipline). Registering cleanup only
    // after a successful open used to leak the emulator + ResizeObserver.
    const ac = new AbortController();
    let term: XTerminal | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let dataDisposable: IDisposable | null = null;
    let streamTeardown: (() => void) | void;
    let motionTeardown: (() => void) | null = null;

    async function mount() {
      const { Terminal: XtermTerminal, FitAddon } = await (loadModulesRef.current ?? loadXterm)();
      if (ac.signal.aborted || !host) return;

      // The mount div persists across effect re-runs; never stack a second
      // emulator into it.
      host.replaceChildren();

      const palette = {
        ...terminalThemeFor(resolvedPaletteRef.current, resolvedThemeRef.current),
        ...colorsRef.current,
      };
      term = new XtermTerminal({
        theme: palette,
        fontFamily,
        fontSize,
        cursorBlink: cursorBlink && !prefersReducedMotion(),
        convertEol: true,
        disableStdin: readOnly,
        scrollback,
      });
      terminalRef.current = term;
      const blinkTerm = term;
      motionTeardown = observeReducedMotion((reduced) => {
        blinkTerm.options.cursorBlink = cursorBlink && !reduced;
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(host);
      safeFit(fitAddon);
      if (ac.signal.aborted) return;

      const boundTerm = term;
      const write: TerminalWriter = (data) => boundTerm.write(data);

      const initialLines = linesRef.current;
      if (initialLines && initialLines.length > 0) boundTerm.write(initialLines.join("\n"));

      dataDisposable = boundTerm.onData((data) => onDataRef.current?.(data));

      resizeObserver =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(() => {
              safeFit(fitAddon);
              onResizeRef.current?.({ cols: boundTerm.cols, rows: boundTerm.rows });
            })
          : null;
      resizeObserver?.observe(host);

      onReadyRef.current?.(boundTerm);
      streamTeardown = streamRef.current?.(write) ?? undefined;
    }

    setBlank(false);
    void mount().catch((error: unknown) => {
      if (ac.signal.aborted) return;
      onErrorRef.current?.({ code: "terminal-start-failed", cause: error });
      // Surface the failure inside the terminal, where the eye already is; with
      // no emulator the surface itself states it instead of staying blank.
      if (term === null) {
        setBlank(true);
        return;
      }
      const message = error instanceof Error ? error.message : "Failed to start terminal.";
      term.writeln(`\x1b[1;31m${message}\x1b[0m`);
    });

    return () => {
      // Aborting short-circuits an in-flight mount(); the rest is disposed
      // unconditionally, whatever stage setup reached.
      ac.abort();
      if (typeof streamTeardown === "function") streamTeardown();
      motionTeardown?.();
      resizeObserver?.disconnect();
      dataDisposable?.dispose();
      if (terminalRef.current === term) terminalRef.current = null;
      term?.dispose();
    };
  }, [fontSize, fontFamily, cursorBlink, readOnly, scrollback]);

  const surfaceBackground = terminalThemeFor(resolvedPalette, resolvedTheme).background;

  return (
    <div
      data-slot="terminal"
      data-theme-mode={resolvedTheme}
      data-palette={resolvedPalette}
      data-state={blank ? "failed" : undefined}
      className={cn("sui-terminal", className)}
      style={{ background: colors?.background ?? surfaceBackground, ...style }}
      {...rest}
    >
      {blank ? (
        <div role="alert" data-slot="terminal-error" className="sui-terminal-error">
          Terminal failed to start.
        </div>
      ) : null}
      <div className="sui-terminal-screen" data-slot="terminal-screen" ref={mountRef} />
    </div>
  );
}
