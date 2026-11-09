# 03 — نموذج البيانات (Database Schema)

> المرجع التنفيذي: [`db/schema.sql`](../db/schema.sql) — تم التحقق من تطبيقه على PostgreSQL 16 + pgvector.
> اختبار العزل: [`db/tests/tenant_isolation.sql`](../db/tests/tenant_isolation.sql) — ناجح، وتم التأكد أنه يفشل عند تعطيل RLS.

---

## 1. المبادئ

1. كل جدول خاص بشركة يحتوي `tenant_id` و **RLS مفعّل ومفروض (FORCE)**؛ بدون سياق مستأجر لا تُرجع أي صفوف (Fail closed).
2. **مفاتيح أجنبية مركبة** `(tenant_id, x_id)` تمنع ربط سجل بسجل شركة أخرى حتى لو أخطأ الكود.
3. **المصدر (Provenance)**: جدول `data_sources` يربط أي حقل بمصدره ونوعه وتاريخ الحصول عليه والثقة.
4. **مخرجات AI** محفوظة في جداول منظمة (`lead_scores`, `visit_briefs`, `meeting_insights`) مع `reasons/sources/confidence` وربط بـ`agent_run_id` للتتبع.
5. **`client_id`** فريد لكل مستأجر في الجداول التي ينشئها المندوب دون إنترنت → مزامنة Idempotent.
6. **البيانات الشخصية** الحساسة (جوال وبريد جهات الاتصال) مشفرة بمفتاح المستأجر، مع `hash` للبحث وكشف التكرار.
7. **سجل التدقيق** append-only (لا UPDATE/DELETE لدور التطبيق).
8. التخصيص (المراحل، الأسباب، الحقول، المسارات، معايير التقييم) **بيانات وليست كوداً**.

## 2. مخطط الكيانات (ERD مبسط)

```
tenants ─┬─< memberships >── users ──< sessions
         ├─< roles
         ├─< territories ──< territory_assignments >── memberships
         ├─< tracks ──< pipelines ──< pipeline_stages
         ├─< accounts ─┬─< contacts ──< message_drafts
         │             ├─< opportunities ─┬─< opportunity_stage_history
         │             │                  ├─< quotes ──< quote_items >── products
         │             │                  └─< tasks
         │             ├─< visits ─┬─< visit_recordings ── files
         │             │           ├── visit_briefs
         │             │           └── meeting_insights
         │             ├─< lead_scores >── scoring_models
         │             ├─< activities
         │             └─< data_sources (polymorphic)
         ├─< brain_items ──< brain_item_versions
         ├─< brain_documents ──< brain_chunks (vector)
         ├─< import_jobs ──< import_rows
         ├─< agent_settings
         ├─< agent_runs ──< agent_steps
         ├─< approval_requests
         ├─< integrations (secrets encrypted)
         ├─< subscriptions >── plans
         ├─< usage_events / usage_counters
         ├─< invoices
         └─< audit_logs
```

## 3. المجموعات

| المجموعة | الجداول | ملاحظات |
|---|---|---|
| المنصة | `users`, `sessions`, `plans`, `tenants`, `ai_model_routes` | بلا RLS؛ تصل لها وحدات identity/platform فقط |
| المستأجر والصلاحيات | `memberships`, `roles`, `invitations`, `territories`, `territory_assignments` | الأدوار النظامية `tenant_id = NULL` مرئية للجميع للقراءة |
| CRM | `tracks`, `pipelines`, `pipeline_stages`, `custom_field_defs`, `accounts`, `contacts`, `opportunities`, `opportunity_stage_history`, `outcome_reasons`, `tasks`, `notes`, `files`, `activities`, `products`, `quotes`, `quote_items`, `data_sources` | `tracks` تحقق فصل مساري انجزني بشكل عام |
| الاستيراد | `import_jobs`, `import_rows` | `data_permission_confirmed` إقرار المستخدم بمشروعية البيانات |
| الزيارات | `visits`, `visit_recordings` | `recording_consent` إلزامي قبل رفع الصوت؛ `retention_until` لحذف الصوت تلقائياً |
| Sales Brain | `brain_items`, `brain_item_versions`, `brain_documents`, `brain_chunks`, `scoring_models` | الوكلاء يقرؤون `status = 'approved'` فقط؛ `conflict_ids` للتناقضات |
| الوكلاء | `agent_settings`, `agent_runs`, `agent_steps`, `lead_scores`, `visit_briefs`, `meeting_insights`, `approval_requests` | `payload_hash` يضمن تنفيذ الحمولة المعتمدة حرفياً |
| التواصل | `message_drafts`, `inbound_messages` | DNC على مستوى `contacts` |
| SaaS | `integrations`, `subscriptions`, `usage_events`, `usage_counters`, `invoices` | `usage_counters` مصدر الحقيقة للحدود، و Redis للعداد اللحظي |

## 4. كشف التكرار

ترتيب المطابقة (من الأقوى للأضعف):

1. `cr_number` (فهرس فريد جزئي).
2. `vat_number`.
3. `website_domain`.
4. `phone` للشركة (مطبّع إلى E.164).
5. `name_normalized` + `city` بتشابه trigram ≥ 0.85 (فهرس `gin_trgm_ops`).

**التطبيع العربي** لـ`name_normalized`: إزالة التشكيل والتطويل، توحيد (أ إ آ → ا)، (ة → ه)، (ى → ي)، إزالة اللواحق القانونية (شركة، مؤسسة، المحدودة، ذ.م.م، Co., Ltd)، توحيد المسافات والأرقام العربية/الهندية.

## 5. Sales Brain — هيكل `content` لكل قسم (أمثلة)

```jsonc
// section = 'objections'
{ "objection": "الأسعار أعلى من السوق",
  "approved_response": "...",
  "when_to_use": "...",
  "track": "shipper" }

// section = 'discount_rules'
{ "max_discount_pct_rep": 0, "max_discount_pct_manager": 10,
  "conditions": ["عقد سنوي", "حجم شحنات > X"] }

// section = 'forbidden'
{ "phrases": ["نضمن لك", "أرخص سعر في السوق"],
  "promises": ["مواعيد تسليم مضمونة دون عقد"] }

// section = 'icp'
{ "industries": ["..."], "regions": ["..."], "min_size": "...",
  "signals": ["..."], "track": "carrier" }
```

كل قسم له Zod schema في `packages/shared/brain`.

## 6. الفهارس والأداء

- كل جدول كبير مفهرس بدءاً بـ`tenant_id`.
- `brain_chunks` بفهرس HNSW (cosine)؛ الاستعلام دائماً مع فلتر `tenant_id` (RLS + شرط صريح). عند تجاوز ~1M chunk يُنظر في التقسيم (Partitioning) حسب المستأجر.
- `activities`, `audit_logs`, `usage_events`, `agent_steps`: مرشحة للتقسيم الزمني الشهري لاحقاً.

## 7. الاحتفاظ والحذف

| البيانات | الاحتفاظ الافتراضي (قابل للتعديل) |
|---|---|
| تسجيلات الصوت | 90 يوماً ثم حذف تلقائي (النص يبقى) |
| `agent_steps` (حمولة مفصلة) | 180 يوماً |
| سجل التدقيق | 3 سنوات (يُراجع قانونياً) |
| بيانات الشركة بعد إلغاء الاشتراك | 90 يوماً ثم حذف بعد إشعار وتصدير متاح |

## 8. ما بعد Discovery

- يتحول `db/schema.sql` إلى Drizzle schema + migrations في `packages/db` خلال Phase 2.
- `db/tests/tenant_isolation.sql` يتحول إلى اختبار تكامل يُشغل في CI على كل الجداول تلقائياً (القائمة من `pg_policies`).
