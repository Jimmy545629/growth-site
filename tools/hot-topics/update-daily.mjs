#!/usr/bin/env node
/* ============================================================
   每日热搜抓取（Day 27 加）
   ============================================================

   干什么：从百度实时热搜抓一份**当天**的快照，写出两条可以直接执行的 SQL。
   产物：`--out` 目录下的两个文件（默认 `.tmp/`）——
         `hot-01-delete.sql`（先跑）＋ `hot-02-insert.sql`（后跑）；
         日志打到标准错误（stderr）。

   ⚠️ 为什么是**两条**、而不是一条：见文件末尾那段「踩坑记录」。
   （一句话：PG 里用 CTE 把「删+插」凑成一条语句**不幂等**，当天第二次跑必撞主键。）

   ⚠️ 为什么只生成 SQL、不直接写库：
   写库需要管理员权限，而网页那侧**只有读权限**（Day 27 路线A 之后
   连写权限都收回了）。所以这一步只负责「抓干净数据 + 拼好 SQL」，
   执行由助手走管理员通道。
   → 将来要是有了带密钥的服务端，把最后一步换成一次 INSERT 就行，
     前面这些解析逻辑一行都不用动。

   ⚠️ 抓的是公开页面里的 s-data 数据块，不是官方 API：
   百度没有开放热搜接口，这个 `<!--s-data:...-->` 是它自己页面用的数据。
   所以**字段名变了要能一眼看出来** —— 下面每一步都带断言，
   抓不到就直接报错退出，**绝不返回半份数据**（宁可这次不更新，
   也不能把残缺的榜单写进库里）。

   用法：
     node tools/hot-topics/update-daily.mjs                 # 抓今天，写两个 SQL 文件
     node tools/hot-topics/update-daily.mjs --date=2026-10-13
     node tools/hot-topics/update-daily.mjs --out=.tmp       # 指定输出目录（默认就是 .tmp）
     node tools/hot-topics/update-daily.mjs --json           # 只看解析结果，不写文件
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';

const BOARD = 'https://top.baidu.com/board?tab=realtime';
const TOP_N = 30;          /* 一天存几条。跟库里已有的两份快照保持一致（都是 30）。 */
const MIN_ROWS = 10;       /* 少于这个数就认为没抓对，整次作废 */

/* 有些站会按 UA 给不同内容 —— 带一个正常浏览器的 UA，拿到的就是 PC 版那套完整数据。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const dateArg = (args.find(function (a) { return a.startsWith('--date='); }) || '').slice(7);
const outArg = (args.find(function (a) { return a.startsWith('--out='); }) || '').slice(6);

/* 本地日期（这台机器就是 +08:00，跟榜单的更新时间对得上）。
   ⚠️ 不用 toISOString()：那是 UTC，晚上 8 点之后会算成「明天」，日期就串了。 */
function todayLocal() {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const date = dateArg || todayLocal();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die('日期格式不对：' + date + '（应该是 YYYY-MM-DD）');

function die(msg) {
  process.stderr.write('✗ ' + msg + '\n');
  process.exit(1);
}

/* SQL 字符串转义：把单引号翻倍。榜单标题里出现英文撇号是可能的。 */
function q(v) {
  if (v === null || v === undefined || v === '') return "''";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

const res = await fetch(BOARD, { headers: { 'User-Agent': UA, 'Referer': 'https://top.baidu.com/' } })
  .catch(function (e) { die('抓取失败（网络层）：' + e.message); });

if (!res.ok) die('抓取失败：HTTP ' + res.status);
const html = await res.text();

/* ① 把页面里那段数据块抠出来 */
const m = /<!--s-data:([\s\S]*?)-->/.exec(html);
if (!m) die('页面里找不到 s-data 数据块（百度改版了？）');

let parsed;
try {
  parsed = JSON.parse(m[1]);
} catch (e) {
  die('s-data 不是合法 JSON（百度改版了？）：' + e.message);
}

/* ② 找到「实时热搜」那张卡 */
const cards = (parsed.data && parsed.data.cards) || [];
const card = cards.find(function (c) { return c && c.component === 'hotList'; });
if (!card) die('没有 hotList 卡片（百度改版了？）');

const items = card.content || [];
if (!items.length) die('榜单是空的');

/* ③ 逐条挑字段。缺 word 的跳过 —— 标题都没有的条目没法展示。 */
/* ⚠️ 坑（2026-10-13 实测踩到）：页面给的 hotScore 是**字符串**（"7903997"），
   不是数字。第一版写成 `typeof === 'number'`，结果 30 条热度**全丢成空**——
   而且不报错，安安静静写进库，页面上只是「热度那一格不见了」。
   → 一律 Number() 转一遍，转不出数字就当没有（不猜、不补 0）。 */
function toScore(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const rows = [];
let noScore = 0;
for (const it of items) {
  if (!it || !it.word) continue;
  const score = toScore(it.hotScore);
  if (score === null) noScore++;
  rows.push({
    rank: rows.length + 1,
    title: it.word,
    summary: it.desc || '',
    hot_value: score,
    /* 页面上的「780.92w」= 原始热度 ÷ 10000，保留两位。
       ⚠️ 跟库里已有那两份快照的写法一致（实测 7809199 → 780.92w）。 */
    hot_text: score === null ? '' : (score / 10000).toFixed(2) + 'w',
    url: it.url || ''
  });
  if (rows.length >= TOP_N) break;
}

if (rows.length < MIN_ROWS) die('只解析到 ' + rows.length + ' 条（少于 ' + MIN_ROWS + ' 条），判定为没抓对');

/* 热度大面积缺失 = 字段名八成变了。这种情况**不许悄悄写进去** ——
   页面上只是「热度那一格不见了」，没人会注意到，榜单的可信度却已经掉了。 */
if (noScore > rows.length / 2) {
  die('热度字段大面积缺失（' + noScore + '/' + rows.length + ' 条没有热度）—— 页面结构可能改了，先去看一眼');
}

process.stderr.write('✓ 抓到 ' + rows.length + ' 条，日期 ' + date + '\n');
process.stderr.write('  前 3 条：' + rows.slice(0, 3).map(function (r) { return r.rank + '.' + r.title; }).join(' / ') + '\n');

if (wantJson) {
  process.stdout.write(JSON.stringify({ date: date, rows: rows }, null, 2) + '\n');
  process.exit(0);
}

/* ④ 拼 SQL：**两条**，由执行侧依次跑（先删当天、再插新的）。

   ============================================================
   ⚠️⚠️ 踩坑记录（Day 27 当天，两个坑里的第二个，也是更值钱的那个）
   ------------------------------------------------------------
   第一版写的是「数据修改型 CTE」：想用**一条**语句把「删当天 + 插新的」
   合成一步，注释还理直气壮写着「天然幂等」。**它不幂等。**

   实测（当天就复现了，用一张临时表两分钟就验死）：当天第一次跑成功；
   **第二次跑必失败**，报：
     DATABASE_23505 duplicate key value violates unique constraint "hot_topics_pkey"

   原因：PG 里 `WITH` 的数据修改子语句和主查询**共用同一个快照、并发执行**，
   互相看不见对方的效果 —— 所以 INSERT 做唯一索引检查时，
   那个旧行**还没被标记成删除**，于是撞主键。

   为什么阴：**首次跑一定成功，只有「重复跑」才炸。**
   而自动化里常带一句「失败就重试一次」——那正好等于「第一次成功、重试必失败」，
   看起来像网络抖了一下，查起来极费劲。
   （当时的临时绕法是手工把同一条语句拆成两步跑；现在直接固化进脚本。）

   → 现在的做法：**老老实实输出两条语句**，执行侧依次跑。
     不图「一条语句」的漂亮 —— **幂等比短更重要。**
   ============================================================ */

const delSql = 'DELETE FROM hot_topics WHERE topic_date = ' + q(date) + ';\n';

const values = rows.map(function (r) {
  return '(' + [
    q('baidu-' + date + '-' + String(r.rank).padStart(2, '0')),
    q(date),
    String(r.rank),
    q(r.title),
    q(r.summary),
    r.hot_value === null ? 'NULL' : String(r.hot_value),
    q(r.hot_text),
    q(r.url),
    q('baidu'),
    q('百度实时热搜')
  ].join(', ') + ')';
}).join(',\n  ');

const insSql =
  'INSERT INTO hot_topics\n' +
  '  (id, topic_date, rank, title, summary, hot_value, hot_text, url, source_key, source_name)\n' +
  'VALUES\n  ' + values + ';\n';

const outDir = outArg || '.tmp';
fs.mkdirSync(outDir, { recursive: true });
const delPath = path.join(outDir, 'hot-01-delete.sql');
const insPath = path.join(outDir, 'hot-02-insert.sql');
fs.writeFileSync(delPath, delSql, 'utf8');
fs.writeFileSync(insPath, insSql, 'utf8');

process.stdout.write(delPath + '\n' + insPath + '\n');
