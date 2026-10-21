-- FAQ sections (e.g. «البداية والربط», «الحملات والردود»), ordered by the owner; existing questions go to «عام».
CREATE TABLE IF NOT EXISTS support_faq_sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
ALTER TABLE support_faq ADD COLUMN section_id INTEGER;
INSERT INTO support_faq_sections (title, sort, created_at)
  SELECT 'عام', 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE EXISTS (SELECT 1 FROM support_faq);
UPDATE support_faq SET section_id = (SELECT MIN(id) FROM support_faq_sections) WHERE section_id IS NULL;
