/**
 * Where a task's failure alerts go, and how they get there.
 *
 * A task runs in an isolated system session with no chat of its own, so its
 * owner is found two ways, in order:
 *   1. the chat it was created from (its origin session's messaging group and
 *      thread) — the person who asked for the task sees what became of it;
 *   2. otherwise (created from the CLI, or the origin is gone) the agent
 *      group's approver chain — scoped admin, global admin, owner — by DM,
 *      the same people who are asked to approve its privileged actions.
 */
import { resolveGroupTimezone } from '../../container-config.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { formatLocalTime } from '../../timezone.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { alertText, type Alert } from './incidents.js';

export interface AlertTarget {
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance?: string;
}

export async function resolveAlertTarget(
  agentGroupId: string,
  originSessionId: string | null,
): Promise<AlertTarget | null> {
  if (originSessionId) {
    const origin = await getSession(originSessionId);
    if (origin && origin.agent_group_id === agentGroupId && origin.messaging_group_id) {
      const mg = await getMessagingGroup(origin.messaging_group_id);
      if (mg?.platform_id) {
        return {
          channelType: mg.channel_type,
          platformId: mg.platform_id,
          threadId: origin.thread_id,
          instance: mg.instance,
        };
      }
    }
  }
  const delivery = await pickApprovalDelivery(await pickApprover(agentGroupId), '');
  if (!delivery) return null;
  const mg = delivery.messagingGroup;
  return { channelType: mg.channel_type, platformId: mg.platform_id, threadId: null, instance: mg.instance };
}

/** Send one alert. Never throws: a lost alert is logged, the incident state stands. */
export async function sendAlert(alert: Alert, agentGroupId: string, originSessionId: string | null): Promise<boolean> {
  try {
    const adapter = getDeliveryAdapter();
    const target = await resolveAlertTarget(agentGroupId, originSessionId);
    if (!adapter || !target) {
      log.warn('Task alert has nowhere to go', { seriesId: alert.seriesId, kind: alert.kind, hasAdapter: !!adapter });
      return false;
    }
    const tz = await resolveGroupTimezone(agentGroupId);
    const text = alertText(alert, (iso) => formatLocalTime(iso, tz));
    await adapter.deliver(
      target.channelType,
      target.platformId,
      target.threadId,
      'chat',
      JSON.stringify({ text }),
      undefined,
      target.instance,
    );
    return true;
  } catch (err) {
    log.warn('Task alert delivery failed', { seriesId: alert.seriesId, kind: alert.kind, err: String(err) });
    return false;
  }
}
