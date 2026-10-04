/** 测年台账领域模型 */

/** 样本：按 探方 + 地层 + 袋号 唯一绑定 */
export interface DatingSample {
  key: string;
  trench: string; // 探方
  layer: string; // 地层
  layerOrder: number; // 同探方内层位顺序，数值小者在上（更晚）
  bagNo: string; // 袋号
  material: string; // 样本材质
  createdAt: string;
}

/** 实验室回执：带报告号与曲线版本 */
export interface LabReceipt {
  reportNo: string; // 报告号，全局唯一
  lab: string; // 实验室
  trench: string;
  layer: string;
  bagNo: string;
  bpAge: number; // 未校准 BP 年代
  bpError: number; // 误差 ±
  curveVersion: string; // 回执标注的校准曲线版本
  receivedAt: string;
}

/** 对不上样本的回执：先留待核 */
export interface PendingReceipt extends LabReceipt {
  reason: string;
}

/** 结论历史：曲线换版后失效的旧区间留痕 */
export interface ConclusionHistoryEntry {
  curveVersion: string;
  calMin: number;
  calMax: number;
  invalidatedAt: string;
  reason: string;
}

/** 年代结论：一份已挂接回执对应一条 */
export interface Conclusion {
  id: string;
  reportNo: string;
  sampleKey: string;
  bpAge: number;
  bpError: number;
  curveVersion: string; // 当前区间所依据的曲线版本
  calMin: number; // 校准区间下界 calBP（最晚）
  calMax: number; // 校准区间上界 calBP（最早）
  status: "pending" | "approved"; // 未批复 / 已批复
  history: ConclusionHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
}

/** 批次导入的单条回执输入 */
export interface BatchItemInput {
  reportNo: string;
  lab?: string;
  trench: string;
  layer: string;
  bagNo: string;
  bpAge: number;
  bpError: number;
  curveVersion?: string;
}

/** 导入批次：保留完整清单与逐条进度，失败可恢复 */
export interface ImportBatch {
  id: string;
  createdAt: string;
  status: "importing" | "failed" | "done";
  note?: string;
  items: BatchItemInput[];
  appliedReportNos: string[]; // 已完成回执的检查点
  attached: number;
  pending: number;
  duplicates: number;
}

/** 已发布的年代报告 */
export interface Publication {
  id: string;
  trench: string;
  publishedAt: string;
  curveVersion: string;
  reportNos: string[];
}

export interface LedgerState {
  version: 1;
  curveVersion: string; // 台账当前校准曲线版本
  samples: DatingSample[];
  receipts: LabReceipt[]; // 已挂接到样本的回执
  pendingReceipts: PendingReceipt[]; // 待核回执
  ignoredReportNos: string[]; // 已作废报告号，重放不再入
  conclusions: Conclusion[];
  batches: ImportBatch[];
  publications: Publication[];
}

/** 样本唯一键：探方 | 地层 | 袋号 */
export function sampleKeyOf(trench: string, layer: string, bagNo: string): string {
  return [trench, layer, bagNo].map((s) => s.trim()).join("|");
}

export function sampleLabel(s: { trench: string; layer: string; bagNo: string }): string {
  return `${s.trench} · ${s.layer} · ${s.bagNo}`;
}
