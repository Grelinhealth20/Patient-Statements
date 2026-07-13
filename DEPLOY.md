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
| `GOOGLE_ADDRESS_VALIDATION_API_KEY` | `<your-google-api-key>` |
| `GOOGLE_ADDRESS_VALIDATION_REGION` | `US` |
| `GCP_PROJECT_ID` | `<gcp-project-that-owns-the-key>` *(optional; enables project-wide usage)* |
| `GCP_SERVICE_ACCOUNT_JSON` | `<service-account-key-as-one-line-json>` *(optional; see below)* |
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

> **Address Validation billing tier (live).** The "Free Tier / Paid" pill and the
> API-status popup are driven by REAL data, never fabricated. SKU name, free
> allowance, and unit price come from the **Cloud Billing Catalog** (works with the
> API key alone). The month-to-date call count that decides FREE vs PAYMENT comes
> from **Cloud Monitoring** when configured (project-wide, authoritative); if it is
> not configured the app falls back to its own DB call-counter — still real, but it
> counts only this app's calls. Configure Cloud Monitoring (below) to get Google's
> project-wide total.

> Generate fresh JWT secrets for a real production deploy:
> `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

---

## Cloud Monitoring (project-wide usage) — optional but recommended

This makes the Free-tier vs Payment verdict reflect **Google's own project-wide
call count** instead of this app's local counter. Cloud Monitoring **rejects API
keys**, so it requires a service account (OAuth). SKU pricing does *not* need
this — only the project-wide call volume does.

**One-time GCP setup** (in the project that owns the Address Validation API key):

1. **Enable the API** — in the Cloud Console, enable **Cloud Monitoring API**
   (`monitoring.googleapis.com`) for the project.
2. **Create a service account** — *IAM & Admin → Service Accounts → Create*.
   Name it e.g. `statement-usage-reader`. No user access needed.
3. **Grant the role** — give it exactly **`roles/monitoring.viewer`** (read-only
   metrics). That is the only role required; nothing can be written or billed.
4. **Create a JSON key** — *Keys → Add Key → Create new key → JSON*. Download it.
   Treat it as a secret (never commit it, never send it to the browser).

**Configure the two env vars:**

- `GCP_PROJECT_ID` — the project ID that owns the API key.
- `GCP_SERVICE_ACCOUNT_JSON` — the entire downloaded JSON key as **one line**.
  Minify it with:
  ```bash
  node -e "process.stdout.write(JSON.stringify(require('./key.json')))"
  ```
  Paste the output as the value. (Alternatively, leave this blank and set
  `GOOGLE_APPLICATION_CREDENTIALS` to a key-file path — the app reads Application
  Default Credentials automatically.)

**Verify it's live** — after redeploying, open the app, click the Address
Validation status pill, and confirm the popup's **Sources** row reads
`Cloud Monitoring · Billing Catalog` (not `App usage counter`). Until then the
verdict still works — it just uses the local counter and says so honestly.

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
