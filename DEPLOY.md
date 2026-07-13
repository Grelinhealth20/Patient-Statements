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
