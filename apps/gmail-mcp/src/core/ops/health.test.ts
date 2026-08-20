// Handler-level tests for src/core/ops/health.ts.
//
// Covers health_check text/structured output plus degraded/unhealthy branches
// driven by event-loop p99 and watchdog kill reasons.
//
// Strategy: mock the local health-snapshot seam. Tests that drive
// degraded/unhealthy branches fabricate a full snapshot through it (the
// status-computation logic itself is covered upstream in
// mcp-cli-starter-template's robustness suite); tests that only exercise
// session counters leave the holder null and flow through the REAL package
// snapshotHealth. Side-effect import of ./health.js registers the op; we
// dispatch through the registry singleton with a stub context (the handler
// never touches ctx.gmail).

import type { HealthSnapshot } from "@george43g/robustness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationContext } from "../context.js";
import { registry } from "../registry.js";
import { _resetForTests, incrementToolCallCount, recordToolError } from "../session.js";

const mockSnapshot = vi.hoisted(() => ({ value: null as HealthSnapshot | null }));

vi.mock("../health-snapshot.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../health-snapshot.js")>();
  return {
    takeHealthSnapshot: (counters: { toolCalls: number; recentErrors: number }) =>
      mockSnapshot.value
        ? {
            ...mockSnapshot.value,
            tool_calls: counters.toolCalls,
            recent_errors: counters.recentErrors,
          }
        : real.takeHealthSnapshot(counters),
  };
});

function makeSnap(over: Partial<HealthSnapshot>): HealthSnapshot {
  return {
    status: "healthy",
    issues: [],
    uptime_s: 1,
    pid: process.pid,
    node: process.version,
    heap_mb: 10,
    rss_mb: 50,
    event_loop_p99_ms: 0,
    event_loop_max_ms: 0,
    tool_calls: 0,
    recent_errors: 0,
    last_activity_age_s: 0,
    ...over,
  };
}

// Side-effect: registers the health_check op on the registry singleton.
await import("./health.js");

function makeCtx(): OperationContext {
  // health_check never touches ctx.gmail / ctx.oauth2Client, so these are
  // intentionally untyped stubs cast to the interface.
  return {
    gmail: {} as OperationContext["gmail"],
    oauth2Client: {} as OperationContext["oauth2Client"],
    authorizedScopes: [],
    toolName: "health_check",
  };
}

describe("health_check handler (8.1)", () => {
  beforeEach(() => {
    mockSnapshot.value = null;
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
  });

  it("returns healthy when watchdog is quiet and no recent errors", async () => {
    const result = await registry.dispatch("health_check", {}, makeCtx());

    expect(result.content[0].text).toContain("Status: healthy");
    expect(result.content[0].text).not.toContain("Issues:");

    // structuredContent (typed output) reflects the snapshot.
    const sc = result.structuredContent as {
      status: string;
      issues: string[];
      tool_calls: number;
      recent_errors: number;
      pid: number;
    };
    expect(sc.status).toBe("healthy");
    expect(sc.issues).toEqual([]);
    expect(sc.tool_calls).toBe(0);
    expect(sc.recent_errors).toBe(0);
    expect(sc.pid).toBe(process.pid);
  });

  it("threads session counters (tool_calls + recent_errors) into the snapshot", async () => {
    incrementToolCallCount();
    incrementToolCallCount();
    incrementToolCallCount();
    recordToolError();
    recordToolError();

    const result = await registry.dispatch("health_check", {}, makeCtx());
    const sc = result.structuredContent as { tool_calls: number; recent_errors: number };
    expect(sc.tool_calls).toBe(3);
    expect(sc.recent_errors).toBe(2);
  });

  it("propagates a degraded snapshot (event-loop p99 issue)", async () => {
    mockSnapshot.value = makeSnap({
      status: "degraded",
      issues: ["event loop p99 750ms"],
      event_loop_p99_ms: 750,
    });

    const result = await registry.dispatch("health_check", {}, makeCtx());

    expect(result.content[0].text).toContain("Status: degraded");
    expect(result.content[0].text).toContain("Issues: event loop p99 750ms");
    const sc = result.structuredContent as { status: string; issues: string[] };
    expect(sc.status).toBe("degraded");
    expect(sc.issues).toEqual(["event loop p99 750ms"]);
  });

  it("returns degraded when recent errors >= 5 and event-loop is quiet", async () => {
    for (let i = 0; i < 5; i++) recordToolError();

    const result = await registry.dispatch("health_check", {}, makeCtx());

    const sc = result.structuredContent as {
      status: string;
      issues: string[];
      recent_errors: number;
    };
    expect(sc.status).toBe("degraded");
    expect(sc.recent_errors).toBe(5);
    expect(sc.issues.some((i) => i.includes("5 recent errors"))).toBe(true);
  });
});

describe("health op propagates unhealthy snapshots (8.2)", () => {
  beforeEach(() => {
    mockSnapshot.value = null;
    _resetForTests();
  });

  afterEach(() => {
    _resetForTests();
  });

  it("returns unhealthy when the snapshot reports a blocked event loop", async () => {
    mockSnapshot.value = makeSnap({
      status: "unhealthy",
      issues: ["event loop p99 5000ms"],
      event_loop_p99_ms: 5000,
    });

    const result = await registry.dispatch("health_check", {}, makeCtx());

    const sc = result.structuredContent as { status: string; issues: string[] };
    expect(sc.status).toBe("unhealthy");
    expect(sc.issues).toEqual(["event loop p99 5000ms"]);
    expect(result.content[0].text).toContain("Status: unhealthy");
  });

  it("returns unhealthy when the snapshot carries a watchdog kill", async () => {
    mockSnapshot.value = makeSnap({
      status: "unhealthy",
      issues: ["watchdog kill: rss_exceeded"],
    });

    const result = await registry.dispatch("health_check", {}, makeCtx());

    const sc = result.structuredContent as { status: string; issues: string[] };
    expect(sc.status).toBe("unhealthy");
    expect(sc.issues).toContain("watchdog kill: rss_exceeded");
    expect(result.content[0].text).toContain("Status: unhealthy");
    expect(result.content[0].text).toContain("Issues: watchdog kill: rss_exceeded");
  });

  it("renders multiple issues from an unhealthy snapshot", async () => {
    mockSnapshot.value = makeSnap({
      status: "unhealthy",
      issues: ["event loop p99 750ms", "watchdog kill: event_loop_blocked"],
      event_loop_p99_ms: 750,
    });

    const result = await registry.dispatch("health_check", {}, makeCtx());

    const sc = result.structuredContent as { status: string; issues: string[] };
    expect(sc.status).toBe("unhealthy");
    // Both issues recorded — event-loop pushed in first, killReason second.
    expect(sc.issues).toEqual(["event loop p99 750ms", "watchdog kill: event_loop_blocked"]);
  });
});
