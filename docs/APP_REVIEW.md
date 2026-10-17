# ملف مراجعة التطبيق (Meta App Review)

يُستخدم **بعد** قبول توثيق النشاط التجاري (Business Verification). لا تضغط «Submit for review» قبلها.

## متى نحتاج المراجعة؟
- حسب صفحة Meta الرسمية [App Review for Instagram API](https://developers.facebook.com/docs/instagram-platform/app-review):
  - التطبيق اللي يخدم حسابك أنت فقط ما يحتاج مراجعة (Standard Access).
  - التطبيق اللي يخدم عملاء آخرين (Tech Provider) يحتاج **Advanced Access**، وهذا يعني مراجعة كل صلاحية.
- بدون المراجعة يبقى كل عميل لازم ينضاف «مختبِر» (Tester) في التطبيق.

## الصلاحيات المطلوبة (الموجودة فعلًا في الكود)
| الصلاحية | ليش نحتاجها |
|---|---|
| `instagram_business_basic` | قراءة اسم الحساب ومنشوراته وريلزه لاختيار المنشور في الحملة والسحب |
| `instagram_business_manage_comments` | استلام التعليقات (Webhook)، الرد العام تحت التعليق، قراءة تعليقات المنشور للسحب ولاسترجاع الفائت |
| `instagram_business_manage_messages` | الرد الخاص على التعليق (Private Reply) ورسائل المحادثة ضمن نافذة 24 ساعة، وصندوق الرسائل |

| `instagram_business_manage_insights` (اختيارية — من v2.13.0) | أرقام إنستقرام نفسه في صفحة «التحليلات»: مشاهدات ووصول وإعجابات وحفظ ومشاركات كل منشور وستوري، والوصول للمتابعين مقابل غير المتابعين، والمتابعين الجدد، وجمهور المتابعين (العمر والجنس والدول) |

| `instagram_business_content_publish` (اختيارية — من v2.14.0) | جدولة نشر منشور صورة، أو متعدد، أو ريل، أو ستوري على حساب صاحب الحساب نفسه في وقت يحدده |

صلاحية الإحصاءات ما تنطلب عند الربط إلا إذا فعّلها المالك من «التحليلات» ← «طلب صلاحية الإحصاءات عند ربط الحساب»: إيقاف (الافتراضي) / حسابي فقط / كل العملاء. قبل موافقة Meta تشتغل فقط للحسابات اللي لها دور في التطبيق، فلا تختار «كل العملاء» قبل الموافقة. ولازم تنضاف الصلاحية للتطبيق في لوحة Meta أولًا، وإلا بيفشل الربط.

لا تطلب أي صلاحية غيرها. كل صلاحية زيادة تحتاج تبرير وفيديو، وتصعّب الموافقة.

## نص التبرير لكل صلاحية (انسخه بالإنجليزي في نموذج المراجعة)

**instagram_business_basic**
> HSN AutoReply lets an Instagram professional account owner automate replies to comments on their own posts. We use instagram_business_basic to show the connected account's username and profile, and to list the account's own posts and reels so the owner can choose which post a campaign or a giveaway applies to. We do not access any other account's data.

**instagram_business_manage_comments**
> We receive comment webhooks for the connected account's own posts. When a comment contains a keyword chosen by the account owner, we (1) post one short public reply under that comment if the owner enabled it, and (2) send one private reply. We also read the comments of the owner's own post to run a transparent random giveaway chosen by the owner, and to recover comments whose webhook was missed. Each comment is answered at most once.

**instagram_business_manage_messages**
> When a person comments a keyword, we send exactly one Private Reply to that comment within 7 days of the comment, as allowed by the Private Replies feature. We send further messages only after the person replies (inside the 24-hour messaging window). The owner can also answer conversations manually from the app inbox inside the allowed window. We never message people who did not interact with the account first.

**instagram_business_manage_insights**
> The account owner sees the performance of their own posts, reels and stories in the app's Analytics page: views, reach, likes, comments, shares and saves per post, follower vs non-follower reach, daily new followers, and aggregated follower demographics (age, gender, country) as returned by the API. We store periodic snapshots only for the connected account's own media, show "unavailable" when the API returns no value, and never attribute demographics to individual people. Data is visible only to that account's owner and is deleted with the account.

**instagram_business_content_publish**
> The account owner uploads their own photo or video in the app's Schedule page, writes a caption and picks a time. At that time our server creates a media container through the Content Publishing API and publishes it to the owner's own account (posts, carousels, reels and stories). We check the account's publishing limit before publishing, never publish to any other account, and delete the uploaded file from our storage once the post is live. The owner can optionally choose one of their comment-reply campaigns to start on the new post.

## سيناريو الفيديو (Screencast)
**ملاحظات عامة.** هذي أعراف شائعة في مراجعات Meta. ما قدرت أفتح صفحة إرشادات الفيديو الرسمية من هنا، فراجع التعليمات اللي تطلع لك في نموذج كل صلاحية داخل لوحة Meta.
- الواجهة عربية، فأضف **ترجمة إنجليزية مكتوبة** على الشاشة لكل خطوة.
- مدة الفيديو من 2 إلى 4 دقائق، والصوت مو ضروري.
- يبدأ الفيديو **وأنت مسجّل خروج**، ويبيّن تسجيل الدخول بإنستقرام وشاشة الموافقة على الصلاحيات كاملة.
- يُصوَّر على حساب تجريبي ومنشور تجريبي تحددهم أنت (حسب قاعدة 6 في CLAUDE.md).
- **لا يظهر فيه شرط المتابعة الإلزامي أبدًا.** حسابات المراجعة تستخدم «الدعوة الاختيارية للمتابعة» فقط.

| # | ماذا يظهر | الترجمة على الشاشة |
|---|---|---|
| 1 | فتح hsnreply.online وتسجيل الدخول للوحة | Business owner signs in to HSN AutoReply |
| 2 | صفحة «الربط» ← «ربط إنستقرام» ← تسجيل دخول إنستقرام ← شاشة الصلاحيات ← موافقة | Owner connects their own Instagram professional account and grants the 3 permissions |
| 3 | الرجوع للوحة: اسم الحساب ظاهر ومتصل | instagram_business_basic: connected account's username |
| 4 | «حملة جديدة» ← اختيار منشور من القائمة ← كلمة مثل «كورس» ← نص الرد الخاص ← تفعيل | instagram_business_basic: choosing one of the owner's own posts |
| 5 | من جوال ثاني (حساب مختبِر) يعلّق «كورس» على المنشور | A user comments the keyword on the owner's post |
| 6 | يظهر الرد العام تحت التعليق | instagram_business_manage_comments: one public reply |
| 7 | الجوال الثاني يستلم الرسالة الخاصة | instagram_business_manage_messages: one Private Reply to the comment |
| 8 | المستخدم يضغط «ابدأ» ← يستلم المحتوى/الرابط | Follow-up only after the user replies (24h window) |
| 9 | صفحة «الرسائل» في اللوحة: المحادثة + رد يدوي | Owner replies manually inside the messaging window |
| 10 | «السحوبات» ← اختيار المنشور ← جلب التعليقات ← تنفيذ السحب | instagram_business_manage_comments: reading comments on the owner's own post for a giveaway |
| 10ب | «التحليلات» ← بطاقة «إحصاءات إنستقرام» ← «تحديث من إنستقرام» ← جدول أداء المنشورات ← فتح منشور ← بطاقة «جمهور المتابعين» | instagram_business_manage_insights: the owner views insights of their own media and aggregated audience |
| 10ج | «الجدولة» ← «منشور جديد» ← رفع صورة ← وصف ← وقت بعد دقائق ← «جدولة» ← انتظار النشر ← الحالة «منشور» ← فتحه في إنستقرام | instagram_business_content_publish: the owner schedules a post on their own account and it is published at the chosen time |
| 11 | فتح /privacy و /data-deletion | Privacy policy and data deletion |
| 12 | «الربط» ← «فصل الحساب وإيقاف الأتمتة» | Owner can disconnect at any time |

## بيانات دخول المراجِع
- Meta تطلب طريقة يجرّب فيها المراجِع التطبيق بنفسه.
- أنشئ عميلًا خاصًا للمراجعة من «العملاء»، مثل `meta_review`، وفعّل له باقة كاملة لمدة 30 يوم.
- اكتب بيانات دخوله **في نموذج Meta مباشرة**، ولا ترسلها في المحادثة.
- اكتب للمراجِع خطوات قصيرة بالإنجليزي: يسجّل الدخول، يربط حساب إنستقرام الاختباري، ينشئ حملة، يعلّق من حساب ثاني.

## مخاطر يجب حسمها قبل التقديم
1. **شرط المتابعة الإلزامي:** يبقى مقفل على الحسابات اللي تسمح بها أنت. ولازم ما يظهر في الفيديو ولا يكون مفعّل على حساب المراجِع.
2. **صفحة الخصوصية والشروط بالعربي فقط:** يُنصح بإضافة نسخة إنجليزية، لأن المراجِع غالبًا ما يقرأ العربي. وهذي توصية مني، مو شرط مكتوب تأكدت منه.
3. **رابط PUBLIC_BASE_URL** للحين على workers.dev. الأفضل تحويله إلى https://hsnreply.online قبل التقديم، عشان روابط الخصوصية والـ OAuth تطلع على الدومين الموثّق.
