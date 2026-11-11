// The license agreement a business accepts in setup (when licensing is
// switched on), with the seller's details and the real trial and grace
// periods filled in. The text comes from docs/legal/license-agreement.md
// (scripts/sync-agreement.mjs).
import { AGREEMENT } from './agreement-text.js';
import { PAYWALL } from './plans.js';

export const AGREEMENT_VERSION = AGREEMENT.version;
export const AGREEMENT_TITLE = AGREEMENT.title;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The agreement as HTML for this business, with the seller's details filled in. */
export function agreementHtml(company) {
  const seller = PAYWALL.seller || 'the seller';
  const values = {
    seller,
    company: company || 'your business',
    email: PAYWALL.supportEmail || "the seller's support email",
    phone: PAYWALL.supportPhone || '',
    price: PAYWALL.price || 'the price you were quoted',
    trialDays: String(PAYWALL.trialDays),
    graceDays: String(PAYWALL.graceDays),
    warnDays: String(PAYWALL.warnDays),
    law: PAYWALL.law || `the state where ${seller} is based`,
  };
  return AGREEMENT.html.replace(/\{(\w+)\}/g, (m, k) => (k in values ? esc(values[k]) : m)).replace(/ · (?=<\/p>)/g, '');
}

/** Whether this kiosk's settings record acceptance of the current version. */
export const agreementAccepted = (s) => !!s.agreement?.by && s.agreement.version === AGREEMENT_VERSION;
