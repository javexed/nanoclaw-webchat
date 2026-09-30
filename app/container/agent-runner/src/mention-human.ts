/**
 * "Reaching a human" prompt section — consumer of the destinations prompt seam,
 * paired with the host's writeRoomHumans. Without it an agent's only known
 * correspondents are channels and other AGENTS, so something needing a person
 * goes to the nearest agent. Webchat already resolves `@handle` in
 * agent-authored messages (room badge + push); this supplies the knowledge.
 */
import { getInboundDb } from './mailbox/sqlite/connection.js';
import { registerPromptSectionContributor } from './seam/index.js';

interface RoomHumanRow {
  handle: string;
  display_name: string | null;
}

function roomHumans(): RoomHumanRow[] {
  try {
    return getInboundDb()
      .prepare('SELECT handle, display_name FROM room_humans ORDER BY handle')
      .all() as RoomHumanRow[];
  } catch {
    // Table absent: host predates this, or the session is not a webchat room.
    return [];
  }
}

registerPromptSectionContributor(() => {
  const humans = roomHumans();
  if (humans.length === 0) return null;

  const who = humans.map((h) => (h.display_name ? `\`@${h.handle}\` (${h.display_name})` : `\`@${h.handle}\``));

  return [
    '### Reaching a human',
    '',
    `You can get a person's attention by @-mentioning them in your reply: ${who.join(', ')}. They receive a notification and a badge on the room, whether or not they are currently reading it.`,
    '',
    "Use it when something genuinely needs a person: a decision that isn't yours to make, a bug in the system itself, or a request you cannot complete and cannot diagnose. Say what you need and why in the same message — a bare mention makes them come and ask.",
    '',
    'Do NOT route these to another agent. Other agents are peers with their own jobs, not a way to reach the operator; sending a human matter to one means nobody is told.',
  ].join('\n');
});
