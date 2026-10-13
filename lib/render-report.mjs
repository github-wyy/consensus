#!/usr/bin/env node
// report.json → report.html 渲染（consensus skill）
// 用法：node render-report.mjs <report.json> [out.html]
// 模板：report-template.html（短幻灯片 deck：每页一个关键点，空内容页自动跳过）

import fs from 'node:fs';
import path from 'node:path';

const [reportPath, outArg] = process.argv.slice(2);
if (!reportPath) { console.error('用法: render-report.mjs <report.json> [out.html]'); process.exit(2); }
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const out = outArg || reportPath.replace(/\.json$/, '.html');
const tpl = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'report-template.html'), 'utf8');
// 陷阱防护：__REPORT__ 注入前先转义 </script>
const dataJson = JSON.stringify(report, null, 0).replace(/<\//g, '<\\/');
// 精确替换代码行占位符（模板注释里也有一处文档用的 __REPORT__ 字样，
// 裸 replace 只换第一次会把 JSON 注进注释、代码行残留占位符 → 白屏）
const html = tpl
  .replace('const D = __REPORT__;', 'const D = ' + dataJson + ';')
  .replace('{{QUESTION}}', String(report.question || 'consensus').replace(/[<>"]/g, ''));
fs.writeFileSync(out, html);
console.log(JSON.stringify({ rendered: out, format: 'deck' }));
