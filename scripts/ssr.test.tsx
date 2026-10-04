import { renderToString } from "react-dom/server";
import App from "../src/App";
const html = renderToString(<App />);
const must = ["可恢复的测年台账", "样本登记", "实验室回执", "待核回执", "年代结论", "地层顺序校验与报告发布", "BA-2401", "IntCal20"];
const missing = must.filter((m) => !html.includes(m));
if (missing.length) { console.error("缺少内容:", missing); process.exit(1); }
console.log("SSR 渲染正常，关键区块齐全，长度", html.length);
