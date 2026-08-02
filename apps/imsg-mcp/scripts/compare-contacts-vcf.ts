#!/usr/bin/env tsx
/**
 * Compare contacts from contacts.vcf with the tool's Address Book integration.
 * Core logic: `src/vcf-contact-compare.ts` (also covered by Vitest).
 *
 * Usage: pnpm exec tsx scripts/compare-contacts-vcf.ts [path/to/contacts.vcf]
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContactsDB } from "../src/contacts-db.js";
import {
  compareVcfEntriesToContacts,
  parseVcfFile,
  type VCardEntry,
} from "../src/vcf-contact-compare.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const defaultVcf = join(root, "env-data", "contacts.vcf");

function main() {
  const vcfPath = process.argv[2] || defaultVcf;
  console.log("Comparing VCF contacts with Address Book integration\n");
  console.log(`VCF: ${vcfPath}\n`);

  let entries: VCardEntry[];
  try {
    entries = parseVcfFile(vcfPath);
  } catch (e) {
    console.error("Failed to read VCF:", e);
    process.exit(1);
  }

  const contacts = new ContactsDB();
  contacts.initialize();
  const stats = contacts.getStats();
  console.log(
    `Address Book: ${stats.totalContacts} contacts, ${stats.phoneNumbers} phone entries, ${stats.emails} email entries\n`,
  );

  const { match, mismatch, notFound, total, matchRate } = compareVcfEntriesToContacts(
    entries,
    (h) => contacts.lookupHandle(h),
  );

  console.log("Results (by handle: each TEL/EMAIL counted once):");
  console.log(`  Match (resolved to VCF name): ${match}`);
  console.log(`  Mismatch (resolved to different name): ${mismatch}`);
  console.log(`  Not found (returned raw handle): ${notFound}`);
  console.log(`  Total lookups: ${total}`);
  if (total > 0) {
    console.log(`  Match rate: ${(100 * matchRate).toFixed(1)}%`);
  }

  const mismatches: { fn: string; handle: string; expected: string; got: string }[] = [];
  const notFounds: { fn: string; handle: string }[] = [];

  for (const entry of entries) {
    const expectedName = entry.fn || "(no name)";
    const handles = [...entry.tel, ...entry.email].filter(Boolean);
    for (const handle of handles) {
      const resolved = contacts.lookupHandle(handle);
      if (resolved === handle) {
        if (notFounds.length < 15) notFounds.push({ fn: expectedName, handle });
      } else if (resolved !== expectedName) {
        if (mismatches.length < 15) {
          mismatches.push({ fn: expectedName, handle, expected: expectedName, got: resolved });
        }
      }
    }
  }

  if (mismatches.length > 0) {
    console.log("\nSample mismatches (VCF name vs resolved name):");
    for (const m of mismatches) {
      console.log(`  "${m.fn}" / ${m.handle} => "${m.got}" (expected "${m.expected}")`);
    }
  }
  if (notFounds.length > 0) {
    console.log("\nSample not found (handle not in Address Book or normalization missed):");
    for (const n of notFounds) {
      console.log(`  "${n.fn}" / ${n.handle}`);
    }
  }

  // Spot check on a synthetic fixture handle. Replace with a real number/email
  // when running against a live Mac Address Book.
  const probeHandle = "+15555550100";
  const probeResolved = contacts.lookupHandle(probeHandle);
  console.log("\nSpot check:");
  console.log(`  ${probeHandle} => "${probeResolved}"`);

  contacts.close();
}

main();
