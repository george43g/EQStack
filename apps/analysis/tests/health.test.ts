import { describe, expect, it } from "vitest";
import { APP_NAME, health } from "../src/index.js";

describe("blank app shell", () => {
  it("reports healthy", () => {
    expect(health()).toEqual({ ok: true, app: APP_NAME });
  });
});
