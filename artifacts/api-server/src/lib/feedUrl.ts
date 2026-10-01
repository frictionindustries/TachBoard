// Feeds are complete resource URLs, not bases for fixed API suffixes. Preserve
// their query strings and trailing slashes; the public-only HTTP transport
// validates the protocol/destination and pins DNS before fetching.
export function normalizeFeedUrl(value: string): string {
  const trimmed = value.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}