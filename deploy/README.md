# Deploying the Leak Quote App

Three artefacts, produced on your Mac:

| Command | Produces | What it is |
|---|---|---|
| `./deploy/build-release.sh` | `dist/leakquote-<stamp>.tar.gz` | The application, ~400 KB |
| `./deploy/export-data.sh` | `dist/leakquote-db-<stamp>.sql.gz` | Database dump |
| | `dist/leakquote-files-<stamp>.tar.gz` | Photos, exports, signatures |

The release deliberately excludes `node_modules` (installed on the server, because
`sharp` and `bcrypt` are native), `case-studies/` (118 MB already imported), and
your `.env`.

---

## First deployment

### 1. The server

Ubuntu 22.04 or 24.04, 2 vCPU / 4 GB / 40 GB, in Singapore.

```bash
sudo apt update
sudo apt install -y postgresql nginx certbot python3-certbot-nginx \
                    libreoffice-calc fonts-crosextra-carlito
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

`fonts-crosextra-carlito` is **not optional**. Calibri does not exist on Linux;
Carlito is metrically identical, and without it the text-wrapping measurements
shift and quotations lay out differently from your own documents.

### 2. Database and user

```bash
sudo -u postgres createuser leakquote --pwprompt
sudo -u postgres createdb leakquote --owner=leakquote

sudo useradd --system --home /srv/leakquote --shell /usr/sbin/nologin leakquote
sudo mkdir -p /srv/leakquote
sudo chown leakquote:leakquote /srv/leakquote
```

### 3. Upload and unpack

```bash
scp dist/leakquote-*.tar.gz  dist/leakquote-db-*.sql.gz  dist/leakquote-files-*.tar.gz \
    you@server:/tmp/

ssh you@server
sudo tar -xzf /tmp/leakquote-*.tar.gz -C /srv --strip-components=0
sudo chown -R leakquote:leakquote /srv/leakquote
cd /srv/leakquote
sudo -u leakquote npm ci --omit=dev
```

### 4. Configure

```bash
sudo cp deploy/env.production.example /srv/leakquote/.env
sudo nano /srv/leakquote/.env          # fill in every value
sudo chown leakquote:leakquote /srv/leakquote/.env
sudo chmod 600 /srv/leakquote/.env     # it holds the API key and session secret
```

Generate the session secret with `openssl rand -base64 48`. The app **refuses to
start** in production without one, rather than falling back to a default that
would make every session forgeable.

### 5. Restore your data

```bash
cd /srv/leakquote/server
sudo -u leakquote tar -xzf /tmp/leakquote-files-*.tar.gz     # uploads, exports, signatures

gunzip -c /tmp/leakquote-db-*.sql.gz | sudo -u postgres psql leakquote
```

Skip the database restore if you would rather start clean — in that case run
`npm run db:migrate` and create your first user instead.

### 6. Start it

```bash
sudo cp /srv/leakquote/deploy/leakquote.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now leakquote
sudo journalctl -u leakquote -f
```

### 7. nginx and HTTPS

```bash
sudo cp /srv/leakquote/deploy/nginx.conf.example /etc/nginx/sites-available/leakquote
sudo nano /etc/nginx/sites-available/leakquote        # set your domain
sudo ln -s /etc/nginx/sites-available/leakquote /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d quotes.swcconstruction.com.sg
```

Two settings in that config are not decoration: `client_max_body_size 120M`
(ten 10 MB photos in one upload — the 1 MB default rejects a normal inspection)
and `proxy_read_timeout 180s` (analysing a job calls the Anthropic API and the
60 s default cuts it off mid-request).

---

## Updating a running site

```bash
# on your Mac
./deploy/build-release.sh
scp dist/leakquote-<stamp>.tar.gz you@server:/tmp/

# on the server
sudo systemctl stop leakquote
sudo tar -xzf /tmp/leakquote-<stamp>.tar.gz -C /srv
sudo chown -R leakquote:leakquote /srv/leakquote
cd /srv/leakquote && sudo -u leakquote npm ci --omit=dev
sudo -u leakquote --preserve-env node server/dist/db/migrate.js   # if the schema changed
sudo systemctl start leakquote
```

Unpacking over the top does **not** touch `.env`, `uploads/`, `exports/` or
`signatures/` — those are not in the release.

---

## Backups

The database dump alone is not a backup. It loses the site photographs, which
are the only genuinely irreplaceable data — you can re-quote a job, you cannot
re-photograph a repaired leak.

```bash
# /etc/cron.daily/leakquote-backup
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip > /var/backups/leakquote-db-$(date +\%F).sql.gz
tar -czf /var/backups/leakquote-files-$(date +\%F).tar.gz -C /srv/leakquote/server uploads signatures
```

Copy both off the machine. Provider snapshots protect against the server dying;
they do not protect against a bad delete you notice a fortnight later.

---

## Checking it worked

1. Sign in over HTTPS.
2. Create an inspection, upload a photo — confirms uploads, `sharp`, and the
   Anthropic key.
3. Export a quotation to **PDF** — confirms LibreOffice and the Carlito font.
   Compare the letterhead and page breaks against a known-good document.
4. `sudo systemctl restart leakquote` and reload the page — you should still be
   signed in, because sessions live in Postgres rather than memory.
