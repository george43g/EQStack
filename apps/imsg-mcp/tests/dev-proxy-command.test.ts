/**
 * mcp-dev-proxy default child command — tsx signal-relay hardening.
 *
 * The tsx CLI (`.bin/tsx`) runs code in a grandchild and relays signals to it
 * with a 30ms IPC-ack window; a busy child gets SIGKILLed ~60ms in, truncating
 * graceful shutdown and faking our "no shutdown marker = crash" heuristic
 * (tsx 4.23.1 `relaySignalToChild`; mcp-cli-starter-template#64). The proxy
 * signals its child (process-group SIGTERM/SIGINT/SIGKILL), so its default
 * command must be the single-process `node --import <tsx loader>` shape.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDefaultDevCmd, devCliPath, tsxLoaderHref } from "../scripts/dev-proxy-cmd.js";

describe("buildDefaultDevCmd", () => {
  it("uses node --import (single process), never the tsx CLI wrapper", () => {
    const cmd = buildDefaultDevCmd();
    expect(cmd.startsWith(`${process.execPath} --import `)).toBe(true);
    expect(cmd).not.toContain("/.bin/tsx");
    expect(cmd.endsWith(" mcp")).toBe(true);
  });

  it("resolves the tsx loader to a real file, independent of cwd", () => {
    const href = tsxLoaderHref();
    expect(href.startsWith("file:///")).toBe(true);
    expect(existsSync(fileURLToPath(href))).toBe(true);
  });

  it("points at the dev entry src/cli.ts as an absolute path", () => {
    const cli = devCliPath();
    expect(cli.endsWith("/src/cli.ts")).toBe(true);
    expect(existsSync(cli)).toBe(true);
  });

  it("every segment is space-free — the shell word-splits the command", () => {
    for (const segment of buildDefaultDevCmd().split(" ")) {
      expect(segment.length).toBeGreaterThan(0);
    }
    expect(buildDefaultDevCmd().split(" ")).toHaveLength(5);
  });
});
