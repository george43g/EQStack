/**
 * RS-A delivery-truth tests (BRIEF §9 A1-A4). Pure derivation is faked-row
 * only (RS-INV-3: no live failure exists post-reset). Column tolerance is
 * exercised against the reduced fixture, which genuinely lacks is_sent /
 * is_finished / was_downgraded.
 */
import { describe, expect, it } from "vitest";
import {
  type DeliveryRow,
  deriveDeliveryState,
  deriveDeliveryStatus,
  deriveSendMethod,
} from "../src/delivery-status.js";

describe("deriveDeliveryState (RS-INV-2: never sent-as-delivered)", () => {
  it("A1: delivered when is_delivered=1 and error=0", () => {
    expect(deriveDeliveryState({ error: 0, isDelivered: true })).toBe("delivered");
  });
  it("A2: failed when error != 0 (err=22 = SMS-only-number trap)", () => {
    expect(deriveDeliveryState({ error: 22, isDelivered: false })).toBe("failed");
  });
  it("A3: pending when neither resolves", () => {
    expect(deriveDeliveryState({ error: 0, isDelivered: false })).toBe("pending");
  });
  it("failed dominates even if is_delivered somehow set", () => {
    expect(deriveDeliveryState({ error: 22, isDelivered: true })).toBe("failed");
  });
  it("absent verdict columns ⇒ pending, never a false delivered", () => {
    expect(deriveDeliveryState({})).toBe("pending");
    expect(deriveDeliveryState({ error: null, isDelivered: null })).toBe("pending");
  });
});

describe("deriveSendMethod (realised pathway)", () => {
  it("reports the base service", () => {
    expect(deriveSendMethod({ service: "iMessage" })).toBe("iMessage");
    expect(deriveSendMethod({ service: "SMS" })).toBe("SMS");
  });
  it("A4: an iMessage downgraded to SMS is annotated", () => {
    expect(deriveSendMethod({ service: "iMessage", wasDowngraded: true })).toBe(
      "iMessage (downgraded iMessage→SMS)",
    );
  });
  it("unknown service when the column is absent", () => {
    expect(deriveSendMethod({})).toBe("unknown");
  });
});

describe("deriveDeliveryStatus (the whole shape)", () => {
  it("delivered carries no error and no disclaimer", () => {
    const s = deriveDeliveryStatus({ error: 0, isDelivered: true, service: "iMessage" });
    expect(s).toEqual({ state: "delivered", sendMethod: "iMessage" });
  });
  it("failed carries errorCode + the did-not-leave-this-Mac note", () => {
    const s = deriveDeliveryStatus({ error: 22, service: "iMessage" });
    expect(s.state).toBe("failed");
    expect(s.errorCode).toBe(22);
    expect(s.note).toMatch(/did not leave this Mac/);
  });
  it("pending carries the do-not-assume disclaimer (RS-INV-2)", () => {
    const s = deriveDeliveryStatus({ error: 0, isDelivered: false, service: "SMS" });
    expect(s.state).toBe("pending");
    expect(s.note).toMatch(/Do NOT assume delivered/);
  });
});

describe("row typing is column-tolerant", () => {
  it("a row with only the columns a reduced DB has still derives", () => {
    const reduced: DeliveryRow = { error: 0, isDelivered: true, service: "iMessage" };
    expect(deriveDeliveryStatus(reduced).state).toBe("delivered");
  });
});
