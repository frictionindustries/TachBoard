import { useEffect, useState } from "react";
import {
  useGetWeatherWidget,
  getGetWeatherWidgetQueryKey,
  ApiError,
  type GetWeatherWidgetParams,
} from "@workspace/api-client-react";
import {
  Sun,
  Moon,
  Cloud,
  CloudSun,
  CloudMoon,
  CloudFog,
  CloudDrizzle,
  CloudRain,
  CloudSnow,
  CloudLightning,
  MapPin,
  type LucideIcon,
} from "lucide-react";
import type { WidgetProps } from "./IntegrationTile";

// Map a WMO weather code (Open-Meteo) to a human label and an icon. The icon
// branches on day/night for the clear and partly-cloudy codes.
function weatherInfo(code: number, isDay: boolean): { label: string; Icon: LucideIcon } {
  switch (code) {
    case 0:
      return { label: "Clear sky", Icon: isDay ? Sun : Moon };
    case 1:
      return { label: "Mainly clear", Icon: isDay ? CloudSun : CloudMoon };
    case 2:
      return { label: "Partly cloudy", Icon: isDay ? CloudSun : CloudMoon };
    case 3:
      return { label: "Overcast", Icon: Cloud };
    case 45:
    case 48:
      return { label: "Fog", Icon: CloudFog };
    case 51:
    case 53:
    case 55:
      return { label: "Drizzle", Icon: CloudDrizzle };
    case 56:
    case 57:
      return { label: "Freezing drizzle", Icon: CloudDrizzle };
    case 61:
    case 63:
    case 65:
      return { label: "Rain", Icon: CloudRain };
    case 66:
    case 67:
      return { label: "Freezing rain", Icon: CloudRain };
    case 71:
    case 73:
    case 75:
    case 77:
      return { label: "Snow", Icon: CloudSnow };
    case 80:
    case 81:
    case 82:
      return { label: "Rain showers", Icon: CloudRain };
    case 85:
    case 86:
      return { label: "Snow showers", Icon: CloudSnow };
    case 95:
      return { label: "Thunderstorm", Icon: CloudLightning };
    case 96:
    case 99:
      return { label: "Thunderstorm, hail", Icon: CloudLightning };
    default:
      return { label: "—", Icon: Cloud };
  }
}

type Target =
  | { kind: "coords"; lat: number; lon: number }
  | { kind: "city"; name: string };

// Pull the server's specific error message out of a failed request. The API
// returns { error: "..." } bodies; fall back to a generic label otherwise.
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string } | null;
    if (data && typeof data.error === "string" && data.error.trim()) return data.error;
  }
  if (err instanceof Error && err.message) return err.message;
  return "Weather unavailable";
}

// Short weekday label for a YYYY-MM-DD date string (parsed as local time).
function weekdayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

function Prompt({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full h-full flex flex-col items-center justify-center text-center gap-1 px-3 text-muted-foreground text-sm">
      <MapPin className="w-5 h-5 opacity-50" />
      <span>{children}</span>
    </div>
  );
}

export default function WeatherTile({ density, tileSettings }: WidgetProps) {
  const autoLocate = tileSettings?.weatherAutoLocate ?? true;
  const typedLocation = (tileSettings?.weatherLocation ?? "").trim();
  const units = tileSettings?.weatherUnits ?? "c";

  // Browser geolocation (only when auto-detect is on). On denial/unavailability
  // we fall back to the typed city if one is set, otherwise prompt for one.
  const [browserCoords, setBrowserCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [geoDenied, setGeoDenied] = useState(false);

  useEffect(() => {
    if (!autoLocate) {
      setBrowserCoords(null);
      setGeoDenied(false);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoDenied(true);
      return;
    }
    let cancelled = false;
    setGeoDenied(false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!cancelled)
          setBrowserCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
      },
      () => {
        if (!cancelled) setGeoDenied(true);
      },
      { timeout: 10_000, maximumAge: 600_000 },
    );
    return () => {
      cancelled = true;
    };
  }, [autoLocate]);

  const cityAvailable = typedLocation.length > 0;

  let target: Target | null = null;
  if (autoLocate && browserCoords) {
    target = { kind: "coords", ...browserCoords };
  } else if (!autoLocate && cityAvailable) {
    target = { kind: "city", name: typedLocation };
  } else if (autoLocate && geoDenied && cityAvailable) {
    target = { kind: "city", name: typedLocation };
  }

  const detecting = autoLocate && !browserCoords && !geoDenied && !cityAvailable;
  const needCity =
    (!autoLocate && !cityAvailable) || (autoLocate && geoDenied && !cityAvailable);

  // Fetch through the app's own API — the server does geocoding, reverse
  // geocoding, and the forecast call, so the browser never hits third parties.
  const params: GetWeatherWidgetParams = { units };
  if (target?.kind === "coords") {
    params.lat = target.lat;
    params.lon = target.lon;
  } else if (target?.kind === "city") {
    params.city = target.name;
  }

  const query = useGetWeatherWidget(params, {
    query: {
      queryKey: getGetWeatherWidgetQueryKey(params),
      enabled: target !== null,
      refetchInterval: 600_000,
      staleTime: 300_000,
      retry: 1,
    },
  });

  if (needCity) {
    return (
      <Prompt>
        {autoLocate
          ? "Location unavailable — enter a city in this tile's settings."
          : "Enter a city in this tile's settings."}
      </Prompt>
    );
  }

  if (detecting || (query.isLoading && target !== null)) {
    return (
      <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">
        {detecting ? "Detecting location…" : "Loading…"}
      </div>
    );
  }

  if (query.isError || !query.data) {
    return <Prompt>{errorMessage(query.error)}</Prompt>;
  }

  const data = query.data;
  const { label, Icon } = weatherInfo(data.code, data.isDay);
  const unit = units === "f" ? "°F" : "°C";
  const round = (n: number) => Math.round(n);

  // The icon/temperature and city name always show; the extra "feels like / high
  // · low" line is revealed only when the measured body has room for it, so the
  // tile fills its space without ever overflowing.
  const showDetail = density.scrollable || density.bodyHeight >= 122;

  const upcoming = data.forecast.slice(1);

  // Layout mode is threshold-based on the measured body:
  //   - "row":  clearly wide → forecast is a vertical day list BESIDE the
  //             current conditions, each side filling half the tile.
  //   - "list": clearly tall → forecast is a vertical day list BELOW the
  //             current conditions, spreading to fill the remaining height
  //             (works even on narrow tiles where the strip can't fit).
  //   - "col":  everything else → the original horizontal strip below.
  let layoutMode: "row" | "list" | "col";
  if (density.bodyWidth >= 340 && density.bodyWidth > density.bodyHeight * 1.2) {
    layoutMode = "row";
  } else if (
    density.bodyHeight >= 280 &&
    density.bodyHeight > density.bodyWidth * 0.9 &&
    density.bodyWidth >= 140
  ) {
    layoutMode = "list";
  } else {
    layoutMode = "col";
  }

  // On roomy tiles the whole block scales up so the content fills the space
  // instead of floating in a corner.
  const big = density.bodyHeight >= 240 && density.bodyWidth >= 280;

  // Col mode: the number of days shown adapts to the tile's width (3–5 days),
  // and the strip is only revealed when there's enough height to fit it.
  const fitDays = Math.floor((density.bodyWidth - 8) / 54);
  // Scrollable/expanded: every forecast day the API returned.
  const numColDays = density.scrollable ? upcoming.length : Math.max(3, Math.min(5, fitDays));

  // Row/list modes: days stack vertically, so the count is height-driven and
  // capped at the API's available days. List mode reserves ~150px for the
  // current-conditions block above the list.
  const numRowDays = density.scrollable ? upcoming.length : Math.min(
    upcoming.length,
    Math.max(2, Math.floor((density.bodyHeight - 20) / 26)),
  );
  const numListDays = density.scrollable ? upcoming.length : Math.min(
    upcoming.length,
    Math.max(3, Math.floor((density.bodyHeight - 150) / 30)),
  );

  const days = upcoming.slice(
    0,
    layoutMode === "row" ? numRowDays : layoutMode === "list" ? numListDays : numColDays,
  );
  const showForecast =
    layoutMode === "col"
      ? (density.scrollable || (density.bodyHeight >= 210 && density.bodyWidth >= 200)) && days.length >= 3
      : days.length >= 2;

  const current = (
    <>
      <div className={`flex items-center ${big ? "gap-4" : "gap-3"}`}>
        <Icon className={`${big ? "w-14 h-14" : "w-9 h-9"} flex-shrink-0 text-primary`} />
        <div className="min-w-0">
          <div
            className={`${big ? "text-5xl" : "text-3xl"} font-bold leading-none tabular-nums`}
          >
            {round(data.temp)}
            {unit}
          </div>
          <div className={`${big ? "text-sm" : "text-xs"} text-muted-foreground truncate`}>
            {label}
          </div>
        </div>
      </div>

      <div className={`${big ? "text-base" : "text-sm"} font-medium truncate max-w-full`}>
        {data.name}
      </div>

      {showDetail && (
        <div
          className={`flex items-center gap-3 ${big ? "text-sm" : "text-xs"} text-muted-foreground pt-0.5`}
        >
          <span className="tabular-nums">Feels {round(data.feels)}{unit}</span>
          {data.high != null && data.low != null && (
            <span className="tabular-nums">
              H {round(data.high)}° · L {round(data.low)}°
            </span>
          )}
        </div>
      )}
    </>
  );

  // One forecast day as a horizontal line (day · icon · high/low pushed to the
  // right edge) — used by both the row and list layouts so the line fills
  // whatever width its column has.
  const dayLine = (day: (typeof upcoming)[number], bigRow: boolean) => {
    const { Icon: DayIcon, label: dayLabel } = weatherInfo(day.code, true);
    return (
      <div
        key={day.date}
        className={`grid ${bigRow ? "grid-cols-[3rem_1fr_auto]" : "grid-cols-[2rem_1fr_auto]"} items-center gap-2 leading-tight min-w-0`}
      >
        <span
          className={`${bigRow ? "text-sm" : "text-[11px]"} font-medium text-muted-foreground`}
        >
          {weekdayLabel(day.date)}
        </span>
        <DayIcon
          className={`${bigRow ? "w-6 h-6" : "w-4 h-4"} justify-self-center text-primary`}
          aria-label={dayLabel}
        />
        <span className={`tabular-nums ${bigRow ? "text-sm" : "text-[11px]"} truncate`}>
          {day.high != null ? round(day.high) : "—"}°
          <span className="text-muted-foreground">
            {" "}
            {day.low != null ? round(day.low) : "—"}°
          </span>
        </span>
      </div>
    );
  };

  if (layoutMode === "row" && showForecast) {
    // Rows get bigger when each one has generous vertical space.
    const perRow = (density.bodyHeight - 24) / days.length;
    const bigRow = big || perRow >= 38;
    return (
      <div className="w-full h-full flex flex-row items-stretch p-3 gap-3 text-foreground overflow-hidden">
        <div className="flex-1 min-w-0 flex flex-col justify-center items-center text-center gap-1">
          {current}
        </div>
        <div
          data-testid="weather-forecast-row"
          className="flex-1 min-w-0 flex flex-col justify-evenly border-l border-border/50 pl-3"
        >
          {days.map((day) => dayLine(day, bigRow))}
        </div>
      </div>
    );
  }

  if (layoutMode === "list" && showForecast) {
    const perRow = (density.bodyHeight - 150) / days.length;
    const bigRow = big || perRow >= 38;
    return (
      <div className="w-full h-full flex flex-col p-3 gap-1 text-foreground overflow-hidden">
        <div className="flex-none flex flex-col gap-1 py-1">{current}</div>
        <div
          data-testid="weather-forecast-list"
          className="flex-1 min-h-0 flex flex-col justify-evenly border-t border-border/50 mt-2 pt-1"
        >
          {days.map((day) => dayLine(day, bigRow))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col justify-center p-3 gap-1 text-foreground">
      {current}

      {layoutMode === "col" && showForecast && (
        <div
          data-testid="weather-forecast-col"
          className={`flex gap-1 pt-2 mt-1 border-t border-border/50 ${density.scrollable ? "flex-wrap" : ""}`}
        >
          {days.map((day) => {
            const { Icon: DayIcon, label: dayLabel } = weatherInfo(day.code, true);
            return (
              <div
                key={day.date}
                className="flex-1 min-w-0 flex flex-col items-center gap-1 text-center"
              >
                <span className="text-[11px] font-medium text-muted-foreground">
                  {weekdayLabel(day.date)}
                </span>
                <DayIcon className="w-5 h-5 text-primary" aria-label={dayLabel} />
                <span className="text-[11px] tabular-nums leading-tight">
                  {day.high != null ? round(day.high) : "—"}°
                  <span className="text-muted-foreground">
                    {" "}
                    {day.low != null ? round(day.low) : "—"}°
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
