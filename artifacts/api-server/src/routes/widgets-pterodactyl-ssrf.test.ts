import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import express from "express";
import request from "supertest";
import dns from "node:dns/promises";
import { httpClient } from "../lib/http.js";

// Keep gameQuery, outboundTargets, and the HTTP IP classifier real. Only the
// network boundaries and stored panel configuration are replaced.
const { findByService, gameDigQuery } = vi.hoisted(() => ({
  findByService: vi.fn(),
  gameDigQuery: vi.fn(),
}));

vi.mock("gamedig", () => ({
  GameDig: { query: gameDigQuery },
}));

vi.mock("../lib/auth.js", () => ({
  requireAuth: (req: { user?: { userId: number } }, _res: unknown, next: () => void) => {
    req.user = { userId: 1 };
    next();
  },
  verifyToken: vi.fn(),
}));

vi.mock("../lib/db.js", () => ({
  connectionStmts: {
    findByService: { get: findByService },
    upsert: { run: vi.fn() },
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { default: widgetsRouter } = await import("./widgets.js");
const httpGet = vi.spyOn(httpClient, "get");
// Vitest infers lookup's single-address overload; the guard always uses all:true.
const dnsLookup = vi.spyOn(dns, "lookup") as unknown as MockInstance<
  (host: string, options: { all: true; verbatim: true }) => Promise<DnsAnswer[]>
>;
const app = express();
app.use("/widgets", widgetsRouter);

const panelUrl = "https://panel.example.com";
const sources = ["allocation IP", "allocation alias", "SFTP host"] as const;
type Source = (typeof sources)[number];
type DnsAnswer = { address: string; family: number };

function serverFixture({
  ip = "",
  alias = "",
  sftp = "",
  port = 25565,
} = {}) {
  return {
    identifier: "ssrf1234",
    name: "Minecraft SSRF regression",
    limits: { memory: 4096 },
    sftp_details: { ip: sftp },
    relationships: {
      allocations: {
        data: [{ attributes: { ip, ip_alias: alias, port, is_default: true } }],
      },
    },
  };
}

function fixtureForSource(source: Source, host: string, port = 25565) {
  switch (source) {
    case "allocation IP": return serverFixture({ ip: host, port });
    case "allocation alias": return serverFixture({ alias: host, port });
    case "SFTP host": return serverFixture({ sftp: host, port });
  }
}

function stubPanel(server: ReturnType<typeof serverFixture>) {
  httpGet
    .mockResolvedValueOnce({ data: { data: [{ attributes: server }] } })
    .mockResolvedValueOnce({
      data: {
        attributes: {
          current_state: "running",
          resources: { cpu_absolute: 10, memory_bytes: 1024 * 1024 },
        },
      },
    });
}

beforeEach(() => {
  findByService.mockReset();
  findByService.mockReturnValue({
    service: "pterodactyl",
    url: panelUrl,
    api_key: "ptlc_test",
    username: null,
    password: null,
    extra: null,
  });
  httpGet.mockReset();
  httpGet.mockRejectedValue(new Error("Unexpected panel HTTP request"));
  dnsLookup.mockReset();
  dnsLookup.mockRejectedValue(new Error("Unexpected DNS lookup"));
  gameDigQuery.mockReset();
  // A permissive success stub makes missing validation fail immediately rather
  // than being hidden by an unrelated game-query timeout.
  gameDigQuery.mockResolvedValue({ numplayers: 3, maxplayers: 20 });
});

const blockedLiterals = [
  "10.0.0.5",
  "172.16.0.5",
  "192.168.1.10",
  "100.64.0.5",
  "127.0.0.1",
  "169.254.169.254",
  "::1",
  "[::1]",
  "fd00::1",
  "fe80::1",
  "::ffff:7f00:1",
  "0:0:0:0:0:ffff:c0a8:10a",
  "64:ff9b::a9fe:a9fe",
];

const blockedDnsCases: Array<{ label: string; answers: DnsAnswer[] }> = [
  { label: "private IPv4", answers: [{ address: "10.0.0.5", family: 4 }] },
  { label: "loopback IPv4", answers: [{ address: "127.0.0.1", family: 4 }] },
  { label: "link-local metadata", answers: [{ address: "169.254.169.254", family: 4 }] },
  { label: "private IPv6", answers: [{ address: "fd00::1", family: 6 }] },
  { label: "loopback IPv6", answers: [{ address: "::1", family: 6 }] },
  { label: "link-local IPv6", answers: [{ address: "fe80::1", family: 6 }] },
  {
    label: "public IPv4 followed by private IPv4",
    answers: [{ address: "8.8.8.8", family: 4 }, { address: "192.168.1.10", family: 4 }],
  },
  {
    label: "loopback IPv4 followed by public IPv4",
    answers: [{ address: "127.0.0.1", family: 4 }, { address: "8.8.8.8", family: 4 }],
  },
  {
    label: "public IPv4 followed by link-local IPv6",
    answers: [{ address: "8.8.8.8", family: 4 }, { address: "fe80::1", family: 6 }],
  },
  {
    label: "public IPv6 followed by private IPv4",
    answers: [{ address: "2001:4860:4860::8888", family: 6 }, { address: "10.0.0.5", family: 4 }],
  },
];

for (const route of ["/pterodactyl", "/pterodactyl/diagnostics"] as const) {
  const diagnostics = route.endsWith("/diagnostics");

  describe(`GET /widgets${route} game-query SSRF guard`, () => {
    async function fetchServer() {
      const res = await request(app).get(`/widgets${route}`);
      expect(res.status).toBe(200);
      expect(res.body.servers).toHaveLength(1);
      expect(res.body.servers[0]).toMatchObject({ id: "ssrf1234", state: "running" });
      if (diagnostics) expect(res.body.configured).toBe(true);
      expect(findByService).toHaveBeenCalledWith(1, "pterodactyl");
      expect(httpGet).toHaveBeenCalledTimes(2);
      expect(httpGet.mock.calls.map(([url]) => url)).toEqual([
        `${panelUrl}/api/client`,
        `${panelUrl}/api/client/servers/ssrf1234/resources`,
      ]);
      return res.body.servers[0];
    }

    function expectBlocked(server: Awaited<ReturnType<typeof fetchServer>>, reason = "unreachable") {
      if (diagnostics) {
        expect(server.outcome).toMatchObject({ players: null, reason });
        if (reason === "unreachable") {
          expect(server.outcome.attempts).not.toHaveLength(0);
          for (const attempt of server.outcome.attempts) {
            expect(attempt.outcome).toMatch(/^unreachable: That destination is not allowed\./);
          }
        }
      } else {
        expect(server).toMatchObject({ players: null, playersUnavailableReason: reason });
      }
      expect(gameDigQuery).not.toHaveBeenCalled();
    }

    for (const source of sources) {
      describe(source, () => {
        it.each(blockedLiterals)("does not query blocked literal %s", async (host) => {
          stubPanel(fixtureForSource(source, host));
          // The existing route planner omits obvious loopback/unspecified raw
          // allocations. Alias and SFTP variants must reach the real guard.
          const omittedByPlanner = source === "allocation IP" && /^(0\.0\.0\.0|127\.|::)/.test(host);
          const server = await fetchServer();
          expectBlocked(server, omittedByPlanner ? "no-allocation" : "unreachable");
          if (diagnostics) {
            expect(server.candidates).toEqual(omittedByPlanner ? [] : [{ host, port: 25565 }]);
          }
          expect(dnsLookup).not.toHaveBeenCalled();
        });

        it.each(blockedDnsCases)("rejects domain DNS with $label", async ({ answers }) => {
          const host = "game.example.com";
          stubPanel(fixtureForSource(source, host));
          dnsLookup.mockResolvedValue(answers);
          expectBlocked(await fetchServer());
          expect(dnsLookup).toHaveBeenCalledExactlyOnceWith(host, { all: true, verbatim: true });
        });

        it.each([
          { host: "8.8.8.8", address: "8.8.8.8", family: 4 },
          { host: "2001:4860:4860::8888", address: "2001:4860:4860::8888", family: 6 },
          { host: "game.example.com", address: "8.8.8.8", family: 4 },
          { host: "ipv6.example.com", address: "2001:4860:4860::8888", family: 6 },
        ])("returns players for public $host using pinned $address", async ({ host, address, family }) => {
          stubPanel(fixtureForSource(source, host));
          // A second lookup would return loopback: only the validated answer
          // may be handed to GameDig, never a hostname-only connection.
          dnsLookup
            .mockResolvedValueOnce([{ address, family }])
            .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
          const server = await fetchServer();
          if (diagnostics) {
            expect(server.outcome).toEqual({
              players: { current: 3, max: 20 },
              reason: null,
              attempts: [{ host, port: 25565, outcome: "ok" }],
            });
          } else {
            expect(server).toMatchObject({
              players: { current: 3, max: 20 },
              playersUnavailableReason: null,
            });
          }
          expect(gameDigQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            type: "minecraft",
            host,
            address,
            port: 25565,
            givenPortOnly: false,
          }));
          if (host.endsWith(".example.com")) {
            expect(dnsLookup).toHaveBeenCalledExactlyOnceWith(host, { all: true, verbatim: true });
          } else {
            expect(dnsLookup).not.toHaveBeenCalled();
          }
        });
      });
    }

    it("blocks every alias, allocation, SFTP, and standard-port fallback", async () => {
      stubPanel(serverFixture({
        alias: "alias.example.com",
        ip: "192.168.1.10",
        sftp: "169.254.169.254",
        port: 25566,
      }));
      dnsLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
      const server = await fetchServer();
      expectBlocked(server);
      expect(dnsLookup).toHaveBeenCalledTimes(2);
      if (diagnostics) {
        expect(server.candidates).toEqual([
          { host: "alias.example.com", port: 25566 },
          { host: "192.168.1.10", port: 25566 },
          { host: "169.254.169.254", port: 25566 },
          { host: "alias.example.com", port: 25565 },
        ]);
        expect(server.outcome.attempts).toHaveLength(4);
      }
    });

    it("skips a blocked alias but can succeed on a validated public allocation", async () => {
      stubPanel(serverFixture({ alias: "127.0.0.1", ip: "8.8.8.8", sftp: "169.254.169.254" }));
      const server = await fetchServer();
      expect(gameDigQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        host: "8.8.8.8", address: "8.8.8.8", port: 25565, givenPortOnly: false,
      }));
      expect(dnsLookup).not.toHaveBeenCalled();
      if (diagnostics) {
        expect(server.outcome.players).toEqual({ current: 3, max: 20 });
        expect(server.outcome.reason).toBeNull();
        expect(server.outcome.attempts).toEqual([
          { host: "127.0.0.1", port: 25565, outcome: "unreachable: That destination is not allowed." },
          { host: "8.8.8.8", port: 25565, outcome: "ok" },
        ]);
      } else {
        expect(server).toMatchObject({
          players: { current: 3, max: 20 }, playersUnavailableReason: null,
        });
      }
    });
  });
}