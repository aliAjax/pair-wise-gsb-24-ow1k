import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import "./styles.css";
import { getCurve, nextCurve, rangeLabel } from "./ledger/curves";
import { buildTrenchViews, findConflicts } from "./ledger/stratigraphy";
import { applyReceipt, loadState, reducer, saveState } from "./ledger/store";
import { sampleKeyOf, sampleLabel } from "./ledger/types";
import type { BatchItemInput, ImportBatch, LedgerState } from "./ledger/types";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const fmtTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });

/** 演示批次：含重复报告、正常挂接、对不上样本、以及一条会制造层序矛盾的回执 */
const DEMO_BATCH = `[
  {"reportNo":"BA-2402","lab":"北京大学考古实验室","trench":"T0203","layer":"第3层","bagNo":"袋03","bpAge":2150,"bpError":35},
  {"reportNo":"BA-2405","lab":"北京大学考古实验室","trench":"T0203","layer":"第2层","bagNo":"袋08","bpAge":2650,"bpError":35},
  {"reportNo":"BA-2406","lab":"社科院考古所实验室","trench":"T0301","layer":"F2房址","bagNo":"袋02","bpAge":2300,"bpError":40},
  {"reportNo":"BA-2407","lab":"社科院考古所实验室","trench":"T0203","layer":"第4层","bagNo":"袋11","bpAge":2600,"bpError":45},
  {"reportNo":"BA-2408","lab":"社科院考古所实验室","trench":"T0204","layer":"H12灰坑","bagNo":"袋02","bpAge":2050,"bpError":30}
]`;

function MetricCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={tone} />
    </article>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="empty-hint">{text}</p>;
}

function App() {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);
  useEffect(() => saveState(state), [state]);

  const stateRef = useRef<LedgerState>(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // ---------- 派生数据 ----------
  const conflicts = useMemo(
    () => findConflicts(state.samples, state.conclusions),
    [state.samples, state.conclusions]
  );
  const trenchViews = useMemo(
    () => buildTrenchViews(state.samples, state.conclusions),
    [state.samples, state.conclusions]
  );
  const sampleByKey = useMemo(
    () => new Map(state.samples.map((s) => [s.key, s])),
    [state.samples]
  );
  const receiptByReport = useMemo(
    () => new Map(state.receipts.map((r) => [r.reportNo, r])),
    [state.receipts]
  );
  const unapproved = state.conclusions.filter((c) => c.status === "pending");
  const curve = getCurve(state.curveVersion);
  const targetCurve = nextCurve(state.curveVersion);

  // ---------- 样本登记 ----------
  const [sampleForm, setSampleForm] = useState({
    trench: "T0203",
    layer: "第4层",
    layerOrder: "4",
    bagNo: "袋09",
    material: "炭屑",
  });
  const [sampleMsg, setSampleMsg] = useState("");

  function registerSample() {
    const trench = sampleForm.trench.trim();
    const layer = sampleForm.layer.trim();
    const bagNo = sampleForm.bagNo.trim();
    const layerOrder = Number(sampleForm.layerOrder);
    if (!trench || !layer || !bagNo || !Number.isFinite(layerOrder)) {
      setSampleMsg("探方、地层、袋号和层位顺序都要填写。");
      return;
    }
    const key = sampleKeyOf(trench, layer, bagNo);
    if (sampleByKey.has(key)) {
      setSampleMsg(`样本 ${trench} / ${layer} / ${bagNo} 已登记，同一袋样本不重复入账。`);
      return;
    }
    dispatch({
      type: "registerSample",
      input: { trench, layer, layerOrder, bagNo, material: sampleForm.material },
    });
    const matched = state.pendingReceipts.filter(
      (r) => sampleKeyOf(r.trench, r.layer, r.bagNo) === key
    ).length;
    const label = key.split("|").join(" / ");
    setSampleMsg(
      matched > 0
        ? `已登记 ${label}，有 ${matched} 份待核回执现在可以挂接。`
        : `已登记 ${label}。`
    );
    setSampleForm((f) => ({ ...f, bagNo: "" }));
  }

  // ---------- 单条回执 ----------
  const [receiptForm, setReceiptForm] = useState({
    reportNo: "BA-2409",
    lab: "北京大学考古实验室",
    trench: "T0203",
    layer: "第3层",
    bagNo: "袋05",
    bpAge: "2200",
    bpError: "35",
  });
  const [receiptMsg, setReceiptMsg] = useState("");

  function receiveReceipt() {
    const input: BatchItemInput = {
      reportNo: receiptForm.reportNo,
      lab: receiptForm.lab,
      trench: receiptForm.trench,
      layer: receiptForm.layer,
      bagNo: receiptForm.bagNo,
      bpAge: Number(receiptForm.bpAge),
      bpError: Number(receiptForm.bpError),
    };
    if (!input.reportNo.trim() || !Number.isFinite(input.bpAge)) {
      setReceiptMsg("报告号与 BP 年代必填。");
      return;
    }
    const outcome = applyReceipt(state, input).outcome;
    dispatch({ type: "receiveReceipt", input });
    setReceiptMsg(
      outcome === "attached"
        ? `报告 ${input.reportNo} 已挂接样本并生成待批复结论。`
        : outcome === "pending"
          ? `报告 ${input.reportNo} 对不上已登记样本，已留待核。`
          : `报告 ${input.reportNo} 已入账过，重复报告只入一次。`
    );
  }

  // ---------- 批次导入（可恢复） ----------
  const [batchText, setBatchText] = useState(DEMO_BATCH);
  const [importMsg, setImportMsg] = useState("");
  const [simulateFailure, setSimulateFailure] = useState(true);
  const [running, setRunning] = useState(false);

  async function runBatch(batchId: string, failAfter?: number) {
    setRunning(true);
    try {
      let processed = 0;
      for (;;) {
        const batch = stateRef.current.batches.find((b) => b.id === batchId);
        if (!batch) return;
        // 只补未完成样本：跳过已有检查点的回执
        const item = batch.items.find((it) => !batch.appliedReportNos.includes(it.reportNo.trim()));
        if (!item) {
          dispatch({ type: "batchDone", batchId });
          return;
        }
        dispatch({ type: "applyBatchItem", batchId, item });
        processed += 1;
        if (failAfter !== undefined && processed >= failAfter) {
          dispatch({
            type: "batchFailed",
            batchId,
            note: "模拟中断：实验室接口连接失败，进度已落盘，可恢复",
          });
          return;
        }
        await sleep(160);
      }
    } finally {
      setRunning(false);
    }
  }

  async function startImport() {
    let items: BatchItemInput[];
    try {
      const parsed: unknown = JSON.parse(batchText);
      if (!Array.isArray(parsed)) throw new Error("批次必须是 JSON 数组");
      items = parsed.map((raw, i) => {
        const r = raw as Record<string, unknown>;
        if (
          typeof r.reportNo !== "string" ||
          typeof r.trench !== "string" ||
          typeof r.layer !== "string" ||
          typeof r.bagNo !== "string" ||
          typeof r.bpAge !== "number"
        ) {
          throw new Error(`第 ${i + 1} 条缺少 reportNo / trench / layer / bagNo / bpAge`);
        }
        return {
          reportNo: r.reportNo,
          lab: typeof r.lab === "string" ? r.lab : undefined,
          trench: r.trench,
          layer: r.layer,
          bagNo: r.bagNo,
          bpAge: r.bpAge,
          bpError: typeof r.bpError === "number" ? r.bpError : 30,
          curveVersion: typeof r.curveVersion === "string" ? r.curveVersion : undefined,
        };
      });
    } catch (e) {
      setImportMsg(`批次解析失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (items.length === 0) {
      setImportMsg("批次为空。");
      return;
    }
    const batch: ImportBatch = {
      id: `B-${Date.now().toString(36)}`,
      createdAt: new Date().toISOString(),
      status: "importing",
      items,
      appliedReportNos: [],
      attached: 0,
      pending: 0,
      duplicates: 0,
    };
    dispatch({ type: "createBatch", batch });
    setImportMsg("");
    await sleep(30); // 等批次先落盘
    await runBatch(batch.id, simulateFailure ? Math.max(1, Math.ceil(items.length / 2)) : undefined);
  }

  // ---------- 曲线升级 / 重置 ----------
  function upgradeCurve() {
    const n = unapproved.length;
    const ok = window.confirm(
      `将校准曲线从 ${state.curveVersion} 升级为 ${targetCurve.id}。\n` +
        `${n} 条未批复结论的年代区间将立即失效并按新曲线重算；\n` +
        `已批复结论保留批复时的曲线版本与区间。`
    );
    if (ok) dispatch({ type: "upgradeCurve", to: targetCurve.id });
  }

  function resetAll() {
    if (window.confirm("清空本地台账并恢复示例数据？")) dispatch({ type: "reset" });
  }

  // ---------- 渲染 ----------
  const sortedSamples = [...state.samples].sort(
    (a, b) =>
      a.trench.localeCompare(b.trench) ||
      a.layerOrder - b.layerOrder ||
      a.bagNo.localeCompare(b.bagNo)
  );

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-10 · 考古发掘 · 领队整理</p>
          <h1>可恢复的测年台账</h1>
          <p className="subtitle">
            样本按探方、地层、袋号唯一绑定；实验室回执凭报告号只入一次，对不上样本先留待核。
            校准曲线换版后未批复区间立即失效重算，已批复结论保留当时依据；层序矛盾未消除前挡住报告发布。
          </p>
        </div>
        <div className="stack-card">
          <span>当前校准曲线</span>
          <strong>
            {curve.label} <small className="muted-text">{curve.id}</small>
          </strong>
          <p className="hint">{curve.note}</p>
          <div className="toolbar">
            <button className="primary-action" onClick={upgradeCurve}>
              升级为 {targetCurve.id} 并重算
            </button>
            <button onClick={resetAll}>重置台账</button>
          </div>
        </div>
      </section>

      <section className="metrics-grid">
        <MetricCard label="登记样本" value={state.samples.length} tone="status-ok" />
        <MetricCard label="已挂回执" value={state.receipts.length} tone="status-ok" />
        <MetricCard label="待核回执" value={state.pendingReceipts.length} tone="status-watch" />
        <MetricCard label="未批复结论" value={unapproved.length} tone="status-watch" />
        <MetricCard label="层序矛盾" value={conflicts.length} tone={conflicts.length ? "status-danger" : "status-ok"} />
        <MetricCard label="已发布报告" value={state.publications.length} tone="status-ok" />
      </section>

      <section className="workspace">
        <aside className="panel narrow">
          <div className="section-heading">
            <div>
              <p>唯一绑定</p>
              <h2>样本登记</h2>
            </div>
          </div>
          <div className="form-grid">
            <label>
              <span>探方</span>
              <input
                value={sampleForm.trench}
                onChange={(e) => setSampleForm({ ...sampleForm, trench: e.target.value })}
                placeholder="如 T0203"
              />
            </label>
            <label>
              <span>地层</span>
              <input
                value={sampleForm.layer}
                onChange={(e) => setSampleForm({ ...sampleForm, layer: e.target.value })}
                placeholder="如 第4层"
              />
            </label>
            <label>
              <span>层位顺序（小者在上）</span>
              <input
                type="number"
                value={sampleForm.layerOrder}
                onChange={(e) => setSampleForm({ ...sampleForm, layerOrder: e.target.value })}
              />
            </label>
            <label>
              <span>袋号</span>
              <input
                value={sampleForm.bagNo}
                onChange={(e) => setSampleForm({ ...sampleForm, bagNo: e.target.value })}
                placeholder="如 袋09"
              />
            </label>
            <label>
              <span>材质</span>
              <input
                value={sampleForm.material}
                onChange={(e) => setSampleForm({ ...sampleForm, material: e.target.value })}
              />
            </label>
            <button className="primary-action" onClick={registerSample}>
              登记样本
            </button>
          </div>
          {sampleMsg && <p className="form-msg">{sampleMsg}</p>}

          <h3 className="panel-subtitle">样本清单（{sortedSamples.length}）</h3>
          <div className="table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>探方 / 地层 / 袋号</th>
                  <th>材质</th>
                  <th>回执</th>
                </tr>
              </thead>
              <tbody>
                {sortedSamples.map((s) => {
                  const cons = state.conclusions.filter((c) => c.sampleKey === s.key);
                  return (
                    <tr key={s.key}>
                      <td>
                        {s.trench} / {s.layer}（序{s.layerOrder}）/ {s.bagNo}
                      </td>
                      <td>{s.material}</td>
                      <td>
                        {cons.length === 0
                          ? "—"
                          : cons.map((c) => (
                              <span
                                key={c.id}
                                className={`badge ${c.status === "approved" ? "badge-ok" : "badge-warn"}`}
                              >
                                {c.reportNo}
                                {c.status === "approved" ? " · 已批复" : " · 待批复"}
                              </span>
                            ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>报告号 + 曲线版本</p>
              <h2>实验室回执</h2>
            </div>
          </div>
          <div className="form-grid cols-3">
            <label>
              <span>报告号</span>
              <input
                value={receiptForm.reportNo}
                onChange={(e) => setReceiptForm({ ...receiptForm, reportNo: e.target.value })}
              />
            </label>
            <label>
              <span>实验室</span>
              <input
                value={receiptForm.lab}
                onChange={(e) => setReceiptForm({ ...receiptForm, lab: e.target.value })}
              />
            </label>
            <label>
              <span>探方</span>
              <input
                value={receiptForm.trench}
                onChange={(e) => setReceiptForm({ ...receiptForm, trench: e.target.value })}
              />
            </label>
            <label>
              <span>地层</span>
              <input
                value={receiptForm.layer}
                onChange={(e) => setReceiptForm({ ...receiptForm, layer: e.target.value })}
              />
            </label>
            <label>
              <span>袋号</span>
              <input
                value={receiptForm.bagNo}
                onChange={(e) => setReceiptForm({ ...receiptForm, bagNo: e.target.value })}
              />
            </label>
            <label>
              <span>BP 年代 ± 误差</span>
              <span className="inline-inputs">
                <input
                  type="number"
                  value={receiptForm.bpAge}
                  onChange={(e) => setReceiptForm({ ...receiptForm, bpAge: e.target.value })}
                />
                <input
                  type="number"
                  value={receiptForm.bpError}
                  onChange={(e) => setReceiptForm({ ...receiptForm, bpError: e.target.value })}
                />
              </span>
            </label>
          </div>
          <div className="toolbar">
            <button className="primary-action" onClick={receiveReceipt}>
              登记回执（按 {state.curveVersion} 校准）
            </button>
          </div>
          {receiptMsg && <p className="form-msg">{receiptMsg}</p>}

          <h3 className="panel-subtitle">批次导入（失败可恢复）</h3>
          <textarea
            className="batch-input"
            rows={7}
            value={batchText}
            onChange={(e) => setBatchText(e.target.value)}
            spellCheck={false}
          />
          <div className="toolbar">
            <button className="primary-action" onClick={startImport} disabled={running}>
              {running ? "导入中…" : "开始导入"}
            </button>
            <label className="check-label">
              <input
                type="checkbox"
                checked={simulateFailure}
                onChange={(e) => setSimulateFailure(e.target.checked)}
              />
              模拟中途失败
            </label>
          </div>
          {importMsg && <p className="form-msg danger-text">{importMsg}</p>}
          <p className="hint">
            导入逐条落盘：中断或关页后从完整批次恢复，只补未完成样本；重放同一批次不会重复挂回执。
          </p>

          <div className="batch-list">
            {state.batches.length === 0 && <EmptyHint text="还没有导入批次。" />}
            {state.batches.map((b) => {
              const done = b.appliedReportNos.length;
              const pct = b.items.length ? Math.round((done / b.items.length) * 100) : 0;
              return (
                <article key={b.id} className="batch-item">
                  <div className="batch-head">
                    <strong>{b.id}</strong>
                    <span className="muted-text">{fmtTime(b.createdAt)}</span>
                    <span
                      className={`badge ${
                        b.status === "done"
                          ? "badge-ok"
                          : b.status === "failed"
                            ? "badge-danger"
                            : "badge-warn"
                      }`}
                    >
                      {b.status === "done" ? "已完成" : b.status === "failed" ? "已中断·可恢复" : "导入中"}
                    </span>
                  </div>
                  <div className="progress">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                  <p className="hint">
                    进度 {done}/{b.items.length} · 挂接 {b.attached} · 待核 {b.pending} · 重复{" "}
                    {b.duplicates}
                    {b.note ? ` · ${b.note}` : ""}
                  </p>
                  {b.status === "failed" && (
                    <button onClick={() => runBatch(b.id)} disabled={running}>
                      从完整批次恢复（续 {b.items.length - done} 条）
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>对不上样本先留待核</p>
            <h2>待核回执（{state.pendingReceipts.length}）</h2>
          </div>
        </div>
        {state.pendingReceipts.length === 0 && <EmptyHint text="没有待核回执，所有报告都已对入账。" />}
        <div className="pending-list">
          {state.pendingReceipts.map((r) => {
            const exactKey = sampleKeyOf(r.trench, r.layer, r.bagNo);
            const exact = sampleByKey.get(exactKey);
            return (
              <article key={r.reportNo} className="pending-item">
                <div>
                  <h3>
                    {r.reportNo} <span className="badge badge-warn">待核</span>
                  </h3>
                  <p>
                    回执指向 {r.trench} / {r.layer} / {r.bagNo} · BP {r.bpAge}±{r.bpError} ·{" "}
                    {r.lab} · 曲线 {r.curveVersion}
                  </p>
                  <p className="danger-text">{r.reason}</p>
                </div>
                <PendingAttach
                  reportNo={r.reportNo}
                  exactKey={exact ? exact.key : ""}
                  samples={sortedSamples}
                  onAttach={(sampleKey) => dispatch({ type: "attachPending", reportNo: r.reportNo, sampleKey })}
                  onDiscard={() => dispatch({ type: "discardPending", reportNo: r.reportNo })}
                />
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>曲线换版 · 未批复即时重算</p>
            <h2>年代结论（{state.conclusions.length}）</h2>
          </div>
        </div>
        {state.conclusions.length === 0 && <EmptyHint text="还没有年代结论。" />}
        {state.conclusions.length > 0 && (
          <div className="table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>报告号</th>
                  <th>样本</th>
                  <th>BP 年代</th>
                  <th>校准区间</th>
                  <th>曲线依据</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {state.conclusions.map((c) => {
                  const s = sampleByKey.get(c.sampleKey);
                  const staleApproved = c.status === "approved" && c.curveVersion !== state.curveVersion;
                  return (
                    <tr key={c.id}>
                      <td>{c.reportNo}</td>
                      <td>{s ? sampleLabel(s) : c.sampleKey}</td>
                      <td>
                        {c.bpAge}±{c.bpError}
                      </td>
                      <td>
                        {rangeLabel(c.calMin, c.calMax)}
                        {c.history.length > 0 && (
                          <span className="history-note">
                            原 {c.history[c.history.length - 1].curveVersion} 区间 calBP{" "}
                            {c.history[c.history.length - 1].calMin}–
                            {c.history[c.history.length - 1].calMax} 已失效，按 {c.curveVersion} 重算
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${staleApproved ? "badge-muted" : "badge-ok"}`}>
                          {c.curveVersion}
                          {staleApproved ? " · 批复时依据" : ""}
                        </span>
                      </td>
                      <td>
                        {c.status === "approved" ? (
                          <span className="badge badge-ok">
                            已批复 · {c.approvedBy}
                          </span>
                        ) : (
                          <span className="badge badge-warn">待批复</span>
                        )}
                      </td>
                      <td>
                        {c.status === "pending" && (
                          <button
                            onClick={() =>
                              dispatch({ type: "approveConclusion", id: c.id, by: "领队" })
                            }
                          >
                            领队批复
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>层序矛盾挡住发布</p>
            <h2>地层顺序校验与报告发布</h2>
          </div>
        </div>
        {trenchViews.length === 0 && <EmptyHint text="还没有可校验的探方结论。" />}
        <div className="trench-list">
          {trenchViews.map((t) => {
            const tConflicts = conflicts.filter((c) => c.trench === t.trench);
            const blocked = tConflicts.length > 0;
            return (
              <article key={t.trench} className={`trench-card ${blocked ? "blocked" : ""}`}>
                <div className="trench-head">
                  <h3>探方 {t.trench}</h3>
                  <span className={`badge ${blocked ? "badge-danger" : "badge-ok"}`}>
                    {blocked ? `层序矛盾 ${tConflicts.length} 处 · 禁止发布` : "层序自洽"}
                  </span>
                  <button
                    className="primary-action"
                    disabled={blocked}
                    title={blocked ? "存在层序矛盾，报告发布已被挡住" : "发布该探方年代报告"}
                    onClick={() => dispatch({ type: "publishTrench", trench: t.trench })}
                  >
                    发布年代报告
                  </button>
                </div>
                <ol className="layer-list">
                  {t.layers.map((l) => (
                    <li key={l.layer}>
                      <strong>
                        {l.layer}（序{l.layerOrder}）
                      </strong>{" "}
                      calBP {l.calMin}–{l.calMax} · {l.members.length} 个样本：
                      {l.members
                        .map((m) => `${m.bagNo}（${m.reportNo}，calBP ${m.calMin}–${m.calMax}）`)
                        .join("、")}
                    </li>
                  ))}
                </ol>
                {blocked && (
                  <div className="conflict-box">
                    <p className="danger-text">以下新结果与地层上下顺序矛盾，已挡住报告发布：</p>
                    <ul>
                      {tConflicts.map((c) => (
                        <li key={c.id}>
                          探方 {c.trench}：上层 {c.upper.layer} · {c.upper.bagNo}（{c.upper.reportNo}
                          ，calBP {c.upper.calMin}–{c.upper.calMax}）最早边界仍老于下层{" "}
                          {c.lower.layer} · {c.lower.bagNo}（{c.lower.reportNo}，calBP{" "}
                          {c.lower.calMin}–{c.lower.calMax}）最晚边界，请复核样本或层位归属。
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        {state.publications.length > 0 && (
          <>
            <h3 className="panel-subtitle">已发布报告</h3>
            <div className="pub-list">
              {state.publications.map((p) => (
                <article key={p.id} className="pub-item">
                  <strong>{p.id}</strong> · 探方 {p.trench} · {fmtTime(p.publishedAt)} · 曲线{" "}
                  {p.curveVersion} · 含 {p.reportNos.length} 份结论（
                  {p.reportNos.join("、")}）
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      <footer className="footer-note">
        台账保存在浏览器本地（localStorage），重新打开页面可继续整理；导入中断的批次会标记为可恢复。
        内置校准模型仅用于流程演示，正式结论以实验室与现行国际曲线为准。
      </footer>
    </main>
  );
}

/** 待核回执的挂接操作：优先建议完全匹配的样本 */
function PendingAttach({
  reportNo,
  exactKey,
  samples,
  onAttach,
  onDiscard,
}: {
  reportNo: string;
  exactKey: string;
  samples: { key: string; trench: string; layer: string; bagNo: string }[];
  onAttach: (sampleKey: string) => void;
  onDiscard: () => void;
}) {
  const [selected, setSelected] = useState(exactKey);
  useEffect(() => setSelected(exactKey), [exactKey, reportNo]);
  return (
    <div className="pending-actions">
      <select value={selected} onChange={(e) => setSelected(e.target.value)}>
        <option value="">选择要挂接的样本…</option>
        {samples.map((s) => (
          <option key={s.key} value={s.key}>
            {s.trench} / {s.layer} / {s.bagNo}
            {s.key === exactKey ? "（完全匹配）" : ""}
          </option>
        ))}
      </select>
      <button className="primary-action" disabled={!selected} onClick={() => onAttach(selected)}>
        挂接
      </button>
      <button onClick={onDiscard}>作废</button>
    </div>
  );
}

export default App;
