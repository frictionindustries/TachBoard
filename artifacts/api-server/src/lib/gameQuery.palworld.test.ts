import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";
import http, { type IncomingMessage, type RequestOptions } from "node:http";
import https from "node:https";
import net from "node:net";
import { PassThrough, Writable } from "node:stream";
import { GameDig } from "gamedig";
import { queryGamePlayersDetailed } from "./gameQuery.js";

// Neither GameDig nor axios is mocked. The real axios HTTP adapter runs all
// interceptors and constructs a native request; only that last I/O boundary
// returns in-memory streams. The socket tripwire also catches GameDig's TCP
// ping if Palworld is accidentally delegated back to the installed library.
const publicAnswers = [
  { address: "8.8.8.8", family: 4 },
  { address: "1.1.1.1", family: 4 },
];
const privateAnswers = [{ address: "192.168.1.10", family: 4 }];
const hostname = "palworld.example.com";
const port = 8212;

type LookupResult = string | Array<{ address: string; family: number }>;
type BoundaryLookup = (
  host: string,
  options: { all: boolean },
  callback: (error: NodeJS.ErrnoException | null, address: LookupResult, family?: number) => void,
) => void;

interface CapturedRequest {
  options: RequestOptions;
  single?: { address: LookupResult; family?: number };
  all?: { address: LookupResult; family?: number };
}

let requests: CapturedRequest[];
let responseStatus: number;
let responseHeaders: Record<string, string>;
let responseBody: string;

function readPinnedLookup(lookup: BoundaryLookup, host: string, all: boolean) {
  return new Promise<{ address: LookupResult; family?: number }>((resolve, reject) => {
    lookup(host, { all }, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

class MemoryRequest extends Writable {
  constructor(private readonly captured: CapturedRequest) {
    super({ autoDestroy: false });
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    callback();
  }

  override _final(callback: (error?: Error | null) => void) {
    callback();
    // Give the real adapter time to install response/error listeners.
    queueMicrotask(() => {
      void this.respond().catch((error: Error) => this.destroy(error));
    });
  }

  setTimeout(_milliseconds: number, _callback?: () => void) {
    return this;
  }

  private async respond() {
    const { options } = this.captured;
    if (options.lookup) {
      const lookup = options.lookup as unknown as BoundaryLookup;
      const host = String(options.hostname ?? options.host);
      // Exercise both Node lookup calling conventions at the actual native
      // request boundary, not by inspecting a mocked axios config.
      this.captured.single = await readPinnedLookup(lookup, host, false);
      this.captured.all = await readPinnedLookup(lookup, host, true);
    }
    if (this.destroyed) return;
    const response = Object.assign(new PassThrough(), {
      statusCode: responseStatus,
      statusMessage: responseStatus === 200 ? "OK" : "Found",
      headers: { "content-type": "application/json", ...responseHeaders },
      req: this,
    });
    this.emit("response", response);
    response.end(responseBody);
  }
}

function expectNoGameDigOrSockets() {
  expect(GameDig.query).not.toHaveBeenCalled();
  expect(net.Socket.prototype.connect).not.toHaveBeenCalled();
  expect(https.request).not.toHaveBeenCalled();
}

beforeEach(() => {
  requests = [];
  responseStatus = 200;
  responseHeaders = {};
  responseBody = JSON.stringify({ currentplayernum: 3, maxplayernum: 32 });

  // A spy with no replacement implementation calls the REAL installed GameDig.
  vi.spyOn(GameDig, "query");
  vi.spyOn(dns, "lookup").mockRejectedValue(new Error("Unexpected DNS lookup in Palworld test"));
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("Live socket connections are forbidden in Palworld tests");
  });
  vi.spyOn(https, "request").mockImplementation(() => {
    throw new Error("Unexpected HTTPS request in Palworld tests");
  });
  vi.spyOn(http, "request").mockImplementation(((
    options: RequestOptions,
    callback?: (response: IncomingMessage) => void,
  ) => {
    const captured: CapturedRequest = { options };
    requests.push(captured);
    const request = new MemoryRequest(captured);
    if (callback) request.once("response", callback);
    return request;
  }) as unknown as typeof http.request);

  // A poisoned environment must not override the checked game destination.
  vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9999");
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9999");
  vi.stubEnv("ALL_PROXY", "http://127.0.0.1:9999");
  vi.stubEnv("NO_PROXY", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("HTTP games use the guarded real transport, never GameDig's Got path", () => {
  it("Eco reaches its allocation+1 query port through the real pinned HTTP adapter", async () => {
    vi.mocked(dns.lookup).mockResolvedValue(publicAnswers as never);
    responseBody = JSON.stringify({ Info: { OnlinePlayers: 2, TotalPlayers: 8 } });
    expect((await queryGamePlayersDetailed("eco", hostname, 3000)).players)
      .toEqual({ current: 2, max: 8 });
    expect(requests).toHaveLength(1);
    expect(Number(requests[0]!.options.port)).toBe(3001);
    expect(requests[0]!.options.path).toBe("/frontpage");
    expect(requests[0]!.single?.address).toBe("8.8.8.8");
    expectNoGameDigOrSockets();
  });

  it.each([
    "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.10",
    "100.64.0.1", "169.254.169.254", "::1", "fd00::1",
    "::ffff:c0a8:10a", "[::1]",
  ])("denies private host %s before any native request", async (host) => {
    expect(await queryGamePlayersDetailed("palworld", host, port)).toMatchObject({
      players: null,
      reason: "unreachable",
      detail: "That destination is not allowed.",
    });
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expectNoGameDigOrSockets();
  });

  it.each([
    { answers: privateAnswers },
    { answers: [publicAnswers[0]!, privateAnswers[0]!] },
  ])("rejects private or mixed DNS answers before any native request ($answers)", async ({ answers }) => {
    vi.mocked(dns.lookup).mockResolvedValueOnce(answers as never);
    expect(await queryGamePlayersDetailed("palworld", hostname, port)).toMatchObject({
      players: null, reason: "unreachable", detail: "That destination is not allowed.",
    });
    expect(dns.lookup).toHaveBeenCalledExactlyOnceWith(hostname, { all: true, verbatim: true });
    expect(requests).toHaveLength(0);
    expectNoGameDigOrSockets();
  });

  it("rejects rebinding from the wrapper's public DNS answer to a private HTTP-guard answer", async () => {
    vi.mocked(dns.lookup)
      .mockResolvedValueOnce(publicAnswers as never)
      .mockResolvedValueOnce(privateAnswers as never);

    expect(await queryGamePlayersDetailed("palworld", hostname, port)).toMatchObject({
      players: null, reason: "unreachable", detail: "That destination is not allowed.",
    });
    expect(dns.lookup).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(dns.lookup).mock.calls) {
      expect(call).toEqual([hostname, { all: true, verbatim: true }]);
    }
    expect(requests).toHaveLength(0);
    expectNoGameDigOrSockets();
  });

  it("pins the checked public answers at native request time despite a later private DNS answer", async () => {
    vi.mocked(dns.lookup)
      .mockResolvedValueOnce(publicAnswers as never)
      .mockResolvedValueOnce(publicAnswers as never)
      .mockResolvedValue(privateAnswers as never);

    expect(await queryGamePlayersDetailed("palworld", hostname, port)).toEqual({
      players: { current: 3, max: 32 }, reason: null,
    });
    expect(dns.lookup).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      options: { hostname, port: String(port), method: "GET", path: "/v1/api/metrics" },
      single: { address: publicAnswers[0]!.address, family: 4 },
      all: { address: publicAnswers },
    });

    // The next query rechecks DNS and denies the now-private answer. Socket
    // lookup on the first query did not consume it or silently re-resolve.
    expect(await queryGamePlayersDetailed("palworld", hostname, port)).toMatchObject({
      players: null, reason: "unreachable", detail: "That destination is not allowed.",
    });
    expect(dns.lookup).toHaveBeenCalledTimes(3);
    expect(requests).toHaveLength(1);
    expectNoGameDigOrSockets();
  });

  it.each([
    "http://127.0.0.1:8212/v1/api/metrics",
    "http://192.168.1.10:8212/v1/api/metrics",
    "http://169.254.169.254/latest/meta-data/",
  ])("does not follow an actual public HTTP 302 response to %s", async (location) => {
    vi.mocked(dns.lookup).mockResolvedValue(publicAnswers as never);
    responseStatus = 302;
    responseHeaders = { location };
    responseBody = "";

    expect(await queryGamePlayersDetailed("palworld", hostname, port)).toMatchObject({
      players: null, detail: "Request failed with status code 302",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.options).toMatchObject({
      hostname, path: "/v1/api/metrics", method: "GET",
    });
    expect(dns.lookup).toHaveBeenCalledTimes(2);
    expectNoGameDigOrSockets();
  });

  it("returns metrics counts from a public response through the real axios HTTP adapter", async () => {
    responseBody = JSON.stringify({ currentplayernum: 7, maxplayernum: 24 });
    expect(await queryGamePlayersDetailed("palworld", "8.8.8.8", port)).toEqual({
      players: { current: 7, max: 24 }, reason: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      options: { hostname: "8.8.8.8", port: String(port), method: "GET", path: "/v1/api/metrics" },
      single: { address: "8.8.8.8", family: 4 },
      all: { address: [{ address: "8.8.8.8", family: 4 }] },
    });
    expect(dns.lookup).not.toHaveBeenCalled();
    expectNoGameDigOrSockets();
  });
});