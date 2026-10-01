import https from "node:https";
import { httpClient, UnsafeUrlError } from "./http.js";
import { resolvePublicHost, validateOutboundPort } from "./outboundTargets.js";

// httpClient normally permits self-signed homelab certificates. CalDAV is a
// public-only transport, so always override that agent with verified TLS.
const verifiedHttpsAgent = new https.Agent({ rejectUnauthorized: true });

function validateCalDavUrl(value: string, base?: URL): URL {
  let target: URL;
  try {
    target = new URL(value, base);
  } catch {
    throw new UnsafeUrlError("Invalid CalDAV destination URL.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new UnsafeUrlError("CalDAV destinations must use http:// or https://.");
  }
  if (target.username || target.password) {
    throw new UnsafeUrlError("CalDAV destination URLs must not contain credentials.");
  }
  validateOutboundPort(Number(target.port || (target.protocol === "https:" ? 443 : 80)));
  return target;
}

// tsdav 2.3 accepts a `fetch` override and propagates it through service
// discovery, principal/home hrefs, collection discovery, and REPORT requests.
// Its discovery code catches errors and tries other roots. Remember a security
// rejection so those retries cannot turn a blocked destination into success.
export function createCalDavTransport(): {
  fetch: typeof globalThis.fetch;
  assertSafe: () => void;
} {
  let securityError: UnsafeUrlError | undefined;
  const assertSafe = () => {
    if (securityError) throw securityError;
  };

  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    assertSafe();
    try {
      const target = validateCalDavUrl(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const request = new Request(input, init);
      const data = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
      const response = await httpClient.request<ArrayBuffer>({
        url: target.href,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        data,
        signal: request.signal,
        ssrfPublicOnly: true,
        // The shared interceptor resolves, rejects any non-public DNS answer,
        // and pins the validated addresses in config.lookup before connecting.
        // Do not permit environment proxies to bypass that pinned destination.
        proxy: false,
        httpsAgent: verifiedHttpsAgent,
        maxRedirects: 0,
        responseType: "arraybuffer",
        transformRequest: [(body) => body],
        transformResponse: [(body) => body],
        validateStatus: () => true,
      });

      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, String(item));
        } else {
          headers.set(name, String(value));
        }
      }

      if (response.status >= 300 && response.status < 400) {
        const location = headers.get("location");
        if (request.redirect !== "manual" || !location) {
          throw new UnsafeUrlError("CalDAV automatic redirects are disabled.");
        }
        // tsdav deliberately handles .well-known redirects itself. Validate
        // even that returned URL before exposing it, then its next request
        // goes through the same guarded client and pinned DNS lookup again.
        const next = validateCalDavUrl(location, target);
        await resolvePublicHost(next.hostname);
      }

      const result = new Response(
        [204, 205, 304].includes(response.status) ? null : new Uint8Array(response.data),
        { status: response.status, statusText: response.statusText, headers },
      );
      // Native Response construction does not set URL, but tsdav uses the
      // fetch response URL when handling non-XML/error responses.
      Object.defineProperty(result, "url", { value: target.href });
      return result;
    } catch (error) {
      if (error instanceof UnsafeUrlError) securityError = error;
      throw error;
    }
  };

  return { fetch: guardedFetch, assertSafe };
}