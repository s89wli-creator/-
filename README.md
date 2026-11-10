# راكان — AI Sales Employee

منصة SaaS سعودية متعددة المستأجرين تقدم **موظف مبيعات ذكي** يعمل بجانب فرق المبيعات الميدانية B2B: اكتشاف وتحليل العملاء، تجهيز الزيارات، تحليل الاجتماعات، إدارة المتابعات، وتقارير الإدارة — مع موافقة بشرية على القرارات التجارية الحساسة.

أول عميل تجريبي: **انجزني** (النقل والخدمات اللوجستية). المنتج عام وغير مرتبط بقطاع النقل.

## الحالة

- **المرحلة 1 — Discovery:** ✅ معتمدة.
- **المرحلة 2 — Foundation:** ✅ مكتملة — [التقرير](docs/09-phase-2-report.md).
- **المرحلة 3 — Core CRM:** ✅ مكتملة — [التقرير](docs/10-phase-3-report.md).
- **تجربة المستخدم:** ✅ نظام تصميم موحّد — [design-system/rakan/MASTER.md](design-system/rakan/MASTER.md).
- **التالي:** المرحلة 4 — AI Intelligence (Sales Brain والوكلاء والموافقات).

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

## الاختبارات

```bash
set -a && . ./.env && set +a && pnpm lint && pnpm typecheck && pnpm test
```

```bash
pnpm test:isolation:app-layer   # عزل الشركات مع تعطيل RLS: طبقة التطبيق وحدها
```

اختبارات المتصفح (تتطلب تشغيل الـAPI بـ`MAIL_TRANSPORT=log` والواجهة على قاعدة بيانات فارغة):

```bash
pnpm e2e && pnpm e2e:crm && pnpm e2e:ux
```

## التقنيات

Next.js + TypeScript + Tailwind · NestJS · PostgreSQL + pgvector + RLS · Redis + BullMQ · Drizzle ORM · طبقة مزودي AI مستقلة · Object Storage داخل المملكة.
