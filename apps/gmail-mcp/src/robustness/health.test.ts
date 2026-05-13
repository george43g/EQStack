import { describe, expect, it } from "vitest";
import { formatHealthText, type HealthSnapshot, snapshotHealth } from "./health.js";

describe("snapshotHealth", () => {
  it("returns healthy under normal conditions", () => {
    const s = snapshotHealth({ toolCalls: 5, recentErrors: 0 });
    expect(s.status).toBe("healthy");
    expect(s.issues).toEqual([]);
    expect(s.tool_calls).toBe(5);
    expect(s.recent_errors).toBe(0);
    expect(s.pid).toBe(process.pid);
    expect(typeof s.node).toBe("string");
    expect(s.heap_mb).toBeGreaterThan(0);
    expect(s.rss_mb).toBeGreaterThan(0);
  });

  it("flags degraded when recentErrors >= 5", () => {
    const s = snapshotHealth({ toolCalls: 100, recentErrors: 5 });
    expect(s.status).toBe("degraded");
    expect(s.issues.some((i) => i.includes("recent errors"))).toBe(true);
  });

  it("snapshot includes uptime and last activity age (numbers)", () => {
    const s = snapshotHealth({ toolCalls: 0, recentErrors: 0 });
    expect(typeof s.uptime_s).toBe("number");
    expect(typeof s.last_activity_age_s).toBe("number");
  });
});

describe("formatHealthText", () => {
  function snap(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
    return {
      status: "healthy",
      issues: [],
      uptime_s: 10,
      pid: 1234,
      node: "v20.0.0",
      heap_mb: 50,
      rss_mb: 80,
      event_loop_p99_ms: 1.2,
      event_loop_max_ms: 5,
      tool_calls: 3,
      recent_errors: 0,
      last_activity_age_s: 1,
      ...overrides,
    };
  }

  it("renders Status, Uptime, PID, Memory, Event loop, Tool calls", () => {
    const text = formatHealthText(snap());
    expect(text).toContain("Status: healthy");
    expect(text).toContain("Uptime: 10s");
    expect(text).toContain("PID: 1234");
    expect(text).toContain("Node: v20.0.0");
    expect(text).toContain("heap 50 MB");
    expect(text).toContain("RSS 80 MB");
    expect(text).toContain("p99: 1.2 ms");
    expect(text).toContain("Tool calls: 3");
  });

  it("omits Issues line when empty", () => {
    const text = formatHealthText(snap());
    expect(text).not.toContain("Issues:");
  });

  it("renders Issues when present", () => {
    const text = formatHealthText(
      snap({
        status: "degraded",
        issues: ["event loop p99 600ms", "5 recent errors"],
      }),
    );
    expect(text).toContain("Status: degraded");
    expect(text).toContain("Issues: event loop p99 600ms, 5 recent errors");
  });
});
