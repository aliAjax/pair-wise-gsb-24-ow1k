import type { Conclusion, DatingSample } from "./types";

/** 矛盾中涉及的一方（某份结论及其样本） */
export interface ConflictSide {
  sampleKey: string;
  trench: string;
  layer: string;
  bagNo: string;
  reportNo: string;
  calMin: number;
  calMax: number;
}

/** 层序矛盾：上层样本的最早可能年代仍老于下层样本的最晚可能年代 */
export interface StratConflict {
  id: string;
  trench: string;
  upper: ConflictSide;
  lower: ConflictSide;
}

function toSide(sample: DatingSample, c: Conclusion): ConflictSide {
  return {
    sampleKey: sample.key,
    trench: sample.trench,
    layer: sample.layer,
    bagNo: sample.bagNo,
    reportNo: c.reportNo,
    calMin: c.calMin,
    calMax: c.calMax,
  };
}

/**
 * 检查同一探方内的层位上下顺序：
 * 层位顺序小的在上，应更晚（calBP 更小）。
 * 若上层某样本的最早边界（calMin）仍老于下层某样本的最晚边界（calMax），
 * 则两区间无论如何取舍都与地层顺序矛盾。
 */
export function findConflicts(
  samples: DatingSample[],
  conclusions: Conclusion[]
): StratConflict[] {
  const byKey = new Map(samples.map((s) => [s.key, s]));
  const rows = conclusions
    .map((c) => ({ c, s: byKey.get(c.sampleKey) }))
    .filter((x): x is { c: Conclusion; s: DatingSample } => Boolean(x.s));

  const conflicts: StratConflict[] = [];
  for (const a of rows) {
    for (const b of rows) {
      if (a === b) continue;
      if (a.s.trench !== b.s.trench) continue;
      if (a.s.layerOrder < b.s.layerOrder && a.c.calMin > b.c.calMax) {
        conflicts.push({
          id: `${a.c.id}~${b.c.id}`,
          trench: a.s.trench,
          upper: toSide(a.s, a.c),
          lower: toSide(b.s, b.c),
        });
      }
    }
  }
  return conflicts;
}

/** 单个地层的年代包络视图 */
export interface LayerView {
  layer: string;
  layerOrder: number;
  calMin: number;
  calMax: number;
  members: {
    sampleKey: string;
    bagNo: string;
    reportNo: string;
    calMin: number;
    calMax: number;
    status: Conclusion["status"];
  }[];
}

export interface TrenchView {
  trench: string;
  layers: LayerView[];
  conclusionCount: number;
}

/** 按探方 → 地层（自上而下）汇总当前结论，供校验与发布使用 */
export function buildTrenchViews(
  samples: DatingSample[],
  conclusions: Conclusion[]
): TrenchView[] {
  const byKey = new Map(samples.map((s) => [s.key, s]));
  const byTrench = new Map<string, Map<string, LayerView>>();

  for (const c of conclusions) {
    const s = byKey.get(c.sampleKey);
    if (!s) continue;
    let layers = byTrench.get(s.trench);
    if (!layers) {
      layers = new Map();
      byTrench.set(s.trench, layers);
    }
    let view = layers.get(s.layer);
    if (!view) {
      view = {
        layer: s.layer,
        layerOrder: s.layerOrder,
        calMin: c.calMin,
        calMax: c.calMax,
        members: [],
      };
      layers.set(s.layer, view);
    }
    view.calMin = Math.min(view.calMin, c.calMin);
    view.calMax = Math.max(view.calMax, c.calMax);
    view.members.push({
      sampleKey: s.key,
      bagNo: s.bagNo,
      reportNo: c.reportNo,
      calMin: c.calMin,
      calMax: c.calMax,
      status: c.status,
    });
  }

  return [...byTrench.entries()]
    .map(([trench, layers]) => {
      const sorted = [...layers.values()].sort((a, b) => a.layerOrder - b.layerOrder);
      return {
        trench,
        layers: sorted,
        conclusionCount: sorted.reduce((n, l) => n + l.members.length, 0),
      };
    })
    .sort((a, b) => a.trench.localeCompare(b.trench));
}
