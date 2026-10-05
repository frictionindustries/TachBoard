import {
  useGetLauncherDevices,
  getGetLauncherDevicesQueryKey,
} from "@workspace/api-client-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Lock, RotateCw, AlertTriangle } from "lucide-react";
import {
  isLauncherTransportSecure,
  LAUNCHER_TRANSPORT_MESSAGE,
  launcherErrorMessage,
  isForbidden,
} from "@/lib/launcher";

export interface LauncherBinding {
  instanceId: string | null;
  deviceId: string | null;
  actionId: string | null;
}

interface Props {
  open: boolean;
  value: LauncherBinding;
  onChange: (next: LauncherBinding) => void;
}

const MISSING = "__missing__";

export default function LauncherBindingEditor({ open, value, onChange }: Props) {
  const secure = isLauncherTransportSecure();
  const q = useGetLauncherDevices({
    query: {
      queryKey: getGetLauncherDevicesQueryKey(),
      enabled: open && secure,
      refetchInterval: open ? 5000 : false,
      retry: (n, err) => !isForbidden(err) && n < 2,
    },
  });

  if (!secure) {
    return (
      <div className="flex gap-2 text-xs text-muted-foreground border-t border-border pt-4" data-testid="text-launcher-editor-transport">
        <Lock className="w-4 h-4 text-destructive shrink-0" />
        <p>{LAUNCHER_TRANSPORT_MESSAGE} The current binding is kept unchanged.</p>
      </div>
    );
  }

  const data = q.data;
  const devices = data?.devices ?? [];
  const device = devices.find((d) => d.id === value.deviceId);
  const action = device?.actions.find((a) => a.id === value.actionId);
  const instanceMismatch = Boolean(data && value.instanceId && value.instanceId !== data.instanceId);
  const hasBinding = Boolean(value.deviceId);

  let warning: string | null = null;
  if (data && hasBinding) {
    if (instanceMismatch) warning = "Bound to a different launcher instance. Pick a device to rebind.";
    else if (!device) warning = "The bound device no longer exists. Pick another device to rebind.";
    else if (device.revoked) warning = "The bound device was revoked. Pair it again, then rebind.";
    else if (value.actionId && !action) warning = "The bound app is no longer allowed on this device. Pick another.";
    else if (!device.online) warning = "The bound device is offline right now. Launches will expire until it reconnects.";
  }

  const selectableDevices = devices.filter((d) => !d.revoked);

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <p className="text-sm text-muted-foreground">
        Tap the tile to ask a paired computer to open an allow-listed app. The tile has no link; the companion decides what runs. Pair computers in Settings.
      </p>

      {q.isLoading ? (
        <div className="space-y-2">
          <div className="h-9 bg-muted/50 animate-pulse" />
          <div className="h-9 bg-muted/50 animate-pulse" />
        </div>
      ) : q.isError ? (
        <div className="flex items-center justify-between gap-3 text-xs text-destructive">
          <span>{isForbidden(q.error) ? "Only the owner account can bind launcher tiles." : launcherErrorMessage(q.error, "Launcher unavailable")}</span>
          {!isForbidden(q.error) && (
            <Button type="button" size="sm" variant="outline" onClick={() => q.refetch()} className="gap-1.5">
              <RotateCw className="w-3.5 h-3.5" /> Retry
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Computer</Label>
            {selectableDevices.length === 0 && !hasBinding ? (
              <p className="text-xs text-muted-foreground" data-testid="text-launcher-no-devices">No paired computers. Pair one in Settings, Desktop Launcher.</p>
            ) : (
              <Select
                value={device && !device.revoked && !instanceMismatch ? device.id : hasBinding ? MISSING : ""}
                onValueChange={(id) => {
                  if (id === MISSING) return;
                  const d = devices.find((x) => x.id === id);
                  const keep = d?.actions.some((a) => a.id === value.actionId);
                  onChange({
                    instanceId: data?.instanceId ?? null,
                    deviceId: id,
                    actionId: keep ? value.actionId : (d?.actions[0]?.id ?? null),
                  });
                }}
              >
                <SelectTrigger data-testid="select-launcher-device"><SelectValue placeholder="Choose a computer" /></SelectTrigger>
                <SelectContent>
                  {hasBinding && (!device || device.revoked || instanceMismatch) && (
                    <SelectItem value={MISSING} disabled>
                      {device ? `${device.name} (${device.revoked ? "revoked" : "other instance"})` : "Missing device"}
                    </SelectItem>
                  )}
                  {selectableDevices.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name} {d.online ? "· online" : "· offline"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {device && !device.revoked && !instanceMismatch && (
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">App</Label>
              {device.actions.length === 0 ? (
                <p className="text-xs text-muted-foreground">This computer has no allowed apps. Add some in the companion config.</p>
              ) : (
                <Select
                  value={action ? action.id : value.actionId ? MISSING : ""}
                  onValueChange={(id) => {
                    if (id === MISSING) return;
                    onChange({ instanceId: data?.instanceId ?? null, deviceId: device.id, actionId: id });
                  }}
                >
                  <SelectTrigger data-testid="select-launcher-action"><SelectValue placeholder="Choose an app" /></SelectTrigger>
                  <SelectContent>
                    {value.actionId && !action && <SelectItem value={MISSING} disabled>Missing app</SelectItem>}
                    {device.actions.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {warning && (
            <p className="flex items-start gap-1.5 text-xs text-destructive" data-testid="text-launcher-binding-warning">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              {warning}
            </p>
          )}
          {hasBinding && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onChange({ instanceId: null, deviceId: null, actionId: null })}
              data-testid="button-clear-launcher-binding"
            >
              Clear binding
            </Button>
          )}
        </>
      )}
    </div>
  );
}
