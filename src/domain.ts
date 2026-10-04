import type {
  Approval,
  Calibration,
  CurveVersion,
  LedgerState,
  PublishedConclusion,
  Receipt,
  Sample,
} from "./types";

export const sampleKey = (square: string, layer: string, bag: string) =>
  `${square.trim()}|${layer.trim()}|${bag.trim()}`;

/** 简化的放射性碳校准：实验室 BP±σ 经曲线版本做确定性偏移与展宽，便于演示重算差异。 */
export function calibrate(
  bp: number,
  sigma: number,
  curve: CurveVersion,
): { fromCalBP: number; toCalBP: number } {
  // 各版本曲线对同一测量值给出的系统偏移（cal BP）
  const shift: Record<CurveVersion, number> = {
    IntCal13: 0,
    IntCal20: 32,
    IntCal25: 47,
  };
  // 新版本曲线分辨率更高，区间略收紧
  const widthFactor: Record<CurveVersion, number> = {
    IntCal13: 2,
    IntCal20: 1.9,
    IntCal25: 1.8,
  };
  const center = bp + shift[curve];
  const half = sigma * widthFactor[curve];
  return {
    fromCalBP: Math.round(center - half),
    toCalBP: Math.round(center + half),
  };
}

/** 第N层 → N；灰坑/房址等非地层单位返回 null（不参与上下序校验） */
export function layerOrdinal(layer: string): number | null {
  const m = layer.match(/第\s*(\d+)\s*层/);
  return m ? Number(m[1]) : null;
}

/** 样本当前生效的年代区间：已批复用批复冻结值，否则用未批复校准结果 */
export function effectiveRange(
  state: LedgerState,
  key: string,
): { fromCalBP: number; toCalBP: number; curveVersion: CurveVersion; approved: boolean } | null {
  const approval = state.approvals[key];
  if (approval) {
    return {
      fromCalBP: approval.fromCalBP,
      toCalBP: approval.toCalBP,
      curveVersion: approval.curveVersion,
      approved: true,
    };
  }
  const cal = state.results[key];
  if (!cal) return null;
  return {
    fromCalBP: cal.fromCalBP,
    toCalBP: cal.toCalBP,
    curveVersion: cal.curveVersion,
    approved: false,
  };
}

export interface OrderConflict {
  square: string;
  upper: { layer: string; sampleKey: string };
  lower: { layer: string; sampleKey: string };
}

/**
 * 地层上下顺序校验：同一探方内地层号小的在上（更晚、cal BP 更小）。
 * 上层样本区间老端不得晚于下层样本区间年轻端（允许相切），否则年代倒置。
 * 已批复与未批复区间都参与——批复保留依据，但仍要挡住包含矛盾的报告发布。
 */
export function findOrderConflicts(state: LedgerState): OrderConflict[] {
  const conflicts: OrderConflict[] = [];
  const bySquare = new Map<string, Sample[]>();
  for (const s of state.samples) {
    if (layerOrdinal(s.layer) === null) continue;
    const list = bySquare.get(s.square) ?? [];
    list.push(s);
    bySquare.set(s.square, list);
  }
  for (const [square, list] of bySquare) {
    const withRange = list
      .map((s) => ({ s, range: effectiveRange(state, s.key) }))
      .filter((x): x is { s: Sample; range: NonNullable<ReturnType<typeof effectiveRange>> } =>
        Boolean(x.range),
      );
    withRange.sort(
      (a, b) => (layerOrdinal(a.s.layer) ?? 0) - (layerOrdinal(b.s.layer) ?? 0),
    );
    for (let i = 0; i < withRange.length; i++) {
      for (let j = i + 1; j < withRange.length; j++) {
        const upper = withRange[i];
        const lower = withRange[j];
        if (
          layerOrdinal(upper.s.layer) !== layerOrdinal(lower.s.layer) &&
          upper.range.fromCalBP > lower.range.toCalBP
        ) {
          conflicts.push({
            square,
            upper: { layer: upper.s.layer, sampleKey: upper.s.key },
            lower: { layer: lower.s.layer, sampleKey: lower.s.key },
          });
        }
      }
    }
  }
  return conflicts;
}

export function buildPublication(state: LedgerState): PublishedConclusion[] {
  return state.samples.map((s) => {
    const range = effectiveRange(state, s.key);
    const approval = state.approvals[s.key];
    const receipt: Receipt | undefined = state.receipts.find(
      (r) => r.sampleKey === s.key,
    );
    return {
      sampleKey: s.key,
      square: s.square,
      layer: s.layer,
      bag: s.bag,
      reportNo: receipt?.reportNo ?? null,
      fromCalBP: range?.fromCalBP ?? 0,
      toCalBP: range?.toCalBP ?? 0,
      curveVersion: range?.curveVersion ?? state.currentCurve,
      approved: Boolean(approval),
    };
  });
}

export function recalibrate(results: Record<string, Calibration>, curve: CurveVersion,
  receipts: Receipt[], now: number): Record<string, Calibration> {
  const next: Record<string, Calibration> = {};
  for (const [key, cal] of Object.entries(results)) {
    const receipt = receipts.find((r) => r.reportNo === cal.basedOnReport && r.sampleKey === key);
    if (!receipt) {
      next[key] = cal;
      continue;
    }
    const r = calibrate(receipt.bp, receipt.sigma, curve);
    next[key] = {
      ...cal,
      ...r,
      curveVersion: curve,
      recalcs: cal.recalcs + 1,
      updatedAt: now,
    };
  }
  return next;
}

export function rangeLabel(r: { fromCalBP: number; toCalBP: number } | null): string {
  if (!r) return "—";
  return `${r.fromCalBP}–${r.toCalBP} cal BP`;
}

export function approvalKeyOf(a: Approval) {
  return `${a.reportNo}@${a.curveVersion}`;
}
