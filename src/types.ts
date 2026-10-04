// 测年台账领域类型

/** 校准曲线版本（换版后未批复结论按新版重算，已批复结论保留当时版本） */
export type CurveVersion = "IntCal13" | "IntCal20" | "IntCal25";

export const CURVE_VERSIONS: CurveVersion[] = ["IntCal13", "IntCal20", "IntCal25"];

export const CURVE_NOTE: Record<CurveVersion, string> = {
  IntCal13: "2013 版北半球大气曲线",
  IntCal20: "2020 版北半球大气曲线",
  IntCal25: "2025 版北半球大气曲线",
};

/** 样本：按 探方 + 地层 + 袋号 唯一绑定 */
export interface Sample {
  key: string;
  square: string;
  layer: string;
  bag: string;
  material: string;
  registeredAt: number;
}

/**
 * 实验室回执：报告号全局唯一（重复报告只入一次）。
 * sampleKey 为 null 表示对不上样本，先留待核；intended 保留回执上写的目标。
 */
export interface Receipt {
  reportNo: string;
  lab: string;
  bp: number;
  sigma: number;
  curveVersion: CurveVersion;
  receivedAt: number;
  sampleKey: string | null;
  intended: { square: string; layer: string; bag: string } | null;
  matchedAt: number | null;
  returnedAt: number | null;
}

/** 样本当前（未批复）校准结果，随项目曲线版本重算 */
export interface Calibration {
  fromCalBP: number; // 年轻端（较小 BP）
  toCalBP: number; // 老端（较大 BP）
  curveVersion: CurveVersion;
  basedOnReport: string;
  recalcs: number;
  updatedAt: number;
}

/** 已批复结论：批复时冻结，曲线换版后仍保留当时依据 */
export interface Approval {
  reportNo: string;
  curveVersion: CurveVersion;
  fromCalBP: number;
  toCalBP: number;
  approver: string;
  approvedAt: number;
}

export interface LogEntry {
  id: string;
  at: number;
  kind: "sample" | "receipt" | "curve" | "approval" | "batch" | "publish" | "system";
  message: string;
}

export interface BatchItem {
  id: string;
  kind: "sample" | "receipt";
  payload: unknown;
  status: "pending" | "done" | "error";
  note: string | null;
}

export interface BatchState {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** interrupted：导入中断，可从完整批次继续；running：本次正在处理；completed：全部完成 */
  status: "interrupted" | "running" | "completed";
  /** 模拟中断：本次续跑处理多少条后中断（用于演示导入失败） */
  failAfter: number | null;
  items: BatchItem[];
}

export interface PublishedConclusion {
  sampleKey: string;
  square: string;
  layer: string;
  bag: string;
  reportNo: string | null;
  fromCalBP: number;
  toCalBP: number;
  curveVersion: CurveVersion;
  approved: boolean;
}

export interface Publication {
  id: string;
  at: number;
  currentCurve: CurveVersion;
  conclusions: PublishedConclusion[];
}

export interface LedgerState {
  version: 1;
  currentCurve: CurveVersion;
  samples: Sample[];
  receipts: Receipt[];
  results: Record<string, Calibration>;
  approvals: Record<string, Approval>;
  /** 探方内地层登记顺序（自上而下），仅第N层可解析序号的参与上下序校验 */
  strataOrder: Record<string, string[]>;
  batches: Record<string, BatchState>;
  logs: LogEntry[];
  publications: Publication[];
}
