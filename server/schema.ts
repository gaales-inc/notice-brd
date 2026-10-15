import { Db } from "./db";

/**
 * Created on startup, idempotently. Gaales services keep schema here rather
 * than in migration files: everything is additive so far, and `IF NOT EXISTS`
 * makes a restart safe.
 */
export async function migrate(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      sent_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS boards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS board_members (
      board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'collaborator')),
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (board_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS board_members_user ON board_members(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      color TEXT NOT NULL,
      speed TEXT NOT NULL,
      size TEXT NOT NULL,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS messages_board ON messages(board_id);

    -- A screen is one browser showing the board: a TV, a tablet, a phone in a
    -- window. Until a board member enters its pair code it belongs to no board.
    -- message_id is what it is broadcasting; NULL is the black screen.
    CREATE TABLE IF NOT EXISTS screens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash TEXT NOT NULL UNIQUE,
      board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '',
      pair_code TEXT UNIQUE,
      pair_expires_at TIMESTAMPTZ,
      message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paired_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS screens_board ON screens(board_id);
    CREATE INDEX IF NOT EXISTS screens_message ON screens(message_id);
  `);
}
