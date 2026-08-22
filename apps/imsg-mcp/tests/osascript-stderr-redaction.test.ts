/**
 * osascript stderr is the one imsg log boundary that carries a recipient
 * handle: AppleScript quotes the address back in its failure text ("Can't get
 * buddy id \"alice@example.com\"…"). Phones ride the kit logger's default-on
 * rules; EMAILS are opt-in kit-wide (the email shape also matches package
 * specifiers and git remotes — enabling it globally would mangle
 * "@george43g/robustness@0.12.0" in every log line), so this call site opts in
 * deliberately, and this test pins that it stays opted in.
 */
import { redactString } from "@george43g/robustness";
import { describe, expect, it } from "vitest";

describe("osascript stderr redaction (the imsg email boundary)", () => {
  const STDERR = 'execution error: Can\'t get buddy id "alice@example.com" of service 1. (-1728)';

  it("hides the local part of a quoted recipient address, keeping the domain", () => {
    const out = redactString(STDERR, { emails: true });
    expect(out).not.toContain("alice@example.com");
    expect(out).toContain("@example.com"); // domain is the diagnostic half
    expect(out).toContain("-1728"); // the error code a human needs survives
  });

  it("leaves package specifiers alone when redaction is NOT opted in", () => {
    // The five-of-six measurement behind the kit's default-OFF choice: this is
    // why the opt-in above is scoped to one bounded text domain rather than
    // switched on globally.
    const line = "resolved @george43g/robustness@0.12.0 from registry";
    expect(redactString(line)).toContain("@george43g/robustness@0.12.0");
  });

  it("still redacts phone numbers without any opt-in (kit default)", () => {
    const phoneErr = 'Can\'t get buddy id "+61401234567" of service 1.';
    expect(redactString(phoneErr)).not.toContain("+61401234567");
  });
});
