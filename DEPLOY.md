# Deploying to Vercel (Production)

This repo deploys as **one Vercel project**: the React SPA is served as static
files and the Express API runs as a serverless function, both on the **same
origin** (so there are no CORS issues and the app works in real time).

```
/api/index.js        → Vercel serverless function (wraps the Express app)
/backend/src/**      → API source, imported by the function
/frontend/**         → React SPA (built to frontend/dist)
/vercel.json         → build + routing config
```

Requests to `/api/*` hit the function; everything else serves the SPA.

---

## ⚠️ Prerequisite: the database must be reachable from Vercel

Vercel's serverless functions connect out from **rotating IP addresses**, so the
MySQL server at `3.130.239.42:3306` must accept inbound connections from the
public internet.

- In the AWS Security Group (or firewall) for that MySQL host, allow inbound
  **TCP 3306** from `0.0.0.0/0` (or, more tightly, from Vercel's egress ranges).
- Confirm the MySQL user `grelin` is allowed to connect from `%` (any host).

If this is not open, the API will return 500s because it cannot reach the DB.
This is the single most common cause of a failed Vercel deploy for this app.

---

## Option A — Deploy from the Vercel Dashboard (recommended)

1. Push this folder to a GitHub/GitLab/Bitbucket repo.
2. In Vercel: **Add New → Project → Import** the repo.
3. Vercel reads `vercel.json`, so leave Framework/Build/Output as detected
   (Build Command `npm run vercel-build`, Output `frontend/dist`).
4. Add the **Environment Variables** (Production **and** Preview) listed below.
5. Click **Deploy**. The bootstrap super admin is created automatically on the
   first request.

## Option B — Deploy with the Vercel CLI

```bash
npm i -g vercel
vercel login
vercel link                       # link this folder to a Vercel project
bash scripts/push-vercel-env.sh   # pushes all env vars from .env
vercel --prod                     # deploy to production
```

---

## Environment Variables

Set these in **Settings → Environment Variables** for **Production** and
**Preview** (or run `scripts/push-vercel-env.sh`):

| Key | Value |
| --- | --- |
| `DB_HOST` | `3.130.239.42` |
| `DB_PORT` | `3306` |
| `DB_USER` | `grelin` |
| `DB_PASSWORD` | `<your-db-password>` |
| `DB_NAME` | `StatementGenerator` |
| `DB_POOL_LIMIT` | `3` |
| `JWT_ACCESS_SECRET` | *(a long random string — see `.env`)* |
| `JWT_REFRESH_SECRET` | *(a different long random string)* |
| `JWT_ACCESS_EXPIRES` | `40m` |
| `JWT_REFRESH_EXPIRES` | `8h` |
| `SUPER_ADMIN_USERNAME` | `superadmin` |
| `SUPER_ADMIN_EMAIL` | `admin@grelinhealth.com` |
| `SUPER_ADMIN_PASSWORD` | `<your-admin-password>` |
| `SUPER_ADMIN_NAME` | `Super Administrator` |
| `GOOGLE_ADDRESS_VALIDATION_API_KEY` | `<google-api-key>` *(address validator — Google Cloud Address Validation API; `GOOGLE_API_KEY` also accepted)* |
| `GOOGLE_ADDRESS_VALIDATION_BASE` | `https://addressvalidation.googleapis.com` *(optional; API base override)* |
| `PHI_ENCRYPTION_KEY` | `<base64 32-byte key>` *(PHI at-rest encryption — **required in production**)* |
| `PHI_ENCRYPTION_KEYS_OLD` | `<comma-separated retired keys>` *(optional; only during key rotation)* |
| `AWS_ACCESS_KEY_ID` | `<your-aws-access-key>` *(omit to use an IAM role)* |
| `AWS_SECRET_ACCESS_KEY` | `<your-aws-secret-key>` *(omit to use an IAM role)* |
| `S3_REGION` | `us-east-1` |
| `S3_BUCKET` | `patient-statement-mlmg` |
| `S3_KEY_PREFIX` | `statements` *(optional; folder for stored PDFs)* |
| `S3_PRESIGN_EXPIRY_SECONDS` | `300` *(optional; download-link lifetime)* |
| `S3_MAX_PDF_BYTES` | `26214400` *(optional; max upload size, 25 MiB)* |

> **Statement archival (S3).** Generated PDFs are stored in the S3 bucket and
> re-downloaded on demand by clicking the file name (via short-lived presigned
> URLs). In production, prefer an **IAM role** over static keys — leave
> `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` unset and the AWS default
> credential provider chain is used. If the bucket is not configured, generation
> still works and PDFs download locally (archival is simply skipped).

> **Address validation (Google only).** The **Google Cloud Address Validation API**
> is the **sole** validator — real-time, server-side. The app calls
> `POST /v1:validateAddress?key=…` on `addressvalidation.googleapis.com` with
> `enableUspsCass: true`, so the response carries the USPS CASS standardized address
> (line + ZIP+4) and DPV confirmation alongside Google's own verdict. On a confirmed
> match the standardized address is written to the DB and recorded in the audit log.
> The API key is read from `GOOGLE_ADDRESS_VALIDATION_API_KEY` (or `GOOGLE_API_KEY`)
> and stays server-side — it never reaches the browser. If Google cannot identify an
> address, the user gets a clear message — there is no fallback. **Billing:** the
> Address Validation API is a **billable** Google Cloud SKU (it has a monthly free
> allowance, then a per-call charge) — enable billing on the Google Cloud project and
> restrict the key to the Address Validation API. Restrict the key to the Address
> Validation API and rotate the bundled default key before going live.

> **PHI encryption at rest (required).** Every patient record (names, addresses, DOB,
> financials, clinical DOS detail) is encrypted with **AES-256-GCM** before it is
> written to the `statement_dos.data` column and decrypted transparently on read, so no
> plaintext PHI is persisted. Set `PHI_ENCRYPTION_KEY` to a base64 32-byte key:
> `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
> On boot the app **automatically encrypts any existing plaintext rows** in the
> background (idempotent); you can also run a full, logged pass with
> `cd backend && npm run encrypt-phi`. The few non-PHI facts SQL needs (validated flag,
> has-address flag, outstanding amount) are kept in dedicated helper columns, so search,
> sorting and the financial summary are unchanged. **Losing the key makes existing PHI
> unrecoverable** — store it in a secret manager and back it up. Rotate by moving the old
> key into `PHI_ENCRYPTION_KEYS_OLD` (comma-separated) and setting a new
> `PHI_ENCRYPTION_KEY`; old data still decrypts until re-encrypted. PDFs in S3 are
> already encrypted at rest (SSE-AES256) and all traffic is TLS.
>
> Generate fresh JWT secrets for a real production deploy:
> `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

---

## After deploying — verify it's live

Replace `<app>` with your Vercel domain:

```bash
curl https://<app>.vercel.app/api/health
# → {"status":"ok", ...}
```

Then open `https://<app>.vercel.app`, sign in as `superadmin`, and confirm:

- Super Admin lands on the **Admin Panel**; create/edit/delete/reset/restrict all work.
- A created operator lands on the **Statement Generator** (blank workspace).
- The access token still carries a 40-minute lifetime and silently refreshes.

---

## Notes for production hardening

- **Rate limiting** is in-memory (per function instance). For strict, global
  throttling across all instances, back `express-rate-limit` with a shared store
  (e.g. Redis / Upstash).
- **Region**: `vercel.json` pins the function to `iad1` (US-East) to sit close to
  the US-East-2 database. Change `regions` if your DB moves.
- **Secrets**: rotate the JWT secrets and the super-admin password before going
  live, and change the seeded password immediately after first login.
