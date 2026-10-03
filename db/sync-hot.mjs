/* db/sync-hot.mjs —— 「今日热点」的真实热搜同步任务。
   ============================================================
   建立于 Day 17（2026-10-03）。

   【它做什么】
   从公开的热搜接口拉一份**真实**的百度实时热搜，规范化之后写进云端
   `hot_topics` 表，一天一份（当日快照）。

   【为什么要有「规范化」这一步 —— 这是 Day 17 的核心】
   两个真实数据源对同一个百度热搜，返回的字段**根本不一样**：

     字段        源 A（60s.viki.moe）        源 B（top.baidu.com 官方）
     ---------   ------------------------    ------------------------
     条数        50 条                       51 条（含 1 条置顶）
     标题        title                       word        ← 名字不同
     排名        rank                        index       ← 置顶那条没有
     热度        score（字符串 "7808196"）   完全没有
     摘要        desc（有正文）              完全没有
     链接        www.baidu.com/s             m.baidu.com/s ← 域名不同
     更新时间    两个源都不给！

   所以这个脚本的第一件事不是「发请求」，而是**把两个源的不同形状，
   统一成表里那几列**。这一步叫「规范化」（normalize）。

   ⚠️ 关键决定：**更新时间是我们自己打的，不是源给的。**
   两个源都不给时间字段，而「当日真实热搜」必须能判断是不是当天的。
   所以 topic_date 用**本机（北京时间）的今天**，fetched_at 用现在。
   —— 这是如实的：数据库里记的是「我们什么时候抓的」，不是「百度什么时候更新的」。
      两者不是一回事，所以字段名就叫 fetched_at（抓取时间），不叫 updated_at（更新时间）。

   【为什么用 curl 而不是引 SDK】
   这个脚本跑在你的电脑上（沙箱里），不是网页。网页用的是官方 SDK
   （assets/cloud.js），这里用 Node 自己发请求 —— 因为 Node 环境里没有浏览器
   的那些东西，SDK 的浏览器构建跑不顺。两条路走的是**同一个数据面**，
   同一个鉴权头 `x-wb-webapp-access-key`，只是调用方式不同。

   【跑法】
     cd C:\Users\33386\WorkBuddy\growth-site
     node db/sync-hot.mjs

   【幂等】
   同一天重复跑，结果一样（靠主键 + ON CONFLICT 覆盖）。
   抓取失败时**不删旧数据** —— 宁可留着昨天的，也不要让页面空掉。
   ============================================================ */

/* ⚠️ 踩坑记录 2（Day 17，实测）—— 这个比第 1 条值钱：
   抓取成功（50 条真实热搜），但**写库被拒**：
     HTTP 401 {"code":"DATABASE_42501","message":"permission denied for table hot_topics"}

   查了两道门之后弄清楚了，这不是 bug：
     第 1 道 GRANT  → anon 有 SELECT、authenticated 全权限，**门是开的**
     第 2 道 POLICY → 只有一条 hot_topics_read_all（SELECT），
                      **没有 INSERT / UPDATE 策略，这扇门是关着的**
   —— 这是我们 Day 16 就定下的安全边界：**网页只能读、不许写**。

   所以「让网页带上写权限」是错的方向（那会把内容表变成任何人都能改）。
   正确做法：**抓取归抓取（本脚本），入库走维护者通道**（管理员 SQL，绕过 RLS）。
   于是脚本支持两种模式：
     node db/sync-hot.mjs           → 抓取 + 规范化，把 SQL 打印出来
     node db/sync-hot.mjs --sql     → 只打印那条 SQL（方便直接复制去执行）
   （原来那条「自己 POST 写库」的路故意留着，注释说明为什么不用 —— 以后别绕回去。）
*/

/* ⚠️ 踩坑记录 1：本来用 child_process 的 spawnSync 调系统 curl，
   在 Windows 上稳定报 `spawnSync curl EBUSY`，两个源全挂，
   看起来像「数据源挂了」，其实是本地调用方式不对。
   → 改用 Node 自带的 fetch（Node 18+ 内置），少一层跨进程，稳。 */

/* ---------- 一、配置 ---------- */

/* 数据面地址与「公开钥匙」。这两个值来自云服务开通时返回的 publicConfig，
   本来就允许放进前端代码（钥匙本身不带权限，权限由服务端按来源校验）。

   ⚠️⚠️ 这两个值必须和 assets/config.js 里的 cloud 段**完全一致**，
   也必须属于「网页当前挂的那个域名」——服务端按来源（Origin）精确匹配，
   对不上会一口回绝 403（浏览器只会报含糊的 Failed to fetch）。
   今天踩过这个坑，详见 assets/config.js 的「踩坑记录 4」。 */
const ENDPOINT = 'https://source-board.app.workbuddy.host';
const PUBLISHABLE_KEY = 'wbpk_e8u8wxL7HunoPn0U8X5CS7_g94jZpavt3LlRkSgivp4QtXNPeP7p655';

/* 主用源：开源项目 60s 的公共实例。字段最全（有摘要、有热度值）。 */
const SOURCE = {
  key: 'baidu',
  name: '百度实时热搜',
  url: 'https://60s.viki.moe/v2/baidu/realtime',
  /* 备用源：百度官方接口。字段少（没热度、没摘要），主源挂了才用。
     实测：必须带一个手机端 UA，否则百度会把请求挡掉。 */
  fallbackUrl: 'https://top.baidu.com/api/board?platform=wise&tab=realtime',
  fallbackUa: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
};

/* 一天存几条。50 条足够「看热点」，再多页面也放不下。
   （这也是今天「余力加练」那条的伏笔：以后可以让接口带一个 limit 参数。） */
const LIMIT = 30;

/* ---------- 二、拿今天（北京时间）的日期 ---------- *//* 为什么不用 toISOString()：那个给的是 UTC 时间，国内晚上 8 点之后
   会被算成「第二天」，快照就记错日期了。这条坑项目里早就踩过
   （见 README「日期一律用本地时间拼」）。 */
function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------- 三、发请求 ---------- */
/* Node 18+ 自带 fetch。超时靠自己包的 AbortSignal.timeout —— 
   没有超时的话，一个卡住的源会把整个同步任务拖死。 */
async function getJson(url, ua) {
  const headers = {};
  if (ua) headers['User-Agent'] = ua;
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const text = await resp.text();
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: '返回的不是合法 JSON：' + e.message + '（前 120 字：' + text.slice(0, 120) + '）' };
    }
  } catch (e) {
    return { ok: false, error: (e.name || 'Error') + '：' + e.message };
  }
}

/* ---------- 四、规范化：把两个源的不同形状，统一成表里的列 ---------- */

/* 千分位字符串 → 数字。"7808196" → 7808196；不是数字就返回 null。
   ⚠️ 注意这里**不报错**：外面来的数据不许假设它长得对。 */
function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/* 源 A（60s.viki.moe）→ 统一形状 */
function fromSourceA(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.map((it) => ({
    rank: toNumber(it.rank),
    title: String(it.title || '').trim(),
    summary: String(it.desc || '').trim() || null,
    hotValue: toNumber(it.score),
    hotText: String(it.score_desc || '').trim() || null,
    url: String(it.url || '').trim() || null
  }));
}

/* 源 B（top.baidu.com 官方）→ 统一形状。
   注意它的标题字段叫 word、排名字段叫 index，而且置顶那条没有 index。
   热度、摘要这两项它**根本没有** —— 所以规范化后留 null，不编一个填进去。 */
function fromSourceB(json) {
  const items = json?.data?.cards?.[0]?.content?.[0]?.content || [];
  const rows = [];
  let n = 0;
  for (const it of items) {
    if (it.isTop) continue;               /* 置顶位不算榜单名次，跳过 */
    n += 1;
    rows.push({
      rank: toNumber(it.index) ?? n,
      title: String(it.word || '').trim(),
      summary: null,                      /* 官方源不给摘要 */
      hotValue: null,                     /* 官方源不给热度值 */
      hotText: null,
      url: String(it.url || '').trim() || null
    });
  }
  return rows;
}

/* ---------- 五、拼入库 SQL ---------- */
/* 为什么是「拼 SQL」而不是「自己发请求写库」：
   见文件开头「踩坑记录 2」—— 网页这条通道只有 SELECT 权限（Day 16 定的边界），
   写不进去。而维护者通道（管理员 SQL）能写，且它本来就绕过 RLS，
   正是为「灌数据」准备的。所以脚本负责**抓取 + 规范化 + 拼 SQL**，
   真正的执行交给那条唯一有权写的路。

   SQL 里用了 ON CONFLICT (id) DO UPDATE —— 跟 Day 16 的种子脚本一个写法：
   同一天重复跑，结果一样，不会插重复。 */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function buildSql(rows) {
  const values = rows.map((x) => [
    sqlLiteral(x.id),
    sqlLiteral(x.topic_date) + '::date',
    String(x.rank),
    sqlLiteral(x.title),
    sqlLiteral(x.summary),
    x.hot_value === null ? 'NULL' : String(x.hot_value),
    sqlLiteral(x.hot_text),
    sqlLiteral(x.url),
    sqlLiteral(x.source_key),
    sqlLiteral(x.source_name)
  ].join(', '));

  return 'INSERT INTO hot_topics (id, topic_date, rank, title, summary, hot_value, hot_text, url, source_key, source_name) VALUES\n'
    + rows.map((_, i) => '  (' + values[i] + ')').join(',\n')
    + '\nON CONFLICT (id) DO UPDATE SET\n'
    + '  topic_date  = EXCLUDED.topic_date,\n'
    + '  rank        = EXCLUDED.rank,\n'
    + '  title       = EXCLUDED.title,\n'
    + '  summary     = EXCLUDED.summary,\n'
    + '  hot_value   = EXCLUDED.hot_value,\n'
    + '  hot_text    = EXCLUDED.hot_text,\n'
    + '  url         = EXCLUDED.url,\n'
    + '  source_key  = EXCLUDED.source_key,\n'
    + '  source_name = EXCLUDED.source_name,\n'
    + '  fetched_at  = now();';
}

/* ---------- 六、主流程 ---------- */

async function main() {
  const date = todayLocal();
  console.log('=== 今日热点同步 · ' + date + ' ===');

  /* 6.1 先试主源 */
  console.log('主源：' + SOURCE.url);
  let r = await getJson(SOURCE.url);
  let rows = [];
  let usedSource = SOURCE.key;

  if (r.ok) {
    rows = fromSourceA(r.json);
    console.log('  主源返回，规范化后 ' + rows.length + ' 条');
  } else {
    console.log('  主源失败：' + r.error);
  }

  /* 6.2 主源不给力（失败 / 条数太少），切备用源。
         —— 这就是任务清单里「附录 F 切备用源」那一步的做法。 */
  if (rows.length < 5) {
    console.log('切备用源：' + SOURCE.fallbackUrl);
    const r2 = await getJson(SOURCE.fallbackUrl, SOURCE.fallbackUa);
    if (r2.ok) {
      const rows2 = fromSourceB(r2.json);
      console.log('  备用源返回，规范化后 ' + rows2.length + ' 条');
      if (rows2.length > rows.length) {
        rows = rows2;
        usedSource = SOURCE.key + '(官方)';
      }
    } else {
      console.log('  备用源也失败：' + r2.error);
    }
  }

  /* 6.3 两个源都拿不到 → **保留旧数据**，如实报告，不假装成功。
         宁可页面上显示的是上一份，也不要让它空掉或者显示编的东西。 */
  if (rows.length < 5) {
    console.log('');
    console.log('❌ 两个源都拿不到可用数据 —— 本次**不写入**，云库里原有的记录保持不变。');
    console.log('   （页面会继续显示上一次抓到的内容，不会空、也不会变成假数据。）');
    process.exitCode = 2;
    return;
  }

  /* 6.4 丢掉没标题的、截断到 LIMIT、补上日期与主键 */
  const cleaned = rows
    .filter((x) => x.title)
    .slice(0, LIMIT)
    .map((x, i) => ({
      /* 主键：来源 + 日期 + 名次。同一天同一条重复入库时会撞主键，
         正好被 ON CONFLICT 覆盖掉 —— 这就是幂等的实现方式。 */
      id: `${SOURCE.key}-${date}-${String(i + 1).padStart(2, '0')}`,
      topic_date: date,
      rank: i + 1,
      title: x.title,
      summary: x.summary,
      hot_value: x.hotValue,
      hot_text: x.hotText,
      url: x.url,
      source_key: SOURCE.key,
      source_name: SOURCE.name
    }));

  /* 6.5 拼出入库 SQL 并输出。
         --sql 模式只输出 SQL（方便复制到管理器执行）；
         默认模式输出 SQL + 一份「人看的」摘要。 */
  const sql = buildSql(cleaned);
  const onlySql = process.argv.includes('--sql');

  if (onlySql) {
    console.log(sql);
    return;
  }

  console.log('');
  console.log('✅ 抓到并规范化 ' + cleaned.length + ' 条真实热搜（' + date + '，来源：' + usedSource + '）');
  console.log('   前 5 条：');
  cleaned.slice(0, 5).forEach((x) => {
    console.log('   ' + String(x.rank).padStart(2, ' ') + '. ' + x.title
      + (x.hot_text ? '  [' + x.hot_text + ']' : ''));
  });
  console.log('');
  console.log('--- 入库 SQL（用 --sql 可只输出这一段）---');
  console.log(sql);
  console.log('--- SQL 结束 ---');
  console.log('');
  console.log('下一步：把上面这段 SQL 交给维护者通道执行（管理员权限），');
  console.log('       因为网页那条通道只有 SELECT 权限 —— 这是 Day 16 定的边界，不是 bug。');

  /* 把 SQL 同时写一份到文件，方便直接取用（放在 .tmp/，不进 git）。 */
  const fs = await import('node:fs');
  const outDir = 'C:/Users/33386/WorkBuddy/2026-10-03-14-59-26/.tmp/day17';
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outDir + '/hot-' + date + '.sql', sql, 'utf8');
    console.log('（同一段 SQL 已写到 ' + outDir + '/hot-' + date + '.sql）');
  } catch (e) {
    console.log('（写临时文件失败，不影响：' + e.message + '）');
  }
}

main();
