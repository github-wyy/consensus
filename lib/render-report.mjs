#!/usr/bin/env node
// report.json → report.html 渲染（consensus skill）
// 用法：node render-report.mjs <report.json> [out.html]
// 模板：report-template.html（#121 原型转正，三视图 A/B/C）

import fs from 'node:fs';
import path from 'node:path';

const [reportPath, outArg] = process.argv.slice(2);
if (!reportPath) { console.error('用法: render-report.mjs <report.json> [out.html]'); process.exit(2); }
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const out = outArg || reportPath.replace(/\.json$/, '.html');
const tpl = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'report-template.html'), 'utf8');
// 陷阱防护：__REPORT__ 注入前先转义 </script>
const dataJson = JSON.stringify(report, null, 0).replace(/<\//g, '<\\/');
const html = tpl
  .replace('__REPORT__', dataJson)
  .replace('{{QUESTION}}', String(report.question || 'consensus').replace(/[<>"]/g, ''));
fs.writeFileSync(out, html);
console.log(JSON.stringify({ rendered: out, views: ['A', 'B', 'C'] }));
