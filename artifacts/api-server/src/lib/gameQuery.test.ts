import { beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";
import { GameDig } from "gamedig";
import { httpClient } from "./http.js";
import { queryGamePlayersDetailed } from "./gameQuery.js";
import { resolvePublicHost, validateOutboundPort } from "./outboundTargets.js";

vi.mock("gamedig", () => ({ GameDig: { query: vi.fn() } }));
vi.mock("node:dns/promises", () => ({ default: { lookup: vi.fn() } }));
vi.mock("./logger.js", () => ({ logger: { debug: vi.fn() } }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(dns.lookup).mockReset();
  vi.mocked(GameDig.query).mockReset();
});

describe("public socket destinations", () => {
  it.each([
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.0.1", "100.64.0.1",
    "169.254.169.254", "::1", "fd00::1", "fe80::1", "ff02::1", "fec0::1",
    "::ffff:7f00:1", "::ffff:c0a8:1", "64:ff9b::a00:1", "2002:7f00:1::",
    "::192.168.0.1", "[::1]",
  ])("blocks %s before querying", async (host) => {
    const result = await queryGamePlayersDetailed("minecraft", host, 25565);
    expect(result).toMatchObject({ players: null, reason: "unreachable" });
    expect(GameDig.query).not.toHaveBeenCalled();
  });

  it.each(["host/path", "user@host", "host:123", "host\\path", "host%00", "", " host", "[invalid]"])(
    "rejects malformed host %s", async (host) => {
      await expect(resolvePublicHost(host)).rejects.toThrow();
      expect(dns.lookup).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 65536, 1.5, NaN, Infinity])("rejects invalid port %s", (port) => {
    expect(() => validateOutboundPort(port)).toThrow();
  });

  it("rejects mixed DNS answers and DNS failures before querying", async () => {
    vi.mocked(dns.lookup).mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 },
    ] as never).mockRejectedValueOnce(new Error("ENOTFOUND"));
    for (let n = 0; n < 2; n++) {
      expect((await queryGamePlayersDetailed("minecraft", "games.example.com", 25565)).players).toBeNull();
    }
    expect(GameDig.query).not.toHaveBeenCalled();
  });

  it("pins a public IP, bypasses SRV, and rechecks DNS on the next query", async () => {
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    vi.mocked(GameDig.query).mockResolvedValue({ numplayers: 3, maxplayers: 10 } as never);
    expect((await queryGamePlayersDetailed("minecraft", "games.example.com", 25565)).players)
      .toEqual({ current: 3, max: 10 });
    expect(GameDig.query).toHaveBeenCalledWith(expect.objectContaining({
      host: "games.example.com", address: "8.8.8.8", port: 25565, givenPortOnly: false,
    }));
    expect((await queryGamePlayersDetailed("minecraft", "games.example.com", 25565)).players).toBeNull();
    expect(GameDig.query).toHaveBeenCalledTimes(1);
  });

  it("blocks unapproved GameDig protocol paths", async () => {
    expect((await queryGamePlayersDetailed("protocol-http", "8.8.8.8", 80)).players).toBeNull();
    expect(GameDig.query).not.toHaveBeenCalled();
  });
});

describe("HTTP game protocols", () => {
  it("uses guarded HTTP for Eco instead of GameDig's redirect-following client", async () => {
    const get = vi.spyOn(httpClient, "get").mockResolvedValue({
      data: { Info: { OnlinePlayers: 2, TotalPlayers: 8 } },
    });
    expect((await queryGamePlayersDetailed("eco", "8.8.8.8", 3000)).players).toEqual({ current: 2, max: 8 });
    expect(get).toHaveBeenCalledWith("http://8.8.8.8:3001/frontpage", expect.objectContaining({
      ssrfPublicOnly: true, maxRedirects: 0, proxy: false,
    }));
    expect(GameDig.query).not.toHaveBeenCalled();
  });

  it("uses guarded HTTP for both Satisfactory login and state", async () => {
    const post = vi.spyOn(httpClient, "post")
      .mockResolvedValueOnce({ data: { data: { authenticationToken: "test-token" } } })
      .mockResolvedValueOnce({ data: { data: { serverGameState: { numConnectedPlayers: 1, playerLimit: 4 } } } });
    expect((await queryGamePlayersDetailed("satisfactory", "8.8.8.8", 7777)).players).toEqual({ current: 1, max: 4 });
    expect(post).toHaveBeenCalledTimes(2);
    for (const call of post.mock.calls) {
      expect(call[2]).toMatchObject({ ssrfPublicOnly: true, maxRedirects: 0, proxy: false });
    }
    expect(GameDig.query).not.toHaveBeenCalled();
  });

  it("does not follow HTTP redirects to another destination", async () => {
    const adapter = vi.fn().mockRejectedValue(new Error("Request failed with status code 302"));
    const original = httpClient.defaults.adapter;
    httpClient.defaults.adapter = adapter;
    vi.mocked(dns.lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    try {
      expect((await queryGamePlayersDetailed("eco", "8.8.8.8", 3001)).players).toBeNull();
      expect(adapter).toHaveBeenCalledTimes(2);
      expect(adapter.mock.calls[0]![0]).toMatchObject({ maxRedirects: 0, ssrfPublicOnly: true });
    } finally {
      httpClient.defaults.adapter = original;
    }
  });
});