<script setup lang="ts">
/**
 * The Ollama host cards — twenty-fifth island, and the first CLUSTER one.
 *
 * Mounted into <div id="ollama-host-cards">, exclusively owned by this module.
 *
 * Three renderers previously shared this subtree: buildOllamaHostCard made the
 * card, loadOllamaHostModels filled .ollama-model-list, renderOllamaPulls filled
 * .ollama-pull-status. Each rebuilt or overwrote elements the others owned, so
 * none could convert alone. They are three slices of one state object now.
 *
 * Element ORDER is load-bearing and matches the builder exactly: head, then the
 * accordion body (model list + pull row), then the pull status OUTSIDE the body
 * so progress stays visible while the card is collapsed.
 *
 * The chevron is first inside the head because makeCardAccordion prepended it.
 */
import { computed } from 'vue';
import SelectToggle from './SelectToggle.vue';
import { hostModels, hostPullPreview, hostPulls, hosts, openCards, setCardOpen } from './ollama-cards-state.js';
import { ollamaCardId } from './ollama-cards.js';

const props = defineProps<{
  onRemove: (host: string, model: string) => void;
  onCancel: (host: string, model: string) => void;
  onPreview: (host: string, model: string) => void;
  onPull: (host: string, model: string, input: HTMLInputElement, btn: HTMLElement) => void;
}>();

const LOADING = 'Loading…';
const NO_MODELS = 'No models installed';
const SYS_HEADING = 'System — not selectable';
const CLASSIFIER = 'classifier';
const CLASSIFIER_TITLE = 'Auto-routing classifier — infrastructure, not selectable as an agent model';
const PULL = 'Pull';
const CANCEL = 'Cancel';
const PULL_PLACEHOLDER = 'Model to pull, e.g. qwen3.5:4b…';
const CHEVRON = '›';
const DOTS = '…';

const cards = computed(() =>
  hosts.value.map((host) => {
    const m = hostModels.value[host];
    const open = openCards.value.has(host);
    const rows = (list: any[]) =>
      list.map((x: any) => ({
        name: x.name,
        // Guarded: a row arriving without a size rendered the literal "NaN GB".
        // /api/tags always carries one today, so this is belt-and-braces — but
        // "NaN GB" is the kind of thing that reaches a screenshot before anyone
        // notices, and an em dash costs nothing.
        meta: typeof x.size === 'number' ? (x.size / 1e9).toFixed(1) + ' GB' : '—',
        loaded: !!x.loaded,
        vram: typeof x.size_vram === 'number' ? (x.size_vram / 1e9).toFixed(1) + ' GB in VRAM' : '',
      }));
    return {
      host,
      id: ollamaCardId(host),
      label: host.replace(/^https?:\/\//, ''),
      open,
      // '…' until the model count arrives, exactly as the builder seeded it.
      summary: !m || m.phase === 'loading' ? DOTS : m.phase === 'error' ? '' : countLabel(m),
      phase: m ? m.phase : 'loading',
      error: m ? m.error : '',
      selectable: m ? rows(m.selectable) : [],
      system: m ? rows(m.system) : [],
      pull: hostPulls.value[host] || null,
      preview: hostPullPreview.value[host] || null,
    };
  }),
);

function countLabel(m: any): string {
  const n = m.selectable.length + m.system.length;
  return n + ' model' + (n === 1 ? '' : 's');
}

/** Card actions keep working — a click on a button must not toggle the card. */
function toggle(host: string, e: MouseEvent) {
  if ((e.target as HTMLElement).closest('button')) return;
  setCardOpen(host, !openCards.value.has(host));
}

function pull(host: string, e: Event) {
  const row = (e.currentTarget as HTMLElement).closest('.ollama-pull-row')!;
  const input = row.querySelector('.ollama-pull-input') as HTMLInputElement;
  props.onPull(host, input.value.trim(), input, row.querySelector('button')!);
}

function pullKey(host: string, e: KeyboardEvent) {
  if (e.key !== 'Enter') return;
  const row = (e.currentTarget as HTMLElement).closest('.ollama-pull-row')!;
  const input = row.querySelector('.ollama-pull-input') as HTMLInputElement;
  props.onPull(host, input.value.trim(), input, row.querySelector('button')!);
}

function preview(host: string, e: Event) {
  props.onPreview(host, (e.target as HTMLInputElement).value);
}
</script>

<template>
  <div v-for="c in cards" :key="c.host" class="ollama-host-card" :id="c.id" :data-host="c.host">
    <div class="ollama-host-head clickable" role="button" tabindex="0" @click="toggle(c.host, $event)">
      <span :class="c.open ? 'ollama-card-chevron open' : 'ollama-card-chevron'">{{ CHEVRON }}</span
      ><span class="ollama-host-name">{{ c.label }}</span
      ><span class="ollama-card-summary" :hidden="c.open">{{ c.summary }}</span>
    </div>
    <div :hidden="!c.open">
      <ul class="ollama-model-list">
        <li v-if="c.phase === 'loading'" class="ollama-muted">{{ LOADING }}</li>
        <li v-else-if="c.phase === 'error'" class="ollama-muted">{{ c.error }}</li>
        <li v-else-if="c.selectable.length === 0 && c.system.length === 0" class="ollama-muted">{{ NO_MODELS }}</li>
        <template v-else>
          <li v-for="m in c.selectable" :key="m.name">
            <span class="ollama-model-name">{{ m.name }}</span
            ><span class="ollama-model-meta">{{ m.meta }}</span
            ><span v-if="m.loaded" class="ollama-loaded-badge" :title="m.vram">in memory</span
            ><SelectToggle kind="ollama" :endpoint="c.host" :model-id="m.name" :display-name="m.name" /><button
              class="ollama-model-remove"
              type="button"
              :aria-label="`Remove ${m.name} from this server`"
              title="Remove from server…"
              @click="props.onRemove(c.host, m.name)"
            >✕</button>
          </li>
          <template v-if="c.system.length">
            <li class="ollama-model-sysheading">{{ SYS_HEADING }}</li>
            <li v-for="m in c.system" :key="m.name">
              <span class="ollama-model-name">{{ m.name }}</span
              ><span class="ollama-model-meta">{{ m.meta }}</span
              ><span v-if="m.loaded" class="ollama-loaded-badge" :title="m.vram">in memory</span
              ><span class="ollama-model-systag" :title="CLASSIFIER_TITLE">{{ CLASSIFIER }}</span>
            </li>
          </template>
        </template>
      </ul>
      <div class="ollama-pull-row">
        <input
          type="text"
          :placeholder="PULL_PLACEHOLDER"
          class="ollama-pull-input"
          @keydown="pullKey(c.host, $event)"
          @input="preview(c.host, $event)"
        />
        <button class="btn btn-secondary" type="button" @click="pull(c.host, $event)">{{ PULL }}</button>
      </div>
      <!-- What this pull would cost, while it is still being typed. Absent
           unless the size is actually known — see previewOllamaPull. -->
      <div v-if="c.preview" class="ollama-pull-preview" :class="{ warn: c.preview.warn }">{{ c.preview.text }}</div>
    </div>
    <div class="ollama-pull-status" :hidden="!c.pull">
      <template v-if="c.pull">
        <template v-if="c.pull.status === 'pulling'">
          <div class="ollama-pull-line progress">
            <span class="ollama-pull-text">Pulling {{ c.pull.model }} — {{ c.pull.detail }}</span>
            <!-- The way out, at the point where it is wanted: mid-download,
                 not in a dialog before one. Ollama keeps the blobs it already
                 has, so a later re-pull resumes. -->
            <button class="ollama-pull-cancel" type="button" @click="props.onCancel(c.host, c.pull.model)">
              {{ CANCEL }}
            </button>
          </div>
          <div class="ollama-pull-bar"><span :style="{ width: c.pull.pct + '%' }"></span></div>
        </template>
        <template v-else-if="c.pull.status === 'success'">
          <div class="ollama-pull-line ok">Pulled {{ c.pull.model }}</div>
          <!-- Fitness at pull time — data, not prose: the three facts that
               decide whether this model works on THIS hardware right now. -->
          <div v-for="v in c.pull.verdict || []" :key="v" class="ollama-pull-line pull-verdict">{{ v }}</div>
        </template>
        <!-- Cancelled is neutral, not an error: the operator asked for it. -->
        <div v-else-if="c.pull.status === 'cancelled'" class="ollama-pull-line">
          Cancelled pull of {{ c.pull.model }}
        </div>
        <div v-else class="ollama-pull-line err">Pull of {{ c.pull.model }} failed: {{ c.pull.error }}</div>
      </template>
    </div>
  </div>
</template>
