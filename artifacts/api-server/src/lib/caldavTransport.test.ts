import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { InternalAxiosRequestConfig } from "axios";

// Keep Google/database initialization out of these CalDAV-only tests. tsdav,
// the shared HTTP interceptor, and the calendar event reader remain real.
vi.mock("./google.js", () => ({ getGoogleAccessToken: vi.fn() }));

const PUBLIC_IP = "8.8.8.8";
const PUBLIC_URL = "https://calendar.example/dav/";

function multistatus(href: string, props: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop>
    <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;
}

interface WireResponse {
  status?: number;
  headers?: Record<string, string>;
  data: string;
}

function davServer(options: {
  principal?: string;
  home?: string;
  calendar?: string;
  redirect?: string;
} = {}): (config: InternalAxiosRequestConfig) => WireResponse {
  const start = new Date(Date.now() + 3_600_000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:public-event\r\nSUMMARY:Public calendar event\r\nDTSTART:${start}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  return (config) => {
    const url = new URL(config.url!);
    const body = config.data?.toString() ?? "";
    if (url.pathname === "/.well-known/caldav") {
      return options.redirect
        ? { status: 301, headers: { location: options.redirect }, data: "" }
        : { status: 404, data: "" };
    }
    if (body.includes("current-user-principal")) {
      return { data: multistatus(url.pathname, `<d:current-user-principal><d:href>${options.principal ?? "/principal/"}</d:href></d:current-user-principal>`) };
    }
    if (body.includes("calendar-home-set")) {
      return { data: multistatus(url.pathname, `<c:calendar-home-set><d:href>${options.home ?? "/calendars/"}</d:href></c:calendar-home-set>`) };
    }
    if (url.pathname === "/calendars/") {
      return { data: multistatus(options.calendar ?? "/calendars/main/", "<d:displayname>Public calendar</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype>") };
    }
    if (body.includes("supported-report-set")) {
      return { data: multistatus(url.pathname, "<d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report></d:supported-report-set>") };
    }
    if (body.includes("calendar-multiget")) {
      return { data: multistatus("/calendars/main/event.ics", `<d:getetag>event-etag</d:getetag><c:calendar-data><![CDATA[${ics}]]></c:calendar-data>`) };
    }
    if (body.includes("calendar-query")) {
      return { data: multistatus("/calendars/main/event.ics", "<d:getetag>event-etag</d:getetag>") };
    }
    throw new Error(`Unexpected mocked CalDAV request: ${config.method} ${config.url}`);
  };
}

describe("CalDAV runtime public-only transport", () => {
  let unguardedFetch: ReturnType<typeof vi.fn>;
  // dns.lookup's last overload returns one address; these call sites use the
  // {all:true} overload, so describe that signature to Vitest explicitly.
  let lookupAll: Mock<(host: string, options: { all: true; verbatim: true }) => Promise<LookupAddress[]>>;

  beforeEach(() => {
    vi.resetModules();
    // No test opens a real socket. The mocked Axios adapter is the network
    // boundary; blocked requests must never reach it. This separate fetch spy
    // also catches any discovery/query that escapes tsdav's fetch override.
    unguardedFetch = vi.fn(() => {
      throw new Error("Unprotected fetch must never be used");
    });
    vi.stubGlobal("fetch", unguardedFetch);
    lookupAll = vi.spyOn(dns, "lookup") as unknown as typeof lookupAll;
    lookupAll.mockImplementation(async (hostname) => {
      const host = hostname.replace(/^\[|\]$/g, "");
      const address = net.isIP(host) ? host : host === "private.example" ? "192.168.1.10" : PUBLIC_IP;
      return [{ address, family: net.isIP(address) }];
    });
  });

  afterEach(() => {
    expect(unguardedFetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function setup(server = davServer()) {
    const { httpClient } = await import("./http.js");
    const openSocket = vi.fn(async (config: InternalAxiosRequestConfig) => {
      const response = server(config);
      return {
        status: response.status ?? 207,
        statusText: response.status === 404 ? "Not Found" : "Multi-Status",
        headers: { "content-type": "application/xml; charset=utf-8", ...response.headers },
        data: Buffer.from(response.data),
        config,
      };
    });
    httpClient.defaults.adapter = openSocket;
    const { fetchCalDavEvents } = await import("./calendar.js");
    const fetchEvents = (url = PUBLIC_URL) => fetchCalDavEvents(
      { id: "caldav-transport-test", label: "Test account", url, username: "dav-user", password: "dav-password" },
      { daysAhead: 7, max: 10, fresh: true },
    );
    return { openSocket, fetchEvents };
  }

  it.each([
    "http://127.0.0.1/dav/",
    "http://169.254.169.254/dav/",
    "http://192.168.1.10/dav/",
    "http://10.0.0.1/dav/",
    "http://[::1]/dav/",
    "http://[fd00::1]/dav/",
    "https://private.example/dav/",
  ])("blocks an initial private destination before the socket boundary: %s", async (url) => {
    const { openSocket, fetchEvents } = await setup();
    await expect(fetchEvents(url)).rejects.toThrow("That destination is not allowed.");
    expect(openSocket).not.toHaveBeenCalled();
  });

  it.each(["principal", "home", "calendar"] as const)(
    "blocks a private discovered %s href before its socket can open",
    async (stage) => {
      const { openSocket, fetchEvents } = await setup(davServer({
        [stage]: "http://192.168.1.10/internal/",
      }));
      await expect(fetchEvents()).rejects.toThrow("That destination is not allowed.");
      expect(openSocket).toHaveBeenCalled();
      for (const [config] of openSocket.mock.calls) {
        expect(new URL(config.url!).hostname).toBe("calendar.example");
      }
    },
  );

  it.each([
    "http://127.0.0.1/internal/",
    "http://169.254.169.254/latest/meta-data/",
    "https://private.example/internal/",
    "//192.168.1.10/internal/",
  ])("rejects a private .well-known redirect with no fallback: %s", async (redirect) => {
    const { openSocket, fetchEvents } = await setup(davServer({ redirect }));
    await expect(fetchEvents()).rejects.toThrow("That destination is not allowed.");
    // tsdav catches discovery failures; the sticky security error must prevent
    // its GET/root fallbacks from making any further request.
    expect(openSocket).toHaveBeenCalledTimes(1);
    expect(openSocket.mock.calls[0]![0].url).toBe("https://calendar.example/.well-known/caldav");
  });

  it("disables automatic redirects on REPORT requests", async () => {
    const normal = davServer();
    const { openSocket, fetchEvents } = await setup((config) =>
      config.method === "report"
        ? { status: 302, headers: { location: "http://192.168.1.10/internal/" }, data: "" }
        : normal(config),
    );
    await expect(fetchEvents()).rejects.toThrow("CalDAV automatic redirects are disabled.");
    expect(openSocket.mock.calls.every(([config]) => new URL(config.url!).hostname === "calendar.example")).toBe(true);
    expect(openSocket.mock.calls.every(([config]) => config.maxRedirects === 0)).toBe(true);
  });

  it("uses pinned public DNS, verified TLS, and intact DAV XML/auth for every request", async () => {
    const { openSocket, fetchEvents } = await setup();
    const events = await fetchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: "Public calendar event",
      calendar: "Public calendar",
      accountLabel: "Test account",
    });
    expect(openSocket.mock.calls.length).toBeGreaterThanOrEqual(8);
    for (const [config] of openSocket.mock.calls) {
      expect(config.ssrfPublicOnly).toBe(true);
      expect(config.maxRedirects).toBe(0);
      expect(config.proxy).toBe(false);
      expect(config.httpsAgent.options.rejectUnauthorized).toBe(true);
      expect(config.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("dav-user:dav-password").toString("base64")}`,
      );
      // Even a different future DNS answer cannot influence this lookup.
      const pinned = await new Promise((resolve, reject) => {
        config.lookup!("calendar.example", { all: false }, (error, address, family) => {
          if (error) reject(error);
          else resolve({ address, family });
        });
      });
      expect(pinned).toEqual({ address: PUBLIC_IP, family: 4 });
      if (config.method !== "get") {
        expect(config.headers.get("content-type")).toBe("text/xml;charset=UTF-8");
        expect(config.data.toString()).toContain("<?xml");
      }
    }
    const reports = openSocket.mock.calls.filter(([config]) => config.method === "report");
    expect(reports).toHaveLength(2);
    expect(reports[0]![0].data.toString()).toContain("calendar-query");
    expect(reports[1]![0].data.toString()).toContain("calendar-multiget");
  });

  it("allows public .well-known discovery redirects only through another guarded request", async () => {
    const { openSocket, fetchEvents } = await setup(davServer({ redirect: "https://dav.example/dav/" }));
    expect(await fetchEvents()).toHaveLength(1);
    expect(openSocket.mock.calls[1]![0].url).toBe("https://dav.example/dav/");
    expect(openSocket.mock.calls.every(([config]) => config.ssrfPublicOnly && config.maxRedirects === 0)).toBe(true);
  });

  it("rejects a DNS rebind to private space between requests", async () => {
    const normal = davServer();
    const { openSocket, fetchEvents } = await setup((config) => {
      const response = normal(config);
      lookupAll.mockResolvedValue([{ address: "10.0.0.8", family: 4 }]);
      return response;
    });
    await expect(fetchEvents()).rejects.toThrow("That destination is not allowed.");
    expect(openSocket).toHaveBeenCalledTimes(1);
  });

  it("rejects mixed public/private DNS answers before connecting", async () => {
    const { openSocket, fetchEvents } = await setup();
    lookupAll.mockResolvedValue([
      { address: PUBLIC_IP, family: 4 },
      { address: "192.168.1.10", family: 4 },
    ]);
    await expect(fetchEvents()).rejects.toThrow("That destination is not allowed.");
    expect(openSocket).not.toHaveBeenCalled();
  });

  it("rejects unsafe or malformed discovery redirect URLs without a fallback", async () => {
    for (const redirect of ["file:///etc/passwd", "https://user:secret@calendar.example/dav/", "http://["]) {
      const { openSocket, fetchEvents } = await setup(davServer({ redirect }));
      await expect(fetchEvents()).rejects.toThrow(/CalDAV destination/);
      expect(openSocket).toHaveBeenCalledTimes(1);
    }
  });

  it("never retries certificate failures with an insecure TLS agent", async () => {
    const { openSocket, fetchEvents } = await setup(() => {
      throw new Error("self-signed certificate");
    });
    await expect(fetchEvents()).rejects.toThrow("self-signed certificate");
    expect(openSocket).toHaveBeenCalled();
    for (const [config] of openSocket.mock.calls) {
      expect(config.httpsAgent.options.rejectUnauthorized).toBe(true);
      expect(config.ssrfPublicOnly).toBe(true);
    }
  });
});