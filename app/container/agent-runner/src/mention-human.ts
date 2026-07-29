/**
 * "Reaching a human" prompt section — fork-owned consumer of the destinations
 * prompt seam (R4), paired with the host's writeRoomHumans.
 *
 * Without this an agent's only known correspondents are its destinations:
 * channels and other AGENTS. Faced with something needing a person it picks the
 * nearest agent, which cannot help. That is not hypothetical — an agent with a
 * genuine bug to report sent it to a coding agent, got told "I'm not a human,
 * route this to the actual admin", and the report sat unread for ~15 hours.
 *
 * The delivery mechanism already worked: webchat resolves `@handle` on every
 * message including agent-authored ones, and the mentioned person gets a room
 * badge plus a push. Only the knowledge was missing.
 */
import { getInboundDb } from './db/connection.js';
import { registerPromptSectionContributor } from './destinations.js';

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
