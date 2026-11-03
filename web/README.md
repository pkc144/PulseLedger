# PulseLedger web

A browser UI for the PulseLedger API: a **customer dashboard** and an **admin console** in one app.
React + Vite + TypeScript + Tailwind, in its own package so the backend's lint, typecheck, tests,
and Docker image are unaffected.

## Run it

With the API running on `localhost:3000` (see the [root quick start](../README.md#quick-start)):

```bash
cd web
npm ci
npm run dev          # http://localhost:5173
```

Vite proxies `/v1` and `/health` to the API, so the browser sees one origin and the API needs no
CORS configuration. Point it elsewhere with `PULSELEDGER_API_URL=http://host:port npm run dev`.

## Pages

| Route          | What it is                                                                      |
| -------------- | ------------------------------------------------------------------------------- |
| `/`            | Landing page. The hero dashboard is labelled demo data; the API status is live. |
| `/login/user`  | Customer sign-in: Google, email/password (Firebase), or a `pl_live_` API key.   |
| `/login/admin` | Operator sign-in with the server's `ADMIN_API_KEY`.                             |
| `/app`         | Customer dashboard: accounts, transfers, ledger history.                        |
| `/admin`       | Admin console: onboarding, funding, reconciliation, metrics.                    |

Keys are checked against the API **before** being stored, and stored only in `sessionStorage`
(per tab, cleared on close). Nothing secret is in the bundle: the Firebase values in `.env.local`
are public client identifiers.

## Firebase sign-in (Google + email/password)

1. `cp .env.example .env.local` here and fill in the Firebase web config. `.env.local` is
   git-ignored. Without it, only API-key sign-in is shown.
2. In the **root** `.env`, set `FIREBASE_PROJECT_ID` to the same project ID and restart the API.
   This is what makes the backend accept the tokens; no service-account key is needed.
3. Firebase console → Authentication → Sign-in method: **Google** and **Email/Password** enabled.
   `localhost` is an authorized domain by default.

Email/password users must click the verification link before the API lets them in. The UI sends
it on sign-up and shows a "verify your email" step with a resend button. Each Firebase user gets
their own principal on first sign-in, so their accounts are private to them.

## A first session

1. **Admin** tab → sign in with `ADMIN_API_KEY` from the server's `.env`.
2. **Onboard a customer** → the API key is shown once; click _Open customer app as …_.
3. **Open account** (INR or USD) and copy its ID.
4. Back in **Admin**, **Fund** that account ID.
5. Open the account → **Send money** to another of your accounts, or to anyone's account ID.

## Behaviour worth knowing

- **Money never touches a float.** Amounts go over the wire as integer minor-unit strings; the UI
  parses and formats with `BigInt` (`src/lib/money.ts`).
- **One idempotency key per intent.** The send form keeps the same `Idempotency-Key` across
  retries of an unchanged request, and offers a _Retry safely_ button for
  `TRANSFER_RETRY_EXHAUSTED` and `IDEMPOTENCY_IN_PROGRESS`. Editing the form or a successful send
  starts a new key.
- **Credentials live in `sessionStorage`** — they survive a reload and are gone when the tab closes.
  A `401` clears the stored key and returns you to sign-in.
- The admin console only knows about principals and keys created in the current page session: the
  API has no endpoint to list them.

## Build

```bash
npm run build        # typecheck + production bundle in web/dist
npm run preview      # serve the bundle, with the same API proxy
```
