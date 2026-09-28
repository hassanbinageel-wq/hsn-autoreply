-- Profile pictures of people in the inbox (Instagram User Profile API; the CDN URL expires, so it is refreshed).
ALTER TABLE participants ADD COLUMN profile_pic_url TEXT;
ALTER TABLE participants ADD COLUMN profile_pic_at INTEGER;     -- last fetch attempt
CREATE INDEX participants_inbox_pic ON participants(last_message_at, profile_pic_at);
