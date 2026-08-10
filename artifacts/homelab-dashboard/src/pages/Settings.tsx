import { useState, useEffect, useRef } from "react";
import { TachLogo } from "@/components/TachLogo";
import { useLocation } from "wouter";
import {
  useGetMe,
  useGetVersion,
  getGetVersionQueryKey,
  useGetConnections,
  useUpdateConnection,
  useTestConnection,
  getTruenasDiagnostics,
  ApiError,
  useGetSpotifyStatus,
  useSaveSpotifyCredentials,
  useStartSpotifyAuth,
  useDisconnectSpotify,
  useGetGoogleStatus,
  useDisconnectGoogle,
  useSetGoogleCredentials,
  useClearGoogleCredentials,
  createGoogleAuthIntent,
  useListImapAccounts,
  useAddImapAccount,
  useRemoveImapAccount,
  useListCalDavAccounts,
  useAddCalDavAccount,
  useRemoveCalDavAccount,
  useListAiAccounts,
  useAddAiAccount,
  useUpdateAiAccount,
  useRemoveAiAccount,
  useTestAiAccount,
  getListAiAccountsQueryKey,
  AiProvider,
  type AiAccount,
  getGetConnectionsQueryKey,
  getGetConnectionsStatusQueryKey,
  getGetSpotifyStatusQueryKey,
  getGetGoogleStatusQueryKey,
  getListImapAccountsQueryKey,
  getListCalDavAccountsQueryKey,
  getGetMeQueryKey,
  exportProfile,
  useImportProfile,
  type ServiceConnection,
  type ServiceConnectionUpdate,
  type ProfileExport,
  type ProfileImportBody,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import AppearanceSettings from "@/components/AppearanceSettings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Loader2,
  Check,
  AlertTriangle,
  Server,
  Clapperboard,
  Tv,
  Film,
  Music,
  Download,
  Shield,
  Network,
  Radar,
  Gamepad2,
  Globe,
  Tv2,
  TrendingUp,
  MonitorPlay,
  ChevronDown,
  Plug,
  Stethoscope,
  X,
  Copy,
  ExternalLink,
  Unplug,
  Mail,
  CalendarDays,
  Trash2,
  Image as ImageIcon,
  Bot,
  Pencil,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { groupByCategory } from "@/lib/integrationCategories";
import {
  encryptProfileFile,
  decryptProfileFile,
  isEncryptedProfileFile,
  ProfileDecryptError,
  type EncryptedProfileFile,
} from "@/lib/profileCrypto";
import {
  THEME_KEY,
  readSavedColors,
  persistTheme,
  persistColors,
  applyThemeToDom,
  isKnownTheme,
  type ColorOverrides,
} from "@/lib/theme";
import {
  readCustomThemes,
  persistCustomThemes,
  validateCustomTheme,
  isCustomThemeId,
  type CustomThemeMap,
} from "@/lib/customThemes";

// Copy text to the clipboard, returning whether it succeeded. The async
// Clipboard API only exists in secure contexts (HTTPS or localhost); a
// self-hosted dashboard reached over plain HTTP on the LAN has no
// `navigator.clipboard`, so fall back to a hidden textarea + execCommand.
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path (e.g. permission denied).
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

type ServiceKey =
  | "truenas"
  | "plex"
  | "jellyfin"
  | "subsonic"
  | "sonarr"
  | "radarr"
  | "lidarr"
  | "qbittorrent"
  | "pihole"
  | "nginx-proxy-manager"
  | "prowlarr"
  | "pterodactyl"
  | "tailscale"
  | "ersatztv"
  | "stocks"
  | "immich";

type FieldKey = "url" | "apiKey" | "username" | "password" | "token";

interface FieldDef {
  key: FieldKey;
  label: string;
  type?: string;
  placeholder?: string;
}

interface ServiceDef {
  key: ServiceKey;
  name: string;
  icon: React.ComponentType<{ className?: string }>;
  fields: FieldDef[];
}

const URL_FIELD: FieldDef = {
  key: "url",
  label: "Base URL",
  placeholder: "http://192.168.1.10:8080",
};
const API_KEY_FIELD: FieldDef = {
  key: "apiKey",
  label: "API Key",
  type: "password",
  placeholder: "••••••••••••",
};

const SERVICES: ServiceDef[] = [
  {
    key: "truenas",
    name: "TrueNAS",
    icon: Server,
    fields: [URL_FIELD, API_KEY_FIELD],
  },
  {
    key: "plex",
    name: "Plex",
    icon: Clapperboard,
    fields: [
      URL_FIELD,
      API_KEY_FIELD,
      { key: "token", label: "Plex Token", type: "password", placeholder: "X-Plex-Token" },
    ],
  },
  {
    key: "jellyfin",
    name: "Jellyfin",
    icon: MonitorPlay,
    fields: [URL_FIELD, API_KEY_FIELD],
  },
  {
    key: "subsonic",
    name: "Navidrome / Subsonic",
    icon: Music,
    // Subsonic-compatible servers (Navidrome, Airsonic, Gonic) authenticate with
    // a username + password using a salted token the backend derives per request.
    fields: [
      URL_FIELD,
      { key: "username", label: "Username", placeholder: "admin" },
      { key: "password", label: "Password", type: "password", placeholder: "••••••••" },
    ],
  },
  {
    key: "sonarr",
    name: "Sonarr",
    icon: Tv,
    fields: [URL_FIELD, API_KEY_FIELD],
  },
  {
    key: "radarr",
    name: "Radarr",
    icon: Film,
    fields: [URL_FIELD, API_KEY_FIELD],
  },
  {
    key: "lidarr",
    name: "Lidarr",
    icon: Music,
    fields: [URL_FIELD, API_KEY_FIELD],
  },
  {
    key: "qbittorrent",
    name: "qBittorrent",
    icon: Download,
    fields: [
      URL_FIELD,
      { key: "username", label: "Username", placeholder: "admin" },
      { key: "password", label: "Password", type: "password", placeholder: "••••••••" },
    ],
  },
  {
    key: "pihole",
    name: "Pi-hole",
    icon: Shield,
    fields: [URL_FIELD, API_KEY_FIELD],
  },
  {
    key: "nginx-proxy-manager",
    name: "Nginx Proxy Manager",
    icon: Network,
    fields: [
      URL_FIELD,
      { key: "username", label: "Email", placeholder: "admin@example.com" },
      { key: "password", label: "Password", type: "password", placeholder: "••••••••" },
    ],
  },
  {
    key: "prowlarr",
    name: "Prowlarr",
    icon: Radar,
    fields: [URL_FIELD, API_KEY_FIELD],
  },
  {
    key: "pterodactyl",
    name: "Pterodactyl",
    icon: Gamepad2,
    // The game panel's client API authenticates with a per-user client API key
    // (Account Settings → API Credentials in the panel).
    fields: [
      { key: "url", label: "Panel URL", placeholder: "https://panel.example.com" },
      {
        key: "apiKey",
        label: "Client API Key",
        type: "password",
        placeholder: "ptlc_••••••••",
      },
    ],
  },
  {
    key: "tailscale",
    name: "Tailscale",
    icon: Globe,
    // Tailscale is a cloud service, so there's no LAN base URL. We reuse the
    // `url` field to carry the tailnet name and `apiKey` for the API access
    // token — both are relabelled here to match.
    fields: [
      { key: "url", label: "Tailnet name", placeholder: "example.ts.net or -" },
      {
        key: "apiKey",
        label: "API access token",
        type: "password",
        placeholder: "tskey-api-••••••••",
      },
    ],
  },
  {
    key: "ersatztv",
    name: "ErsatzTV",
    icon: Tv2,
    // ErsatzTV runs without auth here, so only a base URL is needed.
    fields: [URL_FIELD],
  },
  {
    key: "immich",
    name: "Immich",
    icon: ImageIcon,
    // Immich authenticates with a per-user API key (Account Settings → API
    // Keys in Immich). Used by the Picture Frame tile's album source.
    fields: [URL_FIELD, API_KEY_FIELD],
  },
  {
    key: "stocks",
    name: "Stocks (Finnhub)",
    icon: TrendingUp,
    // Finnhub's base URL is fixed, so only an API key is needed. Without one the
    // Stocks tile falls back to sample quotes.
    fields: [API_KEY_FIELD],
  },
];

type FormState = Record<FieldKey, string>;

function connectionToForm(conn: ServiceConnection | undefined): FormState {
  return {
    url: conn?.url ?? "",
    apiKey: conn?.apiKey ?? "",
    username: conn?.username ?? "",
    password: conn?.password ?? "",
    token: conn?.token ?? "",
  };
}

function ServiceCard({
  def,
  connection,
}: {
  def: ServiceDef;
  connection: ServiceConnection | undefined;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => connectionToForm(connection));
  const [savedAt, setSavedAt] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagOutput, setDiagOutput] = useState<string | null>(null);
  const [diagCopied, setDiagCopied] = useState(false);

  // Re-sync the form when server values load/refresh, so saved values pre-fill.
  useEffect(() => {
    setForm(connectionToForm(connection));
  }, [connection]);

  const testMutation = useTestConnection();

  const mutation = useUpdateConnection({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData<ServiceConnection[]>(
          getGetConnectionsQueryKey(),
          (old) =>
            old?.map((c) => (c.service === data.service ? data : c)) ?? [data],
        );
        // Re-ping so the dashboard's reachability badge reflects the new settings.
        queryClient.invalidateQueries({ queryKey: getGetConnectionsStatusQueryKey() });
        setSavedAt(true);
        setTimeout(() => setSavedAt(false), 2000);
      },
    },
  });

  const Icon = def.icon;

  function buildPayload(): ServiceConnectionUpdate {
    const payload: ServiceConnectionUpdate = {};
    for (const field of def.fields) {
      payload[field.key] = form[field.key];
    }
    return payload;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    mutation.mutate(
      { service: def.key, data: buildPayload() },
      {
        onError: () => {
          toast({
            title: `Failed to save ${def.name}`,
            description: "Check your connection and try again.",
            variant: "destructive",
          });
        },
      },
    );
  }

  function handleTest() {
    setTestResult(null);
    testMutation.mutate(
      { service: def.key, data: buildPayload() },
      {
        onSuccess: (result) => setTestResult(result),
        onError: () =>
          setTestResult({ ok: false, message: "Could not reach service" }),
      },
    );
  }

  async function handleDiagnostics() {
    setDiagRunning(true);
    setDiagCopied(false);
    setDiagOutput(null);
    try {
      const data = await getTruenasDiagnostics();
      setDiagOutput(JSON.stringify(data, null, 2));
    } catch (err) {
      // A 409 (not configured) or upstream failure still carries a useful body.
      if (err instanceof ApiError && err.data != null) {
        setDiagOutput(JSON.stringify(err.data, null, 2));
      } else {
        setDiagOutput(
          JSON.stringify(
            { error: err instanceof Error ? err.message : String(err) },
            null,
            2,
          ),
        );
      }
    } finally {
      setDiagRunning(false);
    }
  }

  async function handleCopyDiagnostics() {
    if (!diagOutput) return;
    if (await copyText(diagOutput)) {
      setDiagCopied(true);
      setTimeout(() => setDiagCopied(false), 2000);
    } else {
      toast({
        title: "Couldn't copy",
        description: "Select the text and copy it manually.",
        variant: "destructive",
      });
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-border bg-card relative"
    >
      <div className="absolute top-0 left-0 h-full w-0.5 bg-primary/60" />
      <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
        <Icon className="w-4 h-4 text-primary" />
        <h2 className="font-bold text-sm uppercase tracking-widest text-foreground">
          {def.name}
        </h2>
      </div>

      <div className="p-5 grid gap-4 sm:grid-cols-2">
        {def.fields.map((field) => (
          <div
            key={field.key}
            className={`space-y-1.5 ${field.key === "url" ? "sm:col-span-2" : ""}`}
          >
            <Label
              htmlFor={`${def.key}-${field.key}`}
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              {field.label}
            </Label>
            <Input
              id={`${def.key}-${field.key}`}
              type={field.type ?? "text"}
              autoComplete="off"
              placeholder={field.placeholder}
              value={form[field.key]}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, [field.key]: e.target.value }))
              }
            />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border">
        <div className="min-h-5 text-xs">
          {testMutation.isPending ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Testing…
            </span>
          ) : testResult ? (
            testResult.ok ? (
              <span className="flex items-center gap-1.5 text-primary">
                <Check className="w-3.5 h-3.5" />
                {testResult.message}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-destructive">
                <X className="w-3.5 h-3.5" />
                {testResult.message}
              </span>
            )
          ) : mutation.isError ? (
            <span className="flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="w-3.5 h-3.5" />
              Could not save — try again.
            </span>
          ) : savedAt ? (
            <span className="flex items-center gap-1.5 text-primary">
              <Check className="w-3.5 h-3.5" />
              Saved
            </span>
          ) : connection?.updatedAt ? (
            <span className="text-muted-foreground">
              Last saved {new Date(connection.updatedAt + "Z").toLocaleString()}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {def.key === "truenas" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDiagnostics}
              disabled={diagRunning || mutation.isPending}
              className="gap-1.5"
            >
              {diagRunning ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Stethoscope className="w-3.5 h-3.5" />
              )}
              Diagnostics
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleTest}
            disabled={testMutation.isPending || mutation.isPending}
            className="gap-1.5"
          >
            {testMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plug className="w-3.5 h-3.5" />
            )}
            Test
          </Button>
          <Button type="submit" size="sm" disabled={mutation.isPending} className="gap-1.5">
            {mutation.isPending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </div>

      {def.key === "truenas" && diagOutput !== null && (
        <div className="border-t border-border px-5 py-4 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Reporting diagnostic (runs against your saved TrueNAS settings —
              click Save first if you just changed them). Copy this and paste it
              back so the CPU/RAM metrics can be fixed for your TrueNAS version.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleCopyDiagnostics}
              className="gap-1.5 shrink-0"
            >
              {diagCopied ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {diagCopied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="max-h-80 overflow-auto bg-muted/50 border border-border p-3 text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
            {diagOutput}
          </pre>
        </div>
      )}
    </form>
  );
}

// Spotify needs a bespoke card: it uses OAuth (Client ID/Secret + an account
// link round-trip) rather than the simple credential form the other services
// share. The user registers their own Spotify app — no Replit integration
// exists — so we surface the exact redirect URI they must allow-list.
function SpotifyCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useGetSpotifyStatus({
    query: { queryKey: getGetSpotifyStatusQueryKey() },
  });

  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  const refreshStatus = () =>
    queryClient.invalidateQueries({ queryKey: getGetSpotifyStatusQueryKey() });

  const saveMutation = useSaveSpotifyCredentials({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getGetSpotifyStatusQueryKey(), next);
        toast({ title: "Spotify credentials saved" });
      },
      onError: () =>
        toast({
          title: "Couldn’t save credentials",
          description: "Check the Client ID and Secret and try again.",
          variant: "destructive",
        }),
    },
  });

  const authMutation = useStartSpotifyAuth({
    mutation: {
      onError: () =>
        toast({
          title: "Couldn’t start Spotify sign-in",
          description: "Save your Client ID and Secret first.",
          variant: "destructive",
        }),
    },
  });

  const disconnectMutation = useDisconnectSpotify({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getGetSpotifyStatusQueryKey(), next);
        toast({ title: "Spotify disconnected" });
      },
      onError: () => refreshStatus(),
    },
  });

  // The OAuth popup posts its result here when it returns; refresh status and
  // toast in this (the dashboard) tab.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== "spotify-auth") return;
      queryClient.invalidateQueries({ queryKey: getGetSpotifyStatusQueryKey() });
      if (e.data.result === "connected") {
        toast({ title: "Spotify connected" });
      } else {
        toast({
          title: "Spotify connection failed",
          description: "Please try linking your account again.",
          variant: "destructive",
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [queryClient, toast]);

  const configured = status?.configured ?? false;
  const connected = status?.connected ?? false;
  const redirectUri = status?.redirectUri ?? "";

  function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId.trim() || !clientSecret.trim()) return;
    saveMutation.mutate({ data: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } });
  }

  function handleConnect() {
    // Spotify's consent page refuses to be framed (it sets frame-ancestors), and
    // the dashboard runs inside Replit's preview iframe — so navigating in-place
    // shows "accounts.spotify.com refused to connect". Open the flow in a
    // top-level popup instead. The window MUST be opened synchronously inside the
    // click handler (before the await) or the browser's popup blocker kills it.
    const popup = window.open("about:blank", "spotify-auth", "width=520,height=720");

    // Send the full base URL (host + SPA base path) so the server can build the
    // host-root redirect URI and a base-path-aware return URL.
    const origin = window.location.origin + import.meta.env.BASE_URL;
    authMutation.mutate(
      { data: { origin } },
      {
        onSuccess: (res) => {
          if (popup && !popup.closed) {
            popup.location.href = res.url;
          } else {
            // Popup was blocked — try a fresh top-level tab as a fallback.
            window.open(res.url, "_blank", "noopener");
          }
        },
        onError: () => popup?.close(),
      },
    );
  }

  async function copyRedirect() {
    if (await copyText(redirectUri)) toast({ title: "Redirect URI copied" });
  }

  return (
    <div className="border border-border bg-card relative">
      <div className="absolute top-0 left-0 h-full w-0.5 bg-primary/60" />
      <div className="flex items-center justify-between gap-2.5 px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <Music className="w-4 h-4 text-primary" />
          <h2 className="font-bold text-sm uppercase tracking-widest text-foreground">Spotify</h2>
        </div>
        {!isLoading && (
          <span
            className={`text-[10px] uppercase tracking-wider font-bold ${
              connected ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {connected ? "Connected" : configured ? "Not linked" : "Not configured"}
          </span>
        )}
      </div>

      <div className="p-5 space-y-4">
        <p className="text-xs text-muted-foreground">
          Create an app at the{" "}
          <a
            href="https://developer.spotify.com/dashboard"
            target="_blank"
            rel="noreferrer"
            className="text-primary inline-flex items-center gap-0.5 hover:underline"
          >
            Spotify Developer Dashboard
            <ExternalLink className="w-3 h-3" />
          </a>
          , then add the redirect URI below to it and paste the Client ID and Secret here.
        </p>

        {/* Redirect URI to allow-list in the Spotify app */}
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Redirect URI
          </Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground">
              {redirectUri || "—"}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={copyRedirect}
              disabled={!redirectUri}
              className="gap-1.5"
            >
              <Copy className="w-3.5 h-3.5" />
              Copy
            </Button>
          </div>
        </div>

        {/* Client credentials */}
        <form onSubmit={handleSaveCredentials} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label
              htmlFor="spotify-client-id"
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              Client ID
            </Label>
            <Input
              id="spotify-client-id"
              autoComplete="off"
              placeholder={configured ? "•••• saved ••••" : "Spotify Client ID"}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="spotify-client-secret"
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              Client Secret
            </Label>
            <Input
              id="spotify-client-secret"
              type="password"
              autoComplete="off"
              placeholder={configured ? "•••• saved ••••" : "Spotify Client Secret"}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2 flex items-center justify-between gap-3">
            <div className="min-h-5 text-xs">
              {connected && status?.displayName ? (
                <span className="text-muted-foreground">
                  Linked as <span className="text-foreground">{status.displayName}</span>
                  {status.premium === false && " · remote-only (no Premium)"}
                  {status.premium === true && " · Premium"}
                </span>
              ) : null}
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={saveMutation.isPending || !clientId.trim() || !clientSecret.trim()}
              className="gap-1.5"
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save credentials"
              )}
            </Button>
          </div>
        </form>
      </div>

      <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border">
        <div className="text-xs text-muted-foreground">
          {connected
            ? "Your Spotify account is linked."
            : configured
              ? "Credentials saved — link your account to finish."
              : "Save credentials to enable account linking."}
        </div>
        {connected ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => disconnectMutation.mutate()}
            disabled={disconnectMutation.isPending}
            className="gap-1.5"
          >
            {disconnectMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Unplug className="w-3.5 h-3.5" />
            )}
            Disconnect
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={handleConnect}
            disabled={!configured || authMutation.isPending}
            className="gap-1.5"
          >
            {authMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plug className="w-3.5 h-3.5" />
            )}
            Connect Spotify
          </Button>
        )}
      </div>
    </div>
  );
}

function GoogleCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useGetGoogleStatus({
    query: { queryKey: getGetGoogleStatusQueryKey() },
  });

  const [clientIdInput, setClientIdInput] = useState("");
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [editingCredentials, setEditingCredentials] = useState(false);

  const saveCredentialsMutation = useSetGoogleCredentials({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getGetGoogleStatusQueryKey(), next);
        setClientIdInput("");
        setClientSecretInput("");
        setEditingCredentials(false);
        toast({
          title: "Google credentials saved",
          description: "Now click Connect Google to link your account.",
        });
      },
      onError: (err) => {
        queryClient.invalidateQueries({ queryKey: getGetGoogleStatusQueryKey() });
        toast({
          title: "Couldn’t save credentials",
          description: err instanceof ApiError ? err.message : "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  const clearCredentialsMutation = useClearGoogleCredentials({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getGetGoogleStatusQueryKey(), next);
        toast({ title: "Google credentials removed" });
      },
      onError: () =>
        queryClient.invalidateQueries({ queryKey: getGetGoogleStatusQueryKey() }),
    },
  });

  const disconnectMutation = useDisconnectGoogle({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getGetGoogleStatusQueryKey(), next);
        toast({ title: "Google disconnected" });
      },
      onError: () =>
        queryClient.invalidateQueries({ queryKey: getGetGoogleStatusQueryKey() }),
    },
  });

  // When the popup fails (or closes before ever reaching our callback — the
  // classic redirect_uri_mismatch dead end happens entirely on Google's page),
  // this holds a failure reason so the card can render targeted help.
  // "no-callback" = popup closed without posting a result.
  const [connectFailure, setConnectFailure] = useState<string | null>(null);
  // True once the popup posted a result; the popup-close watcher checks this
  // to distinguish a normal close from a dead-end abandon.
  const authSettledRef = useRef(false);
  const popupWatchRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (popupWatchRef.current !== null) window.clearInterval(popupWatchRef.current);
    },
    [],
  );

  // The OAuth popup posts its result here when it returns; refresh status and
  // toast in this (the dashboard) tab.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type !== "google-auth") return;
      authSettledRef.current = true;
      if (popupWatchRef.current !== null) {
        window.clearInterval(popupWatchRef.current);
        popupWatchRef.current = null;
      }
      queryClient.invalidateQueries({ queryKey: getGetGoogleStatusQueryKey() });
      if (e.data.result === "connected") {
        setConnectFailure(null);
        toast({ title: "Google account connected" });
      } else {
        setConnectFailure(typeof e.data.reason === "string" ? e.data.reason : "unknown");
        toast({
          title: "Google connection failed",
          description: "See the Google card for what to check.",
          variant: "destructive",
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [queryClient, toast]);

  const configured = status?.configured ?? false;
  const connected = status?.connected ?? false;
  const accounts = status?.accounts ?? [];
  const redirectUri = status?.redirectUri ?? "";
  const credentialSource = status?.credentialSource ?? null;
  const activeClientId = status?.clientId ?? null;
  const fromEnv = credentialSource === "env";
  const showCredentialForm = !fromEnv && (!configured || editingCredentials);

  function handleSaveCredentials() {
    saveCredentialsMutation.mutate({
      data: { clientId: clientIdInput.trim(), clientSecret: clientSecretInput.trim() },
    });
  }

  async function handleConnect() {
    // Google's consent page refuses to be framed, and the dashboard may run
    // inside an iframe — open the flow in a top-level popup. The auth endpoint
    // is an unauthenticated GET redirect, so it requires a short-lived
    // single-use intent token minted here (with the bearer token) first;
    // otherwise anyone could start the flow and bind their own account.
    // Open the popup synchronously so the click isn't lost to popup blockers,
    // then point it at the auth URL once the intent arrives.
    const popup = window.open("about:blank", "google-auth", "width=520,height=720");
    authSettledRef.current = false;
    setConnectFailure(null);
    try {
      const { intent } = await createGoogleAuthIntent();
      const origin = window.location.origin + import.meta.env.BASE_URL;
      const url =
        `${import.meta.env.BASE_URL}api/widgets/gmail/auth` +
        `?origin=${encodeURIComponent(origin)}&intent=${encodeURIComponent(intent)}`;
      if (popup) {
        popup.location.href = url;
        // Watch for the popup closing without ever reaching our callback —
        // that's what a redirect_uri_mismatch dead end on Google's own error
        // page looks like from here (no result is ever posted back).
        if (popupWatchRef.current !== null) window.clearInterval(popupWatchRef.current);
        popupWatchRef.current = window.setInterval(() => {
          if (!popup.closed) return;
          if (popupWatchRef.current !== null) {
            window.clearInterval(popupWatchRef.current);
            popupWatchRef.current = null;
          }
          // Give a just-posted result message a moment to arrive first.
          window.setTimeout(() => {
            if (!authSettledRef.current) setConnectFailure("no-callback");
          }, 500);
        }, 1000);
      } else {
        // Popup was blocked — try a fresh top-level tab as a fallback.
        window.open(url, "_blank", "noopener");
      }
    } catch {
      popup?.close();
      toast({
        title: "Couldn’t start Google sign-in",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  }

  async function copyRedirect() {
    if (await copyText(redirectUri)) toast({ title: "Redirect URI copied" });
  }

  return (
    <div className="border border-border bg-card relative">
      <div className="absolute top-0 left-0 h-full w-0.5 bg-primary/60" />
      <div className="flex items-center justify-between gap-2.5 px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <Mail className="w-4 h-4 text-primary" />
          <h2 className="font-bold text-sm uppercase tracking-widest text-foreground">
            Google (Gmail + Calendar)
          </h2>
        </div>
        {!isLoading && (
          <span
            className={`text-[10px] uppercase tracking-wider font-bold ${
              connected ? "text-primary" : "text-muted-foreground"
            }`}
          >
            {connected ? "Connected" : configured ? "Not linked" : "Not configured"}
          </span>
        )}
      </div>

      <div className="p-5 space-y-4">
        <p className="text-xs text-muted-foreground">
          One Google sign-in powers both the Email tile (Gmail inbox) and the
          Calendar tile (Google Calendar). Google requires each app that reads
          your mail or calendar to have its own free OAuth credentials, so a
          one-time setup in the Google Cloud Console is needed before you can
          connect your account.
        </p>

        {!connected && (
          <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground border border-border bg-muted/20 px-4 py-3">
            <li>
              Open the{" "}
              <a
                href="https://console.cloud.google.com/apis/credentials"
                target="_blank"
                rel="noreferrer"
                className="text-primary inline-flex items-center gap-0.5 hover:underline"
              >
                Google Cloud Console credentials page
                <ExternalLink className="w-3 h-3" />
              </a>{" "}
              and create (or select) a project.
            </li>
            <li>
              Enable the <span className="text-foreground">Gmail API</span> and{" "}
              <span className="text-foreground">Google Calendar API</span> under{" "}
              <a
                href="https://console.cloud.google.com/apis/library"
                target="_blank"
                rel="noreferrer"
                className="text-primary inline-flex items-center gap-0.5 hover:underline"
              >
                APIs &amp; Services → Library
                <ExternalLink className="w-3 h-3" />
              </a>
              .
            </li>
            <li>
              Configure the OAuth consent screen (choose{" "}
              <span className="text-foreground">External</span> and add your own
              Google address as a test user).
            </li>
            <li>
              Create credentials: <span className="text-foreground">OAuth client ID</span>{" "}
              → application type <span className="text-foreground">Web application</span>,
              and paste the Redirect URI below into{" "}
              <span className="text-foreground">Authorized redirect URIs</span>.
            </li>
            <li>
              Copy the generated <span className="text-foreground">Client ID</span> and{" "}
              <span className="text-foreground">Client secret</span> into the fields
              below and save.
            </li>
            <li>
              Click <span className="text-foreground">Connect Google</span> and sign in
              with the account whose mail and calendar you want on the dashboard.
            </li>
          </ol>
        )}

        {/* Targeted help when the OAuth popup failed or never came back. The
            most common dead end is Google's "Error 400: redirect_uri_mismatch"
            page, which the user only ever sees inside the popup. */}
        {connectFailure && (
          <div className="border border-destructive/50 bg-destructive/10 px-4 py-3 space-y-2 text-xs">
            <div className="flex items-center gap-2 text-destructive font-bold uppercase tracking-wider">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {connectFailure === "denied"
                ? "Access was declined"
                : "Google sign-in didn’t complete"}
            </div>
            {connectFailure === "denied" ? (
              <p className="text-muted-foreground">
                Google reported that access was declined. Click Connect Google
                again and approve the requested permissions to link the account.
              </p>
            ) : connectFailure === "expired" ? (
              <p className="text-muted-foreground">
                The sign-in attempt expired before it finished. Click Connect
                Google to start a fresh attempt.
              </p>
            ) : (
              <>
                <p className="text-muted-foreground">
                  If Google showed{" "}
                  <span className="text-foreground">
                    “Error 400: redirect_uri_mismatch”
                  </span>
                  , the redirect URI below isn’t registered on your OAuth
                  client. Open{" "}
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary inline-flex items-center gap-0.5 hover:underline"
                  >
                    Google Cloud Console → Credentials
                    <ExternalLink className="w-3 h-3" />
                  </a>{" "}
                  and add it under{" "}
                  <span className="text-foreground">Authorized redirect URIs</span>:
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate border border-border bg-muted/40 px-2 py-1.5 text-foreground">
                    {redirectUri || "—"}
                  </code>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={copyRedirect}
                    disabled={!redirectUri}
                    className="gap-1.5"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    Copy
                  </Button>
                </div>
                <p className="text-muted-foreground">
                  It must match{" "}
                  <span className="text-foreground">character-for-character</span>{" "}
                  (scheme, host, port, and path — the easiest way is the Copy
                  button). If Google’s error page shows the URI it received,
                  register exactly that value. Changes in Google Cloud Console
                  can take a few minutes to apply, so wait a moment before
                  trying again.
                </p>
              </>
            )}
          </div>
        )}

        {/* Redirect URI to allow-list in the Google OAuth app */}
        <div className="space-y-1.5">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Redirect URI
          </Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate border border-border bg-muted/40 px-2 py-1.5 text-xs text-foreground">
              {redirectUri || "—"}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={copyRedirect}
              disabled={!redirectUri}
              className="gap-1.5"
            >
              <Copy className="w-3.5 h-3.5" />
              Copy
            </Button>
          </div>
          {!connected && (
            <p className="text-xs text-muted-foreground">
              Copy this exact URI into your OAuth client’s{" "}
              <span className="text-foreground">Authorized redirect URIs</span>{" "}
              in Google Cloud Console <span className="text-foreground">before</span>{" "}
              clicking Connect — otherwise Google stops the sign-in with a{" "}
              <span className="text-foreground">redirect_uri_mismatch</span> error.
              Changes there take a few minutes to apply.
            </p>
          )}
        </div>

        {fromEnv ? (
          <p className="text-xs text-muted-foreground border border-border bg-muted/20 px-4 py-3">
            Credentials are provided by the server’s{" "}
            <code className="text-foreground">GOOGLE_CLIENT_ID</code> and{" "}
            <code className="text-foreground">GOOGLE_CLIENT_SECRET</code>{" "}
            environment variables, so they can’t be edited here.
          </p>
        ) : showCredentialForm ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label
                  htmlFor="google-client-id"
                  className="text-xs uppercase tracking-wider text-muted-foreground"
                >
                  Client ID
                </Label>
                <Input
                  id="google-client-id"
                  value={clientIdInput}
                  onChange={(e) => setClientIdInput(e.target.value)}
                  placeholder="1234567890-abc123.apps.googleusercontent.com"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label
                  htmlFor="google-client-secret"
                  className="text-xs uppercase tracking-wider text-muted-foreground"
                >
                  Client Secret
                </Label>
                <Input
                  id="google-client-secret"
                  type="password"
                  value={clientSecretInput}
                  onChange={(e) => setClientSecretInput(e.target.value)}
                  placeholder="GOCSPX-…"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={handleSaveCredentials}
                disabled={
                  !clientIdInput.trim() ||
                  !clientSecretInput.trim() ||
                  saveCredentialsMutation.isPending
                }
                className="gap-1.5"
              >
                {saveCredentialsMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                Save Credentials
              </Button>
              {editingCredentials && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingCredentials(false);
                    setClientIdInput("");
                    setClientSecretInput("");
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 border border-border bg-muted/20 px-4 py-3">
            <div className="min-w-0 text-xs text-muted-foreground">
              <span className="uppercase tracking-wider font-bold">Client ID:&nbsp;</span>
              <code className="text-foreground break-all">{activeClientId ?? "—"}</code>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditingCredentials(true)}
              >
                Change
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => clearCredentialsMutation.mutate()}
                disabled={clearCredentialsMutation.isPending}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Remove Google credentials"
              >
                {clearCredentialsMutation.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="px-5 py-4 border-t border-border space-y-3">
        {accounts.length > 0 && (
          <ul className="space-y-2">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between gap-2 border border-border bg-muted/20 px-4 py-2.5"
              >
                <div className="min-w-0 flex items-center gap-2 text-xs">
                  <span
                    className={`w-1.5 h-1.5 shrink-0 rounded-full ${
                      account.connected ? "bg-primary" : "bg-destructive"
                    }`}
                    aria-hidden
                  />
                  <span className="truncate text-foreground">
                    {account.email ?? "Google account"}
                  </span>
                  {!account.connected && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wider text-destructive">
                      needs reconnect
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => disconnectMutation.mutate({ data: { accountId: account.id } })}
                  disabled={disconnectMutation.isPending}
                  className="gap-1.5 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Disconnect ${account.email ?? "Google account"}`}
                >
                  <Unplug className="w-3.5 h-3.5" />
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            {accounts.length > 0 ? (
              "Each linked account can be shown on its own Email or Calendar tile."
            ) : configured ? (
              "Credentials saved — click Connect Google to link your account."
            ) : (
              "Follow the steps above, then save your credentials to enable linking."
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant={accounts.length > 0 ? "outline" : "default"}
            onClick={handleConnect}
            disabled={!configured}
            className="gap-1.5 shrink-0"
          >
            <Plug className="w-3.5 h-3.5" />
            {accounts.length > 0 ? "Connect another account" : "Connect Google"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ImapAccountsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: accounts, isLoading } = useListImapAccounts({
    query: { queryKey: getListImapAccountsQueryKey() },
  });

  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("993");
  const [secure, setSecure] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [webmailUrl, setWebmailUrl] = useState("");

  const addMutation = useAddImapAccount({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getListImapAccountsQueryKey(), next);
        setLabel("");
        setHost("");
        setPort("993");
        setSecure(true);
        setUsername("");
        setPassword("");
        setWebmailUrl("");
        toast({ title: "IMAP account added" });
      },
      onError: (err) =>
        toast({
          title: "Couldn’t add IMAP account",
          description: err instanceof ApiError ? err.message : "Check the details and try again.",
          variant: "destructive",
        }),
    },
  });

  const removeMutation = useRemoveImapAccount({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getListImapAccountsQueryKey(), next);
        toast({ title: "IMAP account removed" });
      },
      onError: () =>
        queryClient.invalidateQueries({ queryKey: getListImapAccountsQueryKey() }),
    },
  });

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!host.trim() || !username.trim() || !password) return;
    const portNum = Number.parseInt(port, 10);
    addMutation.mutate({
      data: {
        label: label.trim() || null,
        host: host.trim(),
        port: Number.isFinite(portNum) && portNum > 0 ? portNum : null,
        secure,
        username: username.trim(),
        password,
        webmailUrl: webmailUrl.trim() || null,
      },
    });
  }

  return (
    <div className="border border-border bg-card relative">
      <div className="absolute top-0 left-0 h-full w-0.5 bg-primary/60" />
      <div className="flex items-center justify-between gap-2.5 px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <Mail className="w-4 h-4 text-primary" />
          <h2 className="font-bold text-sm uppercase tracking-widest text-foreground">
            IMAP Mail Accounts
          </h2>
        </div>
        {!isLoading && (
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
            {(accounts ?? []).length > 0
              ? `${(accounts ?? []).length} account${(accounts ?? []).length === 1 ? "" : "s"}`
              : "None"}
          </span>
        )}
      </div>

      <div className="p-5 space-y-4">
        <p className="text-xs text-muted-foreground">
          Add any standard IMAP mailbox (Fastmail, iCloud, a self-hosted server,
          …) to show it on the Email tile. Passwords are stored on the host and
          never sent back to the browser — for most providers use an
          app-specific password.
        </p>

        {(accounts ?? []).length > 0 && (
          <ul className="space-y-2">
            {(accounts ?? []).map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 border border-border bg-muted/30 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm text-foreground truncate">{a.label}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {a.username} @ {a.host}:{a.port}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => removeMutation.mutate({ id: a.id })}
                  disabled={removeMutation.isPending}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${a.label}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleAdd} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Label (optional)
            </Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Personal mail"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              IMAP host
            </Label>
            <Input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="imap.fastmail.com"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Port
            </Label>
            <Input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={secure ? "993" : "143"}
              inputMode="numeric"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="imap-secure"
              className="text-xs uppercase tracking-wider text-muted-foreground"
            >
              Use SSL/TLS
            </Label>
            <div className="flex items-center gap-2.5 h-9">
              <Switch
                id="imap-secure"
                checked={secure}
                onCheckedChange={(checked) => {
                  setSecure(checked);
                  // Swap the default port along with the mode, but only if the
                  // user hasn't typed a custom one.
                  if (checked && port === "143") setPort("993");
                  if (!checked && port === "993") setPort("143");
                }}
              />
              <span className="text-xs text-muted-foreground">
                {secure ? "Implicit TLS (usually port 993)" : "Plain / STARTTLS (usually port 143)"}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Username
            </Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@example.com"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Password
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="App password"
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Webmail URL (optional)
            </Label>
            <Input
              value={webmailUrl}
              onChange={(e) => setWebmailUrl(e.target.value)}
              placeholder="https://mail.example.com"
              autoComplete="off"
            />
            <p className="text-[11px] text-muted-foreground">
              When set, clicking a message on the Email tile opens this webmail
              in a new tab.
            </p>
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={
                addMutation.isPending || !host.trim() || !username.trim() || !password
              }
              className="gap-1.5"
            >
              {addMutation.isPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Adding…
                </>
              ) : (
                "Add account"
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CalDavAccountsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: accounts, isLoading } = useListCalDavAccounts({
    query: { queryKey: getListCalDavAccountsQueryKey() },
  });

  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const addMutation = useAddCalDavAccount({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getListCalDavAccountsQueryKey(), next);
        setLabel("");
        setUrl("");
        setUsername("");
        setPassword("");
        toast({ title: "CalDAV account added" });
      },
      onError: (err) =>
        toast({
          title: "Couldn’t add CalDAV account",
          description: err instanceof ApiError ? err.message : "Check the details and try again.",
          variant: "destructive",
        }),
    },
  });

  const removeMutation = useRemoveCalDavAccount({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getListCalDavAccountsQueryKey(), next);
        toast({ title: "CalDAV account removed" });
      },
      onError: () =>
        queryClient.invalidateQueries({ queryKey: getListCalDavAccountsQueryKey() }),
    },
  });

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || !username.trim() || !password) return;
    addMutation.mutate({
      data: {
        label: label.trim() || null,
        url: url.trim(),
        username: username.trim(),
        password,
      },
    });
  }

  return (
    <div className="border border-border bg-card relative">
      <div className="absolute top-0 left-0 h-full w-0.5 bg-primary/60" />
      <div className="flex items-center justify-between gap-2.5 px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <CalendarDays className="w-4 h-4 text-primary" />
          <h2 className="font-bold text-sm uppercase tracking-widest text-foreground">
            CalDAV Calendars
          </h2>
        </div>
        {!isLoading && (
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
            {(accounts ?? []).length > 0
              ? `${(accounts ?? []).length} account${(accounts ?? []).length === 1 ? "" : "s"}`
              : "None"}
          </span>
        )}
      </div>

      <div className="p-5 space-y-4">
        <p className="text-xs text-muted-foreground">
          Add any CalDAV calendar (Nextcloud, Radicale, Fastmail, iCloud, …) to
          show its events on the Calendar tile. Passwords are stored on the
          host and never sent back to the browser.
        </p>

        {(accounts ?? []).length > 0 && (
          <ul className="space-y-2">
            {(accounts ?? []).map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 border border-border bg-muted/30 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm text-foreground truncate">{a.label}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {a.username} @ {a.url}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => removeMutation.mutate({ id: a.id })}
                  disabled={removeMutation.isPending}
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${a.label}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleAdd} className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Label (optional)
            </Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Family calendar"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Server URL
            </Label>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://cloud.example.com/remote.php/dav"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Username
            </Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@example.com"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Password
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="App password"
              autoComplete="new-password"
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={
                addMutation.isPending || !url.trim() || !username.trim() || !password
              }
              className="gap-1.5"
            >
              {addMutation.isPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Adding…
                </>
              ) : (
                "Add account"
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

const AI_PROVIDER_LABELS: Record<string, string> = {
  [AiProvider.openai]: "OpenAI (ChatGPT)",
  [AiProvider.gemini]: "Google Gemini",
  [AiProvider.anthropic]: "Anthropic (Claude)",
  [AiProvider.ollama]: "Ollama (local)",
  [AiProvider.openai_compatible]: "Local server (LM Studio, vLLM…)",
};

// Local providers connect to a server on your network via a base URL instead
// of a cloud API key.
const LOCAL_AI_PROVIDERS: string[] = [AiProvider.ollama, AiProvider.openai_compatible];

function AiAccountsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: accounts, isLoading } = useListAiAccounts({
    query: { queryKey: getListAiAccountsQueryKey() },
  });

  // Shared add/edit form. `editing` holds the account being edited (null when
  // adding). While editing, an empty key field means "keep the saved key".
  const [editing, setEditing] = useState<AiAccount | null>(null);
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<string>(AiProvider.openai);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const isLocal = LOCAL_AI_PROVIDERS.includes(provider);
  // Per-account test feedback keyed by account id.
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; message: string }>
  >({});

  function resetForm() {
    setEditing(null);
    setLabel("");
    setProvider(AiProvider.openai);
    setApiKey("");
    setBaseUrl("");
    setModel("");
  }

  const addMutation = useAddAiAccount({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getListAiAccountsQueryKey(), next);
        resetForm();
        toast({ title: "AI account added" });
      },
      onError: (err) =>
        toast({
          title: "Couldn’t add AI account",
          description:
            err instanceof ApiError ? err.message : "Check the details and try again.",
          variant: "destructive",
        }),
    },
  });

  const updateMutation = useUpdateAiAccount({
    mutation: {
      onSuccess: (next) => {
        queryClient.setQueryData(getListAiAccountsQueryKey(), next);
        resetForm();
        toast({ title: "AI account updated" });
      },
      onError: (err) =>
        toast({
          title: "Couldn’t update AI account",
          description:
            err instanceof ApiError ? err.message : "Check the details and try again.",
          variant: "destructive",
        }),
    },
  });

  const removeMutation = useRemoveAiAccount({
    mutation: {
      onSuccess: (next, vars) => {
        queryClient.setQueryData(getListAiAccountsQueryKey(), next);
        if (editing?.id === vars.id) resetForm();
        toast({ title: "AI account removed" });
      },
      onError: () =>
        queryClient.invalidateQueries({ queryKey: getListAiAccountsQueryKey() }),
    },
  });

  const testMutation = useTestAiAccount({
    mutation: {
      onSuccess: (result, vars) => {
        setTestResults((cur) => ({
          ...cur,
          [vars.id]: {
            ok: result.ok,
            message:
              result.message || (result.ok ? "Key works" : "Key check failed"),
          },
        }));
      },
      onError: (err, vars) => {
        setTestResults((cur) => ({
          ...cur,
          [vars.id]: {
            ok: false,
            message: err instanceof ApiError ? err.message : "Test failed",
          },
        }));
      },
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editing) {
      updateMutation.mutate({
        id: editing.id,
        data: {
          label: label.trim() || null,
          provider: provider as AiAccount["provider"],
          apiKey: apiKey.trim() || null,
          baseUrl: isLocal ? baseUrl.trim() || null : null,
          model: model.trim() || null,
        },
      });
    } else {
      if (isLocal ? !baseUrl.trim() : !apiKey.trim()) return;
      addMutation.mutate({
        data: {
          label: label.trim() || null,
          provider: provider as AiAccount["provider"],
          apiKey: apiKey.trim() || null,
          baseUrl: isLocal ? baseUrl.trim() : null,
          model: model.trim() || null,
        },
      });
    }
  }

  function startEdit(a: AiAccount) {
    setEditing(a);
    setLabel(a.label);
    setProvider(a.provider);
    setApiKey("");
    setBaseUrl(a.baseUrl ?? "");
    setModel(a.model ?? "");
  }

  const saving = addMutation.isPending || updateMutation.isPending;

  return (
    <div className="border border-border bg-card relative">
      <div className="absolute top-0 left-0 h-full w-0.5 bg-primary/60" />
      <div className="flex items-center justify-between gap-2.5 px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2.5">
          <Bot className="w-4 h-4 text-primary" />
          <h2 className="font-bold text-sm uppercase tracking-widest text-foreground">
            AI Accounts
          </h2>
        </div>
        {!isLoading && (
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">
            {(accounts ?? []).length > 0
              ? `${(accounts ?? []).length} account${(accounts ?? []).length === 1 ? "" : "s"}`
              : "None"}
          </span>
        )}
      </div>

      <div className="p-5 space-y-4">
        <p className="text-xs text-muted-foreground">
          Bring your own API keys for OpenAI, Google Gemini, or Anthropic
          Claude — or point at a local model server like Ollama or LM Studio on
          your network — to power AI Chat tiles. Keys are stored on the host and
          never sent back to the browser — only a masked hint is shown here.
        </p>

        {(accounts ?? []).length > 0 && (
          <ul className="space-y-2">
            {(accounts ?? []).map((a) => {
              const test = testResults[a.id];
              return (
                <li
                  key={a.id}
                  className="border border-border bg-muted/30 px-3 py-2 space-y-1"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm text-foreground truncate">
                        {a.label}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {AI_PROVIDER_LABELS[a.provider] ?? a.provider}
                        {a.baseUrl ? ` · ${a.baseUrl}` : ""}
                        {a.maskedKey ? ` · ${a.maskedKey}` : ""}
                        {a.model ? ` · ${a.model}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => testMutation.mutate({ id: a.id })}
                        disabled={testMutation.isPending}
                        className="h-7 px-2 text-xs"
                      >
                        {testMutation.isPending && testMutation.variables?.id === a.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          "Test"
                        )}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => startEdit(a)}
                        className="h-7 px-2 text-muted-foreground hover:text-foreground"
                        aria-label={`Edit ${a.label}`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => removeMutation.mutate({ id: a.id })}
                        disabled={removeMutation.isPending}
                        className="h-7 px-2 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove ${a.label}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  {test && (
                    <p
                      className={`text-xs flex items-center gap-1 ${test.ok ? "text-green-500" : "text-destructive"}`}
                    >
                      {test.ok ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <AlertTriangle className="w-3 h-3" />
                      )}
                      {test.message}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-2">
          {editing && (
            <div className="sm:col-span-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Editing <span className="text-foreground">{editing.label}</span> —
                leave the key blank to keep the saved one.
              </span>
              <Button type="button" size="sm" variant="ghost" onClick={resetForm}>
                Cancel
              </Button>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Label (optional)
            </Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Work OpenAI"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Provider
            </Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(AiProvider).map((p) => (
                  <SelectItem key={p} value={p}>
                    {AI_PROVIDER_LABELS[p] ?? p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isLocal && (
            <div className="space-y-1.5">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Server URL
              </Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  provider === AiProvider.ollama
                    ? "http://192.168.1.10:11434"
                    : "http://192.168.1.10:1234"
                }
                autoComplete="off"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              {isLocal ? "API key (optional)" : "API key"}
            </Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                editing
                  ? "Leave blank to keep saved key"
                  : isLocal
                    ? "Usually not needed"
                    : "sk-…"
              }
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              {isLocal ? "Default model" : "Default model (optional)"}
            </Label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                provider === AiProvider.ollama ? "e.g. llama3.2" : "e.g. gpt-4o-mini"
              }
              autoComplete="off"
            />
          </div>
          {isLocal && !model.trim() && (
            <p className="sm:col-span-2 text-xs text-muted-foreground">
              Local servers need a model name — set a default here or pick one
              per tile after saving (the list loads from your server).
            </p>
          )}
          <div className="sm:col-span-2">
            <Button
              type="submit"
              size="sm"
              disabled={saving || (!editing && (isLocal ? !baseUrl.trim() : !apiKey.trim()))}
              className="gap-1.5"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {editing ? "Save changes" : "Add AI account"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Persist each category's collapsed/expanded state in localStorage, keyed per
// category, so a user's choice survives reloads and sessions. Defaults to
// expanded the first time (matching the original behaviour).
const COLLAPSE_STORAGE_PREFIX = "settings.category.open.";

function readCategoryOpen(title: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(COLLAPSE_STORAGE_PREFIX + title);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

function writeCategoryOpen(title: string, open: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COLLAPSE_STORAGE_PREFIX + title, String(open));
  } catch {
    // Ignore storage failures (e.g. private mode); state stays in-memory only.
  }
}

// A collapsible group of service cards under a category heading. Expanded by
// default the first time; the collapsed state is remembered per category across
// reloads and sessions via localStorage.
function CategorySection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => readCategoryOpen(title));

  function handleOpenChange(next: boolean) {
    setOpen(next);
    writeCategoryOpen(title, next);
  }

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-1 py-2 text-left">
        <ChevronDown
          className={`w-4 h-4 text-primary transition-transform ${open ? "" : "-rotate-90"}`}
        />
        <span className="font-bold text-xs uppercase tracking-widest text-foreground">
          {title}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-5 pt-1 pb-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Profile export/import
// ---------------------------------------------------------------------------

// The browser-side theme bundle merged into a downloaded profile file. Themes
// live in localStorage (not the server), so the client is the only place that
// can round-trip them between accounts/browsers.
interface ProfileThemeBundle {
  active?: string | null;
  colors?: ColorOverrides;
  customThemes?: CustomThemeMap;
}

type ProfileFile = ProfileExport & { theme?: ProfileThemeBundle };

// Collect the current browser theme state for embedding into an export file.
function collectThemeBundle(): ProfileThemeBundle {
  let active: string | null = null;
  try {
    active = localStorage.getItem(THEME_KEY);
  } catch {
    /* privacy mode */
  }
  return {
    active,
    colors: readSavedColors(),
    customThemes: readCustomThemes(),
  };
}

// Apply an imported theme bundle to this browser. Every custom theme passes
// through validateCustomTheme so a hand-edited file can never inject raw CSS.
// Replace mode swaps the browser's theme state for the file's; merge mode adds
// the file's custom themes/overrides without clobbering existing ones.
// Returns the number of custom themes applied.
function applyThemeBundle(theme: ProfileThemeBundle, replace: boolean): number {
  const incoming: CustomThemeMap = {};
  for (const [id, def] of Object.entries(theme.customThemes ?? {})) {
    if (!isCustomThemeId(id)) continue;
    const result = validateCustomTheme(def);
    if (result.ok) incoming[id] = { ...result.value, id };
  }

  const existing = readCustomThemes();
  const merged = replace ? incoming : { ...incoming, ...existing };
  persistCustomThemes(merged);

  const existingColors = readSavedColors();
  const incomingColors =
    theme.colors && typeof theme.colors === "object" ? theme.colors : {};
  const colors = replace
    ? incomingColors
    : { ...incomingColors, ...existingColors };
  persistColors(colors);

  // Switch to the file's active theme when it resolves to something real.
  const active = theme.active;
  if (typeof active === "string" && (isKnownTheme(active) || merged[active])) {
    persistTheme(active);
    applyThemeToDom(
      active,
      isKnownTheme(active) ? (colors as ColorOverrides)[active] : undefined,
      merged,
    );
  }
  return Object.keys(incoming).length;
}

// Human summary counts for a parsed profile file.
function summarizeProfileFile(file: ProfileFile) {
  const pages = file.pages?.length ?? 0;
  const tiles = (file.pages ?? []).reduce((n, p) => n + (p.tiles?.length ?? 0), 0);
  return {
    pages,
    tiles,
    deviceModes: file.deviceModes?.length ?? 0,
    connections: file.connections?.length ?? 0,
    customThemes: Object.keys(file.theme?.customThemes ?? {}).length,
    hasTheme: Boolean(file.theme),
  };
}

function ProfileSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const [includeConnections, setIncludeConnections] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exporting, setExporting] = useState(false);

  const [pendingFile, setPendingFile] = useState<ProfileFile | null>(null);
  const [importMode, setImportMode] = useState<"merge" | "replace">("merge");

  // Set when the selected file is an encrypted export awaiting a passphrase.
  const [lockedFile, setLockedFile] = useState<EncryptedProfileFile | null>(null);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [decrypting, setDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);

  const importProfile = useImportProfile({
    mutation: {
      onSuccess: (result) => {
        // The whole account may have changed shape — refetch everything.
        queryClient.invalidateQueries();
        let themes = 0;
        if (pendingFile?.theme) {
          themes = applyThemeBundle(pendingFile.theme, result.mode === "replace");
        }
        setPendingFile(null);
        const bits = [
          `${result.pages} page${result.pages === 1 ? "" : "s"}`,
          `${result.tiles} tile${result.tiles === 1 ? "" : "s"}`,
        ];
        if (result.connections > 0) bits.push(`${result.connections} connections`);
        if (themes > 0) bits.push(`${themes} custom theme${themes === 1 ? "" : "s"}`);
        toast({
          title: result.mode === "replace" ? "Profile replaced" : "Profile imported",
          description: `Imported ${bits.join(", ")}.`,
        });
      },
      onError: (err) => {
        toast({
          title: "Import failed",
          description: err instanceof Error ? err.message : "Could not import profile",
          variant: "destructive",
        });
      },
    },
  });

  async function handleExport() {
    setExporting(true);
    try {
      const data = await exportProfile(
        includeConnections ? { includeConnections: true } : undefined,
      );
      const file: ProfileFile = { ...data, theme: collectThemeBundle() };
      const passphrase = includeConnections ? exportPassphrase.trim() : "";
      const payload = passphrase
        ? await encryptProfileFile(JSON.stringify(file), passphrase)
        : file;
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "tachboard-profile.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      setExportOpen(false);
      setExportPassphrase("");
      toast({
        title: passphrase ? "Encrypted profile exported" : "Profile exported",
      });
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Could not export profile",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  }

  // Validate a decrypted/plain parsed file and open the import dialog.
  function acceptPlainFile(parsed: ProfileFile) {
    if (parsed?.format === "homelab-dashboard-pages") {
      toast({
        title: "That's a pages export",
        description:
          "This file holds pages only. Import it from the dashboard's page menu instead.",
        variant: "destructive",
      });
      return;
    }
    if (parsed?.format !== "tachboard-profile") {
      toast({
        title: "Import failed",
        description: "This file is not a Tachboard profile export.",
        variant: "destructive",
      });
      return;
    }
    setImportMode("merge");
    setPendingFile(parsed);
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so re-selecting the same file re-fires the change event.
    e.target.value = "";
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast({
        title: "Import failed",
        description: "That file isn't valid JSON.",
        variant: "destructive",
      });
      return;
    }
    if (isEncryptedProfileFile(parsed)) {
      // Encrypted export: ask for the passphrase before anything else.
      setImportPassphrase("");
      setDecryptError(null);
      setLockedFile(parsed);
      return;
    }
    acceptPlainFile(parsed as ProfileFile);
  }

  async function handleDecrypt() {
    if (!lockedFile) return;
    setDecrypting(true);
    setDecryptError(null);
    try {
      const plainJson = await decryptProfileFile(lockedFile, importPassphrase);
      let parsed: ProfileFile;
      try {
        parsed = JSON.parse(plainJson) as ProfileFile;
      } catch {
        setDecryptError("The decrypted file isn't valid JSON.");
        return;
      }
      setLockedFile(null);
      setImportPassphrase("");
      acceptPlainFile(parsed);
    } catch (err) {
      setDecryptError(
        err instanceof ProfileDecryptError
          ? err.message
          : "Could not decrypt this file.",
      );
    } finally {
      setDecrypting(false);
    }
  }

  function confirmImport() {
    if (!pendingFile) return;
    // The server ignores the client-only theme key, but strip it anyway so the
    // request body matches the API contract exactly.
    const { theme: _theme, ...serverEnvelope } = pendingFile;
    importProfile.mutate({
      data: { ...serverEnvelope, mode: importMode } as ProfileImportBody,
    });
  }

  const summary = pendingFile ? summarizeProfileFile(pendingFile) : null;

  return (
    <div className="mb-8">
      <div className="mb-4">
        <h1 className="font-bold uppercase tracking-widest text-foreground">Profile</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Move your whole setup — pages, tiles, layouts, device modes, and themes —
          between accounts or installs as a single file.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => setExportOpen(true)}
          data-testid="button-export-profile"
        >
          <Download className="w-3.5 h-3.5" />
          Export profile
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => fileInputRef.current?.click()}
          data-testid="button-import-profile"
        >
          <Plug className="w-3.5 h-3.5" />
          Import profile
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={handleImportFile}
          data-testid="input-import-profile-file"
        />
      </div>

      {/* Export dialog: credentials opt-in with an explicit warning. */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Export profile</DialogTitle>
            <DialogDescription>
              Downloads a JSON file with your pages, tiles, layouts, device modes,
              and browser themes.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer">
            <Checkbox
              checked={includeConnections}
              onCheckedChange={(v) => setIncludeConnections(v === true)}
              className="mt-0.5"
              data-testid="checkbox-include-connections"
            />
            <span className="text-sm">
              <span className="font-medium text-foreground">
                Include service connections
              </span>
              <span className="block text-muted-foreground mt-1">
                Adds your saved URLs, API keys, usernames, and passwords to the
                file in readable form. Only share the file with people you trust.
              </span>
            </span>
          </label>
          {includeConnections && (
            <div className="space-y-2">
              <Label htmlFor="export-passphrase" className="text-sm">
                Passphrase <span className="text-muted-foreground">(recommended)</span>
              </Label>
              <Input
                id="export-passphrase"
                type="password"
                autoComplete="new-password"
                placeholder="Encrypt the file with a passphrase"
                value={exportPassphrase}
                onChange={(e) => setExportPassphrase(e.target.value)}
                data-testid="input-export-passphrase"
              />
              {exportPassphrase.trim() ? (
                <p className="text-xs text-muted-foreground">
                  The file will be encrypted. You'll need this passphrase to import
                  it — it can't be recovered if lost.
                </p>
              ) : (
                <div className="flex items-start gap-2 text-xs text-destructive">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  Without a passphrase, the exported file will contain credentials
                  in plain text.
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleExport}
              disabled={exporting}
              data-testid="button-confirm-export"
            >
              {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Passphrase prompt for encrypted export files. */}
      <Dialog
        open={lockedFile !== null}
        onOpenChange={(open) => {
          if (!open) {
            setLockedFile(null);
            setImportPassphrase("");
            setDecryptError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Encrypted profile file</DialogTitle>
            <DialogDescription>
              This export is protected. Enter the passphrase it was exported with
              to unlock it.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleDecrypt();
            }}
            className="space-y-2"
          >
            <Label htmlFor="import-passphrase" className="text-sm">
              Passphrase
            </Label>
            <Input
              id="import-passphrase"
              type="password"
              autoComplete="off"
              autoFocus
              value={importPassphrase}
              onChange={(e) => setImportPassphrase(e.target.value)}
              data-testid="input-import-passphrase"
            />
            {decryptError && (
              <p className="text-xs text-destructive" data-testid="text-decrypt-error">
                {decryptError}
              </p>
            )}
          </form>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLockedFile(null);
                setImportPassphrase("");
                setDecryptError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void handleDecrypt()}
              disabled={decrypting || !importPassphrase}
              data-testid="button-confirm-decrypt"
            >
              {decrypting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Unlock
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import dialog: file summary + replace/add choice. */}
      <Dialog
        open={pendingFile !== null}
        onOpenChange={(open) => {
          if (!open) setPendingFile(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Import profile</DialogTitle>
            <DialogDescription>
              {summary && (
                <>
                  This file contains {summary.pages} page{summary.pages === 1 ? "" : "s"},{" "}
                  {summary.tiles} tile{summary.tiles === 1 ? "" : "s"}, {summary.deviceModes}{" "}
                  device mode{summary.deviceModes === 1 ? "" : "s"}
                  {summary.connections > 0 &&
                    `, ${summary.connections} service connection${summary.connections === 1 ? "" : "s"} (with credentials)`}
                  {summary.hasTheme &&
                    `, and theme settings${summary.customThemes > 0 ? ` (${summary.customThemes} custom)` : ""}`}
                  .
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setImportMode("merge")}
              className={`w-full text-left rounded-md border p-3 text-sm transition-colors ${
                importMode === "merge"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-muted-foreground/40"
              }`}
              data-testid="button-mode-merge"
            >
              <span className="font-medium text-foreground">Add to my profile</span>
              <span className="block text-muted-foreground mt-0.5">
                Appends the file's pages and device modes next to yours. Nothing is
                deleted; duplicate names get a “(2)” suffix.
              </span>
            </button>
            <button
              type="button"
              onClick={() => setImportMode("replace")}
              className={`w-full text-left rounded-md border p-3 text-sm transition-colors ${
                importMode === "replace"
                  ? "border-destructive bg-destructive/5"
                  : "border-border hover:border-muted-foreground/40"
              }`}
              data-testid="button-mode-replace"
            >
              <span className="font-medium text-foreground">Replace my profile</span>
              <span className="block text-muted-foreground mt-0.5">
                Deletes all of your current pages, tiles, and device modes
                {summary && summary.connections > 0 ? " (and service connections)" : ""}{" "}
                and recreates everything from the file. This cannot be undone.
              </span>
            </button>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingFile(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant={importMode === "replace" ? "destructive" : "default"}
              onClick={confirmImport}
              disabled={importProfile.isPending}
              data-testid="button-confirm-import"
            >
              {importProfile.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : null}
              {importMode === "replace" ? "Replace & import" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── About / version + update notice ────────────────────────────────────────
// Shows the running build's version and, when the (once-a-day, opt-out)
// GitHub release check finds a newer release, an unobtrusive notice + link.
function AboutSection() {
  const { data: version } = useGetVersion({
    query: {
      queryKey: getGetVersionQueryKey(),
      staleTime: 60 * 60 * 1000, // server caches for a day; no need to poll
      retry: false,
    },
  });

  return (
    <div className="mt-8 pt-4 border-t border-border text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="uppercase tracking-widest font-semibold">Tachboard</span>
        <span data-testid="text-app-version">
          Version {version?.currentVersion ?? "…"}
        </span>
        {version?.updateAvailable && version.latestVersion && (
          <a
            href={version.releaseUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
            data-testid="link-update-available"
          >
            Update available: {version.latestVersion}
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
      {version && !version.checkEnabled && (
        <p className="mt-1">Update checks are disabled.</p>
      )}
    </div>
  );
}

export default function Settings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: me, isError: meError } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });

  useEffect(() => {
    if (meError) setLocation("/login");
  }, [meError, setLocation]);

  // Surface the result of an OAuth round-trip (the server redirects back here
  // with ?spotify=connected|error or ?google=connected|error), then strip the
  // param so it doesn't re-fire on refresh.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Each entry: query param name → postMessage type + display name.
    const flows = [
      { param: "spotify", type: "spotify-auth", name: "Spotify" },
      { param: "google", type: "google-auth", name: "Google" },
    ];
    const flow = flows.find((f) => params.get(f.param));
    if (!flow) return;
    const result = params.get(flow.param)!;
    // Optional failure detail (e.g. google_reason=redirect) so the card can
    // show targeted help instead of a generic error.
    const reason = params.get(`${flow.param}_reason`);

    // When this page is the OAuth popup (opened by handleConnect), hand the
    // result back to the dashboard tab and close — the opener refreshes status
    // and shows the toast. Same-origin, so opener access is allowed.
    if (window.opener && window.opener !== window) {
      try {
        window.opener.postMessage(
          { type: flow.type, result, reason },
          window.location.origin,
        );
      } catch {
        /* opener gone/blocked — fall through to top-level handling below */
      }
      window.close();
      return;
    }

    if (flow.param === "google") {
      // The popup-blocked fallback opens the flow in a top-level tab, so the
      // redirect lands here instead of in a popup. Forward the result to the
      // GoogleCard listener (same window receives self-posted messages) so it
      // can show the targeted redirect-URI help — it also handles the toast.
      window.postMessage({ type: flow.type, result, reason }, window.location.origin);
    } else if (result === "connected") {
      toast({ title: `${flow.name} connected` });
    } else if (result === "error") {
      toast({
        title: `${flow.name} connection failed`,
        description: "Please try linking your account again.",
        variant: "destructive",
      });
    }
    params.delete(flow.param);
    params.delete(`${flow.param}_reason`);
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      window.location.pathname + (query ? `?${query}` : ""),
    );
  }, [toast]);

  const {
    data: connections,
    isLoading,
    isError,
  } = useGetConnections({
    query: { queryKey: getGetConnectionsQueryKey(), enabled: Boolean(me) },
  });

  useEffect(() => {
    if (isError) {
      toast({
        title: "Failed to load settings",
        description: "Could not reach the server.",
        variant: "destructive",
      });
    }
  }, [isError, toast]);

  const byService = new Map(
    (connections ?? []).map((c) => [c.service, c]),
  );

  return (
    <div className="min-h-screen bg-background bg-dot-pattern">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-screen-md mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <TachLogo className="w-5 h-5 text-primary" />
            <span className="font-bold text-sm uppercase tracking-widest text-foreground">
              Settings
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setLocation("/")}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Dashboard
          </Button>
        </div>
      </header>

      <main className="max-w-screen-md mx-auto px-4 py-6">
        <AppearanceSettings />

        <ProfileSection />

        <div className="mb-6">
          <h1 className="font-bold uppercase tracking-widest text-foreground">
            Service connections
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Connection details are stored on the host and shared across all
            browsers pointing to this dashboard.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
            <span className="text-primary">{"> "}</span>
            <span className="animate-pulse">Loading settings…</span>
          </div>
        ) : (
          <div className="space-y-4">
            {groupByCategory(SERVICES, (def) => def.key).map((group) => (
              <CategorySection key={group.category} title={group.category}>
                {group.items.map((def) => (
                  <ServiceCard
                    key={def.key}
                    def={def}
                    connection={byService.get(def.key)}
                  />
                ))}
                {/* Spotify lives in Media but uses its own OAuth card. */}
                {group.category === "Media" && <SpotifyCard />}
              </CategorySection>
            ))}
            {/* Communication has no generic ServiceCard entries — its cards are
                all bespoke (Google OAuth + multi-account IMAP/CalDAV lists). */}
            <CategorySection title="Communication">
              <GoogleCard />
              <ImapAccountsCard />
              <CalDavAccountsCard />
              <AiAccountsCard />
            </CategorySection>
          </div>
        )}

        <AboutSection />
      </main>
    </div>
  );
}
