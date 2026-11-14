// The connect screen (tailnet-hosting decision 5): a browser reaching the
// board over the tailnet with no cookie gets 401 on its first query, and
// pastes its client token here once. `POST /auth/connect` answers a valid
// token with an HttpOnly cookie, so the token never sits in a URL, in
// storage, or anywhere script can read it again; the page then reloads
// and every request carries the cookie.
//
// The screen can't tell a first visit from a token revoked mid-session
// (the cookie is HttpOnly), so its copy covers both.

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import {
  clearConnectAttempt,
  hasConnectAttempt,
  isUnauthorized,
  markConnectAttempt,
  subscribeUnauthorized,
} from "../lib/connection.js";

export interface ConnectGateProps {
  children: ReactNode;
}

/** The app, until the server refuses this browser; then the connect screen. */
export function ConnectGate({ children }: ConnectGateProps) {
  const unauthorized = useSyncExternalStore(subscribeUnauthorized, isUnauthorized);
  return unauthorized ? <ConnectScreen /> : <>{children}</>;
}

export interface ConnectScreenProps {
  /** The cookie is set: by default, reload so every request carries it. */
  onConnected?: () => void;
}

type SubmitState = { kind: "idle" } | { kind: "submitting" } | { kind: "error"; message: string };

const COOKIE_NOT_KEPT = "Connected, but this browser didn't keep the connection. Check that cookies aren't blocked for this site.";

function messageForStatus(status: number): string {
  if (status === 401) {
    return "That token wasn't accepted. Check it was copied whole, and that it's a human token; if it was revoked, create a new one on the host.";
  }
  if (status === 400 || status === 413 || status === 415) return "That doesn't look like a token.";
  if (status >= 500) return `Connecting failed (HTTP ${status}). Try again.`;
  return `Connecting failed (HTTP ${status}).`;
}

export function ConnectScreen({ onConnected = () => location.reload() }: ConnectScreenProps) {
  const [token, setToken] = useState("");
  // Read in the initializer, cleared in an effect: StrictMode runs the
  // initializer twice, and clearing there would hide the message.
  const [state, setState] = useState<SubmitState>(() =>
    hasConnectAttempt() ? { kind: "error", message: COOKIE_NOT_KEPT } : { kind: "idle" },
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => clearConnectAttempt(), []);

  // After the error is rendered, so the input's description already names
  // it; selected, so the next paste replaces what was refused.
  useEffect(() => {
    if (state.kind !== "error") return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [state]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = token.trim();
    if (trimmed === "") {
      setState({ kind: "error", message: "Paste a token first." });
      return;
    }
    setState({ kind: "submitting" });
    let res: Response;
    try {
      res = await fetch("/auth/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: trimmed }),
        credentials: "same-origin",
      });
    } catch {
      setState({ kind: "error", message: "Couldn't reach Breakdown. Check the connection and try again." });
      return;
    }
    if (res.status === 204) {
      markConnectAttempt();
      onConnected();
      return;
    }
    setState({ kind: "error", message: messageForStatus(res.status) });
  }

  const submitting = state.kind === "submitting";
  const failed = state.kind === "error";

  return (
    <main className="flex h-dvh flex-col overflow-y-auto px-4 py-8">
      <div aria-hidden="true" className="ambience pointer-events-none fixed inset-0 -z-10" />
      <form onSubmit={handleSubmit} noValidate className="glass m-auto w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-fg">Connect to Breakdown</h1>
        <p id="connect-help" className="mt-1 text-sm text-fg-muted">
          This browser isn't connected to Breakdown, or its token was revoked. On the host, run{" "}
          <code className="font-mono text-fg">pnpm -s client-token create &lt;name&gt; --scope human</code> and paste
          the <code className="font-mono text-fg">bdt_…</code> value it prints.
        </p>
        <label htmlFor="connect-token" className="mt-5 block text-sm font-medium text-fg">
          Client token
        </label>
        <input
          ref={inputRef}
          id="connect-token"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          enterKeyHint="go"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={failed}
          aria-describedby={failed ? "connect-error connect-help" : "connect-help"}
          className="mt-1 min-h-11 w-full rounded-xl border border-hairline bg-surface-strong px-3 py-2 font-mono text-base text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        />
        {failed && (
          <p id="connect-error" role="alert" className="mt-2 text-sm text-red-300">
            {state.message}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="mt-5 min-h-11 w-full rounded-xl bg-accent px-3 py-2 text-sm font-medium text-ground hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-50"
        >
          {submitting ? "Connecting…" : "Connect"}
        </button>
      </form>
    </main>
  );
}
