/**
 * Verifies the node:sqlite fallback adapter in src/sqlite.ts behaves as a
 * drop-in for the slice of better-sqlite3 the codebase uses. Forcing the
 * fallback here means CI exercises the exact engine that runs inside Claude
 * Desktop's Electron (whose ABI has no better-sqlite3 prebuild).
 */
import { beforeAll, describe, expect, it } from "vitest";

// Must be set before the engine resolves (lazy: on first `new Database`).
process.env.IMSG_FORCE_NODE_SQLITE = "1";

import Database, { activeSqliteEngine } from "../src/sqlite.js";

describe("sqlite engine — node:sqlite fallback", () => {
  beforeAll(() => {
    // Trigger resolution.
    new Database(":memory:").close();
  });

  it("resolves to node:sqlite when forced", () => {
    expect(activeSqliteEngine()).toBe("node:sqlite");
  });

  it("prepares, inserts, and selects (all/get) with plain-object rows", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const info = db.prepare("INSERT INTO t (name) VALUES (?)").run("alice");
    expect(info.changes).toBe(1);
    expect(typeof info.lastInsertRowid).toBe("number");

    db.prepare("INSERT INTO t (name) VALUES (?)").run("bob");
    const rows = db.prepare("SELECT id, name FROM t ORDER BY id").all() as Array<{
      id: number;
      name: string;
    }>;
    expect(rows).toEqual([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
    // plain object (not null-prototype) — spread/keys behave like better-sqlite3
    expect(Object.getPrototypeOf(rows[0])).toBe(Object.prototype);

    const one = db.prepare("SELECT name FROM t WHERE id = ?").get(2);
    expect(one).toEqual({ name: "bob" });
    const none = db.prepare("SELECT name FROM t WHERE id = ?").get(999);
    expect(none).toBeUndefined();
    db.close();
  });

  it("returns large integers (iMessage ns dates) as Number, not throwing", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE m (date INTEGER)");
    // ~Mac-epoch nanoseconds, well beyond 2^53
    db.prepare("INSERT INTO m (date) VALUES (?)").run(780000000000000000);
    const row = db.prepare("SELECT date FROM m").get() as { date: number };
    expect(typeof row.date).toBe("number");
    expect(row.date).toBeGreaterThan(7e17);
    db.close();
  });

  it("supports @named parameters with bare keys", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE c (k TEXT PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO c (k, v) VALUES (@k, @v)").run({ k: "x", v: "y" });
    expect(db.prepare("SELECT v FROM c WHERE k = @k").get({ k: "x" })).toEqual({ v: "y" });
    db.close();
  });

  it("runs transactions and rolls back on throw", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE n (v INTEGER)");
    const insert = db.prepare("INSERT INTO n (v) VALUES (?)");
    const tx = db.transaction((vals: number[]) => {
      for (const v of vals) insert.run(v);
    });
    tx([1, 2, 3]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM n").get()).toEqual({ c: 3 });

    const boom = db.transaction(() => {
      insert.run(4);
      throw new Error("boom");
    });
    expect(() => boom()).toThrow("boom");
    // rolled back — still 3
    expect(db.prepare("SELECT COUNT(*) AS c FROM n").get()).toEqual({ c: 3 });
    db.close();
  });

  it("honors fileMustExist by throwing on a missing file", () => {
    expect(
      () =>
        new Database("/nonexistent/path/does-not-exist.db", {
          fileMustExist: true,
          readonly: true,
        }),
    ).toThrow();
  });
});
