// ── Busy control ─────────────────────────────────────────────────────────────
// The one in-progress affordance (DESIGN.md §5, "Long-running operations"):
// the pressed control shows the wait itself — spinner, verb, disabled.
// Vue templates use BusyLabel.vue, which renders the same markup.

/** Put `btn` in its busy state; returns the restore function for the `finally`. */
export function buttonBusy(btn: HTMLElement & { disabled?: boolean }, busyLabel: string): () => void {
  // The label's own nodes, so an icon in it comes back too (textContent would drop it).
  const original = Array.from(btn.childNodes);
  btn.disabled = true;
  btn.textContent = '';
  const spin = document.createElement('span');
  spin.className = 'btn-spinner';
  spin.setAttribute('aria-hidden', 'true');
  btn.appendChild(spin);
  btn.appendChild(document.createTextNode(busyLabel));
  return () => {
    btn.disabled = false;
    btn.replaceChildren(...original);
  };
}
