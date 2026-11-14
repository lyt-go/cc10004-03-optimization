import { useCallback, useEffect, useState } from 'react'

import { loadOverview } from '@/api/local-service'
import { loadRecoverySummary } from '@/api/orchestration-service'
import type { OverviewResult } from '@/data/types'

export default function Overview() {
  const [cards, setCards] = useState<OverviewResult['cards']>([])
  const [moduleRows, setModuleRows] = useState<OverviewResult['modules']>([])
  const [recoveryCards, setRecoveryCards] = useState<{ label: string; value: string }[]>([])

  const refresh = useCallback(() => {
    const payload = loadOverview()
    setCards(payload.cards)
    setModuleRows(payload.modules)
    const summary = loadRecoverySummary()
    setRecoveryCards([
      { label: '投产回收批次', value: `${summary.batches}（进行中 ${summary.liveBatches}）` },
      { label: '未处理回收活动', value: String(summary.unprocessed) },
      { label: '累计释放预算', value: summary.released.toLocaleString('zh-CN') },
      { label: '当前可释放预算', value: summary.releasable.toLocaleString('zh-CN') },
    ])
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>运营概览</h2>
          <p className="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={refresh}>重新统计</button>
        </div>
      </header>
      <div className="stat-row">
        {[...cards, ...recoveryCards].map((card) => (
          <article key={card.label} className="stat-card">
            <span className="stat-label">{card.label}</span>
            <strong className="stat-value">{card.value}</strong>
          </article>
        ))}
      </div>
      <table className="data-table">
        <thead>
          <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
        </thead>
        <tbody>
          {moduleRows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td>{row.created}</td>
              <td>{row.pending}</td>
              <td>{row.abnormal}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="page-foot">
        <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
      </footer>
    </section>
  )
}
