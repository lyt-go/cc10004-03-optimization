import {
  allocateBudget,
  appendEvent,
  canAdvancePhase,
  evaluateCampaign,
  inclusiveDays,
  parseAmount,
  type ChannelProductionRow,
  type OrchestrationView,
  type RecoveryBatch,
  type RecoveryBasis,
  type RecoveryItem,
  type RecoveryLedgerEntry,
  type RecoveryOutcome,
  type RecoveryState,
} from '@/data/recovery'
import { MODULE_BY_KEY } from '@/data/modules'
import {
  commitTransaction,
  listRows,
  readRecoveryState,
  resetRows,
  saveRecoveryState,
} from '@/data/local-store'
import type { ActionResult, EntryRow, PageResult } from '@/data/types'

/**
 * 渠道投产编排服务。
 *
 * 业务入口：渠道停用 → 生成待回收活动 → 逐条处理 → 原子提交（结束活动 + 释放预算）
 * → 归档。阶段只允许沿生命周期向前；归档后不再提供任何回退入口。
 */

// 只有仍在投放中的活动进入回收队列；草稿、审批中、已暂停、已结束都不进入。
const RECOVERABLE_STATUS = '投放中'

export type GenerateOptions = {
  operator?: string
  /** 停用生效时刻；多人并发时以较早时刻的版本为准。 */
  effectiveAt?: string
  /** 渠道尚未停用时，是否由本次操作一并停用。 */
  disableIfNeeded?: boolean
}

export type RecoveryOperationResult = ActionResult & { batch?: RecoveryBatch }

function nowIso(): string {
  return new Date().toISOString()
}

function campaignNo(row: EntryRow): string {
  return String(row['活动编号'] ?? '')
}

function channelNo(row: EntryRow): string {
  return String(row['渠道编号'] ?? '')
}

function linkedCampaigns(channel: EntryRow, campaigns: EntryRow[]): EntryRow[] {
  const no = channelNo(channel)
  const name = String(channel['渠道名称'] ?? '')
  return campaigns.filter((row) => {
    const linked = String(row['关联渠道'] ?? '').trim()
    return linked !== '' && (linked === no || linked === name)
  })
}

function isDraft(row: EntryRow): boolean {
  return String(row.status) === '草稿'
}

function isRecoverable(row: EntryRow): boolean {
  return String(row.status) === RECOVERABLE_STATUS
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** 同一渠道里没有被更早生效版本取代的批次。 */
function effectiveBatches(state: RecoveryState, channelNoValue: string): RecoveryBatch[] {
  return state.batches.filter(
    (batch) => batch.channelNo === channelNoValue && !batch.supersededBy,
  )
}

/** 仍在回收流程中的批次：只有这些批次会被并发版本取代。 */
function liveBatches(state: RecoveryState, channelNoValue: string): RecoveryBatch[] {
  return effectiveBatches(state, channelNoValue).filter(
    (batch) => batch.phase === '待回收' || batch.phase === '回收中',
  )
}

/** 投产清单展示用的批次：优先展示仍在流程中的，其次最近创建的。 */
function displayBatch(state: RecoveryState, channelNoValue: string): RecoveryBatch | undefined {
  const batches = effectiveBatches(state, channelNoValue)
  if (batches.length === 0) return undefined
  const live = batches.filter((batch) => batch.phase === '待回收' || batch.phase === '回收中')
  const pool = live.length > 0 ? live : batches
  return [...pool].sort((left, right) => {
    const byTime = right.createdAt.localeCompare(left.createdAt)
    return byTime !== 0 ? byTime : right.version - left.version
  })[0]
}

/** 已经被有效批次纳入过回收队列的活动，避免同一活动被回收两次。 */
function coveredCampaigns(state: RecoveryState, channelNoValue: string): Set<string> {
  const covered = new Set<string>()
  for (const batch of effectiveBatches(state, channelNoValue)) {
    for (const item of batch.items) covered.add(item.campaignNo)
  }
  return covered
}

function ledgerNetForChannel(state: RecoveryState, channelNoValue: string): number {
  return round(
    state.ledger
      .filter((entry) => entry.channelNo === channelNoValue)
      .reduce((sum, entry) => sum + entry.amount, 0),
  )
}

/**
 * 额度分配池 = 渠道投放预算 − 已经释放的额度。
 * 已消耗预算只抵扣单个活动自身的计划额度，不从池里再扣一次，避免重复占用。
 */
function availablePool(state: RecoveryState, channel: EntryRow): number {
  const configured = parseAmount(channel['投放预算'])
  const released = ledgerNetForChannel(state, channelNo(channel))
  return Math.max(0, round(configured - released))
}

type PlannedCampaign = {
  row: EntryRow
  campaignNo: string
  endDate: string
  plannedBudget: number
}

function buildBatch(
  state: RecoveryState,
  channel: EntryRow,
  campaignRows: EntryRow[],
  effectiveAt: string,
  operator: string,
  at: string,
): RecoveryBatch | null {
  const linked = linkedCampaigns(channel, campaignRows)
  const covered = coveredCampaigns(state, channelNo(channel))
  const recoverable = linked.filter((row) => isRecoverable(row) && !covered.has(campaignNo(row)))
  if (recoverable.length === 0) return null

  const planned: PlannedCampaign[] = recoverable.map((row) => ({
    row,
    campaignNo: campaignNo(row),
    endDate: String(row['结束日期'] ?? ''),
    plannedBudget: round(
      parseAmount(row['日预算']) *
        inclusiveDays(String(row['开始日期'] ?? ''), String(row['结束日期'] ?? '')),
    ),
  }))
  // 额度分配：只从渠道剩余可用预算池里配额，按结束日期先到先得。
  const pool = availablePool(state, channel)
  const allocations = allocateBudget(
    planned.map((entry) => ({
      campaignNo: entry.campaignNo,
      endDate: entry.endDate,
      plannedBudget: entry.plannedBudget,
    })),
    pool,
  )

  const batchId = `RCV-${channelNo(channel)}-${String(state.batchSeq + 1).padStart(3, '0')}`
  const version = state.batches.filter((batch) => batch.channelNo === channelNo(channel)).length + 1
  const items: RecoveryItem[] = []
  const basis: RecoveryBasis[] = []

  for (const entry of planned) {
    const row = entry.row
    const no = entry.campaignNo
    const evaluation = evaluateCampaign({
      sourceStatus: String(row.status),
      startDate: String(row['开始日期'] ?? ''),
      endDate: entry.endDate,
      dailyBudget: parseAmount(row['日预算']),
      audience: String(row['投放人群'] ?? ''),
      consumedBudget: parseAmount(row['已消耗预算']),
      allocatedBudget: allocations.get(no) ?? 0,
      effectiveDate: effectiveAt.slice(0, 10),
    })
    const basisId = `${batchId}-${no}-g${basis.length + 1}`
    items.push({
      campaignId: Number(row.id),
      campaignNo: no,
      campaignName: String(row['活动名称'] ?? ''),
      startDate: String(row['开始日期'] ?? ''),
      endDate: entry.endDate,
      dailyBudget: parseAmount(row['日预算']),
      audience: String(row['投放人群'] ?? ''),
      planDays: evaluation.planDays,
      plannedBudget: evaluation.plannedBudget,
      consumedBudget: evaluation.consumedBudget,
      remainingBudget: evaluation.remainingBudget,
      allocatedBudget: evaluation.allocatedBudget,
      boundaryDays: evaluation.boundaryDays,
      outcome: evaluation.outcome,
      targetStatus: evaluation.targetStatus,
      admission: evaluation.admission,
      releaseAmount: evaluation.releaseAmount,
      reason: evaluation.reason,
      processed: false,
      processedAt: null,
      repeatedAt: null,
      basisId,
    })
    basis.push({
      id: basisId,
      batchId,
      campaignNo: no,
      stage: '生成',
      at,
      operator,
      channelNo: channelNo(channel),
      channelEffectiveAt: effectiveAt,
      sourceStatus: String(row.status),
      endDate: entry.endDate,
      dailyBudget: parseAmount(row['日预算']),
      audience: String(row['投放人群'] ?? ''),
      plannedBudget: evaluation.plannedBudget,
      consumedBudget: evaluation.consumedBudget,
      allocatedBudget: evaluation.allocatedBudget,
      boundaryDays: evaluation.boundaryDays,
      outcome: evaluation.outcome,
      releaseAmount: evaluation.releaseAmount,
      rule: evaluation.reason,
    })
  }

  const count = (outcome: RecoveryOutcome) =>
    items.filter((item) => item.outcome === outcome).length
  const batch: RecoveryBatch = {
    id: batchId,
    channelId: Number(channel.id),
    channelNo: channelNo(channel),
    channelName: String(channel['渠道名称'] ?? ''),
    version,
    effectiveAt,
    supersededBy: '',
    phase: '待回收',
    operator,
    createdAt: at,
    updatedAt: at,
    submittedAt: null,
    archivedAt: null,
    interruptedAt: null,
    items,
    basis,
    events: [],
    releasedAmount: 0,
    conclusion: `待回收：已结束 ${count('已结束')}、待暂停 ${count('待暂停')}、仍在采集 ${count('仍在采集')}`,
  }
  appendEvent(
    batch,
    operator,
    '生成回收批次',
    `按结束日期生成 ${items.length} 个待回收活动；可用预算池 ${pool}，本批分配 ${round(
      items.reduce((sum, item) => sum + item.allocatedBudget, 0),
    )}；草稿活动不进入回收`,
    at,
  )
  return batch
}

/**
 * 停用渠道并生成回收批次（渠道已停用时复用停用生效时间）。
 *
 * 并发规则：
 * - 已有更早生效的版本，且仍在待回收/回收中：直接返回该版本的结论，不重复回收；
 * - 本次带来更早的生效时刻：晚版本停在归档终态，由更早版本接管；
 * - 已有已提交/已归档版本：不再重复回收，只对尚未纳入队列的投放中活动续生成后续批次。
 */
export function disableAndGenerate(
  channelId: number,
  options: GenerateOptions = {},
): RecoveryOperationResult {
  const operator = options.operator?.trim() || '值班管理员'
  const channelRows = listRows('channel')
  const channelIndex = channelRows.findIndex((row) => Number(row.id) === channelId)
  if (channelIndex < 0) {
    return { ok: false, message: `没有找到编号为 ${channelId} 的渠道配置` }
  }
  const channel = channelRows[channelIndex]
  const no = channelNo(channel)
  const state = readRecoveryState()
  const at = nowIso()

  if (String(channel.status) !== '已停用') {
    if (!options.disableIfNeeded) {
      return { ok: false, message: `渠道 ${no} 当前状态「${channel.status}」，请先停用渠道再生成回收队列` }
    }
    if (String(channel.status) !== '已启用') {
      return { ok: false, message: `渠道 ${no} 当前状态「${channel.status}」，只有已启用渠道可以停用` }
    }
  }

  const registeredEffectiveAt = String(channel['停用生效时间'] ?? '')
  // 显式传入的生效时刻代表操作人看到的停用版本；未传时以渠道登记时间为准。
  const effectiveAt =
    options.effectiveAt?.trim() ||
    (String(channel.status) === '已停用' && registeredEffectiveAt ? registeredEffectiveAt : at)

  const live = liveBatches(state, no)
  // 已经有提交/归档版本的渠道：预算释放与活动结束都已生效。
  // 若没有后续新增的投放中活动，后到操作只看到已处理结论；有新活动才允许续生成下一批。
  const settled = effectiveBatches(state, no).filter(
    (batch) => batch.phase === '已提交' || batch.phase === '已归档',
  )
  if (live.length === 0 && settled.length > 0) {
    const cover = coveredCampaigns(state, no)
    const uncovered = linkedCampaigns(channel, listRows('campaign')).filter(
      (row) => isRecoverable(row) && !cover.has(campaignNo(row)),
    )
    if (uncovered.length === 0) {
      const latest = [...settled].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )[0]
      return {
        ok: false,
        batch: latest,
        message:
          `渠道 ${no} 已有${latest.phase}的回收版本 ${latest.id}（生效 ${latest.effectiveAt}）：` +
          `${latest.conclusion}。预算释放已生效，本次操作不重复回收`,
      }
    }
  }
  if (live.length > 0) {
    const earliest = [...live].sort((left, right) => {
      const byTime = left.effectiveAt.localeCompare(right.effectiveAt)
      return byTime !== 0 ? byTime : left.version - right.version
    })[0]
    if (earliest.effectiveAt <= effectiveAt) {
      return {
        ok: false,
        batch: earliest,
        message:
          `渠道 ${no} 已有更早生效的停用版本 ${earliest.id}（生效 ${earliest.effectiveAt}，当前${earliest.phase}）：` +
          `${earliest.conclusion}。本次操作以该版本为准，不再重复回收`,
      }
    }
    // 本次生效时刻更早：晚版本归档，由本次接管。
    for (const batch of live) {
      batch.supersededBy = `${no}-next`
      batch.phase = '已归档'
      batch.archivedAt = at
      batch.conclusion = `已归档：停用生效 ${batch.effectiveAt} 晚于 ${effectiveAt}，版本被取代`
      appendEvent(
        batch,
        operator,
        '版本被更早版本取代',
        `生效 ${batch.effectiveAt} 晚于 ${effectiveAt}，停止回收并归档，由更早版本接管`,
        at,
      )
    }
  }

  const batch = buildBatch(state, channel, listRows('campaign'), effectiveAt, operator, at)
  if (!batch) {
    // 没有新的可回收活动：返回已有批次的已处理结论，而不是让后到操作误以为需要重做。
    const settled = displayBatch(state, no)
    const cover = coveredCampaigns(state, no)
    const remaining = linkedCampaigns(channel, listRows('campaign')).filter(
      (row) => isRecoverable(row) && !cover.has(campaignNo(row)),
    )
    if (settled) {
      return {
        ok: false,
        batch: settled,
        message:
          `渠道 ${no} 已有回收版本 ${settled.id}（生效 ${settled.effectiveAt}，当前${settled.phase}）：` +
          `${settled.conclusion}。没有新的待回收活动，本次操作不重复回收`,
      }
    }
    if (remaining.length === 0) {
      return {
        ok: false,
        message: `渠道 ${no} 下没有仍在投放中的活动可回收（草稿与审批中活动不参与回收）`,
      }
    }
    return { ok: false, message: `渠道 ${no} 没有可生成回收队列的活动` }
  }

  // 让更早版本取代占位标记指向真实批次。
  for (const entry of state.batches) {
    if (entry.supersededBy === `${no}-next`) {
      entry.supersededBy = batch.id
      appendEvent(entry, '系统', '接管批次确认', `由 ${batch.id} 接管渠道回收`, at)
    }
  }

  state.batchSeq += 1
  state.batches.push(batch)
  channelRows[channelIndex] = {
    ...channel,
    status: '已停用',
    pending: true,
    abnormal: false,
    '停用生效时间': effectiveAt,
    '回收批次': batch.id,
    '可释放预算': 0,
    '已释放金额': ledgerNetForChannel(state, no),
  }
  // 渠道停用与回收批次同一次写入，避免出现「已停用但没有回收队列」的中间态。
  commitTransaction({ channel: channelRows }, state)

  return {
    ok: true,
    message: `已生成回收批次 ${batch.id}（v${batch.version}，生效 ${effectiveAt}），待回收 ${batch.items.length} 个活动`,
    batch,
  }
}

/** 渠道管理页的停用动作：停用生效时刻取操作时刻。 */
export function disableChannel(
  channelId: number,
  operator = '值班管理员',
  effectiveAt?: string,
): RecoveryOperationResult {
  return disableAndGenerate(channelId, { operator, effectiveAt, disableIfNeeded: true })
}

/** 渠道投产编排页重新生成：渠道必须已停用。 */
export function generateRecoveryBatch(
  channelId: number,
  options: GenerateOptions = {},
): RecoveryOperationResult {
  return disableAndGenerate(channelId, { ...options, disableIfNeeded: false })
}

function findBatch(state: RecoveryState, batchId: string): RecoveryBatch | undefined {
  return state.batches.find((batch) => batch.id === batchId)
}

type BatchAction = 'start' | 'process' | 'interrupt' | 'resume' | 'submit' | 'archive'

function guardBatch(batch: RecoveryBatch, action: BatchAction): ActionResult | null {
  if (batch.supersededBy) {
    return {
      ok: false,
      message: `批次 ${batch.id} 已被更早生效版本 ${batch.supersededBy} 取代，只能查看已归档结论`,
    }
  }
  if (batch.phase === '已归档') {
    return { ok: false, message: `批次 ${batch.id} 已归档，归档后不可恢复，也不允许回到旧状态` }
  }
  if (action !== 'start' && action !== 'archive' && batch.phase === '待回收') {
    return { ok: false, message: `批次 ${batch.id} 尚未进入回收中，请先开始回收` }
  }
  if (batch.phase === '已提交' && action !== 'archive') {
    return { ok: false, message: `批次 ${batch.id} 已提交，后到操作只展示已处理结论，不再重复回收` }
  }
  return null
}

export function startRecovery(batchId: string, operator = '值班管理员'): ActionResult {
  const state = readRecoveryState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到回收批次 ${batchId}` }
  const blocked = guardBatch(batch, 'start')
  if (blocked) return blocked
  if (!canAdvancePhase(batch.phase, '回收中')) {
    return { ok: false, message: `批次 ${batchId} 处于「${batch.phase}」，阶段只能按生命周期单向流转` }
  }
  const remaining = batch.items.filter((item) => !item.processed).length
  batch.phase = '回收中'
  batch.conclusion = `回收中：待处理 ${remaining} 项`
  appendEvent(batch, operator, '开始回收', '进入回收中，可按断点继续处理未完成活动', nowIso())
  saveRecoveryState(state)
  return { ok: true, message: `批次 ${batchId} 已进入回收中，${remaining} 个活动待处理` }
}

/** 中断后继续：阶段仍是回收中，只清掉中断标记，已完成项与回收依据全部保留。 */
export function resumeRecovery(batchId: string, operator = '值班管理员'): ActionResult {
  const state = readRecoveryState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到回收批次 ${batchId}` }
  const blocked = guardBatch(batch, 'resume')
  if (blocked) return blocked
  if (batch.phase !== '回收中' || !batch.interruptedAt) {
    return { ok: false, message: `批次 ${batchId} 当前没有可继续的中断记录` }
  }
  const remaining = batch.items.filter((item) => !item.processed)
  batch.interruptedAt = null
  batch.conclusion = `回收中：从断点继续，剩余 ${remaining.length} 项`
  appendEvent(
    batch,
    operator,
    '继续回收',
    remaining.length > 0
      ? `从未完成活动继续：${remaining.map((item) => item.campaignNo).join('、')}`
      : '所有活动已处理，可直接提交',
    nowIso(),
  )
  saveRecoveryState(state)
  return { ok: true, message: `批次 ${batchId} 已继续回收，剩余 ${remaining.length} 项` }
}

export function processRecoveryItem(
  batchId: string,
  campaignNoValue: string,
  operator = '值班管理员',
): RecoveryOperationResult & { item?: RecoveryItem } {
  const state = readRecoveryState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到回收批次 ${batchId}` }
  const blocked = guardBatch(batch, 'process')
  if (blocked) return blocked
  if (batch.phase !== '回收中') {
    return { ok: false, message: `批次 ${batchId} 当前为「${batch.phase}」，只能处理回收中的活动` }
  }
  if (batch.interruptedAt) {
    return { ok: false, message: `批次 ${batchId} 已中断，请先「继续回收」再从断点处理` }
  }
  const item = batch.items.find((entry) => entry.campaignNo === campaignNoValue)
  if (!item) return { ok: false, message: `批次 ${batchId} 中没有活动 ${campaignNoValue}` }

  const at = nowIso()
  if (item.processed) {
    item.repeatedAt = at
    appendEvent(batch, operator, '重复处理', `${campaignNoValue} 已处理：${item.outcome}，展示已处理结论`, at)
    saveRecoveryState(state)
    return {
      ok: true,
      message: `活动 ${campaignNoValue} 已处理：${item.outcome}，后到操作直接展示该结论，不再重复回收`,
      item,
    }
  }

  item.processed = true
  item.processedAt = at
  batch.conclusion = `回收中：已处理 ${batch.items.filter((entry) => entry.processed).length}/${batch.items.length}`
  const base = batch.basis.find((entry) => entry.id === item.basisId)
  if (base) {
    batch.basis.push({
      ...base,
      id: `${batch.id}-${campaignNoValue}-p${batch.basis.length + 1}`,
      stage: '处理',
      at,
      operator,
      rule: `${base.rule}；处理结论 ${item.outcome}，计划释放 ${item.releaseAmount}`,
    })
  }
  appendEvent(
    batch,
    operator,
    '处理活动',
    `${campaignNoValue} 判定 ${item.outcome}，计划释放 ${item.releaseAmount}；准入：${item.admission}`,
    at,
  )
  saveRecoveryState(state)
  return {
    ok: true,
    message: `活动 ${campaignNoValue} 已判定为${item.outcome}，计划释放 ${item.releaseAmount}`,
    item,
  }
}

/** 一键处理剩余活动；每条仍然单独落回收依据。 */
export function processAllRemaining(batchId: string, operator = '值班管理员'): ActionResult {
  const state = readRecoveryState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到回收批次 ${batchId}` }
  if (batch.phase !== '回收中' || batch.interruptedAt) {
    return { ok: false, message: `批次 ${batchId} 当前不能批量处理，请先进入回收中并继续回收` }
  }
  const pending = batch.items.filter((item) => !item.processed).map((item) => item.campaignNo)
  let processed = 0
  for (const no of pending) {
    const result = processRecoveryItem(batchId, no, operator)
    if (!result.ok) return result
    processed += 1
  }
  return { ok: true, message: `批次 ${batchId} 已处理 ${processed} 个未完成活动` }
}

export function interruptRecovery(batchId: string, operator = '值班管理员'): ActionResult {
  const state = readRecoveryState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到回收批次 ${batchId}` }
  const blocked = guardBatch(batch, 'interrupt')
  if (blocked) return blocked
  if (batch.phase !== '回收中') {
    return { ok: false, message: `批次 ${batchId} 当前为「${batch.phase}」，只有回收中可以中断` }
  }
  if (batch.interruptedAt) {
    return { ok: false, message: `批次 ${batchId} 已处于中断中，直接继续回收即可` }
  }
  const remaining = batch.items.filter((item) => !item.processed).length
  batch.interruptedAt = nowIso()
  batch.conclusion = `回收中断：剩余 ${remaining} 项，可从断点继续`
  appendEvent(batch, operator, '中断回收', `保留已完成项与回收依据，剩余 ${remaining} 项待继续`, batch.interruptedAt)
  saveRecoveryState(state)
  return { ok: true, message: `批次 ${batchId} 已中断，剩余 ${remaining} 项可从断点继续` }
}

/**
 * 回收提交：活动状态变更、渠道占用退出、释放台账和回收依据在同一次 localStorage 写入里同时成立。
 * 只允许从回收中提交，且必须所有活动均已处理。
 */
export function submitRecovery(batchId: string, operator = '值班管理员'): ActionResult {
  const state = readRecoveryState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到回收批次 ${batchId}` }
  const blocked = guardBatch(batch, 'submit')
  if (blocked) return blocked
  if (batch.phase !== '回收中') {
    return { ok: false, message: `批次 ${batchId} 处于「${batch.phase}」，提交只能从回收中发起` }
  }
  if (batch.interruptedAt) {
    return { ok: false, message: `批次 ${batchId} 已中断，请先继续回收再提交` }
  }
  const unfinished = batch.items.filter((item) => !item.processed)
  if (unfinished.length > 0) {
    return {
      ok: false,
      message: `批次 ${batchId} 还有 ${unfinished.length} 个活动未处理（${unfinished
        .map((item) => item.campaignNo)
        .join('、')}），不能提交`,
    }
  }

  const at = nowIso()
  const nextCampaignRows = [...listRows('campaign')]
  const ledger: RecoveryLedgerEntry[] = []

  for (const item of batch.items) {
    const index = nextCampaignRows.findIndex((row) => Number(row.id) === item.campaignId)
    if (index < 0) continue
    const row = nextCampaignRows[index]
    const shared = {
      '准入结论': item.admission,
      '回收结论': item.outcome,
      '最近回收批次': batch.id,
    }
    if (item.outcome === '仍在采集') {
      // 仍在采集：不改活动状态，只同步准入结论，存量记录继续保留。
      nextCampaignRows[index] = { ...row, ...shared }
      continue
    }
    nextCampaignRows[index] = {
      ...row,
      ...shared,
      status: item.targetStatus,
      pending: false,
      abnormal: false,
      '回收来源': `${batch.id} / ${batch.channelNo}`,
      '释放金额': item.releaseAmount,
    }
    if (item.releaseAmount > 0) {
      state.ledgerSeq += 1
      ledger.push({
        id: `LED-${String(state.ledgerSeq).padStart(3, '0')}`,
        batchId: batch.id,
        version: batch.version,
        channelNo: batch.channelNo,
        campaignNo: item.campaignNo,
        amount: item.releaseAmount,
        at,
        actor: operator,
        basisId: `${batch.id}-${item.campaignNo}-c${state.ledgerSeq}`,
        note: `${item.outcome}，释放尚未消耗预算`,
      })
    }
    const base = batch.basis.find((entry) => entry.id === item.basisId)
    if (base) {
      batch.basis.push({
        ...base,
        id: `${batch.id}-${item.campaignNo}-s${batch.basis.length + 1}`,
        stage: '提交',
        at,
        operator,
        releaseAmount: item.releaseAmount,
        rule: `${base.rule}；提交回收，活动状态 ${item.targetStatus}，释放 ${item.releaseAmount}`,
      })
    }
  }

  const channelRows = listRows('channel')
  const channelIndex = channelRows.findIndex((row) => Number(row.id) === batch.channelId)
  const totalReleased = round(ledger.reduce((sum, entry) => sum + entry.amount, 0))
  if (channelIndex >= 0) {
    const channelRow = channelRows[channelIndex]
    const stillCollecting = batch.items.filter((item) => item.outcome === '仍在采集').length
    const remainingActive = linkedCampaigns(channelRow, nextCampaignRows).filter(isRecoverable).length
    channelRows[channelIndex] = {
      ...channelRow,
      status: '已停用',
      pending: stillCollecting > 0 || remainingActive > 0,
      abnormal: false,
      '回收批次': batch.id,
      '可释放预算': round(
        batch.items.reduce((sum, item) => sum + item.allocatedBudget - item.consumedBudget, 0) -
          totalReleased,
      ),
      '已释放金额': round(ledgerNetForChannel(state, batch.channelNo) + totalReleased),
    }
  }

  const count = (outcome: RecoveryOutcome) =>
    batch.items.filter((item) => item.outcome === outcome).length
  batch.releasedAmount = totalReleased
  batch.phase = '已提交'
  batch.submittedAt = at
  batch.conclusion =
    `已提交：已结束 ${count('已结束')}、待暂停 ${count('待暂停')}、仍在采集 ${count('仍在采集')}；` +
    `释放预算 ${totalReleased}`
  appendEvent(
    batch,
    operator,
    '提交回收',
    `活动结束/暂停与预算释放原子提交，台账 ${ledger.length} 条，释放 ${totalReleased}`,
    at,
  )
  state.ledger.push(...ledger)

  // 单次写入：投放活动、渠道配置、回收批次与释放台账一起落盘。
  commitTransaction({ campaign: nextCampaignRows, channel: channelRows }, state)

  return {
    ok: true,
    message:
      `批次 ${batchId} 已提交：已结束 ${count('已结束')}、待暂停 ${count('待暂停')}、仍在采集 ${count('仍在采集')}，` +
      `释放预算 ${totalReleased}`,
  }
}

export function archiveRecovery(batchId: string, operator = '值班管理员'): ActionResult {
  const state = readRecoveryState()
  const batch = findBatch(state, batchId)
  if (!batch) return { ok: false, message: `没有找到回收批次 ${batchId}` }
  const blocked = guardBatch(batch, 'archive')
  if (blocked) return blocked
  if (!canAdvancePhase(batch.phase, '已归档')) {
    return { ok: false, message: `批次 ${batchId} 处于「${batch.phase}」，归档只能从已提交发起` }
  }
  batch.phase = '已归档'
  batch.archivedAt = nowIso()
  batch.conclusion = `${batch.conclusion}（已归档，不可恢复）`
  appendEvent(batch, operator, '归档回收', '批次进入归档终态，不提供恢复或回到旧状态的操作', batch.archivedAt)
  saveRecoveryState(state)
  return { ok: true, message: `批次 ${batchId} 已归档，归档后不可恢复` }
}

function productionRowFor(
  channel: EntryRow,
  campaigns: EntryRow[],
  state: RecoveryState,
  batch: RecoveryBatch | undefined,
): ChannelProductionRow {
  const linked = linkedCampaigns(channel, campaigns)
  const drafts = linked.filter(isDraft)
  const eligible = linked.filter(isRecoverable)
  const pool = parseAmount(channel['投放预算'])
  const consumed = linked.filter((row) => !isDraft(row)).reduce((sum, row) => sum + parseAmount(row['已消耗预算']), 0)
  const items = batch?.items ?? []
  const allocated =
    items.length > 0
      ? round(items.reduce((sum, item) => sum + item.allocatedBudget, 0))
      : round(
          [...allocateBudget(
            eligible.map((row) => ({
              campaignNo: campaignNo(row),
              endDate: String(row['结束日期'] ?? ''),
              plannedBudget:
                parseAmount(row['日预算']) *
                inclusiveDays(String(row['开始日期'] ?? ''), String(row['结束日期'] ?? '')),
            })),
            pool,
          ).values()].reduce((sum, value) => sum + value, 0),
        )
  const batchConsumed =
    items.length > 0 ? round(items.reduce((sum, item) => sum + item.consumedBudget, 0)) : round(consumed)
  const releasable = Math.max(0, round(allocated - batchConsumed))
  const released = ledgerNetForChannel(state, channelNo(channel))
  const occupied = Math.max(0, round(releasable - released))
  const unprocessed = items.filter((item) => !item.processed).length
  const count = (outcome: RecoveryOutcome) => items.filter((item) => item.outcome === outcome).length

  return {
    channelNo: channelNo(channel),
    channelName: String(channel['渠道名称'] ?? ''),
    channelStatus: String(channel.status),
    phase: batch ? batch.phase : '未回收',
    version: batch ? batch.version : 0,
    effectiveAt: batch ? batch.effectiveAt : String(channel['停用生效时间'] ?? ''),
    batchId: batch ? batch.id : '',
    linkedActive: eligible.length,
    excludedDrafts: drafts.length,
    endedCount: count('已结束'),
    pendingPauseCount: count('待暂停'),
    collectingCount: count('仍在采集'),
    budgetPool: pool,
    allocatedBudget: allocated,
    consumedBudget: batchConsumed,
    releasableBudget: releasable,
    releasedAmount: released,
    occupiedBudget: occupied,
    unprocessedCount: unprocessed,
    updatedAt: batch ? batch.updatedAt : nowIso(),
    conclusion: batch
      ? batch.conclusion
      : `未生成回收批次；投放中活动 ${eligible.length} 个，草稿排除 ${drafts.length} 个`,
  }
}

export function loadOrchestration(): OrchestrationView {
  const state = readRecoveryState()
  const channels = listRows('channel')
  const campaigns = listRows('campaign')
  return {
    productionRows: channels.map((channel) =>
      productionRowFor(channel, campaigns, state, displayBatch(state, channelNo(channel))),
    ),
    batches: [...state.batches].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    ledger: [...state.ledger].sort((left, right) => right.at.localeCompare(left.at)),
    channels: channels.map((channel) => ({
      id: Number(channel.id),
      channelNo: channelNo(channel),
      channelName: String(channel['渠道名称'] ?? ''),
      status: String(channel.status),
    })),
  }
}

/** 渠道投产清单：保留回收阶段、可释放预算与已释放金额，归档批次也继续展示。 */
export function loadProductionList(filters: Record<string, string> = {}): PageResult {
  const view = loadOrchestration()
  const rows: EntryRow[] = view.productionRows.map((row, index) => ({
    id: index + 1,
    status: row.channelStatus,
    pending: row.unprocessedCount > 0 || row.phase === '待回收' || row.phase === '回收中',
    abnormal: row.phase === '回收中' && row.unprocessedCount > 0,
    '渠道编号': row.channelNo,
    '渠道名称': row.channelName,
    '渠道状态': row.channelStatus,
    '回收阶段': row.phase,
    '回收版本': row.version,
    '停用生效时间': row.effectiveAt || '—',
    '关联投放中活动': row.linkedActive,
    '草稿排除': row.excludedDrafts,
    '已结束': row.endedCount,
    '待暂停': row.pendingPauseCount,
    '仍在采集': row.collectingCount,
    '渠道预算': row.budgetPool,
    '已分配额度': row.allocatedBudget,
    '已消耗预算': row.consumedBudget,
    '可释放预算': row.releasableBudget,
    '已释放金额': row.releasedAmount,
    '占用中预算': row.occupiedBudget,
    '未处理活动': row.unprocessedCount,
    '投产结论': row.conclusion,
  }))
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const matched =
    pairs.length === 0
      ? rows
      : rows.filter((row) =>
          pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
        )
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function resetOrchestration(): ActionResult {
  const rows = resetRows('channel')
  resetRows('campaign')
  saveRecoveryState({ batches: [], ledger: [], batchSeq: 0, ledgerSeq: 0 })
  return { ok: true, message: `渠道投产编排已重置，恢复 ${rows.length} 条渠道配置与示例投放活动` }
}

/** 运营概览的回收口径汇总。 */
export function loadRecoverySummary() {
  const view = loadOrchestration()
  return {
    batches: view.batches.length,
    liveBatches: view.batches.filter(
      (batch) => !batch.supersededBy && (batch.phase === '待回收' || batch.phase === '回收中'),
    ).length,
    released: round(view.productionRows.reduce((sum, row) => sum + row.releasedAmount, 0)),
    releasable: round(view.productionRows.reduce((sum, row) => sum + row.releasableBudget, 0)),
    unprocessed: view.productionRows.reduce((sum, row) => sum + row.unprocessedCount, 0),
    modules: [...MODULE_BY_KEY.values()].map((meta) => {
      const entries = listRows(meta.key)
      return {
        name: meta.name,
        created: entries.length,
        pending: entries.filter((row) => row.pending).length,
        abnormal: entries.filter((row) => row.abnormal).length,
      }
    }),
  }
}
