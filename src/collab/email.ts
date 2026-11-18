import type { ApiOptions } from './api';
import { createRequester } from './files';

/**
 * Email on the collaboration server (the routes are listed in
 * `server/email.ts`): whether the server sends email, whether the signed-in
 * account's address is confirmed, sending the link again, following it, and
 * the setting for emails about mentions.
 */

export interface EmailStatus {
  /** Whether this server sends email at all; when false nothing here needs showing. */
  mail: boolean;
  email: string;
  /** Whether the address is confirmed (by its link, or by Google). */
  verified: boolean;
  /** Whether a mention in a comment is also sent by email. */
  mentionEmails: boolean;
}

export function createEmailApi(options: ApiOptions = {}) {
  const { json } = createRequester(options);
  return {
    status: () => json<EmailStatus>('GET', '/me/email'),
    /** Sends a new link to confirm the address (older ones stop working). */
    resend: () => json<{ sent: true }>('POST', '/me/email/resend'),
    /** Follows a link: needs no session, so it works on any device. */
    verify: (token: string) => json<{ email: string; verified: true }>('POST', '/auth/verify-email', { token }),
    setMentionEmails: (on: boolean) => json<EmailStatus>('PATCH', '/me/email', { mentionEmails: on }),
  };
}

export type EmailApi = ReturnType<typeof createEmailApi>;

export const emailApi: EmailApi = createEmailApi();

/** Whether to ask the person to confirm their address: only when the server sends email and it is not confirmed yet. */
export function needsVerifying(status: EmailStatus | null): boolean {
  return !!status && status.mail && !status.verified;
}
