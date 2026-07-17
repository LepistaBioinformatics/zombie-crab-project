import { Pool } from "pg";

// Server-only. A singleton pool + lazy schema init, kept deliberately tiny
// (one table) -- this is chat-webapp's own conversation-metadata store, not
// a step towards Mycelium's own account database (see docker-compose.yaml's
// comment on the chat-webapp-postgres service for why those stay separate).
const globalForDb = globalThis as unknown as { pgPool?: Pool; schemaReady?: Promise<void> };

function getPool(): Pool {
  if (!globalForDb.pgPool) {
    globalForDb.pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return globalForDb.pgPool;
}

// Conversations are scoped to a workspace (tenant + subscription + role), not
// just the account email -- switching workspace in the picker shows only that
// workspace's chats (workspace-selection spec, resolved point 2). `instance`
// holds the role (alpha/beta); `tenant_id`/`subs_acc_id` are added additively
// via ADD COLUMN IF NOT EXISTS so pre-existing rows survive (they simply carry
// NULL workspace ids and no longer match any real workspace query).
function ensureSchema(): Promise<void> {
  if (!globalForDb.schemaReady) {
    globalForDb.schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        instance TEXT NOT NULL,
        title TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS tenant_id TEXT;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS subs_acc_id TEXT;
      CREATE INDEX IF NOT EXISTS conversations_workspace_idx
        ON conversations (email, tenant_id, subs_acc_id, instance);
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS alias TEXT;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_key TEXT;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS session_file TEXT;
      CREATE TABLE IF NOT EXISTS conversation_tags (
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        value TEXT,
        metadata JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (conversation_id, name)
      );
      CREATE INDEX IF NOT EXISTS conversation_tags_conv_idx ON conversation_tags (conversation_id);
      CREATE TABLE IF NOT EXISTS branding (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        app_name TEXT,
        logo_light BYTEA, logo_light_type TEXT,
        logo_dark  BYTEA, logo_dark_type  TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `).then(() => undefined);
  }
  return globalForDb.schemaReady;
}

export interface Tag {
  name: string;
  value: string | null;
  metadata: Record<string, unknown>;
}

export interface ConversationRow {
  id: string;
  email: string;
  instance: string;
  tenantId: string;
  subsAccId: string;
  title: string;
  updatedAt: string;
  alias: string | null;
  tags: Tag[];
  sessionKey: string | null;
  sessionFile: string | null;
}

function rowFromDb(row: {
  id: string;
  email: string;
  instance: string;
  tenant_id: string;
  subs_acc_id: string;
  title: string;
  updated_at: Date;
  alias: string | null;
  session_key: string | null;
  session_file: string | null;
  tags: Tag[];
}): ConversationRow {
  return {
    id: row.id,
    email: row.email,
    instance: row.instance,
    tenantId: row.tenant_id,
    subsAccId: row.subs_acc_id,
    title: row.title,
    updatedAt: row.updated_at.toISOString(),
    alias: row.alias,
    tags: row.tags,
    sessionKey: row.session_key,
    sessionFile: row.session_file,
  };
}

export async function listConversationsForWorkspace(
  email: string,
  tenantId: string,
  subsAccId: string,
  role: string,
): Promise<ConversationRow[]> {
  await ensureSchema();
  // A row exists only once a first message has actually been sent (see
  // upsertConversationRow) -- so a listed conversation always has a real
  // title and a matching picoclaw session. `title <> 'New chat'` additionally
  // hides legacy placeholder rows created by the old create-on-open flow,
  // which had no picoclaw transcript behind them (the postgres/picoclaw
  // divergence, chat-ui-material-refactor).
  const { rows } = await getPool().query(
    `SELECT c.id, c.email, c.instance, c.tenant_id, c.subs_acc_id, c.title,
            c.updated_at, c.alias, c.session_key, c.session_file,
            COALESCE(
              json_agg(
                json_build_object('name', t.name, 'value', t.value, 'metadata', t.metadata)
              ) FILTER (WHERE t.name IS NOT NULL),
              '[]'
            ) AS tags
     FROM conversations c
     LEFT JOIN conversation_tags t ON t.conversation_id = c.id
     WHERE c.email = $1 AND c.tenant_id = $2 AND c.subs_acc_id = $3 AND c.instance = $4
       AND c.title <> 'New chat'
     GROUP BY c.id
     ORDER BY c.updated_at DESC`,
    [email, tenantId, subsAccId, role],
  );
  return rows.map(rowFromDb);
}

// Creates the conversation row on the FIRST sent message (deferred creation) --
// the id is client-minted and only lands in postgres once the user actually
// sends something, so opened-but-never-used conversations never create a
// ghost row without a picoclaw transcript. On later messages this just bumps
// updated_at (recency); the title, set from the first message, is kept. The
// DO UPDATE is scoped to `email` so one account can't touch another's row by
// guessing an id.
export async function upsertConversationRow(
  id: string,
  email: string,
  tenantId: string,
  subsAccId: string,
  role: string,
  firstUserMessage: string,
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO conversations (id, email, instance, tenant_id, subs_acc_id, title, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE
       SET updated_at = now()
       WHERE conversations.email = $2`,
    [id, email, role, tenantId, subsAccId, deriveTitle(firstUserMessage)],
  );
}

// Owner-scoped title UPDATE. Deliberately touches only `title` -- NOT
// updated_at -- so a rename never disturbs recency ordering. The `email` guard
// means a non-owner id updates zero rows (returns false, never renames another
// account's conversation).
export async function renameConversation(
  id: string,
  email: string,
  title: string,
): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE conversations SET title = $3 WHERE id = $1 AND email = $2`,
    [id, email, title],
  );
  return (rowCount ?? 0) > 0;
}

// Owner-scoped delete of a conversation's index row. Removes it from the
// sidebar list only -- picoclaw's transcript on disk is untouched (the proxy
// exposes no session-delete). Returns false (→ 404) for a non-owner/unknown id.
export async function deleteConversationRow(id: string, email: string): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `DELETE FROM conversations WHERE id = $1 AND email = $2`,
    [id, email],
  );
  return (rowCount ?? 0) > 0;
}

// Owner-scoped alias UPDATE. Like renameConversation it deliberately touches
// only `alias` -- NOT updated_at -- so setting/clearing an alias never disturbs
// recency ordering. An empty alias clears it (stored as NULL). A non-owner id
// updates zero rows (returns false -> 404).
export async function setAlias(
  id: string,
  email: string,
  alias: string | null,
): Promise<boolean> {
  await ensureSchema();
  const normalized = alias && alias.trim() !== "" ? alias : null;
  const { rowCount } = await getPool().query(
    `UPDATE conversations SET alias = $3 WHERE id = $1 AND email = $2`,
    [id, email, normalized],
  );
  return (rowCount ?? 0) > 0;
}

// Owner-scoped upsert of one tag (unique by name per conversation). The tags
// table has no email column, so ownership is enforced by gating the INSERT on
// EXISTS(conversations WHERE id AND email): a non-owner id inserts zero rows
// (returns false -> 404). On a name collision it updates value + metadata.
export async function upsertTag(id: string, email: string, tag: Tag): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `INSERT INTO conversation_tags (conversation_id, name, value, metadata)
     SELECT $1, $3, $4, $5::jsonb
     WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id = $1 AND c.email = $2)
     ON CONFLICT (conversation_id, name) DO UPDATE
       SET value = EXCLUDED.value, metadata = EXCLUDED.metadata`,
    [id, email, tag.name, tag.value, JSON.stringify(tag.metadata)],
  );
  return (rowCount ?? 0) > 0;
}

// Owner-scoped delete of one tag by name. Gated on EXISTS(conversations WHERE id
// AND email) so a non-owner id removes zero rows; also returns false when the
// owner has no tag by that name (both -> 404).
export async function deleteTag(id: string, email: string, name: string): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `DELETE FROM conversation_tags
     WHERE conversation_id = $1 AND name = $3
       AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = $1 AND c.email = $2)`,
    [id, email, name],
  );
  return (rowCount ?? 0) > 0;
}

// Owner-scoped read of a conversation's tags. Returns [] for a non-owner/unknown
// id (a safe empty read, not an error -- the GET route only 404s on writes).
export async function listTags(id: string, email: string): Promise<Tag[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT t.name, t.value, t.metadata
     FROM conversation_tags t
     WHERE t.conversation_id = $1
       AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = $1 AND c.email = $2)
     ORDER BY t.name`,
    [id, email],
  );
  return rows as Tag[];
}

// Owner-scoped store of the proxy session identifiers. Like the alias/rename
// updates it does NOT touch updated_at (never disturbs recency). session_file
// is stored NULL until picoclaw has written the transcript. A non-owner id
// updates zero rows (returns false -> 404).
export async function setSessionRefs(
  id: string,
  email: string,
  sessionKey: string,
  sessionFile: string | null,
): Promise<boolean> {
  await ensureSchema();
  const { rowCount } = await getPool().query(
    `UPDATE conversations SET session_key = $3, session_file = $4 WHERE id = $1 AND email = $2`,
    [id, email, sessionKey, sessionFile && sessionFile !== "" ? sessionFile : null],
  );
  return (rowCount ?? 0) > 0;
}

// Per-instance white-label branding is a singleton row (id=1). An empty table
// (or a NULL app_name) yields the default name; unset logos return null so the
// caller serves the bundled default. Writes are instance-admin only (gated in
// the route layer, not here).
export const DEFAULT_APP_NAME = "zombie-crab";

export async function getAppName(): Promise<string> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT app_name FROM branding WHERE id = 1`,
  );
  return rows[0]?.app_name ?? DEFAULT_APP_NAME;
}

export async function setAppName(name: string | null): Promise<void> {
  await ensureSchema();
  const normalized = name && name.trim() !== "" ? name.trim() : null;
  await getPool().query(
    `INSERT INTO branding (id, app_name, updated_at)
     VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET app_name = $1, updated_at = now()`,
    [normalized],
  );
}

export async function getLogo(
  variant: "light" | "dark",
): Promise<{ bytes: Buffer; type: string } | null> {
  await ensureSchema();
  const col = variant === "light" ? "logo_light" : "logo_dark";
  const typeCol = variant === "light" ? "logo_light_type" : "logo_dark_type";
  const { rows } = await getPool().query(
    `SELECT ${col} AS bytes, ${typeCol} AS type FROM branding WHERE id = 1`,
  );
  const row = rows[0];
  if (!row?.bytes || !row?.type) return null;
  return { bytes: row.bytes as Buffer, type: row.type as string };
}

export async function setLogo(
  variant: "light" | "dark",
  bytes: Buffer,
  type: string,
): Promise<void> {
  await ensureSchema();
  const col = variant === "light" ? "logo_light" : "logo_dark";
  const typeCol = variant === "light" ? "logo_light_type" : "logo_dark_type";
  await getPool().query(
    `INSERT INTO branding (id, ${col}, ${typeCol}, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET ${col} = $1, ${typeCol} = $2, updated_at = now()`,
    [bytes, type],
  );
}

export async function clearLogo(variant: "light" | "dark"): Promise<void> {
  await ensureSchema();
  const col = variant === "light" ? "logo_light" : "logo_dark";
  const typeCol = variant === "light" ? "logo_light_type" : "logo_dark_type";
  await getPool().query(
    `UPDATE branding SET ${col} = NULL, ${typeCol} = NULL, updated_at = now() WHERE id = 1`,
  );
}

export const TITLE_MAX_LENGTH = 60;

function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim();
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}
