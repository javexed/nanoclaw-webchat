// ── Host list editor ─────────────────────────────────────────────────────────
// One row per host with Remove, and a box to add more (several at once:
// spaces, commas or new lines). Every change saves at once; the server
// normalizes and validates, and what it stored is what the list shows. Used by
// the install allowlist (Manage → Network) and each agent's own hosts.
//
// Markup inside `root`: [data-hosts] (the rows), input[data-host-input] and
// button[data-host-add].
import { esc } from '../core/dom.js';

export interface HostListEditor {
  set(hosts: string[]): void;
  get(): string[];
  /** Save the list with these hosts added (the presets, "Allow"). */
  add(hosts: string[]): Promise<void>;
  replace(hosts: string[]): Promise<void>;
}

export function hostListEditor(
  root: HTMLElement,
  save: (hosts: string[]) => Promise<string[] | null>,
  empty = '<p class="cred-hint">None.</p>',
): HostListEditor {
  let hosts: string[] = [];
  const listEl = root.querySelector<HTMLElement>('[data-hosts]');
  const input = root.querySelector<HTMLInputElement>('[data-host-input]');
  const addBtn = root.querySelector<HTMLButtonElement>('[data-host-add]');

  const render = () => {
    if (!listEl) return;
    listEl.innerHTML = hosts.length
      ? hosts
          .map(
            (h) =>
              `<div class="secret-row"><code>${esc(h)}</code><button class="btn btn-ghost" type="button" data-remove="${esc(h)}">Remove</button></div>`,
          )
          .join('')
      : empty;
  };

  const commit = async (next: string[]): Promise<boolean> => {
    const saved = await save(next);
    if (!saved) return false;
    hosts = saved;
    render();
    return true;
  };

  const addTyped = async () => {
    if (!input) return;
    const typed = input.value.split(/[\s,]+/).filter(Boolean);
    if (!typed.length) return;
    if (addBtn) addBtn.disabled = true;
    try {
      if (await commit([...hosts, ...typed.filter((h) => !hosts.includes(h))])) input.value = '';
    } finally {
      if (addBtn) addBtn.disabled = false;
    }
  };

  addBtn?.addEventListener('click', () => void addTyped());
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void addTyped();
    }
  });
  listEl?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
    if (!btn) return;
    btn.disabled = true;
    void commit(hosts.filter((h) => h !== btn.dataset.remove)).then((ok) => {
      if (!ok) btn.disabled = false;
    });
  });

  return {
    set(h) {
      hosts = [...h];
      render();
    },
    get: () => hosts,
    async add(more) {
      const add = more.filter((h) => !hosts.includes(h));
      if (add.length) await commit([...hosts, ...add]);
    },
    async replace(next) {
      await commit(next);
    },
  };
}
