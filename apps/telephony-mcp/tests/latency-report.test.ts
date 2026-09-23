import { describe, expect, it } from "vitest";
import { buildLatencyReport } from "../src/domain/latency-report.js";
import type { CallMode, TurnTiming } from "../src/domain/types.js";

function timing(over: Partial<TurnTiming>): TurnTiming {
  return {
    callId: "c",
    turn: 1,
    endOfTurnMs: 0,
    firstModelTokenMs: null,
    firstTokenToTwilioMs: null,
    interruptedAtMs: null,
    deliveredToHostMs: null,
    replyReceivedMs: null,
    ...over,
  };
}

describe("buildLatencyReport", () => {
  it("splits direct-mode legs and computes percentiles", () => {
    const rows: Array<{ timing: TurnTiming; mode: CallMode }> = [
      {
        mode: "direct",
        timing: timing({
          endOfTurnMs: 1000,
          deliveredToHostMs: 1010,
          replyReceivedMs: 3010,
          firstTokenToTwilioMs: 3040,
        }),
      },
      {
        mode: "direct",
        timing: timing({
          endOfTurnMs: 2000,
          deliveredToHostMs: 2020,
          replyReceivedMs: 6020,
          firstTokenToTwilioMs: 6050,
        }),
      },
    ];
    const r = buildLatencyReport(rows, 2);
    expect(r.calls).toBe(2);
    expect(r.legs["direct.pickup"]?.n).toBe(2);
    expect(r.legs["direct.think"]?.p50).toBeGreaterThanOrEqual(2000);
    expect(r.legs["direct.turn"]?.maxMs).toBe(4050);
  });

  it("drops negative and null legs (wall-clock inversions never poison stats)", () => {
    const r = buildLatencyReport(
      [
        {
          mode: "direct",
          timing: timing({
            endOfTurnMs: 1000,
            deliveredToHostMs: 999, // inverted by 1ms
            replyReceivedMs: 3000,
            firstTokenToTwilioMs: 3020,
          }),
        },
      ],
      1,
    );
    expect(r.legs["direct.pickup"]).toBeUndefined(); // negative dropped
    expect(r.legs["direct.turn"]?.n).toBe(1); // the valid leg survives
  });

  it("byo-model uses its own leg names", () => {
    const r = buildLatencyReport(
      [
        {
          mode: "byo-model",
          timing: timing({ endOfTurnMs: 100, firstModelTokenMs: 400, firstTokenToTwilioMs: 800 }),
        },
      ],
      1,
    );
    expect(r.legs["byo-model.firstToken"]?.p50).toBe(300);
    expect(r.legs["byo-model.firstTokenToTwilio"]?.p50).toBe(700);
    expect(r.legs["direct.turn"]).toBeUndefined();
  });
});

describe("consult legs (Phase R)", () => {
  it("consult.pickup and consult.answer come from question rows; open questions add nothing", () => {
    const report = buildLatencyReport([], 1, [
      { askedAtMs: 1000, firstDeliveredMs: 1200, answeredAtMs: 9000 },
      { askedAtMs: 2000, firstDeliveredMs: 2600, answeredAtMs: 30_000 },
      { askedAtMs: 3000, firstDeliveredMs: null, answeredAtMs: null },
    ]);
    expect(report.legs["consult.pickup"]).toMatchObject({ n: 2, p50: 200, maxMs: 600 });
    expect(report.legs["consult.answer"]).toMatchObject({ n: 2, p50: 8000, maxMs: 28_000 });
  });
});
