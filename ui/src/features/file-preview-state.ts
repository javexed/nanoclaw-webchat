// Bridge ref for the FilePreview island. Rows arrive with the thumbnail URL
// already resolved: object URLs are created and revoked by files.ts, which owns
// the pendingThumbUrls map and the revoke on clear. A component that minted
// them would leak on every re-render.
import { ref } from 'vue';

export interface PreviewRow {
  id: number;
  name: string;
  size: string;
  thumbUrl: string | null;
}

export const previewRows = ref<PreviewRow[]>([]);
