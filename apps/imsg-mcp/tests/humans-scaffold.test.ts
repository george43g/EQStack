import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeRelationshipLeaderboard } from "../src/analytics.js";
import {
  computePersonSlug,
  HumansScaffold,
  parseFrontmatterHandles,
  renderTemplate,
} from "../src/humans-scaffold.js";
import type { Message } from "../src/types.js";

let dirs: string[] = [];
function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), "imsg-humans-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const INIT = {
  name: "Sam Smith",
  aliases: ["Dad"],
  handles: ["+61400000000", "sam@example.com"],
  firstContact: new Date("2019-03-14T00:00:00Z"),
  lastContact: new Date("2026-07-10T00:00:00Z"),
  messageCount: 4120,
};

describe("computePersonSlug", () => {
  it("sanitizes and avoids collisions with numeric suffixes", () => {
    expect(computePersonSlug("Sam Smith", new Set())).toBe("sam-smith");
    expect(computePersonSlug("Sam Smith", new Set(["sam-smith"]))).toBe("sam-smith-2");
    expect(computePersonSlug("Sam Smith", new Set(["sam-smith", "sam-smith-2"]))).toBe(
      "sam-smith-3",
    );
  });

  it("never produces a thread-slug-shaped name (no ~)", () => {
    expect(computePersonSlug("weird~name~here", new Set())).not.toContain("~");
  });
});

describe("renderTemplate / parseFrontmatterHandles round-trip", () => {
  it("produces humans/v1 frontmatter whose handles parse back", () => {
    const content = renderTemplate(INIT);
    expect(content).toContain("schema: humans/v1");
    expect(content).toContain("privacy: never-share");
    expect(content).toContain("## Log");
    expect(content).toContain("4,120 message(s) on record since 2019-03-14");
    expect(parseFrontmatterHandles(content)).toEqual(["+61400000000", "sam@example.com"]);
  });

  it("parses flow-style handle lists too", () => {
    const content = `---\nname: X\nhandles: ["+15550001111", x@y.com]\n---\nbody`;
    expect(parseFrontmatterHandles(content)).toEqual(["+15550001111", "x@y.com"]);
  });
});

describe("HumansScaffold", () => {
  it("creates the file with 600 perms in a 700 dir", () => {
    const dir = makeDir();
    rmSync(dir, { recursive: true, force: true }); // scaffold must bootstrap the dir
    const s = new HumansScaffold(dir);
    const r = s.scaffold(INIT);
    expect(r.created).toBe(true);
    expect(r.slug).toBe("sam-smith");
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readFileSync(r.path, "utf8")).toContain("name: Sam Smith");
  });

  it("never overwrites: same handles → existing file returned untouched", () => {
    const dir = makeDir();
    const s = new HumansScaffold(dir);
    const first = s.scaffold(INIT);
    writeFileSync(first.path, readFileSync(first.path, "utf8") + "\n- precious agent edit\n");
    // Different name, overlapping handle (the email) → same person.
    const again = s.scaffold({ ...INIT, name: "Samuel", handles: ["SAM@EXAMPLE.COM"] });
    expect(again.created).toBe(false);
    expect(again.slug).toBe(first.slug);
    expect(readFileSync(first.path, "utf8")).toContain("precious agent edit");
  });

  it("detects overlap across phone format variants", () => {
    const dir = makeDir();
    const s = new HumansScaffold(dir);
    s.scaffold(INIT);
    // Local-format variant of the same AU number.
    const again = s.scaffold({ ...INIT, name: "Other Name", handles: ["0400 000 000"] });
    expect(again.created).toBe(false);
  });

  it("different people get distinct files, colliding names get suffixes", () => {
    const dir = makeDir();
    const s = new HumansScaffold(dir);
    const a = s.scaffold(INIT);
    const b = s.scaffold({ ...INIT, handles: ["+61411111111"], name: "Sam Smith" });
    expect(b.created).toBe(true);
    expect(b.slug).toBe("sam-smith-2");
    expect(a.slug).not.toBe(b.slug);
  });

  it("skips unreadable foreign files without blocking", () => {
    const dir = makeDir();
    const bad = join(dir, "corrupt.md");
    writeFileSync(bad, "no frontmatter here");
    chmodSync(bad, 0o000);
    const s = new HumansScaffold(dir);
    const r = s.scaffold(INIT);
    expect(r.created).toBe(true);
    chmodSync(bad, 0o600);
  });
});

describe("computeRelationshipLeaderboard", () => {
  function msg(
    id: number,
    handle: string,
    isFromMe: boolean,
    daysAgo: number,
    displayName?: string,
  ): Message {
    return {
      id,
      guid: `g${id}`,
      text: "hey",
      // Mirrors messageFromRow: from-me rows carry "me", not the peer handle,
      // and never a displayName — the regression the leaderboard once had.
      handle: isFromMe ? "me" : handle,
      isFromMe,
      date: new Date(Date.now() - daysAgo * 86_400_000),
      dateRead: null,
      dateDelivered: null,
      isRead: true,
      isDelivered: true,
      chatId: handle, // 1:1 chat identifier = the peer handle
      service: "iMessage",
      isReaction: false,
      isReply: false,
      isEdited: false,
      isRetracted: false,
      hasAttachments: false,
      displayName: isFromMe ? undefined : displayName,
    };
  }

  it("ranks balanced, recent, voluminous conversations first", () => {
    const messages: Message[] = [];
    let id = 0;
    // Bestie: 40 msgs, balanced, recent.
    for (let i = 0; i < 20; i++) {
      messages.push(msg(id++, "+15550000001", true, 1, "Bestie"));
      messages.push(msg(id++, "+15550000001", false, 1, "Bestie"));
    }
    // Promo: 40 msgs, entirely one-sided, recent.
    for (let i = 0; i < 40; i++) {
      messages.push(msg(id++, "+15550000002", false, 1, "Promo Sender"));
    }
    // Old friend: balanced but 200 days stale.
    for (let i = 0; i < 20; i++) {
      messages.push(msg(id++, "+15550000003", i % 2 === 0, 200, "Old Friend"));
    }
    const { leaderboard } = computeRelationshipLeaderboard(messages);
    expect(leaderboard[0].contact).toBe("Bestie");
    const promo = leaderboard.find((r) => r.contact === "Promo Sender");
    const old = leaderboard.find((r) => r.contact === "Old Friend");
    // One-sided and stale conversations score far below the balanced recent one.
    if (promo) expect(promo.score).toBeLessThan(leaderboard[0].score / 2);
    if (old) expect(old.score).toBeLessThan(leaderboard[0].score / 2);
  });

  it("excludes group chats and reactions", () => {
    const groupMsg = {
      ...msg(1, "+15550000001", false, 1, "Groupie"),
      chatId: "chat123456789",
    };
    const reaction = { ...msg(2, "+15550000004", false, 1, "Reactor"), isReaction: true };
    const { leaderboard } = computeRelationshipLeaderboard([groupMsg, reaction]);
    expect(leaderboard).toHaveLength(0);
  });
});

describe("legacy (pre-v1) file compatibility", () => {
  it("a same-name file without frontmatter is treated as the same person", () => {
    const dir = makeDir();
    writeFileSync(
      join(dir, "sam-smith.md"),
      "# Sam Smith — Human Memory\n\nlegacy prose file, no frontmatter\n",
    );
    const s = new HumansScaffold(dir);
    const r = s.scaffold(INIT);
    expect(r.created).toBe(false);
    expect(r.slug).toBe("sam-smith");
    expect(readFileSync(r.path, "utf8")).toContain("legacy prose file");
  });
});
