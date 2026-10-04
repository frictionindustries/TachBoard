import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ExternalLink, Maximize2, X } from "lucide-react";
import { PortalContainerContext } from "@/lib/portalContainer";
import { openTileUrl } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Expanded tile panels.
//
// Single-owner model: the dashboard owns ONE expandedId. Each tile's content
// is rendered exactly once, inside an always-mounted <TileExpansionHost>. To
// expand, the host element itself is promoted into the browser top layer via
// the native Popover API (popover="manual" + showPopover). The DOM node never
// moves or re-parents, so React never remounts the widget and connected
// <video>/<iframe>/<audio> elements keep playing; the top layer escapes the
// grid's transforms and overflow clipping. Nested Radix portals are redirected
// into the host (PortalContainerContext) so they stack above the panel.
// ---------------------------------------------------------------------------

interface ExpansionOwner {
  expandedId: number | null;
  open: (id: number) => void;
  close: () => void;
}

const OwnerContext = createContext<ExpansionOwner | null>(null);

export function TileExpansionProvider({
  children,
  resetKey,
  validIds,
}: {
  children: ReactNode;
  // Any change (page / device mode / variant / edit mode) dismisses the panel.
  resetKey: string;
  // Tile ids currently on screen; an expanded tile that disappears closes.
  validIds: number[];
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  useEffect(() => {
    setExpandedId(null);
  }, [resetKey]);
  const idsKey = validIds.join(",");
  useEffect(() => {
    setExpandedId((cur) => (cur != null && !idsKey.split(",").includes(String(cur)) ? null : cur));
  }, [idsKey]);
  const open = useCallback((id: number) => setExpandedId(id), []);
  const close = useCallback(() => setExpandedId(null), []);
  const value = useMemo(() => ({ expandedId, open, close }), [expandedId, open, close]);
  return <OwnerContext.Provider value={value}>{children}</OwnerContext.Provider>;
}

export interface TileExpansionState {
  // The option is on and the dashboard is locked.
  canExpand: boolean;
  // Currently presented in the expanded panel.
  expanded: boolean;
  requestExpand: () => void;
}

const NOOP_STATE: TileExpansionState = { canExpand: false, expanded: false, requestExpand: () => {} };
const TileExpansionContext = createContext<TileExpansionState>(NOOP_STATE);

// Read by widgets: IntegrationTile lifts density limits while expanded; AppTile
// and the IntegrationTile title expand instead of navigating when enabled.
export function useTileExpansion(): TileExpansionState {
  return useContext(TileExpansionContext);
}

const INTERACTIVE =
  'a,button,input,textarea,select,label,summary,video,audio,iframe,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="slider"],[role="tab"],[role="menuitem"],[role="option"],[contenteditable=""],[contenteditable="true"],[data-no-expand]';

const NESTED_LAYER =
  '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[data-radix-popper-content-wrapper],[role="menu"][data-state="open"],[role="listbox"]';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

// The panel REQUIRES the native Popover API (Chrome/Edge 114+, Safari 17+,
// Firefox 125+): only the top layer reliably escapes the grid's transformed /
// clipped ancestors without moving the DOM. Where it is missing the option is
// inert (tile keeps its normal behavior, no expand control) rather than
// rendering a broken fixed-position overlay inside a transformed ancestor.
export function supportsPopover(): boolean {
  return (
    typeof HTMLElement !== "undefined" &&
    typeof (HTMLElement.prototype as HTMLElement & { showPopover?: unknown }).showPopover === "function"
  );
}

// Make everything outside `host` inert (non-focusable, non-clickable, hidden
// from AT) by marking the siblings of host and of each of its ancestors. The
// host's own subtree, including nested Radix portals rendered into it, stays
// live. Returns an undo function that only reverts what we changed.
function inertOutside(host: HTMLElement): () => void {
  const touched: HTMLElement[] = [];
  let node: HTMLElement | null = host;
  while (node && node.parentElement && node !== document.body) {
    const parent: HTMLElement = node.parentElement;
    for (const sib of Array.from(parent.children)) {
      if (sib === node || !(sib instanceof HTMLElement)) continue;
      if (sib.inert || sib.tagName === "SCRIPT" || sib.tagName === "STYLE") continue;
      sib.inert = true;
      touched.push(sib);
    }
    node = parent;
  }
  return () => {
    for (const el of touched) el.inert = false;
  };
}

interface HostProps {
  tileId: number;
  // Setting on, not a layout tile, dashboard locked.
  enabled: boolean;
  title: string;
  url?: string | null;
  // Mirrors tileSettings.scrollable for the compact presentation.
  scrollable?: boolean;
  integration?: string | null;
  hasImage?: boolean;
  children: ReactNode;
}

// Flow content sizes itself; canvases/editors need a bounded working surface
// because their children deliberately fill their parent rather than size it.
export function expandedPresentation(integration?: string | null, hasImage = false) {
  if (!integration) return hasImage ? "media" : "app";
  if (["videoplayer", "pictureframe", "aquarium", "visualizer"].includes(integration)) return "media";
  if (integration === "note") return "editor";
  if (["timer", "tamagotchi", "bonsai", "dice", "coinflip", "eightball", "fortune"].includes(integration)) return "instrument";
  return "flow";
}

export function TileExpansionHost({ tileId, enabled: enabledProp, title, url, scrollable, integration, hasImage, children }: HostProps) {
  const owner = useContext(OwnerContext);
  const enabled = enabledProp && supportsPopover();
  const expanded = enabled && owner?.expandedId === tileId;
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostEl, setHostEl] = useState<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const nestedAtPointerDown = useRef(false);
  const titleId = useId();

  // Owner is read through a ref so these callbacks stay stable across
  // expandedId updates (the focus effect must not re-run on owner changes).
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const openSelf = useCallback(() => {
    if (!enabled || !ownerRef.current) return;
    restoreFocusRef.current = (document.activeElement as HTMLElement | null) ?? null;
    ownerRef.current.open(tileId);
  }, [enabled, tileId]);
  const closeSelf = useCallback(() => {
    const o = ownerRef.current;
    if (o?.expandedId === tileId) o.close();
  }, [tileId]);

  const hasNested = () => Boolean(hostRef.current?.querySelector(NESTED_LAYER));

  // Promote / demote the same element in the top layer.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el || !expanded) return;
    setHostEl(el);
    try {
      el.showPopover();
    } catch {
      /* already open */
    }
    const undoInert = inertOutside(el);
    return () => {
      undoInert();
      setHostEl(null);
      try {
        el.hidePopover();
      } catch {
        /* already closed / disconnected */
      }
    };
  }, [expanded]);

  // Focus management + Escape + Tab trap while expanded.
  useEffect(() => {
    if (!expanded) return;
    const raf = requestAnimationFrame(() => closeBtnRef.current?.focus({ preventScroll: true }));
    // Radix can synchronously remove its layer before our document listener
    // runs. Remember which layer owned the event before any handler dismisses it.
    const nestedEvents = new WeakSet<KeyboardEvent>();
    const captureKey = (e: KeyboardEvent) => {
      if (hasNested()) nestedEvents.add(e);
    };
    const onKey = (e: KeyboardEvent) => {
      const host = hostRef.current;
      if (!host) return;
      // A nested dialog/menu handles its own Escape/Tab first.
      if (nestedEvents.has(e) || hasNested() || e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeSelf();
        return;
      }
      if (e.key === "Tab") {
        const items = Array.from(host.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          (n) => n.offsetParent !== null || n === document.activeElement,
        );
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement as HTMLElement | null;
        if (!active || !host.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", captureKey, true);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", captureKey, true);
      document.removeEventListener("keydown", onKey);
      const back = restoreFocusRef.current;
      restoreFocusRef.current = null;
      requestAnimationFrame(() => {
        if (back && back.isConnected && back !== document.body) back.focus({ preventScroll: true });
        else triggerRef.current?.focus({ preventScroll: true });
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const state = useMemo<TileExpansionState>(
    () => ({ canExpand: enabled, expanded, requestExpand: openSelf }),
    [enabled, expanded, openSelf],
  );

  // Compact: click on noninteractive content expands. Child controls win.
  const onBodyClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!enabled || expanded || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    const hit = target.closest(INTERACTIVE);
    if (hit && e.currentTarget.contains(hit)) return;
    openSelf();
  };

  return (
    <>
      <div
        ref={hostRef}
        // Always present so promotion never changes the element identity.
        popover="manual"
        className="tile-expand-host"
        data-expanded={expanded ? "true" : "false"}
        data-presentation={expandedPresentation(integration, hasImage)}
        data-testid={`tile-host-${tileId}`}
        role={expanded ? "dialog" : undefined}
        aria-modal={expanded ? true : undefined}
        aria-labelledby={expanded ? titleId : undefined}
        onPointerDownCapture={() => {
          nestedAtPointerDown.current = hasNested();
        }}
        onClick={(e) => {
          // Expanded, the host itself is a full-viewport element painting the
          // dimmed backdrop, so a click outside the panel frame lands on the
          // host as a real DOM target (no reliance on ::backdrop hit-testing).
          if (expanded && e.target === e.currentTarget && !nestedAtPointerDown.current) closeSelf();
        }}
      >
        <div className="tile-expand-frame">
        {expanded && (
          <div className="tile-expand-header" data-testid={`panel-header-${tileId}`}>
            <h2 id={titleId} className="truncate text-sm font-bold uppercase tracking-widest">
              {title}
            </h2>
            <div className="ml-auto flex items-center gap-1">
              {url && (
                <button
                  type="button"
                  onClick={() => openTileUrl(url)}
                  className="tile-expand-action"
                  data-testid={`button-panel-open-link-${tileId}`}
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Open link</span>
                </button>
              )}
              <button
                ref={closeBtnRef}
                type="button"
                onClick={closeSelf}
                aria-label="Close expanded panel"
                className="tile-expand-action"
                data-testid={`button-panel-close-${tileId}`}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        <div
          className={`tile-expand-body ${expanded ? "overflow-auto" : scrollable ? "overflow-auto" : "overflow-hidden"} ${enabled && !expanded ? "cursor-zoom-in" : ""}`}
          onClick={onBodyClick}
        >
          <PortalContainerContext.Provider value={expanded ? hostEl : null}>
            <TileExpansionContext.Provider value={state}>{children}</TileExpansionContext.Provider>
          </PortalContainerContext.Provider>
        </div>
        {enabled && !expanded && (
          <button
            ref={triggerRef}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openSelf();
            }}
            aria-label={`Expand ${title}`}
            title="Open in expanded panel"
            className="tile-expand-trigger"
            data-testid={`button-expand-tile-${tileId}`}
          >
            <Maximize2 className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
        </div>
      </div>
      {expanded && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] uppercase tracking-widest text-muted-foreground" aria-hidden="true">
          Expanded
        </div>
      )}
    </>
  );
}
