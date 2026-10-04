import { useEffect, useRef, useState } from "react";
import type { Tile } from "@workspace/api-client-react";
import { Bot, Send, Square, Eraser, Loader2 } from "lucide-react";
import { MarkdownContent } from "../../lib/markdown";
import { useTileExpansion } from "./expansion";

// Per-tile conversation history lives in localStorage under the app's legacy
// key prefix (kept for back-compat) so it survives refreshes without touching
// the server. Capped so a long-running chat can't grow unbounded.
const HISTORY_PREFIX = "homehub:aichat:";
const HISTORY_CAP = 50;
// Only the most recent turns are sent to the provider; the full capped history
// stays visible locally.
const CONTEXT_TURNS = 20;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  // Set on assistant messages produced by demo mode (no accounts configured).
  sample?: boolean;
  // Set when a send failed: rendered as an inline error bubble.
  error?: boolean;
}

// A canned conversation shown when the tile has no AI account selected, so an
// unconfigured tile demonstrates what it does (mock only when unconfigured).
const DEMO_CONVERSATION: ChatMessage[] = [
  { role: "user", content: "What can you do?" },
  {
    role: "assistant",
    content:
      "I'm your dashboard AI assistant. Add an AI account (OpenAI, Gemini, Anthropic, or a local server like Ollama) in Settings, then pick it in this tile's options to start a real conversation.",
    sample: true,
  },
];

function loadHistory(tileId: string | number): ChatMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_PREFIX + tileId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMessage =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    );
  } catch {
    return [];
  }
}

function saveHistory(tileId: string | number, messages: ChatMessage[]): void {
  try {
    localStorage.setItem(
      HISTORY_PREFIX + tileId,
      JSON.stringify(messages.slice(-HISTORY_CAP)),
    );
  } catch {
    // Storage full/unavailable — the chat still works, it just won't persist.
  }
}

// Streams a chat reply from the API's NDJSON streaming mode. Calls onDelta
// with each incremental piece of reply text; resolves with the final metadata
// line. Non-2xx responses (400/404/502 before streaming starts) throw with
// the server's error message; mid-stream provider failures surface as an
// {"error"} line and also throw.
async function streamAiChat(
  body: {
    accountId: string | null;
    model: string | null;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ sample: boolean }> {
  const token = localStorage.getItem("token");
  const res = await fetch("/api/widgets/ai/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
  if (!res.ok) {
    let message = "The AI request failed.";
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // non-JSON error body — keep the generic message
    }
    throw new Error(message);
  }
  if (!res.body) {
    // Extremely old browser without stream support — read it all at once.
    const text = await res.text();
    return finishFromLines(text.split("\n"), onDelta);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: { sample: boolean } | null = null;
  for (;;) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      done = handleStreamLine(line, onDelta) ?? done;
    }
  }
  if (buffer.trim()) done = handleStreamLine(buffer, onDelta) ?? done;
  if (!done) throw new Error("The AI reply stream ended unexpectedly.");
  return done;
}

function finishFromLines(
  lines: string[],
  onDelta: (text: string) => void,
): { sample: boolean } {
  let done: { sample: boolean } | null = null;
  for (const line of lines) done = handleStreamLine(line, onDelta) ?? done;
  if (!done) throw new Error("The AI reply stream ended unexpectedly.");
  return done;
}

// Parses one NDJSON line; returns final metadata when it's the done line.
function handleStreamLine(
  line: string,
  onDelta: (text: string) => void,
): { sample: boolean } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let payload: { delta?: string; done?: boolean; sample?: boolean; error?: string };
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (payload.error) throw new Error(payload.error);
  if (typeof payload.delta === "string" && payload.delta) onDelta(payload.delta);
  if (payload.done) return { sample: payload.sample === true };
  return null;
}

interface AiChatTileProps {
  tile: Tile;
  // In edit (layout) mode the tile is a drag/resize target, so the input is
  // disabled — chatting happens in locked mode.
  editMode: boolean;
}

// The AI Chat tile: a scrollable conversation backed by a saved AI account
// (selected in the tile editor). History persists per tile in localStorage.
export default function AiChatTile({ tile, editMode }: AiChatTileProps) {
  const { expanded } = useTileExpansion();
  const accountId = tile.tileSettings?.aiAccountId ?? null;
  const model = tile.tileSettings?.aiModel ?? null;
  const configured = Boolean(accountId);

  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    loadHistory(tile.id),
  );
  const [input, setInput] = useState("");
  // True from send until the stream finishes; "Thinking…" shows only until
  // the first token arrives, then the reply grows in place.
  const [busy, setBusy] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const thinking = busy && streamingText === null;
  // Lets the Stop button abort the in-flight streaming fetch mid-reply.
  const abortRef = useRef<AbortController | null>(null);

  // Abandon any in-flight stream if the tile unmounts mid-reply.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  // Keep the newest message in view as the conversation grows.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking, streamingText]);

  // Persist every change (also covers the clear action writing []).
  useEffect(() => {
    saveHistory(tile.id, messages);
  }, [tile.id, messages]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    const next: ChatMessage[] = [
      ...messages.filter((m) => !m.error),
      { role: "user", content: text },
    ];
    setMessages(next.slice(-HISTORY_CAP));
    setInput("");
    setBusy(true);
    setStreamingText(null);
    const controller = new AbortController();
    abortRef.current = controller;

    // Accumulate deltas locally; render them via the streamingText bubble and
    // commit the finished reply to history in one go.
    let acc = "";
    try {
      const meta = await streamAiChat(
        {
          accountId: accountId || null,
          model: model || null,
          messages: next
            .filter((m) => !m.sample)
            .slice(-CONTEXT_TURNS)
            .map((m) => ({ role: m.role, content: m.content })),
        },
        (delta) => {
          acc += delta;
          setStreamingText(acc);
        },
        controller.signal,
      );
      setMessages((cur) =>
        [
          ...cur,
          {
            role: "assistant" as const,
            content: acc,
            sample: meta.sample || undefined,
          },
        ].slice(-HISTORY_CAP),
      );
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        // User hit Stop — keep whatever streamed in as a normal message,
        // no error bubble.
        if (acc) {
          setMessages((cur) =>
            [...cur, { role: "assistant" as const, content: acc }].slice(
              -HISTORY_CAP,
            ),
          );
        }
      } else {
        const detail =
          (err instanceof Error && err.message) || "The AI request failed.";
        setMessages((cur) =>
          [
            ...cur,
            // Keep whatever partial reply already streamed in, then the error.
            ...(acc ? [{ role: "assistant" as const, content: acc }] : []),
            { role: "assistant" as const, content: detail, error: true },
          ].slice(-HISTORY_CAP),
        );
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStreamingText(null);
    }
  }

  // Stops the in-flight reply: aborts the fetch (which also disconnects the
  // server from the provider); the catch above commits the partial text.
  function stop() {
    abortRef.current?.abort();
  }

  const shown = messages.length > 0 || configured ? messages : DEMO_CONVERSATION;
  const canClear = messages.length > 0;

  return (
    <div className={`w-full ${expanded ? "h-auto" : "h-full"} flex flex-col bg-card text-card-foreground overflow-hidden`}>
      {/* Compact header: identity + clear-conversation action. */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-border flex-shrink-0">
        <Bot className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <span className={`text-xs font-bold tracking-wide truncate ${expanded ? "sr-only" : ""}`}>
          {tile.name || "AI Chat"}
        </span>
        {!configured && (
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground border border-border rounded px-1">
            Sample
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {canClear && !editMode && (
            <button
              type="button"
              aria-label="Clear conversation"
              title="Clear conversation"
              onClick={() => setMessages([])}
              className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
            >
              <Eraser className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Conversation. */}
      <div ref={scrollRef} className={`${expanded ? "max-h-[min(400px,50dvh)]" : "flex-1"} min-h-0 overflow-y-auto px-2.5 py-2 space-y-2`}>
        {shown.length === 0 && (
          <p className="text-xs text-muted-foreground pt-2">
            Ask anything — the conversation stays on this tile.
          </p>
        )}
        {shown.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs break-words ${
                m.error
                  ? "bg-destructive/10 text-destructive border border-destructive/30 whitespace-pre-wrap"
                  : m.role === "user"
                    ? "bg-primary text-primary-foreground whitespace-pre-wrap"
                    : "bg-muted text-foreground"
              }`}
            >
              {/* Assistant replies often contain Markdown (lists, code) —
                  render it sanitized. User messages and errors stay plain. */}
              {m.role === "assistant" && !m.error ? (
                <MarkdownContent text={m.content} />
              ) : (
                m.content
              )}
              {m.sample && configured === false && messages.length > 0 && (
                <span className="block mt-1 text-[10px] opacity-70">
                  Sample reply — pick an AI account in this tile's options.
                </span>
              )}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />
              Thinking…
            </div>
          </div>
        )}
        {/* The in-flight reply, growing token by token as the stream arrives. */}
        {streamingText !== null && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs break-words bg-muted text-foreground">
              <MarkdownContent text={streamingText} />
              <span className="inline-block w-1.5 h-3 ml-0.5 align-middle bg-muted-foreground/60 animate-pulse" />
            </div>
          </div>
        )}
      </div>

      {/* Input row. Disabled while arranging the layout. */}
      <form
        className="flex items-center gap-1.5 border-t border-border px-2 py-1.5 flex-shrink-0"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={configured ? "Message…" : "Try it — replies are samples"}
          disabled={editMode || busy}
          aria-label="Chat message"
          className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground disabled:opacity-50"
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />
        {busy ? (
          <button
            type="button"
            aria-label="Stop generating"
            title="Stop generating"
            onClick={stop}
            className="text-foreground hover:text-destructive transition-colors p-1"
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send message"
            disabled={editMode || input.trim().length === 0}
            className="text-primary disabled:text-muted-foreground transition-colors p-1"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        )}
      </form>
    </div>
  );
}
