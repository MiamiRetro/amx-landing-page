import type { Busy } from "./google.js";

/** When a host takes sessions: days of the week (0 = Sunday), local hours, and their time zone. */
export interface Hours {
  days: number[];
  start: number; // minutes after midnight, local
  end: number;
  tz: string;
}

const DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "Mon-Fri 10:00-18:00 Asia/Bangkok" or "Mon,Wed,Fri 14:00-20:00 UTC". */
export function parseHours(s: string): Hours {
  const m = /^\s*([a-z,\-]+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s+(\S+)\s*$/i.exec(s);
  if (!m) throw new Error(`can't read working hours "${s}"`);
  const days = new Set<number>();
  for (const part of m[1].toLowerCase().split(",")) {
    const [a, b] = part.split("-").map((d) => DAY.indexOf(d.slice(0, 3)));
    if (a < 0 || (b !== undefined && b < 0)) throw new Error(`can't read days "${m[1]}"`);
    for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (b === undefined || d === b) break; }
  }
  new Intl.DateTimeFormat("en", { timeZone: m[6] }); // throws on an unknown zone
  return { days: [...days].sort(), start: +m[2] * 60 + +m[3], end: +m[4] * 60 + +m[5], tz: m[6] };
}

/** The local calendar date, weekday and minute of the day of an instant in a time zone. */
function local(t: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" })
    .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, min: +p.hour * 60 + +p.minute, wd: DAY.indexOf(p.weekday.toLowerCase().slice(0, 3)) };
}

/** The instant of a local wall-clock time in a time zone. */
function instant(y: number, mo: number, d: number, min: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, 0, min);
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const l = local(t, tz);
    t += guess - Date.UTC(l.y, l.mo - 1, l.d, 0, l.min);
  }
  return t;
}

/**
 * Open session slots: inside the host's hours, clear of their busy blocks, no
 * sooner than `leadMin` from now (sessions are booked, not on demand), at most
 * one per day so the VIP gets a real choice, earliest first.
 */
export function findSlots(o: { hours: Hours; busy: Busy[]; now: Date; lengthMin: number; days: number; leadMin: number; count: number; stepMin?: number }): Date[] {
  const step = o.stepMin ?? 30;
  const earliest = +o.now + o.leadMin * 60_000;
  const out: Date[] = [];
  const today = local(+o.now, o.hours.tz);
  for (let i = 0; i <= o.days && out.length < o.count; i++) {
    // Noon UTC of the local date i days on, to step over DST changes safely.
    const day = local(Date.UTC(today.y, today.mo - 1, today.d + i, 12), "UTC");
    const wd = new Date(Date.UTC(day.y, day.mo - 1, day.d)).getUTCDay();
    if (!o.hours.days.includes(wd)) continue;
    for (let m = o.hours.start; m + o.lengthMin <= o.hours.end; m += step) {
      const s = instant(day.y, day.mo, day.d, m, o.hours.tz), e = s + o.lengthMin * 60_000;
      if (s < earliest) continue;
      if (o.busy.some((b) => +b.start < e && +b.end > s)) continue;
      out.push(new Date(s));
      break;
    }
  }
  return out;
}
