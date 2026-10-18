-- When the customer tapped a notification (opened its link): shown to the owner for his messages.
ALTER TABLE app_notifications ADD COLUMN clicked_at INTEGER;
