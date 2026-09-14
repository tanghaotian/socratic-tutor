/**
 * README 中英配对结构校验（对标 DeepSeek Harness 的双语文档配对契约）。
 *
 * 契约要求结构一一对应：标题层级与顺序、列表种类与条目数、表格行列数、代码块。
 * 代码块分两类，校验方式不同：
 *
 *  1. **命令示例**（info string 非空，如 `sh`）——必须与英文侧**逐字节相同**。
 *     这是 DSH 契约「verbatim code blocks」的落地方式：命令与参数不翻译，
 *     解释写在代码块外的正文里（DSH 的 README 正是如此），因此不需要在块内加翻译注释。
 *  2. **结构图**（info string 为空，如架构分层图、目录树）——**必须翻译**，不可能逐字节相同。
 *     此类块校验**结构等价**：行数一致、每行前导缩进一致（只比骨架，不比文案）。
 *
 * 用法：node scripts/verify-readme-pairing.mjs
 * 退出码：0 = 结构一致；1 = 存在不一致（逐条列出）
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const PAIRS = [['README.md', 'README.zh.md']];

/** 结构图代码块的骨架：行数 + 每行缩进（用于比对中英结构是否等价） */
function skeleton(body) {
  return body.split('\n').map((l) => l.match(/^\s*/)[0].length).join(',');
}

/** 提取结构签名：按出现顺序记录各类结构元素 */
function signature(text) {
  const lines = text.split(/\r?\n/);
  const sig = [];
  let fence = null;
  let fenceBody = [];

  for (const line of lines) {
    // 代码块内部：只收集正文，不做其它解析
    if (fence !== null) {
      if (/^\s*```/.test(line)) {
        sig.push({ kind: 'code', info: fence, body: fenceBody.join('\n') });
        fence = null;
        fenceBody = [];
      } else {
        fenceBody.push(line);
      }
      continue;
    }
    const fenceOpen = line.match(/^\s*```(\S*)/);
    if (fenceOpen) {
      fence = fenceOpen[1] ?? '';
      fenceBody = [];
      continue;
    }
    if (/^\s*<!--/.test(line)) continue;

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      sig.push({ kind: 'heading', depth: h[1].length });
      continue;
    }
    // 表格行
    if (/^\s*\|/.test(line)) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').length;
      const isSep = /^\s*\|[\s:|-]+\|\s*$/.test(line);
      sig.push({ kind: isSep ? 'table-sep' : 'table-row', cells });
      continue;
    }
    // 列表项（有序/无序）
    const ul = line.match(/^\s*([-*+])\s+/);
    if (ul) {
      sig.push({ kind: 'list', ordered: false });
      continue;
    }
    const ol = line.match(/^\s*(\d+)[.)]\s+/);
    if (ol) {
      sig.push({ kind: 'list', ordered: true });
      continue;
    }
  }
  if (fence !== null) sig.push({ kind: 'code-unclosed', info: fence });
  return sig;
}

/** 把签名压成可比较的序列：命令块按 info + 正文哈希；结构图按 info + 骨架 */
function compact(sig) {
  return sig.map((s) => {
    if (s.kind !== 'code') return JSON.stringify(s);
    if (s.info) return `code:${s.info}:${crypto.createHash('sha1').update(s.body).digest('hex').slice(0, 12)}`;
    return `diagram:${skeleton(s.body)}`;
  });
}

let failed = 0;
for (const [en, zh] of PAIRS) {
  if (!fs.existsSync(en) || !fs.existsSync(zh)) {
    console.log(`✗ 缺文件：${!fs.existsSync(en) ? en : zh}`);
    failed++;
    continue;
  }
  const enSig = signature(fs.readFileSync(en, 'utf-8'));
  const zhSig = signature(fs.readFileSync(zh, 'utf-8'));
  const enC = compact(enSig);
  const zhC = compact(zhSig);

  const problems = [];
  // 1) 语言切换器（规范：中文侧紧随 H1 回链英文）
  const zhText = fs.readFileSync(zh, 'utf-8');
  if (!/^\[English\]\(README\.md\) \| 中文\s*$/m.test(zhText)) {
    problems.push('中文侧缺少规范语言切换器 `[English](README.md) | 中文`');
  }
  const enText = fs.readFileSync(en, 'utf-8');
  if (!/^English \| \[中文\]\(README\.zh\.md\)\s*$/m.test(enText)) {
    problems.push('英文侧缺少规范语言切换器 `English | [中文](README.zh.md)`');
  }
  // 2) 相对链接的目标语言（本仓库仅这两个文件成对，故只检查指向配对文件的链接）
  if (!/\(README\.zh\.md\)/.test(enText)) problems.push('英文侧未链接中文 README');
  if (!/\(README\.md\)/.test(zhText)) problems.push('中文侧未链接英文 README');

  // 3) 结构签名长度与逐项一致性（忽略 heading 文案与 list 文案，只比结构）
  const norm = (c) => c.filter((x) => !x.startsWith('{"kind":"table-sep"'));
  const a = norm(enC);
  const b = norm(zhC);
  if (a.length !== b.length) {
    problems.push(`结构元素数量不一致：英文 ${a.length} 项 vs 中文 ${b.length} 项`);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) problems.push(`  首个分歧 @${i}：en=${a[i] ?? '(缺)'} zh=${b[i] ?? '(缺)'}`);
      if (problems.length > 8) break;
    }
  } else {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) problems.push(`结构分歧 @${i}：en=${a[i]} zh=${b[i]}`);
      if (problems.length > 8) break;
    }
  }

  // 4) 代码块：命令块逐字节一致；结构图结构等价（行数 + 缩进骨架）
  const enCode = enSig.filter((s) => s.kind === 'code');
  const zhCode = zhSig.filter((s) => s.kind === 'code');
  if (enCode.length !== zhCode.length) {
    problems.push(`代码块数量不一致：英文 ${enCode.length} vs 中文 ${zhCode.length}`);
  } else {
    enCode.forEach((c, i) => {
      const z = zhCode[i];
      if (c.info !== z.info) problems.push(`代码块 ${i} info string 不一致：${c.info} vs ${z.info}`);
      if (c.info) {
        // 命令示例：必须逐字节相同（命令与参数不翻译）
        if (c.body !== z.body) {
          problems.push(`代码块 ${i}（命令示例 \`${c.info}\`）正文不一致——命令与参数不得翻译`);
        }
      } else {
        // 结构图：必须翻译，但骨架（行数 + 缩进）必须等价
        if (c.body.split('\n').length !== z.body.split('\n').length) {
          problems.push(`结构图 ${i} 行数不一致：英文 ${c.body.split('\n').length} vs 中文 ${z.body.split('\n').length}`);
        } else if (skeleton(c.body) !== skeleton(z.body)) {
          problems.push(`结构图 ${i} 缩进骨架不一致：en=[${skeleton(c.body)}] zh=[${skeleton(z.body)}]`);
        }
      }
    });
  }

  const head = `${en} ↔ ${zh}`;
  if (problems.length) {
    failed++;
    console.log(`✗ ${head}`);
    for (const p of problems) console.log(`    ${p}`);
  } else {
    console.log(`✓ ${head}（结构元素 ${a.length} 项、代码块 ${enCode.length} 个、语言切换器齐备）`);
  }
}

process.exit(failed ? 1 : 0);
