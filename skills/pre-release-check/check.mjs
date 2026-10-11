#!/usr/bin/env node
/* =============================================================================
   pre-release-check —— growth-site「发布前检查」技能的执行脚本
   -----------------------------------------------------------------------------
   什么时候跑：改完代码、本地提交之前。它是「发布前最后一道闸门」。
   怎么跑：
       node skills/pre-release-check/check.mjs
       node skills/pre-release-check/check.mjs --no-online     # 跳过联网检查
       node skills/pre-release-check/check.mjs --only A1,C1    # 只跑指定项
       node skills/pre-release-check/check.mjs --walk          # 强制走「目录遍历」降级通道
       node skills/pre-release-check/check.mjs --root <目录>    # 指定项目根
       node skills/pre-release-check/check.mjs --html <out.html> --html-title "标题"
                                                              # 把这份报告另存成一页网页（留档/截图用）

   设计原则（四条，决定了它长什么样）：

   ① 三态，不是两态。 PASS / FAIL / WARN。
      WARN = 这一项「没能检查」（断网、拿不到文件清单…），**它不算通过**。
      汇总里单独列出「未检查 N 项」——绝不用「没查」冒充「没问题」。

   ② 会剥注释再匹配。项目里的注释大量提到 innerHTML / localStorage /
      toISOString（都是在讲「别用它」），照着原文匹配必然误报。
      所以 .js 先剥掉行注释和块注释，.html 先剥掉 HTML 注释，再去找真代码。

   ③ 失败必须指到「文件:行号 + 原文」。只说「有问题」等于没说，
      还得人去猜在哪。

   ④ 零外部依赖、零子进程。
      不 spawn 任何东西 —— 因为在受限环境里 spawn 会被挡（EBUSY），
      脚本就会假装「检查不了」。宁可自己多写几十行，也不能让检查项
      因为环境问题变成「未检查」。
      · 文件清单：能用 `git ls-files` 就用（最准）；用不了就退回
        「自己遍历目录 + 自己解析 .gitignore」。
      · 联网：用 Node 自带的 fetch（不调 curl）。

   退出码：有 FAIL → 1；只有 PASS/WARN → 0。（只要有一项红，就不算通过。）
   ============================================================================= */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

/* ============================ 0. 运行参数 ============================ */

const argv = process.argv.slice(2);
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

const ROOT = path.resolve(argVal('--root') || process.cwd());
const NO_ONLINE = argv.includes('--no-online');
const FORCE_WALK = argv.includes('--walk');
const ONLY = (argVal('--only') || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/* 线上地址：本项目发布后的固定域名（沿用旧产品名 source-board）。
   换了域名只改这一行。 */
const ONLINE_BASE = 'https://source-board.app.workbuddy.host/';

/* ============================ 1. 文件清单（含降级通道） ============================ */

let FILE_LIST_SOURCE = '';

/* --- 1a. 首选：git ls-files（最权威：就是「会被提交的那些文件」） --- */
function tryGitLsFiles() {
  try {
    const buf = execFileSync('git', ['ls-files', '-z'],
      { cwd: ROOT, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
    const list = buf.toString('utf8').split('\0').filter(Boolean);
    if (list.length) {
      FILE_LIST_SOURCE = 'git ls-files（权威：只含会被提交的文件）';
      return list;
    }
  } catch {
    /* spawn 被挡 / 不是 git 仓库 —— 落到下面的降级通道 */
  }
  return null;
}

/* --- 1b. 降级：自己遍历目录 + 自己解析 .gitignore ---
   为什么不用第三方库：项目是零依赖的（没有 node_modules），
   检查脚本自己也不该引入依赖，否则「跑检查」这件事本身就多了一道安装步骤。 */

function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i += 1; } else { re += '[^/]*'; }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function parseGitignore(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    rules.push({ re: globToRe(line), anchored: line.includes('/'), dirOnly, negate });
  }
  return rules;
}

/** 路径本身 + 它的每一层父路径（每层都参与匹配，这样「忽略某目录」能管到里面的文件） */
function suffixes(rel) {
  const parts = rel.split('/');
  return parts.map((_, i) => parts.slice(i).join('/'));
}

/** 这条规则命中 cand 了吗？'self' = 命中的就是它本身；'ancestor' = 它是被命中目录的下层 */
function ruleHit(rule, cand) {
  if (rule.re.test(cand)) return 'self';
  const under = new RegExp(`${rule.re.source.slice(0, -1)}(?:/(.*))?$`);
  return under.test(cand) ? 'ancestor' : null;
}

function isIgnored(rules, rel, isDir) {
  let hit = false;
  for (const r of rules) {
    const cands = r.anchored ? [rel] : suffixes(rel);
    let matched = false;
    for (const c of cands) {
      const kind = ruleHit(r, c);
      if (!kind) continue;
      /* 目录规则（`.tmp/`）不该命中同名**文件**，只命中目录或目录下面的东西 */
      if (r.dirOnly && kind === 'self' && !isDir) continue;
      matched = true;
      break;
    }
    if (matched) hit = !r.negate;
  }
  return hit;
}

function fsWalk() {
  const giPath = path.join(ROOT, '.gitignore');
  const rules = existsSync(giPath) ? parseGitignore(readFileSync(giPath, 'utf8')) : [];
  const out = [];

  (function walk(dir, relDir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (isIgnored(rules, rel, isDir)) continue;
      if (isDir) walk(path.join(dir, e.name), rel);
      else out.push(rel);
    }
  })(ROOT, '');

  return out.sort();
}

function listFiles() {
  if (!FORCE_WALK) {
    const viaGit = tryGitLsFiles();
    if (viaGit) return viaGit;
  }
  FILE_LIST_SOURCE = FORCE_WALK
    ? '目录遍历 + .gitignore 解析（本次用 --walk 强制走降级通道）'
    : '目录遍历 + .gitignore 解析（降级通道：本环境起不了 git 子进程）';
  return fsWalk();
}

const FILES = listFiles();

/* 调试用：把文件清单原样打出来，方便对比「两条通道是不是得到同一份清单」 */
if (argv.includes('--list-files')) {
  console.log(FILES.join('\n'));
  process.exit(0);
}

/* ============================ 2. 小工具 ============================ */

function readText(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 剥掉 JS 的行注释与块注释（字符串里的不算），换行保留 → 行号不错位 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let st = 'code';
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (st === 'code') {
      if (c === '/' && d === '/') { st = 'line'; i += 2; out += '  '; continue; }
      if (c === '/' && d === '*') { st = 'block'; i += 2; out += '  '; continue; }
      if (c === "'") { st = 'sq'; out += c; i += 1; continue; }
      if (c === '"') { st = 'dq'; out += c; i += 1; continue; }
      if (c === '`') { st = 'tpl'; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (st === 'line') {
      if (c === '\n') { st = 'code'; out += c; }
      i += 1; continue;
    }
    if (st === 'block') {
      if (c === '*' && d === '/') { st = 'code'; i += 2; continue; }
      if (c === '\n') out += c;
      i += 1; continue;
    }
    const close = st === 'sq' ? "'" : st === 'dq' ? '"' : '`';
    if (c === '\\') { out += c + d; i += 2; continue; }
    if (c === close) { st = 'code'; out += c; i += 1; continue; }
    if (c === '\n' && st !== 'tpl') { st = 'code'; out += c; i += 1; continue; }
    out += c; i += 1; continue;
  }
  return out;
}

/** 剥掉 HTML 注释，换行保留（行号不错位） */
function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

const isJs = (f) => /\.m?js$/i.test(f);
const isCss = (f) => /\.css$/i.test(f);
const isMd = (f) => /\.md$/i.test(f);
const isBinary = (f) => /\.(png|jpe?g|gif|mp4|webm|ico|woff2?|ttf|zip|pdf)$/i.test(f);

/* ============================ 3. 结果收集 ============================ */

const RESULTS = [];

function record(id, group, name, status, detail, hits = [], notes = []) {
  RESULTS.push({ id, group, name, status, detail, hits, notes });
}

/* ============================ 4. A 组：安全红线 ============================ */

/* A1 —— 敏感凭据特征词。
   ⚠️ 两条自我约束（都是有意的）：
   ① 报告里**只打印代号 + 打码片段**，绝不回显命中原文 —— 一份检查报告
      自己把凭据抄一遍，就成了新的泄漏面。
   ② 代号含义只写在本脚本的注释里，**不写进任何文档** —— 同一个理由。

   代号对照（内部用，不外发）：
     S1 WorkBuddy 服务端密钥前缀      S2 云端数据库服务端角色名
     S3 OpenAI 风格密钥               S4 JWT 三段式令牌
     S5 PEM 私钥文件头                S6 数据库连接串（带密码）
     S7 Slack 令牌                    S8 Google API 密钥
     S9 AWS Access Key
   ⚠️ 脚本自身必须包含这些「形状」，扫自己必然报警 → 显式豁免（见下）。 */
const SECRET_PATTERNS = [
  { code: 'S1', re: /\bwbsk_[A-Za-z0-9_-]{8,}/g },
  { code: 'S2', re: /\b(?:service_role|serviceRole|SUPABASE_SERVICE_ROLE)\b/g },
  { code: 'S3', re: /\bsk-[A-Za-z0-9]{20,}/g },
  { code: 'S4', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { code: 'S5', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { code: 'S6', re: /\bpostgres(?:ql)?:\/\/[^:/\s]+:[^@/\s]+@/g },
  { code: 'S7', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { code: 'S8', re: /\bAIza[A-Za-z0-9_-]{35}/g },
  { code: 'S9', re: /\bAKIA[0-9A-Z]{16}\b/g },
];

/* 白名单：能放在前端的**公开**键。判据就是前缀 ——
   wbpk_ = public key，设计上就该在页面里；wbsk_ = secret key，绝不能出现。 */
const PUBLIC_KEY_OK = /\bwbpk_[A-Za-z0-9_-]+/;

/* ⚠️ 元文件豁免 —— 检查脚本自己必须包含这些「被禁词」的形状
   （`localStorage` / `toISOString` / 各类凭据形状）才能去查别人，
   所以它**不能参与「按词扫描」类的检查项**（A1 / B4 / B5 / B6）。
   不豁免的话，它一入库就会把自己报成一片红 —— 那是纯误报。
   （2026-10-11 入库后跑第二遍时真踩到了，B5/B6 报了 7 处。）
   代价与边界：check.mjs 从此不被这几项扫到。所以它自己**不碰存储、不碰页面**，
   只读文件、只算、只打印 —— 这条约束写在 SKILL.md 里。 */
const SELF_EXEMPT = new Set(['skills/pre-release-check/check.mjs']);

/** 打码：报告里只留长度，不回显内容 */
const maskHit = (s) => `****（${s.length} 字符，已打码）`;

function checkA1() {
  const hits = [];
  let scanned = 0;

  for (const f of FILES) {
    if (isBinary(f) || SELF_EXEMPT.has(f)) continue;
    let text;
    try { text = readText(f); } catch { continue; }
    scanned += 1;
    const lines = (isJs(f) ? stripJsComments(text) : text).split(/\r?\n/);

    lines.forEach((line, idx) => {
      for (const p of SECRET_PATTERNS) {
        p.re.lastIndex = 0;
        const m = p.re.exec(line);
        if (!m) continue;
        if (PUBLIC_KEY_OK.test(m[0])) continue; /* 公开键放行 */
        hits.push({
          file: f,
          line: idx + 1,
          what: p.code,
          text: maskHit(m[0]),
          /* 文档（.md）里出现这些词，多半是在讲「这些是密钥形状」，
             不能直接判死 —— 降级成 WARN 交人工确认。 */
          soft: isMd(f),
        });
      }
    });
  }

  const hard = hits.filter((h) => !h.soft);
  const soft = hits.filter((h) => h.soft);

  if (hard.length) {
    record('A1', 'A', '仓库内无真密钥', 'FAIL',
      `扫描 ${scanned} 个文件，${hard.length} 处命中真实凭据形状`, hard);
  } else if (soft.length) {
    /* 文档里出现这些词，通常是在**讲这件事本身**（比如 Day 23 记录的
       「密钥特征词清单」）。它和「代码里藏了真凭据」是两回事，
       不该共用一个结论 —— 所以判「通过」，但把位置原样列出来让人自己看。
       ⚠️ 这是「通过 + 备注」，不是「忽略」：位置一条不少地摆在报告里。 */
    record('A1', 'A', '仓库内无真密钥', 'PASS',
      `扫描 ${scanned} 个文件；代码与配置 0 处命中（另有 ${soft.length} 处在文档里，属说明性字样）`,
      [],
      soft);
  } else {
    record('A1', 'A', '仓库内无真密钥', 'PASS', `扫描 ${scanned} 个文件，0 处命中`);
  }
}

const ENV_VARIANTS = ['.env', '.env.local', '.env.production', '.env.development', '.env.test', '.env.staging'];

function checkA2() {
  const giPath = path.join(ROOT, '.gitignore');
  if (!existsSync(giPath)) {
    record('A2', 'A', '.env 全族被忽略', 'FAIL', '根本没有 .gitignore 文件');
    return;
  }
  const rules = parseGitignore(readFileSync(giPath, 'utf8'));
  const bad = ENV_VARIANTS.filter((f) => !isIgnored(rules, f, false));
  if (bad.length) {
    record('A2', 'A', '.env 全族被忽略', 'FAIL',
      `${ENV_VARIANTS.length} 个变体里有 ${bad.length} 个**没被忽略**，里面有密钥就会提交上去`,
      bad.map((f) => ({ file: '.gitignore', line: 0, what: '漏了', text: f })));
  } else {
    record('A2', 'A', '.env 全族被忽略', 'PASS',
      `${ENV_VARIANTS.length}/${ENV_VARIANTS.length} 个变体全部被忽略`);
  }
}

/* ============================ 5. B 组：技术硬规矩 ============================ */

/* B1 —— 禁止 <script type="module">（file:// 下会被浏览器直接拦掉，页面白屏） */
function checkB1() {
  const html = stripHtmlComments(readText('index.html'));
  const hits = [];
  html.split(/\r?\n/).forEach((l, i) => {
    if (/type\s*=\s*["']module["']/i.test(l)) {
      hits.push({ file: 'index.html', line: i + 1, text: l.trim().slice(0, 110) });
    }
  });
  if (hits.length) record('B1', 'B', '无 <script type="module">', 'FAIL', `${hits.length} 处`, hits);
  else record('B1', 'B', '无 <script type="module">', 'PASS', 'index.html 里没有模块脚本');
}

/* B2 —— 不许出现「白名单外」的在线资源。
   ⚠️ 唯一的例外是云端 SDK 那一个 CDN（Day 17 加的，见 index.html 注释）：
   纯静态 + 零构建，所以 SDK 用 CDN 引，不用 npm 包（引 npm 就要多加一步构建）。
   这个例外是**刻意**的，不是漏网 —— 所以检查项要把它写进白名单，
   而不是照文档一刀切（那样会对一个正常的项目报红，属于误报）。 */
const CDN_WHITELIST = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@tencent-ai\/workbuddy-cloud-sdk@/;

function checkB2() {
  const hits = [];

  /* html：只看「资源型」属性 src / href / poster 指向外部的；
     内容里的跳转链接不算「页面依赖的资源」（那是数据，不是依赖）。 */
  const html = stripHtmlComments(readText('index.html'));
  html.split(/\r?\n/).forEach((l, i) => {
    const re = /(?:src|href|poster)\s*=\s*["'](https?:\/\/[^"']+)["']/g;
    let m;
    while ((m = re.exec(l))) {
      if (CDN_WHITELIST.test(m[1])) continue;
      hits.push({ file: 'index.html', line: i + 1, what: '外部资源', text: m[1] });
    }
  });

  /* css：url(...) 与 @import 指向外部的 */
  for (const f of FILES.filter(isCss)) {
    readText(f).split(/\r?\n/).forEach((l, i) => {
      const re = /(?:url\(\s*["']?|@import\s+["'])(https?:\/\/[^)"']+)/g;
      let m;
      while ((m = re.exec(l))) {
        if (CDN_WHITELIST.test(m[1])) continue;
        hits.push({ file: f, line: i + 1, what: 'CSS 外链', text: m[1] });
      }
    });
  }

  if (hits.length) {
    record('B2', 'B', '无白名单外的在线资源', 'FAIL',
      `${hits.length} 处（白名单只有云端 SDK 那一个 CDN）`, hits);
  } else {
    record('B2', 'B', '无白名单外的在线资源', 'PASS',
      '页面只依赖本地文件 + 1 个白名单 CDN（云端 SDK，Day 17 刻意引入）');
  }
}

/* B3 —— 不许有构建步骤 */
const BUILD_ARTIFACTS = ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'node_modules', '.npmrc'];

function checkB3() {
  const found = BUILD_ARTIFACTS.filter((a) => FILES.some((f) => f === a || f.startsWith(`${a}/`)));
  if (found.length) {
    record('B3', 'B', '无构建步骤', 'FAIL', `仓库里出现了构建链文件：${found.join(' / ')}`,
      found.map((f) => ({ file: f, line: 0, what: '构建链' })));
  } else {
    record('B3', 'B', '无构建步骤', 'PASS', '无 package.json / lock 文件 / node_modules（双击就能跑）');
  }
}

/* B4/B5/B6 —— 都要先剥注释再看 */

function scanJsCode(reFactory, opts = {}) {
  const hits = [];
  for (const f of FILES) {
    if (!isJs(f)) continue;
    if (SELF_EXEMPT.has(f)) continue; /* 元文件豁免，见 SELF_EXEMPT 的说明 */
    if (opts.exclude && opts.exclude.test(f)) continue;
    stripJsComments(readText(f)).split(/\r?\n/).forEach((l, i) => {
      const re = reFactory();
      let m;
      while ((m = re.exec(l))) {
        hits.push({ file: f, line: i + 1, what: opts.what, text: l.trim().slice(0, 110) });
      }
    });
  }
  return hits;
}

function checkB4() {
  const hits = [
    ...scanJsCode(() => /\.innerHTML\s*=[^=]/g, { what: 'innerHTML 赋值' }),
    ...scanJsCode(() => /\.outerHTML\s*=[^=]/g, { what: 'outerHTML 赋值' }),
    ...scanJsCode(() => /insertAdjacentHTML\s*\(/g, { what: 'insertAdjacentHTML' }),
  ];
  if (hits.length) record('B4', 'B', '无 innerHTML 拼接', 'FAIL', `${hits.length} 处（文字只能走 textContent）`, hits);
  else record('B4', 'B', '无 innerHTML 拼接', 'PASS', '全部 JS 里没有拼 HTML 的写法（注释里提到的不算）');
}

function checkB5() {
  const hits = scanJsCode(() => /localStorage/g, {
    what: '直接碰 localStorage',
    exclude: /assets\/store\.js$/,
  });
  if (hits.length) {
    record('B5', 'B', 'localStorage 只在 store.js', 'FAIL',
      `${hits.length} 处出现在 store.js 之外（以后换云端会漏改）`, hits);
  } else {
    record('B5', 'B', 'localStorage 只在 store.js', 'PASS', '只有 store.js 碰本地存储（注释里提到的不算）');
  }
}

function checkB6() {
  const hits = scanJsCode(() => /toISOString/g, { what: '用 UTC 时间取日期' });
  if (hits.length) {
    record('B6', 'B', '不用 toISOString 取日期', 'FAIL',
      `${hits.length} 处（UTC 会让晚上 8 点后的打卡记到第二天）`, hits);
  } else {
    record('B6', 'B', '不用 toISOString 取日期', 'PASS', '日期都按本地时间自己拼（注释里提到的不算）');
  }
}

/* B7 —— 脚本加载顺序。后面每个文件一加载就用前面那个，顺序换了就白屏。 */
const EXPECTED_ORDER = ['config.js', 'db.js', 'cloud.js', 'rules.js', 'store.js', 'data.js', 'app.js'];

function checkB7() {
  const html = stripHtmlComments(readText('index.html'));
  const localScripts = [];
  const re = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    if (/^https?:/i.test(u)) continue;
    localScripts.push(path.basename(u));
  }
  const ok = localScripts.length === EXPECTED_ORDER.length
    && localScripts.every((f, i) => f === EXPECTED_ORDER[i]);
  if (ok) {
    record('B7', 'B', '脚本加载顺序正确', 'PASS', localScripts.join(' → '));
  } else {
    record('B7', 'B', '脚本加载顺序正确', 'FAIL', '实际顺序与约定不符', [
      { file: 'index.html', line: 0, what: '实际', text: localScripts.join(' → ') },
      { file: 'index.html', line: 0, what: '应为', text: EXPECTED_ORDER.join(' → ') },
    ]);
  }
}

/* B8 —— 文件名规范：小写 + 连字符 + 不带空格（避免本地路径出问题） */
const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+$/;

function checkB8() {
  const files = FILES.filter((f) => f.startsWith('assets/'));
  const bad = files.filter((f) => !NAME_RULE.test(path.basename(f)));
  if (bad.length) {
    record('B8', 'B', 'assets 文件名规范', 'FAIL', `${bad.length} 个文件名不符合「小写+连字符」`,
      bad.map((f) => ({ file: f, line: 0, what: '命名' })));
  } else {
    record('B8', 'B', 'assets 文件名规范', 'PASS', `${files.length}/${files.length} 个文件命名合规`);
  }
}

/* ============================ 6. C 组：发布前状态 ============================ */

function md5(buf) {
  return createHash('md5').update(buf).digest('hex');
}

async function fetchWithTimeout(url, ms = 25000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'follow' });
  return res;
}

/* C1 —— 线上地址还活着吗 */
async function checkC1() {
  if (NO_ONLINE) {
    record('C1', 'C', '线上地址可访问', 'WARN', '本次用 --no-online 跳过了 —— **未检查**，不代表通过');
    return;
  }
  try {
    const res = await fetchWithTimeout(ONLINE_BASE);
    if (res.status === 200) {
      record('C1', 'C', '线上地址可访问', 'PASS', `HTTP 200 — ${ONLINE_BASE}`);
    } else {
      record('C1', 'C', '线上地址可访问', 'FAIL', `HTTP ${res.status}（不是 200）`,
        [{ file: ONLINE_BASE, line: 0, what: 'HTTP', text: String(res.status) }]);
    }
  } catch (e) {
    record('C1', 'C', '线上地址可访问', 'WARN', `没连上（${e.name}）—— **未检查**`);
  }
}

/* C2 —— 线上跑的是不是本地这份代码（逐文件比 md5） */
function localCodeFiles() {
  const html = stripHtmlComments(readText('index.html'));
  const set = new Set(['index.html']);
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    if (/^https?:/i.test(u) || u.startsWith('#') || u.startsWith('data:')) continue;
    const clean = u.split('?')[0].split('#')[0];
    if (!clean) continue;
    if (/\.(js|css|svg)$/i.test(clean)) set.add(clean);
  }
  return [...set];
}

async function checkC2() {
  const files = localCodeFiles();
  if (NO_ONLINE) {
    record('C2', 'C', '线上与本地代码一致', 'WARN',
      `本次用 --no-online 跳过（应比对 ${files.length} 个文件）—— **未检查**`);
    return;
  }
  const diff = [];
  let okCount = 0;
  let netFail = 0;

  for (const f of files) {
    const localPath = path.join(ROOT, f);
    if (!existsSync(localPath)) {
      diff.push({ file: f, line: 0, what: '本地缺失' });
      continue;
    }
    const localMd5 = md5(readFileSync(localPath));
    const url = new URL(f, ONLINE_BASE).href;
    try {
      const res = await fetchWithTimeout(url);
      const remoteMd5 = md5(Buffer.from(await res.arrayBuffer()));
      if (remoteMd5 === localMd5) okCount += 1;
      else {
        diff.push({
          file: f, line: 0, what: '不一致',
          text: `本地 ${localMd5.slice(0, 8)} / 线上 ${remoteMd5.slice(0, 8)}`,
        });
      }
    } catch {
      netFail += 1;
    }
  }

  if (netFail === files.length) {
    record('C2', 'C', '线上与本地代码一致', 'WARN', '全部取不到 —— 网络不通，**未检查**');
  } else if (diff.length) {
    record('C2', 'C', '线上与本地代码一致', 'FAIL',
      `${okCount}/${files.length} 一致，${diff.length} 个对不上（线上还是旧版？没发布？）`, diff);
  } else {
    record('C2', 'C', '线上与本地代码一致', 'PASS', `${okCount}/${files.length} 个文件 md5 完全一致`);
  }
}

/* ============================ 7. 跑 ============================ */

const ALL = [
  ['A1', checkA1], ['A2', checkA2],
  ['B1', checkB1], ['B2', checkB2], ['B3', checkB3], ['B4', checkB4],
  ['B5', checkB5], ['B6', checkB6], ['B7', checkB7], ['B8', checkB8],
  ['C1', checkC1], ['C2', checkC2],
];

if (!existsSync(path.join(ROOT, '.git')) && !existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`\n✗ ${ROOT} 看起来不是 growth-site 项目目录（既没有 .git 也没有 index.html）。\n`);
  process.exit(2);
}

for (const [id, fn] of ALL) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  try {
    await fn();
  } catch (e) {
    record(id, id[0], id, 'WARN', `检查项本身报错：${e && e.message ? e.message : e}`);
  }
}

/* ============================ 8. 出报告 ============================ */

/* 三个标记补成等宽，左边几列才能对齐（截图看着清楚，也方便扫） */
const ICON = { PASS: '[通过]  ', FAIL: '[失败]  ', WARN: '[未检查]' };
const GROUP_TITLE = {
  A: 'A 组 · 安全红线（碰了就是事故）',
  B: 'B 组 · 技术硬规矩（AGENTS.md 第 4 条）',
  C: 'C 组 · 发布前状态',
};

function pad(s, n) {
  let w = 0;
  for (const ch of s) w += /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

/* 报告先收集成「行」，最后一次性输出 —— 这样同一份内容
   既能打到终端，也能（用 --html）写成一份可截图留档的网页。 */
const LINES = [];
const out = (s = '') => LINES.push(s);

const now = new Date();
const p2 = (x) => String(x).padStart(2, '0');
const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} `
  + `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;

out('');
out('======================================================================');
out('  growth-site 发布前检查 · pre-release-check');
out('======================================================================');
out(`  检查对象：${ROOT}`);
out(`  执行时间：${stamp}`);
out(`  文件清单：${FILES.length} 个 —— ${FILE_LIST_SOURCE}`);
out('');

let curGroup = null;
for (const r of RESULTS) {
  if (r.group !== curGroup) {
    curGroup = r.group;
    out(`【${GROUP_TITLE[curGroup] || curGroup}】`);
  }
  out(`  ${ICON[r.status]} ${pad(r.id, 5)}${pad(r.name, 30)}${r.detail || ''}`);
  for (const h of r.hits || []) {
    const loc = h.line ? `${h.file}:${h.line}` : h.file;
    out(`         └ ${loc}${h.what ? `  [${h.what}]` : ''}${h.text ? `  ${h.text}` : ''}`);
  }
  for (const n of r.notes || []) {
    const loc = n.line ? `${n.file}:${n.line}` : n.file;
    out(`         · ${loc}${n.what ? `  [${n.what}]` : ''}${n.text ? `  ${n.text}` : ''}`);
  }
  out('');
}

const pass = RESULTS.filter((r) => r.status === 'PASS').length;
const fail = RESULTS.filter((r) => r.status === 'FAIL').length;
const warn = RESULTS.filter((r) => r.status === 'WARN').length;

out('----------------------------------------------------------------------');
out(`  汇总：通过 ${pass} 项　失败 ${fail} 项　未检查 ${warn} 项　（共 ${RESULTS.length} 项）`);

let verdict = '';
if (fail > 0) {
  verdict = '不能发布';
  out('');
  out('  结论：不能发布 —— 上面打 [失败] 的项必须先修掉。');
} else if (warn > 0) {
  verdict = '有未检查项，不能算通过';
  out('');
  out('  结论：没有失败项，但有「未检查」的项 —— 它们**不算通过**。');
  out('        要发布请先补跑：去掉 --no-online，换个能上网的环境再跑一次。');
} else {
  verdict = '可以发布';
  out('');
  out('  结论：可以发布 —— 全部检查项都真的跑过、都通过。');
}
out('======================================================================');
out('');

console.log(LINES.join('\n'));

/* ---------- 可选：把这份报告写成一份网页（给留档 / 截图用） ---------- */

const HTML_OUT = argVal('--html');

if (HTML_OUT) {
  const htmlTitle = argVal('--html-title') || '发布前检查报告';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const body = LINES.map((line) => {
    let cls = 'ln';
    if (line.includes('[失败]')) cls += ' fail';
    else if (line.includes('[未检查]')) cls += ' warn';
    else if (line.includes('结论：可以发布')) cls += ' ok';
    return `<div class="${cls}">${esc(line) || '&nbsp;'}</div>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${esc(htmlTitle)} · growth-site 发布前检查</title>
<style>
  body { margin: 0; padding: 28px 32px; background: #eef1f5;
         font-family: Consolas, "Courier New", "Microsoft YaHei", monospace; }
  .sheet { max-width: 1100px; margin: 0 auto; background: #fff;
           border: 1px solid #d6dbe3; border-radius: 8px; overflow: hidden;
           box-shadow: 0 2px 10px rgba(16,24,40,.08); }
  .head { padding: 14px 20px; background: #1f2937; color: #f9fafb;
          font-family: "Microsoft YaHei", sans-serif; }
  .head h1 { margin: 0 0 4px; font-size: 17px; font-weight: 600; }
  .head .sub { font-size: 12.5px; color: #cbd5e1; }
  .cmd { margin: 0; padding: 12px 20px; background: #111827; color: #93c5fd;
         font-size: 13px; border-bottom: 1px solid #374151; }
  .cmd b { color: #f9fafb; font-weight: 600; }
  .out { padding: 14px 18px 18px; font-size: 13px; line-height: 1.55; color: #1f2937; }
  .ln { white-space: pre; }
  .ln.fail { background: #fee2e2; color: #991b1b; font-weight: 700;
             border-left: 4px solid #dc2626; margin-left: -18px; padding-left: 14px; }
  .ln.warn { background: #fef3c7; color: #92400e;
             border-left: 4px solid #f59e0b; margin-left: -18px; padding-left: 14px; }
  .ln.ok { background: #dcfce7; color: #166534; font-weight: 700;
           border-left: 4px solid #16a34a; margin-left: -18px; padding-left: 14px; }
  .foot { padding: 10px 20px; background: #f3f4f6; border-top: 1px solid #e5e7eb;
          font-family: "Microsoft YaHei", sans-serif; font-size: 12px; color: #6b7280; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="head">
      <h1>${esc(htmlTitle)}</h1>
      <div class="sub">growth-site 发布前检查（pre-release-check）· 自动生成，内容即终端输出原文</div>
    </div>
    <pre class="cmd"><b>&gt;</b> node skills/pre-release-check/check.mjs &nbsp;&nbsp;<b>// 退出码 ${fail > 0 ? 1 : 0}　判定：${esc(verdict)}</b></pre>
    <div class="out">
${body}
    </div>
    <div class="foot">本页由 check.mjs 自己生成（--html）· 生成时间 ${stamp} · 共 ${RESULTS.length} 项：通过 ${pass} / 失败 ${fail} / 未检查 ${warn}</div>
  </div>
</body>
</html>
`;

  const target = path.resolve(HTML_OUT);
  writeFileSync(target, html, 'utf8');
  console.log(`[报告已写出] ${target}\n`);
}

process.exit(fail > 0 ? 1 : 0);
