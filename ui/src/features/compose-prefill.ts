// Puts text from a rendered HTML attachment into the composer, never sending
// it, and shows where it came from until it is sent or cleared.
import { $ } from '../core/dom.js';

function originEl(): HTMLElement | null {
  return $('#compose-origin');
}

export function clearComposeOrigin(): void {
  const el = originEl();
  if (el && !el.hidden) {
    el.hidden = true;
    el.textContent = '';
  }
}

// Emptying the composer by hand also drops the note.
let watching = false;
function clearWhenEmpty(this: HTMLTextAreaElement): void {
  if (this.value.trim()) return;
  clearComposeOrigin();
  this.removeEventListener('input', clearWhenEmpty);
  watching = false;
}

/** Pre-fill the composer: replaces an empty draft, appends to one in progress. */
export function prefillComposer(text: string, filename: string): void {
  const input = $<HTMLTextAreaElement>('#message-input');
  if (!input || input.disabled) return;
  input.value = input.value.trim() ? `${input.value.replace(/\s+$/, '')}\n${text}` : text;
  // Same path as typing: the composer's own input listeners (size, send button)
  // see the new text.
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const el = originEl();
  if (el) {
    el.textContent = `From ${filename}`;
    el.title = el.textContent;
    el.hidden = false;
  }
  if (!watching) {
    watching = true;
    input.addEventListener('input', clearWhenEmpty);
  }
}
