import { describe, it, expect, vi, beforeEach } from "vitest";

describe("isSsrfBlockedIp", () => {
  it("always blocks loopback, link-local, cloud-metadata, and reserved IPv4 ranges", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    for (const ip of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
      expect(isSsrfBlockedIp(ip, false)).toBe(true);
      expect(isSsrfBlockedIp(ip, true)).toBe(true);
    }
  });

  it("always blocks IPv6 loopback, unspecified, and link-local addresses", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    for (const ip of ["::1", "::", "fe80::1", "ff02::1"]) {
      expect(isSsrfBlockedIp(ip, false)).toBe(true);
      expect(isSsrfBlockedIp(ip, true)).toBe(true);
    }
  });

  it("blocks an IPv4-mapped loopback/metadata address regardless of publicOnly (dotted form)", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    expect(isSsrfBlockedIp("::ffff:127.0.0.1", false)).toBe(true);
    expect(isSsrfBlockedIp("::ffff:169.254.169.254", true)).toBe(true);
  });

  it("blocks IPv4-mapped addresses spelled in fully hex-encoded form (bypass check)", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    // 127.0.0.1 as hex groups
    expect(isSsrfBlockedIp("::ffff:7f00:1", false)).toBe(true);
    expect(isSsrfBlockedIp("0:0:0:0:0:ffff:7f00:0001", false)).toBe(true);
    // 169.254.169.254 (cloud metadata) as hex groups
    expect(isSsrfBlockedIp("::ffff:a9fe:a9fe", true)).toBe(true);
    expect(isSsrfBlockedIp("::FFFF:A9FE:A9FE", false)).toBe(true);
  });

  it("blocks NAT64 well-known-prefix mapped loopback/metadata addresses", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    expect(isSsrfBlockedIp("64:ff9b::127.0.0.1", false)).toBe(true);
    expect(isSsrfBlockedIp("64:ff9b::7f00:1", false)).toBe(true);
  });

  it("applies publicOnly to hex-encoded mapped private-range addresses too", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    // 192.168.1.10 as hex groups (c0a8:010a)
    expect(isSsrfBlockedIp("::ffff:c0a8:10a", true)).toBe(true);
    expect(isSsrfBlockedIp("::ffff:c0a8:10a", false)).toBe(false);
  });

  it("fails closed on an unparseable IPv6-looking string", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    expect(isSsrfBlockedIp("not-an-ip", false)).toBe(true);
  });

  it("allows RFC1918 private ranges when publicOnly is false (homelab devices)", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    for (const ip of ["10.0.0.5", "172.16.0.5", "192.168.1.10", "100.64.0.5"]) {
      expect(isSsrfBlockedIp(ip, false)).toBe(false);
    }
  });

  it("blocks RFC1918 private ranges and IPv6 ULA when publicOnly is true (news feed proxy)", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    for (const ip of ["10.0.0.5", "172.16.0.5", "192.168.1.10", "100.64.0.5"]) {
      expect(isSsrfBlockedIp(ip, true)).toBe(true);
    }
    expect(isSsrfBlockedIp("fd00::1", true)).toBe(true);
    expect(isSsrfBlockedIp("fec0::1", true)).toBe(true);
    expect(isSsrfBlockedIp("2002:a00:1::", true)).toBe(true);
    expect(isSsrfBlockedIp("::192.168.0.1", true)).toBe(true);
  });

  it("allows ordinary public IPv4/IPv6 addresses either way", async () => {
    const { isSsrfBlockedIp } = await import("./http.js");
    expect(isSsrfBlockedIp("8.8.8.8", false)).toBe(false);
    expect(isSsrfBlockedIp("8.8.8.8", true)).toBe(false);
    expect(isSsrfBlockedIp("2001:4860:4860::8888", true)).toBe(false);
  });
});

describe("httpClient SSRF guard (request interceptor)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("rejects a request to a loopback destination before it hits the network", async () => {
    const { httpClient } = await import("./http.js");
    await expect(httpClient.get("http://127.0.0.1:1/anything")).rejects.toThrow(
      "That destination is not allowed.",
    );
  });

  it("rejects a request to the cloud-metadata address", async () => {
    const { httpClient } = await import("./http.js");
    await expect(httpClient.get("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      "That destination is not allowed.",
    );
  });

  it("rejects a non-http(s) protocol", async () => {
    const { httpClient } = await import("./http.js");
    await expect(httpClient.get("file:///etc/passwd")).rejects.toThrow(
      "Only http:// and https:// URLs are allowed.",
    );
  });

  it("rejects a private-range destination when ssrfPublicOnly is set", async () => {
    const { httpClient } = await import("./http.js");
    await expect(
      httpClient.get("http://192.168.1.10:1/anything", { ssrfPublicOnly: true }),
    ).rejects.toThrow("That destination is not allowed.");
  });

  it("pins public IPv6 literals without looking up bracketed hostnames", async () => {
    const { httpClient } = await import("./http.js");
    const adapter = vi.fn(async (config) => ({
      data: "ok", status: 200, statusText: "OK", headers: {}, config,
    }));
    await httpClient.get("https://[2001:4860:4860::8888]/", { ssrfPublicOnly: true, adapter });
    const config = adapter.mock.calls[0]![0];
    const callback = vi.fn();
    config.lookup("ignored", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "2001:4860:4860::8888", family: 6 }]);
    expect(config.maxRedirects).toBe(0);
  });
});
