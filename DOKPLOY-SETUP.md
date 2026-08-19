# Dokploy Volume Setup — Agent / Operator Instructions

Goal: persist TheArchive server data across rebuilds/redeploys by mounting a
Dokploy volume at the container path `/app/server/data`. Without this, the
SQLite archive cache, uploaded Original Images, and visitor comments are on the
container's ephemeral filesystem and are LOST on every rebuild.

This file is the single source of truth for the volume step. Follow it in order.

---

## Facts already verified (do NOT re-derive)

- Deployment source: repository **Dockerfile** (no docker-compose, no railway.json).
- Dockerfile declares: `VOLUME ["/app/server/data"]` and `RUN mkdir -p /app/server/data/uploads`.
- All durable data lives under `/app/server/data/` inside the container:
  - `archive.sqlite` — archive cache AND the `comments` table (same DB)
  - `uploads/` — Original Image uploads
  - WAL files `archive.sqlite-wal`, `archive.sqlite-shm` (same dir)
- Configurable env (defaults already correct, only change if you want a subpath):
  - `ARCHIVE_DATABASE_PATH` (default `server/data/archive.sqlite`)
  - `UPLOADS_DIR` (default `server/data/uploads`)
- The app reads/writes these paths via `server/config.mjs`; no code change needed.

---

## Step 1 — Locate the service in Dokploy

1. Open your Dokploy dashboard → TheArchive **project**.
2. Open the **service** that deploys from this repo's Dockerfile (the running app, not the git repo object).

## Step 2 — Create a volume

1. In the service (or left Resources → Volumes), choose **Add Volume / Create Volume**.
2. Set:
   - Name: `thearchive-data`
   - **Container Path / Mount Path: `/app/server/data`**  ← must match exactly
   - Storage: pick a **managed volume** (recommended) OR a host path such as
     `/var/lib/dokploy/volumes/thearchive-data` (ensure it exists and Dokploy can write).
3. Save.

## Step 3 — Attach volume to the service

1. On the volume, choose **Deploy / Attach to this service** (or service → Volumes → Link).
2. Select the TheArchive service.
3. Confirm **Container Path = `/app/server/data`**.
4. Save. Dokploy will **redeploy** to apply the mount.

## Step 4 — Verify the mount

After redeploy finishes:

1. Logs show: `[archive] listening on http://0.0.0.0:3000`
2. Open the container terminal (Dokploy Terminal/Exec) and run:
   ```
   ls -la /app/server/data
   ls -la /app/server/data/uploads
   ```
   Expect to see `archive.sqlite` (created on first run) and an `uploads` dir.
3. App-level check (from a machine that can reach the site, or via port-forward):
   - POST a visitor comment, then trigger a Redeploy, then GET it again.
   - It must still be present after redeploy.

### Example API checks (run against the live site, e.g. https://archive.voxxinc.xyz)

```sh
# add a note
curl -s -X POST "https://archive.voxxinc.xyz/api/comments?archiveId=0xVERIFY" \
  -H 'content-type: application/json' -d '{"text":"volume-persistence-check"}'

# read it back
curl -s "https://archive.voxxinc.xyz/api/comments?archiveId=0xVERIFY"
```

If the note survives a Redeploy, the volume is correctly mounted and data is durable.

---

## Important caveats (tell the agent/user)

- Mount is **overlay**: once `/app/server/data` is a volume, anything the image
  baked into that path is hidden by the volume. Our image only `mkdir`s an empty
  `uploads` there, so this is fine — the app creates `archive.sqlite` on startup.
- Old ephemeral data is NOT migrated. That is expected: archive records are
  re-reconciled from on-chain events; comments are new (no legacy data).
- Do NOT change `ARCHIVE_DATABASE_PATH`/`UPLOADS_DIR` unless you also update the
  volume's Container Path to match the new subpath.

## Definition of done

- Volume attached, Container Path = `/app/server/data`.
- `ls /app/server/data` inside container shows `archive.sqlite` + `uploads/`.
- A posted comment survives a Redeploy.
