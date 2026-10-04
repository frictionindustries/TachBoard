import React, { useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import { TachLogo } from "@/components/TachLogo";
import { useLocation } from "wouter";
import GridLayout from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import {
  useGetMe,
  useGetTiles,
  useSaveLayout,
  useCreateTile,
  useGetConnectionsStatus,
  useGetPages,
  useCreatePage,
  useUpdatePage,
  useDeletePage,
  useReorderPages,
  useImportPages,
  useGetDeviceModes,
  useCreateDeviceMode,
  useUpdateDeviceMode,
  useDeleteDeviceMode,
  useGetPageLayouts,
  useCopyPageLayout,
  exportPage,
  exportAllPages,
  getGetMeQueryKey,
  getGetTilesQueryKey,
  getGetPagesQueryKey,
  getGetConnectionsStatusQueryKey,
  getGetDeviceModesQueryKey,
  getGetPageLayoutsQueryKey,
  TileType,
  type Tile,
  type Page,
  type PageInput,
  type PageExport,
  type ServiceStatus,
  type DeviceMode,
  type GetTilesParams,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useHealthAlerts } from "@/hooks/use-health-alerts";
import AppTile from "@/components/tiles/AppTile";
import IntegrationTile, { INTEGRATION_LABELS } from "@/components/tiles/IntegrationTile";
import { TileExpansionHost, TileExpansionProvider } from "@/components/tiles/expansion";
import NoteTile from "@/components/tiles/NoteTile";
import TimerTile from "@/components/tiles/TimerTile";
import TamagotchiTile from "@/components/tiles/TamagotchiTile";
import BonsaiTile from "@/components/tiles/BonsaiTile";
import AquariumTile from "@/components/tiles/AquariumTile";
import VisualizerTile from "@/components/tiles/VisualizerTile";
import PictureFrameTile from "@/components/tiles/PictureFrameTile";
import VideoPlayerTile from "@/components/tiles/VideoPlayerTile";
import { PageTilesContext } from "@/components/tiles/pageTiles";
import AiChatTile from "@/components/tiles/AiChatTile";
import TileEditModal, { type EditMode } from "@/components/TileEditModal";
import { INTEGRATION_SERVICE, CONNECTION_BACKED_INTEGRATIONS } from "@/lib/integrationMeta";
import { ToastAction } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LayoutGrid,
  Plus,
  LogOut,
  Lock,
  Unlock,
  ChevronDown,
  Pencil,
  Check,
  Loader2,
  SeparatorHorizontal,
  Heading,
  Settings as SettingsIcon,
  ChevronLeft,
  ChevronRight,
  X,
  Trash2,
  Download,
  Upload,
  MonitorSmartphone,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

// react-grid-layout's TS types omit some valid props (cols, margin, containerPadding)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Grid = GridLayout as React.ComponentType<any>;

const ROW_HEIGHT = 40;
const GRID_MARGIN = 12;
// Fixed per-column footprint (column width + one margin) that matches the
// established grid resolution (24 cols at ~1536px). Holding this constant keeps
// every tile the same visual size while the number of columns scales with the
// available width — a wider screen exposes more placeable columns instead of
// stretching the existing ones. With react-grid-layout's containerPadding=[0,0]
// the rendered column width is (width - margin*(cols-1))/cols, so solving for a
// target column width gives cols = (width + margin) / (colWidth + margin).
const COL_WIDTH = 51;
const MIN_COLS = 12;

function colsForWidth(width: number): number {
  return Math.max(
    MIN_COLS,
    Math.round((width + GRID_MARGIN) / (COL_WIDTH + GRID_MARGIN)),
  );
}

// Fixed scale presets. "auto" keeps the responsive (window-width-driven) column
// count. Every other preset locks the page to a fixed column count chosen to
// echo a target screen resolution, so a denser preset (uhd) fits more tiles and
// a lighter one (compact) fewer. The whole grid is then CSS-scaled to fit the
// viewport, so tiles keep their relative positions and never reflow on resize.
const PRESET_COLS: Record<string, number> = {
  compact: 18,
  fhd: 24,
  qhd: 32,
  uhd: 48,
};

// Human-friendly labels for the layout dropdown.
const PRESET_LABEL: Record<string, string> = {
  auto: "Auto / responsive",
  adaptive: "Adaptive",
  compact: "Compact",
  fhd: "1080p",
  qhd: "2K",
  uhd: "4K",
};
const PRESET_ORDER = ["auto", "adaptive", "compact", "fhd", "qhd", "uhd"] as const;

// ---- Adaptive pages -------------------------------------------------------
// An "adaptive" page auto-resolves a fixed scale preset + orientation from the
// current viewport and keeps an independently saved layout per resolved
// (preset, orientation) pair — the "variant". Variant keys look like
// "fhd-landscape". Auto/fixed pages always use the base layout (variant null).

// ---- Portrait (vertical) tiers --------------------------------------------
// A vertical screen's grid must be shaped by its WIDTH (the short side), not by
// the landscape column count — otherwise a 1080×1920 portrait page renders a
// 24-column landscape-wide grid that just gets shrunk to fit the height.
// Portrait widths cluster tightly (1080p and 2K portrait are ~1080–1440px
// wide), so vertical mode offers a simplified two-tier set instead of
// mirroring all four landscape presets:
//   - "fhd"  → Standard vertical (~1080–1440px wide screens), 14 columns
//   - "uhd"  → 4K vertical (~2160px wide), 27 columns
// Column counts keep the landscape px-per-column density: fhd landscape is
// 24 cols per 1920px (~80px/col), so 1080px wide ≈ 14 cols and 2160px ≈ 27.
const PORTRAIT_COLS: Record<string, number> = {
  fhd: 14,
  uhd: 27,
};

// Labels shown for the vertical tiers wherever a portrait preset/variant is
// displayed. Landscape labels stay in PRESET_LABEL, unchanged.
const PORTRAIT_PRESET_LABEL: Record<string, string> = {
  fhd: "Standard",
  uhd: "4K",
};
const PORTRAIT_PRESET_ORDER = ["fhd", "uhd"] as const;

// Collapse any legacy preset onto its simplified vertical tier. compact/fhd/qhd
// portrait all had near-identical real widths, so they map to the "fhd"
// (Standard) tier; uhd keeps its own denser tier. This is also the back-compat
// seam: previously saved "compact-portrait"/"qhd-portrait" variant keys resolve
// to "fhd-portrait" (the server migrates stored tile rows the same way).
function canonicalPortraitPreset(preset: string): string {
  return preset === "uhd" ? "uhd" : "fhd";
}

// The column count for a preset in a given orientation. Landscape uses the
// original PRESET_COLS (unchanged); portrait uses the simplified vertical tiers.
function colsForPreset(preset: string, orientation: string): number {
  if (orientation === "portrait") {
    return PORTRAIT_COLS[canonicalPortraitPreset(preset)] ?? PORTRAIT_COLS["fhd"]!;
  }
  return PRESET_COLS[preset] ?? MIN_COLS;
}

// Width breakpoints (CSS px) that pick the fixed preset an adaptive page
// resolves to. Chosen to sit between the widths the presets echo (compact
// ~<1400, 1080p ~1920, 2K ~2560, 4K ~3840).
function resolveAdaptive(width: number, height: number): {
  preset: string;
  orientation: string;
} {
  const orientation = height > width ? "portrait" : "landscape";
  if (orientation === "portrait") {
    // Vertical screens resolve to the simplified portrait tiers by their WIDTH
    // (the short side): a ~2160px-wide 4K portrait panel gets the dense tier,
    // everything narrower (1080p/2K portrait, both ~1080–1440px wide) gets the
    // Standard tier.
    const preset = width >= 1800 ? "uhd" : "fhd";
    return { preset, orientation };
  }
  const preset =
    width >= 3200 ? "uhd" : width >= 2240 ? "qhd" : width >= 1600 ? "fhd" : "compact";
  return { preset, orientation };
}

function variantKey(preset: string, orientation: string): string {
  // Portrait variant keys are always canonical simplified tiers, so legacy
  // presets never create (or read) a non-canonical portrait scope.
  const p = orientation === "portrait" ? canonicalPortraitPreset(preset) : preset;
  return `${p}-${orientation}`;
}

// Human label for a variant key, e.g. "fhd-landscape" → "1080p · Landscape",
// "fhd-portrait" → "Standard · Vertical".
function variantLabel(variant: string | null | undefined): string {
  if (!variant) return "Base layout";
  const [p, o] = variant.split("-");
  const portrait = o === "portrait";
  const preset = portrait
    ? (PORTRAIT_PRESET_LABEL[canonicalPortraitPreset(p ?? "")] ?? p ?? "?")
    : (PRESET_LABEL[p ?? ""] ?? p ?? "?");
  return `${preset} · ${portrait ? "Vertical" : "Landscape"}`;
}

// A page is locked to a fixed layout when its preset is a known non-auto preset.
function isFixedPreset(preset: string | undefined): boolean {
  return preset !== undefined && preset !== "auto" && preset in PRESET_COLS;
}

// The intrinsic (unscaled) pixel width of a grid rendered at `cols` columns,
// using the same per-column footprint react-grid-layout derives from width when
// containerPadding is [0,0]: width = colWidth*cols + margin*(cols-1).
function intrinsicGridWidth(cols: number): number {
  return COL_WIDTH * cols + GRID_MARGIN * (cols - 1);
}

function tileToLayout(tile: Tile) {
  return {
    i: String(tile.id),
    x: tile.gridX,
    y: tile.gridY,
    w: tile.gridW,
    h: tile.gridH,
    minW: 1,
    minH: 1,
  };
}

// Scan the grid row by row, column by column for the first rectangular slot of
// size (w × h) that is fully unoccupied by existing tiles. Returns {x, y} of the
// first free slot, or {x: 0, y: maxY} (below every existing tile) as a safe
// fallback if nothing fits within the scan depth.
function findFirstEmptyPosition(
  existing: Pick<Tile, "gridX" | "gridY" | "gridW" | "gridH">[],
  w: number,
  h: number,
  cols: number,
): { x: number; y: number } {
  const maxX = Math.max(0, cols - w);
  const maxY = existing.reduce((acc, t) => Math.max(acc, t.gridY + t.gridH), 0);

  const overlaps = (x: number, y: number): boolean =>
    existing.some(
      (t) =>
        x < t.gridX + t.gridW &&
        x + w > t.gridX &&
        y < t.gridY + t.gridH &&
        y + h > t.gridY,
    );

  // Scan one row past the current content so a slot just below also gets found.
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      if (!overlaps(x, y)) return { x, y };
    }
  }

  return { x: 0, y: maxY };
}

// Maps a tile's integration to the saved connection it pings. Plain app/link
// tiles (no integration) have no backing service and so get no reachability dot.
function renderTileContent(tile: Tile, status: ServiceStatus | undefined, editMode: boolean) {
  // The spacer is a layout-only tile: an invisible gap. In locked mode it
  // renders nothing at all; in edit mode it shows a dashed ghost so users can
  // find, move, resize, or delete it.
  if (tile.integration === "spacer") {
    if (!editMode) return null;
    return (
      <div className="absolute inset-0 flex items-center justify-center border-2 border-dashed border-primary/40 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        Spacer
      </div>
    );
  }
  // The divider is a layout-only tile: a low-profile section heading users drop
  // between groups of tiles. It shows its label as styled text (no card
  // surface) and stays visible in both locked and edit modes.
  if (tile.integration === "divider") {
    return (
      <div className="absolute inset-0 flex items-center px-1">
        <span className="text-sm font-bold uppercase tracking-widest text-muted-foreground truncate">
          {tile.name || "Section"}
        </span>
      </div>
    );
  }
  // The note is a post-it tile: its content is created and edited in-place by
  // the user (no backing service). It renders its own colored surface, bypassing
  // the standard integration header.
  if (tile.integration === "note") {
    return <NoteTile tile={tile} editMode={editMode} />;
  }
  // The timer is a client-side stopwatch/countdown tile. Its run state is
  // operated in-place on the tile (Start/Pause/Reset) and persisted back via
  // the tile-update flow, so it manages its own surface like the note.
  if (tile.integration === "timer") {
    return <TimerTile tile={tile} editMode={editMode} />;
  }
  // The Tamagotchi is a self-contained virtual-pet toy. Its living state
  // (hunger/happiness/energy) decays over real time and is cared for in-place on
  // the tile, so it paints its own surface and persists like the note/timer,
  // bypassing the standard integration header.
  if (tile.integration === "tamagotchi") {
    return <TamagotchiTile tile={tile} editMode={editMode} />;
  }
  // The Bonsai is a self-contained living-plant toy. Its hydration, overgrowth
  // and growth-stage state changes over real time and is tended in-place on the
  // tile (Water/Prune), so it paints its own surface and persists like the
  // tamagotchi/note/timer, bypassing the standard integration header.
  if (tile.integration === "bonsai") {
    return <BonsaiTile tile={tile} editMode={editMode} />;
  }
  // The Aquarium is a self-contained animated toy: fish idle-swim across a
  // full-tile tank whose population scales with the tile's rendered size. It
  // paints its own surface like the bonsai/tamagotchi, bypassing the standard
  // integration header.
  if (tile.integration === "aquarium") {
    return <AquariumTile tile={tile} editMode={editMode} />;
  }
  // The Audio Visualizer is a self-contained toy that taps the app's own audio
  // player and paints a live, sound-reactive canvas (bars / lava lamp / VU
  // meter), or a calm idle animation when nothing is playing. It renders its own
  // surface like the bonsai/tamagotchi, bypassing the integration header.
  if (tile.integration === "visualizer") {
    return <VisualizerTile tile={tile} editMode={editMode} />;
  }
  // The Picture Frame is a self-contained photo slideshow: it paints photos
  // edge-to-edge across the whole tile (with an optional decorative frame),
  // bypassing the standard integration header like the aquarium/visualizer.
  if (tile.integration === "pictureframe") {
    return <PictureFrameTile tile={tile} editMode={editMode} />;
  }
  // The Video Player paints a full-surface video (uploads, URLs, YouTube, or a
  // Plex/Jellyfin library — yule log when unconfigured), bypassing the
  // standard integration header like the picture frame.
  if (tile.integration === "videoplayer") {
    return <VideoPlayerTile tile={tile} editMode={editMode} />;
  }
  // The AI Chat tile owns its whole surface (conversation + input) and keeps
  // its history per tile, bypassing the standard integration header.
  if (tile.integration === "aichat") {
    return <AiChatTile tile={tile} editMode={editMode} />;
  }
  // Every tile renders as a styled app/link card. When an integration is
  // attached it also shows a compact live-status section from that service.
  if (tile.integration) {
    return <IntegrationTile tile={tile} status={status} editMode={editMode} />;
  }
  return <AppTile tile={tile} />;
}

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editMode, setEditMode] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedTile, setSelectedTile] = useState<Tile | undefined>(undefined);
  const [modalMode, setModalMode] = useState<EditMode>("create");
  // Grid slot a newly-created tile should occupy, computed at the moment the
  // create modal opens so the tile lands in the first empty cell instead of
  // stacking at (0, 0).
  const [createGridPos, setCreateGridPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  // null until the real container width is measured. Gating the grid render on
  // a measured width (instead of starting from a hard-coded guess) keeps the
  // column count correct on the very first paint, so saved tile positions are
  // never compacted out of bounds on a hard refresh.
  const [gridWidth, setGridWidth] = useState<number | null>(null);
  // Pixel offset of the "fold" (viewport bottom) from the grid container's
  // top. Used only for the edit-mode dotted safe-zone guide.
  const [foldOffset, setFoldOffset] = useState<number | null>(null);
  // The unscaled (intrinsic) height of the fixed-preset grid, measured after
  // render. Transforms don't change offsetHeight, so this stays the true size
  // even while a scale transform is applied.
  const [intrinsicHeight, setIntrinsicHeight] = useState<number | null>(null);
  // Ref to the inner (unscaled) wrapper around the grid so its natural height
  // can be measured for the scale computation.
  const scaleInnerRef = useRef<HTMLDivElement>(null);

  // The currently-shown page. null until pages load / are reconciled below.
  // Persisted to localStorage so the active page survives reloads.
  const [activePageId, setActivePageId] = useState<number | null>(() => {
    const stored = localStorage.getItem("activePageId");
    const n = stored ? parseInt(stored, 10) : NaN;
    return Number.isNaN(n) ? null : n;
  });
  // The device mode this browser shows. Persisted so a PC and a wall tablet can
  // each remember their own mode. null until modes load / are reconciled.
  const [activeDeviceModeId, setActiveDeviceModeId] = useState<number | null>(() => {
    const stored = localStorage.getItem("activeDeviceModeId");
    const n = stored ? parseInt(stored, 10) : NaN;
    return Number.isNaN(n) ? null : n;
  });
  // Dialog state for creating/renaming a device mode, plus its name draft.
  const [modeDialog, setModeDialog] = useState<null | { kind: "create" | "rename" }>(null);
  const [modeNameDraft, setModeNameDraft] = useState("");
  // Device mode queued for deletion; drives the confirm dialog.
  const [modePendingDelete, setModePendingDelete] = useState<DeviceMode | null>(null);
  // Viewport-resolved scale for adaptive pages, re-resolved on resize.
  const [adaptiveResolved, setAdaptiveResolved] = useState(() =>
    resolveAdaptive(window.innerWidth, window.innerHeight),
  );
  // While editing an adaptive page the user can pin a specific variant to work
  // on (instead of the one the current screen resolves to). null = follow the
  // screen. Cleared when leaving edit mode or switching pages.
  const [editVariantOverride, setEditVariantOverride] = useState<string | null>(null);

  // Page id whose name is being edited inline (edit mode only), plus its draft.
  const [renamingPageId, setRenamingPageId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Page queued for deletion; drives the confirm dialog.
  const [pagePendingDelete, setPagePendingDelete] = useState<Page | null>(null);
  // Copy-layout source queued for confirmation because the current layout
  // already has tiles that the copy would replace.
  const [copyPendingReplace, setCopyPendingReplace] = useState<{
    deviceModeId: number | null;
    variant: string | null;
    tileCount: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSaved, setShowSaved] = useState(false);
  // Hidden file input that backs the "Import page" action.
  const importInputRef = useRef<HTMLInputElement>(null);

  // Measure container width for the non-responsive GridLayout. useLayoutEffect
  // measures synchronously before the browser paints, so the grid's first paint
  // already uses the true width (and therefore the correct column count).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w) setGridWidth(w);
      // Fold offset within the container: how many pixels from the container's
      // top fit in the viewport without scrolling. Computed against the
      // container's absolute document position so it stays correct even if the
      // user has scrolled when a resize fires. Drives the edit-mode safe-zone
      // guide line (purely advisory — content may extend past it and scroll).
      const absTop = el.getBoundingClientRect().top + window.scrollY;
      const fold = window.innerHeight - absTop;
      setFoldOffset(fold > 0 ? fold : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The container's width changes are caught by the ResizeObserver, but a pure
    // viewport-height change (window shorter, no width change) is not — so also
    // remeasure on window resize to keep the fold-guide offset current.
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const { data: me, isError: meError } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });

  // Redirect to login on auth failure (TanStack Query v5 removed onError from query options)
  useEffect(() => {
    if (meError) setLocation("/login");
  }, [meError, setLocation]);

  const { data: pages = [] } = useGetPages({
    query: { queryKey: getGetPagesQueryKey(), enabled: Boolean(me) },
  });

  // Reconcile the active page against the loaded list: keep the persisted page
  // when it still exists, otherwise fall back to the first page. Runs whenever
  // pages change (e.g. after a delete removes the active page).
  useEffect(() => {
    if (pages.length === 0) return;
    setActivePageId((current) => {
      if (current != null && pages.some((p) => p.id === current)) return current;
      return pages[0]!.id;
    });
  }, [pages]);

  // Persist the active page so a reload reopens it.
  useEffect(() => {
    if (activePageId != null) localStorage.setItem("activePageId", String(activePageId));
  }, [activePageId]);

  // Device modes: switchable layout profiles (e.g. "PC", "Phone"). Every user
  // has at least one; each keeps an independent set of tiles per page.
  const { data: deviceModes = [] } = useGetDeviceModes({
    query: { queryKey: getGetDeviceModesQueryKey(), enabled: Boolean(me) },
  });

  // Reconcile the active mode against the loaded list (mirrors the page logic).
  useEffect(() => {
    if (deviceModes.length === 0) return;
    setActiveDeviceModeId((current) => {
      if (current != null && deviceModes.some((m) => m.id === current)) return current;
      return deviceModes[0]!.id;
    });
  }, [deviceModes]);

  // Persist the active mode so this browser reopens in the same profile.
  useEffect(() => {
    if (activeDeviceModeId != null) {
      localStorage.setItem("activeDeviceModeId", String(activeDeviceModeId));
    }
  }, [activeDeviceModeId]);

  // Re-resolve the adaptive scale whenever the viewport changes.
  useEffect(() => {
    const onResize = () =>
      setAdaptiveResolved((prev) => {
        const next = resolveAdaptive(window.innerWidth, window.innerHeight);
        return next.preset === prev.preset && next.orientation === prev.orientation
          ? prev
          : next;
      });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Resolve the active page + its scale settings early: the tile query below is
  // scoped by the adaptive variant, which depends on the page's preset.
  const activePage = pages.find((p) => p.id === activePageId) ?? null;
  const preset = activePage?.layoutPreset ?? "auto";
  const orientation = activePage?.layoutOrientation ?? "landscape";
  const isAdaptive = preset === "adaptive";

  // The layout variant currently shown. Only adaptive pages use variants; in
  // edit mode a pinned variant (the edit-mode switcher) wins over the one the
  // screen resolves to.
  const activeVariant = isAdaptive
    ? editMode && editVariantOverride
      ? editVariantOverride
      : variantKey(adaptiveResolved.preset, adaptiveResolved.orientation)
    : null;

  // Tile query params: page + device mode always; variant only for adaptive
  // pages. One shared object so the query key and cache writes always agree.
  const tilesParams: GetTilesParams | undefined =
    activePageId != null && activeDeviceModeId != null
      ? {
          pageId: activePageId,
          deviceModeId: activeDeviceModeId,
          ...(activeVariant != null ? { variant: activeVariant } : {}),
        }
      : undefined;

  const { data: tiles = [], isLoading } = useGetTiles(tilesParams, {
    query: {
      queryKey: getGetTilesQueryKey(tilesParams),
      enabled: Boolean(me) && tilesParams !== undefined,
    },
  });

  // Poll service reachability so each live-widget tile shows an up/down badge.
  // Refetches on a timer and whenever the dashboard regains focus (e.g. after
  // saving a connection in Settings).
  const { data: statuses } = useGetConnectionsStatus({
    query: {
      queryKey: getGetConnectionsStatusQueryKey(),
      enabled: Boolean(me),
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
    },
  });

  const statusByService = new Map((statuses ?? []).map((s) => [s.service, s]));

  // Surface a toast whenever a previously-healthy service goes unreachable.
  useHealthAlerts(Boolean(me));

  // Query key for the active (page, device mode, variant) tile scope. All cache
  // reads/writes for tiles go through this so each scope keeps its own
  // independently-cached tile list.
  const tilesQueryKey = getGetTilesQueryKey(tilesParams);

  const saveLayout = useSaveLayout({
    mutation: {
      onSuccess: (data) => {
        // Reconcile with the server's authoritative response
        queryClient.setQueryData(tilesQueryKey, data);
        if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
        setShowSaved(true);
        savedTimeoutRef.current = setTimeout(() => setShowSaved(false), 2000);
      },
      onError: () => {
        toast({ title: "Failed to save layout", variant: "destructive" });
        // Roll back the optimistic update to the server's true state
        queryClient.invalidateQueries({ queryKey: tilesQueryKey });
      },
    },
  });

  // Quick-add for the layout-only spacer/divider tiles. They carry no settings,
  // so they skip the editor entirely and drop straight into the first empty slot
  // on the active page.
  const createTile = useCreateTile({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: tilesQueryKey });
      },
      onError: (err) => {
        toast({
          title: "Failed to add tile",
          description: err.message,
          variant: "destructive",
        });
      },
    },
  });

  // Page CRUD mutations. Each refreshes the page list; create also switches to
  // the new page, and the tile cache for a deleted page is dropped.
  const createPage = useCreatePage({
    mutation: {
      onSuccess: (page) => {
        queryClient.invalidateQueries({ queryKey: getGetPagesQueryKey() });
        setActivePageId(page.id);
      },
      onError: (err) => {
        toast({ title: "Failed to create page", description: err.message, variant: "destructive" });
      },
    },
  });

  const updatePage = useUpdatePage({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetPagesQueryKey() });
      },
      onError: (err) => {
        toast({ title: "Failed to rename page", description: err.message, variant: "destructive" });
      },
    },
  });

  const deletePage = useDeletePage({
    mutation: {
      onSuccess: (_data, variables) => {
        queryClient.removeQueries({
          queryKey: getGetTilesQueryKey({ pageId: variables.id }),
        });
        queryClient.invalidateQueries({ queryKey: getGetPagesQueryKey() });
      },
      onError: (err) => {
        toast({ title: "Failed to delete page", description: err.message, variant: "destructive" });
      },
    },
  });

  // Device-mode CRUD. Create switches this browser to the new mode; delete
  // drops the mode's cached tile scopes and lets the reconcile effect pick a
  // surviving mode.
  const createDeviceMode = useCreateDeviceMode({
    mutation: {
      onSuccess: (mode) => {
        queryClient.invalidateQueries({ queryKey: getGetDeviceModesQueryKey() });
        setActiveDeviceModeId(mode.id);
      },
      onError: (err) => {
        toast({ title: "Failed to create mode", description: err.message, variant: "destructive" });
      },
    },
  });

  const updateDeviceMode = useUpdateDeviceMode({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDeviceModesQueryKey() });
      },
      onError: (err) => {
        toast({ title: "Failed to rename mode", description: err.message, variant: "destructive" });
      },
    },
  });

  const deleteDeviceMode = useDeleteDeviceMode({
    mutation: {
      onSuccess: () => {
        queryClient.removeQueries({ queryKey: getGetTilesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDeviceModesQueryKey() });
      },
      onError: (err) => {
        toast({ title: "Failed to delete mode", description: err.message, variant: "destructive" });
      },
    },
  });

  // "Copy layout from…" for an empty (mode, variant) scope. Lists the page's
  // non-empty scopes and clones one into the current scope.
  const { data: pageLayouts = [] } = useGetPageLayouts(activePageId ?? 0, {
    query: {
      queryKey: getGetPageLayoutsQueryKey(activePageId ?? 0),
      enabled: Boolean(me) && activePageId != null,
    },
  });

  const copyPageLayout = useCopyPageLayout({
    mutation: {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getGetTilesQueryKey() });
        if (activePageId != null) {
          queryClient.invalidateQueries({
            queryKey: getGetPageLayoutsQueryKey(activePageId),
          });
        }
        toast({
          title: result.copied === 1 ? "Copied 1 tile" : `Copied ${result.copied} tiles`,
        });
      },
      onError: (err) => {
        toast({ title: "Copy failed", description: err.message, variant: "destructive" });
      },
    },
  });

  const reorderPages = useReorderPages({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetPagesQueryKey(), data);
      },
      onError: (err) => {
        toast({ title: "Failed to reorder pages", description: err.message, variant: "destructive" });
        queryClient.invalidateQueries({ queryKey: getGetPagesQueryKey() });
      },
    },
  });

  const layout = tiles.map(tileToLayout);

  // Effective scale settings. An adaptive page behaves exactly like a fixed
  // page whose preset/orientation come from the active variant (screen-resolved
  // or pinned in edit mode); auto/fixed pages use the page's own settings.
  const effPreset = isAdaptive ? (activeVariant?.split("-")[0] ?? "fhd") : preset;
  const effOrientation = isAdaptive
    ? (activeVariant?.split("-")[1] ?? "landscape")
    : orientation;
  const fixedLayout = isFixedPreset(effPreset);

  // Portrait fixed pages use the simplified vertical column tiers (shaped by
  // the screen's short side); landscape keeps the original preset columns.
  const cols = fixedLayout
    ? colsForPreset(effPreset, effOrientation)
    : gridWidth !== null
      ? colsForWidth(gridWidth)
      : MIN_COLS;

  // For a fixed page the grid is rendered at its intrinsic pixel width (derived
  // from the locked column count) and then CSS-scaled to fit. For an auto page
  // it renders at the measured container width as before.
  const renderWidth = fixedLayout ? intrinsicGridWidth(cols) : gridWidth;

  // The scale factor applied to a fixed grid in locked (non-edit) mode. Edit
  // mode is never scaled so react-grid-layout's pointer math stays correct.
  // Both orientations fit to width: the grid fills the viewport width at its
  // intended size and the page scrolls vertically when content extends past
  // the fold — the fold guide is advisory only, never a content ceiling.
  // (Portrait used to fit-to-height, which shrank the whole grid whenever
  // content exceeded one screenful.) Defaults to 1 until the inputs are known.
  const scale =
    fixedLayout && !editMode && gridWidth !== null
      ? gridWidth / intrinsicGridWidth(cols)
      : 1;

  const handleLayoutChange = useCallback(
    (currentLayout: { i: string; x: number; y: number; w: number; h: number }[]) => {
      if (!editMode) return;

      const mapped = currentLayout.map((l) => ({
        id: parseInt(l.i, 10),
        gridX: l.x,
        gridY: l.y,
        gridW: l.w,
        gridH: l.h,
      }));

      // Optimistically apply the new positions to the cache so a tab close
      // during the in-flight request never loses the change.
      const byId = new Map(mapped.map((m) => [m.id, m]));
      queryClient.setQueryData<Tile[]>(tilesQueryKey, (old) =>
        old?.map((t) => {
          const m = byId.get(t.id);
          return m
            ? { ...t, gridX: m.gridX, gridY: m.gridY, gridW: m.gridW, gridH: m.gridH }
            : t;
        }),
      );

      // Persist immediately on drag/resize end — no debounce. Scope the save to
      // the active (page, mode, variant) so the response (and reconcile)
      // carries only this scope's tiles.
      saveLayout.mutate({
        data: {
          tiles: mapped,
          pageId: activePageId,
          deviceModeId: activeDeviceModeId,
          variant: activeVariant,
        },
      });
    },
    [editMode, saveLayout, queryClient, tilesQueryKey, activePageId, activeDeviceModeId, activeVariant],
  );

  // Measure the fixed grid's intrinsic (unscaled) height so the locked wrapper
  // can reserve intrinsicHeight * scale. offsetHeight (and ResizeObserver's reported size) ignore
  // CSS transforms, so the measured height is the true layout height even while
  // a scale is applied — and since scaling only changes the OUTER wrapper, the
  // observed inner element never resizes in response, so there's no feedback
  // loop. The value guard keeps an unchanged measurement from re-rendering. Only
  // the locked fixed branch attaches scaleInnerRef; otherwise the height clears.
  //
  // isLoading and tiles.length are dependencies (not just fixedLayout/width): on
  // a hard refresh the tiles are still fetching, so the render shows the
  // "Loading tiles…" placeholder and the scaled wrapper (with its ref) does not
  // exist yet. Without these deps the effect would run once against a null ref,
  // bail, and never re-run when the grid finally mounts — leaving intrinsicHeight
  // stale so the outer overflow-hidden clips the bottom of the page. Re-running
  // on the loading→loaded transition attaches the observer once the wrapper is
  // actually present.
  useLayoutEffect(() => {
    if (!fixedLayout || editMode) {
      setIntrinsicHeight(null);
      return;
    }
    const el = scaleInnerRef.current;
    if (!el) return;
    const measure = () => {
      const h = el.offsetHeight;
      setIntrinsicHeight((prev) => (prev === h ? prev : h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixedLayout, editMode, cols, renderWidth, gridWidth, isLoading, tiles.length]);

  // Clean up the "saved" indicator timer on unmount
  useEffect(() => {
    return () => {
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    };
  }, []);

  // Update the active page's fixed-scale layout settings. A partial patch (just
  // preset or just orientation) is fine — the backend keeps the other side.
  function setPageLayout(patch: { layoutPreset?: string; layoutOrientation?: string }) {
    if (!activePage) return;
    updatePage.mutate({ id: activePage.id, data: patch as PageInput });
  }

  // Warn before leaving the tab if a layout save is still in flight or has
  // failed and not yet been retried, so a slow-network change is never lost.
  const hasUnsavedLayout = saveLayout.isPending || saveLayout.isError;
  useEffect(() => {
    if (!hasUnsavedLayout) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedLayout]);

  function handleLogout() {
    localStorage.removeItem("token");
    // Only drop auth-related state. Keep the tile list cache so a slow
    // re-login doesn't briefly flash a stale empty grid.
    queryClient.removeQueries({ queryKey: getGetMeQueryKey() });
    setLocation("/login");
  }

  function openCreateModal() {
    setSelectedTile(undefined);
    setModalMode("create");
    // Drop the new (default 4×4) tile into the first empty grid slot rather
    // than stacking it on top of whatever already sits at (0, 0).
    setCreateGridPos(findFirstEmptyPosition(tiles, 4, 4, cols));
    setModalOpen(true);
  }

  function addSpacer() {
    // Spacers carry no content — drop a default 4×4 gap into the first empty
    // slot without opening the editor. It lands movable/resizable like any tile.
    const pos = findFirstEmptyPosition(tiles, 4, 4, cols);
    createTile.mutate({
      data: {
        pageId: activePageId,
        deviceModeId: activeDeviceModeId,
        variant: activeVariant,
        type: TileType.app,
        integration: "spacer",
        gridX: pos.x,
        gridY: pos.y,
        gridW: 4,
        gridH: 4,
      },
    });
  }

  function addDivider() {
    // Dividers are layout-only section headings carrying just a label. Drop a
    // default 4×4 divider into the first empty slot without opening the editor;
    // it lands movable/resizable/editable like any tile and can be renamed.
    const pos = findFirstEmptyPosition(tiles, 4, 4, cols);
    createTile.mutate({
      data: {
        pageId: activePageId,
        deviceModeId: activeDeviceModeId,
        variant: activeVariant,
        type: TileType.app,
        integration: "divider",
        name: "Section",
        gridX: pos.x,
        gridY: pos.y,
        gridW: 4,
        gridH: 4,
      },
    });
  }

  function openEditModal(tile: Tile) {
    if (!editMode) return;
    setSelectedTile(tile);
    setModalMode("edit");
    setModalOpen(true);
  }

  function handleSelectPage(id: number) {
    if (id === activePageId) return;
    setRenamingPageId(null);
    setEditVariantOverride(null);
    setActivePageId(id);
  }

  function handleAddPage() {
    createPage.mutate({ data: { name: "New Page" } });
  }

  function startRename(page: Page) {
    setRenamingPageId(page.id);
    setRenameDraft(page.name);
  }

  function commitRename() {
    const id = renamingPageId;
    if (id == null) return;
    const name = renameDraft.trim();
    const current = pages.find((p) => p.id === id);
    setRenamingPageId(null);
    if (!name || (current && current.name === name)) return;
    updatePage.mutate({ id, data: { name } });
  }

  // Move a page one slot left/right and persist the new order.
  function movePage(id: number, direction: -1 | 1) {
    const index = pages.findIndex((p) => p.id === id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= pages.length) return;
    const order = pages.map((p) => p.id);
    const [moved] = order.splice(index, 1);
    order.splice(target, 0, moved!);
    // Optimistically reorder the cached list so the tabs reflow immediately.
    const byId = new Map(pages.map((p) => [p.id, p]));
    queryClient.setQueryData<Page[]>(
      getGetPagesQueryKey(),
      order.map((pid, i) => ({ ...byId.get(pid)!, position: i })),
    );
    reorderPages.mutate({ data: { order } });
  }

  function confirmDeletePage() {
    const page = pagePendingDelete;
    setPagePendingDelete(null);
    if (page) deletePage.mutate({ id: page.id });
  }

  const activeDeviceMode =
    deviceModes.find((m) => m.id === activeDeviceModeId) ?? null;

  // Open the create/rename mode dialog with the right starting draft.
  function openModeDialog(kind: "create" | "rename") {
    setModeNameDraft(kind === "rename" ? (activeDeviceMode?.name ?? "") : "");
    setModeDialog({ kind });
  }

  function commitModeDialog() {
    const kind = modeDialog?.kind;
    const name = modeNameDraft.trim();
    setModeDialog(null);
    if (!kind || !name) return;
    if (kind === "create") {
      createDeviceMode.mutate({ data: { name } });
    } else if (activeDeviceModeId != null) {
      updateDeviceMode.mutate({ id: activeDeviceModeId, data: { name } });
    }
  }

  function confirmDeleteMode() {
    const mode = modePendingDelete;
    setModePendingDelete(null);
    if (mode) deleteDeviceMode.mutate({ id: mode.id });
  }

  // The variant the current screen resolves to (adaptive pages only) — used to
  // mark "this screen" in the edit-mode variant switcher.
  const screenVariant = variantKey(adaptiveResolved.preset, adaptiveResolved.orientation);

  // Layout scopes offered by the "copy layout from…" picker: every non-empty
  // scope on this page except the one currently shown.
  const copySources = pageLayouts.filter(
    (l) =>
      !(
        l.deviceModeId === activeDeviceModeId &&
        (l.variant ?? null) === (activeVariant ?? null)
      ),
  );

  function modeName(id: number | null): string {
    return deviceModes.find((m) => m.id === id)?.name ?? "Unknown mode";
  }

  function handleCopyLayout(
    fromDeviceModeId: number | null,
    fromVariant: string | null,
    replace = false,
  ) {
    if (activePageId == null || activeDeviceModeId == null || fromDeviceModeId == null) return;
    copyPageLayout.mutate({
      id: activePageId,
      data: {
        fromDeviceModeId,
        fromVariant,
        toDeviceModeId: activeDeviceModeId,
        toVariant: activeVariant,
        replace,
      },
    });
  }

  // Entry point used by both copy pickers. If the current layout already has
  // tiles, queue a confirmation dialog instead of copying straight away.
  function requestCopyLayout(src: {
    deviceModeId: number | null;
    variant: string | null;
    tileCount: number;
  }) {
    if (tiles.length > 0) {
      setCopyPendingReplace(src);
    } else {
      handleCopyLayout(src.deviceModeId, src.variant);
    }
  }

  function confirmCopyReplace() {
    const src = copyPendingReplace;
    setCopyPendingReplace(null);
    if (src) handleCopyLayout(src.deviceModeId, src.variant, true);
  }

  // Import a previously exported file. On success the new pages are appended,
  // the page list is refreshed, and we switch to the first imported page.
  const importPages = useImportPages({
    mutation: {
      onSuccess: (created, variables) => {
        queryClient.invalidateQueries({ queryKey: getGetPagesQueryKey() });
        const first = created[0];
        if (first) setActivePageId(first.id);
        toast({
          title:
            created.length === 1
              ? "Imported 1 page"
              : `Imported ${created.length} pages`,
        });

        // Exports deliberately omit credentials, so an imported integration
        // tile references a service but has no connection configured. Surface
        // the distinct integrations whose connection still needs setting up so
        // the user isn't left wondering why those tiles show errors.
        const needsReconnect = integrationsNeedingReconnect(variables.data);
        if (needsReconnect.length > 0) {
          toast({
            title:
              needsReconnect.length === 1
                ? "1 integration needs reconnecting"
                : `${needsReconnect.length} integrations need reconnecting`,
            description: `Imports don't include credentials. Set up ${formatLabelList(needsReconnect)} in Settings so these tiles can load.`,
            action: (
              <ToastAction
                altText="Open settings"
                onClick={() => setLocation("/settings")}
              >
                Open settings
              </ToastAction>
            ),
          });
        }
      },
      onError: (err) => {
        toast({ title: "Import failed", description: err.message, variant: "destructive" });
      },
    },
  });

  // Inspect a just-imported envelope and return the distinct friendly labels of
  // the connection-backed integrations that still lack a configured connection.
  // Uses the live connection status; until that has loaded we stay silent rather
  // than risk a false "needs reconnecting" warning for an already-set-up service.
  function integrationsNeedingReconnect(envelope: PageExport): string[] {
    if (!statuses) return [];
    const labels: string[] = [];
    const seen = new Set<string>();
    for (const page of envelope.pages ?? []) {
      for (const tile of page.tiles ?? []) {
        const integration = tile.integration;
        if (!integration) continue;
        const backing = CONNECTION_BACKED_INTEGRATIONS[integration];
        if (!backing) continue;
        if (statusByService.get(backing.service)?.configured) continue;
        if (seen.has(backing.label)) continue;
        seen.add(backing.label);
        labels.push(backing.label);
      }
    }
    return labels;
  }

  // Join labels into readable prose: "A", "A and B", "A, B and C".
  function formatLabelList(labels: string[]): string {
    if (labels.length <= 1) return labels[0] ?? "";
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  }

  // Turn arbitrary text into a safe download filename fragment.
  function safeFileName(name: string): string {
    const cleaned = name.trim().replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "");
    return cleaned || "dashboard";
  }

  // Trigger a browser download of an export envelope as a pretty-printed JSON.
  function downloadExport(data: PageExport, filename: string) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  }

  async function handleExportPage(page: Page) {
    try {
      const data = await exportPage(page.id);
      downloadExport(data, `${safeFileName(page.name)}.dashboard.json`);
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Could not export page",
        variant: "destructive",
      });
    }
  }

  async function handleExportAll() {
    try {
      const data = await exportAllPages();
      downloadExport(data, "all-pages.dashboard.json");
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Could not export pages",
        variant: "destructive",
      });
    }
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so selecting the same file again re-fires the change event.
    e.target.value = "";
    if (!file) return;
    let parsed: PageExport;
    try {
      parsed = JSON.parse(await file.text()) as PageExport;
    } catch {
      toast({
        title: "Import failed",
        description: "That file isn't valid JSON.",
        variant: "destructive",
      });
      return;
    }
    importPages.mutate({ data: parsed });
  }

  if (!me && isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background bg-dot-pattern">
        <div className="text-muted-foreground text-sm">
          <span className="text-primary">{"> "}</span>
          <span className="animate-pulse">Initializing…</span>
        </div>
      </div>
    );
  }

  return (
    <PageTilesContext.Provider value={tiles}>
    <div className="min-h-screen bg-background bg-dot-pattern">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-screen-2xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <TachLogo className="w-5 h-5 text-primary" />
            <span className="font-bold text-sm uppercase tracking-widest text-foreground">
              Tachboard
            </span>
          </div>

          <div className="flex items-center gap-2">
            {saveLayout.isPending ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Saving…
              </span>
            ) : showSaved ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Check className="w-3.5 h-3.5 text-primary" />
                Saved
              </span>
            ) : null}

            {editMode && (
              <>
                <Button size="sm" variant="default" className="gap-1.5" onClick={openCreateModal}>
                  <Plus className="w-3.5 h-3.5" />
                  Add tile
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={addSpacer}
                  disabled={createTile.isPending}
                >
                  <SeparatorHorizontal className="w-3.5 h-3.5" />
                  Add spacer
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={addDivider}
                  disabled={createTile.isPending}
                >
                  <Heading className="w-3.5 h-3.5" />
                  Add divider
                </Button>
              </>
            )}

            <Button
              size="sm"
              variant={editMode ? "secondary" : "outline"}
              className="gap-1.5"
              onClick={() =>
                setEditMode((v) => {
                  // Leaving edit mode drops any pinned variant so the page
                  // returns to the layout the current screen resolves to.
                  if (v) setEditVariantOverride(null);
                  return !v;
                })
              }
            >
              {editMode ? (
                <>
                  <Lock className="w-3.5 h-3.5" />
                  Done
                </>
              ) : (
                <>
                  <Unlock className="w-3.5 h-3.5" />
                  Edit
                </>
              )}
            </Button>

            {/* Device-mode switcher: which layout profile this browser shows. */}
            {deviceModes.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5"
                    title="Device mode — separate tile layouts per device (PC, phone, …)"
                    data-testid="device-mode-trigger"
                  >
                    <MonitorSmartphone className="w-3.5 h-3.5" />
                    <span className="max-w-24 truncate text-sm">
                      {activeDeviceMode?.name ?? "Mode"}
                    </span>
                    <ChevronDown className="w-3.5 h-3.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel>Device mode</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={activeDeviceModeId != null ? String(activeDeviceModeId) : ""}
                    onValueChange={(v) => setActiveDeviceModeId(parseInt(v, 10))}
                  >
                    {deviceModes.map((m) => (
                      <DropdownMenuRadioItem key={m.id} value={String(m.id)}>
                        {m.name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  {editMode && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => openModeDialog("create")} className="gap-2">
                        <Plus className="w-3.5 h-3.5" />
                        New mode…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => openModeDialog("rename")}
                        className="gap-2"
                        disabled={!activeDeviceMode}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        Rename current…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => activeDeviceMode && setModePendingDelete(activeDeviceMode)}
                        className="gap-2 text-destructive"
                        disabled={!activeDeviceMode || deviceModes.length <= 1}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete current…
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => setLocation("/settings")}
              aria-label="Settings"
            >
              <SettingsIcon className="w-4 h-4" />
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="gap-1.5">
                  <span className="max-w-24 truncate text-sm">{me?.username}</span>
                  <ChevronDown className="w-3.5 h-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleLogout} className="text-destructive gap-2">
                  <LogOut className="w-3.5 h-3.5" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Page switcher */}
        {pages.length > 0 && (
          <div className="border-t border-border/60">
            <div className="max-w-screen-2xl mx-auto px-4 h-11 flex items-center gap-1 overflow-x-auto">
              {pages.map((page, index) => {
                const isActive = page.id === activePageId;
                const isRenaming = renamingPageId === page.id;
                return (
                  <div
                    key={page.id}
                    className={`group flex items-center shrink-0 h-8 px-1 border-b-2 transition-colors ${
                      isActive
                        ? "border-primary"
                        : "border-transparent hover:border-border"
                    }`}
                  >
                    {editMode && (
                      <button
                        type="button"
                        className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
                        onClick={() => movePage(page.id, -1)}
                        disabled={index === 0}
                        aria-label="Move page left"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {isRenaming ? (
                      <Input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setRenamingPageId(null);
                        }}
                        className="h-7 w-32 px-2 text-sm"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleSelectPage(page.id)}
                        onDoubleClick={() => editMode && startRename(page)}
                        className={`px-2 h-7 text-sm whitespace-nowrap transition-colors ${
                          isActive
                            ? "text-foreground font-medium"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {page.name}
                      </button>
                    )}

                    {editMode && !isRenaming && (
                      <>
                        <button
                          type="button"
                          className="p-0.5 text-muted-foreground hover:text-foreground"
                          onClick={() => startRename(page)}
                          aria-label="Rename page"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          className="p-0.5 text-muted-foreground hover:text-foreground"
                          onClick={() => handleExportPage(page)}
                          aria-label="Export page"
                          title="Export this page"
                        >
                          <Download className="w-3 h-3" />
                        </button>
                        <button
                          type="button"
                          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground"
                          onClick={() => movePage(page.id, 1)}
                          disabled={index === pages.length - 1}
                          aria-label="Move page right"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          className="p-0.5 text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:hover:text-muted-foreground"
                          onClick={() => setPagePendingDelete(page)}
                          disabled={pages.length <= 1}
                          aria-label="Delete page"
                          title={pages.length <= 1 ? "Can't delete your last page" : "Delete page"}
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                );
              })}

              {editMode && (
                <>
                  {activePage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1.5 shrink-0 h-7 ml-1"
                          title="Lock this page to a fixed scale so tiles don't reflow on resize"
                        >
                          <MonitorSmartphone className="w-3.5 h-3.5" />
                          {!isAdaptive && fixedLayout && orientation === "portrait"
                            ? (PORTRAIT_PRESET_LABEL[canonicalPortraitPreset(preset)] ?? "Standard")
                            : (PRESET_LABEL[preset] ?? "Auto / responsive")}
                          {!isAdaptive && fixedLayout && (
                            <span className="text-muted-foreground">
                              · {orientation === "portrait" ? "Vertical" : "Landscape"}
                            </span>
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-48">
                        <DropdownMenuLabel>Page scale</DropdownMenuLabel>
                        {/* Vertical pages offer the simplified portrait tiers
                            only; landscape (and auto/adaptive) keep the full
                            preset list. The radio value is canonicalized so a
                            legacy compact/qhd portrait page highlights the
                            tier it actually renders as. */}
                        {!isAdaptive && fixedLayout && orientation === "portrait" ? (
                          <DropdownMenuRadioGroup
                            value={canonicalPortraitPreset(preset)}
                            onValueChange={(v) => setPageLayout({ layoutPreset: v })}
                          >
                            {PORTRAIT_PRESET_ORDER.map((p) => (
                              <DropdownMenuRadioItem key={p} value={p}>
                                {PORTRAIT_PRESET_LABEL[p]}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        ) : (
                          <DropdownMenuRadioGroup
                            value={preset}
                            onValueChange={(v) => setPageLayout({ layoutPreset: v })}
                          >
                            {PRESET_ORDER.map((p) => (
                              <DropdownMenuRadioItem key={p} value={p}>
                                {PRESET_LABEL[p]}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Orientation</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={orientation}
                          onValueChange={(v) =>
                            // Switching to vertical also snaps the stored
                            // preset onto its simplified portrait tier so the
                            // saved page always names a canonical vertical
                            // option.
                            setPageLayout(
                              v === "portrait" && fixedLayout && !isAdaptive
                                ? {
                                    layoutOrientation: v,
                                    layoutPreset: canonicalPortraitPreset(preset),
                                  }
                                : { layoutOrientation: v },
                            )
                          }
                        >
                          <DropdownMenuRadioItem
                            value="landscape"
                            disabled={isAdaptive || !fixedLayout}
                          >
                            Landscape (fit width)
                          </DropdownMenuRadioItem>
                          <DropdownMenuRadioItem
                            value="portrait"
                            disabled={isAdaptive || !fixedLayout}
                          >
                            Vertical (fit height)
                          </DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                        {isAdaptive && (
                          <p className="px-2 py-1.5 text-xs text-muted-foreground">
                            Adaptive pages pick scale and orientation from the
                            screen automatically.
                          </p>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}

                  {/* Edit-mode variant switcher for adaptive pages: pin any
                      scale+orientation variant to edit its layout, regardless
                      of what this screen resolves to. */}
                  {activePage && isAdaptive && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1.5 shrink-0 h-7"
                          title="Which adaptive layout variant you're editing"
                          data-testid="variant-switcher-trigger"
                        >
                          <LayoutGrid className="w-3.5 h-3.5" />
                          {variantLabel(activeVariant)}
                          {activeVariant === screenVariant && (
                            <span className="text-muted-foreground">· this screen</span>
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-56">
                        <DropdownMenuLabel>Editing layout for</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={activeVariant ?? ""}
                          onValueChange={(v) =>
                            setEditVariantOverride(v === screenVariant ? null : v)
                          }
                        >
                          {/* Landscape lists all four presets; vertical lists
                              only the simplified portrait tiers. */}
                          {[
                            ...PRESET_ORDER.filter((p) => p in PRESET_COLS).map(
                              (p) => variantKey(p, "landscape"),
                            ),
                            ...PORTRAIT_PRESET_ORDER.map((p) => variantKey(p, "portrait")),
                          ].map((key) => (
                            <DropdownMenuRadioItem key={key} value={key}>
                              {variantLabel(key)}
                              {key === screenVariant && (
                                <span className="ml-1 text-muted-foreground text-xs">
                                  (this screen)
                                </span>
                              )}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 shrink-0 h-7 ml-1"
                    onClick={handleAddPage}
                    disabled={createPage.isPending}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New page
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 shrink-0 h-7"
                    onClick={() => importInputRef.current?.click()}
                    disabled={importPages.isPending}
                  >
                    {importPages.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Upload className="w-3.5 h-3.5" />
                    )}
                    Import page
                  </Button>
                  {/* Copy layout from another mode/variant even when this
                      layout already has tiles — replacement is confirmed
                      via a dialog before anything is overwritten. */}
                  {tiles.length > 0 && copySources.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="gap-1.5 shrink-0 h-7"
                          disabled={copyPageLayout.isPending}
                          data-testid="copy-layout-trigger"
                        >
                          {copyPageLayout.isPending ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Download className="w-3.5 h-3.5" />
                          )}
                          Copy layout from…
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="center" className="w-64">
                        <DropdownMenuLabel>
                          Replace this layout's tiles with
                        </DropdownMenuLabel>
                        {copySources.map((src) => (
                          <DropdownMenuItem
                            key={`${src.deviceModeId ?? "none"}:${src.variant ?? "base"}`}
                            onClick={() => requestCopyLayout(src)}
                          >
                            {modeName(src.deviceModeId)} · {variantLabel(src.variant)}
                            <span className="ml-auto text-xs text-muted-foreground">
                              {src.tileCount} {src.tileCount === 1 ? "tile" : "tiles"}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 shrink-0 h-7"
                    onClick={handleExportAll}
                    disabled={pages.length === 0}
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export all
                  </Button>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={handleImportFile}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Grid */}
      <main className="px-4 py-6">
        <div ref={containerRef}>
        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
            <span className="text-primary">{"> "}</span>
            <span className="animate-pulse">Loading tiles…</span>
          </div>
        ) : tiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-72 gap-4 text-center border border-dashed border-border bg-card/40">
            <LayoutGrid className="w-12 h-12 text-primary opacity-40" />
            <div>
              <p className="font-bold uppercase tracking-widest text-foreground">No tiles yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Enable edit mode and add your first tile.
              </p>
            </div>
            <Button
              onClick={() => {
                setEditMode(true);
                openCreateModal();
              }}
              className="gap-1.5"
            >
              <Plus className="w-4 h-4" />
              Add your first tile
            </Button>
            {copySources.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="gap-1.5"
                    disabled={copyPageLayout.isPending}
                    data-testid="copy-layout-trigger"
                  >
                    {copyPageLayout.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    Copy layout from…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" className="w-64">
                  <DropdownMenuLabel>Copy this page's tiles from</DropdownMenuLabel>
                  {copySources.map((src) => (
                    <DropdownMenuItem
                      key={`${src.deviceModeId ?? "none"}:${src.variant ?? "base"}`}
                      onClick={() => requestCopyLayout(src)}
                    >
                      {modeName(src.deviceModeId)} · {variantLabel(src.variant)}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {src.tileCount} {src.tileCount === 1 ? "tile" : "tiles"}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ) : (
          <div className="relative">
            {/* Edit-mode safe-zone guide: a dotted line marking the fold (what
                fits in the viewport without scrolling). Purely visual —
                pointer-events-none so it never interferes with drag/resize. */}
            {editMode && foldOffset !== null && (
              <div
                data-testid="fold-guide"
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 z-30"
                style={{ top: foldOffset }}
              >
                <div className="border-t-2 border-dashed border-primary/50" />
                <span className="absolute right-0 -top-0.5 -translate-y-full bg-background/80 border border-primary/40 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-primary/80">
                  Visible without scrolling
                </span>
              </div>
            )}
            {gridWidth !== null && (() => {
            const gridEl = (
            <TileExpansionProvider
              resetKey={`${activePageId}:${activeDeviceModeId}:${activeVariant ?? "base"}:${editMode ? "edit" : "locked"}`}
              validIds={tiles.map((t) => t.id)}
            >
            <Grid
              className={`layout ${editMode ? "grid-editing" : "grid-locked"}`}
              layout={layout}
              width={renderWidth ?? gridWidth}
              gridConfig={{
                cols,
                rowHeight: ROW_HEIGHT,
                margin: [GRID_MARGIN, GRID_MARGIN],
                containerPadding: [0, 0],
              }}
              dragConfig={{ enabled: editMode, handle: ".drag-handle" }}
              resizeConfig={{ enabled: editMode }}
              onLayoutChange={handleLayoutChange}
            >
              {tiles.map((tile) => {
                // Per-tile overflow: when "scrollable" is on, the tile body
                // scrolls instead of clipping. The image background sub-layer
                // keeps its own overflow-hidden so framing is unaffected. The
                // spacer tile is layout-only and always clips.
                const isLayoutTile =
                  tile.integration === "spacer" || tile.integration === "divider";
                const overflowClass =
                  !isLayoutTile && tile.tileSettings?.scrollable
                    ? "overflow-auto"
                    : "overflow-hidden";
                return (
                <div
                  key={String(tile.id)}
                  className={
                    isLayoutTile
                      ? // Layout tiles (spacer/divider) carry no card surface.
                        // The spacer is invisible in locked mode; the divider
                        // shows its label text. Neither is a click target when
                        // locked, but both keep the edit ring so they can be
                        // moved, resized, or deleted.
                        `relative ${overflowClass} transition-all ${
                          editMode
                            ? "ring-1 ring-primary/40 hover:ring-primary cursor-default"
                            : "pointer-events-none"
                        }`
                      : `relative ${overflowClass} border border-border shadow-sm bg-card transition-all ${
                          editMode ? "ring-1 ring-primary/40 hover:ring-primary cursor-default" : "hover:border-primary/40"
                        }`
                  }
                >
                  {editMode && (
                    <div className="drag-handle absolute inset-0 z-20 flex items-start justify-end p-1.5 cursor-grab active:cursor-grabbing">
                      <button
                        type="button"
                        className="p-1 bg-background/80 hover:bg-background border border-border shadow-sm text-muted-foreground hover:text-primary transition-colors"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditModal(tile);
                        }}
                        aria-label="Edit tile"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                  {isLayoutTile ? (
                    renderTileContent(tile, undefined, editMode)
                  ) : (
                    // Always the same host element whether or not expansion
                    // is enabled, so toggling edit mode / the setting never
                    // remounts the widget.
                    <TileExpansionHost
                      tileId={tile.id}
                      enabled={!editMode && tile.tileSettings?.openExpanded === true}
                      title={
                        tile.name ||
                        (tile.integration ? INTEGRATION_LABELS[tile.integration] : undefined) ||
                        "Tile"
                      }
                      url={tile.url}
                      scrollable={Boolean(tile.tileSettings?.scrollable)}
                      integration={tile.integration}
                      hasImage={Boolean(tile.imageUrl)}
                    >
                      {renderTileContent(
                        tile,
                        tile.integration
                          ? statusByService.get(INTEGRATION_SERVICE[tile.integration])
                          : undefined,
                        editMode,
                      )}
                    </TileExpansionHost>
                  )}
                </div>
                );
              })}
            </Grid>
            </TileExpansionProvider>
            );

            // Auto (responsive) pages render the grid directly, as before.
            if (!fixedLayout) return gridEl;

            // A fixed page being edited renders at full intrinsic size (no
            // scaling) so react-grid-layout's drag/resize pointer math stays
            // correct; it scrolls horizontally if it's wider than the viewport.
            // A vertical dashed guide marks the page's placeable width limit —
            // rendered inside the scroll wrapper (next to the grid, sized to
            // the grid's intrinsic width) so it scrolls with the grid and is
            // correct whether the fixed canvas is narrower or wider than the
            // viewport. Purely visual: pointer-events-none.
            if (editMode)
              return (
                <div className="overflow-x-auto">
                  <div className="relative" style={{ width: renderWidth ?? undefined }}>
                    <div
                      data-testid="fold-guide-vertical"
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 z-30"
                      style={{ left: renderWidth ?? 0, marginLeft: -2 }}
                    >
                      <div className="h-full border-l-2 border-dashed border-primary/50" />
                      <span className="absolute top-6 left-0 -translate-x-full bg-background/80 border border-primary/40 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-primary/80 whitespace-nowrap [writing-mode:vertical-rl]">
                        Page width limit
                      </span>
                    </div>
                    {gridEl}
                  </div>
                </div>
              );

            // A locked fixed page is CSS-scaled to fit and centered. The outer
            // wrapper reserves the scaled height (and clips the unscaled layout
            // box's leftover space) so the page neither clips nor leaves dead
            // scroll area. transform-origin "top center" keeps it centered.
            return (
              <div
                // items-start is critical: the default align-items:stretch would
                // stretch the measured inner wrapper to this parent's height
                // (intrinsicHeight*scale). Since the ResizeObserver reads that
                // wrapper's offsetHeight back into intrinsicHeight, a scale < 1
                // (a fixed canvas wider than the viewport, e.g. the 2K/4K presets
                // on a smaller screen) would shrink the height geometrically to
                // zero each cycle and collapse the grid out of view.
                className="flex items-start justify-center overflow-hidden"
                style={{
                  height:
                    intrinsicHeight != null ? intrinsicHeight * scale : undefined,
                }}
              >
                <div
                  ref={scaleInnerRef}
                  data-testid="fixed-scale-wrapper"
                  className="shrink-0"
                  style={{
                    width: renderWidth ?? undefined,
                    transform: `scale(${scale})`,
                    transformOrigin: "top center",
                  }}
                >
                  {gridEl}
                </div>
              </div>
            );
            })()}
          </div>
        )}
        </div>
      </main>

      <TileEditModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        tile={selectedTile}
        mode={modalMode}
        defaultGridPos={createGridPos}
        pageId={activePageId}
        deviceModeId={activeDeviceModeId}
        variant={activeVariant}
      />

      {/* Create / rename a device mode */}
      <AlertDialog
        open={modeDialog !== null}
        onOpenChange={(open) => {
          if (!open) setModeDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {modeDialog?.kind === "rename" ? "Rename device mode" : "New device mode"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {modeDialog?.kind === "rename"
                ? "Give this device mode a new name."
                : "A device mode is a separate layout profile — e.g. one for your PC and one for your phone. Each browser remembers which mode it shows."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            autoFocus
            value={modeNameDraft}
            onChange={(e) => setModeNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitModeDialog();
            }}
            placeholder="e.g. Phone"
            data-testid="mode-name-input"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={commitModeDialog}
              disabled={!modeNameDraft.trim()}
            >
              {modeDialog?.kind === "rename" ? "Rename" : "Create mode"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm device-mode deletion */}
      <AlertDialog
        open={modePendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setModePendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{modePendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the device mode and every tile layout it
              holds on all pages. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteMode}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete mode
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pagePendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPagePendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{pagePendingDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the page and all of its tiles. This can't be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeletePage}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete page
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirm replacing the current layout's tiles with a copied layout. */}
      <AlertDialog
        open={copyPendingReplace !== null}
        onOpenChange={(open) => {
          if (!open) setCopyPendingReplace(null);
        }}
      >
        <AlertDialogContent data-testid="copy-replace-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace this layout?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces the {tiles.length}{" "}
              {tiles.length === 1 ? "tile" : "tiles"} in the current layout with{" "}
              {copyPendingReplace ? (
                <>
                  the {copyPendingReplace.tileCount}{" "}
                  {copyPendingReplace.tileCount === 1 ? "tile" : "tiles"} from{" "}
                  {modeName(copyPendingReplace.deviceModeId)} ·{" "}
                  {variantLabel(copyPendingReplace.variant)}
                </>
              ) : (
                "the copied layout"
              )}
              . The existing tiles here will be deleted. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmCopyReplace}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="copy-replace-confirm"
            >
              Replace layout
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </PageTilesContext.Provider>
  );
}
