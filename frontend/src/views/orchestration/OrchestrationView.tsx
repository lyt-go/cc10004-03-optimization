import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  archiveRecovery,
  disableChannel,
  generateRecoveryBatch,
  interruptRecovery,
  loadOrchestration,
  loadProductionList,
  processAllRemaining,
  processRecoveryItem,
  resetOrchestration,
  resumeRecovery,
  startRecovery,
  submitRecovery,
} from '@/api/orchestration-service'
import type { OrchestrationView, RecoveryBatch } from '@/data/recovery'
import type { EntryRow } from '@/data/types'

const productionColumns = [
  '渠道编号',
  '渠道名称',
  '渠道状态',
  '回收阶段',
  '回收版本',
  '停用生效时间',
  '关联投放中活动',
  '草稿排除',
  '已结束',
  '待暂停',
  '仍在采集',
  '渠道预算',
  '已分配额度',
  '已消耗预算',
  '可释放预算',
  '已释放金额',
  '占用中预算',
  '未处理活动',
  '投产结论',
]

const outcomeClass: Record<string, string> = {
  已结束: 'tag ok',
  待暂停: 'tag warn',
  仍在采集: 'tag neutral',
}

function formatAmount(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
}

function phaseClass(phase: string): string {
  if (phase === '已归档') return 'tag archived'
  if (phase === '已提交') return 'tag ok'
  if (phase === '回收中') return 'tag warn'
  return 'tag neutral'
}

export default function OrchestrationView() {
  const [view, setView] = useState<OrchestrationView>({
    productionRows: [],
    batches: [],
    ledger: [],
    channels: [],
  })
  const [productionRows, setProductionRows] = useState<EntryRow[]>([])
  const [selectedChannel, setSelectedChannel] = useState('')
  const [selectedBatch, setSelectedBatch] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const reload = useCallback(() => {
    const payload = loadOrchestration()
    setView(payload)
    setProductionRows(loadProductionList(filters).items)
    if (!selectedChannel && payload.channels.length > 0) {
      const preferred = payload.channels.find((channel) => channel.channelNo === 'CHAN-0003')
      setSelectedChannel(String(preferred?.id ?? payload.channels[0].id))
    }
  }, [filters, selectedChannel])

  useEffect(() => {
    reload()
  }, [reload])

  const channel = view.channels.find((item) => String(item.id) === selectedChannel)
  const channelBatches = useMemo(
    () => view.batches.filter((item) => !channel || item.channelNo === channel.channelNo),
    [channel, view.batches],
  )
  // 选中的批次必须属于当前渠道，否则回落到该渠道最新的批次。
  const batch =
    channelBatches.find((item) => item.id === selectedBatch) ?? channelBatches[0] ?? undefined
  const production = view.productionRows.find(
    (row) => !channel || row.channelNo === channel.channelNo,
  )

  const stats = useMemo(
    () => [
      { label: '渠道状态', value: production?.channelStatus ?? '—' },
      { label: '回收阶段', value: batch?.phase ?? '未回收' },
      { label: '待处理活动', value: batch?.items.filter((item) => !item.processed).length ?? 0 },
      { label: '可释放预算', value: formatAmount(production?.releasableBudget ?? 0) },
      { label: '已释放金额', value: formatAmount(production?.releasedAmount ?? 0) },
    ],
    [batch, production],
  )

  function run(action: () => { ok: boolean; message: string }) {
    setMessage('')
    setErrorMessage('')
    const result = action()
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setMessage(result.message)
    reload()
  }

  function generateForChannel() {
    if (!channel) {
      setErrorMessage('请先选择渠道')
      return
    }
    run(() =>
      channel.status === '已停用'
        ? generateRecoveryBatch(channel.id)
        : disableChannel(channel.id),
    )
  }

  function renderBatchCard(item: RecoveryBatch) {
    const counts = {
      已结束: item.items.filter((entry) => entry.outcome === '已结束').length,
      待暂停: item.items.filter((entry) => entry.outcome === '待暂停').length,
      仍在采集: item.items.filter((entry) => entry.outcome === '仍在采集').length,
    }
    return (
      <article key={item.id} className="batch-card">
        <div className="batch-head">
          <strong>{item.id}</strong>
          <span className={phaseClass(item.phase)}>{item.phase}</span>
          {item.supersededBy && <span className="tag archived">被 {item.supersededBy} 取代</span>}
        </div>
        <p className="batch-meta">
          版本 v{item.version} · 停用生效 {item.effectiveAt || '—'} · 创建 {item.createdAt}
        </p>
        <p className="batch-meta">
          已结束 {counts.已结束} · 待暂停 {counts.待暂停} · 仍在采集 {counts.仍在采集} · 释放{' '}
          {formatAmount(item.releasedAmount)}
        </p>
        <p className="batch-conclusion">{item.conclusion}</p>
        <p className="batch-events">
          {item.events.map((event, index) => (
            <span key={`${event.at}-${index}`} className="event-line">
              {event.at.slice(11, 19)} {event.actor} {event.action}：{event.detail}
            </span>
          ))}
        </p>
      </article>
    )
  }

  return (
    <section className="page" data-module="orchestration">
      <header className="page-head">
        <div>
          <h2>渠道投产编排</h2>
          <p className="page-desc">
            渠道停用后按活动结束时间生成待回收队列，重算渠道状态、可释放预算与活动准入结论，并同步到渠道投产清单。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={generateForChannel} disabled={!channel}>
            {channel?.status === '已停用' ? '生成回收队列' : '停用并生成回收队列'}
          </button>
          <button
            className="btn"
            type="button"
            disabled={!batch}
            onClick={() => batch && run(() => startRecovery(batch.id))}
          >
            开始回收
          </button>
          <button
            className="btn"
            type="button"
            disabled={!batch}
            onClick={() => batch && run(() => resumeRecovery(batch.id))}
          >
            继续回收
          </button>
          <button
            className="btn"
            type="button"
            disabled={!batch}
            onClick={() => batch && run(() => interruptRecovery(batch.id))}
          >
            中断
          </button>
          <button
            className="btn"
            type="button"
            disabled={!batch}
            onClick={() => batch && run(() => processAllRemaining(batch.id))}
          >
            处理剩余
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!batch}
            onClick={() => batch && run(() => submitRecovery(batch.id))}
          >
            提交回收
          </button>
          <button
            className="btn"
            type="button"
            disabled={!batch}
            onClick={() => batch && run(() => archiveRecovery(batch.id))}
          >
            归档
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => run(() => resetOrchestration())}
          >
            重置数据
          </button>
        </div>
      </header>

      {(message || errorMessage) && (
        <p className={errorMessage ? 'notice error' : 'notice'}>{errorMessage || message}</p>
      )}

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <div className="orchestration-bar">
        <label className="filter-item">
          <span>业务渠道</span>
          <select
            value={selectedChannel}
            onChange={(event) => {
              const nextChannel = view.channels.find(
                (entry) => String(entry.id) === event.target.value,
              )
              setSelectedChannel(event.target.value)
              setSelectedBatch(
                view.batches.find((item) => item.channelNo === nextChannel?.channelNo)?.id ?? '',
              )
            }}
          >
            {view.channels.map((item) => (
              <option key={item.id} value={item.id}>
                {item.channelNo} / {item.channelName}（{item.status}）
              </option>
            ))}
          </select>
        </label>
        <label className="filter-item">
          <span>回收批次</span>
          <select
            value={batch?.id ?? ''}
            onChange={(event) => setSelectedBatch(event.target.value)}
          >
            {channelBatches.length === 0 && <option value="">暂无批次</option>}
            {channelBatches.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}（v{item.version} / {item.phase}）
              </option>
            ))}
          </select>
        </label>
      </div>

      {batch ? (
        <>
          <section className="panel">
            <h3 className="panel-title">回收队列（按结束日期、日预算、投放人群拆分）</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>活动编号</th>
                  <th>活动名称</th>
                  <th>结束日期</th>
                  <th>日预算</th>
                  <th>投放人群</th>
                  <th>计划预算</th>
                  <th>已消耗</th>
                  <th>分配额度</th>
                  <th>边界天数</th>
                  <th>处理结论</th>
                  <th>目标状态</th>
                  <th>准入结论</th>
                  <th>计划释放</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {batch.items.map((item) => (
                  <tr key={item.campaignNo}>
                    <td>{item.campaignNo}</td>
                    <td>{item.campaignName}</td>
                    <td>{item.endDate}</td>
                    <td>{formatAmount(item.dailyBudget)}</td>
                    <td>{item.audience}</td>
                    <td>{formatAmount(item.plannedBudget)}</td>
                    <td>{formatAmount(item.consumedBudget)}</td>
                    <td>{formatAmount(item.allocatedBudget)}</td>
                    <td>{item.boundaryDays}</td>
                    <td>
                      <span className={outcomeClass[item.outcome] ?? 'tag'}>{item.outcome}</span>
                    </td>
                    <td>{item.targetStatus}</td>
                    <td>{item.admission}</td>
                    <td>{formatAmount(item.releaseAmount)}</td>
                    <td>
                      {item.processed ? (
                        <span className="processed">
                          已处理 {item.processedAt?.slice(11, 19)}
                          {item.repeatedAt && '（后到操作仅查看结论）'}
                        </span>
                      ) : (
                        <button
                          className="link"
                          type="button"
                          onClick={() => run(() => processRecoveryItem(batch.id, item.campaignNo))}
                        >
                          处理
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="rule-note">
              判定规则：结束日期 ≤ 停用生效日 → 已结束；距结束 ≤ 人群边界 → 待暂停（保留已完成记录）；
              其余 → 仍在采集。释放金额只计算尚未消耗的预算，草稿活动不进入回收队列。
            </p>
          </section>

          <section className="panel">
            <h3 className="panel-title">回收依据（每次判定留痕，按阶段记录）</h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>依据编号</th>
                  <th>阶段</th>
                  <th>活动</th>
                  <th>操作人</th>
                  <th>时间</th>
                  <th>结论</th>
                  <th>释放</th>
                  <th>判定说明</th>
                </tr>
              </thead>
              <tbody>
                {batch.basis.map((item) => (
                  <tr key={item.id}>
                    <td>{item.id}</td>
                    <td>{item.stage}</td>
                    <td>{item.campaignNo}</td>
                    <td>{item.operator}</td>
                    <td>{item.at.slice(0, 19).replace('T', ' ')}</td>
                    <td>{item.outcome}</td>
                    <td>{formatAmount(item.releaseAmount)}</td>
                    <td>{item.rule}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : (
        <p className="empty-state panel">
          当前渠道还没有回收批次：先停用渠道并生成回收队列。草稿活动 CAMP-0001 不会进入回收。
        </p>
      )}

      <section className="panel">
        <h3 className="panel-title">回收批次</h3>
        <div className="batch-grid">
          {channelBatches.map(renderBatchCard)}
          {channelBatches.length === 0 && <p className="empty-state">暂无回收批次</p>}
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">渠道投产清单</h3>
        <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
          {['渠道编号', '回收阶段', '渠道状态'].map((field) => (
            <label key={field} className="filter-item">
              <span>{field}</span>
              <input
                value={filters[field] ?? ''}
                placeholder={`按${field}检索`}
                onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
              />
            </label>
          ))}
          <button className="btn" type="submit">查询</button>
          <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
        </form>
        <table className="data-table">
          <thead>
            <tr>
              {productionColumns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {productionRows.map((row) => (
              <tr key={String(row.id)}>
                {productionColumns.map((column) => (
                  <td key={column}>{row[column] ?? '—'}</td>
                ))}
              </tr>
            ))}
            {productionRows.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={productionColumns.length}>暂无渠道投产数据</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h3 className="panel-title">预算释放台账</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>台账编号</th>
              <th>批次</th>
              <th>渠道</th>
              <th>活动</th>
              <th>释放金额</th>
              <th>操作人</th>
              <th>时间</th>
              <th>依据</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {view.ledger.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.id}</td>
                <td>{entry.batchId}（v{entry.version}）</td>
                <td>{entry.channelNo}</td>
                <td>{entry.campaignNo}</td>
                <td>{formatAmount(entry.amount)}</td>
                <td>{entry.actor}</td>
                <td>{entry.at.slice(0, 19).replace('T', ' ')}</td>
                <td>{entry.basisId}</td>
                <td>{entry.note}</td>
              </tr>
            ))}
            {view.ledger.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={9}>还没有释放记录，提交回收后在这里核对金额</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="page-foot">
        <span>
          阶段严格单向：待回收 → 回收中 → 已提交 → 已归档；提交时活动结束与预算释放同一次写入生效。
        </span>
      </footer>
    </section>
  )
}
