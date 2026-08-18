/**
 * Send-file prompt hint — fork-owned consumer of the destinations prompt seam
 * (R4). Part of the webchat app tree composed onto a NanoClaw checkout by
 * install.sh. Appends an inline-attachment hint to the destinations
 * prompt when at least one destination is a chat channel (webchat, slack,
 * telegram, ...). Loaded for side effects from the runner entry (index.ts).
 */
import { registerPromptSectionContributor } from './destinations.js';

registerPromptSectionContributor((destinations) => {
  if (!destinations.some((d) => d.type === 'channel')) return null;
  return [
    '### Sending files',
    '',
    "When the user asks for a file (a report, screenshot, generated artifact, exported data), deliver it — don't just describe it. Save the file under `uploads/` in your group folder and call the `send_file` MCP tool with `path: \"uploads/<filename>\"` and an optional `text` caption. The destination renders it as an attachment in its native format (inline preview in webchat; uploaded file on Slack, Telegram, etc.).",
    '',
    'Use `send_file` for deliverables intended for the user. Working files / scratch artifacts stay in your workspace.',
    '',
    'The tool is always available as `mcp__nanoclaw__send_file` — call it directly. Do NOT probe for it with ToolSearch: NanoClaw MCP tools are never deferred, so ToolSearch reports "no matching deferred tools" for them even though they are callable. That result does not mean the tool is missing.',
  ].join('\n');
});
