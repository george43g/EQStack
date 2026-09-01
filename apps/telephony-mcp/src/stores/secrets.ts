/**
 * Secret resolution by variable NAME, never by value: process env first,
 * then the opkeep keychain cache (`security find-generic-password -s
 * opkeep -a NAME -w`). Absolute binary path — GUI-launched MCP hosts have
 * no user PATH. Values are cached in-memory per process and never logged.
 *
 * Service name: opkeep re-keyed its cache from service "dotfiles" to
 * "opkeep" on 2026-08-06 (opkeep lib/config.sh OPKEEP_SERVICE default);
 * this default was stranded on the old name until 2026-08-16, silently
 * reading a pre-re-key TWILIO_AUTH_TOKEN. Rollback / alternate cache:
 * TEL_KEYCHAIN_SERVICE.
 */
import { execFile } from "node:child_process";

const SECURITY_BIN = "/usr/bin/security";
const KEYCHAIN_SERVICE = process.env.TEL_KEYCHAIN_SERVICE ?? "opkeep";

export type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultExecFile: ExecFileFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });

export class EnvKeychainSecretProvider {
  private cache = new Map<string, string | null>();

  constructor(private exec: ExecFileFn = defaultExecFile) {}

  async get(name: string): Promise<string | null> {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return null;
    const fromEnv = process.env[name];
    if (fromEnv) return fromEnv;
    if (this.cache.has(name)) return this.cache.get(name) ?? null;
    let value: string | null = null;
    if (process.platform === "darwin") {
      try {
        const { stdout } = await this.exec(SECURITY_BIN, [
          "find-generic-password",
          "-s",
          KEYCHAIN_SERVICE,
          "-a",
          name,
          "-w",
        ]);
        value = stdout.replace(/\n$/, "") || null;
      } catch {
        value = null;
      }
    }
    this.cache.set(name, value);
    return value;
  }
}
