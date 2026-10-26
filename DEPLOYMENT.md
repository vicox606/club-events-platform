# Deployment notes

## Docker

1. Copy `.env.example` to `.env` and replace every placeholder with real secrets/credentials.
2. Set `CLIENT_ORIGIN` and `PUBLIC_APP_URL` to your actual HTTPS domain. With the included single-container deployment, both normally use the same public origin.
3. Run `docker compose up --build -d`.
4. Verify `https://YOUR_DOMAIN/api/health` and configure the Razorpay webhook URL as `https://YOUR_DOMAIN/api/webhooks/razorpay`.
5. Configure a persistent volume for `/app/data` and schedule encrypted backups.

The Dockerfile is a convenient baseline. For a locked, reproducible production build, generate and commit a package lockfile in a network-enabled environment and use `npm ci` in the image. Prefer a managed PostgreSQL database and managed mail queue for multi-instance deployments.

## Before accepting real money

- Test successful, failed, cancelled, duplicate and delayed webhook scenarios using Razorpay test mode.
- Confirm the browser signature path and webhook path both produce exactly one confirmed registration and one email (or a retriable outbox record).
- Verify SMTP delivery, bounce handling and SPF/DKIM/DMARC for your sender domain.
- Add a venue check-in endpoint/UI that verifies QR registration IDs server-side; a QR is an identifier, not proof by itself.
- Configure TLS, secret rotation, alerts, backups, rate limits at the edge, and a tested restore process.
