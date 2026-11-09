# 05 — خطة التطوير (Development Roadmap)

> التقديرات لفريق صغير (2–3 مهندسين + مصمم جزئي) بمساعدة AI. المدد تقديرية وتُراجع في نهاية كل مرحلة.
> قاعدة: كل مرحلة تنتهي بـ: اختبارات ناجحة + تحقق قاعدة البيانات + تحقق الصلاحيات + مراجعة UX + توثيق.

---

## نظرة زمنية

| المرحلة | المدة التقديرية | المخرج الرئيسي | بوابة الانتقال |
|---|---|---|---|
| 1. Discovery | ✅ هذه الوثائق | PRD، المعمارية، المخطط، الشاشات، الخطة، التكاليف | **اعتماد صاحب المشروع** |
| 2. Foundation ✅ | 2–3 أسابيع | Monorepo، Auth، Multi-tenancy + RLS، RBAC، الشركات والفريق، Audit، CI | اختبارات العزل والصلاحيات ناجحة 100% |
| 3. Core CRM ✅ | 3–4 أسابيع | العملاء، جهات الاتصال، المسارات، الفرص والمراحل، المهام، الزيارات (ويب)، الاستيراد مع التكرار، Timeline، Dashboard أساسي | استيراد ملف حقيقي من انجزني بنجاح على Staging |
| 4. AI Intelligence | 4–5 أسابيع | AI Provider layer، Tool Gateway، الموافقات، Sales Brain، Lead Intelligence، Field Sales Brief، Meeting Intelligence، Follow-up؛ ثم Prospecting و Coach | Evals عربية تتجاوز الحد المحدد؛ اختبارات T2، T3، T6، T9، T10 |
| 5. Field Experience | 3 أسابيع | PWA، Offline outbox، الصوت + STT، الخرائط، شاشة النتيجة السريعة | تسجيل زيارة ≤ 3 دقائق في اختبار ميداني؛ T5 ناجح |
| 6. SaaS Operations | 2–3 أسابيع | الباقات، العدادات، الحدود، الدفع، الفوترة الإلكترونية، لوحة Super Admin | T7 ناجح؛ تكلفة AI مرئية |
| 7. Enjazni Pilot | 6–8 أسابيع (متداخلة جزئياً مع 5–6) | Sales Brain انجزني المعتمد، بيانات حقيقية، 2–5 مندوبين، قياس قبل/بعد | تقرير نتائج Pilot مقابل الأهداف |
| 8. Commercial Launch | 2 أسابيع | حساب شركة ثانية من الصفر، اختبار عزل شامل، مراجعة أمنية، أول عميل خارجي | إعداد عميل جديد دون أي تدخل برمجي |

**الإجمالي حتى بدء Pilot**: ~ 14–18 أسبوعاً. يمكن بدء Pilot "مبكر" بعد Phase 4 (الويب فقط) لجمع ملاحظات.

## ترتيب الأولويات داخل المراحل

### Phase 2 — Foundation (تفصيل في [07-phase-2-execution-plan.md](07-phase-2-execution-plan.md))

### Phase 3 — Core CRM
1. Tracks + Pipelines + Stages + Reasons + Custom fields (إعدادات).
2. Accounts + Contacts (CRUD، بحث عربي، تطبيع، DNC).
3. Import (رفع → ربط أعمدة → تحقق → تكرار → مراجعة → تنفيذ) + Export.
4. Opportunities + Kanban + سجل المراحل.
5. Tasks + Notes + Files + Activities timeline.
6. Visits (جدولة، تقويم، نتيجة) — نسخة الويب.
7. Dashboard v1 (أرقام من الاستعلامات مباشرة).

### Phase 4 — AI Intelligence (بالترتيب)
1. `packages/ai`: Providers + Router + Structured output + Cost metering + Evals harness.
2. Tool Gateway + Approvals module + Agent runs logging + لوحة الوكلاء.
3. Sales Brain (العناصر، الحالات، المستندات، التضمين، فحص الحقن، التناقضات).
4. Lead Intelligence (Scoring models قابلة للتعديل).
5. Field Sales — Pre-visit brief.
6. Meeting Intelligence (من النص أولاً؛ الصوت في Phase 5).
7. Follow-up (مهام + مسودات + DNC + كشف المهملين).
8. Orchestrator chat "اسأل راكان".
9. Prospecting (Adapter واحد مرخص على الأقل + إدخال يدوي للمصدر).
10. Sales Coach (بعد توفر بيانات كافية من Pilot).

### Phase 5 — Field
PWA shell → Offline cache للبطاقات → Outbox + Idempotent sync → Check-in/out + GPS اختياري → تسجيل صوتي + رفع مجزأ → STT + تصحيح → خرائط.

### Phase 6 — SaaS
Plans/limits كبيانات → عدادات Redis + Postgres → تنبيهات 80/100% → Hard limits → مزود الدفع → ZATCA → Platform admin.

## مخطط التبعيات

```
Foundation ──► Core CRM ──► AI (Gateway/Approvals) ──► Agents
                   │                                    │
                   └──────────► Field PWA ◄─────────────┘
Foundation ──► Usage metering (مبكراً، يحتاجه AI) ──► Billing
```

> ملاحظة: **عداد الاستهلاك والحدود الأساسية** يُبنى مع أول استدعاء AI في Phase 4 (وليس انتظاراً لـPhase 6)، لمنع أي استهلاك مفتوح من اليوم الأول.

## إدارة المخاطر في الخطة

| الخطر | نقطة القرار |
|---|---|
| جودة STT العربية | نهاية Phase 4: اختبار 3 مزودين على 20 تسجيلاً حقيقياً (بموافقة) |
| الاستضافة داخل المملكة | نهاية Phase 3: قبل إدخال بيانات انجزني الحقيقية |
| مصادر Prospecting | أثناء Phase 4: التعاقد مع مزود بيانات أو الاكتفاء بـGoogle Places + إدخال يدوي |
| الإطار القانوني (PDPL، التسجيل، التسويق المباشر) | قبل Pilot: مراجعة مستشار قانوني |
