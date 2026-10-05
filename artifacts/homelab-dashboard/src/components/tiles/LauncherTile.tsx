import { useEffect, useRef, useState } from "react";
import {
  useGetLauncherDevices,
  getGetLauncherDevicesQueryKey,
  useCreateLauncherCommand,
  useGetLauncherCommand,
  getGetLauncherCommandQueryKey,
  type Tile,
} from "@workspace/api-client-react";
import { Loader2, MonitorUp, RotateCw, ShieldAlert, Unplug, Check, X, Clock, Lock } from "lucide-react";
import {
  isLauncherTransportSecure,
  newRequestId,
  launcherErrorMessage,
  isUncertainFailure,
  isForbidden,
  toEpochMs,
} from "@/lib/launcher";

type Phase =
  | { kind: "idle" }
  | { kind: "sending"; requestId: string }
  | { kind: "pending"; requestId: string; commandId: string; expiresAt: number }
  | { kind: "accepted"; commandId: string }
  | { kind: "failed"; message: string }
  | { kind: "expired" }
  // Network/server failure before we got an answer: the command may exist.
  // Retrying reuses the same requestId so the server can de-duplicate.
  | { kind: "uncertain"; requestId: string; message: string };

const TERMINAL_RESET_MS = 8000;

export default function LauncherTile({ tile, editMode }: { tile: Tile; editMode: boolean }) {
  const secure = isLauncherTransportSecure();
  const s = tile.tileSettings;
  const instanceId = s?.launcherInstanceId ?? null;
  const deviceId = s?.launcherDeviceId ?? null;
  const actionId = s?.launcherActionId ?? null;
  const bound = Boolean(instanceId && deviceId && actionId);

  const devicesQ = useGetLauncherDevices({
    query: {
      queryKey: getGetLauncherDevicesQueryKey(),
      enabled: secure && bound,
      refetchInterval: 3000,
      retry: (n, err) => !isForbidden(err) && n < 2,
    },
  });

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const createCmd = useCreateLauncherCommand();
  const createRef = useRef(createCmd.mutate);
  createRef.current = createCmd.mutate;

  const commandId = phase.kind === "pending" || phase.kind === "accepted" ? phase.commandId : "";
  const cmdQ = useGetLauncherCommand(commandId, {
    query: {
      queryKey: getGetLauncherCommandQueryKey(commandId),
      enabled: secure && (phase.kind === "pending" || phase.kind === "accepted"),
      refetchInterval: 1000,
      retry: 3,
    },
  });

  // Fold polled command status into the phase.
  useEffect(() => {
    if ((phase.kind !== "pending" && phase.kind !== "accepted") || !cmdQ.data || cmdQ.data.id !== phase.commandId) return;
    const st = cmdQ.data.status;
    if (st === "accepted" && phase.kind !== "accepted") setPhase({ kind: "accepted", commandId: phase.commandId });
    else if (st === "failed") setPhase({ kind: "failed", message: cmdQ.data.error || "The companion rejected the command." });
    else if (st === "expired") setPhase({ kind: "expired" });
  }, [cmdQ.data, phase]);

  // Local expiry guard in case polling cannot reach the server.
  useEffect(() => {
    if (phase.kind !== "pending") return;
    const wait = phase.expiresAt + 5000 - Date.now();
    const t = window.setTimeout(() => setPhase({ kind: "uncertain", requestId: phase.requestId, message: "Status unavailable; the application may have launched" }), Math.max(0, wait));
    return () => window.clearTimeout(t);
  }, [phase]);

  // Terminal states fade back to idle.
  useEffect(() => {
    if (phase.kind !== "accepted" && phase.kind !== "failed" && phase.kind !== "expired") return;
    const t = window.setTimeout(() => setPhase({ kind: "idle" }), TERMINAL_RESET_MS);
    return () => window.clearTimeout(t);
  }, [phase]);

  const device = devicesQ.data?.devices.find((d) => d.id === deviceId);
  const action = device?.actions.find((a) => a.id === actionId);
  const instanceMismatch = Boolean(devicesQ.data && instanceId && devicesQ.data.instanceId !== instanceId);

  let blocker: { icon: typeof Lock; title: string; detail: string } | null = null;
  if (!secure) blocker = { icon: Lock, title: "HTTPS required", detail: "Open the dashboard over HTTPS to launch." };
  else if (!bound) blocker = { icon: Unplug, title: "Not bound", detail: "Edit this tile to pick a device and app." };
  else if (devicesQ.isError) {
    blocker = isForbidden(devicesQ.error)
      ? { icon: ShieldAlert, title: "Owner only", detail: "Only the owner account can launch apps." }
      : { icon: Unplug, title: "Launcher unavailable", detail: launcherErrorMessage(devicesQ.error, "Could not load devices") };
  } else if (devicesQ.data) {
    if (instanceMismatch) blocker = { icon: Unplug, title: "Rebind needed", detail: "This tile belongs to another launcher instance." };
    else if (!device) blocker = { icon: Unplug, title: "Device missing", detail: "The bound device no longer exists. Rebind." };
    else if (device.revoked) blocker = { icon: ShieldAlert, title: "Device revoked", detail: "Pair again and rebind this tile." };
    else if (!action) blocker = { icon: Unplug, title: "Action missing", detail: "The app is no longer allowed on this device. Rebind." };
  }
  const offline = Boolean(device && !device.revoked && !device.online);

  function send(requestId: string) {
    if (!instanceId || !deviceId || !actionId) return;
    setPhase({ kind: "sending", requestId });
    createRef.current(
      { data: { instanceId, deviceId, actionId, requestId } },
      {
        onSuccess: (cmd) => {
          if (cmd.status === "accepted") setPhase({ kind: "accepted", commandId: cmd.id });
          else if (cmd.status === "failed") setPhase({ kind: "failed", message: cmd.error || "The companion rejected the command." });
          else if (cmd.status === "expired") setPhase({ kind: "expired" });
          else setPhase({ kind: "pending", requestId, commandId: cmd.id, expiresAt: toEpochMs(cmd.expiresAt) });
        },
        onError: (err) => {
          if (isUncertainFailure(err)) {
            setPhase({ kind: "uncertain", requestId, message: launcherErrorMessage(err, "Network error") });
          } else {
            setPhase({ kind: "failed", message: launcherErrorMessage(err, "Launch rejected") });
          }
        },
      },
    );
  }

  const busy = phase.kind === "sending" || phase.kind === "pending";
  const canLaunch = !editMode && secure && bound && !blocker && !offline && !busy && phase.kind !== "uncertain" && devicesQ.isSuccess;

  function handleTap(e: React.MouseEvent) {
    e.stopPropagation();
    if (!canLaunch) return;
    // One fresh request UUID per deliberate attempt.
    send(newRequestId());
  }

  function handleRetry(e: React.MouseEvent) {
    e.stopPropagation();
    if (editMode || phase.kind !== "uncertain") return;
    send(phase.requestId);
  }

  const name = tile.name || action?.name || "Launcher";
  const bg = tile.bgColor || "hsl(var(--card))";
  const BIcon = blocker?.icon;

  let statusLine: React.ReactNode = null;
  if (editMode) statusLine = <span className="text-muted-foreground">Editing: launch disabled</span>;
  else if (phase.kind === "sending")
    statusLine = <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" />Sending</span>;
  else if (phase.kind === "pending")
    statusLine = <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" />Waiting for companion{cmdQ.isError ? " (reconnecting)" : ""}</span>;
  else if (phase.kind === "accepted")
    statusLine = <span className="flex items-center gap-1 text-primary" title="The companion accepted the command. This does not confirm the app actually opened."><Check className="w-3 h-3" />Accepted by companion (not confirmation it opened)</span>;
  else if (phase.kind === "failed")
    statusLine = <span className="flex items-center gap-1 text-destructive"><X className="w-3 h-3" />{phase.message}</span>;
  else if (phase.kind === "expired")
    statusLine = <span className="flex items-center gap-1 text-destructive"><Clock className="w-3 h-3" />Expired before the companion picked it up</span>;
  else if (phase.kind === "uncertain")
    statusLine = <span className="text-destructive">{phase.message}. It may still have been queued.</span>;
  else if (blocker) statusLine = <span className="text-muted-foreground">{blocker.detail}</span>;
  else if (offline) statusLine = <span className="text-muted-foreground">Device offline: no commands will be queued</span>;
  else if (devicesQ.isLoading) statusLine = <span className="text-muted-foreground animate-pulse">Checking device</span>;
  else if (device) statusLine = <span className="text-muted-foreground truncate">on {device.name}</span>;

  return (
    <div
      className="absolute inset-0 flex flex-col border border-border overflow-hidden"
      style={{ background: bg, containerType: "size" }}
      data-testid={`tile-launcher-${tile.id}`}
    >
      <div
        role="button"
        tabIndex={canLaunch ? 0 : -1}
        aria-disabled={!canLaunch}
        onClick={handleTap}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && canLaunch) {
            e.preventDefault();
            send(newRequestId());
          }
        }}
        className={`flex-1 min-h-0 flex flex-col items-center justify-center gap-[4cqh] px-3 text-center select-none transition-colors ${
          canLaunch ? "cursor-pointer hover:bg-primary/5 active:bg-primary/10" : "cursor-default"
        } ${editMode ? "pointer-events-none" : ""}`}
        data-testid={`button-launch-${tile.id}`}
      >
        <div className="relative">
          {BIcon ? (
            <BIcon className="w-[22cqmin] h-[22cqmin] min-w-5 min-h-5 text-muted-foreground" />
          ) : (
            <MonitorUp className={`w-[22cqmin] h-[22cqmin] min-w-5 min-h-5 text-primary ${busy ? "animate-pulse" : ""}`} />
          )}
          {device && !device.revoked && (
            <span
              className={`absolute -top-0.5 -right-1 h-2 w-2 rounded-full ${device.online ? "bg-green-500" : "bg-muted-foreground/50"}`}
              aria-label={device.online ? "Online" : "Offline"}
            />
          )}
        </div>
        {!tile.hideTitle && (
          <span className="font-bold text-sm uppercase tracking-widest text-foreground truncate max-w-full" data-testid={`text-launcher-name-${tile.id}`}>
            {name}
          </span>
        )}
        {blocker && <span className="text-[10px] uppercase tracking-wider font-bold text-destructive">{blocker.title}</span>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1 text-[10px] min-h-6" data-testid={`status-launcher-${tile.id}`}>
        <div className="min-w-0 truncate">{statusLine}</div>
        {phase.kind === "uncertain" && !editMode && (
          <button
            type="button"
            onClick={handleRetry}
            className="flex items-center gap-1 shrink-0 font-bold uppercase tracking-wider text-primary hover:underline"
            data-testid={`button-launch-retry-${tile.id}`}
            title="Retry with the same request id (will not launch twice)"
          >
            <RotateCw className="w-3 h-3" />
            Retry
          </button>
        )}
        {phase.kind === "uncertain" && !editMode && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setPhase({ kind: "idle" }); }}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss"
            data-testid={`button-launch-dismiss-${tile.id}`}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
