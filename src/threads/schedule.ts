import type { ScheduleEntry } from './types';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Parse a free-text schedule into ScheduleEntry[]. One entry per non-empty line.
 *
 *   Sun 16:00-21:00              recurring
 *   Mon,Wed,Fri 09:00-10:00      recurring multiple days
 *   2026-05-04 15:00-16:00       one-shot (date + time range)
 *
 * Returns { entries, errors } — errors are line-by-line, never throws.
 */
export function parseSchedule(text: string): { entries: ScheduleEntry[]; errors: string[] } {
  const entries: ScheduleEntry[] = [];
  const errors: string[] = [];
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const e = parseLine(raw);
    if ('error' in e) {
      errors.push(`line ${i + 1}: ${e.error} ("${raw}")`);
    } else {
      entries.push(e.entry);
    }
  }
  return { entries, errors };
}

function parseLine(line: string): { entry: ScheduleEntry } | { error: string } {
  // Try one-shot first: starts with YYYY-MM-DD
  const oneShotMatch = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(line);
  if (oneShotMatch) {
    const [, date, start, end] = oneShotMatch;
    return {
      entry: {
        kind: 'one-shot',
        start: `${date}T${normalizeTime(start)}`,
        end: `${date}T${normalizeTime(end)}`,
      },
    };
  }

  // Recurring: "DAYS HH:MM-HH:MM"
  const recMatch = /^([A-Za-z,\s]+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(line);
  if (recMatch) {
    const [, daysStr, start, end] = recMatch;
    const tokens = daysStr.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const days: number[] = [];
    for (const t of tokens) {
      if (!(t in DAY_INDEX)) return { error: `unknown day "${t}"` };
      const d = DAY_INDEX[t];
      if (!days.includes(d)) days.push(d);
    }
    if (days.length === 0) return { error: 'no days specified' };
    return {
      entry: {
        kind: 'recurring',
        days: days.sort(),
        start: normalizeTime(start),
        end: normalizeTime(end),
      },
    };
  }

  return { error: 'expected "DAYS HH:MM-HH:MM" or "YYYY-MM-DD HH:MM-HH:MM"' };
}

function normalizeTime(t: string): string {
  const [h, m] = t.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/** Render ScheduleEntry[] back to the textarea-friendly format. */
export function formatSchedule(entries: ScheduleEntry[] | undefined): string {
  if (!entries || entries.length === 0) return '';
  return entries
    .map((e) => {
      if (e.kind === 'recurring') {
        return `${e.days.map((d) => DAY_NAMES[d]).join(',')} ${e.start}-${e.end}`;
      }
      // one-shot: split T into "YYYY-MM-DD HH:MM"
      const date = e.start.split('T')[0];
      const startTime = e.start.split('T')[1]?.slice(0, 5) ?? '00:00';
      const endTime = e.end.split('T')[1]?.slice(0, 5) ?? '00:00';
      return `${date} ${startTime}-${endTime}`;
    })
    .join('\n');
}

/** True if the entry covers `now` (local time). */
export function entryCoversNow(e: ScheduleEntry, now = new Date()): boolean {
  if (e.kind === 'recurring') {
    if (!e.days.includes(now.getDay())) return false;
    const minsNow = now.getHours() * 60 + now.getMinutes();
    return minsNow >= toMinutes(e.start) && minsNow < toMinutes(e.end);
  }
  // one-shot: parse as local
  const startMs = parseLocalIso(e.start);
  const endMs = parseLocalIso(e.end);
  const t = now.getTime();
  return t >= startMs && t < endMs;
}

/** When does this entry's current/next active window end? `null` if not active. */
export function activeUntil(e: ScheduleEntry, now = new Date()): Date | null {
  if (!entryCoversNow(e, now)) return null;
  if (e.kind === 'recurring') {
    const end = new Date(now);
    const [eh, em] = e.end.split(':').map(Number);
    end.setHours(eh, em, 0, 0);
    return end;
  }
  return new Date(parseLocalIso(e.end));
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Treat a "YYYY-MM-DDTHH:MM" string as local time and return ms since epoch. */
function parseLocalIso(s: string): number {
  // Don't use Date(s) directly — would interpret as UTC if no zone present.
  const [date, time = '00:00'] = s.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return new Date(y, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0).getTime();
}

/** Returns the matching schedule entry from across all threads, if any. */
export function findActiveSchedule(
  threads: Array<{ id: string; schedule?: ScheduleEntry[] }>,
  now = new Date(),
): { threadId: string; entry: ScheduleEntry; until: Date } | null {
  for (const t of threads) {
    if (!t.schedule) continue;
    for (const e of t.schedule) {
      const until = activeUntil(e, now);
      if (until) return { threadId: t.id, entry: e, until };
    }
  }
  return null;
}
