/**
 * HumansIndex — the read-side companion to humans-scaffold: matches
 * conversation participant handles to existing humans/v1 files so tool
 * output can point agents at them.
 */

import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HUMANS_GUIDANCE, HumansIndex, humansHintText } from "../src/humans-hints.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function makeHumansDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "imsg-humans-hints-"));
  tempDirs.push(dir);
  return dir;
}

function writeHuman(dir: string, slug: string, name: string, handles: string[]): string {
  const path = join(dir, `${slug}.md`);
  const handleLines = handles.map((h) => `  - "${h}"`).join("\n");
  writeFileSync(
    path,
    `---\nschema: humans/v1\nname: ${name}\naliases: []\nhandles:\n${handleLines}\nprivacy: never-share\n---\n\n## Summary\n`,
  );
  return path;
}

describe("HumansIndex", () => {
  it("matches a participant phone in any normalized variant", () => {
    const dir = makeHumansDir();
    // Card stores local format; chat identifiers are E.164.
    const path = writeHuman(dir, "alice", "Alice Tester", ["0408 111 222"]);
    const index = new HumansIndex(dir);
    const refs = index.lookup(["+61408111222"]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: "Alice Tester", path, handle: "+61408111222" });
  });

  it("dedupes one person matched via both phone and email", () => {
    const dir = makeHumansDir();
    writeHuman(dir, "bob", "Bob Example", ["+15550001111", "bob@example.com"]);
    const index = new HumansIndex(dir);
    const refs = index.lookup(["+15550001111", "Bob@Example.com"]);
    expect(refs).toHaveLength(1);
  });

  it("returns one ref per person for group participants", () => {
    const dir = makeHumansDir();
    writeHuman(dir, "alice", "Alice", ["+15550001111"]);
    writeHuman(dir, "bob", "Bob", ["+15550002222"]);
    const index = new HumansIndex(dir);
    const refs = index.lookup(["+15550001111", "+15550002222", "+15550009999"]);
    expect(refs.map((r) => r.name).sort()).toEqual(["Alice", "Bob"]);
  });

  it("empty results when the directory does not exist", () => {
    const index = new HumansIndex(join(tmpdir(), "definitely-missing-humans-dir"));
    expect(index.lookup(["+15550001111"])).toEqual([]);
    expect(index.hintFor(["+15550001111"])).toBeNull();
  });

  it("picks up files added after the first lookup (dir mtime cache)", () => {
    const dir = makeHumansDir();
    const index = new HumansIndex(dir);
    expect(index.lookup(["+15550001111"])).toEqual([]);
    writeHuman(dir, "carol", "Carol", ["+15550001111"]);
    // Ensure the directory mtime visibly advances even on coarse filesystems.
    const t = new Date(statSync(dir).mtimeMs + 2000);
    utimesSync(dir, t, t);
    expect(index.lookup(["+15550001111"])).toHaveLength(1);
  });

  it("skips unreadable/foreign files without breaking", () => {
    const dir = makeHumansDir();
    writeFileSync(join(dir, "notes.md"), "no frontmatter here");
    writeFileSync(join(dir, "junk.txt"), "ignored entirely");
    writeHuman(dir, "dave", "Dave", ["dave@example.com"]);
    const index = new HumansIndex(dir);
    expect(index.lookup(["dave@example.com"])).toHaveLength(1);
  });

  it("hintFor embeds the standing guidance and humansHintText renders paths", () => {
    const dir = makeHumansDir();
    const path = writeHuman(dir, "erin", "Erin", ["+15550003333"]);
    const hint = new HumansIndex(dir).hintFor(["+15550003333"]);
    expect(hint).not.toBeNull();
    expect(hint!.guidance).toBe(HUMANS_GUIDANCE);
    const text = humansHintText(hint!);
    expect(text).toContain(path);
    expect(text).toContain("Erin");
  });
});
