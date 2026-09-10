# Deploy OpenReply on Render

This fork includes a production Render Blueprint in `render.yaml`.

## One-click deployment

Open the following URL while signed in to Render:

https://render.com/deploy?repo=https://github.com/syedsadhik16/openreply

Render will read `render.yaml` and prepare these resources:

- `openreply-7a3f91c2e5` — Next.js web/admin app
- `openreply-worker-7a3f91c2e5` — always-on BullMQ DM worker
- `openreply-postgres` — dedicated PostgreSQL database
- `openreply-redis` — Redis-compatible queue/rate-limit store

The Blueprint automatically wires database and Redis connections and generates the shared `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, and `WEBHOOK_VERIFY_TOKEN` values.

## Private values Render will ask for

Enter these only in Render. Never commit them to GitHub:

- `RESEND_API_KEY`
- `EMAIL_FROM`
- `ALLOWED_EMAILS`
- `INSTAGRAM_APP_ID`
- `INSTAGRAM_APP_SECRET`
- `FACEBOOK_APP_SECRET`

The production base URL is configured as:

`https://openreply-7a3f91c2e5.onrender.com`

After the first deploy, confirm the assigned hostname. If Render assigns a different hostname, update `NEXTAUTH_URL` on both web and worker to the actual HTTPS URL before connecting Instagram.

## Meta configuration

For direct Instagram/Meta integration, configure:

- OAuth redirect: `https://openreply-7a3f91c2e5.onrender.com/api/instagram/callback`
- Webhook callback: `https://openreply-7a3f91c2e5.onrender.com/api/webhook`
- Webhook verify token: use the generated `WEBHOOK_VERIFY_TOKEN` from Render
- Subscribe to Instagram `comments` and `messages`

## Verification

1. `GET /api/live` must return HTTP 200 with `{ "status": "ok" }`.
2. `GET /api/health` must return HTTP 200 with `status: "ok"` and healthy database, Redis, queue, and worker checks.
3. Sign in to `/dashboard`.
4. Connect an Instagram Business or Creator account.
5. Create a campaign such as keyword `LINK` with a destination URL.
6. From a different Instagram account, comment `LINK` on the selected post/reel.
7. Confirm the DM arrives and the delivery appears in OpenReply logs.

Do not treat the deployment as production-ready until step 7 passes.
