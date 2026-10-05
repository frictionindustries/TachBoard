import { useEffect, useState } from "react";
import {
  useGetLauncherDevices,
  getGetLauncherDevicesQueryKey,
  useCreateLauncherPairing,
  useRenameLauncherDevice,
  useRevokeLauncherDevice,
  type LauncherDevice,
  type LauncherPairing,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, MonitorUp, Lock, KeyRound, Pencil, Trash2, Check, X, RotateCw, ShieldAlert } from "lucide-react";
import {
  isLauncherTransportSecure,
  LAUNCHER_TRANSPORT_MESSAGE,
  launcherErrorMessage,
  isForbidden,
  toEpochMs,
} from "@/lib/launcher";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function Shell({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="border border-border bg-card relative" data-testid="card-desktop-launcher">
      <div className="absolute top-0 left-0 h-full w-0.5 bg-primary/60" />
      <div className="flex items-center justify-between gap-2.5 px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <MonitorUp className="w-4 h-4 text-primary" />
          <h2 className="font-bold text-sm uppercase tracking-widest text-foreground">Desktop Launcher</h2>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function DeviceRow({ device }: { device: LauncherDevice }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: getGetLauncherDevicesQueryKey() });

  const rename = useRenameLauncherDevice({
    mutation: {
      onSuccess: () => { setEditing(false); refresh(); toast({ title: "Device renamed" }); },
      onError: (e) => toast({ title: "Couldn't rename", description: launcherErrorMessage(e), variant: "destructive" }),
    },
  });
  const revoke = useRevokeLauncherDevice({
    mutation: {
      onSuccess: () => { setConfirmRevoke(false); refresh(); toast({ title: "Device revoked" }); },
      onError: (e) => toast({ title: "Couldn't revoke", description: launcherErrorMessage(e), variant: "destructive" }),
    },
  });

  const status = device.revoked ? "Revoked" : device.online ? "Online" : "Offline";
  const statusCls = device.revoked ? "text-destructive" : device.online ? "text-primary" : "text-muted-foreground";

  return (
    <li className={`px-5 py-3 flex flex-col gap-2 ${device.revoked ? "opacity-60" : ""}`} data-testid={`row-launcher-device-${device.id}`}>
      <div className="flex items-center gap-3">
        <span className={`h-2 w-2 rounded-full shrink-0 ${device.revoked ? "bg-destructive" : device.online ? "bg-green-500" : "bg-muted-foreground/40"}`} />
        {editing ? (
          <form
            className="flex-1 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim();
              if (n) rename.mutate({ id: device.id, data: { name: n } });
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" autoFocus maxLength={80} data-testid={`input-launcher-device-name-${device.id}`} />
            <Button type="submit" size="sm" disabled={rename.isPending || !name.trim()} data-testid={`button-save-launcher-device-${device.id}`}>
              {rename.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); setName(device.name); }}>
              <X className="w-3.5 h-3.5" />
            </Button>
          </form>
        ) : (
          <>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-foreground truncate" data-testid={`text-launcher-device-name-${device.id}`}>{device.name}</div>
              <div className="text-[11px] text-muted-foreground truncate">
                {device.actions.length} allowed app{device.actions.length === 1 ? "" : "s"}
                {device.actions.length > 0 && `: ${device.actions.map((a) => a.name).join(", ")}`}
              </div>
            </div>
            <span className={`text-[10px] uppercase tracking-wider font-bold ${statusCls}`} data-testid={`status-launcher-device-${device.id}`}>{status}</span>
            {!device.revoked && (
              <>
                <Button size="sm" variant="outline" onClick={() => setEditing(true)} aria-label="Rename" data-testid={`button-rename-launcher-device-${device.id}`}>
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmRevoke(true)} aria-label="Revoke" className="text-destructive" data-testid={`button-revoke-launcher-device-${device.id}`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </>
            )}
          </>
        )}
      </div>
      <Dialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {device.name}?</DialogTitle>
            <DialogDescription>
              The companion on this computer will stop receiving launch commands immediately. Tiles bound to it will show as revoked. To use it again, pair it from scratch.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRevoke(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => revoke.mutate({ id: device.id })} disabled={revoke.isPending} data-testid={`button-confirm-revoke-${device.id}`}>
              {revoke.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

export default function LauncherSettingsCard() {
  const secure = isLauncherTransportSecure();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pairing, setPairing] = useState<LauncherPairing | null>(null);
  const now = useNow(pairing !== null);

  const devicesQ = useGetLauncherDevices({
    query: {
      queryKey: getGetLauncherDevicesQueryKey(),
      enabled: secure,
      // Poll faster while a pairing code is live so the new device appears.
      refetchInterval: 3000,
      retry: (n, err) => !isForbidden(err) && n < 2,
    },
  });

  const pair = useCreateLauncherPairing({
    mutation: {
      onSuccess: (p) => setPairing(p),
      onError: (e) => toast({ title: "Couldn't start pairing", description: launcherErrorMessage(e), variant: "destructive" }),
    },
  });

  const expiresMs = pairing ? toEpochMs(pairing.expiresAt) : 0;
  const remaining = pairing ? Math.max(0, Math.ceil((expiresMs - now) / 1000)) : 0;

  // Clear the secret code from memory and the screen at expiry.
  useEffect(() => {
    if (!pairing) return;
    const t = window.setTimeout(() => {
      setPairing(null);
      qc.invalidateQueries({ queryKey: getGetLauncherDevicesQueryKey() });
    }, Math.max(0, expiresMs - Date.now()));
    return () => window.clearTimeout(t);
  }, [pairing, expiresMs, qc]);

  if (!secure) {
    return (
      <Shell right={<span className="text-[10px] uppercase tracking-wider font-bold text-destructive">HTTPS required</span>}>
        <div className="p-5 flex gap-3 text-xs text-muted-foreground" data-testid="text-launcher-transport">
          <Lock className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <div className="space-y-2">
            <p>{LAUNCHER_TRANSPORT_MESSAGE}</p>
            <p>
              Currently opened at <code className="text-foreground">{window.location.origin}</code>. Put the dashboard behind a TLS reverse proxy (for example Nginx Proxy Manager or Tailscale HTTPS) and reopen it via its <code className="text-foreground">https://</code> address to manage devices.
            </p>
          </div>
        </div>
      </Shell>
    );
  }

  const host = window.location.host;
  const cli = `python companion.py pair --server ${window.location.protocol}//${host}`;
  const forbidden = devicesQ.isError && isForbidden(devicesQ.error);
  const devices = devicesQ.data?.devices ?? [];
  const active = devices.filter((d) => !d.revoked);
  const revoked = devices.filter((d) => d.revoked);

  return (
    <Shell
      right={
        devicesQ.data && (
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
            {active.filter((d) => d.online).length}/{active.length} online
          </span>
        )
      }
    >
      <div className="p-5 space-y-3 text-xs text-muted-foreground">
        <p>
          Launch allow-listed apps on your own computers from a tile. A small Python companion runs on each desktop, polls this dashboard over HTTPS, and only runs actions you approved locally. Setup steps are in <code className="text-foreground">packaging/desktop/README.md</code>.
        </p>
        <ol className="list-decimal pl-4 space-y-1">
          <li>Click <span className="text-foreground">Pair a computer</span> to get a one-time code.</li>
          <li>On that computer run <code className="text-foreground">{cli}</code>.</li>
          <li>Enter the code when prompted and explicitly approve the pairing in the terminal. Nothing is paired without that local approval.</li>
        </ol>
      </div>

      {forbidden ? (
        <div className="px-5 pb-5 flex items-center gap-2 text-xs text-destructive" data-testid="text-launcher-forbidden">
          <ShieldAlert className="w-4 h-4" />
          Only the owner account can manage the desktop launcher.
        </div>
      ) : (
        <>
          {pairing && (
            <div className="mx-5 mb-5 border border-primary/50 bg-primary/5 p-4 space-y-2" data-testid="panel-launcher-pairing">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-primary">
                  <KeyRound className="w-3.5 h-3.5" />
                  One-time pairing code
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums" data-testid="text-pairing-countdown">
                  expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
                </span>
              </div>
              <div className="font-mono text-2xl tracking-[0.3em] text-foreground select-all break-all" data-testid="text-pairing-code">
                {pairing.code}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Shown once. Type it into the companion prompt. It is cleared from this page at expiry. Pairing for <span className="text-foreground">{pairing.owner}</span>.
              </p>
              <p className="text-[11px] break-all text-muted-foreground">
                Verify this server instance in the local prompt: <code data-testid="text-launcher-instance">{pairing.instanceId}</code>
              </p>
              <div className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => setPairing(null)} data-testid="button-dismiss-pairing">Hide code</Button>
              </div>
            </div>
          )}

          <div className="border-t border-border">
            {devicesQ.isLoading ? (
              <div className="px-5 py-4 space-y-2">
                {[0, 1].map((i) => <div key={i} className="h-9 bg-muted/50 animate-pulse" />)}
              </div>
            ) : devicesQ.isError ? (
              <div className="px-5 py-4 flex items-center justify-between gap-3 text-xs text-destructive">
                <span>{launcherErrorMessage(devicesQ.error, "Could not load devices")}</span>
                <Button size="sm" variant="outline" onClick={() => devicesQ.refetch()} className="gap-1.5">
                  <RotateCw className="w-3.5 h-3.5" /> Retry
                </Button>
              </div>
            ) : devices.length === 0 ? (
              <div className="px-5 py-6 text-center text-xs text-muted-foreground" data-testid="text-launcher-empty">
                <span className="text-primary">{"> "}</span>No computers paired yet.
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {[...active, ...revoked].map((d) => <DeviceRow key={d.id} device={d} />)}
              </ul>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border">
            <div className="text-xs text-muted-foreground truncate">
              {devicesQ.data ? <>Instance <code className="text-foreground">{devicesQ.data.instanceId}</code></> : null}
            </div>
            <Button size="sm" onClick={() => pair.mutate({ data: {} })} disabled={pair.isPending} className="gap-1.5" data-testid="button-pair-launcher">
              {pair.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
              {pairing ? "New code" : "Pair a computer"}
            </Button>
          </div>
        </>
      )}
    </Shell>
  );
}
