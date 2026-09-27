-- Congratulation cards for draw winners: reusable designs, generated images, and send status per winner.
CREATE TABLE card_designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  design TEXT NOT NULL,              -- JSON (texts, colors, size, optional uploaded background as data URL)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE draws ADD COLUMN card_design_id INTEGER REFERENCES card_designs(id) ON DELETE SET NULL;

CREATE TABLE draw_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  winner_id INTEGER NOT NULL REFERENCES draw_winners(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,        -- unguessable public id (Meta fetches the image by URL)
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX draw_cards_winner ON draw_cards(winner_id, id DESC);

ALTER TABLE draw_winners ADD COLUMN send_status TEXT;      -- NULL | sending | sent | failed | uncertain
ALTER TABLE draw_winners ADD COLUMN send_channel TEXT;     -- dm | private_reply
ALTER TABLE draw_winners ADD COLUMN sent_at INTEGER;
ALTER TABLE draw_winners ADD COLUMN send_error TEXT;
