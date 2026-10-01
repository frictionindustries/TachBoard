import { cloudHttpClient } from "./http.js";
import { getGoogleAccessToken } from "./google.js";
import { cachedFetch } from "./fetchCache.js";
import { createCalDavTransport } from "./caldavTransport.js";
import type { CalDavAccount } from "./mailAccounts.js";

// ── Calendar fetchers (Google Calendar REST + generic CalDAV) ────────────────
// Both providers normalize into the same CalendarEvent shape the widget route
// serves. tsdav is lazily imported so the dependency only loads when a CalDAV
// account is actually queried.

export interface CalendarEvent {
  id: string;
  account: string;
  accountLabel: string;
  calendar: string | null;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
}

const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

interface GoogleEventTime {
  date?: string; // all-day
  dateTime?: string;
}
interface GoogleEvent {
  id?: string;
  summary?: string;
  location?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  status?: string;
}

// Cached wrapper — tiles poll frequently, so identical per-account requests
// within the TTL share one upstream fetch (see fetchCache.ts).
export function fetchGoogleCalendarEvents(
  userId: number,
  opts: {
    accountId: string;
    accountLabel: string;
    daysAhead: number;
    max: number;
    fresh?: boolean;
  },
): Promise<CalendarEvent[]> {
  return cachedFetch(
    `mail:gcal:${userId}:${opts.accountId}:${opts.daysAhead}:${opts.max}`,
    () => fetchGoogleCalendarEventsUncached(userId, opts),
    undefined,
    { fresh: opts.fresh ?? false },
  );
}

async function fetchGoogleCalendarEventsUncached(
  userId: number,
  opts: {
    accountId: string;
    accountLabel: string;
    daysAhead: number;
    max: number;
  },
): Promise<CalendarEvent[]> {
  const token = await getGoogleAccessToken(userId, opts.accountId);
  const headers = { Authorization: `Bearer ${token}` };

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + opts.daysAhead * 86_400_000).toISOString();

  // Pull events from every calendar the account can see (writer/owner/reader),
  // skipping ones the user has hidden from their own list.
  const calList = await cloudHttpClient.get<{
    items?: { id?: string; summary?: string; selected?: boolean; hidden?: boolean }[];
  }>(`${GCAL_BASE}/users/me/calendarList?maxResults=50`, { headers });
  const calendars = (calList.data.items ?? []).filter(
    (c) => c.id && c.selected !== false && c.hidden !== true,
  );

  const perCal = await Promise.all(
    calendars.map(async (cal) => {
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(opts.max),
      });
      const r = await cloudHttpClient.get<{ items?: GoogleEvent[] }>(
        `${GCAL_BASE}/calendars/${encodeURIComponent(cal.id!)}/events?${params.toString()}`,
        { headers },
      );
      return (r.data.items ?? [])
        .filter((e) => e.status !== "cancelled" && (e.start?.date || e.start?.dateTime))
        .map((e): CalendarEvent => {
          const allDay = Boolean(e.start?.date);
          return {
            id: `google:${opts.accountId}:${cal.id}:${e.id ?? ""}`,
            account: opts.accountId,
            accountLabel: opts.accountLabel,
            calendar: cal.summary ?? null,
            title: e.summary?.trim() || "(untitled)",
            start: (allDay ? e.start?.date : e.start?.dateTime) ?? timeMin,
            end: (allDay ? e.end?.date : e.end?.dateTime) ?? null,
            allDay,
            location: e.location?.trim() || null,
          };
        });
    }),
  );

  const events = perCal.flat();
  events.sort((a, b) => (a.start < b.start ? -1 : 1));
  return events.slice(0, opts.max);
}

// ── CalDAV ────────────────────────────────────────────────────────────────────

// Minimal ICS VEVENT reader — enough for SUMMARY/DTSTART/DTEND/LOCATION/UID.
// Recurring events rely on the server expanding the time-range query; RRULEs
// that the server returns unexpanded surface as their first occurrence only.
interface VEvent {
  uid: string;
  summary: string;
  location: string | null;
  start: Date | null;
  startDateOnly: string | null; // set for all-day (VALUE=DATE) starts
  end: Date | null;
  endDateOnly: string | null;
}

function unfoldIcs(data: string): string[] {
  const rawLines = data.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

function unescapeIcsText(v: string): string {
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// Parse an ICS date/date-time property value. `params` carries the part
// between the property name and the colon (e.g. ";VALUE=DATE;TZID=...").
function parseIcsDate(params: string, value: string): { date: Date | null; dateOnly: string | null } {
  const v = value.trim();
  if (/VALUE=DATE(?:;|$)/i.test(params.replace(/^;/, "")) || /^\d{8}$/.test(v)) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return { date: null, dateOnly: null };
    return { date: new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`), dateOnly: `${m[1]}-${m[2]}-${m[3]}` };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return { date: null, dateOnly: null };
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? "Z" : ""}`;
  // Non-UTC values (floating or TZID-qualified) are interpreted in server
  // local time — good enough for a homelab dashboard's "upcoming" list.
  const date = new Date(iso);
  return { date: Number.isNaN(date.getTime()) ? null : date, dateOnly: null };
}

export function parseVEvents(ics: string): VEvent[] {
  const lines = unfoldIcs(ics);
  const events: VEvent[] = [];
  let cur: Partial<VEvent> | null = null;
  let depth = 0;

  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) {
      depth += 1;
      if (depth === 1) cur = {};
      continue;
    }
    if (/^END:VEVENT/i.test(line)) {
      if (depth === 1 && cur) {
        events.push({
          uid: cur.uid ?? `${events.length}`,
          summary: cur.summary ?? "(untitled)",
          location: cur.location ?? null,
          start: cur.start ?? null,
          startDateOnly: cur.startDateOnly ?? null,
          end: cur.end ?? null,
          endDateOnly: cur.endDateOnly ?? null,
        });
      }
      depth = Math.max(0, depth - 1);
      if (depth === 0) cur = null;
      continue;
    }
    if (!cur || depth !== 1) continue;

    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const semi = head.indexOf(";");
    const name = (semi >= 0 ? head.slice(0, semi) : head).toUpperCase();
    const params = semi >= 0 ? head.slice(semi) : "";

    switch (name) {
      case "UID":
        cur.uid = value.trim();
        break;
      case "SUMMARY":
        cur.summary = unescapeIcsText(value).trim();
        break;
      case "LOCATION":
        cur.location = unescapeIcsText(value).trim() || null;
        break;
      case "DTSTART": {
        const parsed = parseIcsDate(params, value);
        cur.start = parsed.date;
        cur.startDateOnly = parsed.dateOnly;
        break;
      }
      case "DTEND": {
        const parsed = parseIcsDate(params, value);
        cur.end = parsed.date;
        cur.endDateOnly = parsed.dateOnly;
        break;
      }
    }
  }
  return events;
}

// Cached wrapper — avoids re-running CalDAV discovery + per-calendar report
// queries on every tile refresh (see fetchCache.ts).
export function fetchCalDavEvents(
  account: CalDavAccount,
  opts: { daysAhead: number; max: number; fresh?: boolean },
): Promise<CalendarEvent[]> {
  return cachedFetch(
    `mail:caldav:${account.id}:${opts.daysAhead}:${opts.max}`,
    () => fetchCalDavEventsUncached(account, opts),
    undefined,
    { fresh: opts.fresh ?? false },
  );
}

async function fetchCalDavEventsUncached(
  account: CalDavAccount,
  opts: { daysAhead: number; max: number },
): Promise<CalendarEvent[]> {
  const { createDAVClient } = await import("tsdav");
  const transport = createCalDavTransport();
  const client = await createDAVClient({
    serverUrl: account.url,
    credentials: { username: account.username, password: account.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
    fetch: transport.fetch,
  });
  transport.assertSafe();

  const now = new Date();
  const windowEnd = new Date(now.getTime() + opts.daysAhead * 86_400_000);

  const calendars = await client.fetchCalendars();
  const perCal = await Promise.all(
    calendars.map(async (cal) => {
      const objects = await client.fetchCalendarObjects({
        calendar: cal,
        timeRange: { start: now.toISOString(), end: windowEnd.toISOString() },
      });
      const calName = typeof cal.displayName === "string" ? cal.displayName : null;
      const out: CalendarEvent[] = [];
      for (const obj of objects) {
        if (!obj.data || typeof obj.data !== "string") continue;
        for (const ev of parseVEvents(obj.data)) {
          const start = ev.start;
          if (!start) continue;
          // The server already filtered by time range, but unexpanded
          // recurring masters can leak through — keep only events that
          // plausibly touch the window.
          if (start.getTime() > windowEnd.getTime()) continue;
          const allDay = ev.startDateOnly !== null;
          out.push({
            id: `${account.id}:${ev.uid}:${start.getTime()}`,
            account: account.id,
            accountLabel: account.label,
            calendar: calName,
            title: ev.summary,
            start: allDay ? ev.startDateOnly! : start.toISOString(),
            end: allDay ? ev.endDateOnly : ev.end ? ev.end.toISOString() : null,
            allDay,
            location: ev.location,
          });
        }
      }
      return out;
    }),
  );

  const events = perCal.flat();
  transport.assertSafe();
  events.sort((a, b) => (a.start < b.start ? -1 : 1));
  return events.slice(0, opts.max);
}

// ── Demo data ─────────────────────────────────────────────────────────────────

export function demoCalendarEvents(now = Date.now()): CalendarEvent[] {
  const at = (days: number, hour: number, durH = 1) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    const e = new Date(d.getTime() + durH * 3_600_000);
    return { start: d.toISOString(), end: e.toISOString() };
  };
  const today = new Date(now);
  const dateOnly = (days: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  return [
    { id: "demo:0", account: "demo", accountLabel: "Demo calendar", calendar: "Personal", title: "Team stand-up", ...at(0, 17), allDay: false, location: null },
    { id: "demo:1", account: "demo", accountLabel: "Demo calendar", calendar: "Home", title: "Pick up groceries", ...at(1, 18), allDay: false, location: "Market St" },
    { id: "demo:2", account: "demo", accountLabel: "Demo calendar", calendar: "Personal", title: "Server maintenance window", ...at(2, 22, 2), allDay: false, location: null },
    { id: "demo:3", account: "demo", accountLabel: "Demo calendar", calendar: "Family", title: "Anniversary", start: dateOnly(3), end: null, allDay: true, location: null },
    { id: "demo:4", account: "demo", accountLabel: "Demo calendar", calendar: "Personal", title: "Dentist appointment", ...at(5, 9), allDay: false, location: "Smile Clinic" },
  ];
}
