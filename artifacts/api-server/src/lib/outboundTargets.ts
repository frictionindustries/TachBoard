import dns from "node:dns/promises";
import net from "node:net";
import { isSsrfBlockedIp, UnsafeUrlError } from "./http.js";

export function validateOutboundPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UnsafeUrlError("Port must be an integer between 1 and 65535.");
  }
}

// Raw socket clients must connect to address, NOT host: otherwise their own
// resolver could replace the checked DNS answer (or follow an unchecked SRV).
// Keep host only for protocol identity, e.g. TLS SNI/certificate verification.
export async function resolvePublicHost(
  input: string,
): Promise<{ host: string; address: string; family: 4 | 6 }> {
  if (typeof input !== "string" || !input || input !== input.trim() ||
      /[\s/@\\?#%]/.test(input)) {
    throw new UnsafeUrlError("Invalid destination host.");
  }
  const host = input.startsWith("[") && input.endsWith("]")
    ? input.slice(1, -1) : input;
  const literalFamily = net.isIP(host);
  if (input !== host && literalFamily !== 6) {
    throw new UnsafeUrlError("Invalid destination host.");
  }
  if (!literalFamily && !/^(?=.{1,253}$)[a-z\d](?:[a-z\d.-]*[a-z\d])?\.?$/i.test(host)) {
    throw new UnsafeUrlError("Invalid destination host.");
  }
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = literalFamily
      ? [{ address: host, family: literalFamily }]
      : await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError("Could not resolve destination host.");
  }
  // Reject mixed public/private answers rather than choosing the public one.
  if (!resolved.length || resolved.some(({ address, family }) =>
    !net.isIP(address) || net.isIP(address) !== family || isSsrfBlockedIp(address, true))) {
    throw new UnsafeUrlError("That destination is not allowed.");
  }
  const chosen = resolved[0]!;
  return { host, address: chosen.address, family: chosen.family as 4 | 6 };
}