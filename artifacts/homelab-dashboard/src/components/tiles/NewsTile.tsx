import { useGetNewsWidget, getGetNewsWidgetQueryKey } from "@workspace/api-client-react";
import type { NewsItem } from "@workspace/api-client-react";
import { Newspaper } from "lucide-react";
import type { WidgetProps } from "./IntegrationTile";
import { tileColumns, listColumnClass, listColumnStyle } from "./metrics";
import { normalizeTileUrl, openTileUrl } from "@/lib/utils";

const NEWS_DEFAULT_LIMIT = 8;

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center text-center gap-1 px-3 text-muted-foreground text-sm">
      <Newspaper className="w-5 h-5 opacity-50" />
      <span>{children}</span>
    </div>
  );
}

// Compact relative time (e.g. "5m", "3h", "2d"), falling back to a short date
// for older items. Returns null when the timestamp is missing/unparseable.
function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return "now";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function HeadlineRow({
  item,
  twoLine,
  meta,
}: {
  item: NewsItem;
  twoLine: boolean;
  meta: string | null;
}) {
  const body = (
    <>
      <div className={`text-xs leading-snug ${twoLine ? "line-clamp-2" : "truncate"}`}>
        {item.title}
      </div>
      {meta && <div className="text-[10px] text-muted-foreground truncate">{meta}</div>}
    </>
  );

  if (item.link) {
    const link = item.link;
    // Route through the shared tile URL opener so headlines honor the same
    // same-tab/new-tab behavior as every other tile link. We keep a real href
    // (so middle-click / "open in new tab" still work) but let openTileUrl
    // handle the primary click.
    return (
      <a
        href={normalizeTileUrl(link)}
        onClick={(e) => {
          e.preventDefault();
          openTileUrl(link);
        }}
        className="block space-y-0.5 hover:text-primary transition-colors cursor-pointer"
      >
        {body}
      </a>
    );
  }
  return <div className="space-y-0.5">{body}</div>;
}

export default function NewsTile({ density, tileSettings }: WidgetProps) {
  const feedUrl = (tileSettings?.newsFeedUrl ?? "").trim();
  const maxItems = tileSettings?.newsMaxItems ?? NEWS_DEFAULT_LIMIT;
  const showTimestamp = tileSettings?.newsShowTimestamp ?? false;

  // The route returns demo headlines when no URL is supplied, so we always run
  // the query — an unconfigured tile still shows representative content. The URL
  // and limit are part of the query key so distinct feeds cache separately.
  const params = { url: feedUrl || undefined, limit: maxItems };
  const { data, isLoading, isError } = useGetNewsWidget(params, {
    query: {
      queryKey: getGetNewsWidgetQueryKey(params),
      refetchInterval: 300_000,
      staleTime: 120_000,
      retry: 1,
    },
  });

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  if (isError || !data) {
    return <Placeholder>Couldn't load this feed — check the URL in settings.</Placeholder>;
  }

  if (data.items.length === 0) {
    return <Placeholder>No headlines in this feed right now.</Placeholder>;
  }

  // Density-aware reveal: small tiles show single-line titles only; as the tile
  // grows, titles get a second line plus a source/timestamp meta line. The full
  // headline list is rendered into a vertically scrollable body, so a taller
  // tile reveals more headlines at once while a short one stays scrollable.
  // Scrollable / expanded bodies always show full row detail.
  const detailed = density.scrollable || density.bodyHeight >= 150;
  const columns = tileColumns(density.bodyWidth);

  return (
    <div
      className={`w-full h-full p-3 overflow-y-auto text-foreground ${listColumnClass(columns, "flex flex-col gap-1.5")}`}
      style={listColumnStyle(columns)}
    >
      {data.items.map((item, i) => {
        const time = showTimestamp ? relativeTime(item.published) : null;
        const src = item.source || data.feedTitle || null;
        const metaParts = detailed ? [src, time].filter(Boolean) : [];
        const meta = metaParts.length > 0 ? metaParts.join(" · ") : null;
        return (
          <HeadlineRow
            key={`${item.link ?? item.title}-${i}`}
            item={item}
            twoLine={detailed}
            meta={meta}
          />
        );
      })}
    </div>
  );
}
