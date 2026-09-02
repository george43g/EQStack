/**
 * launchd LaunchAgent wrapper (Phase D step 4, D-9/D-37).
 *
 * renderPlist() is PURE (snapshot-testable); launchctl calls go through an
 * injected runner. LaunchAgent, not LaunchDaemon: an Agent runs in the login
 * session so the keychain-backed secret provider works — a Daemon would
 * resolve every secret null (D-37). Linux/systemd parity is PARKED (D-9).
 *
 * launchd supplies no user PATH, so every path in the plist is absolute
 * (verified against man launchctl / man launchd.plist on this machine:
 * bootstrap/bootout/kickstart/print are the modern verbs; ThrottleInterval
 * is seconds, default ~10s between respawns).
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DaemonConfig } from "../config/schema.js";

const execFileP = promisify(execFile);

export interface PlistSpec {
  label: string;
  nodeBin: string;
  cliJs: string;
  runAtLoad: boolean;
  keepAlive: boolean;
  logDir: string;
  /** Seconds between launchd respawns — keeps a config-error crash loop slow. */
  throttleSeconds: number;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function expandHome(path: string, home: string = homedir()): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

export function plistSpecFromConfig(cfg: DaemonConfig, cliJs: string): PlistSpec {
  return {
    label: cfg.label,
    nodeBin: cfg.nodeBin ?? process.execPath,
    cliJs,
    runAtLoad: cfg.runAtLogin,
    keepAlive: cfg.keepAlive,
    logDir: expandHome(cfg.logDir),
    throttleSeconds: 30,
  };
}

export function renderPlist(spec: PlistSpec): string {
  const bool = (b: boolean) => (b ? "<true/>" : "<false/>");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(spec.nodeBin)}</string>
    <string>${xmlEscape(spec.cliJs)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key>${bool(spec.runAtLoad)}
  <key>KeepAlive</key>${bool(spec.keepAlive)}
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>${spec.throttleSeconds}</integer>
  <key>StandardOutPath</key><string>${xmlEscape(join(spec.logDir, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(spec.logDir, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

export function plistPath(label: string, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${label}.plist`);
}

export type LaunchctlRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

export const defaultLaunchctl: LaunchctlRunner = async (args) => {
  const { stdout, stderr } = await execFileP("/bin/launchctl", args);
  return { stdout, stderr };
};

export function guiDomain(uid: number = process.getuid?.() ?? 501): string {
  return `gui/${uid}`;
}

export interface DaemonStatus {
  loaded: boolean;
  pid: number | null;
  lastExitStatus: number | null;
  /** launchd print exposes no restart counter on all versions; null = unknown. */
  runs: number | null;
}

/** Parse `launchctl print gui/<uid>/<label>` — tolerant of version drift. */
export function parseLaunchctlPrint(out: string): DaemonStatus {
  const pid = out.match(/\bpid = (\d+)/);
  const lastExit = out.match(/last exit code = (-?\d+|\(never exited\))/);
  const runs = out.match(/\bruns = (\d+)/);
  return {
    loaded: true,
    pid: pid?.[1] ? Number(pid[1]) : null,
    lastExitStatus: lastExit?.[1] && lastExit[1] !== "(never exited)" ? Number(lastExit[1]) : null,
    runs: runs?.[1] ? Number(runs[1]) : null,
  };
}
