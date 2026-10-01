import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import {
  archiveImapMessage,
  fetchImapMessageBody,
  fetchImapMessages,
  markImapMessageRead,
} from "./email.js";
import { invalidateFetchCache } from "./fetchCache.js";
import type { ImapAccount } from "./mailAccounts.js";

// Gmail dependencies must not open the database just to exercise IMAP.
vi.mock("./google.js", () => ({ getGoogleAccessToken: vi.fn() }));

const account: ImapAccount = {
  id: "saved-imap",
  label: "Saved mailbox",
  host: "imap.example.com",
  port: 993,
  secure: true,
  username: "user",
  password: "password",
};

const operations = [
  { name: "inbox listing", run: (a: ImapAccount) => fetchImapMessages(a, { max: 10, unreadOnly: false }) },
  { name: "message body", run: (a: ImapAccount) => fetchImapMessageBody(a, 1) },
  { name: "archive", run: (a: ImapAccount) => archiveImapMessage(a, 1) },
  { name: "mark read", run: (a: ImapAccount) => markImapMessageRead(a, 1) },
];

// dns.lookup is overloaded; these production calls always request all answers.
function mockedLookup() {
  return vi.mocked(dns.lookup as (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>);
}

// Exercise the installed ImapFlow, intercepting only the final socket boundary.
// Returning an unconnected socket and emitting an error lets ImapFlow clean up
// its timeout without performing a network connection or an IMAP login.
function stoppedSocket(): net.Socket {
  const socket = new net.Socket();
  queueMicrotask(() => socket.emit("error", new Error("Test transport stopped")));
  return socket;
}

beforeEach(() => {
  invalidateFetchCache();
  vi.spyOn(dns, "lookup");
  mockedLookup().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  vi.spyOn(net, "connect").mockImplementation(() => stoppedSocket());
  vi.spyOn(tls, "connect").mockImplementation(() => stoppedSocket() as tls.TLSSocket);
});

afterEach(async () => {
  // ImapFlow schedules closeAfter() on the next event-loop iteration.
  await new Promise<void>((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateFetchCache();
});

describe.each(operations)("IMAP $name runtime destination enforcement", ({ run }) => {
  it.each([
    "127.0.0.1", "169.254.169.254", "10.0.0.1", "172.16.0.1",
    "192.168.1.1", "100.64.0.1", "::1", "fe80::1", "fd00::1",
    "::ffff:7f00:1", "::ffff:c0a8:1", "64:ff9b::a9fe:a9fe",
  ])("blocks saved/imported target %s before any socket connection", async (host) => {
    await expect(run({ ...account, host })).rejects.toThrow("That destination is not allowed.");
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
  });

  it("blocks a hostname if any DNS answer is private, including a later IPv6 answer", async () => {
    mockedLookup().mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "fd00::1", family: 6 },
    ]);
    await expect(run(account)).rejects.toThrow("That destination is not allowed.");
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
  });

  it.each(["", "imap.example.com:993", "https://imap.example.com", "user@imap.example.com"])(
    "rejects malformed saved/imported host %s before any socket connection", async (host) => {
      await expect(run({ ...account, host })).rejects.toThrow("Invalid destination host.");
      expect(net.connect).not.toHaveBeenCalled();
      expect(tls.connect).not.toHaveBeenCalled();
    },
  );

  it("fails closed on an empty DNS answer set", async () => {
    mockedLookup().mockResolvedValue([]);
    await expect(run(account)).rejects.toThrow("That destination is not allowed.");
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
  });

  it.each([0, -1, 65536, 993.5, NaN, Infinity])("blocks saved invalid port %s", async (port) => {
    await expect(run({ ...account, port })).rejects.toThrow("Port must be an integer");
    expect(dns.lookup).not.toHaveBeenCalled();
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
  });

  it("fails closed on DNS failure before any socket connection", async () => {
    mockedLookup().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    await expect(run(account)).rejects.toThrow("Could not resolve destination host.");
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).not.toHaveBeenCalled();
  });

  it.each([true, false])("pins the first checked IP and preserves TLS identity (secure=%s)", async (secure) => {
    mockedLookup().mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(run({ ...account, secure, port: secure ? 993 : 143 }))
      .rejects.toThrow("Test transport stopped");

    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(dns.lookup).toHaveBeenCalledWith("imap.example.com", { all: true, verbatim: true });
    const connector = secure ? tls.connect : net.connect;
    expect(connector).toHaveBeenCalledTimes(1);
    expect(connector).toHaveBeenCalledWith(expect.objectContaining({
      host: "8.8.8.8",
      servername: "imap.example.com",
      port: secure ? 993 : 143,
      rejectUnauthorized: true,
    }), expect.any(Function));
    expect(secure ? net.connect : tls.connect).not.toHaveBeenCalled();
  });
});

describe("IMAP pinned transport details", () => {
  it("pins a public IPv6 answer without substituting it for the TLS hostname", async () => {
    mockedLookup().mockResolvedValue([{ address: "2001:4860:4860::8888", family: 6 }]);
    await expect(markImapMessageRead(account, 1)).rejects.toThrow("Test transport stopped");
    expect(tls.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: "2001:4860:4860::8888", servername: "imap.example.com",
    }), expect.any(Function));
  });

  it("ignores proxy and TLS overrides carried by an imported account or environment", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:3128");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:3128");
    const imported = {
      ...account,
      proxy: "http://127.0.0.1:3128",
      tls: { host: "127.0.0.1", rejectUnauthorized: false },
    };
    await expect(markImapMessageRead(imported, 1)).rejects.toThrow("Test transport stopped");
    expect(net.connect).not.toHaveBeenCalled();
    expect(tls.connect).toHaveBeenCalledWith(expect.objectContaining({
      host: "8.8.8.8", rejectUnauthorized: true, servername: "imap.example.com",
    }), expect.any(Function));
  });

  it("uses the original hostname for certificate verification, not the pinned IP", async () => {
    await expect(markImapMessageRead(account, 1)).rejects.toThrow("Test transport stopped");
    const options = vi.mocked(tls.connect).mock.calls[0]![0] as tls.ConnectionOptions;
    const cert = { subjectaltname: "DNS:imap.example.com" } as tls.PeerCertificate;
    expect(tls.checkServerIdentity(options.servername!, cert)).toBeUndefined();
    expect(tls.checkServerIdentity(options.host!, cert)).toBeInstanceOf(Error);
  });

  it("revalidates DNS on each new connection to an already-saved account", async () => {
    mockedLookup().mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValue([{ address: "192.168.1.1", family: 4 }]);
    await expect(markImapMessageRead(account, 1)).rejects.toThrow("Test transport stopped");
    await expect(markImapMessageRead(account, 1)).rejects.toThrow("That destination is not allowed.");
    expect(dns.lookup).toHaveBeenCalledTimes(2);
    expect(tls.connect).toHaveBeenCalledTimes(1);
  });
});