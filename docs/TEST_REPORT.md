# تقرير البناء والاختبارات

تاريخ التشغيل: 2026-09-25 · Node 22 · Vitest 4.1 داخل **Workers runtime (workerd) + D1 محلي** عبر `@cloudflare/vitest-pool-workers` · بدون أي اتصال بـ Meta (عميل Meta وهمي يسجّل الطلبات).

## الملخص

| البند | النتيجة |
|---|---|
| Typecheck (worker + web) | ✅ بدون أخطاء |
| الاختبارات | ✅ **75 / 75** ناجحة (3 ملفات) |
| بناء PWA (`vite build`) | ✅ — Service Worker يخزّن ملفات الواجهة فقط (23 ملفًا)، ويستثني `/api` و`/webhooks` و`/oauth` |
| بناء واجهة Android (`--mode capacitor`) | ✅ — بدون Service Worker، و`connect-src` مقيّد بعنوان الخادم |
| `wrangler deploy --dry-run` | ✅ — ~1 MB (175 KiB مضغوط)، الربطات: DB، ASSETS |
| تشغيل محلي كامل (`wrangler dev` + Chromium) | ✅ إعداد أولي ← لوحة ← معالج حملة 13 خطوة ← محاكاة (غير متابع ← ابدأ ← طلب متابعة بزر) ← تفعيل ← المحاكي ← السجل ← الربط؛ فاتح وداكن، جوال وسطح مكتب؛ بلا أخطاء JS |
| `npx cap add android` + الأيقونات والـ Splash | ✅ مشروع Gradle كامل |
| **بناء APK (Gradle)** | ⏳ **لم يُنفذ في بيئة التطوير**: `dl.google.com` (Android SDK) محجوب فيها. البناء والتوقيع والتحقق (`apksigner verify`) مُعدّة في `android-release.yml` وتعمل على GitHub Actions |
| **اختبار التثبيت على جهاز/محاكي** | ❌ **غير متاح** في هذه البيئة (لا جهاز ولا محاكي Android). نجاح البناء والتوقيع ≠ اختبار تثبيت فعلي |
| سكربت مفتاح التوقيع | ✅ أُنشئ مفتاح تجريبي في مجلد مؤقت ثم حُذف؛ السكربت يرفض الكتابة فوق مفتاح موجود |

## ما يغطيه كل اختبار

```
✓ test/unit.test.ts > Arabic / English normalization > removes tashkeel, tatweel, extra spaces and punctuation; lowercases English
✓ test/unit.test.ts > Arabic / English normalization > optionally unifies alef forms
✓ test/unit.test.ts > Arabic / English normalization > strips emoji and zero-width characters
✓ test/unit.test.ts > keyword matching > contains / word / exact for Arabic without breaking on \b
✓ test/unit.test.ts > keyword matching > multi-word phrases and English case-insensitivity
✓ test/unit.test.ts > keyword matching > multiple keywords and exclusions (exclusions win, also in match-all mode)
✓ test/unit.test.ts > keyword matching > control words
✓ test/unit.test.ts > Meta webhook signature (X-Hub-Signature-256) > accepts a correct signature over the raw body
✓ test/unit.test.ts > Meta webhook signature (X-Hub-Signature-256) > rejects wrong secret, tampered body, missing or malformed header
✓ test/unit.test.ts > secrets > hashes and verifies passwords with a pepper
✓ test/unit.test.ts > secrets > encrypts tokens with AES-GCM bound to the account id
✓ test/unit.test.ts > secrets > sanitizes tokens out of error messages
✓ test/unit.test.ts > CSV export > neutralizes formula injection and escapes quotes
✓ test/unit.test.ts > templates > renders variables with fallbacks and detects delivery claims
✓ test/unit.test.ts > state machine > allows only defined transitions
✓ test/unit.test.ts > Meta error classification & follow interpretation > classifies common Graph errors
✓ test/unit.test.ts > Meta error classification & follow interpretation > never maps a missing field or an error to not_following
✓ test/unit.test.ts > webhook parsing (official Instagram payload shapes) > parses comments with parent ids
✓ test/unit.test.ts > webhook parsing (official Instagram payload shapes) > distinguishes story replies, story mentions, quick replies, postbacks, echoes and plain DMs
✓ test/unit.test.ts > webhook parsing (official Instagram payload shapes) > treats public mentions / tags (non-messaging changes) as unsupported, never as DM triggers
✓ test/unit.test.ts > webhook parsing (official Instagram payload shapes) > ignores non-instagram objects
✓ test/unit.test.ts > backoff > grows exponentially with jitter and respects Retry-After
✓ test/unit.test.ts > campaign validation > rejects putting the final URL in the opening message
✓ test/unit.test.ts > campaign validation > requires keywords unless match-all
✓ test/api.test.ts > webhook endpoint > GET verification echoes the challenge only with the right verify token
✓ test/api.test.ts > webhook endpoint > POST rejects a bad signature and stores nothing
✓ test/engine.test.ts > comment campaign without follow requirement > sends the content once as a private reply and ignores duplicate deliveries of the same event
✓ test/engine.test.ts > comment campaign without follow requirement > ignores non-matching comments, excluded words and threaded replies by default
✓ test/api.test.ts > webhook endpoint > POST with a valid signature persists the event + job before answering 200
✓ test/api.test.ts > admin authentication > allows one-time setup only with the setup token, then never again
✓ test/api.test.ts > admin authentication > rejects weak passwords at setup
✓ test/api.test.ts > admin authentication > web session: HttpOnly Secure SameSite cookie, CSRF required for writes
✓ test/api.test.ts > admin authentication > app session: bearer token, no cookie
✓ test/api.test.ts > admin authentication > requires authentication for the management API
✓ test/api.test.ts > admin authentication > locks the account after repeated failures (brute force)
✓ test/engine.test.ts > comment campaign without follow requirement > never replies to the account's own comments or message echoes
✓ test/engine.test.ts > comment campaign without follow requirement > ignores events older than the campaign activation
✓ test/engine.test.ts > comment campaign without follow requirement > respects media scope
✓ test/api.test.ts > admin authentication > CORS is only granted to the Capacitor app origins
✓ test/api.test.ts > secrets never leave the server > account endpoint does not expose token ciphertext
✓ test/api.test.ts > secrets never leave the server > backup excludes tokens, sessions and personal data
✓ test/engine.test.ts > comment campaign without follow requirement > runs only the highest-priority matching campaign
✓ test/engine.test.ts > comment campaign without follow requirement > limits deliveries per user
✓ test/api.test.ts > OAuth > builds an Instagram Login URL with a one-time state; callback rejects unknown/reused state
✓ test/api.test.ts > account disconnect > cancels pending jobs, open flows and wipes the token
✓ test/api.test.ts > Meta data deletion callback > verifies signed_request and rejects forged ones
✓ test/engine.test.ts > public reply vs private reply are recorded independently > private OK + public FAIL
✓ test/engine.test.ts > public reply vs private reply are recorded independently > private FAIL → no delivery claim; optional fallback public reply
✓ test/api.test.ts > demo simulation (no real sends) > runs a full follow-gated scenario through the real pipeline with demo rows only
✓ test/api.test.ts > CSV export > is formula-injection safe
✓ test/api.test.ts > public pages > serves privacy / data deletion pages
✓ test/engine.test.ts > public reply vs private reply are recorded independently > private FAIL without fallback → no public reply at all
✓ test/engine.test.ts > follow-gated comment flow > opening message never leaks content; 'I followed' without following does not deliver; re-check then delivers once
✓ test/engine.test.ts > follow-gated comment flow > follower who already messaged us: checks immediately and sends content in the single private reply
✓ test/engine.test.ts > follow-gated comment flow > needs_interaction from the API sends the opening (no content) and waits
✓ test/engine.test.ts > follow-gated comment flow > unknown (field missing) is NOT treated as not-following and never delivers
✓ test/engine.test.ts > follow-gated comment flow > API error is NOT treated as not-following and never delivers
✓ test/engine.test.ts > follow-gated comment flow > unsupported follow check → verification_unavailable, reason stored on the account, no content
✓ test/engine.test.ts > follow-gated comment flow > enforces verify cooldown and max attempts
✓ test/engine.test.ts > story reply & story mention > story reply triggers the story campaign (not the comment campaign) and delivers inside the conversation
✓ test/engine.test.ts > story reply & story mention > a plain DM is not treated as a story reply
✓ test/engine.test.ts > story reply & story mention > story mention: thanks once per event, rate-limited per user, duplicates ignored
✓ test/engine.test.ts > story reply & story mention > a public @mention in a comment only follows comment campaigns — it never opens a DM by itself
✓ test/engine.test.ts > messaging window & uncertain results > does not send when the 24h window has closed; flow expires
✓ test/engine.test.ts > messaging window & uncertain results > Meta 'outside of allowed window' error expires the flow
✓ test/engine.test.ts > messaging window & uncertain results > an uncertain send is never retried blindly
✓ test/engine.test.ts > messaging window & uncertain results > stale lease after the request started → uncertain; before the request → rescheduled
✓ test/engine.test.ts > messaging window & uncertain results > rate-limited sends are retried with backoff
✓ test/engine.test.ts > concurrency > two workers never claim the same job
✓ test/engine.test.ts > concurrency > parallel queue runners deliver content only once
✓ test/engine.test.ts > pausing campaigns / disconnecting / global stop > pausing a campaign cancels its pending jobs and open flows
✓ test/engine.test.ts > pausing campaigns / disconnecting / global stop > global automation switch stops processing
✓ test/engine.test.ts > pausing campaigns / disconnecting / global stop > auth errors put the account in needs_reauth and stop further sends
✓ test/engine.test.ts > routing of control words across campaigns > 'ابدأ' goes to the flow awaiting interaction and does not start another campaign
✓ test/engine.test.ts > routing of control words across campaigns > button payload tokens are bound to their participant
```

## ما لم يُختبر (يتطلب بيئة حقيقية)
- استدعاءات Meta الحقيقية (OAuth، Private Replies، User Profile API) — تحتاج تطبيق Meta وحسابًا متصلًا. **لا تُرسل رسائل حقيقية إلا بعد أن تختار صراحة حسابًا ومنشورًا للاختبار الحي.**
- حدود CPU الفعلية على الخطة المجانية (خصوصًا PBKDF2 عند الدخول).
- أشكال Webhooks الفعلية: الاختبارات مبنية على المخططات المنشورة؛ تحقق من أول أحداث حقيقية في «سجل العمليات».

## إعادة التشغيل
```bash
npm ci && npm run typecheck && npm test && npm run build:web
```
