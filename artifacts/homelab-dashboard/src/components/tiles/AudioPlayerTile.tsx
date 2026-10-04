import {
  useGetAudioPlayerNowPlaying,
  getGetAudioPlayerNowPlayingQueryKey,
  browseAudioLibrary,
  useSetAudioFavorite,
  ApiError,
} from "@workspace/api-client-react";
import type { AudioTrack, BrowseAudioLibrarySource } from "@workspace/api-client-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Music, Play, Pause, SkipBack, SkipForward, Volume2, Library, Dices, Heart } from "lucide-react";
import type { WidgetProps } from "./IntegrationTile";
import { useAudioPlayer } from "@/lib/audioPlayer";
import { tileBudget, SECTION_PX, MEDIA_ROW_PX } from "./metrics";
import { Artwork, fmtTime } from "./audioShared";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import MusicBrowser, { type MusicBrowserTarget } from "./MusicBrowser";
import SpotifyAudioPlayer from "./SpotifyAudioPlayer";

// Turn a failed favorite-write into a short, human-readable reason for the heart
// button's tooltip. The server returns the real upstream cause in the JSON
// `error` field (e.g. "HTTP 401: ..." when the source login expired, or "No plex
// connection is configured"); we prefer that and map the most common upstream
// status codes to friendlier phrasing so users can self-diagnose rather than
// blindly retrying.
function favoriteErrorMessage(err: unknown): string {
  const fallback = "Couldn’t update favorite — try again";
  let reason = "";
  if (err instanceof ApiError) {
    const data = err.data as { error?: unknown } | null;
    reason =
      (typeof data?.error === "string" && data.error.trim()) || err.message || "";
  } else if (err instanceof Error) {
    reason = err.message;
  }
  if (!reason) return fallback;

  // Authentication / permission failures from the upstream music source: the
  // saved login is no longer valid, so retrying won't help — reconnecting will.
  if (/\b(401|403)\b|unauthorized|forbidden/i.test(reason)) {
    return "Couldn’t update favorite — the music source login expired. Reconnect it in Settings.";
  }
  // No connection saved for this source.
  if (/no .* connection is configured/i.test(reason)) {
    return "Couldn’t update favorite — no music source is connected. Add one in Settings.";
  }

  return `Couldn’t update favorite — ${reason}`;
}

// Audio Player tile. Branches on the configured source: Spotify (OAuth + remote
// control / Web Playback SDK) renders a dedicated component, while Plex and
// Jellyfin (and the default) use the shared in-browser <audio> stream engine
// below.
export default function AudioPlayerTile(props: WidgetProps) {
  const source = (props.tileSettings?.audioSource as string | undefined) ?? "plex";
  if (source === "spotify") {
    return <SpotifyAudioPlayer {...props} />;
  }
  return <StreamAudioPlayer {...props} />;
}

function StreamAudioPlayer({ enabled, density, tileSettings }: WidgetProps) {
  const source =
    (tileSettings?.audioSource as "plex" | "jellyfin" | "subsonic" | undefined) ??
    "plex";
  const params = { source };
  const {
    data,
    isLoading,
    isError,
  } = useGetAudioPlayerNowPlaying(params, {
    query: {
      queryKey: getGetAudioPlayerNowPlayingQueryKey(params),
      refetchInterval: 15_000,
    },
  });

  // Each tile owns playback under a stable id derived from its source so the tile
  // can tell whether the global player is currently "its" stream.
  const ownerId = `audioplayer:${source}`;
  const player = useAudioPlayer();
  const isOurs = player.ownerId === ownerId && player.currentTrack != null;

  // Like / favorite toggling. The heart writes the favorite state on the linked
  // source (Plex rating, Subsonic star, Jellyfin favorite) and mirrors it in the
  // UI optimistically. The override is keyed by track id so it applies only to
  // the track the user acted on; a real track's `liked` field takes over again
  // when the queue advances. On failure we clear the override (reverting to the
  // server's real state) and surface an error affordance on the button.
  const queryClient = useQueryClient();
  const favoriteMutation = useSetAudioFavorite();
  const [likeOverride, setLikeOverride] = useState<{ id: string; liked: boolean } | null>(null);
  const [likeError, setLikeError] = useState<string | null>(null);

  // The pop-out music browser (search / browse / playlists) is only available
  // for the library sources that back it; its tabs are per-tile toggles that
  // default on when absent.
  const isLibrarySource = source === "plex" || source === "subsonic" || source === "jellyfin";
  const browserTabs = {
    search: (tileSettings?.audioSearch as boolean | undefined) ?? true,
    browse: (tileSettings?.audioBrowse as boolean | undefined) ?? true,
    playlists: (tileSettings?.audioPlaylists as boolean | undefined) ?? true,
  };
  const findMusicEnabled = (tileSettings?.audioFindMusic as boolean | undefined) ?? true;
  const showBrowser =
    isLibrarySource &&
    findMusicEnabled &&
    (browserTabs.search || browserTabs.browse || browserTabs.playlists);
  const [browserOpen, setBrowserOpen] = useState(false);
  // Deep-link target for the browser: set when the user clicks the now-playing
  // artist/album line, cleared when opening via the plain "Find music" button.
  const [browserTarget, setBrowserTarget] = useState<MusicBrowserTarget | null>(null);
  const openBrowser = (target: MusicBrowserTarget | null = null) => {
    setBrowserTarget(target);
    setBrowserOpen(true);
  };

  // The "dice" button pulls ~20 random tracks from the configured library and
  // appends them to the queue (starting playback when idle). It rides alongside
  // "Find music" and is available for the same library-backed sources.
  const showDice = isLibrarySource;
  const [shuffling, setShuffling] = useState(false);
  const shuffleRandom = async () => {
    if (shuffling) return;
    setShuffling(true);
    try {
      const result = await browseAudioLibrary({
        source: source as BrowseAudioLibrarySource,
        kind: "random",
      });
      const tracks = (result.tracks ?? []).filter((t) => Boolean(t.streamUrl));
      // Demo / unconfigured payloads carry no streamUrl — nothing to play, but
      // the interaction still completes without error (button just re-enables).
      // Each dice click replaces the current queue with a fresh random session
      // starting from track 1, so repeated clicks always produce a visible change.
      if (tracks.length > 0) player.playQueue(tracks, 0, ownerId);
    } catch {
      // Unreachable source: swallow so the tile never breaks; button re-enables.
    } finally {
      setShuffling(false);
    }
  };

  const diceButton = (props: { className: string }) =>
    showDice ? (
      <button
        type="button"
        onClick={shuffleRandom}
        disabled={shuffling}
        className={props.className}
        aria-label="Shuffle 20 random songs into the queue"
        title="Shuffle 20 random songs"
      >
        <Dices size={14} aria-hidden="true" className={shuffling ? "animate-pulse" : undefined} />
      </button>
    ) : null;

  const browserNode = showBrowser ? (
    <MusicBrowser
      source={source as "plex" | "subsonic" | "jellyfin"}
      ownerId={ownerId}
      tabs={browserTabs}
      open={browserOpen}
      onOpenChange={setBrowserOpen}
      target={browserTarget}
    />
  ) : null;

  if (isLoading && !data) {
    return (
      <div className="flex h-full items-center justify-center p-3 text-xs text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="flex h-full items-center justify-center p-3 text-xs text-destructive">
        Couldn’t reach the music source.
      </div>
    );
  }

  const backendNowPlaying = data?.nowPlaying ?? null;
  const backendQueue = data?.queue ?? [];
  const sample = data?.sample ?? false;

  // The displayed track: prefer the global player's live track when this tile
  // owns it (so play/seek reflect immediately), else the backend's now-playing.
  const displayTrack: AudioTrack | null = isOurs ? player.currentTrack : backendNowPlaying;

  if (!displayTrack) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-xs text-muted-foreground">
        <Music size={20} aria-hidden="true" />
        <span>Nothing playing</span>
        <div className="flex items-center gap-1.5">
          {showBrowser && (
            <button
              type="button"
              onClick={() => openBrowser()}
              className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-foreground transition-colors hover:bg-muted"
            >
              <Library size={13} aria-hidden="true" /> Find music
            </button>
          )}
          {diceButton({
            className:
              "flex items-center justify-center rounded-full border border-border p-1.5 text-foreground transition-colors hover:bg-muted disabled:opacity-50",
          })}
        </div>
        {browserNode}
      </div>
    );
  }

  // When this tile owns playback, the live player queue (loaded via Find Music or
  // an earlier start) is authoritative for now-playing and up-next; otherwise we
  // fall back to the backend's reported session queue.
  const activeQueue = isOurs ? player.queue : backendQueue;

  // Tracks are streamable only when they carry a streamUrl (real source, not the
  // demo payload). Demo/sample data shows now-playing but disables controls.
  const canStream = activeQueue.some((t) => Boolean(t.streamUrl));

  // Progress + duration: from the live player when we own playback, else from the
  // backend's reported session (remote Plex session) when present.
  const liveDuration = isOurs ? player.duration : (displayTrack.durationMs ?? 0) / 1000;
  const liveCurrent = isOurs
    ? player.currentTime
    : (displayTrack.progressMs ?? 0) / 1000;
  const pct = liveDuration > 0 ? Math.min(100, (liveCurrent / liveDuration) * 100) : 0;

  const isPlaying = isOurs ? player.isPlaying : displayTrack.state === "playing";

  // Build the vertical reveal budget so a small tile shows just artwork + title,
  // and a taller tile reveals progress, controls and the up-next queue in order.
  const budget = tileBudget(density);
  const showArtwork = enabled.has("artwork");
  const artSize = density.level === "sm" ? 40 : density.level === "md" ? 56 : 72;

  // The header block (artwork + track info) is always shown — it is the point of
  // the tile. Remaining metrics compete for the leftover budget in priority order.
  budget.block(Math.max(artSize, 44));
  const showProgress = enabled.has("progress") && budget.block(18);
  const showControls = enabled.has("controls") && budget.block(40);

  // Up-next: when we own playback, the tracks after the live index; otherwise the
  // backend session queue minus the now-playing track.
  const restQueue = isOurs
    ? player.queue.slice(player.index + 1)
    : backendQueue.filter((t) => t.id !== displayTrack.id);
  // Cap the queue at 20 rows so a huge queue never renders hundreds of items
  // (which slows the page) and the "Up Next" list stays a manageable preview.
  const queueRows = enabled.has("queue")
    ? // The expanded/scrollable body shows the whole queue.
      Math.min(budget.list(SECTION_PX, MEDIA_ROW_PX, restQueue.length), density.scrollable ? restQueue.length : 20)
    : 0;

  const startPlayback = (startId: string) => {
    if (!canStream) return;
    const startIndex = activeQueue.findIndex((t) => t.id === startId);
    player.playQueue(activeQueue, startIndex < 0 ? 0 : startIndex, ownerId);
  };

  const onTogglePlay = () => {
    if (!canStream) return;
    if (isOurs) {
      player.togglePlay();
    } else {
      startPlayback(displayTrack.id);
    }
  };

  // Effective like state: the pending optimistic value for this exact track wins,
  // otherwise the track's server-reported `liked` (null → treated as not liked).
  const likedState =
    likeOverride && likeOverride.id === displayTrack.id
      ? likeOverride.liked
      : displayTrack.liked ?? false;

  const toggleLike = async () => {
    // Demo payloads have no real backend to write to; skip.
    if (sample || favoriteMutation.isPending) return;
    const next = !likedState;
    setLikeOverride({ id: displayTrack.id, liked: next });
    setLikeError(null);
    try {
      await favoriteMutation.mutateAsync({
        data: { source, id: displayTrack.id, liked: next },
      });
      // Re-pull now-playing so the confirmed server state backs the UI.
      await queryClient.invalidateQueries({
        queryKey: getGetAudioPlayerNowPlayingQueryKey(params),
      });
    } catch (err) {
      // Revert to the real state and surface the actual reason on the button so
      // the user can self-diagnose (auth expired vs. server rejected) instead of
      // blindly retrying.
      setLikeOverride(null);
      setLikeError(favoriteErrorMessage(err));
    }
  };

  const seekFromClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isOurs || liveDuration <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    player.seek(ratio * liveDuration);
  };

  // Width gating for the absolutely-positioned side elements of the playback
  // controls row. The centered transport cluster (prev 18px + gap 12 + play 32
  // + gap 12 + next 18) is ~92px wide, so each side element must fit inside
  // (rowWidth / 2 − 46px) where rowWidth is the measured body width minus the
  // root's p-3 padding (24px).
  //   • Volume is a single ~28px round button that opens a pop-out slider
  //     (portalled, so it can never collide with anything in the row); the
  //     button itself needs only ~36px of side room → body ≥ ~200px.
  //   • The "Find music" pill (two ~28px round buttons + 6px gap ≈ 62px)
  //     needs ≥ ~260px and otherwise falls back to the open top-right corner
  //     of the now-playing header.
  // Because each element only occupies its own half of the row, the two
  // thresholds are independent — whenever both are visible, neither can reach
  // the centered transport buttons, let alone each other.
  const VOLUME_MIN_BODY_WIDTH = 200;
  const PILL_MIN_BODY_WIDTH = 260;
  const volumeShown = density.bodyWidth >= VOLUME_MIN_BODY_WIDTH;
  const controlsRowFits = density.bodyWidth >= PILL_MIN_BODY_WIDTH;
  const pillAtControls = showBrowser && showControls && controlsRowFits;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {/* Now playing: artwork + title/artist */}
      <div className="flex items-center gap-3">
        {showArtwork && <Artwork track={displayTrack} size={artSize} />}
        <div className="min-w-0 flex-1">
          {enabled.has("trackInfo") ? (
            <>
              <div className="truncate text-sm font-medium" title={displayTrack.title}>
                {displayTrack.title}
              </div>
              {displayTrack.artist &&
                (showBrowser && displayTrack.artistId ? (
                  <button
                    type="button"
                    onClick={() =>
                      openBrowser({
                        kind: "artist",
                        id: displayTrack.artistId!,
                        title: displayTrack.artist!,
                      })
                    }
                    className="block max-w-full truncate text-left text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
                    title={`Browse ${displayTrack.artist}`}
                  >
                    {displayTrack.artist}
                  </button>
                ) : (
                  <div className="truncate text-xs text-muted-foreground" title={displayTrack.artist}>
                    {displayTrack.artist}
                  </div>
                ))}
              {displayTrack.album &&
                density.level !== "sm" &&
                (showBrowser && displayTrack.albumId ? (
                  <button
                    type="button"
                    onClick={() =>
                      openBrowser({
                        kind: "album",
                        id: displayTrack.albumId!,
                        title: displayTrack.album!,
                      })
                    }
                    className="block max-w-full truncate text-left text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground hover:underline"
                    title={`Browse ${displayTrack.album}`}
                  >
                    {displayTrack.album}
                  </button>
                ) : (
                  <div className="truncate text-[11px] text-muted-foreground/80" title={displayTrack.album}>
                    {displayTrack.album}
                  </div>
                ))}
            </>
          ) : (
            <div className="truncate text-sm font-medium" title={displayTrack.title}>
              {displayTrack.title}
            </div>
          )}
          {sample && (
            <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/70">
              Demo
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={toggleLike}
            disabled={sample || favoriteMutation.isPending}
            className={`flex items-center justify-center rounded-full border p-1.5 transition-colors disabled:opacity-50 ${
              likeError
                ? "border-destructive text-destructive hover:bg-destructive/10"
                : likedState
                  ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                  : "border-border text-foreground hover:bg-muted"
            }`}
            aria-label={likedState ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={likedState}
            title={likeError ?? (likedState ? "Liked" : "Like")}
          >
            <Heart
              size={14}
              aria-hidden="true"
              className={likedState ? "fill-current" : undefined}
            />
          </button>
          {!pillAtControls && showBrowser && (
            <button
              type="button"
              onClick={() => openBrowser()}
              className="flex items-center justify-center rounded-full border border-border p-1.5 text-foreground transition-colors hover:bg-muted"
              aria-label="Find music"
              title="Find music"
            >
              <Library size={14} aria-hidden="true" />
            </button>
          )}
          {!pillAtControls &&
            diceButton({
              className:
                "flex items-center justify-center rounded-full border border-border p-1.5 text-foreground transition-colors hover:bg-muted disabled:opacity-50",
            })}
        </div>
      </div>

      {/* Progress bar */}
      {showProgress && (
        <div>
          <div
            className={`h-1.5 w-full overflow-hidden rounded-full bg-muted ${isOurs ? "cursor-pointer" : ""}`}
            onClick={seekFromClick}
            role="presentation"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
            <span>{fmtTime(liveCurrent, "s")}</span>
            <span>{fmtTime(liveDuration, "s")}</span>
          </div>
        </div>
      )}

      {/* Playback controls */}
      {showControls && (
        <div className="relative flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => isOurs && player.prev()}
            disabled={!canStream || !isOurs}
            className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            aria-label="Previous track"
          >
            <SkipBack size={18} />
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={!canStream}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
          </button>
          <button
            type="button"
            onClick={() => isOurs && player.next()}
            disabled={!canStream || !isOurs}
            className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
            aria-label="Next track"
          >
            <SkipForward size={18} />
          </button>
          {volumeShown && (
            <div className="absolute right-0">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center justify-center rounded-full border border-border p-1.5 text-foreground transition-colors hover:bg-muted"
                    aria-label="Volume"
                    title="Volume"
                  >
                    <Volume2 size={14} aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="end" className="w-auto p-3">
                  <div className="flex items-center gap-2">
                    <Volume2 size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={player.volume}
                      onChange={(e) => player.setVolume(Number(e.target.value))}
                      className="h-1 w-28 cursor-pointer accent-primary"
                      aria-label="Volume level"
                    />
                    <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                      {Math.round(player.volume * 100)}%
                    </span>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          )}
          {pillAtControls && (
            <div className="absolute left-0 flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => openBrowser()}
                className="flex items-center justify-center rounded-full border border-border p-1.5 text-foreground transition-colors hover:bg-muted"
                aria-label="Find music"
                title="Find music"
              >
                <Library size={14} aria-hidden="true" />
              </button>
              {diceButton({
                className:
                  "flex items-center justify-center rounded-full border border-border p-1.5 text-foreground transition-colors hover:bg-muted disabled:opacity-50",
              })}
            </div>
          )}
        </div>
      )}

      {/* Up next queue */}
      {queueRows > 0 && (
        <div className="min-h-0 flex-1">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Up Next
          </div>
          <div
            className="space-y-1 overflow-y-auto"
            style={{ maxHeight: queueRows * (MEDIA_ROW_PX + 4) }}
          >
            {restQueue.slice(0, queueRows).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => startPlayback(t.id)}
                disabled={!canStream}
                className="flex w-full items-center gap-2 rounded text-left transition-colors hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <Artwork track={t} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs" title={t.title}>
                    {t.title}
                  </div>
                  {t.artist && (
                    <div className="truncate text-[11px] text-muted-foreground" title={t.artist}>
                      {t.artist}
                    </div>
                  )}
                </div>
                {t.durationMs != null && (
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {fmtTime(t.durationMs, "ms")}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      {browserNode}
    </div>
  );
}
