// Single source of display metadata (icon + one-line description) for every
// integration a tile can attach. Names live with the INTEGRATIONS list in the
// tile editor and the category grouping lives in integrationCategories; this
// file only adds the icon and blurb each integration card needs in the
// app-store style picker. Keyed by TileIntegration value, plus a "none" entry.

import {
  AppWindow,
  Clapperboard,
  Film,
  Tv,
  Disc3,
  Download,
  Server,
  ShieldBan,
  Network,
  Search,
  Gamepad2,
  Waypoints,
  Radio,
  Music,
  Clock,
  MonitorUp,
  Timer,
  Mail,
  CalendarDays,
  CloudSun,
  Trophy,
  Shirt,
  Newspaper,
  TrendingUp,
  CircleHelp,
  Dices,
  Coins,
  Cookie,
  PawPrint,
  Sprout,
  Fish,
  AudioLines,
  StickyNote,
  Bot,
  Images,
  MonitorPlay,
  SquareDashed,
  Heading,
  type LucideIcon,
} from "lucide-react";
import { TileIntegration } from "@workspace/api-client-react";

export const NONE = "none";

export interface IntegrationMeta {
  icon: LucideIcon;
  description: string;
}

// Icon + short description for each integration value. Labels come from the
// INTEGRATIONS list (the tile editor) so there is no duplicate name vocabulary.
export const INTEGRATION_META: Record<string, IntegrationMeta> = {
  [NONE]: {
    icon: AppWindow,
    description: "A plain app shortcut with no live data.",
  },
  [TileIntegration.media]: {
    icon: Clapperboard,
    description: "Now playing and recently added on Plex.",
  },
  [TileIntegration.jellyfin]: {
    icon: Film,
    description: "Now playing and recently added on Jellyfin.",
  },
  [TileIntegration.sonarr]: {
    icon: Tv,
    description: "TV show downloads and upcoming episodes.",
  },
  [TileIntegration.radarr]: {
    icon: Clapperboard,
    description: "Movie downloads and upcoming releases.",
  },
  [TileIntegration.lidarr]: {
    icon: Disc3,
    description: "Music downloads and recent additions.",
  },
  [TileIntegration.qbittorrent]: {
    icon: Download,
    description: "Active torrents and transfer speeds.",
  },
  [TileIntegration.truenas]: {
    icon: Server,
    description: "Storage pools, disks, and system health.",
  },
  [TileIntegration.pihole]: {
    icon: ShieldBan,
    description: "DNS queries blocked and allowed.",
  },
  [TileIntegration["nginx-proxy-manager"]]: {
    icon: Network,
    description: "Reverse proxy hosts and SSL status.",
  },
  [TileIntegration.prowlarr]: {
    icon: Search,
    description: "Indexer health and recent grabs.",
  },
  [TileIntegration.pterodactyl]: {
    icon: Gamepad2,
    description: "Game server status and resource usage.",
  },
  [TileIntegration.tailscale]: {
    icon: Waypoints,
    description: "Your tailnet devices and their status.",
  },
  [TileIntegration.ersatztv]: {
    icon: Radio,
    description: "Your custom IPTV channels and what's on.",
  },
  [TileIntegration.audioplayer]: {
    icon: Music,
    description: "Stream music from your media server.",
  },
  [TileIntegration.email]: {
    icon: Mail,
    description: "Recent messages from Gmail or IMAP inboxes.",
  },
  [TileIntegration.calendar]: {
    icon: CalendarDays,
    description: "Upcoming events from Google Calendar or CalDAV.",
  },
  [TileIntegration.clock]: {
    icon: Clock,
    description: "Current local time and date.",
  },
  [TileIntegration.timer]: {
    icon: Timer,
    description: "Countdown, stopwatch, or Pomodoro timer.",
  },
  [TileIntegration.weather]: {
    icon: CloudSun,
    description: "Current conditions and forecast.",
  },
  [TileIntegration.sports]: {
    icon: Trophy,
    description: "Live scores and schedules for your teams.",
  },
  [TileIntegration.sleeper]: {
    icon: Shirt,
    description: "Your fantasy matchups and scores.",
  },
  [TileIntegration.news]: {
    icon: Newspaper,
    description: "Latest headlines from your feeds.",
  },
  [TileIntegration.stocks]: {
    icon: TrendingUp,
    description: "Track stock and crypto prices.",
  },
  [TileIntegration.eightball]: {
    icon: CircleHelp,
    description: "Ask a yes/no question, get an answer.",
  },
  [TileIntegration.dice]: {
    icon: Dices,
    description: "Roll a handful of virtual dice.",
  },
  [TileIntegration.desktoplauncher]: {
    icon: MonitorUp,
    description: "Open an approved app on a paired computer.",
  },
  [TileIntegration.coinflip]: {
    icon: Coins,
    description: "Flip a coin: heads or tails.",
  },
  [TileIntegration.fortune]: {
    icon: Cookie,
    description: "A random fortune cookie message.",
  },
  [TileIntegration.tamagotchi]: {
    icon: PawPrint,
    description: "Care for a virtual pet.",
  },
  [TileIntegration.bonsai]: {
    icon: Sprout,
    description: "Grow and tend a living bonsai tree.",
  },
  [TileIntegration.aquarium]: {
    icon: Fish,
    description: "A live animated fish tank on your dashboard.",
  },
  [TileIntegration.visualizer]: {
    icon: AudioLines,
    description: "Live audio visualizer for the music player.",
  },
  [TileIntegration.pictureframe]: {
    icon: Images,
    description: "A photo slideshow from uploads, URLs, or albums.",
  },
  [TileIntegration.videoplayer]: {
    icon: MonitorPlay,
    description:
      "Play videos from uploads, URLs, YouTube, your library, or ErsatzTV live TV.",
  },
  [TileIntegration.aichat]: {
    icon: Bot,
    description: "Chat with OpenAI, Gemini, or Claude from your dashboard.",
  },
  [TileIntegration.note]: {
    icon: StickyNote,
    description: "A sticky note for reminders or lists.",
  },
  [TileIntegration.spacer]: {
    icon: SquareDashed,
    description: "An invisible gap to shape your layout.",
  },
  [TileIntegration.divider]: {
    icon: Heading,
    description: "A section heading to group tiles.",
  },
};

// Look up an integration's display metadata, falling back to the generic app
// shortcut look so a newly added integration always renders something.
export function integrationMeta(value: string): IntegrationMeta {
  return INTEGRATION_META[value] ?? INTEGRATION_META[NONE];
}

// Maps a tile integration value to the service-connection key whose
// reachability status applies to it. Only integrations backed by a saved
// connection appear here; everything else has no reachability to show.
export const INTEGRATION_SERVICE: Record<string, string> = {
  [TileIntegration.truenas]: "truenas",
  [TileIntegration.media]: "plex",
  [TileIntegration.sonarr]: "sonarr",
  [TileIntegration.radarr]: "radarr",
  [TileIntegration.qbittorrent]: "qbittorrent",
  [TileIntegration.pihole]: "pihole",
  [TileIntegration["nginx-proxy-manager"]]: "nginx-proxy-manager",
  [TileIntegration.lidarr]: "lidarr",
  [TileIntegration.prowlarr]: "prowlarr",
  [TileIntegration.pterodactyl]: "pterodactyl",
  [TileIntegration.tailscale]: "tailscale",
  [TileIntegration.ersatztv]: "ersatztv",
};

// Every integration whose tile depends on a saved service connection, mapped to
// its connection key and a friendly label. Broader than INTEGRATION_SERVICE
// (which only covers the integrations that surface a reachability badge): this
// is the full set that needs credentials before its tiles can load. Used after
// an import — exports never carry credentials — to tell the user which imported
// tiles still need their connection configured. Self-contained, ambiguous- and
// keyless-source integrations (audioplayer) are intentionally omitted.
export const CONNECTION_BACKED_INTEGRATIONS: Record<
  string,
  { service: string; label: string }
> = {
  [TileIntegration.truenas]: { service: "truenas", label: "TrueNAS" },
  [TileIntegration.media]: { service: "plex", label: "Plex" },
  [TileIntegration.jellyfin]: { service: "jellyfin", label: "Jellyfin" },
  [TileIntegration.sonarr]: { service: "sonarr", label: "Sonarr" },
  [TileIntegration.radarr]: { service: "radarr", label: "Radarr" },
  [TileIntegration.lidarr]: { service: "lidarr", label: "Lidarr" },
  [TileIntegration.qbittorrent]: { service: "qbittorrent", label: "qBittorrent" },
  [TileIntegration.pihole]: { service: "pihole", label: "Pi-hole" },
  [TileIntegration["nginx-proxy-manager"]]: {
    service: "nginx-proxy-manager",
    label: "Nginx Proxy Manager",
  },
  [TileIntegration.prowlarr]: { service: "prowlarr", label: "Prowlarr" },
  [TileIntegration.pterodactyl]: { service: "pterodactyl", label: "Pterodactyl" },
  [TileIntegration.tailscale]: { service: "tailscale", label: "Tailscale" },
  [TileIntegration.ersatztv]: { service: "ersatztv", label: "ErsatzTV" },
  [TileIntegration.stocks]: { service: "stocks", label: "Stocks" },
};
