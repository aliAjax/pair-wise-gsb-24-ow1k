import { useMemo, useState } from "react";
import "./styles.css";
import { StoreProvider, useStore, type BatchDraft } from "./store";
import { CURVE_NOTE, CURVE_VERSIONS, type CurveVersion } from "./types";
import { effectiveRange, findOrderConflicts, rangeLabel } from "./domain";

const fmtTime = (t: number) => new Date(t).toLocaleString("zh-CN", { hour12: false });

function useFields<T extends Record<string, string>>(initial: T) {
  const [fields, setFields] = useState(initial);
  const set = (k: keyof T) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFields((f) => ({ ...f, [k]: e.target.value }));
  const reset = () => setFields(initial);
  return { fields, set, reset };
}

// ---------- 顶部：曲线版本与指标 ----------

function Header() {
  const { state, dispatch } = useStore();
  const pendingCount = state.receipts.filter((r) => !r.sampleKey && !r.returnedAt).length;
  const metrics = [
    { label: "在册样本", value: state.samples.length },
    { label: "回执总数", value: state.receipts.length },
    { label: "待核回执", value: pendingCount, warn: pendingCount > 0 },
    { label: "已批复结论", value: Object.keys(state.approvals).length },
  ];
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-10 · 测年台账</p>
          <h1>可恢复的碳十四测年台账</h1>
          <p className="subtitle">
            样本按「探方 / 地层 / 袋号」唯一绑定；实验室回执带报告号与校准曲线版本，重复报告只入一次，
            对不上样本先留待核。曲线换版后未批复区间立即失效重算，已批复结论保留当时依据；
            地层上下顺序矛盾时挡下报告发布。导入失败可从完整批次恢复，刷新页面不丢进度。
          </p>
        </div>
        <div className="stack-card curve-card">
          <span>当前校准曲线（新回执 / 重算依据）</span>
          <select
            value={state.currentCurve}
            onChange={(e) => dispatch({ type: "setCurve", curve: e.target.value as CurveVersion })}
          >
            {CURVE_VERSIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <strong>{CURVE_NOTE[state.currentCurve]}</strong>
          <button className="ghost" onClick={() => {
            if (confirm("清空浏览器内台账并恢复示例数据？")) dispatch({ type: "reset" });
          }}>
            重置为示例台账
          </button>
        </div>
      </section>

      <section className="metrics-grid">
        {metrics.map((m) => (
          <article className={`metric-card ${m.warn ? "metric-warn" : ""}`} key={m.label}>
            <span>{m.label}</span>
            <strong>{m.value}</strong>
            <i className={m.warn ? "status-danger" : "status-ok"} />
          </article>
        ))}
      </section>
    </>
  );
}

// ---------- 样本登记 ----------

function SamplesPanel() {
  const { state, dispatch } = useStore();
  const { fields, set, reset } = useFields({ square: "", layer: "", bag: "", material: "" });
  const dup = state.samples.some(
    (s) =>
      s.key === `${fields.square.trim()}|${fields.layer.trim()}|${fields.bag.trim()}` &&
      fields.bag.trim() !== "",
  );
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>样本账</p>
          <h2>样本登记（探方 + 地层 + 袋号唯一）</h2>
        </div>
      </div>
      <form
        className="field-grid"
        onSubmit={(e) => {
          e.preventDefault();
          dispatch({ type: "addSample", ...fields });
          reset();
        }}
      >
        <label><span>探方</span><input value={fields.square} onChange={set("square")} placeholder="如 T0203" required /></label>
        <label><span>地层</span><input value={fields.layer} onChange={set("layer")} placeholder="如 第3层" required /></label>
        <label><span>袋号</span><input value={fields.bag} onChange={set("bag")} placeholder="如 D12" required /></label>
        <label><span>测年材料</span><input value={fields.material} onChange={set("material")} placeholder="如 炭化木屑" /></label>
        <button className="primary-action" disabled={dup} type="submit">
          {dup ? "该探方/地层/袋号已存在" : "登记样本"}
        </button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>探方</th><th>地层</th><th>袋号</th><th>材料</th><th>登记时间</th></tr>
          </thead>
          <tbody>
            {state.samples.map((s) => (
              <tr key={s.key}>
                <td>{s.square}</td><td>{s.layer}</td><td>{s.bag}</td>
                <td>{s.material || "—"}</td><td className="dim">{fmtTime(s.registeredAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- 实验室回执 ----------

function ReceiptsPanel() {
  const { state, dispatch } = useStore();
  const { fields, set, reset } = useFields({
    reportNo: "", lab: "", bp: "4200", sigma: "35",
    intendedSquare: "", intendedLayer: "", intendedBag: "",
  });
  const dupNo = state.receipts.some((r) => r.reportNo === fields.reportNo.trim());
  const pending = state.receipts.filter((r) => !r.sampleKey && !r.returnedAt);

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>实验室回执</p>
          <h2>回执入账（报告号唯一，绑定三要素）</h2>
        </div>
      </div>
      <form
        className="field-grid three"
        onSubmit={(e) => {
          e.preventDefault();
          dispatch({
            type: "addReceipt",
            reportNo: fields.reportNo,
            lab: fields.lab,
            bp: Number(fields.bp),
            sigma: Number(fields.sigma),
            curveVersion: state.currentCurve,
            intendedSquare: fields.intendedSquare,
            intendedLayer: fields.intendedLayer,
            intendedBag: fields.intendedBag,
          });
          reset();
        }}
      >
        <label><span>报告号</span><input value={fields.reportNo} onChange={set("reportNo")} placeholder="如 LDR-2025-0031" required /></label>
        <label><span>实验室</span><input value={fields.lab} onChange={set("lab")} /></label>
        <label><span>测量 BP</span><input type="number" value={fields.bp} onChange={set("bp")} /></label>
        <label><span>± σ</span><input type="number" value={fields.sigma} onChange={set("sigma")} /></label>
        <label><span>回执所指探方</span><input value={fields.intendedSquare} onChange={set("intendedSquare")} placeholder="T0203" /></label>
        <label><span>回执所指地层</span><input value={fields.intendedLayer} onChange={set("intendedLayer")} placeholder="第3层" /></label>
        <label><span>回执所指袋号</span><input value={fields.intendedBag} onChange={set("intendedBag")} placeholder="D12" /></label>
        <button className="primary-action" disabled={dupNo} type="submit">
          {dupNo ? "报告号已存在，拒收" : "录入回执（按 " + state.currentCurve + "）"}
        </button>
      </form>
      {dupNo && <p className="inline-warn">重复报告只入一次：该报告号已在台账中。</p>}

      {pending.length > 0 && (
        <div className="pending-box">
          <h3>待核回执（{pending.length}）— 对不上样本，先留待核</h3>
          {pending.map((r) => <PendingRow key={r.reportNo} reportNo={r.reportNo} />)}
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>报告号</th><th>实验室</th><th>BP ± σ</th><th>曲线版本</th><th>绑定样本</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            {state.receipts.map((r) => (
              <tr key={r.reportNo} className={r.sampleKey ? "" : "row-pending"}>
                <td>{r.reportNo}</td>
                <td>{r.lab || "—"}</td>
                <td>{r.bp} ± {r.sigma}</td>
                <td><span className="tag">{r.curveVersion}</span></td>
                <td>{r.sampleKey ?? <em>待核{r.intended ? `：${r.intended.square}/${r.intended.layer}/${r.intended.bag}` : ""}</em>}</td>
                <td>{r.returnedAt ? "已退回" : r.sampleKey ? "已挂样本" : "待核"}</td>
                <td>
                  {!r.returnedAt && (
                    <button className="ghost small" onClick={() => dispatch({ type: "returnReceipt", reportNo: r.reportNo })}>
                      退回
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PendingRow({ reportNo }: { reportNo: string }) {
  const { state, dispatch } = useStore();
  const r = state.receipts.find((x) => x.reportNo === reportNo)!;
  const { fields, set } = useFields({
    square: r.intended?.square ?? "",
    layer: r.intended?.layer ?? "",
    bag: r.intended?.bag ?? "",
  });
  const key = `${fields.square.trim()}|${fields.layer.trim()}|${fields.bag.trim()}`;
  const found = state.samples.some((s) => s.key === key);
  return (
    <div className="pending-row">
      <strong>{r.reportNo}</strong>
      <span className="dim">{r.bp} ± {r.sigma}（{r.curveVersion}）</span>
      <input aria-label="核到探方" value={fields.square} onChange={set("square")} placeholder="探方" />
      <input aria-label="核到地层" value={fields.layer} onChange={set("layer")} placeholder="地层" />
      <input aria-label="核到袋号" value={fields.bag} onChange={set("bag")} placeholder="袋号" />
      <button
        className="primary-action small"
        disabled={!found}
        onClick={() => dispatch({ type: "matchPending", reportNo, ...fields })}
      >
        {found ? "核到该样本" : "样本不存在"}
      </button>
    </div>
  );
}

// ---------- 年代区间与批复 ----------

function AgesPanel() {
  const { state, dispatch } = useStore();
  const [approver, setApprover] = useState("领队");
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>年代区间</p>
          <h2>校准结果与批复（换版后未批复立即重算）</h2>
        </div>
        <label className="inline-label">
          <span>批复人</span>
          <input value={approver} onChange={(e) => setApprover(e.target.value)} />
        </label>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>样本</th><th>依据回执</th><th>当前区间</th><th>依据曲线</th><th>状态</th><th>重算次数</th><th></th></tr>
          </thead>
          <tbody>
            {state.samples.map((s) => {
              const eff = effectiveRange(state, s.key);
              const cal = state.results[s.key];
              const approval = state.approvals[s.key];
              return (
                <tr key={s.key}>
                  <td>{s.key}</td>
                  <td>{cal?.basedOnReport ?? "—"}</td>
                  <td>{rangeLabel(eff)}</td>
                  <td><span className="tag">{eff?.curveVersion ?? "—"}</span></td>
                  <td>{approval ? `已批复 · ${approval.approver}` : cal ? "未批复（随换版失效）" : "无回执"}</td>
                  <td>{cal?.recalcs ?? 0}</td>
                  <td>
                    {cal && !approval && (
                      <button className="primary-action small" onClick={() => dispatch({ type: "approve", sampleKey: s.key, approver })}>
                        批复并冻结
                      </button>
                    )}
                    {approval && <span className="dim" title={fmtTime(approval.approvedAt)}>冻结于 {fmtTime(approval.approvedAt)}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- 发布把关 ----------

function PublishPanel() {
  const { state, dispatch, conflicts } = useStore();
  const blocked = conflicts.length > 0;
  const lastPub = state.publications[0];
  const lastBlockedLog = state.logs.find((l) => l.kind === "publish" && l.message.includes("挡下"));
  return (
    <section className={`panel ${blocked ? "panel-danger" : ""}`}>
      <div className="section-heading">
        <div>
          <p>报告发布</p>
          <h2>地层上下顺序把关{blocked ? " · 存在年代倒置" : ""}</h2>
        </div>
        <button className={blocked ? "danger-action" : "primary-action"} disabled={blocked}
          onClick={() => dispatch({ type: "publish" })}>
          {blocked ? `挡下发布（${conflicts.length} 处矛盾）` : "发布年代报告"}
        </button>
      </div>

      {blocked && (
        <div className="conflict-box">
          <p className="conflict-title">以下探方的地层上下顺序与新结果矛盾，必须先处理（改地层关系 / 退回回执 / 以批复保留原结论）：</p>
          <table>
            <thead><tr><th>探方</th><th>上层（地层 / 样本）</th><th>下层（地层 / 样本）</th><th>上层区间</th><th>下层区间</th></tr></thead>
            <tbody>
              {conflicts.map((c, i) => {
                const u = effectiveRange(state, c.upper.sampleKey);
                const l = effectiveRange(state, c.lower.sampleKey);
                return (
                  <tr key={i}>
                    <td><strong>{c.square}</strong></td>
                    <td>{c.upper.layer} / {c.upper.sampleKey}</td>
                    <td>{c.lower.layer} / {c.lower.sampleKey}</td>
                    <td className="range-bad">{rangeLabel(u)}</td>
                    <td>{rangeLabel(l)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lastBlockedLog && <p className="dim">最近挡下记录：{fmtTime(lastBlockedLog.at)}</p>}
        </div>
      )}

      {!blocked && lastPub && (
        <div className="published-box">
          <h3>最近发布：{fmtTime(lastPub.at)} · {lastPub.currentCurve}</h3>
          <div className="chips">
            {lastPub.conclusions.map((c) => (
              <span key={c.sampleKey} className={c.approved ? "chip-approved" : ""}>
                {c.square}/{c.layer}/{c.bag}：{rangeLabel(c)}
                {c.approved ? "（批复）" : ""}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- 批次导入与恢复 ----------

const DEMO_BATCH: BatchDraft[] = [
  { kind: "sample", square: "T0402", layer: "第2层", bag: "D01", material: "炭屑" },
  { kind: "sample", square: "T0402", layer: "第3层", bag: "D05", material: "动物骨" },
  {
    kind: "receipt", reportNo: "LDR-2025-0031", lab: "十四碳实验室丙", bp: 3600, sigma: 30,
    curveVersion: "IntCal25", intendedSquare: "T0402", intendedLayer: "第2层", intendedBag: "D01",
  },
  {
    kind: "receipt", reportNo: "LDR-2025-0044", lab: "十四碳实验室丙", bp: 3050, sigma: 28,
    curveVersion: "IntCal25", intendedSquare: "T0402", intendedLayer: "第3层", intendedBag: "D05",
  },
  // 与台账已有报告号重复：重放时只入一次、不重复挂
  {
    kind: "receipt", reportNo: "LDR-2024-1187", lab: "十四碳实验室甲", bp: 4200, sigma: 35,
    curveVersion: "IntCal20", intendedSquare: "T0203", intendedLayer: "第2层", intendedBag: "D07",
  },
];

function BatchPanel() {
  const { state, importBatch, resumeBatch, dispatch } = useStore();
  const [text, setText] = useState("");
  const [failAfter, setFailAfter] = useState("2");
  const [error, setError] = useState<string | null>(null);
  const batches = Object.values(state.batches).sort((a, b) => b.updatedAt - a.updatedAt);

  const parseDrafts = (raw: string): BatchDraft[] | null => {
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return null;
      return data.map((d) => ({ kind: d.kind, ...d }));
    } catch {
      return null;
    }
  };

  const doImport = () => {
    const drafts = parseDrafts(text);
    if (!drafts || drafts.length === 0) {
      setError("批次需是 JSON 数组，包含 sample / receipt 条目");
      return;
    }
    setError(null);
    void importBatch(
      `导入批次 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
      drafts,
      failAfter === "none" ? null : Number(failAfter),
    );
    setText("");
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>批次导入 / 失败恢复</p>
          <h2>完整批次导入（中断后只补未完成项）</h2>
        </div>
        <button className="ghost" onClick={() => setText(JSON.stringify(DEMO_BATCH, null, 2))}>
          填入演示批次
        </button>
      </div>
      <textarea
        className="batch-input"
        rows={8}
        placeholder='[{"kind":"sample","square":"T0402","layer":"第2层","bag":"D01","material":"炭屑"}, ...]'
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="batch-controls">
        <label className="inline-label">
          <span>模拟导入失败</span>
          <select value={failAfter} onChange={(e) => setFailAfter(e.target.value)}>
            <option value="none">不中断</option>
            <option value="1">处理完第 1 条后中断</option>
            <option value="2">处理完第 2 条后中断</option>
            <option value="3">处理完第 3 条后中断</option>
          </select>
        </label>
        <button className="primary-action" onClick={doImport} disabled={!text.trim()}>开始导入</button>
        <span className="dim">中断后刷新页面也能在此点「从完整批次恢复」继续。</span>
      </div>
      {error && <p className="inline-warn">{error}</p>}

      <div className="batch-list">
        {batches.map((b) => {
          const done = b.items.filter((it) => it.status === "done").length;
          const pct = Math.round((done / b.items.length) * 100);
          return (
            <article key={b.id} className={`batch-card batch-${b.status}`}>
              <header>
                <strong>{b.name}</strong>
                <span className={`status-pill status-${b.status}`}>
                  {b.status === "completed" ? "已完成" : b.status === "running" ? "导入中…" : "已中断 · 待恢复"}
                </span>
              </header>
              <div className="progress"><i style={{ width: `${pct}%` }} /></div>
              <p className="dim">{done}/{b.items.length} 条已完成 · 创建 {fmtTime(b.createdAt)}</p>
              <ul className="batch-items">
                {b.items.map((it, i) => (
                  <li key={it.id} className={it.status === "done" ? "item-done" : "item-pending"}>
                    <span>{i + 1}. {it.kind === "sample"
                      ? `样本 ${(it.payload as BatchDraft).square}/${(it.payload as BatchDraft).layer}/${(it.payload as BatchDraft).bag}`
                      : `回执 ${(it.payload as BatchDraft).reportNo}`}</span>
                    <span className="dim">{it.status === "done" ? it.note : "未完成"}</span>
                  </li>
                ))}
              </ul>
              {b.status === "interrupted" && (
                <div className="batch-actions">
                  <button className="primary-action" onClick={() => void resumeBatch(b.id)}>
                    从完整批次恢复（只补 {b.items.length - done} 条未完成项）
                  </button>
                  <button className="ghost" onClick={() => dispatch({ type: "batchDiscard", batchId: b.id })}>
                    丢弃批次记录
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

// ---------- 操作日志 ----------

function LogPanel() {
  const { state } = useStore();
  const label: Record<string, string> = {
    sample: "样本", receipt: "回执", curve: "曲线", approval: "批复",
    batch: "批次", publish: "发布", system: "系统",
  };
  return (
    <section className="panel narrow-panel">
      <div className="section-heading">
        <div><p>可追溯</p><h2>操作日志</h2></div>
      </div>
      <ul className="log-list">
        {state.logs.map((l) => (
          <li key={l.id}>
            <span className={`log-kind log-${l.kind}`}>{label[l.kind]}</span>
            <p>{l.message}</p>
            <time>{fmtTime(l.at)}</time>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Shell() {
  const { state } = useStore();
  const conflicts = useMemo(() => findOrderConflicts(state), [state]);
  return (
    <main className="app-shell">
      <Header />
      {conflicts.length > 0 && (
        <div className="conflict-banner">
          ⚠ 检测到 {conflicts.length} 处地层年代倒置，报告发布已被挡住 —— 见下方「报告发布」
        </div>
      )}
      <div className="two-col">
        <div className="col-main">
          <SamplesPanel />
          <ReceiptsPanel />
          <AgesPanel />
          <PublishPanel />
          <BatchPanel />
        </div>
        <div className="col-side"><LogPanel /></div>
      </div>
    </main>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
