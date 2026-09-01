/**
 * Single version truth: package.json (ledger row L-3). `/healthz`, the MCP
 * server identity and the CLI banner all report this value; nothing else may
 * declare a version literal.
 */
import { createRequire } from "node:module";

export const VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
