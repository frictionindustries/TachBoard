import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCalendarEvents,
  getCalendarEvents,
  getGetCalendarEventsQueryKey,
} from "@workspace/api-client-react";
import type { CalendarEvent } from "@workspace/api-client-react";
import { CalendarDays, AlertTriangle, MapPin, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { WidgetProps } from "./IntegrationTile";
import { tileColumns, listColumnClass, listColumnStyle } from "./metrics";

const CALENDAR_DEFAULT_DAYS = 14;
const CALENDAR_DEFAULT_MAX = 20;

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center text-center gap-1 px-3 text-muted-foreground text-sm">
      <CalendarDays className="w-5 h-5 opacity-50" />
      <span>{children}</span>
    </div>
  );
}

// Local midnight of a day offset from today; used to bucket events under
// "Today" / "Tomorrow" / weekday headers.
function dayStart(offsetDays: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

// The local day an event belongs to. All-day events carry a date-only start
// ("2026-07-04") that must be read as a local calendar date, not UTC.
function eventDay(ev: CalendarEvent): Date {
  if (ev.allDay) {
    const m = ev.start.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const d = new Date(ev.start);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayLabel(day: Date): string {
  const today = dayStart(0);
  const diffDays = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 7) return day.toLocaleDateString(undefined, { weekday: "long" });
  return day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function timeLabel(ev: CalendarEvent): string {
  if (ev.allDay) return "All day";
  const start = new Date(ev.start);
  const fmt: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const s = start.toLocaleTimeString(undefined, fmt);
  if (!ev.end) return s;
  const end = new Date(ev.end);
  return `${s} – ${end.toLocaleTimeString(undefined, fmt)}`;
}

// Full date line for the detail pop-out ("Saturday, Jul 4, 2026").
function fullDayLabel(ev: CalendarEvent): string {
  return eventDay(ev).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function EventDetailDialog({
  event,
  onClose,
}: {
  event: CalendarEvent | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={event !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {event && (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">{event.title}</DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-0.5 text-left">
                  <div>{fullDayLabel(event)}</div>
                  <div>{timeLabel(event)}</div>
                </div>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 text-sm">
              {event.location && (
                <div className="flex items-start gap-1.5">
                  <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-muted-foreground" />
                  <span className="break-words">{event.location}</span>
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                {[event.calendar, event.accountLabel].filter(Boolean).join(" · ")}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function CalendarTile({ density, tileSettings }: WidgetProps) {
  const accounts = tileSettings?.calendarAccounts ?? null;
  const days = tileSettings?.calendarDaysAhead ?? CALENDAR_DEFAULT_DAYS;
  const max = tileSettings?.calendarMaxEvents ?? CALENDAR_DEFAULT_MAX;
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  // The route returns demo events when no calendar account is configured, so we
  // always run the query. All knobs live in the query key so distinct tile
  // configurations cache separately.
  const params = {
    accounts: accounts && accounts.length > 0 ? accounts.join(",") : undefined,
    days,
    max,
  };
  const { data, isLoading, isError } = useGetCalendarEvents(params, {
    query: {
      queryKey: getGetCalendarEventsQueryKey(params),
      refetchInterval: 300_000,
      staleTime: 120_000,
      retry: 1,
    },
  });

  // Manual refresh — bypasses the server's short fetch cache (fresh=true) so
  // just-created events show up instantly, then seeds the result into the
  // normal query cache. Background polling keeps using the cached path.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const freshData = await getCalendarEvents({ ...params, fresh: "true" });
      queryClient.setQueryData(getGetCalendarEventsQueryKey(params), freshData);
    } catch {
      // Keep showing the current list; the next poll will retry.
    } finally {
      setRefreshing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  if (isError || !data) {
    return <Placeholder>Couldn't reach your calendars — check Settings.</Placeholder>;
  }

  const refreshButton = !data.sample && (
    <button
      type="button"
      onClick={() => void handleRefresh()}
      disabled={refreshing}
      title="Check for new events now"
      aria-label="Refresh calendar"
      className="ml-auto flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
    >
      <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
    </button>
  );

  if (data.events.length === 0) {
    return (
      <div className="w-full h-full flex flex-col">
        {refreshButton && (
          <div className="flex items-center px-3 pt-2">{refreshButton}</div>
        )}
        <div className="flex-1 min-h-0">
          <Placeholder>Nothing coming up in the next {days} days.</Placeholder>
        </div>
      </div>
    );
  }

  // Scrollable / expanded bodies always show full row detail.
  const detailed = density.scrollable || density.bodyHeight >= 150;
  const columns = tileColumns(density.bodyWidth);
  const accountCount = new Set(data.events.map((e) => e.account)).size;
  const failedAccounts = data.errors ?? [];

  // Group consecutive events under day headers (events arrive sorted).
  const groups: { label: string; events: CalendarEvent[] }[] = [];
  for (const ev of data.events) {
    const label = dayLabel(eventDay(ev));
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.events.push(ev);
    else groups.push({ label, events: [ev] });
  }

  return (
    <div className="w-full h-full flex flex-col">
      {(data.sample || failedAccounts.length > 0 || refreshButton) && (
        <div className="flex items-center gap-2 px-3 pt-2 text-[10px] text-muted-foreground">
          {data.sample && <span className="opacity-70">Sample data — connect an account</span>}
          {failedAccounts.length > 0 && (
            <span
              className="flex items-center gap-1 text-amber-500"
              title={failedAccounts.map((e) => `${e.account}: ${e.message}`).join("\n")}
            >
              <AlertTriangle className="w-3 h-3" />
              {failedAccounts.length === 1
                ? `${failedAccounts[0].account} unavailable`
                : `${failedAccounts.length} accounts unavailable`}
            </span>
          )}
          {refreshButton}
        </div>
      )}
      <div
        className={`flex-1 min-h-0 p-3 overflow-y-auto text-foreground ${listColumnClass(columns, "flex flex-col gap-2")}`}
        style={listColumnStyle(columns)}
      >
        {groups.map((group) => (
          <div key={group.label} className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {group.label}
            </div>
            {group.events.map((ev) => (
              <button
                key={ev.id}
                type="button"
                onClick={() => setSelected(ev)}
                className="block w-full text-left space-y-0.5 hover:text-primary transition-colors cursor-pointer"
              >
                <div className="text-xs leading-snug truncate">{ev.title}</div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {timeLabel(ev)}
                  {detailed && ev.calendar ? ` · ${ev.calendar}` : ""}
                  {detailed && accountCount > 1 ? ` · ${ev.accountLabel}` : ""}
                </div>
                {detailed && ev.location && (
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70 truncate">
                    <MapPin className="w-2.5 h-2.5 flex-shrink-0" />
                    <span className="truncate">{ev.location}</span>
                  </div>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      <EventDetailDialog event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
