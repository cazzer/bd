// React propagates a <dialog>'s `cancel` and `close` through the component
// tree like any bubbling event, so a dialog nested inside another (the
// Lightbox inside the review-all modal) reaches the outer dialog's
// handlers too. A dialog's handlers act only on their own events.

export function isOwnDialogEvent(e: { target: unknown; currentTarget: unknown }): boolean {
  return e.target === e.currentTarget;
}
