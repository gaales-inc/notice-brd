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

    -- How a message moves: 'horizontal' (across), 'vertical' (up), 'whole' (still).
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS display TEXT NOT NULL DEFAULT 'horizontal';

    -- A calendar feed (an iCalendar address) whose meetings can put messages
    -- on screens. meetings caches the occurrences around now that carry a call
    -- link, so meetings start and end on time between fetches.
    CREATE TABLE IF NOT EXISTS calendars (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fetched_at TIMESTAMPTZ,
      error TEXT,
      meetings JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE INDEX IF NOT EXISTS calendars_board ON calendars(board_id);

    -- A message can show by itself during meetings with a call link: on one
    -- calendar (auto_calendar_id) or any of the board's (NULL), on some
    -- screens (auto_screen_ids, a JSON array) or all of them (NULL).
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS auto_calendar BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS auto_calendar_id UUID REFERENCES calendars(id) ON DELETE SET NULL;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS auto_screen_ids JSONB;

    -- The screen's battery as it last reported it. battery_source is 'battery'
    -- (level and charging are set), 'none' (no battery: a TV, a desktop) or
    -- 'unavailable' (the browser won't say: Safari, Firefox); NULL before any report.
    ALTER TABLE screens ADD COLUMN IF NOT EXISTS battery_level SMALLINT;
    ALTER TABLE screens ADD COLUMN IF NOT EXISTS battery_charging BOOLEAN;
    ALTER TABLE screens ADD COLUMN IF NOT EXISTS battery_source TEXT;
    ALTER TABLE screens ADD COLUMN IF NOT EXISTS battery_at TIMESTAMPTZ;

    -- Set times a message shows by itself (see shared/schedule.ts): its time
    -- zone, its screens (NULL: all of them) and its times. NULL: not scheduled.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS schedule JSONB;
  `);
}
