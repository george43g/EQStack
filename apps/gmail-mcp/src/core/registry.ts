// Operation registry — single source of truth for tool dispatch.
//
// Replaces the giant `switch (name)` in src/index.ts. Each per-category file
// under src/core/ops/ registers its operations here at module load time;
// the dispatcher looks up by name and runs handler(input, ctx).
//
// Migration is progressive — until every op is registered, the dispatcher
// in src/index.ts falls through to its switch for any unregistered name.
// Use `has()` to gate that fallthrough.

import type { z } from "zod";
import type { OperationContext } from "./context.js";

export interface OperationResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  structuredContent?: unknown;
}

export interface Operation<TInput = unknown> {
  /** Matches the tool name in src/tools.ts. */
  name: string;
  /** Zod schema used to parse `args` before the handler runs. */
  schema: z.ZodType<TInput>;
  /** Scopes mirrored from tools.ts — for runtime auth gating sanity. */
  scopes: string[];
  /** Pure async function. Throws on Gmail/transport errors — the dispatcher
   *  wraps via auth-errors.wrapToolError. */
  handler: (input: TInput, ctx: OperationContext) => Promise<OperationResult>;
}

export class OperationRegistry {
  private ops = new Map<string, Operation<any>>();

  register<T>(op: Operation<T>): void {
    if (this.ops.has(op.name)) {
      throw new Error(`OperationRegistry: duplicate registration for "${op.name}"`);
    }
    this.ops.set(op.name, op as Operation<any>);
  }

  has(name: string): boolean {
    return this.ops.has(name);
  }

  get(name: string): Operation<any> | undefined {
    return this.ops.get(name);
  }

  names(): string[] {
    return Array.from(this.ops.keys());
  }

  /**
   * Parse args via the op's schema, then run the handler. Schema errors
   * propagate as zod ZodError — the dispatcher converts to a tool-error
   * MCP response with the wrapToolError formatter.
   */
  async dispatch(
    name: string,
    rawArgs: unknown,
    ctx: OperationContext,
  ): Promise<OperationResult> {
    const op = this.ops.get(name);
    if (!op) {
      throw new Error(`OperationRegistry: no op registered for "${name}"`);
    }
    const input = op.schema.parse(rawArgs);
    return op.handler(input, ctx);
  }
}

/**
 * Process-wide registry singleton. Per-category files import this and call
 * `register(...)` at module load.
 */
export const registry = new OperationRegistry();
