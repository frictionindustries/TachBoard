import { cloudHttpClient } from "./http.js";
import { getGoogleAccessToken } from "./google.js";
import { cachedFetch, invalidateFetchCache } from "./fetchCache.js";
import type { ImapAccount } from "./mailAccounts.js";
import { resolvePublicHost, validateOutboundPort } from "./outboundTargets.js";

// ── Mail fetchers (Gmail REST + generic IMAP) ─────────────────────────────────
// Both providers normalize into the same EmailMessage shape the widget route
// serves. imapflow is lazily imported so the (heavy) dependency only loads
// when an IMAP account is actually queried.

export interface EmailMessage {
  id: string;
  account: string;
  accountLabel: string;
  from: string;
  subject: string;
  snippet: string | null;
  date: string;
  unread: boolean;
  link: string | null;
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailHeader {
  name?: string;
  value?: string;
}
interface GmailMessage {
  id?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: { headers?: GmailHeader[] };
}

function gmailHeader(msg: GmailMessage, name: string): string {
  const h = msg.payload?.headers?.find(
    (x) => x.name?.toLowerCase() === name.toLowerCase(),
  );
  return h?.value ?? "";
}

// Strip the email address part from a From header ("Jane <j@x.com>" → "Jane").
function displayFrom(raw: string): string {
  const m = raw.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return (m?.[1] ?? raw).trim() || raw.trim();
}

// Cached wrapper — tiles poll frequently, so identical per-account requests
// within the TTL share one upstream fetch (see fetchCache.ts).
export function fetchGmailMessages(
  userId: number,
  opts: {
    accountId: string;
    accountLabel: string;
    max: number;
    unreadOnly: boolean;
    fresh?: boolean;
  },
): Promise<{ messages: EmailMessage[]; unread: number | null }> {
  return cachedFetch(
    `mail:gmail:${userId}:${opts.accountId}:${opts.max}:${opts.unreadOnly}`,
    () => fetchGmailMessagesUncached(userId, opts),
    undefined,
    { fresh: opts.fresh ?? false },
  );
}

async function fetchGmailMessagesUncached(
  userId: number,
  opts: {
    accountId: string;
    accountLabel: string;
    max: number;
    unreadOnly: boolean;
  },
): Promise<{ messages: EmailMessage[]; unread: number | null }> {
  const token = await getGoogleAccessToken(userId, opts.accountId);
  const headers = { Authorization: `Bearer ${token}` };

  const listParams = new URLSearchParams({
    maxResults: String(opts.max),
    labelIds: "INBOX",
  });
  if (opts.unreadOnly) listParams.append("q", "is:unread");
  const list = await cloudHttpClient.get<{ messages?: { id: string }[] }>(
    `${GMAIL_BASE}/messages?${listParams.toString()}`,
    { headers },
  );
  const ids = (list.data.messages ?? []).slice(0, opts.max).map((m) => m.id);

  const details = await Promise.all(
    ids.map((id) =>
      cloudHttpClient.get<GmailMessage>(
        `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers },
      ),
    ),
  );

  // Unread total from the INBOX label (threadsUnread is closer to what the
  // Gmail UI badge shows, but messagesUnread matches what we list here).
  let unread: number | null = null;
  try {
    const label = await cloudHttpClient.get<{ messagesUnread?: number }>(
      `${GMAIL_BASE}/labels/INBOX`,
      { headers },
    );
    unread = typeof label.data.messagesUnread === "number" ? label.data.messagesUnread : null;
  } catch {
    unread = null;
  }

  const messages = details.map((r) => {
    const msg = r.data;
    const id = msg.id ?? "";
    return {
      id: `gmail:${opts.accountId}:${id}`,
      account: opts.accountId,
      accountLabel: opts.accountLabel,
      from: displayFrom(gmailHeader(msg, "From")),
      subject: gmailHeader(msg, "Subject"),
      snippet: msg.snippet ?? null,
      date: msg.internalDate
        ? new Date(Number(msg.internalDate)).toISOString()
        : new Date().toISOString(),
      unread: msg.labelIds?.includes("UNREAD") ?? false,
      link: id ? `https://mail.google.com/mail/#inbox/${id}` : null,
    };
  });

  return { messages, unread };
}

// ── Full message bodies (fetched on demand for the detail pop-out) ───────────
// Both providers return sanitized plain text (never HTML). Bodies are capped
// so one giant newsletter can't blow up the response.

const BODY_MAX_CHARS = 50_000;

// Crude but dependency-free HTML → text conversion. We never render HTML in
// the UI, so this only needs to produce something readable.
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function finalizeBody(text: string): string | null {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned) return null;
  return cleaned.length > BODY_MAX_CHARS ? `${cleaned.slice(0, BODY_MAX_CHARS)}\n…` : cleaned;
}

interface GmailBodyPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailBodyPart[];
}

// Depth-first search for the first part matching the wanted MIME type that
// actually carries inline data.
function findGmailPart(part: GmailBodyPart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body?.data) return part.body.data;
  for (const child of part.parts ?? []) {
    const found = findGmailPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

// Fetch one Gmail message's plain-text body (format=full). Prefers text/plain;
// falls back to a stripped text/html part; falls back to the snippet.
export function fetchGmailMessageBody(
  userId: number,
  accountId: string,
  messageId: string,
): Promise<string | null> {
  return cachedFetch(`mail:gmail:${userId}:${accountId}:body:${messageId}`, async () => {
    const token = await getGoogleAccessToken(userId, accountId);
    const res = await cloudHttpClient.get<GmailBodyPart & { snippet?: string; payload?: GmailBodyPart }>(
      `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const payload = res.data.payload ?? {};
    const plain = findGmailPart(payload, "text/plain");
    if (plain) return finalizeBody(decodeBase64Url(plain));
    const html = findGmailPart(payload, "text/html");
    if (html) return finalizeBody(htmlToPlainText(decodeBase64Url(html)));
    return finalizeBody(res.data.snippet ?? "");
  });
}

// imapflow bodyStructure node (loosely typed — the library's own typing is any-ish).
interface ImapBodyNode {
  part?: string;
  type?: string;
  disposition?: string;
  parameters?: Record<string, string>;
  childNodes?: ImapBodyNode[];
}

// Find the part number of the first inline part with the wanted MIME type.
// For non-multipart messages the root node has no part id — BODY[1] is the
// content by IMAP convention.
function findImapPart(node: ImapBodyNode, type: string): string | null {
  if (node.type?.toLowerCase() === type && node.disposition !== "attachment") {
    return node.part ?? "1";
  }
  for (const child of node.childNodes ?? []) {
    const found = findImapPart(child, type);
    if (found) return found;
  }
  return null;
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function decodeCharset(buf: Buffer, charset: string | undefined): string {
  if (charset) {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      // Unknown/invalid charset label — fall through to UTF-8.
    }
  }
  return buf.toString("utf8");
}

// Fetch one IMAP message's plain-text body on demand. Prefers the text/plain
// part; falls back to stripped text/html. download() already reverses the
// content-transfer-encoding, so only the charset is left to handle.
export function fetchImapMessageBody(account: ImapAccount, uid: number): Promise<string | null> {
  return cachedFetch(`mail:imap:${account.id}:body:${uid}`, () =>
    fetchImapMessageBodyUncached(account, uid),
  );
}

async function fetchImapMessageBodyUncached(
  account: ImapAccount,
  uid: number,
): Promise<string | null> {
  const client = await createImapClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
      if (!msg || !msg.bodyStructure) {
        throw new Error("Message not found in INBOX");
      }
      const structure = msg.bodyStructure as ImapBodyNode;

      const plainPart = findImapPart(structure, "text/plain");
      const htmlPart = plainPart ? null : findImapPart(structure, "text/html");
      const part = plainPart ?? htmlPart;
      if (!part) return null;

      const { content, meta } = await client.download(String(uid), part, { uid: true });
      if (!content) return null;
      const buf = await streamToString(content);
      const metaCharset = (meta as { charset?: string } | undefined)?.charset;
      const text = decodeCharset(buf, metaCharset);
      return finalizeBody(plainPart ? text : htmlToPlainText(text));
    } finally {
      lock.release();
    }
  } finally {
    // logout() can hang on broken servers; close() force-drops the socket.
    await client.logout().catch(() => client.close());
  }
}

// Archive one Gmail message by removing its INBOX label (the Gmail UI's
// definition of "archive"). Requires the gmail.modify scope — accounts linked
// before that scope was requested fail with 403 until re-linked.
export async function archiveGmailMessage(
  userId: number,
  accountId: string,
  messageId: string,
): Promise<void> {
  const token = await getGoogleAccessToken(userId, accountId);
  await cloudHttpClient.post(
    `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/modify`,
    { removeLabelIds: ["INBOX"] },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  // The inbox listing for this account is now stale — drop the cached fetch so
  // the tile's next poll reflects the archive immediately.
  invalidateFetchCache(`mail:gmail:${userId}:${accountId}`);
}

// Mark one Gmail message as read by removing its UNREAD label. Requires the
// gmail.modify scope — accounts linked before that scope was requested fail
// with 403 until re-linked (same as archive).
export async function markGmailMessageRead(
  userId: number,
  accountId: string,
  messageId: string,
): Promise<void> {
  const token = await getGoogleAccessToken(userId, accountId);
  await cloudHttpClient.post(
    `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/modify`,
    { removeLabelIds: ["UNREAD"] },
    { headers: { Authorization: `Bearer ${token}` } },
  );
  // The inbox listing for this account is now stale (unread count/flags
  // changed) — drop the cached fetch so the tile's next poll reflects it.
  invalidateFetchCache(`mail:gmail:${userId}:${accountId}`);
}

// Hard cap on how long a single IMAP round-trip may take — a wedged server
// must not hang the whole aggregated inbox request.
const IMAP_TIMEOUT_MS = 15_000;

async function createImapClient(account: ImapAccount) {
  const { ImapFlow } = await import("imapflow");
  validateOutboundPort(account.port);
  // Revalidate saved/imported accounts at every connection, not just on save.
  const target = await resolvePublicHost(account.host);
  // ImapFlow passes host directly to net/tls.connect and retains servername
  // for STARTTLS on the same socket. A numeric host prevents another DNS
  // lookup; only explicitly selected options are passed (never a proxy).
  return new ImapFlow({
    host: target.address,
    servername: target.host,
    port: account.port,
    secure: account.secure,
    tls: { rejectUnauthorized: true },
    auth: { user: account.username, pass: account.password },
    logger: false,
    socketTimeout: IMAP_TIMEOUT_MS,
    greetingTimeout: IMAP_TIMEOUT_MS,
    connectionTimeout: IMAP_TIMEOUT_MS,
  });
}

// Cached wrapper — avoids opening a fresh IMAP connection per tile refresh
// and dedupes concurrent logins to the same mailbox (see fetchCache.ts).
export function fetchImapMessages(
  account: ImapAccount,
  opts: { max: number; unreadOnly: boolean; fresh?: boolean },
): Promise<{ messages: EmailMessage[]; unread: number | null }> {
  return cachedFetch(
    `mail:imap:${account.id}:${opts.max}:${opts.unreadOnly}`,
    () => fetchImapMessagesUncached(account, opts),
    undefined,
    { fresh: opts.fresh ?? false },
  );
}

async function fetchImapMessagesUncached(
  account: ImapAccount,
  opts: { max: number; unreadOnly: boolean },
): Promise<{ messages: EmailMessage[]; unread: number | null }> {
  const client = await createImapClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      const total = mailbox && typeof mailbox === "object" ? mailbox.exists : 0;

      let unread: number | null = null;
      try {
        const status = await client.status("INBOX", { unseen: true });
        unread = typeof status.unseen === "number" ? status.unseen : null;
      } catch {
        unread = null;
      }

      let uids: number[];
      if (opts.unreadOnly) {
        const found = await client.search({ seen: false }, { uid: true });
        uids = Array.isArray(found) ? found.slice(-opts.max) : [];
      } else {
        if (total === 0) return { messages: [], unread };
        // Fetch the newest N by sequence number.
        const start = Math.max(1, total - opts.max + 1);
        const found = await client.search({ seq: `${start}:${total}` }, { uid: true });
        uids = Array.isArray(found) ? found : [];
      }
      if (uids.length === 0) return { messages: [], unread };

      const messages: EmailMessage[] = [];
      for await (const msg of client.fetch(
        uids,
        { uid: true, envelope: true, flags: true },
        { uid: true },
      )) {
        const env = msg.envelope;
        const fromAddr = env?.from?.[0];
        const from = fromAddr?.name?.trim() || fromAddr?.address || "Unknown sender";
        messages.push({
          id: `${account.id}:${msg.uid}`,
          account: account.id,
          accountLabel: account.label,
          from,
          subject: env?.subject ?? "",
          snippet: null,
          date: (env?.date ?? new Date()).toISOString(),
          unread: !(msg.flags?.has("\\Seen") ?? false),
          // IMAP has no per-message deep link; fall back to the account's
          // configured webmail UI when the user provided one.
          link: account.webmailUrl ?? null,
        });
      }
      messages.sort((a, b) => (a.date < b.date ? 1 : -1));
      return { messages: messages.slice(0, opts.max), unread };
    } finally {
      lock.release();
    }
  } finally {
    // logout() can hang on broken servers; close() force-drops the socket.
    await client.logout().catch(() => client.close());
  }
}

// Archive one IMAP message by moving it out of INBOX into the server's archive
// mailbox — the special-use \Archive folder when advertised, otherwise a
// mailbox literally named "Archive"/"Archives". Fails with a clear error when
// the server has no such folder rather than guessing at a destination.
export async function archiveImapMessage(account: ImapAccount, uid: number): Promise<void> {
  const client = await createImapClient(account);
  await client.connect();
  try {
    const boxes = await client.list();
    const target =
      boxes.find((b) => b.specialUse === "\\Archive")?.path ??
      boxes.find((b) => /^archives?$/i.test(b.name))?.path;
    if (!target) {
      throw new Error(`No Archive folder found on ${account.host}`);
    }
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageMove(String(uid), target, { uid: true });
    } finally {
      lock.release();
    }
    // Drop every cached inbox listing for this account (all max/unreadOnly
    // variants) so the tile's next poll reflects the move immediately.
    invalidateFetchCache(`mail:imap:${account.id}`);
  } finally {
    // logout() can hang on broken servers; close() force-drops the socket.
    await client.logout().catch(() => client.close());
  }
}

// Mark one IMAP message as read by adding the \Seen flag. Additive (unlike the
// archive move) — the message stays in INBOX, just flagged read.
export async function markImapMessageRead(account: ImapAccount, uid: number): Promise<void> {
  const client = await createImapClient(account);
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
    } finally {
      lock.release();
    }
    // Drop every cached inbox listing for this account (all max/unreadOnly
    // variants) so the tile's next poll reflects the read flag immediately.
    invalidateFetchCache(`mail:imap:${account.id}`);
  } finally {
    // logout() can hang on broken servers; close() force-drops the socket.
    await client.logout().catch(() => client.close());
  }
}

// ── Demo data ─────────────────────────────────────────────────────────────────
// Shown only when no mail account is configured at all, so the tile still
// renders something representative.

export function demoEmailMessages(now = Date.now()): EmailMessage[] {
  const mins = (n: number) => new Date(now - n * 60_000).toISOString();
  const demo = [
    { from: "GitHub", subject: "[homelab] Build #142 passed", snippet: "All checks have passed on main.", unread: true, at: 12 },
    { from: "TrueNAS", subject: "Scrub of pool tank finished", snippet: "Scrub completed with 0 errors in 2:41:07.", unread: true, at: 55 },
    { from: "Sofia Nguyen", subject: "Re: Saturday dinner plans", snippet: "Sounds great — see you at 7! Should I bring anything?", unread: false, at: 130 },
    { from: "Let's Encrypt", subject: "Certificate expiration notice", snippet: "Your certificate for dash.local expires in 19 days.", unread: false, at: 260 },
    { from: "Newsletter Weekly", subject: "This week in self-hosting", snippet: "Top posts: pi-hole v6, ZFS tuning guide, and more.", unread: false, at: 420 },
  ];
  return demo.map((d, i) => ({
    id: `demo:${i}`,
    account: "demo",
    accountLabel: "Demo inbox",
    from: d.from,
    subject: d.subject,
    snippet: d.snippet,
    date: mins(d.at),
    unread: d.unread,
    link: null,
  }));
}
