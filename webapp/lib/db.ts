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
      CREATE INDEX IF NOT EXISTS conversations_email_idx ON conversations (email);
    `).then(() => undefined);
  }
  return globalForDb.schemaReady;
}

export interface ConversationRow {
  id: string;
  email: string;
  instance: string;
  title: string;
  updatedAt: string;
}

function rowFromDb(row: {
  id: string;
  email: string;
  instance: string;
  title: string;
  updated_at: Date;
}): ConversationRow {
  return {
    id: row.id,
    email: row.email,
    instance: row.instance,
    title: row.title,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listConversationsForEmail(email: string): Promise<ConversationRow[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    "SELECT id, email, instance, title, updated_at FROM conversations WHERE email = $1 ORDER BY updated_at DESC",
    [email],
  );
  return rows.map(rowFromDb);
}

export async function createConversationRow(
  id: string,
  email: string,
  instance: string,
  title: string,
): Promise<ConversationRow> {
  await ensureSchema();
  const { rows } = await getPool().query(
    "INSERT INTO conversations (id, email, instance, title) VALUES ($1, $2, $3, $4) RETURNING id, email, instance, title, updated_at",
    [id, email, instance, title],
  );
  return rowFromDb(rows[0]);
}

// Bumps updated_at (recency ordering) and, only the first time a message is
// sent in a conversation (title still the "New chat" placeholder), sets the
// title from that message. Scoped to `email` so one account can't touch
// another's conversation by guessing an id.
export async function touchConversationRow(
  id: string,
  email: string,
  firstUserMessageIfNew: string,
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE conversations
     SET updated_at = now(),
         title = CASE WHEN title = 'New chat' THEN $3 ELSE title END
     WHERE id = $1 AND email = $2`,
    [id, email, deriveTitle(firstUserMessageIfNew)],
  );
}

const TITLE_MAX_LENGTH = 60;

function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim();
  if (trimmed.length <= TITLE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}
