// Bridge ref for the SearchResults island. Rows arrive PRE-ESCAPED and with the
// FTS5 «…» highlight markers already turned into <mark> — see the component.
import { ref } from 'vue';

export interface SearchRow {
  id: string;
  roomId: string;
  roomName: string;
  time: string;
  snipHtml: string;
}

export const searchRows = ref<SearchRow[]>([]);
