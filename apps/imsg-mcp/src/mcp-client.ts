import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "./meta.js";

export interface ToolCallResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

function distRoot(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export class LocalMcpClient {
  private proc: ReturnType<typeof spawn>;
  private requestId = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private outBuf = "";
  private closed = false;

  constructor(private readonly onStderr?: (line: string) => void) {
    const entry = join(distRoot(), "cli.js");
    if (!existsSync(entry)) {
      throw new Error("dist/cli.js not found. Run `pnpm build` first.");
    }

    this.proc = spawn(process.execPath, [entry, "mcp"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      this.onStderr?.(chunk.toString("utf8"));
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.outBuf += chunk.toString("utf8");
      const lines = this.outBuf.split("\n");
      this.outBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as { id?: number };
          if (message.id != null && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            pending?.resolve(message);
          }
        } catch {
          // Ignore non-JSON lines on stdout.
        }
      }
    });

    // Handle unexpected child exit — reject all pending requests
    this.proc.on("exit", (code) => {
      if (this.closed) return;
      for (const [, p] of this.pending) {
        p.reject(new Error(`MCP child exited unexpectedly with code ${code}`));
      }
      this.pending.clear();
    });
  }

  async start(): Promise<void> {
    const response = (await this.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "imsg", version: APP_VERSION },
    })) as { result?: unknown };

    if (response.result) {
      this.proc.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
      );
    }
  }

  async callTool(name: string, args: object, timeoutMs = 30_000): Promise<ToolCallResult> {
    const response = (await this.call("tools/call", { name, arguments: args }, timeoutMs)) as {
      result?: ToolCallResult;
      error?: { message: string };
    };
    if (response.error) {
      throw new Error(response.error.message);
    }
    return response.result ?? {};
  }

  async listTools(timeoutMs = 15_000): Promise<{ name: string; description?: string }[]> {
    const response = (await this.call("tools/list", {}, timeoutMs)) as {
      result?: { tools?: { name: string; description?: string }[] };
      error?: { message: string };
    };
    if (response.error) {
      throw new Error(response.error.message);
    }
    return response.result?.tools ?? [];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Close stdin to signal the child
    this.proc.stdin!.end();

    // Give child 2s to exit gracefully, then force kill
    const killTimer = setTimeout(() => {
      if (!this.proc.killed) {
        this.proc.kill("SIGKILL");
      }
    }, 2000);
    killTimer.unref();

    this.proc.on("exit", () => clearTimeout(killTimer));
    this.proc.kill("SIGTERM");

    // Reject any remaining pending requests
    for (const [, p] of this.pending) {
      p.reject(new Error("MCP client closed"));
    }
    this.pending.clear();
  }

  private call(method: string, params: object, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("MCP client is closed"));
        return;
      }

      const id = ++this.requestId;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Request timeout after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref(); // Don't prevent process exit

      const original = this.pending.get(id);
      if (!original) return;
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          original.resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          original.reject(error);
        },
      });
    });
  }
}
