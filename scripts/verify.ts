import assert from "node:assert";
import { seed, reducer, applyBatchItem } from "../src/store";
import type { BatchDraft } from "../src/store";
import { calibrate, findOrderConflicts, effectiveRange } from "../src/domain";
import type { BatchItem, LedgerState } from "../src/types";

let pass = 0;
const ok = (name: string, cond: boolean) => {
  assert.ok(cond, name);
  pass++;
  console.log(`  ✓ ${name}`);
};

const sk = (sq: string, l: string, b: string) => `${sq}|${l}|${b}`;
let s: LedgerState = seed();
const t = 1_700_000_000_000;

console.log("1) 样本三要素唯一绑定") ;
s = reducer(s, { type: "addSample", square: "T0203", layer: "第2层", bag: "D07", material: "x" });
ok("重复 探方/地层/袋号 不重复登记", s.samples.length === 3);
s = reducer(s, { type: "addSample", square: "T0505", layer: "第2层", bag: "D01", material: "炭屑" });
s = reducer(s, { type: "addSample", square: "T0505", layer: "第3层", bag: "D02", material: "炭屑" });
ok("新样本可登记", s.samples.length === 5);

console.log("2) 回执：报告号唯一、重复只入一次");
const before = s.receipts.length;
s = reducer(s, {
  type: "addReceipt", reportNo: "LDR-2024-1187", lab: "甲", bp: 4200, sigma: 35,
  curveVersion: "IntCal20", intendedSquare: "T0203", intendedLayer: "第2层", intendedBag: "D07",
});
ok("重复报告号被拒收，回执数不增加", s.receipts.length === before);
ok("同一袋样本没有被算两次",
  s.receipts.filter((r) => r.sampleKey === sk("T0203", "第2层", "D07")).length === 1);

console.log("3) 对不上样本先留待核");
s = reducer(s, {
  type: "addReceipt", reportNo: "LDR-2025-0999", lab: "乙", bp: 3100, sigma: 25,
  curveVersion: "IntCal20", intendedSquare: "T0909", intendedLayer: "第1层", intendedBag: "D99",
});
const pend = s.receipts.find((r) => r.reportNo === "LDR-2025-0999")!;
ok("待核回执 sampleKey 为空并保留所指三要素",
  pend.sampleKey === null && pend.intended?.bag === "D99");
s = reducer(s, { type: "matchPending", reportNo: "LDR-2025-0999", square: "T0505", layer: "第2层", bag: "D01" });
const matched = s.receipts.find((r) => r.reportNo === "LDR-2025-0999")!;
ok("核对到存在样本后挂上并生成校准区间",
  matched.sampleKey === sk("T0505", "第2层", "D01") &&
  Boolean(s.results[sk("T0505", "第2层", "D01")]));

console.log("4) 曲线换版：未批复立即失效重算，已批复保留当时依据");
const c20 = calibrate(4680, 40, "IntCal20");
const c25 = calibrate(4680, 40, "IntCal25");
ok("不同曲线版本确实给出不同区间", JSON.stringify(c20) !== JSON.stringify(c25));
// 批复 T0203 第3层（IntCal20 下），再换版 IntCal25
s = reducer(s, { type: "approve", sampleKey: sk("T0203", "第3层", "D12"), approver: "领队" });
const frozen = s.approvals[sk("T0203", "第3层", "D12")];
ok("批复已冻结 IntCal20 区间",
  frozen.curveVersion === "IntCal20" && frozen.fromCalBP === c20.fromCalBP);
const unapprovedBefore = s.results[sk("T0203", "第2层", "D07")];
s = reducer(s, { type: "setCurve", curve: "IntCal25" });
const unapprovedAfter = s.results[sk("T0203", "第2层", "D07")];
const expected25 = calibrate(4200, 35, "IntCal25");
ok("未批复区间按新版重算",
  unapprovedAfter.fromCalBP === expected25.fromCalBP &&
  unapprovedAfter.curveVersion === "IntCal25" &&
  unapprovedAfter.recalcs === (unapprovedBefore.recalcs + 1));
ok("已批复结论仍保留原版本与原值",
  s.approvals[sk("T0203", "第3层", "D12")].fromCalBP === c20.fromCalBP &&
  effectiveRange(s, sk("T0203", "第3层", "D12"))!.curveVersion === "IntCal20");

console.log("5) 新结果导致地层上下矛盾 → 挡住发布并列出探方/地层/样本");
// 让 T0505 第2层（上）明显老于第3层（下）
s = reducer(s, {
  type: "addReceipt", reportNo: "LDR-2025-1001", lab: "乙", bp: 5200, sigma: 30,
  curveVersion: "IntCal25", intendedSquare: "T0505", intendedLayer: "第2层", intendedBag: "D01",
});
// 第2层已挂 0999(3100bp)，新回执挂不上（一样本只挂先到回执）；改为直接给下层年轻回执
s = reducer(s, {
  type: "addReceipt", reportNo: "LDR-2025-1002", lab: "乙", bp: 3000, sigma: 30,
  curveVersion: "IntCal25", intendedSquare: "T0505", intendedLayer: "第3层", intendedBag: "D02",
});
// 制造倒置：把上层 0999 退回后重新挂一个老年代
s = reducer(s, { type: "returnReceipt", reportNo: "LDR-2025-0999" });
s = reducer(s, { type: "matchPending", reportNo: "LDR-2025-1001", square: "T0505", layer: "第2层", bag: "D01" });
const conflicts = findOrderConflicts(s);
const hit = conflicts.find((c) => c.square === "T0505");
ok("检出 T0505 第2层老于第3层的倒置",
  Boolean(hit) && hit!.upper.layer === "第2层" && hit!.lower.layer === "第3层" &&
  hit!.upper.sampleKey.includes("D01") && hit!.lower.sampleKey.includes("D02"));
const pubsBefore = s.publications.length;
s = reducer(s, { type: "publish" });
ok("矛盾未解决时挡下发布，不产生发布记录", s.publications.length === pubsBefore);

console.log("6) 矛盾解决后可发布");
// 退回造成倒置的老年代回执，改挂年轻回执恢复上晚下老
s = reducer(s, { type: "returnReceipt", reportNo: "LDR-2025-1001" });
s = reducer(s, { type: "matchPending", reportNo: "LDR-2025-0999", square: "T0505", layer: "第2层", bag: "D01" });
ok("退回后其区间停用", !s.results[sk("T0505", "第2层", "D01")] ||
  s.results[sk("T0505", "第2层", "D01")].basedOnReport !== "LDR-2025-1001");
s = reducer(s, { type: "publish" });
ok("顺序恢复后发布成功", s.publications.length === pubsBefore + 1);

console.log("7) 批次导入失败 → 从完整批次恢复，只补未完成、重放不重复挂");
let bs = seed();
const drafts: BatchDraft[] = [
  { kind: "sample", square: "T0701", layer: "第1层", bag: "D01", material: "炭" },
  { kind: "sample", square: "T0701", layer: "第2层", bag: "D02", material: "骨" },
  {
    kind: "receipt", reportNo: "LDR-NEW-1", lab: "丙", bp: 2600, sigma: 25,
    curveVersion: "IntCal20", intendedSquare: "T0701", intendedLayer: "第1层", intendedBag: "D01",
  },
  { kind: "receipt", reportNo: "LDR-2024-1187", lab: "甲", bp: 4200, sigma: 35,
    curveVersion: "IntCal20", intendedSquare: "T0203", intendedLayer: "第2层", intendedBag: "D07" },
];
const items: BatchItem[] = drafts.map((d, i) => ({
  id: `it${i}`, kind: d.kind, payload: d, status: "pending", note: null,
}));
// 模拟：只成功处理前 2 条后中断
let applied = applyBatchItem(bs, items[0], t);
bs = applied.state;
applied = applyBatchItem(bs, items[1], t);
bs = applied.state;
ok("中断时仅 2 条样本进入台账",
  bs.samples.some((x) => x.key === sk("T0701", "第1层", "D01")) &&
  !bs.receipts.some((r) => r.reportNo === "LDR-NEW-1"));
// 恢复：重放前 2 条（应跳过），再补后 2 条
for (const it of items) {
  const r = applyBatchItem(bs, it, t);
  bs = r.state;
}
ok("恢复后新样本不重复",
  bs.samples.filter((x) => x.key === sk("T0701", "第1层", "D01")).length === 1 &&
  bs.samples.filter((x) => x.key === sk("T0701", "第2层", "D02")).length === 1);
ok("恢复时新回执已挂上",
  bs.receipts.some((r) => r.reportNo === "LDR-NEW-1" && r.sampleKey === sk("T0701", "第1层", "D01")));
ok("重放不重复挂已有回执（LDR-2024-1187 仍只 1 条、仍挂原袋）",
  bs.receipts.filter((r) => r.reportNo === "LDR-2024-1187").length === 1 &&
  bs.receipts.find((r) => r.reportNo === "LDR-2024-1187")!.sampleKey === sk("T0203", "第2层", "D07"));

console.log(`\n全部 ${pass} 项断言通过 ✔`);
