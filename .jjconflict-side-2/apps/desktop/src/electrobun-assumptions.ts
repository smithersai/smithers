import { join } from "node:path";

export interface DesktopWindow {
  loadURL: (url: string) => Promise<unknown> | unknown;
  on?: (eventName: string, handler: () => void) => void;
  webContents?: {
    executeJavaScript?: (script: string) => Promise<unknown> | unknown;
  };
}

export interface ElectroBunRuntime {
  app: {
    whenReady: () => Promise<void>;
    on: (eventName: string, handler: () => void) => void;
    quit: () => void;
  };
  createWindow: (options: Record<string, unknown>) => DesktopWindow;
}

type UnknownModule = Record<string, unknown>;

async function importByName(moduleName: string): Promise<UnknownModule> {
  const dynamicImport = new Function("name", "return import(name)") as (
    name: string,
  ) => Promise<UnknownModule>;
  return dynamicImport(moduleName);
}

function requireFunction<T extends Function>(value: unknown, label: string): T {
  if (typeof value !== "function") {
    throw new Error(`[desktop] Missing expected function: ${label}`);
  }
  return value as T;
}

function normalizeApp(module: UnknownModule): ElectroBunRuntime["app"] {
  const app = (module.app ?? module.electronApp ?? module.desktopApp) as
    | Record<string, unknown>
    | undefined;

  if (!app) {
    throw new Error("[desktop] Could not find app object in ElectroBun runtime.");
  }

  return {
    whenReady: requireFunction<() => Promise<void>>(app.whenReady, "app.whenReady"),
    on: requireFunction<(eventName: string, handler: () => void) => void>(app.on, "app.on"),
    quit: requireFunction<() => void>(app.quit, "app.quit"),
  };
}

function normalizeCreateWindow(module: UnknownModule): ElectroBunRuntime["createWindow"] {
  const BrowserWindow = module.BrowserWindow as
    | (new (options: Record<string, unknown>) => DesktopWindow)
    | undefined;

  if (BrowserWindow) {
    return (options) => new BrowserWindow(options);
  }

  const createWindow = module.createWindow as
    | ((options: Record<string, unknown>) => DesktopWindow)
    | undefined;

  if (createWindow) {
    return (options) => createWindow(options);
  }

  throw new Error(
    "[desktop] Could not find BrowserWindow/createWindow in ElectroBun runtime.",
  );
}

function resolveViewsIndexUrl(module: UnknownModule): string {
  const viewsUrl = module.viewsUrl as ((assetPath: string) => string) | undefined;
  if (viewsUrl) {
    return viewsUrl("index.html");
  }

  const packagedIndexPath = join(import.meta.dir, "..", "views", "index.html");
  return `file://${packagedIndexPath}`;
}

export interface DesktopRuntimeBindings extends ElectroBunRuntime {
  viewsIndexUrl: string;
}

/**
 * TODO(phase-2): Validate these assumptions against the exact ElectroBun API and
 * replace this adapter with direct typed imports once the API contract is confirmed.
 */
export async function loadDesktopRuntimeBindings(): Promise<DesktopRuntimeBindings> {
  const module = await importByName("electrobun");

  return {
    app: normalizeApp(module),
    createWindow: normalizeCreateWindow(module),
    viewsIndexUrl: resolveViewsIndexUrl(module),
  };
}
