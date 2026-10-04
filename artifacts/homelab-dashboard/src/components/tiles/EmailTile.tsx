import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEmailInbox,
  getEmailInbox,
  getGetEmailInboxQueryKey,
  useGetEmailMessageBody,
  getGetEmailMessageBodyQueryKey,
  useArchiveEmailMessage,
  useMarkEmailMessageRead,
} from "@workspace/api-client-react";
import type { EmailMessage } from "@workspace/api-client-react";
import { Mail, AlertTriangle, Archive, ExternalLink, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { WidgetProps } from "./IntegrationTile";
import { tileColumns, listColumnClass, listColumnStyle } from "./metrics";
import { openTileUrl } from "@/lib/utils";

const EMAIL_DEFAULT_MAX = 15;

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center text-center gap-1 px-3 text-muted-foreground text-sm">
      <Mail className="w-5 h-5 opacity-50" />
      <span>{children}</span>
    </div>
  );
}

// Compact relative time (e.g. "5m", "3h", "2d"), falling back to a short date
// for older messages.
function relativeTime(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return "now";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function MessageRow({
  msg,
  detailed,
  showAccount,
  onSelect,
}: {
  msg: EmailMessage;
  detailed: boolean;
  showAccount: boolean;
  onSelect: (msg: EmailMessage) => void;
}) {
  const time = relativeTime(msg.date);
  const body = (
    <>
      <div className="flex items-baseline gap-1.5 min-w-0">
        {msg.unread && (
          <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0 self-center" aria-label="Unread" />
        )}
        <span
          className={`text-xs leading-snug truncate ${msg.unread ? "font-semibold" : "text-muted-foreground"}`}
        >
          {msg.from}
        </span>
        {time && (
          <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">{time}</span>
        )}
      </div>
      <div className={`text-xs leading-snug truncate ${msg.unread ? "" : "text-muted-foreground"}`}>
        {msg.subject || "(no subject)"}
      </div>
      {detailed && msg.snippet && (
        <div className="text-[10px] text-muted-foreground truncate">{msg.snippet}</div>
      )}
      {detailed && showAccount && (
        <div className="text-[10px] text-muted-foreground/70 truncate">{msg.accountLabel}</div>
      )}
    </>
  );

  // Every row opens the in-app detail pop-out, which carries the "open in
  // Gmail/webmail" deep link (when available) plus the Archive action.
  return (
    <button
      type="button"
      onClick={() => onSelect(msg)}
      className="block w-full text-left space-y-0.5 hover:text-primary transition-colors cursor-pointer"
    >
      {body}
    </button>
  );
}

// Full timestamp for the detail pop-out (the list only shows "5m" / "3h").
function fullDate(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function MessageDetailDialog({
  msg,
  sample,
  onClose,
}: {
  msg: EmailMessage | null;
  sample: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // Clear any stale error when a different message is opened.
  useEffect(() => {
    setArchiveError(null);
  }, [msg?.id]);

  // Refresh every email tile variant (each tile config caches under its own
  // params) so unread badges/counts and archived rows update immediately.
  const invalidateEmailTiles = () =>
    queryClient.invalidateQueries({
      predicate: (q) => String(q.queryKey[0]).includes("/widgets/email/"),
    });

  const archive = useArchiveEmailMessage({
    mutation: {
      onSuccess: () => {
        void invalidateEmailTiles();
        onClose();
      },
      onError: (err) => {
        setArchiveError(err.data?.error ?? "Couldn't archive the message — try again.");
      },
    },
  });

  const markRead = useMarkEmailMessageRead({
    mutation: {
      onSuccess: () => {
        // The message is now read on the server — refresh the tile so its
        // unread dot and the header unread count drop right away.
        void invalidateEmailTiles();
      },
    },
  });

  // Mark a real, unread message read the moment its detail pop-out opens, so
  // the unread badge stays honest — mirroring how mail clients behave. Demo
  // rows and already-read messages are left untouched. Keyed on the message id
  // so re-renders (e.g. body load) don't fire it twice for the same message.
  const markReadMutate = markRead.mutate;
  useEffect(() => {
    if (msg && !sample && msg.unread) {
      markReadMutate({ data: { id: msg.id } });
    }
  }, [msg?.id, sample, msg?.unread, markReadMutate]);

  const isGmail = msg?.id.startsWith("gmail:") ?? false;

  // Fetch the full plain-text body lazily when a real (non-demo) message is
  // opened. Failures fall back to the snippet / no-preview state below.
  const bodyParams = { id: msg?.id ?? "" };
  const bodyQuery = useGetEmailMessageBody(bodyParams, {
    query: {
      queryKey: getGetEmailMessageBodyQueryKey(bodyParams),
      enabled: msg !== null && !sample,
      staleTime: 5 * 60_000,
      retry: 1,
    },
  });
  const bodyLoading = msg !== null && !sample && bodyQuery.isLoading;
  const body = !sample && bodyQuery.data ? bodyQuery.data.body : null;

  return (
    <Dialog open={msg !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {msg && (
          <>
            <DialogHeader>
              <DialogTitle className="break-words">
                {msg.subject || "(no subject)"}
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-0.5 text-left">
                  <div className="break-words">From: {msg.from}</div>
                  {fullDate(msg.date) && <div>{fullDate(msg.date)}</div>}
                  <div className="text-xs opacity-70">
                    {msg.accountLabel}
                    {msg.unread ? " · Unread" : ""}
                  </div>
                </div>
              </DialogDescription>
            </DialogHeader>
            {bodyLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading message…
              </div>
            ) : body ? (
              <div className="max-h-[50vh] overflow-y-auto">
                <p className="text-sm text-foreground whitespace-pre-wrap break-words">{body}</p>
              </div>
            ) : msg.snippet ? (
              <p className="text-sm text-foreground whitespace-pre-wrap break-words">
                {msg.snippet}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No preview available — open this message in your mail client to
                read it.
              </p>
            )}
            {archiveError && (
              <p className="text-xs text-destructive break-words">{archiveError}</p>
            )}
            {(msg.link || !sample) && (
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                {!sample && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={archive.isPending}
                    onClick={() => archive.mutate({ data: { id: msg.id } })}
                  >
                    <Archive className="w-3.5 h-3.5 mr-1.5" />
                    {archive.isPending ? "Archiving…" : "Archive"}
                  </Button>
                )}
                {msg.link && (
                  <Button size="sm" onClick={() => openTileUrl(msg.link as string)}>
                    <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                    {isGmail ? "Open in Gmail" : "Open webmail"}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function EmailTile({ density, tileSettings }: WidgetProps) {
  const accounts = tileSettings?.emailAccounts ?? null;
  const max = tileSettings?.emailMaxMessages ?? EMAIL_DEFAULT_MAX;
  const unreadOnly = tileSettings?.emailUnreadOnly ?? false;
  const [selected, setSelected] = useState<EmailMessage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  // The route returns demo messages when no mail account is configured, so we
  // always run the query. All knobs live in the query key so distinct tile
  // configurations cache separately.
  const params = {
    accounts: accounts && accounts.length > 0 ? accounts.join(",") : undefined,
    max,
    unreadOnly: unreadOnly ? "true" : undefined,
  };
  const { data, isLoading, isError } = useGetEmailInbox(params, {
    query: {
      queryKey: getGetEmailInboxQueryKey(params),
      refetchInterval: 60_000,
      staleTime: 30_000,
      retry: 1,
    },
  });

  // Manual refresh — bypasses the server's short fetch cache (fresh=true) so
  // brand-new mail shows up instantly, then seeds the result into the normal
  // query cache. Background polling keeps using the cached path.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const freshData = await getEmailInbox({ ...params, fresh: "true" });
      queryClient.setQueryData(getGetEmailInboxQueryKey(params), freshData);
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
    return <Placeholder>Couldn't reach your mail accounts — check Settings.</Placeholder>;
  }

  const refreshButton = !data.sample && (
    <button
      type="button"
      onClick={() => void handleRefresh()}
      disabled={refreshing}
      title="Check for new mail now"
      aria-label="Refresh mail"
      className="ml-auto flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 cursor-pointer"
    >
      <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
    </button>
  );

  if (data.messages.length === 0) {
    return (
      <div className="w-full h-full flex flex-col">
        {refreshButton && (
          <div className="flex items-center px-3 pt-2">{refreshButton}</div>
        )}
        <div className="flex-1 min-h-0">
          <Placeholder>
            {unreadOnly ? "No unread mail — inbox zero!" : "No messages here."}
          </Placeholder>
        </div>
      </div>
    );
  }

  // Scrollable / expanded bodies always show full row detail.
  const detailed = density.scrollable || density.bodyHeight >= 150;
  const columns = tileColumns(density.bodyWidth);
  // Only bother labeling messages per-account when more than one is in play.
  const accountCount = new Set(data.messages.map((m) => m.account)).size;
  const failedAccounts = data.errors ?? [];

  return (
    <div className="w-full h-full flex flex-col">
      {(data.sample || typeof data.unreadTotal === "number" || failedAccounts.length > 0 || refreshButton) && (
        <div className="flex items-center gap-2 px-3 pt-2 text-[10px] text-muted-foreground">
          {typeof data.unreadTotal === "number" && (
            <span className="font-medium">
              {data.unreadTotal} unread{data.sample ? "" : ""}
            </span>
          )}
          {data.sample && <span className="opacity-70">Sample data — connect an account</span>}
          {failedAccounts.length > 0 && (
            <span className="flex items-center gap-1 text-amber-500" title={failedAccounts.map((e) => `${e.account}: ${e.message}`).join("\n")}>
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
        {data.messages.map((msg) => (
          <MessageRow
            key={msg.id}
            msg={msg}
            detailed={detailed}
            showAccount={accountCount > 1}
            onSelect={setSelected}
          />
        ))}
      </div>
      <MessageDetailDialog msg={selected} sample={data.sample} onClose={() => setSelected(null)} />
    </div>
  );
}
