/**
 * 校准曲线（内置简化模型，用于流程演示）。
 * 不同版本的曲线对同一 BP 年代给出不同的日历年偏移，
 * 换版后未批复结论需要按新版本重算。
 */
export interface CalibrationCurve {
  id: string;
  label: string;
  note: string;
  shift: (bp: number) => number;
}

export const CURVES: CalibrationCurve[] = [
  {
    id: "IntCal20",
    label: "IntCal20",
    note: "2020 版国际校准曲线，台账现行基准",
    shift: (bp) => 55 + bp * 0.018,
  },
  {
    id: "IntCal21R",
    label: "IntCal21R",
    note: "2021 修订版：近三千年段整体上调，换版后未批复区间须重算",
    shift: (bp) => 95 + bp * 0.024,
  },
];

export function getCurve(id: string): CalibrationCurve {
  return CURVES.find((c) => c.id === id) ?? CURVES[0];
}

export function nextCurve(currentId: string): CalibrationCurve {
  const idx = CURVES.findIndex((c) => c.id === currentId);
  return CURVES[(idx + 1) % CURVES.length];
}

/** 用指定曲线把 BP 年代校准为 calBP 区间 */
export function calibrate(
  bpAge: number,
  bpError: number,
  curveId: string
): { calMin: number; calMax: number } {
  const curve = getCurve(curveId);
  const center = bpAge + curve.shift(bpAge);
  const half = 2 * bpError + 15;
  return {
    calMin: Math.round(center - half),
    calMax: Math.round(center + half),
  };
}

/** calBP 转纪年描述（calBP 1950 = 公元元年前后） */
export function eraLabel(calBP: number): string {
  const year = 1950 - calBP;
  if (year > 0) return `公元${year}年`;
  if (year === 0) return "公元元年前后";
  return `公元前${-year}年`;
}

/** 区间展示：calBP 为主，附纪年（先早后晚） */
export function rangeLabel(calMin: number, calMax: number): string {
  return `calBP ${calMin}–${calMax}（约${eraLabel(calMax)}至${eraLabel(calMin)}）`;
}
