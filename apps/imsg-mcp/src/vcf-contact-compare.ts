/**
 * Parse env-data/contacts.vcf and compare handle resolution against ContactsDB.lookupHandle.
 * Used by scripts/compare-contacts-vcf.ts and Vitest.
 */

import { readFileSync } from "node:fs";

export interface VCardEntry {
  fn: string;
  tel: string[];
  email: string[];
}

export interface VcfHandleCompareStats {
  match: number;
  mismatch: number;
  notFound: number;
  total: number;
  /** 0–1; 1 if total === 0 */
  matchRate: number;
}

export function parseVcf(text: string): VCardEntry[] {
  const entries: VCardEntry[] = [];
  const blocks = text.split(/(?=BEGIN:VCARD)/).filter(Boolean);

  for (const block of blocks) {
    if (!block.trim().startsWith("BEGIN:VCARD")) continue;
    let fn = "";
    const tel: string[] = [];
    const email: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("FN:")) {
        fn = trimmed.slice(3).trim();
      } else if (trimmed.startsWith("TEL;") || trimmed.startsWith("TEL:")) {
        const value = trimmed.replace(/^TEL[^:]*:/, "").trim();
        if (value) tel.push(value);
      } else if (trimmed.startsWith("EMAIL;") || trimmed.startsWith("EMAIL:")) {
        const value = trimmed.replace(/^EMAIL[^:]*:/, "").trim();
        if (value) email.push(value);
      }
    }
    if (fn || tel.length || email.length) {
      entries.push({ fn, tel, email });
    }
  }
  return entries;
}

export function parseVcfFile(path: string): VCardEntry[] {
  return parseVcf(readFileSync(path, "utf-8"));
}

/**
 * For each TEL/EMAIL in the VCF, compare ContactsDB.lookupHandle(handle) to the VCF FN (exact string).
 */
export function compareVcfEntriesToContacts(
  entries: VCardEntry[],
  lookupHandle: (handle: string) => string,
): VcfHandleCompareStats {
  let match = 0;
  let mismatch = 0;
  let notFound = 0;

  for (const entry of entries) {
    const expectedName = entry.fn || "(no name)";
    const handles = [...entry.tel, ...entry.email].filter(Boolean);

    for (const handle of handles) {
      const resolved = lookupHandle(handle);
      if (resolved === handle) {
        notFound++;
      } else if (resolved !== expectedName) {
        mismatch++;
      } else {
        match++;
      }
    }
  }

  const total = match + mismatch + notFound;
  const matchRate = total > 0 ? match / total : 1;
  return { match, mismatch, notFound, total, matchRate };
}
