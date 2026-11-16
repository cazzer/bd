// A button that shows and hides a panel (shared-nav-header, design.md
// decisions 5 and 8): the header's Views menu and its phone Menu. The
// caller draws a button with `aria-expanded` and `aria-controls` and the
// panel; this owns the open state and the ways it closes — Escape (focus
// back on the button; an Escape something inside already handled is left
// alone), a press outside both, focus moving out of both (Tab past the
// end), or the caller's `close` after a choice.

import { useCallback, useEffect, useRef, useState } from "react";

export interface Disclosure {
  open: boolean;
  toggle: () => void;
  show: () => void;
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
  const show = useCallback(() => setOpen(true), []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: Event) {
      const target = e.target as Node | null;
      if (target !== null && (buttonRef.current?.contains(target) || panelRef.current?.contains(target))) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close(true);
    }
    // Focus leaving for somewhere else on the page; a null `relatedTarget`
    // (the window losing focus, a press on nothing focusable) is the
    // pointer handler's to judge, not this one's.
    function onFocusOut(e: FocusEvent) {
      const from = e.target as Node | null;
      const to = e.relatedTarget as Node | null;
      const inside = (node: Node | null) => node !== null && (buttonRef.current?.contains(node) === true || panelRef.current?.contains(node) === true);
      if (!inside(from) || to === null || inside(to)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [open, close]);

  return { open, toggle, show, close, buttonRef, panelRef };
}
