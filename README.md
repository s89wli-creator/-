# راكان — AI Sales Employee

منصة SaaS سعودية متعددة المستأجرين تقدم **موظف مبيعات ذكي** يعمل بجانب فرق المبيعات الميدانية B2B: اكتشاف وتحليل العملاء، تجهيز الزيارات، تحليل الاجتماعات، إدارة المتابعات، وتقارير الإدارة — مع موافقة بشرية على القرارات التجارية الحساسة.

أول عميل تجريبي: **انجزني** (النقل والخدمات اللوجستية). المنتج عام وغير مرتبط بقطاع النقل.

## الحالة

- **المرحلة 1 — Discovery:** ✅ معتمدة.
- **المرحلة 2 — Foundation:** ✅ مكتملة — [التقرير](docs/09-phase-2-report.md).
- **المرحلة 3 — Core CRM:** ✅ مكتملة — [التقرير](docs/10-phase-3-report.md).
- **تجربة المستخدم:** ✅ نظام تصميم موحّد — [design-system/rakan/MASTER.md](design-system/rakan/MASTER.md).
- **المرحلة 4 — AI Intelligence:** ✅ مكتملة (بانتظار مفتاح مزود الذكاء الاصطناعي للتشغيل الفعلي) — [التقرير](docs/11-phase-4-report.md).
- **المرحلة 5 — Field PWA:** ✅ مكتملة (التفريغ الآلي والخرائط بانتظار قرار مزود) — [التقرير](docs/12-phase-5-report.md).
- **المرحلة 6 (جزء 1) — إدارة المنصة:** ✅ الباقات، الحدود المطبّقة، الإيقاف، لوحة المنصة — [التقرير](docs/13-phase-6a-platform-admin.md).
- **التالي:** المرحلة 6 (جزء 2) — الدفع و ZATCA (بانتظار اختيار المزود).

| الوثيقة | المحتوى |
|---|---|
| [00 — التحليل والمخاطر](docs/00-analysis-and-risks.md) | المستخدمون، حالات الاستخدام، التدفقات، المخاطر، الأسئلة المفتوحة، القرارات التقنية |
| [01 — PRD](docs/01-PRD.md) | المتطلبات الوظيفية وغير الوظيفية، مبادئ AI، التقييم، KPIs، سيناريوهات الاختبار |
| [02 — المعمارية](docs/02-architecture.md) | Modular Monolith، تعدد المستأجرين و RLS، طبقة AI و Tool Gateway، PWA، الأمان، النشر |
| [03 — نموذج البيانات](docs/03-database-schema.md) | شرح المخطط — المرجع التنفيذي في [`db/schema.sql`](db/schema.sql) |
| [04 — خريطة الشاشات](docs/04-screen-map.md) | الشاشات العشرون، تجربة المندوب، نظام التصميم |
| [05 — خطة التطوير](docs/05-roadmap.md) | المراحل الثمانية، المدد، بوابات الانتقال |
| [06 — الخدمات والتكاليف](docs/06-external-services-and-costs.md) | المزودون، التكاليف التقديرية، حدود الباقات المقترحة |
| [07 — خطة Phase 2](docs/07-phase-2-execution-plan.md) | المرحلة الأولى للتنفيذ: Foundation |
| [08 — نموذج Pilot انجزني](docs/08-enjazni-pilot-intake.md) | المعلومات المطلوبة من انجزني |
| [09 — تقرير المرحلة الثانية](docs/09-phase-2-report.md) | ما تم بناؤه، الاختبارات، الأمان، القرارات، النواقص |
| [10 — تقرير المرحلة الثالثة](docs/10-phase-3-report.md) | CRM: العملاء، الاستيراد، الفرص، الزيارات، المهام، لوحة القياس |
| [11 — تقرير المرحلة الرابعة](docs/11-phase-4-report.md) | الأمان (MFA)، طبقة AI، عقل المبيعات، المساعدون الأربعة، الموافقات |
| [12 — تقرير المرحلة الخامسة](docs/12-phase-5-report.md) | تطبيق الجوال، العمل دون اتصال، المزامنة دون تكرار، الملاحظات الصوتية |
| [13 — لوحة إدارة المنصة](docs/13-phase-6a-platform-admin.md) | الباقات، الحدود، الإيقاف، لوحة فريق راكان |
| [14 — الوكلاء الإضافيون](docs/14-agents-prospecting-assistant.md) | اسأل راكان، البحث عن عملاء جدد، العملاء المهملون |

## هيكل المشروع

```
apps/api        NestJS API (Modular Monolith)
apps/web        Next.js — واجهة عربية RTL
packages/db     Migrations (SQL + RLS) + Drizzle schema + سياق المستأجر
packages/shared الصلاحيات + Zod schemas + أنواع مشتركة بين الخادم والواجهة
e2e/            اختبار المتصفح الكامل
db/schema.sql   المخطط المرجعي الكامل (Discovery)
```

## التشغيل محلياً

المتطلبات: Node 22، pnpm 10، Docker (أو PostgreSQL 16 محلي).

```bash
docker compose up -d postgres mailpit
```

```bash
cp .env.example .env
```

```bash
pnpm install
```

```bash
set -a && . ./.env && set +a && pnpm db:setup
```

```bash
pnpm build && pnpm dev
```

- الواجهة: http://localhost:3000
- رسائل البريد (الدعوات واستعادة كلمة المرور): http://localhost:8025
- لوحة إدارة المنصة: `pnpm platform:grant <email>` ثم افتح http://localhost:3000/platform
- الذكاء الاصطناعي: ضع `ANTHROPIC_API_KEY` في `.env` (في الخادم فقط). بدونه تعمل المنصة وتظهر المساعدات كـ"غير مفعّلة".

## الاختبارات

```bash
set -a && . ./.env && set +a && pnpm lint && pnpm typecheck && pnpm test
```

```bash
pnpm test:isolation:app-layer   # عزل الشركات مع تعطيل RLS: طبقة التطبيق وحدها
```

اختبارات المتصفح (تتطلب تشغيل الـAPI بـ`MAIL_TRANSPORT=log` والواجهة على قاعدة بيانات فارغة):

```bash
pnpm e2e && pnpm e2e:crm && pnpm e2e:ux && pnpm e2e:ai && pnpm e2e:field && pnpm e2e:platform
```

## التقنيات

Next.js + TypeScript + Tailwind · NestJS · PostgreSQL + pgvector + RLS · Redis + BullMQ · Drizzle ORM · طبقة مزودي AI مستقلة · Object Storage داخل المملكة.
