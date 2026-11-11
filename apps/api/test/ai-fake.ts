import type { INestApplication } from '@nestjs/common';
import { FakeProvider } from '../src/ai/fake.provider';
import { LLM_PROVIDER } from '../src/ai/llm';

export function fake(app: INestApplication): FakeProvider {
  return app.get(LLM_PROVIDER) as FakeProvider;
}

const refsIn = (text: string, prefix: string) => [...text.matchAll(/\[((?:account|brain|doc|note|visit|opportunity):[^\]\s]+)\]/g)].map((m) => m[1]!).filter((r) => r.startsWith(prefix));

/** Plausible, schema-valid answers built only from what the prompt contains (like a well-behaved model). */
export function installDefaultAgents(f: FakeProvider): void {
  f.on('lead_intel', (req) => {
    const acc = refsIn(req.prompt, 'account:');
    return {
      criteria: ['icp_fit', 'need_size', 'region_fit', 'buying_power', 'recurring_need'].map((key) => ({ key, score: 80, reason: 'سبب', evidence: acc.slice(0, 1) })),
      disqualify: { matched: false, reason: '', evidence: [] },
      summary: 'عميل مناسب',
      missingData: [],
    };
  });
  f.on('visit_brief', (req) => {
    const b = refsIn(req.prompt, 'brain:')[0] ?? 'brain:none';
    return {
      summary: 'ملخص', whyTarget: [{ text: 'قطاع مناسب', evidence: refsIn(req.prompt, 'account:').slice(0, 1) }], goals: ['هدف'], questions: ['سؤال؟'],
      valuePoints: [{ text: 'قيمة موثقة', source: b }], objections: [], cautions: [],
    };
  });
  f.on('meeting_intel', (req) => {
    const notes = req.prompt.split('<untrusted_data source="meeting_notes">\n')[1]?.split('\n</untrusted_data>')[0] ?? '';
    return {
      summary: 'ملخص الاجتماع', statedFacts: [{ type: 'need', value: 'احتياج', quote: notes.slice(0, 25) }], inferences: [],
      nextActions: [{ action: 'إرسال عرض', dueInDays: 2 }], interestLevel: 4, progressLikelihood: 0.6,
    };
  });
  f.on('follow_up', () => ({ subject: 'متابعة زيارتنا', body: 'شكراً لوقتكم، نرغب بترتيب الخطوة التالية.', claims: [] }));
  f.on('prospecting', (req) => ({
    __sources: [{ url: 'https://dir.example.sa/p', title: 'P' }],
    candidates: [{
      name: req.prompt.includes('شركة ب') ? 'مقترح الشركة ب' : 'مقترح عام', website: null, city: null, region: null, industry: null, phone: null,
      whyFit: 'مناسب', fitEvidence: [], sourceUrl: req.prompt.includes('<untrusted_data') ? 'manual' : 'https://dir.example.sa/p', confidence: 0.5,
    }],
  }));
  f.onChat('assistant', () => [{ type: 'text', text: 'تم.' }]);
}
