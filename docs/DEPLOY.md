# النشر على Cloudflare (مجاني)

الخادم والـ PWA في Worker واحد على `https://hsn-autoreply.<subdomain>.workers.dev`. لا تستخدم GitHub Pages للخادم.

## المتطلبات
- حساب Cloudflare مجاني (لا تضف وسيلة دفع ولا تفعّل Workers Paid).
- Node 22.

## الإعداد لأول مرة (من جهازك)

```bash
npm ci
npx wrangler login                                  # يفتح المتصفح — لا ترسل أي Token في المحادثات
npx wrangler d1 create hsn_autoreply                # انسخ database_id
```

ضع `database_id` في `wrangler.jsonc` (أو في متغير GitHub `D1_DATABASE_ID` إن كان النشر عبر Actions)، وعدّل:
- `PUBLIC_BASE_URL` = رابط الـ Worker الفعلي بـ https.
- `INSTAGRAM_APP_ID` = Instagram App ID من Meta.

### الأسرار (Workers Secrets) — تُدخل بشكل تفاعلي ولا تُحفظ في المستودع

```bash
npx wrangler secret put INSTAGRAM_APP_SECRET
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN     # أي نص عشوائي طويل؛ نفس القيمة في لوحة Meta
openssl rand -base64 32 | npx wrangler secret put TOKEN_ENC_KEY
openssl rand -hex 32   | npx wrangler secret put PASSWORD_PEPPER
openssl rand -hex 24   | tee /dev/tty | npx wrangler secret put SETUP_TOKEN   # احتفظ بها لخطوة الإعداد الأولي
```

⚠️ **لا تغيّر `TOKEN_ENC_KEY` أو `PASSWORD_PEPPER` لاحقًا** — تغييرهما يُبطل التوكن المخزن وكلمة مرور الإدارة. احتفظ بنسخة منهما في مدير كلمات مرور.

### الترحيل والنشر

```bash
npm run db:migrate:remote
npm run deploy
```

### الإعداد الأولي للإدارة
1. افتح رابط الـ Worker → نموذج «الإعداد الأولي».
2. أدخل `SETUP_TOKEN` واسم مستخدم وكلمة مرور (12+ حرفًا).
3. بعدها احذف الرمز: `npx wrangler secret delete SETUP_TOKEN`. (حتى لو بقي، قيد قاعدة البيانات يمنع إنشاء مدير ثانٍ.)

## النشر عبر GitHub Actions
`deploy.yml` يعمل يدويًا أو عند وسم `v*.*.*` فقط، داخل Environment باسم `production` (يمكنك اشتراط موافقتك اليدوية من إعدادات Environment).

- Secrets: `CLOUDFLARE_API_TOKEN` (صلاحيات: Workers Scripts:Edit, D1:Edit, Account Settings:Read فقط)، `CLOUDFLARE_ACCOUNT_ID`.
- Variables: `D1_DATABASE_ID`, `PUBLIC_BASE_URL`, `INSTAGRAM_APP_ID`.

## الرجوع عند فشل النشر (Rollback)
- **الكود:** `npx wrangler rollback` يعيد الإصدار السابق فورًا (أو من لوحة Cloudflare › Workers › Deployments).
- **قاعدة البيانات:** الترحيلات للأمام فقط وإضافية. قبل أي ترحيل مستقبلي خذ نسخة: `npx wrangler d1 export hsn_autoreply --remote --output backup.sql`. وD1 يوفر **Time Travel** لاستعادة القاعدة لنقطة زمنية خلال آخر 7 أيام على الخطة المجانية 🔎 (`npx wrangler d1 time-travel restore hsn_autoreply --timestamp=<ISO>`).
- إن فشل الترحيل في CI يتوقف الـ workflow قبل `wrangler deploy`، فيبقى الإصدار القديم يعمل.

## بعد النشر
1. `https://<worker>/healthz` يجب أن يعيد `{"ok":true}`.
2. أكمل [META_SETUP.md](META_SETUP.md) ثم «الربط» في التطبيق.
3. أنشئ حملة كمسودة، جرّبها في المحاكاة، ثم فعّلها.
