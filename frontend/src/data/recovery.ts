/**
 * 渠道停用后的投产回收领域模型（纯函数，不碰 localStorage）。
 *
 * 生命周期严格单向：待回收 → 回收中 → 已提交 → 已归档，归档后没有回退入口。
 * 回收队列按活动结束日期、日预算、投放人群拆成「已结束 / 待暂停 / 仍在采集」三种结论；
 * 释放金额只计算尚未消耗的预算，草稿活动不进入队列。
 */

export const RECOVERY_PHASES = ['待回收', '回收中', '已提交', '已归档'] as const
export type RecoveryPhase = (typeof RECOVERY_PHASES)[number]

export const RECOVERY_OUTCOMES = ['已结束', '待暂停', '仍在采集'] as const
export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number]

export const RECOVERY_TARGET_STATUS: Record<RecoveryOutcome, string> = {
  已结束: '已结束',
  待暂停: '已暂停',
  仍在采集: '投放中',
}

export type RecoveryItem = {
  campaignId: number
  campaignNo: string
  campaignName: string
  startDate: string
  endDate: string
  dailyBudget: number
  audience: string
  planDays: number
  plannedBudget: number
  consumedBudget: number
  remainingBudget: number
  allocatedBudget: number
  boundaryDays: number
  outcome: RecoveryOutcome
  targetStatus: string
  admission: string
  releaseAmount: number
  reason: string
  processed: boolean
  processedAt: string | null
  repeatedAt: string | null
  basisId: string
}

export type RecoveryBasis = {
  id: string
  batchId: string
  campaignNo: string
  stage: '生成' | '处理' | '提交'
  at: string
  operator: string
  channelNo: string
  channelEffectiveAt: string
  sourceStatus: string
  endDate: string
  dailyBudget: number
  audience: string
  plannedBudget: number
  consumedBudget: number
  allocatedBudget: number
  boundaryDays: number
  outcome: RecoveryOutcome
  releaseAmount: number
  rule: string
}

export type RecoveryEvent = {
  at: string
  actor: string
  action: string
  detail: string
}

export type RecoveryBatch = {
  id: string
  channelId: number
  channelNo: string
  channelName: string
  version: number
  /** 渠道停用生效时刻：多人并发时以该时刻较早的版本为准。 */
  effectiveAt: string
  /** 被更早生效版本取代后停在归档终态；空串表示仍是有效版本。 */
  supersededBy: string
  phase: RecoveryPhase
  operator: string
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  archivedAt: string | null
  interruptedAt: string | null
  items: RecoveryItem[]
  basis: RecoveryBasis[]
  events: RecoveryEvent[]
  releasedAmount: number
  conclusion: string
}

export type RecoveryLedgerEntry = {
  id: string
  batchId: string
  version: number
  channelNo: string
  campaignNo: string
  amount: number
  at: string
  actor: string
  basisId: string
  note: string
}

export type RecoveryState = {
  batches: RecoveryBatch[]
  ledger: RecoveryLedgerEntry[]
  batchSeq: number
  ledgerSeq: number
}

export type ChannelProductionRow = {
  channelNo: string
  channelName: string
  channelStatus: string
  phase: RecoveryPhase | '未回收'
  version: number
  effectiveAt: string
  batchId: string
  linkedActive: number
  excludedDrafts: number
  endedCount: number
  pendingPauseCount: number
  collectingCount: number
  budgetPool: number
  allocatedBudget: number
  consumedBudget: number
  releasableBudget: number
  releasedAmount: number
  occupiedBudget: number
  unprocessedCount: number
  updatedAt: string
  conclusion: string
}

export type OrchestrationView = {
  productionRows: ChannelProductionRow[]
  batches: RecoveryBatch[]
  ledger: RecoveryLedgerEntry[]
  channels: { id: number; channelNo: string; channelName: string; status: string }[]
}

export function emptyRecoveryState(): RecoveryState {
  return { batches: [], ledger: [], batchSeq: 0, ledgerSeq: 0 }
}

/** 阶段只能沿生命周期向前走一步，不允许回退或跳级。 */
const NEXT_PHASE: Record<RecoveryPhase, RecoveryPhase[]> = {
  待回收: ['回收中'],
  回收中: ['已提交'],
  已提交: ['已归档'],
  已归档: [],
}

export function canAdvancePhase(from: RecoveryPhase, to: RecoveryPhase): boolean {
  return NEXT_PHASE[from].includes(to)
}

export function appendEvent(
  batch: RecoveryBatch,
  actor: string,
  action: string,
  detail: string,
  at: string,
): void {
  batch.events.push({ at, actor, action, detail })
  batch.updatedAt = at
}

const DAY_MS = 86400000

/** 用 UTC 天数编号比较日期，避免时区与夏令时把结束日期算偏。 */
export function dayNumber(date: string): number {
  const [year, month, day] = date.slice(0, 10).split('-').map((piece) => Number(piece))
  return Date.UTC(year, (month || 1) - 1, day || 1) / DAY_MS
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from)
}

export function inclusiveDays(start: string, end: string): number {
  return Math.max(0, daysBetween(start, end) + 1)
}

export function parseAmount(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }
  const parsed = Number(String(value ?? '').replace(/,/g, '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 待暂停边界（天）：按投放人群给不同缓冲，日预算越高越需要缓停。
 * 核心人群 10 天、高价值/复购 8 天、常规 7 天、测试/探索 5 天；日预算 ≥1000 再加 1 天，封顶 14 天。
 * 距结束日期不超过边界时进入待暂停，既不丢历史记录，又尽快释放未消耗额度。
 */
export function pauseBoundaryDays(audience: string, dailyBudget: number): number {
  let base = 7
  if (audience.includes('核心')) base = 10
  else if (audience.includes('高价值') || audience.includes('复购')) base = 8
  else if (audience.includes('测试') || audience.includes('探索')) base = 5
  if (dailyBudget >= 1000) base += 1
  return Math.min(base, 14)
}

export type CampaignEvaluation = {
  planDays: number
  plannedBudget: number
  consumedBudget: number
  remainingBudget: number
  allocatedBudget: number
  boundaryDays: number
  outcome: RecoveryOutcome
  targetStatus: string
  admission: string
  releaseAmount: number
  reason: string
}

/**
 * 单个活动的回收判定：
 * - 结束日期不晚于停用生效日：已结束，释放全部尚未消耗额度；
 * - 距结束日期不超过待暂停边界：待暂停，保留已完成记录，释放尚未消耗额度；
 * - 其余：仍在采集，活动状态不变、本轮不释放，只撤销新增准入。
 */
export function evaluateCampaign(input: {
  sourceStatus: string
  startDate: string
  endDate: string
  dailyBudget: number
  audience: string
  consumedBudget: number
  allocatedBudget: number
  effectiveDate: string
}): CampaignEvaluation {
  const dailyBudget = Math.max(0, input.dailyBudget)
  const planDays = inclusiveDays(input.startDate, input.endDate)
  const plannedBudget = roundAmount(dailyBudget * planDays)
  const consumedBudget = Math.min(plannedBudget, Math.max(0, roundAmount(input.consumedBudget)))
  const remainingBudget = Math.max(0, roundAmount(plannedBudget - consumedBudget))
  const allocatedBudget = Math.min(plannedBudget, Math.max(0, roundAmount(input.allocatedBudget)))
  const boundaryDays = pauseBoundaryDays(input.audience, dailyBudget)
  const effectiveDate = input.effectiveDate.slice(0, 10)
  const daysToEnd = daysBetween(effectiveDate, input.endDate)
  const unspentAllocated = Math.max(0, roundAmount(allocatedBudget - consumedBudget))

  if (input.endDate <= effectiveDate) {
    return {
      planDays,
      plannedBudget,
      consumedBudget,
      remainingBudget,
      allocatedBudget,
      boundaryDays,
      outcome: '已结束',
      targetStatus: RECOVERY_TARGET_STATUS.已结束,
      admission: '停止准入：活动已到结束日期',
      releaseAmount: unspentAllocated,
      reason: `结束日期 ${input.endDate} 不晚于停用生效日 ${effectiveDate}，判为已结束；释放尚未消耗的 ${unspentAllocated}`,
    }
  }

  if (daysToEnd <= boundaryDays) {
    return {
      planDays,
      plannedBudget,
      consumedBudget,
      remainingBudget,
      allocatedBudget,
      boundaryDays,
      outcome: '待暂停',
      targetStatus: RECOVERY_TARGET_STATUS.待暂停,
      admission: '暂停准入：保留已完成记录，停止新增投放',
      releaseAmount: unspentAllocated,
      reason: `距结束 ${daysToEnd} 天 ≤ ${input.audience || '常规人群'}边界 ${boundaryDays} 天，判为待暂停；保留历史记录并释放尚未消耗的 ${unspentAllocated}`,
    }
  }

  return {
    planDays,
    plannedBudget,
    consumedBudget,
    remainingBudget,
    allocatedBudget,
    boundaryDays,
    outcome: '仍在采集',
    targetStatus: input.sourceStatus,
    admission: '限制准入：撤销渠道新增准入，存量数据继续采集',
    releaseAmount: 0,
    reason: `距结束 ${daysToEnd} 天 > 边界 ${boundaryDays} 天，仍在采集；本轮不释放预算`,
  }
}

/**
 * 额度分配：按结束日期升序从渠道预算池配额，先结束的先占用；同一天按活动编号排序。
 * 返回每个活动分到的额度，供释放金额计算使用。
 */
export function allocateBudget(
  campaigns: { campaignNo: string; endDate: string; plannedBudget: number }[],
  pool: number,
): Map<string, number> {
  const allocations = new Map<string, number>()
  const sorted = [...campaigns].sort((left, right) => {
    const byDate = left.endDate.localeCompare(right.endDate)
    return byDate !== 0 ? byDate : left.campaignNo.localeCompare(right.campaignNo)
  })
  let remainingPool = Math.max(0, pool)
  for (const campaign of sorted) {
    const allocated = roundAmount(Math.min(campaign.plannedBudget, remainingPool))
    allocations.set(campaign.campaignNo, allocated)
    remainingPool = Math.max(0, roundAmount(remainingPool - allocated))
  }
  return allocations
}

function roundAmount(value: number): number {
  return Math.round(value * 100) / 100
}
