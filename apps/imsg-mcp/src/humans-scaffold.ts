/**
 * Scaffolding for humans/v1 relationship files (see skills/humans/SKILL.md).
 *
 * Deliberately NOT a CRUD layer: agents read and edit the markdown directly
 * with their own file tools; other tools (email, CRM) contribute to the same
 * files. imsg-mcp only (a) creates a conventional skeleton prefilled with
 * identity + message-history stats, and (b) never overwrites anything —
 * an existing file for the same person is detected by handle overlap and
 * returned as-is.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getHumansDirPath } from "./config.js";
import { normalizedPhoneVariants } from "./contacts-db.js";
import { sanitizeSlugPart } from "./thread-slug.js";

export interface HumanScaffoldInit {
  name: string;
  aliases: string[];
  /** E.164 phones + emails. */
  handles: string[];
  firstContact: Date | null;
  lastContact: Date | null;
  messageCount: number;
}

export interface ScaffoldResult {
  slug: string;
  path: string;
  created: boolean;
}

/** name → person slug (no `~`, so never confusable with thread slugs). */
export function computePersonSlug(name: string, taken: Set<string>): string {
  const base = sanitizeSlugPart(name) || "person";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Normalize a handle for overlap comparison (phones → all variants, emails → lowercase). */
function handleKeys(handle: string): string[] {
  const trimmed = handle.trim();
  if (trimmed.includes("@")) return [trimmed.toLowerCase()];
  return normalizedPhoneVariants(trimmed);
}

/**
 * Parse just the `handles:` list out of a humans-file frontmatter. Tolerant
 * of hand-edited files: returns [] when the file has no parseable block.
 */
export function parseFrontmatterHandles(content: string): string[] {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm?.[1]) return [];
  const lines = fm[1].split("\n");
  const handles: string[] = [];
  let inHandles = false;
  for (const line of lines) {
    if (/^handles:\s*$/.test(line)) {
      inHandles = true;
      continue;
    }
    if (inHandles) {
      const item = line.match(/^\s+-\s+["']?([^"']+)["']?\s*$/);
      if (item?.[1]) {
        handles.push(item[1].trim());
        continue;
      }
      inHandles = false;
    }
    // Flow style: handles: [a, b]
    const flow = line.match(/^handles:\s*\[(.*)\]\s*$/);
    if (flow?.[1]) {
      for (const part of flow[1].split(",")) {
        const v = part.trim().replace(/^["']|["']$/g, "");
        if (v) handles.push(v);
      }
    }
  }
  return handles;
}

export class HumansScaffold {
  constructor(private readonly dir: string = getHumansDirPath()) {}

  /** All existing files' slugs (filenames minus .md). */
  existingSlugs(): Set<string> {
    if (!existsSync(this.dir)) return new Set();
    return new Set(
      readdirSync(this.dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3)),
    );
  }

  /**
   * Find an existing file whose frontmatter handles overlap any of `handles`.
   * Returns its slug, or null. Linear scan — the directory holds tens of
   * files, not thousands.
   */
  findByHandleOverlap(handles: string[]): string | null {
    if (!existsSync(this.dir)) return null;
    const targetKeys = new Set(handles.flatMap(handleKeys));
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = readFileSync(join(this.dir, file), "utf8");
        const fileHandles = parseFrontmatterHandles(content);
        if (fileHandles.some((h) => handleKeys(h).some((k) => targetKeys.has(k)))) {
          return file.slice(0, -3);
        }
      } catch {
        // Unreadable/foreign file — skip, never block scaffolding.
      }
    }
    return null;
  }

  /**
   * Create the conventional skeleton. Never overwrites: an existing file for
   * the same person (by handle overlap) or same slug is returned untouched.
   */
  scaffold(init: HumanScaffoldInit): ScaffoldResult {
    const existing = this.findByHandleOverlap(init.handles);
    if (existing) {
      return { slug: existing, path: join(this.dir, `${existing}.md`), created: false };
    }

    // Legacy same-name file (pre-humans/v1, no parseable frontmatter handles):
    // treat it as the same person rather than minting "<name>-2.md". v1 files
    // keep strict handle-based identity — same name + different handles is a
    // genuinely different person and gets a suffix.
    const base = computePersonSlug(init.name, new Set());
    const basePath = join(this.dir, `${base}.md`);
    if (existsSync(basePath)) {
      try {
        if (parseFrontmatterHandles(readFileSync(basePath, "utf8")).length === 0) {
          return { slug: base, path: basePath, created: false };
        }
      } catch {
        // unreadable — fall through to suffixing, never overwrite
      }
    }

    const slug = computePersonSlug(init.name, this.existingSlugs());
    const path = join(this.dir, `${slug}.md`);
    if (existsSync(path)) {
      return { slug, path, created: false };
    }

    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const content = renderTemplate(init);
    // Atomic-ish write: temp file in the same dir, then rename.
    const tmp = join(this.dir, `.${slug}.md.tmp`);
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    return { slug, path, created: true };
  }
}

function isoDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "null";
}

function yamlList(items: string[]): string {
  if (items.length === 0) return " []";
  return `\n${items.map((i) => `  - "${i.replace(/"/g, "'")}"`).join("\n")}`;
}

export function renderTemplate(init: HumanScaffoldInit): string {
  const today = new Date().toISOString().slice(0, 10);
  const sinceNote = init.firstContact ? ` since ${isoDate(init.firstContact)}` : "";
  return `---
schema: humans/v1
name: ${init.name}
aliases:${yamlList(init.aliases)}
handles:${yamlList(init.handles)}
first_contact: ${isoDate(init.firstContact)}
last_contact: ${isoDate(init.lastContact)}
sources: [imsg-mcp]
updated: ${new Date().toISOString()}
privacy: never-share
---

## Summary

(unwritten — generate from an export: see skills/humans/SKILL.md)

## Facts

## Communication & Preferences

## Boundaries

## Timeline

## Current State (as of ${today.slice(0, 7)})

## Guidance

## Log

- ${today}: file created by imsg-mcp; ${init.messageCount.toLocaleString()} message(s) on record${sinceNote}
`;
}
