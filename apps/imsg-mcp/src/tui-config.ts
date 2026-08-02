/**
 * Back-compat shim. The canonical config module is `src/app-config.ts`, which
 * absorbed this file's schema + resolution when the `interpret` block was added
 * (media-intel Stage 3). Existing imports of `./tui-config.js` keep working.
 */
export * from "./app-config.js";
