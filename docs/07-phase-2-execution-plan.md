# 07 — المرحلة الأولى للتنفيذ: Foundation (Phase 2)

> ✅ **مكتملة** — النتائج في [09-phase-2-report.md](09-phase-2-report.md).
> تبدأ بعد اعتماد وثائق Discovery.
> الهدف: أساس آمن متعدد المستأجرين يُبنى عليه كل شيء، بدون أي ميزة شكلية.

---

## 1. النطاق

| # | البند | المخرج القابل للتحقق |
|---|---|---|
| 1 | Monorepo | `pnpm` + Turborepo؛ `apps/web`, `apps/api`, `apps/worker`, `packages/{db,shared,ui,config}`؛ `docker-compose` (Postgres16+pgvector، Redis، MinIO، Mailpit) |
| 2 | قاعدة البيانات | Drizzle schema للجداول: `users`, `sessions`, `tenants`, `plans`, `roles`, `memberships`, `invitations`, `territories`, `territory_assignments`, `audit_logs`؛ Migrations؛ أدوار `migrator` و `app_user` (NOBYPASSRLS)؛ سياسات RLS |
| 3 | سياق المستأجر | `TenantContext` + `db.withTenant(tenantId, userId, fn)` يفتح معاملة ويضبط `app.tenant_id`؛ منع أي استعلام على جداول المستأجر خارجها (lint rule + فحص وقت التشغيل) |
| 4 | المصادقة | تسجيل/دخول/خروج، Argon2id، جلسات Cookie، CSRF، قفل بعد 5 محاولات، إعادة تعيين كلمة المرور عبر البريد، Rate limiting |
| 5 | الشركات | إنشاء شركة (Owner)، إعدادات الشركة، تبديل الشركة النشطة للمستخدم متعدد العضويات |
| 6 | RBAC | مصفوفة الصلاحيات في `packages/shared`، `@RequirePermission()`، الأدوار الافتراضية الأربعة + Super Admin منفصل |
| 7 | الفريق | دعوة مستخدم بالبريد، قبول الدعوة، تغيير الدور، تعطيل، المناطق وإسنادها |
| 8 | سجل التدقيق | `AuditService.record()` + Interceptor للعمليات الكتابية، شاشة عرض بفلترة |
| 9 | الواجهة | AppShell عربي RTL، تبديل اللغة، شاشات: الدخول، نسيت كلمة المرور، قبول الدعوة، إنشاء الشركة، فريق العمل، المناطق، إعدادات الشركة، سجل التدقيق |
| 10 | CI | lint، typecheck، unit، integration (Postgres حقيقي)، **tenant isolation suite**، build |
| 11 | المراقبة | Structured logging (pino) مع `request_id` و `tenant_id` دون PII، Health endpoints |

**خارج النطاق**: MFA (P1، في نهاية Phase 3)، SSO، الفوترة.

## 2. الاختبارات المطلوبة (معايير القبول)

### Unit
- تجزئة/تحقق كلمة المرور، توليد/تحقق رموز الدعوة وإعادة التعيين (انتهاء الصلاحية، الاستخدام لمرة واحدة).
- مصفوفة الصلاحيات: كل دور × كل صلاحية مطابقة للجدول في وثيقة المعمارية.

### API / Integration
- دورة التسجيل → إنشاء شركة → دعوة مندوب → قبول → دخول المندوب.
- المندوب لا يستطيع الوصول لـ`/team` أو `/settings/company` (403).
- Manager لا يستطيع تعيين دور Owner.
- قفل الحساب بعد المحاولات الفاشلة.
- انتهاء الجلسة وإبطالها عند تعطيل المستخدم.
- كل عملية كتابة تنتج سجل تدقيق صحيحاً.

### Tenant Isolation (إلزامي — يمنع الدمج عند الفشل)
- لكل Endpoint مسجل في الـRouter: مستخدم شركة A يستدعيه بمعرفات شركة B → 404/لا بيانات.
- اختبار قاعدة البيانات المباشر (`db/tests/tenant_isolation.sql` معمم على كل الجداول من `pg_policies`).
- فحص أن كل جدول فيه `tenant_id` عليه RLS مفعّل ومفروض (اختبار ميتا يفشل عند إضافة جدول جديد بدون سياسة).

### UX
- كل الشاشات على 360px و 1440px، RTL صحيح، حالات Loading/Empty/Error.

## 3. خطوات التنفيذ بالترتيب

1. هيكل الـMonorepo + docker-compose + CI فارغ ناجح.
2. `packages/db`: schema + migrations + أدوار + RLS + اختبار العزل الميتا.
3. `apps/api`: Bootstrap، Config (Zod-validated env)، Logger، Error filter، Health.
4. Identity: users + sessions + auth endpoints + اختباراتها.
5. Tenancy: tenants + memberships + roles + guards + اختبارات الصلاحيات والعزل.
6. Audit: service + interceptor + endpoint.
7. Team: invitations + territories.
8. `apps/web`: AppShell + i18n + الشاشات + ربط API.
9. مراجعة أمنية داخلية للمرحلة (OWASP checklist) + توثيق `docs/phase-2-report.md`.

## 4. القرارات التي تُتخذ هندسياً داخل المرحلة (دون الرجوع لصاحب المشروع)

أسماء الحزم، تنظيم المجلدات، مكتبات المساعدة (pino، zod، argon2، next-intl، Radix، TanStack Query)، صيغة الـMigrations، تفاصيل CI.

## 5. ما يحتاج قرار صاحب المشروع قبل/أثناء المرحلة

| القرار | الافتراض إن لم يُحسم |
|---|---|
| اعتماد وثائق Discovery | — (شرط البدء) |
| اسم النطاق (Domain) والعلامة البصرية لـ"راكان" | هوية مؤقتة محايدة |
| مزود البريد للإرسال من بيئة Staging | Mailpit محلياً؛ مزود حقيقي عند الحاجة بعد الموافقة على التكلفة |
