// A button that shows and hides a panel (shared-nav-header, design.md
// decisions 5 and 8): the header's Views menu and its phone Menu. The
// caller draws a button with `aria-expanded` and `aria-controls` and the
// panel; this owns the open state and the ways it closes — Escape (focus
// back on the button), a press outside both, or the caller's `close` after
// a choice.

import { useCallback, useEffect, useRef, useState } from "react";

export interface Disclosure {
  open: boolean;
  toggle: () => void;
  /** Close, moving focus back to the button when `returnFocus`. */
  close: (returnFocus: boolean) => void;
  buttonRef: { current: HTMLButtonElement | null };
  panelRef: { current: HTMLElement | null };
}

export function useDisclosure(): Disclosure {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: Event) {
      const target = e.target as Node | null;
      if (target !== null && (buttonRef.current?.contains(target) || panelRef.current?.contains(target))) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close(true);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return { open, toggle, close, buttonRef, panelRef };
}
