# Gather — Club Events & QR Entry Platform

A full-stack starter matching the supplied visual references: warm off-white canvas, deep teal, orange, lilac and mint accents, rounded event cards, Space Grotesk headings and DM Sans UI text. Includes a responsive public event browser, registration form, Razorpay checkout and signature verification, idempotent webhook processing, QR pass generation/email delivery, admin event creation, registration list and activity logs.

## Stack
- React + Vite frontend
- Express REST API, Helmet, CORS allow-list and rate limiting
- SQLite (`better-sqlite3`) with foreign keys, indexes and WAL mode
- Razorpay Orders API, checkout signature verification and webhook signature verification
- QR code generation and Nodemailer SMTP delivery
- JWT-protected admin API

## Run locally
Requires Node.js 20+ and npm.

```bash
cp .env.example .env
npm install
npm run dev
```

Frontend: `http://localhost:5173` · API health: `http://localhost:4000/api/health`

Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `STUDENT_EMAIL`, `STUDENT_PASSWORD`, and a unique random `JWT_SECRET` in the server environment before using the corresponding sign-in. Student sign-in is a single environment-configured account; its “My passes” page only returns registrations made with that account's email address. Razorpay and SMTP values are intentionally placeholders. With missing Razorpay credentials, paid registration is explicitly a **demo** path and does not collect money; free registrations can be confirmed locally. Never advertise demo registrations as real paid tickets.

## Razorpay setup
1. Add test/live `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` to the server environment.
2. Register `https://YOUR_HOST/api/webhooks/razorpay` in Razorpay Dashboard. Subscribe to `payment.captured` and `payment.failed`; copy the webhook secret into `RAZORPAY_WEBHOOK_SECRET`.
3. Keep the webhook raw-body route before `express.json()` (already configured). Test duplicate deliveries and signature failures in test mode.
4. Use a public HTTPS URL for production webhooks. Do not expose the key secret or webhook secret to the browser.

## Email and QR passes
Configure SMTP host, port, credentials, sender and `PUBLIC_APP_URL`. A pass is emailed only after the server verifies the payment or processes a valid `payment.captured` webhook. Delivery attempts and failures are recorded in `admin_logs`. SMTP is not configured by default, so local startup will log a skipped delivery.

## Production checklist — do not skip
This repository is a deployable application scaffold, not a claim that your production environment is already provisioned. Before taking real payments:

- Use a managed PostgreSQL database for multi-instance/high-availability deployments; SQLite is appropriate only for a single-instance deployment with persistent disk and backups. Move migrations/seeds into a formal migration process.
- Put secrets in your host's secret manager; use a long random JWT secret and rotate credentials. Never commit `.env`.
- Use HTTPS, configure the exact `CLIENT_ORIGIN`, set `NODE_ENV=production`, and serve the frontend/API behind a reverse proxy or platform ingress.
- Add an admin bootstrap flow or secret-manager-managed credentials. Current environment-password comparison is intentionally simple for a single-owner starter; production should use hashed credentials, MFA, audit controls and account lockout.
- Use a transactional outbox/queue for email retry and webhook processing; current webhook records are idempotent, but email is sent inline and should be moved to a worker for higher reliability.
- Reconcile Razorpay order/payment state server-to-server for high-assurance fulfillment. Do not rely only on browser callbacks; the webhook is the recovery path.
- Add automated tests, backups/restore drills, monitoring/alerts, structured log retention, privacy/retention policy, consent text, venue QR check-in validation and operational runbooks.
- Add CSRF protections if cookie auth is introduced, stronger admin auth, and explicit validation for timezone/business rules. Review Helmet CSP before enabling a strict policy with the Razorpay script.
- Do not store card details. Payment is handled by Razorpay Checkout.

## API overview
- `GET /api/health`
- `GET /api/events`
- `POST /api/registrations/order`
- `POST /api/registrations/verify`
- `POST /api/webhooks/razorpay` (Razorpay signature required)
- `POST /api/admin/login`
- `POST /api/student/login`
- `GET /api/student/passes` (student JWT required)
- `GET /api/admin/overview` (Bearer token)
- `POST /api/admin/events` (Bearer token)
- `PATCH /api/admin/events/:id` (Bearer token)
- `GET /api/admin/logs` (Bearer token)
- `POST /api/admin/registrations/:id/resend-pass` (Bearer token)

The browser uses localStorage for event drafts and registration form drafts/demo passes. The database is the source of truth for real event and payment state.
