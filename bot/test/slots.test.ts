import { test } from "node:test";
import assert from "node:assert/strict";
import { findSlots, parseHours } from "../src/calendar/slots.js";

test("parses working hours", () => {
  assert.deepEqual(parseHours("Mon-Fri 10:00-18:00 Asia/Bangkok"), { days: [1, 2, 3, 4, 5], start: 600, end: 1080, tz: "Asia/Bangkok" });
  assert.deepEqual(parseHours("sat,sun 09:30-12:00 UTC").days, [0, 6]);
  assert.deepEqual(parseHours("Fri-Mon 08:00-09:00 UTC").days, [0, 1, 5, 6]);
  assert.throws(() => parseHours("weekdays 9-5"));
  assert.throws(() => parseHours("Mon-Fri 10:00-18:00 Mars/Base"));
});

test("offers one slot per working day, in the host's time zone, after the lead time", () => {
  const hours = parseHours("Mon-Fri 10:00-18:00 Asia/Bangkok");
  // Friday 30 Oct 2026, 11:00 Bangkok.
  const now = new Date("2026-10-30T04:00:00Z");
  const slots = findSlots({ hours, busy: [], now, lengthMin: 30, days: 14, leadMin: 24 * 60, count: 3 });
  // Saturday and Sunday are off, so Monday, Tuesday, Wednesday at 10:00 Bangkok (03:00 UTC).
  assert.deepEqual(slots.map((d) => d.toISOString()), ["2026-11-02T03:00:00.000Z", "2026-11-03T03:00:00.000Z", "2026-11-04T03:00:00.000Z"]);
});

test("skips busy time", () => {
  const hours = parseHours("Mon-Fri 10:00-12:00 Asia/Bangkok");
  const now = new Date("2026-11-01T00:00:00Z");
  const busy = [
    { start: new Date("2026-11-02T03:00:00Z"), end: new Date("2026-11-02T04:15:00Z") }, // Mon 10:00-11:15
    { start: new Date("2026-11-03T03:00:00Z"), end: new Date("2026-11-03T05:00:00Z") }, // all of Tue
  ];
  const slots = findSlots({ hours, busy, now, lengthMin: 30, days: 3, leadMin: 0, count: 3 });
  assert.deepEqual(slots.map((d) => d.toISOString()), ["2026-11-02T04:30:00.000Z", "2026-11-04T03:00:00.000Z"]);
});

test("follows daylight saving in the host's zone", () => {
  const hours = parseHours("Mon-Fri 14:00-15:00 America/New_York");
  // New York leaves daylight time on Sunday 1 Nov 2026.
  const slots = findSlots({ hours, busy: [], now: new Date("2026-10-29T00:00:00Z"), lengthMin: 60, days: 5, leadMin: 0, count: 3 });
  assert.deepEqual(slots.map((d) => d.toISOString()), ["2026-10-29T18:00:00.000Z", "2026-10-30T18:00:00.000Z", "2026-11-02T19:00:00.000Z"]);
});
