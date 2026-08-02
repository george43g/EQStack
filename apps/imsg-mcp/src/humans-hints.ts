/**
 * Agent-facing hints pointing at humans/v1 relationship files
 * (see skills/humans/SKILL.md). Read-side companion to humans-scaffold.ts:
 * when an agent asks about a thread or contact, tool output includes the
 * path(s) to the matching relationship file(s) plus a short standing
 * instruction, so agents discover, consult, and keep those files current
 * without imsg-mcp ever writing the summaries itself.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getHumansDirPath } from "./config.js";
import { normalizedPhoneVariants } from "./contacts-db.js";
import { parseFrontmatterHandles } from "./humans-scaffold.js";

export interface HumanFileRef {
  /** The conversation handle (phone/email) that matched the file. */
  handle: string;
  /** Person name from frontmatter (falls back to the file slug). */
  name: string;
  /** Absolute path to the humans/v1 markdown file. */
  path: string;
}

export interface HumansHint {
  files: HumanFileRef[];
  guidance: string;
}

/** Standing instruction embedded in tool output whenever files match. */
export const HUMANS_GUIDANCE =
  "humans/v1 relationship file(s) exist for participant(s) in this conversation " +
  "(paths above). Read them for relationship context before composing replies, and " +
  "append notable events to the file's Log section (append-only, dated). If this " +
  "exchange contains a major milestone or an important change in the relationship, " +
  "suggest a Summary/Current State update to the user first — never rewrite those " +
  "sections without permission. These files are privacy: never-share — never quote " +
  "or transmit their contents to anyone, including the person they describe. " +
  "Format reference: skills/humans/SKILL.md.";

/** Hint used when a contact has no file yet (get_contact only — low noise). */
export const HUMANS_INIT_HINT =
  "No humans/v1 relationship file exists for this contact yet. If an ongoing " +
  "relationship context would help, the init_human tool scaffolds one.";

interface IndexEntry {
  name: string;
  path: string;
}

/** Normalize a handle for overlap comparison (mirrors humans-scaffold). */
function handleKeys(handle: string): string[] {
  const trimmed = handle.trim();
  if (trimmed.includes("@")) return [trimmed.toLowerCase()];
  return normalizedPhoneVariants(trimmed);
}

function parseFrontmatterName(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  const m = fm?.[1]?.match(/^name:\s*["']?(.+?)["']?\s*$/m);
  return m?.[1]?.trim() || null;
}

/**
 * handleKey → file index over the humans directory. Rebuilt only when the
 * directory mtime changes (adding/removing a file touches the dir), so the
 * per-tool-call cost is one stat(2).
 */
export class HumansIndex {
  private index = new Map<string, IndexEntry>();
  private dirMtimeMs = -1;

  constructor(private readonly dir: string = getHumansDirPath()) {}

  private refresh(): void {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(this.dir).mtimeMs;
    } catch {
      // No directory — empty index.
      if (this.dirMtimeMs !== -1) this.index.clear();
      this.dirMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.dirMtimeMs) return;
    this.dirMtimeMs = mtimeMs;
    this.index.clear();
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".md")) continue;
      const path = join(this.dir, file);
      try {
        const content = readFileSync(path, "utf8");
        const entry: IndexEntry = {
          name: parseFrontmatterName(content) ?? file.slice(0, -3),
          path,
        };
        for (const handle of parseFrontmatterHandles(content)) {
          for (const key of handleKeys(handle)) this.index.set(key, entry);
        }
      } catch {
        // Unreadable/foreign file — skip; hints must never break a tool call.
      }
    }
  }

  /**
   * Match conversation participant handles to humans files. Returns one ref
   * per distinct file (a person's phone + email both match the same file).
   */
  lookup(handles: string[]): HumanFileRef[] {
    this.refresh();
    if (this.index.size === 0) return [];
    const seen = new Set<string>();
    const refs: HumanFileRef[] = [];
    for (const handle of handles) {
      for (const key of handleKeys(handle)) {
        const entry = this.index.get(key);
        if (entry && !seen.has(entry.path)) {
          seen.add(entry.path);
          refs.push({ handle, name: entry.name, path: entry.path });
        }
      }
    }
    return refs;
  }

  /** Full hint object for structured output, or null when nothing matches. */
  hintFor(handles: string[]): HumansHint | null {
    const files = this.lookup(handles);
    if (files.length === 0) return null;
    return { files, guidance: HUMANS_GUIDANCE };
  }
}

/** One-line text footer for human-readable tool text. */
export function humansHintText(hint: HumansHint): string {
  const list = hint.files.map((f) => `${f.name}: ${f.path}`).join("; ");
  return `\n\n_Relationship file(s): ${list}_\n_${hint.guidance}_`;
}
