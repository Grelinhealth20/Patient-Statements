# Grelin Health · Patient Statement Generator

An enterprise-grade, production-ready Patient Statement Generator platform.
Node.js/Express API + React (Vite) client, MySQL with automatic table creation,
JWT authentication with automatic 40-minute token rotation, and role-based access
to two dashboards (Statement Generator + Admin Panel) behind a single login.

## Architecture

```
api/        Vercel serverless entry — wraps the Express app for production
backend/    Node.js + Express REST API, MySQL (mysql2), JWT auth
frontend/   React 18 + Vite SPA (light-mode enterprise UI, fully responsive)
vercel.json Single-project deploy: static SPA + /api serverless function
```

## Deploy to Vercel (production)

The app deploys as **one Vercel project** — the React SPA plus a same-origin
serverless API, so every feature works in real time with no CORS setup. See
**[DEPLOY.md](DEPLOY.md)** for step-by-step instructions.

> ⚠️ The MySQL host must accept inbound connections from Vercel's serverless
> IPs (open TCP 3306 to `0.0.0.0/0` in its firewall/security group). This is the
> most common cause of a failed Vercel deploy for this app.

Quick CLI path:
```bash
npm i -g vercel && vercel login && vercel link
bash scripts/push-vercel-env.sh   # push env vars from .env.example
vercel --prod
```

## Features

- **Single login → two dashboards.** Operators land on the Statement Generator;
  Super Admins land on the Admin Panel. Both are reachable from one login screen.
- **Super-Admin-only Admin Panel** — create, edit, delete users, reset passwords,
  and grant/restrict Statement Generator access per user.
- **JWT with automatic 40-minute rotation.** Access tokens expire in 40 minutes;
  the client silently refreshes ~60s before expiry using a refresh token, so an
  active session never lapses. Any access change, password reset, or logout
  instantly revokes existing tokens (token-version invalidation).
- **Automatic database + schema creation.** On first boot the API creates the
  `StatementGenerator` database, all tables, and a bootstrap super admin.
- **Statement Generator workspace is intentionally blank** (ready for future tools).

## Prerequisites

- Node.js 18+
- Network access to the configured MySQL host

## Run

Open two terminals.

**1. Backend**
```bash
cd backend
npm install
npm start          # http://localhost:5000
```
On first run it prints the seeded super-admin credentials.

**2. Frontend**
```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```
Vite proxies `/api` → `http://localhost:5000`.

## Default Super Admin

| Username     | Password                          |
| ------------ | --------------------------------- |
| `superadmin` | *(set via `SUPER_ADMIN_PASSWORD`)* |

> Change this immediately after first login (Admin Panel → Reset PW, or via the
> `SUPER_ADMIN_*` values in `backend/.env` before first boot).

## Configuration (`backend/.env`)

Database, JWT secrets/expiry, allowed client origin, and the bootstrap super admin
are all configured here. Token lifetime is `JWT_ACCESS_EXPIRES=40m`.

## API Overview

| Method | Endpoint                              | Access        |
| ------ | ------------------------------------- | ------------- |
| POST   | `/api/auth/login`                     | Public        |
| POST   | `/api/auth/refresh`                   | Public (token)|
| GET    | `/api/auth/me`                        | Authenticated |
| POST   | `/api/auth/logout`                    | Authenticated |
| POST   | `/api/auth/change-password`           | Authenticated |
| GET    | `/api/admin/stats`                    | Super Admin   |
| GET    | `/api/admin/users`                    | Super Admin   |
| POST   | `/api/admin/users`                    | Super Admin   |
| PUT    | `/api/admin/users/:id`                | Super Admin   |
| PATCH  | `/api/admin/users/:id/access`         | Super Admin   |
| POST   | `/api/admin/users/:id/reset-password` | Super Admin   |
| DELETE | `/api/admin/users/:id`                | Super Admin   |
| GET    | `/api/statements/ping`                | Statement access |

## Production build

```bash
cd frontend && npm run build     # outputs frontend/dist
```
Serve `frontend/dist` from any static host and run the backend behind a process
manager (e.g. `pm2 start src/server.js`). Set `CLIENT_ORIGIN` in `backend/.env`
to your deployed frontend URL.
