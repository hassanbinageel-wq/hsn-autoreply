-- Winners are picked one at a time: each pick carries its own request id (a resend returns the same winner)
-- and a position can only have one active winner (two concurrent picks cannot both take it).
ALTER TABLE draw_winners ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS draw_winners_request ON draw_winners(draw_id, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS draw_winners_active_position ON draw_winners(draw_id, position) WHERE status = 'active';
