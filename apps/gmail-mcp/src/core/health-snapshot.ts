// Thin seam over @george43g/robustness's snapshotHealth.
//
// The package computes the snapshot from watchdog state read through a
// package-INTERNAL binding, which no consumer-side mock can reach (vitest
// externalizes node_modules). This one-function indirection gives our tests a
// mockable boundary: they drive synthetic snapshots through it and assert OUR
// wiring (op envelope shape, /health status-code mapping) — the branch logic
// that turns raw state into healthy/degraded/unhealthy is covered upstream in
// mcp-cli-starter-template's suite, not re-tested here.
//
// An injectable-state param for snapshotHealth is on order upstream; when it
// lands this seam can collapse to a direct call, but it is also fine to keep.
import { type HealthCounters, type HealthSnapshot, snapshotHealth } from "@george43g/robustness";

export function takeHealthSnapshot(counters: HealthCounters): HealthSnapshot {
  return snapshotHealth(counters);
}
