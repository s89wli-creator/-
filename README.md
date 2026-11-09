# راكان — AI Sales Employee

منصة SaaS سعودية متعددة المستأجرين تقدم **موظف مبيعات ذكي** يعمل بجانب فرق المبيعات الميدانية B2B: اكتشاف وتحليل العملاء، تجهيز الزيارات، تحليل الاجتماعات، إدارة المتابعات، وتقارير الإدارة — مع موافقة بشرية على القرارات التجارية الحساسة.

أول عميل تجريبي: **انجزني** (النقل والخدمات اللوجستية). المنتج عام وغير مرتبط بقطاع النقل.

## الحالة

**المرحلة 1 — Discovery: مكتملة وبانتظار الاعتماد.**

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

## التحقق من المخطط محلياً

```bash
createdb rakan && psql -d rakan -v ON_ERROR_STOP=1 -f db/schema.sql
```

```bash
psql -d rakan -f db/tests/tenant_isolation.sql   # يتطلب PostgreSQL 16 + pgvector
```

## التقنيات

Next.js + TypeScript + Tailwind · NestJS · PostgreSQL + pgvector + RLS · Redis + BullMQ · Drizzle ORM · طبقة مزودي AI مستقلة · Object Storage داخل المملكة.
