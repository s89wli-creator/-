# 02 — وثيقة المعمارية (Architecture Document)

> النمط: **Modular Monolith** متعدد المستأجرين + Worker للمهام الخلفية
> الحالة: مسودة للاعتماد

---

## 1. نظرة عامة

```
                    ┌────────────────────────────────────────┐
  Browser / PWA ───►│  apps/web  (Next.js, TS, Tailwind)     │
  (Arabic RTL)      │  - Manager desktop UI                  │
                    │  - Rep mobile PWA (Service Worker,     │
                    │    IndexedDB outbox)                   │
                    └──────────────┬─────────────────────────┘
                                   │ HTTPS (JSON, cookie session + CSRF)
                    ┌──────────────▼─────────────────────────┐
                    │  apps/api  (NestJS Modular Monolith)   │
                    │  Guards: Auth → Tenant → RBAC → Usage  │
                    │  Modules: identity, tenancy, crm,      │
                    │  visits, sales-brain, agents, approvals│
                    │  billing, integrations, reports, audit │
                    └───┬───────────┬───────────┬────────────┘
                        │           │           │ enqueue
              ┌─────────▼──┐  ┌─────▼────┐  ┌───▼──────────────────┐
              │ PostgreSQL │  │  Redis   │  │ apps/worker (NestJS) │
              │ + pgvector │  │ BullMQ,  │  │ - Agent runs         │
              │ + RLS      │  │ rate lim │  │ - STT, doc ingestion │
              └────────────┘  └──────────┘  │ - imports, schedules │
                        ▲                   └───┬──────────────────┘
                        │                       │
              ┌─────────┴──────────┐   ┌────────▼───────────────────────┐
              │ Object Storage     │   │ External (via adapters only)    │
              │ (S3-compatible,    │   │ LLM providers, STT, Maps,       │
              │  in-Kingdom)       │   │ Email, WhatsApp, Data providers │
              └────────────────────┘   └────────────────────────────────┘
```

## 2. هيكل المستودع (Monorepo)

```
/
├─ apps/
│  ├─ web/            Next.js App Router (ar default, en)
│  ├─ api/            NestJS HTTP API
│  └─ worker/         NestJS standalone app (BullMQ processors)
├─ packages/
│  ├─ db/             Drizzle schema, migrations, RLS policies, seed
│  ├─ shared/         Zod schemas, DTO types, enums, permissions matrix
│  ├─ ai/             AI provider layer, tool gateway, agents, prompts, evals
│  ├─ ui/             Design system (RTL-first components)
│  └─ config/         eslint, tsconfig, tailwind preset
├─ db/schema.sql      Reference DDL (مرجع مقروء للمخطط)
├─ docs/
└─ infra/             docker-compose (dev), IaC لاحقاً
```

## 3. الوحدات (Backend Modules)

لكل وحدة: Controller → Service → Repository، ولا تصل وحدة إلى جداول وحدة أخرى مباشرة إلا عبر Service عام (Public API للوحدة). يتم فرض ذلك بقواعد ESLint (`no-restricted-imports`).

| الوحدة | المسؤولية |
|---|---|
| `identity` | المستخدمون، كلمات المرور (Argon2id)، الجلسات، MFA، الدعوات، إعادة التعيين |
| `tenancy` | الشركات (Tenants)، العضويات، الأدوار، الصلاحيات، المناطق، الفرق، إعدادات الشركة |
| `audit` | سجل التدقيق (append-only) |
| `crm` | Accounts، Contacts، Opportunities، Pipelines/Stages، Tasks، Notes، Activities، Custom fields، Tracks، Quotes |
| `imports` | رفع الملفات، ربط الأعمدة، التحقق، كشف التكرار، التنفيذ عبر Worker |
| `visits` | الزيارات، Check-in/out، النتائج، المرفقات، التسجيلات، المزامنة Offline |
| `sales-brain` | العناصر المنظمة، المستندات، التقطيع والتضمين، الإصدارات، كشف التناقض |
| `agents` | Orchestrator، الوكلاء، تشغيلات الوكلاء (Agent runs)، الأدوات |
| `approvals` | طلبات الموافقة وتنفيذها |
| `messaging` | المسودات، الإرسال (Email/WhatsApp)، DNC، الموافقات على التواصل |
| `billing` | الباقات، الاشتراكات، العدادات، الحدود، الفواتير |
| `integrations` | إعدادات ومفاتيح التكامل المشفرة، Adapters |
| `reports` | المؤشرات، لوحات التحكم (Read models / Materialized views) |
| `files` | Object storage، روابط موقعة قصيرة العمر، فحص النوع والحجم |
| `platform-admin` | لوحة Super Admin |

## 4. تعدد المستأجرين (Multi-Tenancy)

### 4.1 النموذج

- **قاعدة بيانات مشتركة، مخطط مشترك، عمود `tenant_id`** في كل جدول خاص بالمستأجر.
- السبب: أبسط تشغيلاً وأرخص لعدد كبير من الشركات الصغيرة. يمكن لاحقاً نقل عميل Enterprise إلى قاعدة بيانات مستقلة لأن كل الوصول يمر بـ`tenant_id`.

### 4.2 طبقات الحماية (Defense in depth)

1. **TenantGuard**: يحدد المستأجر من الجلسة (العضوية النشطة)، وليس من أي معامل يرسله العميل.
2. **Repository layer**: كل استعلام يمر عبر `withTenant(tx)` يضيف `tenant_id`.
3. **PostgreSQL RLS**: التطبيق يتصل بدور `app_user` (ليس owner للجداول ولا يملك `BYPASSRLS`). كل طلب يعمل داخل معاملة تبدأ بـ:
   ```sql
   SELECT set_config('app.tenant_id', $1, true);  -- true = local to transaction
   SELECT set_config('app.user_id',   $2, true);
   ```
   والسياسة:
   ```sql
   CREATE POLICY tenant_isolation ON accounts
     USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
     WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
   ```
   إذا لم يُضبط المتغير تُرجع السياسة صفراً (Fail closed).
4. **المفاتيح المركبة**: علاقات المفاتيح الأجنبية تشمل `tenant_id` (`FOREIGN KEY (tenant_id, account_id) REFERENCES accounts(tenant_id, id)`) لمنع ربط سجل بسجل مستأجر آخر حتى بالخطأ.
5. **Cache**: كل مفتاح Redis يبدأ بـ`t:{tenantId}:`؛ لا Cache مشترك لمخرجات AI بين المستأجرين.
6. **Vector search**: الاستعلام دائماً مع `WHERE tenant_id = …` داخل نفس RLS.
7. **الملفات**: المسار `tenants/{tenantId}/...` + روابط موقعة صلاحيتها ≤ 5 دقائق بعد التحقق من الصلاحية.
8. **الطوابير**: كل Job يحمل `tenantId` ويعيد Worker ضبط سياق RLS قبل أي استعلام.
9. **Super Admin** يستخدم مساراً منفصلاً (`/platform/*`) بدور قاعدة بيانات مختلف ومسجل بالكامل في التدقيق؛ لا يرى بيانات العملاء التشغيلية افتراضياً (فقط بيانات الاشتراك والاستهلاك) إلا بـ"وصول دعم" مؤقت يمنحه مالك الشركة.

### 4.3 اختبارات العزل

مجموعة اختبارات تُنشئ مستأجرين A و B وتتحقق آلياً من كل Endpoint قراءة/كتابة (قائمة مولدة من الـRouter) أن مستخدم A لا يقرأ/يعدل/يحذف/يصدر/يبحث عن بيانات B، إضافة لاختبار مباشر على قاعدة البيانات بدون فلتر التطبيق للتأكد من RLS.

## 5. الهوية والصلاحيات

- **الجلسات**: Cookie `HttpOnly; Secure; SameSite=Lax` بمعرف جلسة عشوائي، الجلسة مخزنة (hash) في PostgreSQL مع Cache في Redis؛ انتهاء بعد خمول 12 ساعة (قابل للتعديل)، وتدوير عند تغيير الصلاحيات. حماية CSRF بـDouble-submit token.
- **الأدوار** (افتراضية؛ يمكن للشركة إنشاء أدوار مخصصة من الصلاحيات في P1):

| الصلاحية | Owner | Manager | Rep | Read-only |
|---|:-:|:-:|:-:|:-:|
| إعدادات الشركة والاشتراك | ✔ | — | — | — |
| إدارة المستخدمين والأدوار | ✔ | ✔ (دون Owner) | — | — |
| Sales Brain تعديل/اعتماد | ✔ | ✔ | — | قراءة |
| العملاء: كل الشركة | ✔ | ✔ | المسندون فقط* | قراءة |
| استيراد/تصدير | ✔ | ✔ | — | — |
| الموافقات | ✔ | ✔ (ضمن حدود) | — | — |
| الزيارات | ✔ | ✔ | الخاصة به | قراءة |
| إعدادات الوكلاء والتكاملات | ✔ | قراءة | — | — |
| التقارير | ✔ | ✔ | الخاصة به | ✔ |
| سجل التدقيق | ✔ | ✔ | — | — |

\* قابل للتعديل لكل شركة.

- الصلاحيات معرفة كنصوص (`crm.account.read`, `approvals.decide`, …) في `packages/shared` ويُفحص كل Endpoint بـ`@RequirePermission()`، مع فحص على مستوى السجل (Ownership) للمندوب.
- **Super Admin** دور على مستوى المنصة منفصل عن العضويات.

## 6. طبقة الذكاء الاصطناعي

### 6.1 AI Provider Layer (`packages/ai/providers`)

```ts
interface LlmProvider {
  id: string;                       // 'anthropic' | 'openai' | 'google' | 'azure-openai' | ...
  capabilities(model: string): ModelCapabilities;
  generate(req: GenerateRequest): Promise<GenerateResult>;   // with tools + structured output
}
interface ModelCapabilities {
  toolCalling: boolean; structuredOutput: 'native' | 'json-mode' | 'none';
  arabicQuality: 'high' | 'medium' | 'low';    // من تقييمات داخلية، وليس افتراضاً
  contextWindow: number; costPer1MInput: number; costPer1MOutput: number;
  dataRegion?: string;
}
```

- **Model Router**: يختار النموذج حسب `task profile` (مثلاً `extraction.ar`, `reasoning.ar`, `classification`, `embedding`) والتكلفة والقدرات وتفضيلات المستأجر. الإعداد في جدول `ai_model_routes` وليس في الكود.
- **Fallback**: عند فشل المزود (timeout، 5xx، rate limit) ينتقل لمزود بديل يحقق نفس القدرات.
- **Structured outputs**: كل مخرج مُعرّف بـZod schema؛ للنماذج التي لا تدعمها أصلياً يُستخدم JSON mode + تحقق + إعادة محاولة واحدة للإصلاح.
- **Evals**: مجموعة اختبارات عربية (ملخصات زيارات، استخراج اعتراضات، تقييم) تقيس كل نموذج قبل تفعيله؛ تحدد `arabicQuality`.
- **Embeddings**: نموذج تضمين متعدد اللغات؛ البعد مخزن مع كل Chunk (`embedding_model`) لدعم تغيير النموذج وإعادة الفهرسة.

### 6.2 Orchestrator والوكلاء

بدلاً من عدد كبير من الوكلاء المستقلين: **Orchestrator واحد** + **وكلاء متخصصين = (System prompt + Allow-list أدوات + Output schema + سياسة)**، يُنفَّذون في نفس محرك التشغيل.

```
AgentRun {
  id, tenant_id, agent, trigger (user|schedule|event), input,
  status: queued|running|awaiting_approval|succeeded|failed|cancelled,
  steps[] (model call | tool call | tool result), cost, tokens, model, error
}
```

| الوكيل | الأدوات المسموحة (أمثلة) | المخرج |
|---|---|---|
| Orchestrator | كل أدوات القراءة + تفويض للوكلاء + `tasks.create` | رد للمستخدم + إجراءات |
| Prospecting | `prospect.search` (Adapters مرخصة)، `accounts.find_duplicates`, `leads.propose` | Leads مقترحة بحالة pending_review + sources |
| Lead Intelligence | `accounts.read`, `brain.read_icp`, `scoring.compute`, `accounts.save_score` | LeadScore |
| Field Sales | `accounts.read`, `brain.search`, `visits.read`, `briefs.save` | VisitBrief |
| Meeting Intelligence | `visits.read_transcript`, `brain.search`, `insights.save` | MeetingInsights |
| Follow-up | `tasks.create`, `messages.draft`, `contacts.check_dnc`, `opportunities.propose_stage` | مسودات + مهام |
| Sales Coach | `reports.read_rep_metrics`, `insights.read` | CoachingReport (حد أدنى للبيانات) |

### 6.3 Tool Gateway (نقطة الأمان الأساسية)

كل أداة معرفة كالتالي:

```ts
defineTool({
  name: 'messages.send',
  risk: 'EXTERNAL',            // READ | WRITE_INTERNAL | EXTERNAL | IRREVERSIBLE
  permission: 'messaging.send',
  input: z.object({...}),
  requiresApproval: true,      // إلزامي لـEXTERNAL و IRREVERSIBLE ولا يمكن إلغاؤه من الإعدادات
  handler: async (ctx, input) => {...}
})
```

قبل التنفيذ يتحقق الـGateway من:
1. الأداة ضمن Allow-list للوكيل.
2. المستخدم المُشغِّل (أو مالك المهمة المجدولة) يملك الصلاحية.
3. سياق المستأجر صحيح (RLS).
4. المدخلات تطابق Schema.
5. الميزانية/الحدود.
6. مستوى الخطر: `EXTERNAL`/`IRREVERSIBLE` → إنشاء `approval_request` وإيقاف التشغيل بحالة `awaiting_approval`. بعد الموافقة ينفذ الـGateway (وليس النموذج) الحمولة المعتمدة **كما هي حرفياً**.

الوكيل **لا يملك أي وصول SQL أو HTTP مفتوح**.

### 6.4 الحماية من Prompt Injection والهلوسة

- الفصل في السياق: التعليمات في System؛ المحتوى الخارجي (مستندات، رسائل عملاء، صفحات ويب، نصوص اجتماعات) داخل حدود مميزة مع تنبيه أنه بيانات.
- فحص المستندات عند الرفع (قواعد + مصنف) ووسم `trust_level`.
- المحتوى غير الموثوق لا يستطيع رفع مستوى الصلاحيات: الأدوات الحساسة تحتاج موافقة دائماً.
- **Grounding check**: لكل حقيقة في المخرج حقل `source_ref` يُتحقق برمجياً أنه يشير لسجل/مقطع موجود فعلاً في السياق المرسل؛ الحقائق بدون مرجع صالح تُحذف أو تُوسم "غير مؤكد".
- **Forbidden phrases check**: فحص المخرجات الموجهة للعميل مقابل قائمة الممنوعات في Sales Brain.
- **PII minimization**: إخفاء أرقام الجوالات والبريد وأسماء الأشخاص (حيث لا تلزم) قبل إرسالها للنموذج، واستبدالها برموز تُعاد بعد الاستجابة.

### 6.5 التكلفة والحدود

- قبل كل استدعاء: تقدير التوكنات × سعر النموذج → فحص الرصيد المتبقي (Redis atomic counter).
- بعد الاستدعاء: تسجيل التكلفة الفعلية في `ai_usage_events` وربطها بـ`agent_run`.
- حدود: شهرية للمستأجر، يومية لكل مستخدم، لكل تشغيل (max steps، max tokens).
- عرض التكلفة بالريال في لوحة الوكلاء.

## 7. المهام الخلفية (BullMQ)

| الطابور | الأمثلة | السياسة |
|---|---|---|
| `agents` | تشغيل الوكلاء | concurrency لكل مستأجر (Fairness)، retry مع backoff |
| `ingestion` | استخراج نص المستندات، التقطيع، التضمين | retry 3 |
| `stt` | تفريغ الصوت | retry + fallback مزود |
| `imports` | استيراد الملفات | بدون retry تلقائي للكتابة؛ تنفيذ Idempotent بالدفعات |
| `scheduler` | كشف المتابعات المتأخرة، العملاء المهملين، تنبيهات الاستهلاك | Repeatable jobs |
| `notifications` | البريد، إشعارات داخل التطبيق | retry |

Dead-letter: المهام الفاشلة نهائياً تحفظ بحمولتها وسببها وتظهر في لوحة الوكلاء/المنصة.

## 8. تجربة المندوب الميدانية (PWA)

- Next.js + Service Worker (Workbox) لتخزين الواجهة وبطاقات زيارات اليوم والأيام القادمة.
- **IndexedDB Outbox**: كل إنشاء/تعديل يحمل `client_id` (UUID من الجهاز) و`client_updated_at`؛ الخادم يُطبق `INSERT … ON CONFLICT (tenant_id, client_id) DO NOTHING/UPDATE` → المزامنة Idempotent.
- **التعارضات**: آخر كتابة تفوز لحقول الملاحظات الخاصة بالمندوب؛ الحقول التي يملكها المدير (الإسناد، المرحلة) تفوز فيها نسخة الخادم ويُخطر المندوب.
- **الصوت**: تسجيل بـMediaRecorder، تخزين مقطع في IndexedDB، رفع مجزأ (Chunked/Resumable) عند توفر الاتصال.
- **الأمان على الجهاز**: مسح البيانات المحلية عند تسجيل الخروج أو انتهاء الجلسة؛ تخزين أقل قدر من البيانات (زيارات الأيام القريبة فقط).
- **الموقع**: يُطلب عند Check-in/out فقط وبموافقة؛ يُحفظ مع الدقة (accuracy) ولا يستخدم كدليل وحيد.

## 9. الواجهة الأمامية

- Next.js App Router، `next-intl` للترجمة، `dir="rtl"` افتراضي، Tailwind مع **Logical properties** (`ms-*`, `me-*`, `ps-*`) فقط لضمان RTL/LTR.
- خطوط: IBM Plex Sans Arabic أو Noto Kufi/Naskh Arabic (مجانية).
- مكونات: Radix UI primitives + نظام تصميم داخلي (`packages/ui`)؛ TanStack Query للبيانات؛ React Hook Form + Zod (نفس schemas الخادم).
- واجهتان منفصلتان في التنقل: `/(manager)/*` (Desktop-first) و `/(field)/*` (Mobile-first PWA).
- لا توجد مفاتيح API في الواجهة؛ كل الاستدعاءات الخارجية عبر الخادم.

## 10. التخزين والملفات

- Object storage متوافق مع S3 داخل المملكة؛ تشفير على مستوى الخادم.
- فحص نوع الملف بالمحتوى (magic bytes) وليس الامتداد؛ حدود حجم حسب الباقة؛ فحص فيروسات (ClamAV) في Worker.
- روابط رفع/تنزيل موقعة قصيرة العمر.

## 11. الأمان التشغيلي

| المجال | الإجراء |
|---|---|
| الأسرار | Secret manager؛ لا أسرار في المستودع؛ مفاتيح تكامل المستأجرين مشفرة بـEnvelope encryption (DEK لكل مستأجر مشفر بـKEK من KMS) |
| API | Rate limiting (لكل IP، لكل مستخدم، لكل مستأجر)، Helmet headers، CORS مقيد، تحقق Zod لكل مدخل، حجم طلب أقصى |
| التدقيق | جدول `audit_logs` append-only (صلاحية INSERT فقط لدور التطبيق)، تصدير دوري |
| المراقبة | OpenTelemetry + Sentry (أو بديل مستضاف ذاتياً)، تنبيهات على الأخطاء ومعدل فشل الوكلاء والتكلفة |
| النسخ الاحتياطي | Managed PostgreSQL backups + PITR؛ نسخ Object storage؛ اختبار استعادة |
| الاعتماديات | Renovate + `pnpm audit` + فحص الأسرار في CI |
| البيانات الشخصية | سياسة احتفاظ، حذف/تصدير عند الطلب، سجل المعالجة |

## 12. النشر

- **التطوير**: docker-compose (Postgres 16 + pgvector، Redis، MinIO، Mailpit).
- **الإنتاج (V1)**: حاويات (API، Worker، Web) على مزود سحابي بمنطقة داخل المملكة؛ Managed PostgreSQL مع pgvector؛ Managed Redis؛ Object storage؛ CDN للأصول الثابتة فقط.
- **CI/CD**: GitHub Actions: lint → typecheck → unit → integration (Testcontainers) → tenant isolation → build → deploy (staging تلقائي، production يدوي).
- **البيئات**: dev، staging، production — بيانات انجزني الحقيقية في production فقط.

## 13. قرارات قابلة للتأجيل

| القرار | متى |
|---|---|
| مزود الاستضافة النهائي داخل المملكة | قبل Pilot بالبيانات الحقيقية (نهاية Phase 3) |
| مزود STT | بعد اختبار عينات حقيقية (Phase 5) |
| مزود الدفع والفوترة الإلكترونية | Phase 6 |
| WhatsApp Business Platform الرسمي ومزود BSP | بعد Pilot |
| فصل أي وحدة كخدمة مستقلة | فقط عند وجود سبب قياسي (حمل، فريق، عزل) |
