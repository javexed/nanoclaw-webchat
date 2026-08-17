// Bridge refs for the AttachPicker island: the filtered rows and the empty
// message. renderAttachPickerList() applies the config's filter and shapes the
// rows, because the config (items/searchText/name/meta/isAttached) is supplied
// by whichever panel opened the picker and is not this component's business.
import { ref } from 'vue';

export interface AttachRow {
  key: string;
  name: string;
  meta: string;
  attached: boolean;
}

export const attachRows = ref<AttachRow[]>([]);
export const attachEmptyText = ref('');

/** The open picker's config, or null when closed. */
export const attachPickerCfg = ref<any>(null);
/** Files staged in the composer, awaiting send. */
export const pendingFiles = ref<any[]>([]);
