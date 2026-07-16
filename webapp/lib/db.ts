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
    `).then(() => undefined);
  }
  return globalForDb.schemaReady;
}

export interface ConversationRow {
  id: string;
  email: string;
  instance: string;
  tenantId: string;
  subsAccId: string;
  title: string;
  updatedAt: string;
}

function rowFromDb(row: {
  id: string;
  email: string;
  instance: string;
  tenant_id: string;
  subs_acc_id: string;
  title: string;
  updated_at: Date;
}): ConversationRow {
  return {
    id: row.id,
    email: row.email,
    instance: row.instance,
    tenantId: row.tenant_id,
    subsAccId: row.subs_acc_id,
    title: row.title,
    updatedAt: row.updated_at.toISOString(),
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
    `SELECT id, email, instance, tenant_id, subs_acc_id, title, updated_at
     FROM conversations
     WHERE email = $1 AND tenant_id = $2 AND subs_acc_id = $3 AND instance = $4
       AND title <> 'New chat'
     ORDER BY updated_at DESC`,
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

const TITLE_MAX_LENGTH = 60;

function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim();
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}
