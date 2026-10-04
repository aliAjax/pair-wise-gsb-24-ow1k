import { applyReceipt, reducer, seedState } from "../src/ledger/store";
import { findConflicts } from "../src/ledger/stratigraphy";
import type { BatchItemInput, ImportBatch, LedgerState } from "../src/ledger/types";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}`);
  }
}

const s0 = seedState();
check("种子含 6 样本 / 3 回执 / 1 待核 / 1 已批复", s0.samples.length === 6 && s0.receipts.length === 3 && s0.pendingReceipts.length === 1 && s0.conclusions.filter(c => c.status === "approved").length === 1);

// 1. 重复报告只入一次
const dup: BatchItemInput = { reportNo: "BA-2402", trench: "T0203", layer: "第3层", bagNo: "袋03", bpAge: 2150, bpError: 35 };
const r1 = applyReceipt(s0, dup);
check("重复报告 → duplicate 且状态不变", r1.outcome === "duplicate" && r1.next === s0);

// 2. 对不上样本 → 待核
const unmatched: BatchItemInput = { reportNo: "BA-2407", trench: "T0203", layer: "第4层", bagNo: "袋11", bpAge: 2600, bpError: 45 };
const r2 = applyReceipt(s0, unmatched);
check("对不上样本 → pending 留待核", r2.outcome === "pending" && r2.next.pendingReceipts.length === 2);

// 3. 登记缺失样本后可挂接
const s1 = reducer(r2.next, { type: "registerSample", input: { trench: "T0203", layer: "第4层", layerOrder: 4, bagNo: "袋11", material: "炭屑" } });
const key = s1.samples.find(s => s.bagNo === "袋11")!.key;
const s2 = reducer(s1, { type: "attachPending", reportNo: "BA-2407", sampleKey: key });
check("挂接待核回执 → 生成结论", s2.pendingReceipts.length === 1 && s2.conclusions.length === 4);

// 4. 样本唯一绑定
const s3 = reducer(s2, { type: "registerSample", input: { trench: "T0203", layer: "第4层", layerOrder: 4, bagNo: "袋11", material: "x" } });
check("重复样本登记被拒绝", s3 === s2);

// 5. 曲线升级：未批复重算，已批复保留
const approvedBefore = s2.conclusions.find(c => c.reportNo === "BA-2401")!;
const s4 = reducer(s2, { type: "upgradeCurve", to: "IntCal21R" });
const approvedAfter = s4.conclusions.find(c => c.reportNo === "BA-2401")!;
const pendingAfter = s4.conclusions.find(c => c.reportNo === "BA-2402")!;
check("已批复保留当时依据", approvedAfter.curveVersion === "IntCal20" && approvedAfter.calMin === approvedBefore.calMin && approvedAfter.calMax === approvedBefore.calMax);
check("未批复按新曲线重算且旧区间留痕", pendingAfter.curveVersion === "IntCal21R" && pendingAfter.calMin !== 2159 && pendingAfter.history.length === 1 && pendingAfter.history[0].curveVersion === "IntCal20");

// 6. 层序矛盾挡住发布
const conflictItem: BatchItemInput = { reportNo: "BA-2405", trench: "T0203", layer: "第2层", bagNo: "袋08", bpAge: 2650, bpError: 35 };
const s5 = reducer(s2, { type: "receiveReceipt", input: conflictItem });
const conflicts = findConflicts(s5.samples, s5.conclusions);
check("上层老于下层 → 检出矛盾并定位样本", conflicts.length === 1 && conflicts[0].trench === "T0203" && conflicts[0].upper.bagNo === "袋08" && conflicts[0].lower.bagNo === "袋03");
const s6 = reducer(s5, { type: "publishTrench", trench: "T0203" });
check("矛盾探方发布被挡住", s6.publications.length === 0);
const s7 = reducer(s5, { type: "publishTrench", trench: "T0204" });
check("无矛盾探方可发布", s7.publications.length === 1 && s7.publications[0].trench === "T0204");

// 7. 批次中断 → 从完整批次恢复，只补未完成，重放不重复
const items: BatchItemInput[] = [
  { reportNo: "BA-2402", trench: "T0203", layer: "第3层", bagNo: "袋03", bpAge: 2150, bpError: 35 }, // 重复
  { reportNo: "BA-2405", trench: "T0203", layer: "第2层", bagNo: "袋08", bpAge: 2650, bpError: 35 }, // 挂接
  { reportNo: "BA-2406", trench: "T0301", layer: "F2房址", bagNo: "袋02", bpAge: 2300, bpError: 40 }, // 挂接
  { reportNo: "BA-2408", trench: "T0204", layer: "H12灰坑", bagNo: "袋02", bpAge: 2050, bpError: 30 }, // 待核
];
const batch: ImportBatch = { id: "B-test", createdAt: "t", status: "importing", items, appliedReportNos: [], attached: 0, pending: 0, duplicates: 0 };
let st: LedgerState = reducer(s0, { type: "createBatch", batch });
// 模拟导入 2 条后中断
st = reducer(st, { type: "applyBatchItem", batchId: "B-test", item: items[0] });
st = reducer(st, { type: "applyBatchItem", batchId: "B-test", item: items[1] });
st = reducer(st, { type: "batchFailed", batchId: "B-test", note: "中断" });
const mid = st.batches[0];
check("中断时进度 2/4（1 重复 1 挂接）", mid.status === "failed" && mid.appliedReportNos.length === 2 && mid.duplicates === 1 && mid.attached === 1);
const receiptsAtFail = st.receipts.length;
const pendingAtFail = st.pendingReceipts.length;
// 恢复：重放整个批次，已完成条目被检查点跳过，只补未完成
for (const it of items) st = reducer(st, { type: "applyBatchItem", batchId: "B-test", item: it });
st = reducer(st, { type: "batchDone", batchId: "B-test" });
const fin = st.batches[0];
check(
  "恢复后 4/4 完成，只补未完成、未重复挂回执",
  fin.status === "done" &&
    fin.appliedReportNos.length === 4 &&
    fin.duplicates === 1 && // 中断前已记的判重不重复计数
    fin.attached === 2 &&
    fin.pending === 1 &&
    st.receipts.length === receiptsAtFail + 1 && // 只多挂了 BA-2406
    st.pendingReceipts.length === pendingAtFail + 1 // 只多留了 BA-2408
);
// 同一文件作为新批次整体重放：全部判重，回执数不变
const replay: ImportBatch = { id: "B-replay", createdAt: "t", status: "importing", items, appliedReportNos: [], attached: 0, pending: 0, duplicates: 0 };
st = reducer(st, { type: "createBatch", batch: replay });
for (const it of items) st = reducer(st, { type: "applyBatchItem", batchId: "B-replay", item: it });
check(
  "整批重放全部判重、回执与待核数不变",
  st.batches[0].duplicates === 4 &&
    st.receipts.length === receiptsAtFail + 1 &&
    st.pendingReceipts.length === pendingAtFail + 1
);

// 8. 作废后重放仍判重
const s8 = reducer(s2, { type: "discardPending", reportNo: "BA-2404" });
const r3 = applyReceipt(s8, { reportNo: "BA-2404", trench: "T0203", layer: "第4层", bagNo: "袋09", bpAge: 2400, bpError: 40 });
check("作废报告重放 → duplicate", r3.outcome === "duplicate" && r3.next.pendingReceipts.length === s8.pendingReceipts.length);

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
