-- Default time zone is Asia/Riyadh (same UTC+3, no daylight saving): move stored Asia/Aden values over.
UPDATE app_settings SET value = '"Asia/Riyadh"' WHERE (key = 'timezone' OR key LIKE '%:timezone') AND value = '"Asia/Aden"';
UPDATE campaigns SET timezone = 'Asia/Riyadh' WHERE timezone = 'Asia/Aden';
UPDATE draws SET timezone = 'Asia/Riyadh' WHERE timezone = 'Asia/Aden';
