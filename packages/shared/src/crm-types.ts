import type { StageCategory } from './crm';

export interface TrackDto { id: string; key: string; name: string; description: string | null }
export interface StageDto { id: string; key: string; name: string; position: number; category: StageCategory; winProbability: number | null }
export interface PipelineDto { id: string; name: string; trackId: string | null; isDefault: boolean; stages: StageDto[] }
export interface OutcomeReasonDto { id: string; kind: 'win' | 'loss' | 'postpone' | 'disqualify'; label: string; isActive: boolean }
export interface CustomFieldDto {
  id: string; entity: 'account' | 'contact' | 'opportunity'; key: string; label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'boolean'; options: string[] | null; trackId: string | null;
}
export interface CrmSettingsDto { tracks: TrackDto[]; pipelines: PipelineDto[]; reasons: OutcomeReasonDto[]; customFields: CustomFieldDto[] }

export interface AccountDto {
  id: string; name: string; legalName: string | null; crNumber: string | null; vatNumber: string | null;
  websiteDomain: string | null; phone: string | null; industry: string | null; sizeBand: string | null;
  region: string | null; city: string | null; address: string | null; lat: number | null; lng: number | null;
  trackId: string | null; territoryId: string | null; ownerMembershipId: string | null; ownerName: string | null;
  status: string; disqualifyReason: string | null; leadSource: string; leadSourceDetail: string | null;
  customFields: Record<string, unknown>; lastActivityAt: string | null; createdAt: string;
  openOpportunities?: number;
}
export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }

export interface ContactDto {
  id: string; accountId: string; fullName: string; jobTitle: string | null; phone: string | null; email: string | null;
  preferredChannel: string | null; isPrimary: boolean; doNotContact: boolean; dncReason: string | null; dncAt: string | null;
  customFields: Record<string, unknown>; createdAt: string;
}

export interface OpportunityDto {
  id: string; accountId: string; accountName: string; title: string; pipelineId: string; stageId: string;
  stageCategory: StageCategory; ownerMembershipId: string | null; ownerName: string | null; amount: number | null;
  currency: string; expectedCloseDate: string | null; outcomeReasonId: string | null; outcomeNote: string | null;
  closedAt: string | null; customFields: Record<string, unknown>; createdAt: string; updatedAt: string;
}
export interface StageHistoryDto {
  id: number; fromStageId: string | null; toStageId: string; changedByType: string; changedByName: string | null;
  evidence: unknown; changedAt: string;
}

export interface TaskDto {
  id: string; title: string; description: string | null; type: string; priority: 'low' | 'normal' | 'high';
  dueAt: string | null; assigneeMembershipId: string | null; assigneeName: string | null;
  accountId: string | null; accountName: string | null; opportunityId: string | null; visitId: string | null;
  status: 'open' | 'done' | 'cancelled'; completedAt: string | null; createdByType: string; createdAt: string;
}
export interface NoteDto { id: string; body: string; authorName: string; authorUserId: string; createdAt: string }
export interface ActivityDto {
  id: number; type: string; actorType: string; actorName: string | null; summary: string | null;
  refType: string | null; refId: string | null; opportunityId: string | null; occurredAt: string;
}

export interface VisitDto {
  id: string; accountId: string; accountName: string; accountCity: string | null; opportunityId: string | null;
  repMembershipId: string; repName: string | null; purpose: string | null;
  scheduledStart: string; scheduledEnd: string | null;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  checkInAt: string | null; checkOutAt: string | null; checkInLat: number | null; checkInLng: number | null;
  outcome: string | null; interestLevel: number | null; nextStep: string | null; nextFollowUpAt: string | null;
  notes: string | null; followUpTaskId: string | null; createdAt: string;
}

export interface ImportJobDto {
  id: string; entity: 'account'; filename: string; status: string; headers: string[];
  suggestedMapping: Record<string, string>; mapping: Record<string, string> | null;
  stats: { rows?: number; valid?: number; invalid?: number; duplicates?: number; warnings?: number; created?: number; merged?: number; skipped?: number };
  createdAt: string; completedAt: string | null;
}
export interface ImportRowDto {
  id: number; rowNumber: number; raw: Record<string, string>; normalized: Record<string, unknown> | null;
  errors: { field: string; code: string }[] | null; duplicateOfId: string | null; duplicateOfName: string | null;
  duplicateReason: string | null; resolution: 'create' | 'merge' | 'skip' | null; resultEntityId: string | null;
}

export interface DashboardDto {
  period: { from: string; to: string };
  totals: {
    accounts: number; newAccounts: number; qualified: number; visitsScheduled: number; visitsCompleted: number;
    visitsCancelled: number; proposalsSent: number; openOpportunities: number; won: number; lost: number;
    pipelineValue: number; wonValue: number; winRate: number | null; overdueTasks: number;
    visitCompletionRate: number | null; followUpCompletionRate: number | null;
  };
  byRep: { membershipId: string; name: string; visitsCompleted: number; tasksDone: number; won: number; openValue: number }[];
  lossReasons: { label: string; count: number }[];
  stageFunnel: { stageId: string; name: string; count: number; value: number }[];
}
