import { calibrate } from "./curves";
import { findConflicts } from "./stratigraphy";
import { sampleKeyOf } from "./types";
import type {
  BatchItemInput,
  Conclusion,
  DatingSample,
  ImportBatch,
  LabReceipt,
  LedgerState,
  PendingReceipt,
  Publication,
} from "./types";

export const STORAGE_KEY = "hxwl-10-dating-ledger/v1";

const now = () => new Date().toISOString();

function makeConclusion(receipt: LabReceipt, sampleKey: string, curveVersion: string): Conclusion {
  const { calMin, calMax } = calibrate(receipt.bpAge, receipt.bpError, curveVersion);
  return {
    id: `C-${receipt.reportNo}`,
    reportNo: receipt.reportNo,
    sampleKey,
    bpAge: receipt.bpAge,
    bpError: receipt.bpError,
    curveVersion,
    calMin,
    calMax,
    status: "pending",
    history: [],
    createdAt: now(),
    updatedAt: now(),
  };
}

export type ApplyOutcome = "attached" | "pending" | "duplicate";

function normalizeReceipt(input: BatchItemInput, fallbackCurve: string): LabReceipt {
  return {
    reportNo: input.reportNo.trim(),
    lab: (input.lab ?? "").trim() || "未标注实验室",
    trench: input.trench.trim(),
    layer: input.layer.trim(),
    bagNo: input.bagNo.trim(),
    bpAge: Number(input.bpAge),
    bpError: Number(input.bpError),
    curveVersion: (input.curveVersion ?? "").trim() || fallbackCurve,
    receivedAt: now(),
  };
}

/**
 * 挂接一份回执（幂等）：
 * - 报告号已存在（已挂接 / 待核 / 已作废）→ duplicate，只入一次；
 * - 探方+地层+袋号对得上已登记样本 → 挂接并生成待批复结论；
 * - 对不上 → 留待核。
 */
export function applyReceipt(
  state: LedgerState,
  input: BatchItemInput
): { next: LedgerState; outcome: ApplyOutcome } {
  const receipt = normalizeReceipt(input, state.curveVersion);
  if (!receipt.reportNo) return { next: state, outcome: "duplicate" };
  const seen =
    state.receipts.some((r) => r.reportNo === receipt.reportNo) ||
    state.pendingReceipts.some((r) => r.reportNo === receipt.reportNo) ||
    state.ignoredReportNos.includes(receipt.reportNo);
  if (seen) return { next: state, outcome: "duplicate" };

  const key = sampleKeyOf(receipt.trench, receipt.layer, receipt.bagNo);
  const sample = state.samples.find((s) => s.key === key);
  if (!sample) {
    const pending: PendingReceipt = {
      ...receipt,
      reason: `未登记样本：${receipt.trench} / ${receipt.layer} / ${receipt.bagNo}`,
    };
    return {
      next: { ...state, pendingReceipts: [...state.pendingReceipts, pending] },
      outcome: "pending",
    };
  }
  return {
    next: {
      ...state,
      receipts: [...state.receipts, receipt],
      conclusions: [...state.conclusions, makeConclusion(receipt, key, state.curveVersion)],
    },
    outcome: "attached",
  };
}

export type Action =
  | {
      type: "registerSample";
      input: { trench: string; layer: string; layerOrder: number; bagNo: string; material: string };
    }
  | { type: "receiveReceipt"; input: BatchItemInput }
  | { type: "createBatch"; batch: ImportBatch }
  | { type: "applyBatchItem"; batchId: string; item: BatchItemInput }
  | { type: "batchFailed"; batchId: string; note: string }
  | { type: "batchDone"; batchId: string }
  | { type: "attachPending"; reportNo: string; sampleKey: string }
  | { type: "discardPending"; reportNo: string }
  | { type: "approveConclusion"; id: string; by: string }
  | { type: "upgradeCurve"; to: string }
  | { type: "publishTrench"; trench: string }
  | { type: "reset" };

export function reducer(state: LedgerState, action: Action): LedgerState {
  switch (action.type) {
    case "registerSample": {
      const trench = action.input.trench.trim();
      const layer = action.input.layer.trim();
      const bagNo = action.input.bagNo.trim();
      if (!trench || !layer || !bagNo) return state;
      const key = sampleKeyOf(trench, layer, bagNo);
      if (state.samples.some((s) => s.key === key)) return state; // 唯一绑定
      // 同一探方同一地层已有顺序时沿用，避免同层两个顺序
      const existing = state.samples.find((s) => s.trench === trench && s.layer === layer);
      const layerOrder = existing ? existing.layerOrder : action.input.layerOrder;
      const sample: DatingSample = {
        key,
        trench,
        layer,
        layerOrder,
        bagNo,
        material: action.input.material.trim() || "未注明",
        createdAt: now(),
      };
      return { ...state, samples: [...state.samples, sample] };
    }

    case "receiveReceipt":
      return applyReceipt(state, action.input).next;

    case "createBatch":
      return { ...state, batches: [action.batch, ...state.batches] };

    case "applyBatchItem": {
      const batch = state.batches.find((b) => b.id === action.batchId);
      if (!batch || batch.status === "done") return state;
      const reportNo = action.item.reportNo.trim();
      if (batch.appliedReportNos.includes(reportNo)) return state; // 重放检查点
      const applied = applyReceipt(state, action.item);
      const batches = applied.next.batches.map((b) =>
        b.id === action.batchId
          ? {
              ...b,
              appliedReportNos: [...b.appliedReportNos, reportNo],
              attached: b.attached + (applied.outcome === "attached" ? 1 : 0),
              pending: b.pending + (applied.outcome === "pending" ? 1 : 0),
              duplicates: b.duplicates + (applied.outcome === "duplicate" ? 1 : 0),
            }
          : b
      );
      return { ...applied.next, batches };
    }

    case "batchFailed":
      return {
        ...state,
        batches: state.batches.map((b) =>
          b.id === action.batchId ? { ...b, status: "failed", note: action.note } : b
        ),
      };

    case "batchDone":
      return {
        ...state,
        batches: state.batches.map((b) =>
          b.id === action.batchId ? { ...b, status: "done", note: undefined } : b
        ),
      };

    case "attachPending": {
      const pending = state.pendingReceipts.find((r) => r.reportNo === action.reportNo);
      const sample = state.samples.find((s) => s.key === action.sampleKey);
      if (!pending || !sample) return state;
      const { reason: _reason, ...receipt } = pending;
      return {
        ...state,
        pendingReceipts: state.pendingReceipts.filter((r) => r.reportNo !== action.reportNo),
        receipts: [...state.receipts, receipt],
        conclusions: [
          ...state.conclusions,
          makeConclusion(receipt, sample.key, state.curveVersion),
        ],
      };
    }

    case "discardPending": {
      const pending = state.pendingReceipts.find((r) => r.reportNo === action.reportNo);
      if (!pending) return state;
      return {
        ...state,
        pendingReceipts: state.pendingReceipts.filter((r) => r.reportNo !== action.reportNo),
        ignoredReportNos: [...state.ignoredReportNos, pending.reportNo],
      };
    }

    case "approveConclusion":
      return {
        ...state,
        conclusions: state.conclusions.map((c) =>
          c.id === action.id && c.status === "pending"
            ? { ...c, status: "approved", approvedAt: now(), approvedBy: action.by }
            : c
        ),
      };

    case "upgradeCurve": {
      const t = now();
      return {
        ...state,
        curveVersion: action.to,
        conclusions: state.conclusions.map((c) => {
          if (c.status === "approved") return c; // 已批复结论保留当时依据
          const { calMin, calMax } = calibrate(c.bpAge, c.bpError, action.to);
          return {
            ...c,
            history: [
              ...c.history,
              {
                curveVersion: c.curveVersion,
                calMin: c.calMin,
                calMax: c.calMax,
                invalidatedAt: t,
                reason: `校准曲线升级为 ${action.to}，未批复区间失效重算`,
              },
            ],
            curveVersion: action.to,
            calMin,
            calMax,
            updatedAt: t,
          };
        }),
      };
    }

    case "publishTrench": {
      // 层序矛盾未消除前挡住发布
      const blocked = findConflicts(state.samples, state.conclusions).some(
        (c) => c.trench === action.trench
      );
      if (blocked) return state;
      const reportNos = state.conclusions
        .filter(
          (c) => state.samples.find((s) => s.key === c.sampleKey)?.trench === action.trench
        )
        .map((c) => c.reportNo);
      if (reportNos.length === 0) return state;
      const publication: Publication = {
        id: `PUB-${action.trench}-${state.publications.length + 1}`,
        trench: action.trench,
        publishedAt: now(),
        curveVersion: state.curveVersion,
        reportNos,
      };
      return { ...state, publications: [publication, ...state.publications] };
    }

    case "reset":
      return seedState();
  }
}

/** 初始示例台账：含一条已批复结论（演示曲线换版时保留当时依据）与一条待核回执 */
export function seedState(): LedgerState {
  const curveVersion = "IntCal20";
  const t0 = "2026-09-18T08:30:00.000Z";
  const samples: DatingSample[] = [
    { key: sampleKeyOf("T0203", "第2层", "袋07"), trench: "T0203", layer: "第2层", layerOrder: 2, bagNo: "袋07", material: "炭屑", createdAt: t0 },
    { key: sampleKeyOf("T0203", "第2层", "袋08"), trench: "T0203", layer: "第2层", layerOrder: 2, bagNo: "袋08", material: "兽骨", createdAt: t0 },
    { key: sampleKeyOf("T0203", "第3层", "袋03"), trench: "T0203", layer: "第3层", layerOrder: 3, bagNo: "袋03", material: "炭屑", createdAt: t0 },
    { key: sampleKeyOf("T0203", "第3层", "袋05"), trench: "T0203", layer: "第3层", layerOrder: 3, bagNo: "袋05", material: "兽骨", createdAt: t0 },
    { key: sampleKeyOf("T0204", "H12灰坑", "袋01"), trench: "T0204", layer: "H12灰坑", layerOrder: 2, bagNo: "袋01", material: "炭屑", createdAt: t0 },
    { key: sampleKeyOf("T0301", "F2房址", "袋02"), trench: "T0301", layer: "F2房址", layerOrder: 3, bagNo: "袋02", material: "木炭", createdAt: t0 },
  ];
  const r1: LabReceipt = { reportNo: "BA-2401", lab: "北京大学考古实验室", trench: "T0203", layer: "第2层", bagNo: "袋07", bpAge: 1850, bpError: 30, curveVersion, receivedAt: "2026-09-19T09:00:00.000Z" };
  const r2: LabReceipt = { reportNo: "BA-2402", lab: "北京大学考古实验室", trench: "T0203", layer: "第3层", bagNo: "袋03", bpAge: 2150, bpError: 35, curveVersion, receivedAt: "2026-09-19T09:00:00.000Z" };
  const r3: LabReceipt = { reportNo: "BA-2403", lab: "社科院考古所实验室", trench: "T0204", layer: "H12灰坑", bagNo: "袋01", bpAge: 1980, bpError: 30, curveVersion, receivedAt: "2026-09-20T09:00:00.000Z" };
  const c1: Conclusion = {
    ...makeConclusion(r1, samples[0].key, curveVersion),
    status: "approved",
    approvedBy: "领队",
    approvedAt: "2026-09-22T10:00:00.000Z",
    createdAt: "2026-09-19T09:00:00.000Z",
    updatedAt: "2026-09-22T10:00:00.000Z",
  };
  const c2: Conclusion = { ...makeConclusion(r2, samples[2].key, curveVersion), createdAt: "2026-09-19T09:00:00.000Z" };
  const c3: Conclusion = { ...makeConclusion(r3, samples[4].key, curveVersion), createdAt: "2026-09-20T09:00:00.000Z" };
  const pending: PendingReceipt = {
    reportNo: "BA-2404",
    lab: "社科院考古所实验室",
    trench: "T0203",
    layer: "第4层",
    bagNo: "袋09",
    bpAge: 2400,
    bpError: 40,
    curveVersion,
    receivedAt: "2026-09-25T09:00:00.000Z",
    reason: "未登记样本：T0203 / 第4层 / 袋09",
  };
  return {
    version: 1,
    curveVersion,
    samples,
    receipts: [r1, r2, r3],
    pendingReceipts: [pending],
    ignoredReportNos: [],
    conclusions: [c1, c2, c3],
    batches: [],
    publications: [],
  };
}

/** 读取本地台账；上次页面关闭时仍在导入的批次标记为可恢复 */
export function loadState(): LedgerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw) as LedgerState;
    if (parsed.version !== 1 || !Array.isArray(parsed.samples)) return seedState();
    return {
      ...parsed,
      batches: parsed.batches.map((b) =>
        b.status === "importing"
          ? { ...b, status: "failed" as const, note: "页面关闭导致导入中断，可从完整批次恢复" }
          : b
      ),
    };
  } catch {
    return seedState();
  }
}

export function saveState(state: LedgerState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 本地写入失败不阻断整理
  }
}
