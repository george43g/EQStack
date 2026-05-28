import { describe, expect, it } from "vitest";
import { buildComposeTemplate, parseCompose, quoteReplyBody } from "./compose-parser.js";

describe("parseCompose", () => {
  it("splits headers from body on the first blank line", () => {
    const raw = "To: a@b.test\nSubject: hi\n\nbody line 1\nbody line 2\n";
    const parsed = parseCompose(raw);
    expect(parsed.to).toEqual(["a@b.test"]);
    expect(parsed.subject).toBe("hi");
    expect(parsed.body).toBe("body line 1\nbody line 2\n");
  });

  it("handles comma-separated recipients with optional whitespace", () => {
    const raw = "To: a@b.test , c@d.test ,e@f.test\n\n";
    const parsed = parseCompose(raw);
    expect(parsed.to).toEqual(["a@b.test", "c@d.test", "e@f.test"]);
  });

  it("ignores empty Cc/Bcc lines without crashing", () => {
    const raw = "To: a@b.test\nCc:\nBcc:\nSubject: hi\n\nbody\n";
    const parsed = parseCompose(raw);
    expect(parsed.cc).toEqual([]);
    expect(parsed.bcc).toEqual([]);
    expect(parsed.body).toBe("body\n");
  });

  it("normalises CRLF line endings before parsing", () => {
    const raw = "To: a@b.test\r\nSubject: hi\r\n\r\nbody\r\n";
    const parsed = parseCompose(raw);
    expect(parsed.subject).toBe("hi");
    expect(parsed.body).toBe("body\n");
  });

  it("treats a malformed header line as start of body (fault-tolerant)", () => {
    const raw = "To: a@b.test\nthis is not a header\nstill body\n";
    const parsed = parseCompose(raw);
    expect(parsed.to).toEqual(["a@b.test"]);
    expect(parsed.body).toBe("this is not a header\nstill body\n");
  });

  it("preserves URLs that contain colons inside the body", () => {
    const raw = "To: a@b.test\nSubject: links\n\nSee https://example.test/path:foo\n";
    const parsed = parseCompose(raw);
    expect(parsed.body).toBe("See https://example.test/path:foo\n");
  });
});

describe("buildComposeTemplate", () => {
  it("emits headers in canonical order with empty defaults", () => {
    expect(buildComposeTemplate({})).toBe("To: \nCc: \nBcc: \nSubject: \n\n");
  });

  it("joins multiple recipients with comma-space", () => {
    const tmpl = buildComposeTemplate({ to: ["a@b.test", "c@d.test"], subject: "hi" });
    expect(tmpl).toContain("To: a@b.test, c@d.test");
    expect(tmpl).toContain("Subject: hi");
  });
});

describe("quoteReplyBody", () => {
  it("prepends `On … wrote:` and quotes each line with `> `", () => {
    const out = quoteReplyBody("alice@x.test", "Mon, 1 Jan", "hello\nworld");
    expect(out).toContain("On Mon, 1 Jan, alice@x.test wrote:");
    expect(out).toContain("> hello");
    expect(out).toContain("> world");
  });
});
