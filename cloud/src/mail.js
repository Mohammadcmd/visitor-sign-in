// Sending email: Resend's API (free for 3,000 emails a month), or, while
// developing and testing (MAIL_MODE=log), a log the tests can read instead.
//
// Settings (Cloudflare secrets and variables):
//   RESEND_API_KEY   from resend.com (a secret: npx wrangler secret put RESEND_API_KEY)
//   MAIL_FROM        the sender, such as "Visitor Sign-In <hello@yourdomain.com>" (a domain verified in Resend)

/** Sends one email. Returns { ok } or { ok: false, error }. log(mail) receives it in log mode. */
export async function sendMail(env, mail, log) {
  if (env.MAIL_MODE === 'log') {
    await log(mail);
    return { ok: true };
  }
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return { ok: false, error: 'mail_not_configured' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
  });
  if (!res.ok) {
    console.error('email not sent', res.status, await res.text().catch(() => ''));
    return { ok: false, error: 'mail_failed' };
  }
  return { ok: true };
}
