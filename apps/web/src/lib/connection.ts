// Whether the server has refused this browser for want of a client token
// (tailnet-hosting decision 5). The tRPC batch link flips it on a 401;
// ConnectGate swaps the app for the connect screen while it is set. It
// never flips back: a successful connect reloads the page.

type Listener = () => void;

let unauthorized = false;
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

/** Tests only: back to the state a fresh page starts in. */
export function resetConnectionForTests(): void {
  unauthorized = false;
}
