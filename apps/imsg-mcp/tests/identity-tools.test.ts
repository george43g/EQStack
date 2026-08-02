import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMessageMCPServer } from "../src/index.js";

/**
 * get_contact and resolve_handle must attach a consistent `identity` block so
 * an agent gets one normalized shape (E.164 phones, lowercased emails, deduped
 * handles) regardless of which tool resolved the person — and resolve_handle
 * returns it even for an unknown handle. Runs the real handlers on the dev DB.
 */
describe("identity block on contact-resolving tools", () => {
  let server: any;

  beforeAll(() => {
    process.env.IMSG_DEV = "1";
    server = new IMessageMCPServer();
  });

  afterAll(async () => {
    delete process.env.IMSG_DEV;
    await server.db?.close();
  });

  const sc = (r: any) => r.structuredContent;

  it("resolve_handle returns a normalized identity even for an unknown handle", async () => {
    // A handle almost certainly absent from any real address book.
    const r = sc(await server.handleResolveHandle({ handle: "+1 (999) 555-0123" }));
    expect(r.identity).toBeDefined();
    expect(r.identity.canonicalName).toBe("+1 (999) 555-0123");
    // The raw phone is normalized to E.164 in the identity view.
    expect(r.identity.phones).toEqual(["+19995550123"]);
    expect(r.identity.handles).toEqual(["+19995550123"]);
    expect(r.identity.emails).toEqual([]);
  });

  it("resolve_handle classifies an unknown email handle", async () => {
    const r = sc(await server.handleResolveHandle({ handle: "Nobody-XYZ@Nowhere.invalid" }));
    expect(r.identity.emails).toEqual(["nobody-xyz@nowhere.invalid"]);
    expect(r.identity.phones).toEqual([]);
  });

  it("get_contact attaches an identity mirroring the contact's handles", async () => {
    // Grab a real contact from the dev DB, then look it up by id.
    const list = sc(await server.handleListContacts({ limit: 1 }));
    if (list.count === 0) return; // no contacts bundled → nothing to assert
    const id = list.contacts[0].id;
    const gc = sc(await server.handleGetContact({ id }));
    expect(gc.identity).toBeDefined();
    expect(gc.identity.canonicalName).toBe(gc.contact.displayName);
    // handles is the union of phones + emails (deduped) → counts line up.
    expect(gc.identity.handles.length).toBe(gc.identity.phones.length + gc.identity.emails.length);
  });

  it("get_contact on a miss has no identity (contact null)", async () => {
    const gc = sc(await server.handleGetContact({ handle: "+1 (999) 555-0123" }));
    expect(gc.contact).toBeNull();
    expect(gc.identity).toBeUndefined();
  });
});
