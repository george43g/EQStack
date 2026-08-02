/**
 * Placeholder entry for the EQStack relationship-analysis app.
 *
 * Deliberately empty of domain code: the corpus boundary and package
 * extraction are decided only after the analytics research lands
 * (HANDOFF.md §4 Q2, docs/MONOREPO_MIGRATION.md "What the analytics tool
 * will consume"). This shell exists to prove the monorepo structure
 * end-to-end under turbo.
 */
export const APP_NAME = "@eqstack/analysis";

export function health(): { ok: true; app: string } {
  return { ok: true, app: APP_NAME };
}
