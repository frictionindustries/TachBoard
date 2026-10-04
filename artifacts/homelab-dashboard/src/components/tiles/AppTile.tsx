import type { Tile } from "@workspace/api-client-react";
import { ExternalLink } from "lucide-react";
import { openTileUrl } from "@/lib/utils";
import { useTileExpansion } from "./expansion";
import { resolveImageStyle, resolveTitleStyle } from "./imageStyle";

interface AppTileProps {
  tile: Tile;
}

export default function AppTile({ tile }: AppTileProps) {
  const expansion = useTileExpansion();
  const hasImage = Boolean(tile.imageUrl);
  // No explicit per-tile color → follow the active theme's card surface.
  const bg = tile.bgColor || "hsl(var(--card))";

  const image = resolveImageStyle(tile);
  const title = resolveTitleStyle(tile);

  // When enabled, the tile body scrolls instead of clipping overflowing
  // content. The image background layer keeps its own overflow-hidden below so
  // pan/zoom framing is unaffected.
  const scrollable = Boolean(tile.tileSettings?.scrollable);

  return (
    <div
      className={`w-full h-full ${scrollable ? "overflow-auto" : "overflow-hidden"} flex flex-col items-center justify-center relative group cursor-pointer select-none`}
      style={{ background: bg }}
      onClick={() => {
        if (expansion.canExpand && !expansion.expanded) expansion.requestExpand();
        else openTileUrl(tile.url);
      }}
    >
      {hasImage && (
        <div className={`${image.wrapperClassName} overflow-hidden`} style={image.wrapperStyle}>
          <img
            src={tile.imageUrl!}
            alt={tile.name || "tile"}
            className={image.className}
            style={image.style}
            draggable={false}
          />
        </div>
      )}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />

      <div
        className={`absolute inset-0 z-10 flex flex-col gap-1 p-2 ${title.containerClass}`}
      >
        {tile.name && !tile.hideTitle && !expansion.expanded && (
          <span
            className={`font-bold leading-tight tracking-wide drop-shadow-sm max-w-full truncate ${title.sizeClass} ${title.textAlignClass}`}
            style={{ color: tile.titleColor || (hasImage ? "#fff" : "hsl(var(--card-foreground))") }}
          >
            {tile.name}
          </span>
        )}
        {tile.url && !expansion.expanded && (
          <span
            className={`text-xs opacity-60 truncate max-w-full hidden group-hover:block ${title.textAlignClass}`}
            style={{ color: hasImage ? "#fff" : "hsl(var(--card-foreground))" }}
          >
            <ExternalLink className="inline w-3 h-3 mr-0.5" />
            Open
          </span>
        )}
      </div>
    </div>
  );
}
