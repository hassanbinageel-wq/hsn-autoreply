-- Manual public reply to a winner's comment (possible even after the 7-day private reply window).
ALTER TABLE draw_winners ADD COLUMN public_reply_status TEXT;  -- NULL | sending | sent | failed | uncertain
ALTER TABLE draw_winners ADD COLUMN public_reply_at INTEGER;
ALTER TABLE draw_winners ADD COLUMN public_reply_error TEXT;
