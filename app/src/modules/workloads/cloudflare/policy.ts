/**
 * Each app's Access application, from its "who can open" rule, in email
 * addresses: Access only knows people by the address their identity provider
 * gives it, so the policy names the people NanoClaw knows by one. Pure apart
 * from the lookups it is handed.
 *
 *   only-me        the email of the person who exposed it (or approved its
 *                  card); while none is recorded, the owners'
 *   specific       the addresses named on the app
 *   agent-members  every NanoClaw user with an email id who may use the agent
 *   signed-in      every NanoClaw user with an email id
 *
 * NanoClaw's own check still runs behind Access for every request
 * (gateway/access.ts): Access keeps everyone else from reaching the app at
 * all, the gateway decides for the people it lets through.
 */
import { createHash } from 'crypto';

import { emailOfUser } from '../gateway/access.js';
import type { AppRoute } from '../routes.js';
import type { AccessAppBody } from './api.js';

export interface PolicyDeps {
  allUserIds(): Promise<string[]>;
  ownerIds(): Promise<string[]>;
  canAccessAgentGroup(userId: string, agentGroupId: string): Promise<boolean>;
}

/** The most addresses one policy names; more is refused rather than cut short. */
export const MAX_POLICY_EMAILS = 500;

const emailsOf = (ids: string[]): string[] =>
  [...new Set(ids.map(emailOfUser).filter((e): e is string => e !== null))].sort();

export async function allowedEmails(
  route: Pick<AppRoute, 'who' | 'emails' | 'ownerUserId' | 'agentGroupId'>,
  deps: PolicyDeps,
): Promise<string[]> {
  switch (route.who) {
    case 'only-me':
      return emailsOf(route.ownerUserId ? [route.ownerUserId] : await deps.ownerIds());
    case 'specific':
      return [...new Set(route.emails)].sort();
    case 'agent-members': {
      const ids: string[] = [];
      for (const u of await deps.allUserIds())
        if (emailOfUser(u) && (await deps.canAccessAgentGroup(u, route.agentGroupId))) ids.push(u);
      return emailsOf(ids);
    }
    case 'signed-in':
      return emailsOf(await deps.allUserIds());
    default:
      return [];
  }
}

const common = {
  type: 'self_hosted' as const,
  session_duration: '24h',
  app_launcher_visible: false,
  http_only_cookie_attribute: true,
  same_site_cookie_attribute: 'lax' as const,
};

const NOBODY = { name: 'Nobody', decision: 'deny' as const, include: [{ everyone: {} }], precedence: 1 };

/** One app's Access application: its hostname, and its people (nobody when there are none). */
export function appBody(slug: string, app: string, hostname: string, emails: string[]): AccessAppBody {
  if (emails.length > MAX_POLICY_EMAILS)
    throw new Error(`${emails.length} people is more than one Access policy names here (${MAX_POLICY_EMAILS})`);
  return {
    ...common,
    name: `NanoClaw ${slug}: ${app}`,
    domain: hostname,
    policies: emails.length
      ? [
          {
            name: 'Who can open',
            decision: 'allow',
            include: emails.map((email) => ({ email: { email } })),
            precedence: 1,
          },
        ]
      : [NOBODY],
  };
}

/** The catch-all on *.<domain>: any hostname without its own application is refused. */
export function catchAllBody(slug: string, domain: string): AccessAppBody {
  return { ...common, name: `NanoClaw ${slug}: unpublished apps`, domain: `*.${domain}`, policies: [NOBODY] };
}

export const bodyHash = (b: AccessAppBody): string =>
  createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 16);
