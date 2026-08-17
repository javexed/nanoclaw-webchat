// Bridge ref for the RoomWiredAgents island: the agents wired into the open
// room. renderRoomWiredAgents() syncs it, and also keeps the reply-mode info
// button — which lives OUTSIDE this list — imperative.
import { ref } from 'vue';
export const roomWiredRows = ref<any[]>([]);
