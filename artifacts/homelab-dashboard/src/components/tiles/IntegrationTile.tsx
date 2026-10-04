import { useEffect, useRef, useState } from "react";
import type { Tile, ServiceStatus, TileSettings } from "@workspace/api-client-react";
import { TileIntegration } from "@workspace/api-client-react";
import { ExternalLink } from "lucide-react";
import TruenasTile from "./TruenasTile";
import MediaTile from "./MediaTile";
import SonarrTile from "./SonarrTile";
import RadarrTile from "./RadarrTile";
import LidarrTile from "./LidarrTile";
import QbittorrentTile from "./QbittorrentTile";
import PiholeTile from "./PiholeTile";
import NginxProxyManagerTile from "./NginxProxyManagerTile";
import ProwlarrTile from "./ProwlarrTile";
import PterodactylTile from "./PterodactylTile";
import TailscaleTile from "./TailscaleTile";
import ErsatztvTile from "./ErsatztvTile";
import ClockTile from "./ClockTile";
import WeatherTile from "./WeatherTile";
import SportsTile from "./SportsTile";
import NewsTile from "./NewsTile";
import EmailTile from "./EmailTile";
import CalendarTile from "./CalendarTile";
import StocksTile from "./StocksTile";
import SleeperTile from "./SleeperTile";
import AudioPlayerTile from "./AudioPlayerTile";
import EightBallTile from "./EightBallTile";
import DiceTile from "./DiceTile";
import CoinFlipTile from "./CoinFlipTile";
import FortuneTile from "./FortuneTile";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { resolveEnabledMetrics, tileDensity, type TileDensity } from "./metrics";
import { resolveImageStyle } from "./imageStyle";
import { openTileUrl } from "@/lib/utils";
import { useTileExpansion } from "./expansion";

export const INTEGRATION_LABELS: Record<string, string> = {
  [TileIntegration.truenas]: "TrueNAS",
  [TileIntegration.media]: "Plex",
  [TileIntegration.jellyfin]: "Jellyfin",
  [TileIntegration.sonarr]: "Sonarr",
  [TileIntegration.radarr]: "Radarr",
  [TileIntegration.lidarr]: "Lidarr",
  [TileIntegration.qbittorrent]: "qBittorrent",
  [TileIntegration.pihole]: "Pi-hole",
  [TileIntegration["nginx-proxy-manager"]]: "Nginx Proxy Manager",
  [TileIntegration.prowlarr]: "Prowlarr",
  [TileIntegration.pterodactyl]: "Pterodactyl",
  [TileIntegration.tailscale]: "Tailscale",
  [TileIntegration.ersatztv]: "ErsatzTV",
  [TileIntegration.clock]: "Local Time",
  [TileIntegration.timer]: "Timer",
  [TileIntegration.weather]: "Weather",
  [TileIntegration.sports]: "Sports",
  [TileIntegration.news]: "News",
  [TileIntegration.email]: "Email",
  [TileIntegration.calendar]: "Calendar",
  [TileIntegration.aichat]: "AI Chat",
  [TileIntegration.stocks]: "Stocks",
  [TileIntegration.sleeper]: "Fantasy",
  [TileIntegration.audioplayer]: "Audio Player",
  [TileIntegration.eightball]: "Magic Eight Ball",
  [TileIntegration.dice]: "Dice Roller",
  [TileIntegration.coinflip]: "Coin Flip",
  [TileIntegration.fortune]: "Fortune",
};

// Props every integration widget receives: the resolved set of enabled metric
// keys and the size-derived density.
export interface WidgetProps {
  enabled: Set<string>;
  density: TileDensity;
  // Per-tile extra config. Only qBittorrent uses it (category filter) for now;
  // other widgets ignore it.
  tileSettings?: TileSettings | null;
  // The tile's integration value. MediaTile uses it to pick the backing media
  // server (Plex vs Jellyfin); other widgets ignore it.
  integration: string;
  // True while the dashboard layout is being arranged. Widgets with in-place
  // actions (e.g. Pterodactyl power buttons) hide them in edit mode so clicks
  // don't fight drag/resize.
  editMode: boolean;
}

function renderStatusView(integration: string, props: WidgetProps) {
  switch (integration) {
    case TileIntegration.truenas:
      return <TruenasTile {...props} />;
    case TileIntegration.media:
    case TileIntegration.jellyfin:
      return <MediaTile {...props} />;
    case TileIntegration.sonarr:
      return <SonarrTile {...props} />;
    case TileIntegration.radarr:
      return <RadarrTile {...props} />;
    case TileIntegration.lidarr:
      return <LidarrTile {...props} />;
    case TileIntegration.qbittorrent:
      return <QbittorrentTile {...props} />;
    case TileIntegration.pihole:
      return <PiholeTile {...props} />;
    case TileIntegration["nginx-proxy-manager"]:
      return <NginxProxyManagerTile {...props} />;
    case TileIntegration.prowlarr:
      return <ProwlarrTile {...props} />;
    case TileIntegration.pterodactyl:
      return <PterodactylTile {...props} />;
    case TileIntegration.tailscale:
      return <TailscaleTile {...props} />;
    case TileIntegration.ersatztv:
      return <ErsatztvTile {...props} />;
    case TileIntegration.clock:
      return <ClockTile {...props} />;
    case TileIntegration.weather:
      return <WeatherTile {...props} />;
    case TileIntegration.sports:
      return <SportsTile {...props} />;
    case TileIntegration.news:
      return <NewsTile {...props} />;
    case TileIntegration.email:
      return <EmailTile {...props} />;
    case TileIntegration.calendar:
      return <CalendarTile {...props} />;
    case TileIntegration.stocks:
      return <StocksTile {...props} />;
    case TileIntegration.sleeper:
      return <SleeperTile {...props} />;
    case TileIntegration.audioplayer:
      return <AudioPlayerTile {...props} />;
    case TileIntegration.eightball:
      return <EightBallTile />;
    case TileIntegration.dice:
      return <DiceTile tileSettings={props.tileSettings} />;
    case TileIntegration.coinflip:
      return <CoinFlipTile />;
    case TileIntegration.fortune:
      return <FortuneTile />;
    default:
      return null;
  }
}

// Compact "how long ago" for the status tooltip (e.g. "just now", "45s ago",
// "5m ago"). Returns null when the timestamp is missing/unparseable.
function checkedAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface IntegrationTileProps {
  tile: Tile;
  status?: ServiceStatus;
  editMode?: boolean;
}

export default function IntegrationTile({ tile, status, editMode = false }: IntegrationTileProps) {
  const integration = tile.integration!;
  const hasImage = Boolean(tile.imageUrl);
  // No explicit per-tile color → follow the active theme's card surface.
  const bg = tile.bgColor || "hsl(var(--card))";
  const label = tile.name || INTEGRATION_LABELS[integration] || "App";

  const image = resolveImageStyle(tile);

  // A small reachability dot in the header. Only shown once a connection has
  // been saved for the backing service, and hidden when the user turned the
  // indicator off for this tile.
  const showDot =
    Boolean(status?.configured) && tile.tileSettings?.hideStatusDot !== true;
  const dotColor = status?.ok ? "bg-green-500" : "bg-red-500";

  // Resolve which metrics this tile shows.
  const enabled = resolveEnabledMetrics(integration, tile.metrics);

  // Measure the live-status body's real pixel size so reveal decisions are based
  // on the room content actually has, not a grid-unit approximation. The grid
  // dimensions seed the first paint before the observer reports a measurement.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) setMeasured({ width: cr.width, height: cr.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The reachability dot, shared between the header and the collapsed-header
  // overlay so the indicator survives hiding the title. Hovering it explains
  // the last check result (why the service is down + when it was checked).
  const ago = checkedAgo(status?.checkedAt);
  const statusSummary = status?.ok
    ? "Reachable"
    : `Unreachable${status?.message ? `: ${status.message}` : ""}`;
  const statusDot = showDot ? (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="relative flex h-2 w-2 flex-shrink-0 cursor-default"
            aria-label={statusSummary}
            onClick={(e) => e.stopPropagation()}
          >
            {status?.ok && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500/60" />
            )}
            <span className={`relative inline-flex h-2 w-2 rounded-full ${dotColor}`} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-64">
          <p>{statusSummary}</p>
          {ago && <p className="opacity-70">Checked {ago}</p>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : null;

  // With the title hidden the header only earns its fixed height when the tile
  // image fills it (the image becomes the icon). Without an image the header
  // would be an empty colored bar — an awkward gap — so we drop it and float
  // the status dot / open-link affordance over the widget body instead.
  const expansion = useTileExpansion();
  const showHeader = !expansion.expanded && (!tile.hideTitle || hasImage);

  // When enabled, the live-status body scrolls instead of clipping overflowing
  // content. The header (and its image background) stay fixed and clipped.
  // Expanded presentation is transient: it lifts reveal budgets (as if
  // scrollable) without touching the persisted setting.
  const scrollable = Boolean(tile.tileSettings?.scrollable) || expansion.expanded;
  const onHeaderClick = () => {
    if (expansion.canExpand && !expansion.expanded) expansion.requestExpand();
    else openTileUrl(tile.url);
  };

  // Density from the measured body (or grid-seeded for first paint). The seed
  // needs to know whether the header occupies space; `scrollable` makes reveal
  // budgets unbounded so widgets render everything for the body to scroll.
  const density = tileDensity(tile.gridW, tile.gridH, measured, showHeader, scrollable);

  return (
    <div className={`w-full ${expansion.expanded ? "h-auto" : "h-full"} flex flex-col overflow-hidden`}>
      {/* Styled header carrying the tile's custom name, background and image. */}
      {showHeader && (
        <div
          className="relative h-11 flex-shrink-0 overflow-hidden flex items-center px-3 gap-1.5 group/header select-none"
          style={{ background: bg }}
          onClick={onHeaderClick}
          role={expansion.canExpand && !expansion.expanded ? "button" : tile.url ? "link" : undefined}
          tabIndex={expansion.canExpand && !expansion.expanded ? 0 : undefined}
          onKeyDown={(e) => {
            if (expansion.canExpand && !expansion.expanded && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              expansion.requestExpand();
            }
          }}
          aria-label={expansion.canExpand && !expansion.expanded ? `Expand ${label}` : undefined}
          title={expansion.canExpand && !expansion.expanded ? "Open in expanded panel" : tile.url || undefined}
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        >
          {hasImage && (
            <div className={image.wrapperClassName} style={image.wrapperStyle}>
              <img
                src={tile.imageUrl!}
                alt={tile.name || "tile"}
                className={image.className}
                style={image.style}
                draggable={false}
              />
            </div>
          )}
          <div className="absolute inset-0 bg-black/20 group-hover/header:bg-black/30 transition-colors" />

          {statusDot && <span className="relative z-10">{statusDot}</span>}

          {!tile.hideTitle && (
            <span
              className="relative z-10 font-bold text-sm leading-tight tracking-wide truncate drop-shadow-sm"
              style={{ color: hasImage ? "#fff" : "inherit" }}
            >
              {label}
            </span>
          )}

          {tile.url && (
            <ExternalLink
              className="relative z-10 w-3 h-3 flex-shrink-0 opacity-0 group-hover/header:opacity-70 transition-opacity"
              style={{ color: hasImage ? "#fff" : "inherit" }}
            />
          )}
        </div>
      )}

      {/* Live-status section sourced from the integration. Size + the user's
          metric selection drive how much detail is shown. When the header is
          collapsed, the status dot / open-link float here so neither is lost. */}
      <div
        ref={bodyRef}
        className={`relative flex-1 min-h-0 ${scrollable ? "overflow-auto" : "overflow-hidden"} ${showHeader ? "border-t border-border" : ""}`}
      >
        {!showHeader && (statusDot || tile.url) && (
          <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1.5">
            {statusDot}
            {tile.url && !expansion.expanded && (
              <button
                type="button"
                onClick={() => openTileUrl(tile.url)}
                title={tile.url}
                aria-label="Open"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
        {/* One stable wrapper in every mode (never a conditional wrapper), so
            switching scrollable/expanded never remounts the widget. When
            scrolling, `h-full` roots resolve to content height and grow past
            the body; otherwise the wrapper pins to the body like before. */}
        <div className={expansion.expanded ? "min-h-0" : scrollable ? "min-h-full" : "h-full"}>
          {renderStatusView(integration, { enabled, density, tileSettings: tile.tileSettings, integration, editMode })}
        </div>
      </div>
    </div>
  );
}
