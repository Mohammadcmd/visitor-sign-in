# Legal documents (drafts)

These are **drafts for a lawyer to review before you sell**. They're written to match how the kiosk actually works, so the review is quicker. None of this is legal advice.

| Document | Who it's for | Where it's shown |
|---|---|---|
| [license-agreement.md](license-agreement.md) | The businesses that buy the kiosk | In setup, when licensing is switched on: the business accepts it, and who accepted it and when is kept with the settings. Also in Admin → Settings → License |
| [privacy-policy.md](privacy-policy.md) | Your customers and your website visitors | On your website |
| [../privacy-notice.md](../privacy-notice.md) | Visitors, posted by the kiosk | By each kiosk (the business fills it in) |

## Before you use them

1. **Have a lawyer review all three.** Ask in particular about:
   - Which state's law governs the agreement.
   - The limit of liability and the warranty wording for your state.
   - Biometric consent (face recognition) for the states your customers are in.
   - Pausing a kiosk for non-payment while keeping signing out and records available, which is what the kiosk does.
2. **Fill in the seller details** in `PAYWALL` in `web/js/plans.js`: `seller`, `supportEmail`, `supportPhone`, `price` and `law` (such as "the State of Ohio"). The agreement shown in the kiosk fills these in, along with the trial and grace periods actually set.
3. **After any change to `license-agreement.md`:**
   - Update its `Version:` line.
   - Run `node scripts/sync-agreement.mjs`.
   - Release a new version. Kiosks ask their admin to accept the new version.
