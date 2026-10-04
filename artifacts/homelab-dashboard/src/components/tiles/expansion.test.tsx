// @vitest-environment jsdom
import { useState } from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import type { Tile } from "@workspace/api-client-react";
import { expandedPresentation, TileExpansionHost, TileExpansionProvider, useTileExpansion } from "./expansion";
import AppTile from "./AppTile";
import IntegrationTile from "./IntegrationTile";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  // jsdom lacks the Popover API, which the panel requires.
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.showPopover = function () {};
  proto.hidePopover = function () {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  delete proto.showPopover;
  delete proto.hidePopover;
});

// Stateful child: proves the widget is never remounted (count survives).
function Counter() {
  const [n, setN] = useState(0);
  const { expanded } = useTileExpansion();
  return (
    <div>
      <span data-testid="count">{n}</span>
      <span data-testid="mode">{expanded ? "expanded" : "compact"}</span>
      <button type="button" onClick={() => setN((v) => v + 1)}>inc</button>
      <p data-testid="plain">plain text</p>
      <Dialog>
        <DialogTrigger asChild>
          <button type="button">nested</button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Nested</DialogTitle>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Harness({ enabled = true, resetKey = "a" }: { enabled?: boolean; resetKey?: string }) {
  return (
    <TileExpansionProvider resetKey={resetKey} validIds={[7]}>
      <div style={{ position: "relative" }}>
        <TileExpansionHost tileId={7} enabled={enabled} title="My Tile" url="https://example.test">
          <Counter />
        </TileExpansionHost>
      </div>
    </TileExpansionProvider>
  );
}

const tile = (over: Partial<Tile> = {}): Tile =>
  ({
    id: 1, name: "T", url: "https://example.test", type: "app", gridX: 0, gridY: 0, gridW: 4, gridH: 4,
    integration: null, imageUrl: null, bgColor: null, tileSettings: null, metrics: null, ...over,
  }) as unknown as Tile;

describe("TileExpansionHost", () => {
  it("is default-off: no trigger and clicks do nothing", () => {
    const r = render(<Harness enabled={false} />);
    expect(r.queryByTestId("button-expand-tile-7")).toBeNull();
    fireEvent.click(r.getByTestId("plain"));
    expect(r.getByTestId("mode").textContent).toBe("compact");
  });

  it("expands from noninteractive content and keeps the same DOM + state", () => {
    const r = render(<Harness />);
    const host = r.getByTestId("tile-host-7");
    const countEl = r.getByTestId("count");
    fireEvent.click(r.getByText("inc"));
    expect(r.getByTestId("mode").textContent).toBe("compact"); // child button wins
    fireEvent.click(r.getByTestId("plain"));
    expect(r.getByTestId("mode").textContent).toBe("expanded");
    expect(r.getByTestId("tile-host-7")).toBe(host);
    expect(r.getByTestId("count")).toBe(countEl);
    expect(countEl.textContent).toBe("1");
    expect(host.getAttribute("role")).toBe("dialog");
    expect(r.getByTestId("button-panel-open-link-7")).toBeTruthy();
    fireEvent.click(r.getByTestId("button-panel-close-7"));
    expect(r.getByTestId("mode").textContent).toBe("compact");
    expect(r.getByTestId("count")).toBe(countEl);
  });

  it("explicit trigger is keyboard reachable; Escape closes", () => {
    const r = render(<Harness />);
    fireEvent.click(r.getByTestId("button-expand-tile-7"));
    expect(r.getByTestId("mode").textContent).toBe("expanded");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(r.getByTestId("mode").textContent).toBe("compact");
  });

  it("portals nested dialogs into the panel and Escape closes nested first", async () => {
    const r = render(<Harness />);
    fireEvent.click(r.getByTestId("button-expand-tile-7"));
    await act(async () => { fireEvent.click(r.getByText("nested")); });
    const host = r.getByTestId("tile-host-7");
    const nested = await r.findByRole("dialog", { name: "Nested", hidden: true });
    expect(host.contains(nested)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(r.getByTestId("mode").textContent).toBe("expanded");
  });

  it("dismisses on page/device-mode/variant resetKey change and in edit mode", () => {
    const r = render(<Harness />);
    fireEvent.click(r.getByTestId("button-expand-tile-7"));
    r.rerender(<Harness resetKey="b" />);
    expect(r.getByTestId("mode").textContent).toBe("compact");
    fireEvent.click(r.getByTestId("button-expand-tile-7"));
    r.rerender(<Harness resetKey="b" enabled={false} />);
    expect(r.getByTestId("mode").textContent).toBe("compact");
  });
});

describe("modal semantics", () => {
  it("keeps the parent open when a nested layer synchronously removes itself on Escape", () => {
    const r = render(<Harness />);
    fireEvent.click(r.getByTestId("button-expand-tile-7"));
    const layer = document.createElement("div");
    layer.setAttribute("role", "dialog");
    layer.setAttribute("data-state", "open");
    r.getByTestId("tile-host-7").appendChild(layer);
    const dismissNested = () => layer.remove();
    document.addEventListener("keydown", dismissNested, { capture: true, once: true });
    fireEvent.keyDown(layer, { key: "Escape" });
    expect(r.getByTestId("mode").textContent).toBe("expanded");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(r.getByTestId("mode").textContent).toBe("compact");
  });

  it("makes everything outside the panel inert and restores it on close", () => {
    const r = render(
      <div>
        <button type="button" data-testid="outside">outside</button>
        <Harness />
      </div>,
    );
    const outside = r.getByTestId("outside");
    fireEvent.click(r.getByTestId("button-expand-tile-7"));
    expect(outside.inert).toBe(true);
    expect(r.getByTestId("tile-host-7").closest("[inert]")).toBeNull();
    fireEvent.click(r.getByTestId("button-panel-close-7"));
    expect(outside.inert).toBe(false);
  });

  it("backdrop click (host target) closes; clicks inside the frame do not", () => {
    const r = render(<Harness />);
    fireEvent.click(r.getByTestId("button-expand-tile-7"));
    fireEvent.click(r.getByTestId("panel-header-7"));
    expect(r.getByTestId("mode").textContent).toBe("expanded");
    fireEvent.click(r.getByTestId("tile-host-7"));
    expect(r.getByTestId("mode").textContent).toBe("compact");
  });

  it("is disabled entirely when the Popover API is unsupported", () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    delete proto.showPopover;
    const r = render(<Harness />);
    expect(r.queryByTestId("button-expand-tile-7")).toBeNull();
    fireEvent.click(r.getByTestId("plain"));
    expect(r.getByTestId("mode").textContent).toBe("compact");
  });

  it("dismisses when the expanded tile is removed from the tile list", () => {
    const Wrap = ({ ids }: { ids: number[] }) => (
      <TileExpansionProvider resetKey="a" validIds={ids}>
        <TileExpansionHost tileId={7} enabled title="T">
          <Counter />
        </TileExpansionHost>
      </TileExpansionProvider>
    );
    const r = render(<Wrap ids={[7]} />);
    fireEvent.click(r.getByTestId("button-expand-tile-7"));
    r.rerender(<Wrap ids={[8]} />);
    expect(r.getByTestId("mode").textContent).toBe("compact");
  });
});

describe("tile activation", () => {
  it("AppTile expands instead of navigating when enabled", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const r = render(
      <TileExpansionProvider resetKey="a" validIds={[1]}>
        <TileExpansionHost tileId={1} enabled title="T" url="https://example.test">
          <AppTile tile={tile()} />
        </TileExpansionHost>
      </TileExpansionProvider>,
    );
    fireEvent.click(r.getByText("T", { selector: "span" }));
    expect(r.getByTestId("tile-host-1").getAttribute("data-expanded")).toBe("true");
    expect(open).not.toHaveBeenCalled();
  });

  it("IntegrationTile keeps one widget wrapper across scrollable/expanded", () => {
    const t = tile({ integration: "clock" as Tile["integration"], url: null });
    const r = render(
      <TileExpansionProvider resetKey="a" validIds={[1]}>
        <TileExpansionHost tileId={1} enabled title="Clock">
          <IntegrationTile tile={t} />
        </TileExpansionHost>
      </TileExpansionProvider>,
    );
    const body = r.getByTestId("tile-host-1").querySelector(".tile-expand-body .flex-1 > div");
    fireEvent.click(r.getByTestId("button-expand-tile-1"));
    const after = r.getByTestId("tile-host-1").querySelector(".tile-expand-body .flex-1 > div");
    expect(after).toBe(body);
    expect(after?.className).toContain("min-h-0");
  });

  it("uses one visible title when an integration is expanded", () => {
    const r = render(
      <TileExpansionProvider resetKey="a" validIds={[1]}>
        <TileExpansionHost tileId={1} enabled title="Unique clock">
          <IntegrationTile tile={tile({ name: "Unique clock", integration: "clock", url: null })} />
        </TileExpansionHost>
      </TileExpansionProvider>,
    );
    expect(r.getAllByText("Unique clock")).toHaveLength(1);
    fireEvent.click(r.getByTestId("button-expand-tile-1"));
    expect(r.getAllByText("Unique clock")).toHaveLength(1);
    fireEvent.click(r.getByTestId("button-panel-close-1"));
    expect(r.getAllByText("Unique clock")).toHaveLength(1);
  });

  it("uses content flow for lists and bounded surfaces only where needed", () => {
    expect(expandedPresentation("email")).toBe("flow");
    expect(expandedPresentation("truenas")).toBe("flow");
    expect(expandedPresentation("timer")).toBe("instrument");
    expect(expandedPresentation("note")).toBe("editor");
    expect(expandedPresentation("videoplayer")).toBe("media");
    expect(expandedPresentation(null)).toBe("app");
  });
});
