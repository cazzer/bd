// The connect screen (tailnet-hosting decision 5): a browser reaching the
// board over the tailnet with no cookie gets 401 on its first query, and
// pastes its client token here once. `POST /auth/connect` answers a valid
// token with an HttpOnly cookie, so the token never sits in a URL, in
// storage, or anywhere script can read it again; the page then reloads
// and every request carries the cookie.

import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { isUnauthorized, subscribeUnauthorized } from "../lib/connection.js";

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

export function ConnectScreen({ onConnected = () => location.reload() }: ConnectScreenProps) {
  const [token, setToken] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ kind: "submitting" });
    let res: Response;
    try {
      res = await fetch("/auth/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
        credentials: "same-origin",
      });
    } catch {
      setState({ kind: "error", message: "Couldn't reach Breakdown. Check the connection and try again." });
      return;
    }
    if (res.status === 204) {
      onConnected();
      return;
    }
    setState({
      kind: "error",
      message: res.status === 401 ? "That token wasn't accepted." : `Connecting failed (HTTP ${res.status}). Try again.`,
    });
  }

  const submitting = state.kind === "submitting";

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <form onSubmit={handleSubmit} className="glass w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-fg">Connect to Breakdown</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Paste this device's client token. It's needed once; the browser remembers the connection.
        </p>
        <label htmlFor="connect-token" className="mt-5 block text-sm font-medium text-fg">
          Client token
        </label>
        <input
          id="connect-token"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          required
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={state.kind === "error"}
          aria-describedby={state.kind === "error" ? "connect-error" : undefined}
          className="mt-1 w-full rounded-xl border border-hairline bg-surface-strong px-3 py-2 font-mono text-base text-fg focus:outline-none focus:ring-2 focus:ring-accent"
        />
        {state.kind === "error" && (
          <p id="connect-error" role="alert" className="mt-2 text-sm text-red-300">
            {state.message}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting}
          className="mt-5 w-full rounded-xl bg-accent px-3 py-2 text-sm font-medium text-ground hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-ground disabled:opacity-50"
        >
          {submitting ? "Connecting…" : "Connect"}
        </button>
      </form>
    </main>
  );
}
