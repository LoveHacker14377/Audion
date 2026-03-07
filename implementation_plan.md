# Audion — Cross-Device Account Sync Plan (Refined)

A refined, opinionated plan for adding cross-device synchronization to Audion. Covers authentication, data sync, offline support, conflict handling, and backend recommendations — all tailored to Audion's existing SvelteKit + Tauri 2 + Rust/SQLite stack.

---

## 1. Backend Recommendation: Hono on Cloudflare Workers

> [!IMPORTANT]
> **Why not Next.js?** Audion is a SvelteKit + Tauri desktop/mobile app. Adding a Next.js backend introduces a second meta-framework, SSR overhead you don't need, and context-switching between two frontend ecosystems. You only need a lightweight **API server**.

### Recommended Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **API Framework** | [Hono](https://hono.dev) | Ultra-lightweight, TypeScript-native, runs anywhere (Cloudflare Workers, Node, Deno, Bun). ~14KB. Express-like DX. |
| **Hosting** | Cloudflare Workers (free tier) or Railway/Fly.io (Node mode) | Workers = zero cold starts, global edge, generous free tier (100K req/day). Railway if you prefer traditional Node. |
| **Database** | **Turso** (LibSQL — managed SQLite) or **Neon** (serverless Postgres) | Turso is SQLite-compatible (same SQL dialect as your client!), has edge replicas, and a generous free tier. Neon if you prefer Postgres. |
| **ORM** | Drizzle ORM | Lightweight, TypeScript-first, works with both SQLite and Postgres, no code generation step (unlike Prisma). |
| **Auth** | [Better Auth](https://www.better-auth.com) or [Lucia](https://lucia-auth.com) | Framework-agnostic, works with Hono. Supports OAuth (Google, GitHub, Discord), email/password, and JWT. |
| **Token storage (client)** | Tauri's `stronghold` plugin or OS keyring | Encrypted vault for access/refresh tokens. Never localStorage. |

### Why This Stack?

1. **Hono + Cloudflare Workers** — Zero infrastructure to manage. Deploy with `wrangler deploy`. Free tier covers hobby-scale easily. If you outgrow Workers, Hono runs identically on Node/Bun (just change the adapter).

2. **Turso (LibSQL)** — Your client already uses SQLite. Using the same SQL dialect on the server means you can share query patterns and even test sync logic locally with plain SQLite. Turso gives you a managed, replicated SQLite database with an HTTP API. Free tier: 9GB storage, 500M rows read/month.

3. **Drizzle over Prisma** — No generation step, smaller bundle, better edge runtime support. Type-safe queries without the overhead.

### Alternative: Self-hosted Node

If you want full control or need WebSockets for real-time sync:

| Layer | Technology |
|-------|-----------|
| API | Hono or Fastify on Node.js |
| Hosting | Railway, Fly.io, or a VPS |
| Database | PostgreSQL (via Neon or self-hosted) |
| ORM | Drizzle ORM |

---

## 2. Architecture

```
┌──────────────────────────┐
│  Tauri App (Desktop/Android)  │
│  ┌──────────────────────┐│
│  │  SvelteKit Frontend  ││         ┌────────────────────────┐
│  │  (stores, components)││         │  Hono API (Workers)    │
│  └──────────┬───────────┘│  HTTPS  │  ┌──────────────────┐  │
│  ┌──────────┴───────────┐│◄───────►│  │  Auth (Better Auth│  │
│  │  Rust Backend        ││         │  │  or Lucia)        │  │
│  │  ┌──────────────────┐││         │  └──────────────────┘  │
│  │  │ SQLite (local DB) │││         │  ┌──────────────────┐  │
│  │  │ + sync_queue table│││         │  │  Turso (LibSQL)   │  │
│  │  └──────────────────┘││         │  │  or Neon (PG)     │  │
│  └──────────────────────┘│         │  └──────────────────┘  │
└──────────────────────────┘         └────────────────────────┘
```

**Data flow**: All writes → local SQLite first → enqueued in `sync_queue` → background sync pushes to server when online → server responds with remote changes → client applies them.

---

## 3. Data Model

### 3.1 Server-Side (Drizzle + Turso/Postgres)

```typescript
// schema.ts (Drizzle)

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // cuid or uuid
  email: text('email').notNull().unique(),
  name: text('name'),
  passwordHash: text('password_hash'), // null if OAuth-only
  createdAt: integer('created_at', { mode: 'timestamp' }).defaultNow(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).defaultNow(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
});

export const playlists = sqliteTable('playlists', {
  id: text('id').primaryKey(), // server-assigned cuid
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  coverUrl: text('cover_url'),
  version: integer('version').notNull().default(1), // monotonic, for conflict detection
  createdAt: integer('created_at', { mode: 'timestamp' }).defaultNow(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).defaultNow(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }), // soft delete
});

export const playlistTracks = sqliteTable('playlist_tracks', {
  id: text('id').primaryKey(),
  playlistId: text('playlist_id').notNull().references(() => playlists.id, { onDelete: 'cascade' }),
  trackHash: text('track_hash').notNull(), // content_hash from client
  position: real('position').notNull(), // fractional indexing — no unique constraint!
  title: text('title'),     // denormalized for display on other devices
  artist: text('artist'),   // denormalized
  duration: integer('duration'),
  addedAt: integer('added_at', { mode: 'timestamp' }).defaultNow(),
});

export const likedTracks = sqliteTable('liked_tracks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  trackHash: text('track_hash').notNull(),
  title: text('title'),     // denormalized
  artist: text('artist'),   // denormalized
  likedAt: integer('liked_at', { mode: 'timestamp' }).defaultNow(),
}, (table) => ({
  unique: unique().on(table.userId, table.trackHash),
}));

export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  data: text('data', { mode: 'json' }), // JSON blob — flexible, no migrations needed
  version: integer('version').notNull().default(1),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).defaultNow(),
});

// Global sync cursor — one per user, monotonically increasing
export const syncCursors = sqliteTable('sync_cursors', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  cursor: integer('cursor').notNull().default(0), // server-assigned sequence number
});

// Change log — server records every mutation for delta sync
export const changeLog = sqliteTable('change_log', {
  id: integer('id').primaryKey({ autoIncrement: true }), // monotonic sequence = sync cursor
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').notNull(), // 'playlist' | 'playlist_track' | 'liked_track' | 'settings'
  entityId: text('entity_id').notNull(),
  operation: text('operation').notNull(),     // 'create' | 'update' | 'delete'
  payload: text('payload', { mode: 'json' }), // full entity snapshot at time of change
  createdAt: integer('created_at', { mode: 'timestamp' }).defaultNow(),
});
```

#### Key Design Decisions

- **[position](file:///G:/Audion/src-tauri/src/db/schema.rs#148-191) as `real` (float)** — Allows inserting between items without reindexing: insert between positions 1.0 and 2.0 → use 1.5. No unique constraint, no constraint violation during sync.
- **`changeLog` table** — Records every mutation with a monotonic `id`. The `cursor` is just the last `changeLog.id` the client has seen. This is far more robust than timestamp-based sync tokens.
- **Settings as JSON blob** — Adding a new setting never requires a migration. Just merge objects.
- **Denormalized track metadata** — Since tracks are local files, the server can't look them up. We store `title`/[artist](file:///G:/Audion/src-tauri/src/db/queries.rs#691-721)/`duration` alongside the `trackHash` so other devices can display "Unknown Song by Unknown Artist" until the file is found locally.

### 3.2 Client-Side (SQLite Additions)

Add to existing [schema.rs](file:///G:/Audion/src-tauri/src/db/schema.rs):

```sql
-- Unified sync queue: replaces per-table pending_sync flags
CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,   -- 'playlist' | 'playlist_track' | 'liked_track' | 'settings'
    entity_id TEXT NOT NULL,     -- local ID or composite key
    operation TEXT NOT NULL,     -- 'create' | 'update' | 'delete'
    payload TEXT,                -- JSON snapshot of the entity at time of change
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    retry_count INTEGER DEFAULT 0
);

-- Sync metadata: stores auth tokens, sync cursor, user info
CREATE TABLE IF NOT EXISTS sync_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Keys: 'user_id', 'sync_cursor', 'last_sync_at', 'device_id'
```

Add columns to existing tables:

```sql
-- Map local playlists to server IDs
ALTER TABLE playlists ADD COLUMN server_id TEXT;
ALTER TABLE playlists ADD COLUMN version INTEGER DEFAULT 0;
ALTER TABLE playlists ADD COLUMN deleted INTEGER DEFAULT 0; -- soft delete flag

-- Unique constraint for server_id mapping
CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_server_id ON playlists(server_id);
```

> [!NOTE]
> We use a **single `sync_queue` table** instead of adding `pending_sync` flags to every table. This is cleaner, easier to batch-process, and lets you implement retry logic in one place.

---

## 4. Authentication Flow

### 4.1 OAuth Flow for Desktop/Mobile

```
1. User clicks "Sign In" → Tauri opens system browser
      ↓
2. Browser navigates to: https://api.audion.app/auth/google (or github, discord)
      ↓
3. OAuth provider redirects back to: https://api.audion.app/auth/callback?code=...
      ↓
4. Server exchanges code for tokens, creates/finds user, generates:
   - access_token (JWT, 15min expiry)
   - refresh_token (opaque, 30 day expiry)
      ↓
5. Server redirects to: audion://auth/callback?access_token=...&refresh_token=...
      ↓
6. Tauri deep-link plugin catches the URI, extracts tokens
      ↓
7. Tokens stored in Tauri stronghold (encrypted vault)
      ↓
8. Client makes first sync request with Authorization: Bearer <access_token>
```

### 4.2 Token Management

- **Access token**: Short-lived JWT (15 min). Included in `Authorization` header on every API request.
- **Refresh token**: Long-lived (30 days). Used to silently obtain new access tokens.
- **Storage**: Tauri `stronghold` plugin (encrypted file vault) — NOT localStorage.
- **Auto-refresh**: Rust-side middleware intercepts 401 responses, uses refresh token to get a new access token, retries the original request.

### 4.3 Tauri Deep Link Setup

Use `tauri-plugin-deep-link` for cross-platform custom URI scheme (`audion://`):
- **Windows**: Auto-registers protocol in registry
- **macOS**: Info.plist entry
- **Android**: Intent filter in `AndroidManifest.xml`

---

## 5. Sync Protocol

### 5.1 Delta Sync with Monotonic Cursors

```
Client                              Server
  │                                    │
  │  POST /api/sync/push               │
  │  {                                 │
  │    cursor: 42,                     │ ← last known server change
  │    changes: [                      │ ← local pending changes
  │      { type: 'playlist',           │
  │        op: 'create', ... },        │
  │      { type: 'liked_track',        │
  │        op: 'create', ... }         │
  │    ]                               │
  │  }                                 │
  │                                    │
  │                  ┌─────────────────┤
  │                  │ 1. Apply client │
  │                  │    changes      │
  │                  │ 2. Detect       │
  │                  │    conflicts    │
  │                  │ 3. Fetch changes│
  │                  │    since cursor │
  │                  │    42           │
  │                  └─────────────────┤
  │                                    │
  │  Response:                         │
  │  {                                 │
  │    newCursor: 57,                  │
  │    serverChanges: [...],           │ ← changes 43-57 (excluding client's own)
  │    conflicts: [...]                │ ← if any
  │  }                                 │
  │                                    │
```

### 5.2 Sync Queue Processing (Client-Side)

```
on app foreground / after user action (debounced 2s):
  1. Check network status
  2. Read all rows from sync_queue, ordered by id
  3. Batch into single POST /api/sync/push
  4. On success:
     - Delete processed sync_queue rows
     - Apply serverChanges to local DB
     - Update sync_cursor in sync_metadata
  5. On network failure:
     - Increment retry_count
     - Exponential backoff: retry in 2^retry_count seconds
  6. On conflict:
     - For settings/likes: auto-resolve (server wins or merge)
     - For playlists: store conflict, surface to user (Phase 5)
```

### 5.3 Conflict Resolution Strategy

| Data Type | Strategy | Rationale |
|-----------|----------|-----------|
| **Liked tracks** | Set union — never conflict | Liking is additive. Unlike = explicit delete operation. |
| **Settings** | Field-level merge | Merge individual fields. If same field changed on both sides, server wins. |
| **Playlist metadata** (name, cover) | Last-write-wins (by `version`) | Simple, predictable. |
| **Playlist tracks** (add/remove/reorder) | Operation merge | Apply both sets of operations. Duplicate adds are idempotent. Conflicting removes are fine. Reorder conflicts → server wins. |

### 5.4 Track Identification Across Devices

Use the existing `content_hash` column (SHA-256 of audio content):

| Source Type | Identifier | How |
|-------------|-----------|-----|
| Local file | `content_hash` | Already computed during scan. Same file on different devices → same hash. |
| Streaming/plugin track | `source_type:external_id` | e.g., `tidal:12345678` |
| Unmatched | Display with metadata only | Show title/artist from server, flag as "not found locally" |

> [!WARNING]
> Re-encoded files (same song, different bitrate) will NOT match by content hash. This is an accepted limitation. Acoustic fingerprinting (Chromaprint) could be added as a future enhancement.

---

## 6. API Endpoints

### Auth

| Method | Path | Description |
|--------|------|-------------|
| GET | `/auth/:provider` | Start OAuth flow (google, github, discord) |
| GET | `/auth/callback` | OAuth callback → redirect to `audion://` |
| POST | `/auth/refresh` | Exchange refresh token for new access token |
| POST | `/auth/logout` | Revoke refresh token |
| GET | `/auth/me` | Get current user profile |

### Sync

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sync/push` | Push local changes + pull remote changes (main sync endpoint) |
| GET | `/sync/full` | Full data dump for initial sync on new device |
| DELETE | `/sync/account` | GDPR: delete all user data |

> [!TIP]
> Only **two sync endpoints** needed. `/sync/push` handles both pushing and pulling in a single round-trip. `/sync/full` is only used once per device on first login.

---

## 7. Implementation Phases

### Phase 1: Auth & Server Scaffold (1–2 weeks)

**Server:**
- [ ] Init Hono project with Drizzle + Turso (or Neon)
- [ ] Set up Better Auth / Lucia with Google + GitHub OAuth
- [ ] Deploy to Cloudflare Workers (or Railway)
- [ ] Create `users`, `sessions` tables
- [ ] Implement `/auth/*` endpoints
- [ ] Implement `/auth/me` endpoint

**Client:**
- [ ] Add `tauri-plugin-deep-link` for `audion://` custom scheme
- [ ] Add `tauri-plugin-stronghold` for secure token storage
- [ ] Create `sync_metadata` table in SQLite schema
- [ ] Build login UI (button → opens browser → catches callback)
- [ ] Implement token storage/retrieval in Rust
- [ ] Add auth header injection to all API requests
- [ ] Add "Account" section to Settings page (login/logout, profile display)

**Milestone**: User can log in via OAuth and see their profile in the app.

---

### Phase 2: Settings Sync (1 week)

**Server:**
- [ ] Create `user_settings` table
- [ ] Add settings handling to `/sync/push` endpoint
- [ ] Add settings to `/sync/full` response

**Client:**
- [ ] Modify [settings.ts](file:///G:/Audion/src/lib/stores/settings.ts) to enqueue changes to `sync_queue`
- [ ] On sync response, merge server settings with local (field-level merge)
- [ ] Settings that are device-specific (e.g., `audioBackend`, `startMode`) are excluded from sync
- [ ] Syncable settings: theme, volume, ListenBrainz config, autoplay, etc.

**Milestone**: Change theme on desktop → shows up on Android after sync.

---

### Phase 3: Playlist & Liked Tracks Sync (2 weeks)

**Server:**
- [ ] Create `playlists`, `playlist_tracks`, `liked_tracks`, `change_log` tables
- [ ] Implement full `/sync/push` endpoint (process changes, return deltas)
- [ ] Implement `/sync/full` for initial device sync

**Client:**
- [ ] Add `sync_queue` table to SQLite schema
- [ ] Add `server_id`, `version`, `deleted` columns to playlists
- [ ] Modify [playlist.rs](file:///G:/Audion/src-tauri/src/commands/playlist.rs) to enqueue changes to `sync_queue` on every create/update/delete
- [ ] Modify [liked.ts](file:///G:/Audion/src/lib/stores/liked.ts) store to enqueue like/unlike to `sync_queue`
- [ ] Create `SyncService` in Rust that:
  - Reads `sync_queue`
  - Batches and sends to `/sync/push`
  - Applies server changes to local DB
  - Clears processed queue entries
- [ ] Implement initial full-sync merge on first login (see §7.1)
- [ ] Add sync status indicator to UI (spinning icon in sidebar/titlebar)

**Milestone**: Playlists and liked songs appear on all logged-in devices.

---

### Phase 4: Robust Offline & Background Sync (1 week)

**Client:**
- [ ] Network status detection (Tauri events or `navigator.onLine`)
- [ ] Auto-sync on app foreground (debounced)
- [ ] Auto-sync after each user mutation (debounced 2s)
- [ ] Exponential backoff on failure (2s → 4s → 8s → ... → 5min max)
- [ ] Retry queue: `retry_count` in `sync_queue`, skip items with too many failures
- [ ] Sync only on WiFi option for Android (battery consideration)
- [ ] Periodic background sync every 5 minutes while app is active

**Milestone**: Works fully offline. Edits queue up and sync automatically when connection is restored.

---

### Phase 5: Conflict Resolution UI (Optional, 1 week)

- [ ] When `/sync/push` returns `conflicts`, store them in a local `sync_conflicts` table
- [ ] Show a non-intrusive notification: "1 sync conflict — tap to resolve"
- [ ] Conflict resolution modal: show "Your version" vs "Server version" for playlists
- [ ] User picks one, or merges manually
- [ ] Resolved conflicts are pushed back to server

---

### Phase 6: Play History Sync (Optional, 1 week)

- [ ] Use same `sync_queue` + `/sync/push` mechanism
- [ ] Append-only: play history never conflicts (it's a log)
- [ ] Server aggregates play counts per track hash
- [ ] Stats Wrapped feature can show cross-device stats

---

## 7.1 Initial Full-Sync Merge Strategy

When a user logs in on a new device that already has local data:

1. **Fetch** all server data via `GET /sync/full`
2. **Match** local playlists to server playlists by name (fuzzy) or exact match
3. **For matched playlists**: merge tracks (union of track hashes, deduplicated)
4. **For unmatched local playlists**: upload to server (assign `server_id`)
5. **For server-only playlists**: create locally
6. **Liked tracks**: set union (combine both sets)
7. **Settings**: server wins (since it's the "latest" state)
8. **Set** `sync_cursor` to the server's current cursor value

> [!IMPORTANT]
> The first sync should show a progress UI: "Syncing your library... (3/5 playlists)" since it may take a few seconds.

---

## 8. Security Checklist

- [ ] Tokens in Tauri stronghold (encrypted vault) — never localStorage
- [ ] HTTPS for all API calls (Cloudflare Workers = HTTPS by default)
- [ ] Server validates `userId` matches token on every request
- [ ] Rate limiting on sync endpoints (Cloudflare: 100 req/10s per IP)
- [ ] Input validation: playlist name length ≤ 200 chars, track hash format = hex string
- [ ] Soft deletes: data recoverable for 30 days
- [ ] `DELETE /sync/account` endpoint for GDPR compliance
- [ ] Path traversal prevention already handled in [security.rs](file:///G:/Audion/src-tauri/src/security.rs)
- [ ] Device ID generated on first launch, stored in `sync_metadata` — for audit trail

---

## 9. Cost Estimate (Hobby Scale)

| Service | Free Tier | Paid |
|---------|----------|------|
| Cloudflare Workers | 100K requests/day | $5/mo for 10M req |
| Turso | 9GB, 500M reads/mo | $29/mo for more |
| Domain (api.audion.app) | — | ~$12/year |
| **Total** | **$0/mo** | **~$35/mo at scale** |

---

## 10. File Changes Summary

### Server (New Project)

| File | Description |
|------|-------------|
| `server/src/index.ts` | Hono app entry, routes |
| `server/src/schema.ts` | Drizzle schema (all tables above) |
| `server/src/auth.ts` | Better Auth / Lucia setup |
| `server/src/sync.ts` | `/sync/push` and `/sync/full` handlers |
| `server/src/middleware.ts` | Auth middleware, rate limiting |
| `server/wrangler.toml` | Cloudflare Workers config |
| `server/drizzle.config.ts` | Drizzle migration config |

### Client (Modifications)

| File | Change |
|------|--------|
| [schema.rs](file:///G:/Audion/src-tauri/src/db/schema.rs) | Add `sync_queue`, `sync_metadata` tables; add columns to `playlists` |
| [queries.rs](file:///G:/Audion/src-tauri/src/db/queries.rs) | Add sync queue CRUD operations |
| `src-tauri/src/commands/sync.rs` | **[NEW]** Tauri commands for sync operations |
| `src-tauri/src/sync/mod.rs` | **[NEW]** Sync service (queue processing, API calls, merge logic) |
| `src-tauri/src/sync/auth.rs` | **[NEW]** Token management, stronghold read/write |
| [src-tauri/Cargo.toml](file:///G:/Audion/src-tauri/Cargo.toml) | Add `tauri-plugin-deep-link`, `tauri-plugin-stronghold` |
| [settings.ts](file:///G:/Audion/src/lib/stores/settings.ts) | Enqueue syncable settings changes to sync queue |
| [liked.ts](file:///G:/Audion/src/lib/stores/liked.ts) | Enqueue like/unlike to sync queue |
| `src/lib/stores/sync.ts` | **[NEW]** Sync state store (status, last sync time, conflicts) |
| `src/lib/components/LoginModal.svelte` | **[NEW]** OAuth login UI |
| `src/lib/components/SyncStatus.svelte` | **[NEW]** Sync indicator (sidebar/titlebar) |
| [Settings.svelte](file:///G:/Audion/src/lib/components/Settings.svelte) | Add Account section (profile, login/logout) |
