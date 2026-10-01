// Service bases are joined to fixed API paths. A query or fragment would swallow
// that suffix and turn the request into a fetch of an unrelated endpoint.
export class InvalidServiceBaseUrlError extends Error {
  constructor(message: string) {
    super(`Invalid service URL: ${message}`);
    this.name = "InvalidServiceBaseUrlError";
  }
}

const BASE_URL_SERVICES = new Set([
  "truenas", "plex", "jellyfin", "subsonic", "sonarr", "radarr", "lidarr",
  "qbittorrent", "pihole", "nginx-proxy-manager", "prowlarr", "pterodactyl",
  "ersatztv", "immich",
]);

// Tailscale's "url" is a tailnet, stocks uses a fixed provider, and mail/OAuth
// account extras have their own formats rather than generic service bases.
export function isServiceBaseUrlConnection(service: string): boolean {
  return BASE_URL_SERVICES.has(service);
}

export function validateServiceBaseUrl(input: string): string {
  const fail = (message: string): never => {
    throw new InvalidServiceBaseUrlError(message);
  };
  if (typeof input !== "string" || /[\u0000-\u001f\u007f-\u009f\\]/.test(input)) {
    fail("control characters and backslashes are not allowed.");
  }
  const value = input.trim();
  if (!value || /\s/.test(value)) fail("enter a valid HTTP(S) base URL.");
  // Check the original spelling: URL.search/hash are empty for a bare ? or #.
  if (/[?#]/.test(value)) fail("queries and fragments are not allowed.");
  let candidate = value;
  if (!/^https?:\/\//i.test(value)) {
    if (value.startsWith("/") ||
        (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^:]+:\d+(?:\/|$)/.test(value))) {
      fail("only HTTP(S) base URLs are allowed.");
    }
    candidate = `http://${value}`;
  }
  const authorityMatch = candidate.match(/^https?:\/\/([^/]+)/i);
  const authority = authorityMatch?.[1];
  if (!authority || authority.includes("@")) fail("credentials are not allowed in the URL.");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return fail("enter a valid HTTP(S) base URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username || parsed.password) {
    fail("enter a valid HTTP(S) base URL without credentials.");
  }
  // Validate before URL's dot-segment normalization. Reject encoded delimiters
  // and traversal (including nested encoding), but allow ordinary escaped
  // characters such as spaces and Unicode within reverse-proxy prefixes.
  let path = candidate.slice(authorityMatch![0].length);
  try {
    decodeURIComponent(path); // Reject malformed escapes / invalid UTF-8.
    for (let depth = 0; depth < 16; depth++) {
      if (/%(?:2f|3f|23|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path) ||
          /[\u0000-\u001f\u007f-\u009f\\?#]/.test(path) ||
          path.split("/").some((segment) => segment === "." || segment === "..")) {
        fail("encoded delimiters and path traversal are not allowed.");
      }
      if (!/%[0-9a-f]{2}/i.test(path)) break;
      path = decodeURIComponent(path);
      if (depth === 15) fail("excessively encoded paths are not allowed.");
    }
  } catch (err) {
    if (err instanceof InvalidServiceBaseUrlError) throw err;
    return fail("the URL path contains malformed encoding.");
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}