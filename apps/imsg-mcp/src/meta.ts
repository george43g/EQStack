// Injected by Vite `define` from package.json at build/test time.
declare const __APP_VERSION__: string;

export const APP_NAME = "imsg-mcp";
// Fallback covers running un-built source without Vite (e.g. plain tsx).
export const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0-dev";
