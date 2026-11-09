# Deploying to Fly.io

This puts the app on the public internet at `https://<your-app>.fly.dev`, with HTTPS, and with the billing database on a disk that survives restarts and deploys. It costs about **$3.84 a month**: one small machine (shared CPU, 512 MB, about $3.69) and a 1 GB disk (about $0.15). Fly bills by usage, so check [fly.io/pricing](https://fly.io/pricing) for current rates.

The repository already has what Fly needs: `Dockerfile`, `.dockerignore` and `fly.toml`.

> **Run exactly one machine.** The billing database is a single SQLite file on one disk. A second machine would get its own empty database, and users would see different balances depending on which machine answered. `fly.toml` is set up for one machine; don't run `fly scale count 2`.

## 1. Install Fly's command-line tool and sign in

- macOS: `brew install flyctl`
- Linux: `curl -L https://fly.io/install.sh | sh`
- Windows (PowerShell): `pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"`

Then sign up or sign in. Fly asks for a credit card before you can create machines.

```sh
fly auth signup   # or: fly auth login
```

## 2. Create the app

From the repository folder:

```sh
fly launch --copy-config --no-deploy
```

When asked, keep the settings from `fly.toml`, choose an app name (it becomes `<name>.fly.dev`), and pick a region near your users. Say **no** to adding databases such as Postgres or Redis; the app doesn't use them. This writes your chosen name and region into `fly.toml`.

## 3. Create the disk for the database

Use the same region as the app (it's the `primary_region` line in `fly.toml`):

```sh
fly volumes create data --size 1 --region iad --yes
```

The app keeps its database at `/data/billing.db` on this disk.

## 4. Add your keys as secrets

On Fly, settings go in as secrets, not in a `.env` file. (The app's **Settings → Import settings** only works on the computer running the app, so it can't be used on Fly.) Set the provider keys you use, plus the billing settings:

```sh
fly secrets set \
  OPENAI_API_KEY=sk-... \
  ANTHROPIC_API_KEY=sk-ant-... \
  GEMINI_API_KEY=... \
  STRIPE_SECRET_KEY=sk_test_... \
  PUBLIC_URL=https://<your-app>.fly.dev \
  ADMIN_EMAILS=you@example.com
```

Leave out providers you don't use. The full list of variables is in [`.env.example`](.env.example). Start with Stripe's **test** key (`sk_test_...`) so you can try everything without real money. You'll add `STRIPE_WEBHOOK_SECRET` in step 6.

For password reset emails, also set your [Resend](https://resend.com) key and sender (the sender's domain must be verified in Resend):

```sh
fly secrets set RESEND_API_KEY=re_... EMAIL_FROM="Default AI <billing@yourdomain.com>"
```

Without these, reset links are written to the app's log (see step 8) instead of being emailed.

## 5. Deploy

```sh
fly deploy --ha=false
```

`--ha=false` keeps it to one machine. When it finishes, open `https://<your-app>.fly.dev`. The **Account** tab should be there. Sign up with the email you put in `ADMIN_EMAILS` and you'll also see the **Admin** tab.

## 6. Connect Stripe's webhook

The webhook makes sure a payment is credited even if the buyer closes the tab before returning to the site.

1. In the Stripe Dashboard, go to **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://<your-app>.fly.dev/api/billing/webhook`
3. Event: `checkout.session.completed`
4. Save, then reveal the **Signing secret** (`whsec_...`) and set it:

```sh
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

Setting a secret restarts the app automatically.

## 7. Test a payment

In the app, go to **Account**, pick a top-up amount and pay with Stripe's test card `4242 4242 4242 4242`, any future expiry date and any CVC. Your balance should go up, and the payment should appear in Stripe's dashboard and in the Admin tab. Send a prompt and check that the cost is taken off your balance.

When you're ready for real payments, repeat steps 4 and 6 with Stripe's **live** key and a live-mode webhook.

## 8. Day to day

**Logs.** `fly logs` shows what the app is doing, including password reset links when Resend isn't set up. Node prints a one-time "SQLite is an experimental feature" warning at startup; that's expected.

**Updating.** Pull the latest code and run `fly deploy --ha=false` again. The database is on the disk, so it isn't touched.

**Changing a setting.** `fly secrets set NAME=value` (restarts the app). `fly secrets list` shows which are set, without their values.

**Your own domain.** Run `fly certs add ai.yourdomain.com` and add the DNS records it prints. Fly issues the HTTPS certificate. Then update `PUBLIC_URL` and the Stripe webhook URL to the new address.

## 9. Backups

The database is the record of what users have paid for, so keep copies.

- **Fly snapshots.** Fly takes a daily snapshot of the disk and keeps it for 5 days. `fly volumes list` shows the disk's ID, and `fly volumes snapshots list <id>` shows its snapshots.
- **A copy on your computer.** This makes a consistent copy while the app keeps running, then downloads it:

```sh
fly ssh console -C "node scripts/backup-db.js /data/backup.db"
fly ssh sftp get /data/backup.db ./billing-backup.db
fly ssh console -C "rm /data/backup.db"
```

To restore a copy, upload it with `fly ssh sftp shell` (then `put billing-backup.db /data/billing.db`) and run `fly machine restart`. Do this when no one is using the site.

## How the setup works

- `Dockerfile` builds a small Node 22 image with the app and nothing else: no `.env`, no tests, no local data. The app runs as the unprivileged `node` user.
- `fly.toml` mounts the disk at `/data`, points the database there (`BILLING_DATA_FILE=/data/billing.db`), turns on HTTPS, keeps the machine running so it's always ready for Stripe's webhook, and checks the app's health at `/api/config`.
- `CLIENT_IP_HEADER=fly-client-ip` tells the app which header holds each visitor's real address behind Fly's proxy, so the limit on login attempts applies per visitor. Don't set this variable when there's no proxy in front of the app, because anyone could fake the header.
