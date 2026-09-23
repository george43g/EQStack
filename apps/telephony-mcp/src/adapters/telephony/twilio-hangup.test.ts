/**
 * O-30 hang-up wire contract, against a recording fake `fetch` — no network
 * (INV-14). Pins: the SUBACCOUNT url (never the main account's), Basic auth
 * with the subaccount key SID + the secret resolved by NAME (INV-12), the
 * `Status=completed` form, Twilio 21220 as an idempotent success, and that no
 * secret value reaches an error message. Every SID and secret here is fake.
 */
import { describe, expect, it } from "vitest";
import { FakeSecrets } from "../../../tests/helpers.js";
import { TwilioApiError } from "./twilio-conversation-relay.js";
import { buildPhoneLegHangup, TwilioPhoneLegHangup } from "./twilio-hangup.js";

const SUBACCOUNT = `AC${"1".repeat(32)}`;
const MAIN_ACCOUNT = `AC${"9".repeat(32)}`;
const KEY_SID = `SK${"2".repeat(32)}`;
const CALL_SID = `CA${"0".repeat(32)}`;
const SECRET_REF = "TWILIO_API_KEY_ELEVENLABS_SUBACCOUNT_CALLS_RW";
const SECRET = "fake-subaccount-secret-not-real-0123";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(responses: Array<{ status?: number; json?: unknown; text?: string }>) {
  const seen: Seen[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
    });
    const r = responses.shift();
    if (!r) throw new Error("unexpected extra request");
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, seen };
}

function hangup(impl: typeof fetch, secrets: Record<string, string> = { [SECRET_REF]: SECRET }) {
  return new TwilioPhoneLegHangup({
    accountSid: SUBACCOUNT,
    apiKeySid: KEY_SID,
    apiSecretRef: SECRET_REF,
    secrets: new FakeSecrets({
      // The main account's credentials are present and must NOT be used.
      TWILIO_ACCOUNT_SID: MAIN_ACCOUNT,
      TWILIO_API_KEY: `SK${"8".repeat(32)}`,
      TWILIO_API_SECRET: "main-account-secret",
      ...secrets,
    }),
    fetchImpl: impl,
  });
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection");
}

describe("TwilioPhoneLegHangup (O-30)", () => {
  it("POSTs Status=completed to the SUBACCOUNT's Calls/{sid} with the subaccount key", async () => {
    const { impl, seen } = fakeFetch([{ json: { sid: CALL_SID, status: "completed" } }]);
    await expect(hangup(impl).hangUp(CALL_SID)).resolves.toBe("ended");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${SUBACCOUNT}/Calls/${CALL_SID}.json`,
    );
    expect(seen[0]?.url).not.toContain(MAIN_ACCOUNT);
    expect(seen[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${KEY_SID}:${SECRET}`).toString("base64")}`,
    );
    expect(seen[0]?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(seen[0]?.body))).toEqual({
      Status: "completed",
    });
  });

  it("Twilio 21220 (call not in progress) is success: already-ended", async () => {
    const { impl } = fakeFetch([
      {
        status: 400,
        json: {
          code: 21220,
          message: "Call is not in-progress. Cannot redirect.",
          more_info: "https://www.twilio.com/docs/errors/21220",
          status: 400,
        },
      },
    ]);
    await expect(hangup(impl).hangUp(CALL_SID)).resolves.toBe("already-ended");
  });

  it("any other error throws with status and code, and no secret survives in the message", async () => {
    const { impl } = fakeFetch([
      {
        status: 401,
        // A hostile/echoing body: the secret and the Basic value must both be scrubbed.
        json: {
          code: 20003,
          message: `Authenticate ${SECRET} ${Buffer.from(`${KEY_SID}:${SECRET}`).toString("base64")}`,
          status: 401,
        },
      },
    ]);
    const err = await rejection(hangup(impl).hangUp(CALL_SID));
    expect(err).toBeInstanceOf(TwilioApiError);
    expect((err as TwilioApiError).status).toBe(401);
    expect(err.message).toMatch(/→ 401 \(code 20003\)/);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain(Buffer.from(`${KEY_SID}:${SECRET}`).toString("base64"));
    // The path is named by template, not by the SIDs it carried.
    expect(err.message).toContain("/Calls/{CallSid}.json");
    expect(err.message).not.toContain(CALL_SID);
  });

  it("a 404 is an error, not success: a SID from another account must not look ended", async () => {
    const { impl } = fakeFetch([{ status: 404, json: { code: 20404, status: 404 } }]);
    await expect(hangup(impl).hangUp(CALL_SID)).rejects.toThrow(/→ 404 \(code 20404\)/);
  });

  it("a missing secret names the variable and makes no request (INV-12)", async () => {
    const { impl, seen } = fakeFetch([]);
    const err = await rejection(hangup(impl, {}).hangUp(CALL_SID));
    expect(err.message).toBe(
      `missing Twilio hang-up secret: ${SECRET_REF} (env or opkeep keychain cache)`,
    );
    expect(seen).toHaveLength(0);
  });

  it("buildPhoneLegHangup: absent config builds nothing (end_call keeps refusing)", () => {
    expect(buildPhoneLegHangup(undefined, new FakeSecrets({}))).toBeNull();
    expect(
      buildPhoneLegHangup(
        { accountSid: SUBACCOUNT, apiKeySid: KEY_SID, apiSecretRef: SECRET_REF },
        new FakeSecrets({}),
      )?.id,
    ).toBe("twilio");
  });
});
