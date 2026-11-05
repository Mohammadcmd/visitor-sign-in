# Roadmap: from kiosk to a real app

The goal: a business downloads the app, signs up, and pays per kiosk tablet. Tablets, the office and billing are all connected, with no Google script to copy and no files to download from GitHub. Built the most cost-effective way: close to nothing until there are paying customers.

This file is the plan and the progress. Each work session updates the checklists.

## What it's built on, and what it costs

| Part | Choice | Cost |
|---|---|---|
| Cloud service (accounts, records, tablets) | Cloudflare Workers, with one Durable Object per company holding that company's records | Free plan to build and test (100,000 requests a day). **$5 a month** (the Workers Paid plan, with far higher limits) once paying customers rely on it |
| Photos, signatures, PDFs, logos | Cloudflare R2 | Free up to 10 GB, then about $0.015 per GB a month. No download fees |
| Office dashboard, website, browser kiosk | Cloudflare (static hosting) | Free |
| Domain | Cloudflare Registrar (sold at cost) | About $10 a year for a .com |
| Email (alerts, host notices, signed copies, sign-in codes) | Resend, then Amazon SES at volume | Free up to 3,000 a month (100 a day); SES is $0.10 per 1,000 |
| Payments | Stripe Billing: per-tablet subscriptions (the subscription's quantity is the number of tablets). Or a check for a yearly plan, recorded by you | Stripe: no monthly fee. About 2.9% + 30¢ per card payment plus 0.7% for Billing: about $1.70 on a $39 charge. Yearly plans by bank transfer (ACH): 0.8%, capped at $5. Stripe Tax (0.5%) only in states where you register. Checks: no fee |
| Android app | Google Play | **$25 once** |
| iPad | The browser kiosk at first (Add to Home Screen, Guided Access) | Free. The App Store ($99 a year) when iPad customers justify it |
| Error reports, uptime | Sentry free plan, Cloudflare's own logs | Free |
| Terms of service, privacy policy | Drafted here; a lawyer's review is worth paying for before launch | Review fee only |

**To build and test: $0. To launch: $25 + a domain. With paying customers: about $5 a month**, plus Stripe's share of each payment.

Why one Durable Object per company: each company's records live in their own small database, so one company's data can never leak into another's. The object handles one request at a time, which keeps tablets from overwriting each other. And it runs the same business rules as the on-tablet kiosk (`web/js/engine.js`), so the tablet and the cloud behave the same and share tests.

## Plans and licensing

- **Free:** one tablet, records kept on the tablet, no account needed.
- **Paid, per kiosk tablet, monthly or yearly:** the cloud (several tablets, office dashboard, emails, signed-copy PDFs), and every Pro feature. Proposed: $349 a year or $35 a month per kiosk (to be confirmed).
- **Two ways to pay:**
  - **Card or bank transfer through Stripe:** monthly or yearly, automatic.
  - **Check:** yearly plans only. The customer gets an invoice saying who to make the check payable to and where to mail it. Their kiosks work straight away, with 30 days to pay. When the check arrives you record it, and that extends their plan a year.
  - Either way it's the same plan record: how many kiosks, paid until when, and how they pay. So everything else (tablet limits, reminders, pausing) works the same.
- **Locked to the tablet, not transferable:** each tablet makes a key it can't export (a non-extractable browser key now; the Android security chip later) and registers it with the company. Check-ins are signed with that key. A tablet keeps working offline for 30 days.
- **Replacements:** retire a tablet in the dashboard to activate another, 2 per tablet per year. Resetting the same tablet is free. More through support.
- Only kiosk tablets count. The office dashboard is free on any number of phones and computers.
- Google Sheets stays for setups already using it (Shock Tech's own included), but isn't offered to new customers.

## Phases

### Phase 0: owner's to-dos (some take weeks, so start now)
- [ ] Product name and a domain
- [ ] Cloudflare account (free)
- [ ] Stripe account (free; needs business and bank details)
- [ ] For checks: a business bank account with mobile deposit, the name checks are made payable to, a mailing address, and a W-9 ready (businesses often ask for one before paying a vendor)
- [ ] Google Play Console as an **organization** ($25; an organization skips Google's 12-tester, 14-day test for new personal accounts)
- [ ] Resend account (free) and the domain's email records
- [ ] Support email address
- [ ] Later, for the App Store: a D-U-N-S number (free, 1–2 weeks) and Apple Developer as an organization ($99 a year)

### Phase 1: the cloud service and accounts
- [x] Shared business rules for the tablet and the cloud (`web/js/engine.js`)
- [x] Cloud service skeleton: a Worker, one Durable Object per company, files in R2, tested locally (`cloud/`)
- [x] Sign-up and sign-in by emailed code (no passwords to store or leak)
- [x] Companies and staff logins with roles (owner, admin, front desk)
- [ ] Locations (several sites under one company)
- [x] Tablet activation in the cloud: device keys, signed check-ins, device tokens, retiring
- [ ] On the tablet: the key pair, daily check-in, 30-day offline grace
- [ ] The kiosk's third storage option, "Your account", next to "This tablet" and "Google Sheets"
- [ ] Emails from the cloud: alerts, host notices, signed copies (PDF), daily summary
- [ ] Import from Google Sheets or a tablet
- [ ] Deploy: one command (`wrangler deploy`), documented

### Phase 2: the office dashboard
- [ ] Everything in today's admin screen, from any computer or phone
- [ ] Live "who's inside", tablets and their last check-in, staff and roles

### Phase 3: subscriptions
- [ ] Stripe Checkout for sign-up, per-tablet quantity, free trial
- [ ] Adding a tablet adds one to the subscription (prorated); retiring one removes it
- [ ] Stripe's customer portal for cards, invoices and cancelling
- [ ] Failed payments: Stripe's reminder emails, then Pro pauses (visitors are never blocked)
- [ ] The replacement rule
- [ ] One plan per company (kiosks, paid until, card or check), used for the tablet limit whichever way they pay
- [ ] Pay by check: an emailed invoice (number, kiosks, period, amount, PO number if they have one, "make checks payable to" and your mailing address) with a "pay online instead" link
- [ ] Your operator screen: every company and its plan, **Record a check** (amount, check number, date received), and a payments list to export (CSV) for your accountant
- [ ] Renewal reminders by email: 30 and 7 days before the plan ends, and when it's overdue. After a 30-day grace period the Pro extras pause (visitors are never blocked)

### Phase 4: store-ready apps
- [ ] Polish: first-run experience, app icon, store screenshots and listing
- [ ] Google Play: internal test, then production
- [ ] Google Play Integrity check, so only the genuine app can activate
- [ ] Later: the iPad app on the App Store

### Phase 5: launch operations
- [ ] Website: what it does, pricing, sign-up, terms, privacy policy
- [ ] Error reporting, uptime alerts, backups (exports from each company's records)
- [ ] Security review of the cloud service
