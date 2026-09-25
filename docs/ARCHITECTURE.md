# البنية والمخطط

```
Instagram ──Webhook (HMAC)──▶ Worker /webhooks/instagram
                                 │ 1. تحقق التوقيع على الجسم الخام
                                 │ 2. D1 batch: webhook_events + action_jobs(process_event)  ← معاملة واحدة
                                 │ 3. رد 200 (أو 500 عند فشل الحفظ)
                                 └ 4. waitUntil: محاولة فورية (ليست ضمانًا)
Cron كل دقيقة ─▶ expireFlows ─▶ runQueue
                    recoverStaleLeases → claimNextJob (UPDATE…RETURNING ذري) → executeJob
                    process_event → مطابقة الحملات → conversation_flows + مهام
                    follow_check  → User Profile API → follow_checks
                    send_message  → Private Reply / Send API
                    public_reply  → /{comment}/replies
Cron يومي ─▶ تجديد التوكنات + سياسة الاحتفاظ
PWA / APK ─▶ /api/* (كوكي+CSRF أو Bearer)
```

## الجداول
`admin_users` (صف واحد بفهرس فريد ثابت) · `sessions` (هاش التوكن فقط) · `rate_limits` · `oauth_states` (هاش، 10 دقائق، مرة واحدة) · `instagram_accounts` (توكن مشفّر) · `media_cache` · `campaigns` · `campaign_media` · `campaign_keywords` · `templates` · `webhook_events` (`dedup_key` فريد) · `participants` (`account_id+igsid` فريد) · `conversation_flows` (فهرس جزئي: مسار مفتوح واحد لكل حملة+شخص) · `follow_checks` · `action_jobs` (`dedup_key` فريد) · `action_attempts` · `audit_logs` · `app_settings`.

معرفات Meta نصوص. الأوقات UTC بالمللي ثانية وتُعرض بالمنطقة الزمنية (افتراضيًا Asia/Aden).

## منع التكرار

| ما يُمنع | الآلية |
|---|---|
| نفس الحدث | `webhook_events.dedup_key` = `comment:<id>` / `msg:<mid>` / `postback:<mid>` |
| معالجة الحدث مرتين | `action_jobs.dedup_key` = `evt:<dedup>` |
| رد خاص ثانٍ على نفس التعليق | `private_reply_status` في المسار + قناة DM بعده |
| رد عام ثانٍ | `public_reply:<comment_id>` |
| تسليم المحتوى مرتين | `deliver:<flow_id>` + حد التسليم لكل مستخدم + إعادة فحص قبل الإرسال |
| ضغطات تحقق مكررة | حدث الزر مُزال التكرار + الفاصل الزمني + انتقال الحالة المتفائل (`WHERE state = ?`) |
| عاملان على نفس المهمة | `UPDATE … WHERE id = (SELECT …) AND status IN (…) RETURNING` |

**لا ندّعي exactly-once لدى Meta.** إن انقطع الاتصال بعد إرسال الطلب تُسجل المهمة `uncertain` ولا تُعاد تلقائيًا؛ تُراجع يدويًا من «سجل العمليات».

## حالات المسار
`trigger_received` → `awaiting_user_interaction` → `checking_follow` → `awaiting_follow` ⇄ `checking_follow` → `ready_to_deliver` → `delivering` → `content_sent`
نهائية: `content_sent`, `verification_unavailable`, `expired`, `failed`, `cancelled`. الانتقالات المسموحة في `src/shared/states.ts`.

## حالات الإجراء (مستقلة لكل رد خاص/عام/رسالة/فحص)
`pending`, `processing`, `accepted` (قبلت Meta الطلب — ليس «قُرئت»), `retry_scheduled`, `uncertain`, `failed`, `cancelled`.

## سياسة تعدد الحملات
- حدث واحد → حملة واحدة (الأعلى أولوية).
- الشخص قد يكون في عدة مسارات لحملات مختلفة؛ الأزرار تحمل token يحدد المسار بدقة، والكلمات النصية («ابدأ»/«تحقق») تذهب لأحدث مسار ينتظر ذلك الإدخال.
