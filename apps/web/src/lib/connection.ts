// Whether the server has refused this browser for want of a client token
// (tailnet-hosting decision 5). The tRPC batch link flips it on a 401;
// ConnectGate swaps the app for the connect screen while it is set. It
// never flips back: a successful connect reloads the page.

type Listener = () => void;

let unauthorized = false;
let authorizedSeen = false;
const listeners = new Set<Listener>();

export function markUnauthorized(): void {
  if (unauthorized) return;
  unauthorized = true;
  for (const listener of listeners) listener();
}

export function isUnauthorized(): boolean {
  return unauthorized;
}

export function subscribeUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The connect screen reloads once the server sets the cookie. If the
// browser then refuses to keep it, the reloaded page gets 401 again and
// the screen would come back looking as though nothing happened. A
// sessionStorage marker set just before the reload lets the next connect
// screen say so instead. It is only a marker: the token is never stored.
// The cookie is HttpOnly, so this marker is the client's only evidence.
const CONNECT_ATTEMPT_KEY = "bd-connect-attempt";

export function markConnectAttempt(): void {
  try {
    sessionStorage.setItem(CONNECT_ATTEMPT_KEY, "1");
  } catch {
    // Storage blocked: the screen just won't explain a lost cookie.
  }
}

export function hasConnectAttempt(): boolean {
  try {
    return sessionStorage.getItem(CONNECT_ATTEMPT_KEY) !== null;
  } catch {
    return false;
  }
}

export function clearConnectAttempt(): void {
  try {
    sessionStorage.removeItem(CONNECT_ATTEMPT_KEY);
  } catch {
    // Nothing could have been stored either.
  }
}

/**
 * A request got through: any connect attempt behind this page load worked,
 * so its marker must not survive to make a later revocation look like a
 * blocked cookie. Touches storage once per page load.
 */
export function markAuthorized(): void {
  if (authorizedSeen) return;
  authorizedSeen = true;
  clearConnectAttempt();
}

/** Tests only: back to the state a fresh page starts in. */
export function resetConnectionForTests(): void {
  unauthorized = false;
  authorizedSeen = false;
}
