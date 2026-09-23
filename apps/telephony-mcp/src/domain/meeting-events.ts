/**
 * A meeting member's view of the call's event feed (PHASE-GC § 3). PURE.
 *
 * `get_call_events {as: "<member>"}` marks that member listening and filters
 * `consult.asked` / `consult.unanswered` down to questions addressed to it.
 * Everything else (lifecycle, answers, meeting.started) passes through: a
 * member must see call.ended to stop its loop.
 */
import type { CallEvent } from "./types.js";

/** Question events that belong to one addressee. */
const ADDRESSED_EVENT_TYPES: ReadonlySet<string> = new Set(["consult.asked", "consult.unanswered"]);

export function eventsForMember(events: CallEvent[], member: string): CallEvent[] {
  return events.filter((e) => {
    if (!ADDRESSED_EVENT_TYPES.has(e.type)) return true;
    return e.data.addressee === member;
  });
}

/**
 * Why a poll with `as` is refused, or null when it is fine. `roster` is the
 * call's meeting members, or null when the call is not a meeting.
 */
export function memberPollRefusal(roster: string[] | null, member: string): string | null {
  if (roster === null) return `as: this call is not a meeting (as is only for meeting members)`;
  if (!roster.includes(member)) {
    return `as: "${member}" is not on this meeting (roster: ${roster.join(", ")})`;
  }
  return null;
}
