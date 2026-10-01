import { afterEach, describe, expect, it, vi } from "vitest";
import { GameDig } from "gamedig";
import type { QueryOptions } from "gamedig";
import { httpClient } from "./http.js";
import { queryGamePlayersDetailed } from "./gameQuery.js";

afterEach(() => vi.restoreAllMocks());

// Keep the installed QueryRunner and game catalog real. Replace only the
// individual protocol attempt, after GameDig has chosen host/address/port.
describe("public game query-port compatibility", () => {
  it.each([
    ["sdtd", 26900, 26901],
    ["dayz", 2302, 27016],
    ["enshrouded", 15636, 15637],
    ["vrising", 27015, 27030],
    ["barotrauma", 27015, 27016],
    ["arkse", 7777, 27015],
  ])("%s preserves query port %i → %i on the pinned IP", async (type, allocation, queryPort) => {
    const runner = (GameDig.getInstance() as unknown as {
      queryRunner: { _attempt: (options: QueryOptions) => Promise<unknown>; portCache: Record<string, number> };
    }).queryRunner;
    runner.portCache = {};
    const attempt = vi.spyOn(runner, "_attempt").mockImplementation(async (options) => {
      if (options.port !== queryPort) throw new Error("No game response on this port");
      return { numplayers: 2, maxplayers: 16 };
    });
    expect((await queryGamePlayersDetailed(String(type), "8.8.8.8", Number(allocation))).players)
      .toEqual({ current: 2, max: 16 });
    expect(attempt.mock.calls.some(([options]) => options.port === queryPort)).toBe(true);
    for (const [options] of attempt.mock.calls) {
      expect(options.address).toBe("8.8.8.8");
      expect(options.host).toBe("8.8.8.8");
    }
  });

  it("Eco tries its offset then allocation port, using the guard for both", async () => {
    const get = vi.spyOn(httpClient, "get")
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ data: { Info: { OnlinePlayers: 2, TotalPlayers: 8 } } });
    expect((await queryGamePlayersDetailed("eco", "8.8.8.8", 3000)).players).toEqual({ current: 2, max: 8 });
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      "http://8.8.8.8:3001/frontpage", "http://8.8.8.8:3000/frontpage",
    ]);
    for (const [, config] of get.mock.calls) {
      expect(config).toMatchObject({ ssrfPublicOnly: true, maxRedirects: 0, proxy: false });
    }
  });
});