import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type {
  BatchItem,
  BatchState,
  Calibration,
  CurveVersion,
  LedgerState,
  LogEntry,
  Publication,
  Receipt,
  Sample,
} from "./types";
import {
  buildPublication,
  calibrate,
  findOrderConflicts,
  recalibrate,
  sampleKey,
} from "./domain";

const STORAGE_KEY = "hxwl10-dating-ledger-v1";

let counter = 0;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;

// ---------- 初始台账 ----------

export function seed(): LedgerState {
  const now = Date.now();
  const mk = (square: string, layer: string, bag: string, material: string): Sample => ({
    key: sampleKey(square, layer, bag),
    square,
    layer,
    bag,
    material,
    registeredAt: now,
  });
  const samples: Sample[] = [
    mk("T0203", "第2层", "D07", "炭化木屑"),
    mk("T0203", "第3层", "D12", "动物骨"),
    mk("T0301", "第4层", "D03", "炭化种子"),
  ];
  const receipts: Receipt[] = [
    {
      reportNo: "LDR-2024-1187",
      lab: "十四碳实验室甲",
      bp: 4200,
      sigma: 35,
      curveVersion: "IntCal20",
      receivedAt: now,
      sampleKey: samples[0].key,
      intended: null,
      matchedAt: now,
      returnedAt: null,
    },
    {
      reportNo: "LDR-2024-1204",
      lab: "十四碳实验室甲",
      bp: 4680,
      sigma: 40,
      curveVersion: "IntCal20",
      receivedAt: now,
      sampleKey: samples[1].key,
      intended: null,
      matchedAt: now,
      returnedAt: null,
    },
    {
      // 对不上样本：留待核
      reportNo: "LDR-2024-1230",
      lab: "十四碳实验室乙",
      bp: 3900,
      sigma: 30,
      curveVersion: "IntCal20",
      receivedAt: now,
      sampleKey: null,
      intended: { square: "T0301", layer: "第4层", bag: "D09" },
      matchedAt: null,
      returnedAt: null,
    },
  ];
  const results: Record<string, Calibration> = {};
  for (const r of receipts) {
    if (!r.sampleKey) continue;
    const c = calibrate(r.bp, r.sigma, "IntCal20");
    results[r.sampleKey] = {
      ...c,
      curveVersion: "IntCal20",
      basedOnReport: r.reportNo,
      recalcs: 0,
      updatedAt: now,
    };
  }
  return {
    version: 1,
    currentCurve: "IntCal20",
    samples,
    receipts,
    results,
    approvals: {},
    strataOrder: {},
    batches: {},
    logs: [
      {
        id: uid("log"),
        at: now,
        kind: "system",
        message: "台账已建立：样本按探方/地层/袋号绑定，回执 LDR-2024-1230 待核",
      },
    ],
    publications: [],
  };
}

function load(): LedgerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed();
    const parsed = JSON.parse(raw) as LedgerState;
    if (parsed.version !== 1) return seed();
    // 页面重新打开：上次处理到一半的批次标记为中断，等待从完整批次恢复
    for (const b of Object.values(parsed.batches)) {
      if (b.status === "running") b.status = "interrupted";
    }
    return parsed;
  } catch {
    return seed();
  }
}

// ---------- 动作 ----------

export interface BatchDraft {
  kind: "sample" | "receipt";
  square?: string;
  layer?: string;
  bag?: string;
  material?: string;
  reportNo?: string;
  lab?: string;
  bp?: number;
  sigma?: number;
  curveVersion?: CurveVersion;
  intendedSquare?: string;
  intendedLayer?: string;
  intendedBag?: string;
}

type Action =
  | { type: "addSample"; square: string; layer: string; bag: string; material: string }
  | {
      type: "addReceipt";
      reportNo: string;
      lab: string;
      bp: number;
      sigma: number;
      curveVersion: CurveVersion;
      intendedSquare: string;
      intendedLayer: string;
      intendedBag: string;
    }
  | { type: "matchPending"; reportNo: string; square: string; layer: string; bag: string }
  | { type: "returnReceipt"; reportNo: string }
  | { type: "setCurve"; curve: CurveVersion }
  | { type: "approve"; sampleKey: string; approver: string }
  | { type: "publish" }
  | { type: "batchRegister"; batch: BatchState }
  | { type: "batchResume"; batchId: string; at: number }
  | { type: "batchApplyItem"; batchId: string; itemId: string; at: number }
  | { type: "batchInterrupt"; batchId: string; at: number }
  | { type: "batchComplete"; batchId: string; at: number }
  | { type: "batchDiscard"; batchId: string }
  | { type: "reset" };

function pushLog(
  logs: LogEntry[],
  entry: Omit<LogEntry, "id" | "at">,
  at = Date.now(),
): LogEntry[] {
  return [{ ...entry, id: uid("log"), at }, ...logs].slice(0, 300);
}

/** 把回执按 探方/地层/袋号 对到样本；对不上则留待核；重复报告号只入一次 */
function admitReceipt(
  state: LedgerState,
  draft: Receipt,
  at: number,
): { state: LedgerState; outcome: "matched" | "pending" | "duplicate"; note: string } {
  if (state.receipts.some((x) => x.reportNo === draft.reportNo)) {
    return {
      state,
      outcome: "duplicate",
      note: `回执 ${draft.reportNo} 已入账，重放跳过，不重复挂`,
    };
  }
  const intended = draft.intended;
  const key = intended
    ? sampleKey(intended.square, intended.layer, intended.bag)
    : null;
  const sample = key ? state.samples.find((s) => s.key === key) : undefined;

  if (intended && sample && key) {
    const receipt: Receipt = { ...draft, sampleKey: key, intended: null, matchedAt: at };
    const c = calibrate(receipt.bp, receipt.sigma, state.currentCurve);
    const results: Record<string, Calibration> = {
      ...state.results,
      [key]: {
        ...c,
        curveVersion: state.currentCurve,
        basedOnReport: receipt.reportNo,
        recalcs: 0,
        updatedAt: at,
      },
    };
    return {
      state: {
        ...state,
        receipts: [...state.receipts, receipt],
        results,
        logs: pushLog(state.logs, {
          kind: "receipt",
          message: `回执 ${receipt.reportNo}（${receipt.curveVersion}）已挂到 ${key}，校准区间 ${c.fromCalBP}–${c.toCalBP} cal BP`,
        }, at),
      },
      outcome: "matched",
      note: `回执 ${draft.reportNo} 已挂样本 ${key}`,
    };
  }
  const receipt: Receipt = { ...draft, sampleKey: null, matchedAt: null };
  return {
    state: {
      ...state,
      receipts: [...state.receipts, receipt],
      logs: pushLog(state.logs, {
        kind: "receipt",
        message: `回执 ${draft.reportNo} 对不上样本（${intended?.square ?? "?"}/${intended?.layer ?? "?"}/${intended?.bag ?? "?"}），留待核`,
      }, at),
    },
    outcome: "pending",
    note: `回执 ${draft.reportNo} 对不上样本，留待核`,
  };
}

function receiptFromDraft(p: BatchDraft, state: LedgerState, at: number): Receipt {
  return {
    reportNo: (p.reportNo ?? "").trim(),
    lab: (p.lab ?? "").trim(),
    bp: Number(p.bp) || 0,
    sigma: Number(p.sigma) || 0,
    curveVersion: p.curveVersion ?? state.currentCurve,
    receivedAt: at,
    sampleKey: null,
    intended:
      p.intendedSquare || p.intendedLayer || p.intendedBag
        ? {
            square: (p.intendedSquare ?? "").trim(),
            layer: (p.intendedLayer ?? "").trim(),
            bag: (p.intendedBag ?? "").trim(),
          }
        : null,
    matchedAt: null,
    returnedAt: null,
  };
}

/** 应用一条批次记录（幂等：已存在样本/回执直接跳过），返回说明 */
export function applyBatchItem(state: LedgerState, item: BatchItem, at: number): {
  state: LedgerState;
  note: string;
} {
  const p = item.payload as BatchDraft;
  if (item.kind === "sample") {
    const key = sampleKey(p.square ?? "", p.layer ?? "", p.bag ?? "");
    if (state.samples.some((s) => s.key === key)) {
      return { state, note: `样本 ${key} 已存在，跳过` };
    }
    const sample: Sample = {
      key,
      square: (p.square ?? "").trim(),
      layer: (p.layer ?? "").trim(),
      bag: (p.bag ?? "").trim(),
      material: (p.material ?? "").trim(),
      registeredAt: at,
    };
    return {
      state: {
        ...state,
        samples: [...state.samples, sample],
        logs: pushLog(state.logs, {
          kind: "sample",
          message: `批次登记样本 ${key}（${sample.material}）`,
        }, at),
      },
      note: `样本 ${key} 已登记`,
    };
  }
  return admitReceipt(state, receiptFromDraft(p, state, at), at) as {
    state: LedgerState;
    note: string;
  };
}

export function reducer(state: LedgerState, action: Action): LedgerState {
  const now = Date.now();
  switch (action.type) {
    case "addSample": {
      const key = sampleKey(action.square, action.layer, action.bag);
      if (!action.square.trim() || !action.layer.trim() || !action.bag.trim()) return state;
      if (state.samples.some((s) => s.key === key)) return state;
      const sample: Sample = {
        key,
        square: action.square.trim(),
        layer: action.layer.trim(),
        bag: action.bag.trim(),
        material: action.material.trim(),
        registeredAt: now,
      };
      return {
        ...state,
        samples: [...state.samples, sample],
        logs: pushLog(state.logs, {
          kind: "sample",
          message: `登记样本 ${key}（${sample.material}）`,
        }),
      };
    }

    case "addReceipt": {
      if (!action.reportNo.trim()) return state;
      const intended =
        action.intendedSquare.trim() || action.intendedLayer.trim() || action.intendedBag.trim()
          ? {
              square: action.intendedSquare.trim(),
              layer: action.intendedLayer.trim(),
              bag: action.intendedBag.trim(),
            }
          : null;
      const draft: Receipt = {
        reportNo: action.reportNo.trim(),
        lab: action.lab.trim(),
        bp: action.bp,
        sigma: action.sigma,
        curveVersion: action.curveVersion,
        receivedAt: now,
        sampleKey: null,
        intended,
        matchedAt: null,
        returnedAt: null,
      };
      const admitted = admitReceipt(state, draft, now);
      if (admitted.outcome === "duplicate") {
        return {
          ...state,
          logs: pushLog(state.logs, {
            kind: "receipt",
            message: `重复回执 ${draft.reportNo} 已拒收，同一袋样本不重复入账`,
          }),
        };
      }
      return admitted.state;
    }

    case "matchPending": {
      const r = state.receipts.find((x) => x.reportNo === action.reportNo);
      if (!r || r.sampleKey) return state;
      const key = sampleKey(action.square, action.layer, action.bag);
      if (!state.samples.some((s) => s.key === key)) {
        return {
          ...state,
          logs: pushLog(state.logs, {
            kind: "receipt",
            message: `待核回执 ${r.reportNo} 仍对不上 ${key}，继续待核`,
          }),
        };
      }
      const at = now;
      const matched: Receipt = { ...r, sampleKey: key, intended: null, matchedAt: at };
      const c = calibrate(matched.bp, matched.sigma, state.currentCurve);
      return {
        ...state,
        receipts: state.receipts.map((x) => (x.reportNo === r.reportNo ? matched : x)),
        results: {
          ...state.results,
          [key]: {
            ...c,
            curveVersion: state.currentCurve,
            basedOnReport: matched.reportNo,
            recalcs: 0,
            updatedAt: at,
          },
        },
        logs: pushLog(state.logs, {
          kind: "receipt",
          message: `待核回执 ${r.reportNo} 已核到 ${key}，校准区间 ${c.fromCalBP}–${c.toCalBP} cal BP`,
        }),
      };
    }

    case "returnReceipt": {
      const r = state.receipts.find((x) => x.reportNo === action.reportNo);
      if (!r || r.returnedAt) return state;
      // 退回实验室即撤销该年代：停用它挂出的校准区间（已批复结论仍保留痕迹）
      const results = { ...state.results };
      if (r.sampleKey && results[r.sampleKey]?.basedOnReport === r.reportNo) {
        delete results[r.sampleKey];
      }
      return {
        ...state,
        results,
        receipts: state.receipts.map((x) =>
          x.reportNo === r.reportNo ? { ...x, returnedAt: now } : x,
        ),
        logs: pushLog(state.logs, {
          kind: "receipt",
          message: `回执 ${r.reportNo} 已退回实验室，其未批复校准区间一并停用`,
        }),
      };
    }

    case "setCurve": {
      if (action.curve === state.currentCurve) return state;
      // 换版：未批复区间立即失效并按新版重算；已批复结论保留当时依据
      const recalced = recalibrate(state.results, action.curve, state.receipts, now);
      const count = Object.keys(recalced).length;
      const approvedCount = Object.keys(state.approvals).length;
      return {
        ...state,
        currentCurve: action.curve,
        results: recalced,
        logs: pushLog(state.logs, {
          kind: "curve",
          message: `校准曲线换版为 ${action.curve}：${count} 份未批复区间已失效并重算；${approvedCount} 份已批复结论保留原版本依据`,
        }),
      };
    }

    case "approve": {
      const cal = state.results[action.sampleKey];
      if (!cal || state.approvals[action.sampleKey]) return state;
      const sample = state.samples.find((s) => s.key === action.sampleKey);
      return {
        ...state,
        approvals: {
          ...state.approvals,
          [action.sampleKey]: {
            reportNo: cal.basedOnReport,
            curveVersion: cal.curveVersion,
            fromCalBP: cal.fromCalBP,
            toCalBP: cal.toCalBP,
            approver: action.approver.trim() || "领队",
            approvedAt: now,
          },
        },
        logs: pushLog(state.logs, {
          kind: "approval",
          message: `批复 ${sample?.key ?? action.sampleKey}：${cal.fromCalBP}–${cal.toCalBP} cal BP（依据 ${cal.curveVersion} / ${cal.basedOnReport}），后续换版不再改动`,
        }),
      };
    }

    case "publish": {
      const conflicts = findOrderConflicts(state);
      if (conflicts.length > 0) {
        return {
          ...state,
          logs: pushLog(state.logs, {
            kind: "publish",
            message: `报告发布被挡下：发现 ${conflicts.length} 处地层上下顺序矛盾，需先修正`,
          }),
        };
      }
      const publication: Publication = {
        id: uid("pub"),
        at: now,
        currentCurve: state.currentCurve,
        conclusions: buildPublication(state),
      };
      return {
        ...state,
        publications: [publication, ...state.publications].slice(0, 20),
        logs: pushLog(state.logs, {
          kind: "publish",
          message: `报告已发布（${publication.conclusions.length} 条结论，曲线 ${state.currentCurve}）`,
        }),
      };
    }

    case "batchRegister":
      return {
        ...state,
        batches: { ...state.batches, [action.batch.id]: action.batch },
        logs: pushLog(state.logs, {
          kind: "batch",
          message: `批次「${action.batch.name}」开始导入，共 ${action.batch.items.length} 条`,
        }),
      };

    case "batchResume": {
      const batch = state.batches[action.batchId];
      if (!batch) return state;
      const remaining = batch.items.filter((it) => it.status !== "done").length;
      return {
        ...state,
        batches: {
          ...state.batches,
          [batch.id]: { ...batch, status: "running", failAfter: null, updatedAt: action.at },
        },
        logs: pushLog(state.logs, {
          kind: "batch",
          message: `批次「${batch.name}」从完整批次恢复：只补 ${remaining} 条未完成条目，已挂回执不重复挂`,
        }, action.at),
      };
    }

    case "batchApplyItem": {
      const batch = state.batches[action.batchId];
      if (!batch) return state;
      const idx = batch.items.findIndex((it) => it.id === action.itemId);
      if (idx === -1 || batch.items[idx].status === "done") return state; // 重放不重复
      const applied = applyBatchItem(state, batch.items[idx], action.at);
      return {
        ...applied.state,
        batches: {
          ...applied.state.batches,
          [batch.id]: {
            ...batch,
            updatedAt: action.at,
            items: batch.items.map((it, i) =>
              i === idx ? { ...it, status: "done", note: applied.note } : it,
            ),
          },
        },
      };
    }

    case "batchInterrupt": {
      const batch = state.batches[action.batchId];
      if (!batch) return state;
      const done = batch.items.filter((it) => it.status === "done").length;
      return {
        ...state,
        batches: {
          ...state.batches,
          [batch.id]: { ...batch, status: "interrupted", updatedAt: action.at },
        },
        logs: pushLog(state.logs, {
          kind: "batch",
          message: `批次「${batch.name}」导入失败中断：已完成 ${done}/${batch.items.length}，完整批次已保留，可恢复`,
        }, action.at),
      };
    }

    case "batchComplete": {
      const batch = state.batches[action.batchId];
      if (!batch) return state;
      return {
        ...state,
        batches: {
          ...state.batches,
          [batch.id]: { ...batch, status: "completed", updatedAt: action.at },
        },
        logs: pushLog(state.logs, {
          kind: "batch",
          message: `批次「${batch.name}」处理完成：${batch.items.length} 条`,
        }, action.at),
      };
    }

    case "batchDiscard": {
      const batches = { ...state.batches };
      delete batches[action.batchId];
      return { ...state, batches };
    }

    case "reset":
      return seed();

    default:
      return state;
  }
}

// ---------- React Context ----------

interface Store {
  state: LedgerState;
  dispatch: React.Dispatch<Action>;
  /** 导入一批样本/回执；failAfter 不为 null 时处理到第 N 条模拟失败中断 */
  importBatch: (name: string, drafts: BatchDraft[], failAfter: number | null) => Promise<void>;
  /** 从完整批次恢复：只补未完成条目，已挂的回执不重复挂 */
  resumeBatch: (batchId: string) => Promise<void>;
  conflicts: ReturnType<typeof findOrderConflicts>;
}

const Ctx = createContext<Store | null>(null);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // 页面重新打开仍能继续整理：状态变化即落盘；load 时把 running 改判为 interrupted
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* 存储不可用时仍可内存整理 */
    }
  }, [state]);

  const conflicts = useMemo(() => findOrderConflicts(state), [state]);

  const runItems = async (batchId: string, items: BatchItem[], startIndex: number,
    failAfter: number | null, completion: "complete" | "interrupt") => {
    for (let i = startIndex; i < items.length; i++) {
      await delay(140);
      if (failAfter != null && i >= failAfter) {
        dispatch({ type: "batchInterrupt", batchId, at: Date.now() });
        return;
      }
      dispatch({ type: "batchApplyItem", batchId, itemId: items[i].id, at: Date.now() });
    }
    if (completion === "complete") {
      dispatch({ type: "batchComplete", batchId, at: Date.now() });
    }
  };

  const importBatch = async (name: string, drafts: BatchDraft[], failAfter: number | null) => {
    const batch: BatchState = {
      id: uid("batch"),
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "running",
      failAfter,
      items: drafts.map<BatchItem>((d) => ({
        id: uid("bi"),
        kind: d.kind,
        payload: d,
        status: "pending",
        note: null,
      })),
    };
    dispatch({ type: "batchRegister", batch });
    await runItems(batch.id, batch.items, 0, failAfter, "complete");
  };

  const resumeBatch = async (batchId: string) => {
    // 以页面最新台账为基准（刷新后来自 localStorage），只补未完成条目
    const batch = stateRef.current.batches[batchId];
    if (!batch) return;
    const firstPending = batch.items.findIndex((it) => it.status !== "done");
    if (firstPending === -1) {
      dispatch({ type: "batchComplete", batchId, at: Date.now() });
      return;
    }
    dispatch({ type: "batchResume", batchId, at: Date.now() });
    await runItems(batchId, batch.items, firstPending, null, "complete");
  };

  const value: Store = {
    state,
    dispatch,
    importBatch,
    resumeBatch,
    conflicts,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
