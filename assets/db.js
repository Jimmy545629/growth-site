/* db.js —— **数据访问层**：全项目唯一跟云端数据库说话的文件。
   ============================================================
   建立于 Day 19（2026-10-05）。

   【这一天做的事，一句话】
   「查数据库」那段代码，原来跟校验、中文提示、页面契约**挤在同一个文件**
   （`assets/cloud.js`）里。今天把它整段搬到了这里。
   → **从 `assets/cloud.js` 移到了 `assets/db.js`。**

   【为什么要拆开】
   一个文件同时干四件事的时候，会出两种毛病：
     ① 想换个数据源（比如换一张表、换一个字段），得在一堆校验和文案里翻；
     ② 校验和文案是「我们的规矩」，查表是「数据库的事」，
        两者混在一起，改一边就容易顺手碰坏另一边。
   拆开以后，各管各的：

     页面（app.js）
        ↓ 只会调 GROWTH_CLOUD 那几个函数，不知道底下有数据库
     接口层（cloud.js）—— 校验入参 / 编中文提示 / 编排 / 保证返回形状对得上契约
        ↓ 只会调 GROWTH_DB 那几个函数，不知道 SDK 长什么样
     数据访问层（db.js，就是本文件）—— 等 SDK / 建连接 / 查什么表取哪些列
        ↓
     云端数据库

   ⚠️ **这一层的规矩（很要紧，别破坏）**：
     · **只说话，不做判断** —— 它只回答「数据取回来没有」，
       不判断「标题该不该 60 字以内」、不编任何中文句子。
     · **失败也走 resolve，不往上报错** —— 统一收成 { ok:false, reason }，
       上层不用写 try/catch。
     · **返回的是数据库原本的样子** —— 不做格式化、不挑字段、
       不含任何「这个项目自己的说法」。这样以后换数据库，只改这一个文件。

   【对外面那三个词：ok / reason / error】
     读成功 → { ok:true, rows:[…] }（rows 可能是空数组 —— **空不是失败**，
              是「库里确实一条都没有」，由上层决定该说什么）
     读失败 → { ok:false, reason:'no-sdk' | 'no-client' | 'query-failed', error? }
     写成功 → { ok:true, row:{…} }（数据库返回的那一整行原样带出来）
     写失败 → { ok:false, reason:'no-sdk' | 'no-client' | 'write-rejected' | 'empty-result', error? }

   【为什么失败也要分这么细】
     上层靠 reason 决定给用户哪种说法：
     没联网 / 连接没建起来 / 请求发出去了没拿到结果 —— 这是**三件不同的事**，
     对用户来说「去检查网络」和「稍后再试」是不一样的建议。

   【怎么调云端】
   用官方 SDK（@tencent-ai/workbuddy-cloud-sdk 的浏览器版本）。
   ⚠️ 这是**唯一**正确的调用方式，不许自己手写 fetch 去拼 /.cloud/…
   的地址 —— 那样会丢掉 SDK 负责的鉴权和会话管理。

   ⚠️ **本文件也适用于「同一个事实只允许有一个来源」那条硬规矩（AGENTS 第 4 条第 9 项）**：
   表名 / 列名 / 排序方式**只在这一个文件里出现**。上面那几层不许自己再拼一遍查询。

   加载顺序（见 index.html）：config.js → **db.js** → cloud.js → rules.js
   → store.js → data.js → app.js
   ============================================================ */

(function () {
  'use strict';

  /* 表名、栏位上限这些常量都在 config.js（AGENTS 第 4 条第 7 项：常量只在一个地方）。 */
  var C = window.GROWTH_CONFIG;

  /* ---------- 等 SDK ----------
     SDK 的浏览器版本用 <script> 引进来，挂在 window.WorkBuddyCloud 上。
     ⚠️ ⚠️ 这里踩过一个真坑（Day 17，实测，比想象中隐蔽）：
     一开始写的是「跑的时候看一眼，没有就返回 no-sdk」。
     结果首屏**经常**报「云端组件没加载成功」，而实际上 SDK 是好的 ——
     因为外部脚本是异步下载的，**我的代码可能比它先跑到**。
     那一刻 window.WorkBuddyCloud 还不存在，我就把「没有」当成了结论。
     → 正确做法：**等它一会儿**（轮询几秒），而不是看一眼就下结论。
     这条值得记住：**「现在还没有」和「根本没有」是两件事**，
     代码里必须分清楚，否则会偶发、难复现、看起来像网络问题。 */
  function waitForSdk(timeoutMs) {
    var limit = timeoutMs || 6000;
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function tick() {
        if (window.WorkBuddyCloud) return resolve(window.WorkBuddyCloud);
        if (Date.now() - t0 >= limit) return resolve(null);
        setTimeout(tick, 120);
      })();
    });
  }

  /* 客户端只建一次（建两次会有两个会话，白白多打一倍请求）。
     为什么放在这里而不是每个查询各建各的：连接是「数据访问」这件事的一部分，
     跟「查哪张表」一样属于这一层。上面两层都不该知道有这么个东西。 */
  var client = null;

  function buildClient(WB) {
    if (client) return client;
    try {
      client = WB.createWorkBuddyCloud({
        endpoint: C.cloud.endpoint,
        oauthRelayBaseUrl: C.cloud.oauthRelayBaseUrl,
        publishableKey: C.cloud.publishableKey
      });
    } catch (e) {
      client = null;
    }
    return client;
  }

  /* ---------- 失败形状的工厂 ---------- */
  function noSdk()     { return { ok: false, reason: 'no-sdk' }; }
  function noClient()  { return { ok: false, reason: 'no-client' }; }
  function queryFail(e){ return { ok: false, reason: 'query-failed', error: e }; }

  /* ---------- 所有「读」都走这里 ----------
     干四件事：等 SDK → 建连接 → 执行查询 → 把结果收成统一形状。
     ⚠️ 为什么参数是个函数（build）而不是直接给查询：
     因为「用哪个连接去查」这件事只有这一层知道，
     上层只需要说清「我要什么数据」（像 selectEntries 那样），不用管连接。

     入参：build(c) → 一个 SDK 的查询对象（Promise，结果里带 { data, error }）
     出参：{ ok:true, rows:[…] } | { ok:false, reason:'no-sdk'|'no-client'|'query-failed' } */
  function runQuery(build) {
    return waitForSdk().then(function (WB) {
      if (!WB) return noSdk();

      var c = buildClient(WB);
      if (!c) return noClient();

      return build(c).then(function (res) {
        /* ⚠️ PostgREST（云端数据库对外的那套接口）把出错放在 res.error 里，
           而不是 reject —— 所以这里必须主动看一眼，不能只靠 catch。 */
        if (res && res.error) return queryFail(res.error);
        return { ok: true, rows: (res && res.data) || [] };
      });
    }).catch(function (e) {
      /* 意外异常（比如 SDK 内部抛错）也收成统一的失败形状，不往上面抛。 */
      return queryFail(e);
    });
  }

  /* ============================================================
     一、读
     ============================================================ */

  /* ---------- 读当日热搜（Day 17 加，本来在 cloud.js） ----------
     表：config 里的 C.hot.table（hot_topics）—— 每日真实热搜快照（来源：百度实时热搜）。
     这张表**只有 SELECT 权限**（Day 16 定的边界），网页一行也写不进去。

     ⚠️ 为什么一次取 400 条（而不是只取页面上要显示的那 8 条）：
     因为「今天是哪天」这件事要由上层按**浏览器本地时间**判断，
     而数据库里的 topic_date 是日期类型 —— 让数据库去算「今天」，时区会错位。
     所以这一层把最近的整份数据都拿回来，让上层自己去挑那一天。
     （README 里那条「日期一律用本地时间拼」的坑就是这么来的。）

     出参：{ ok:true, rows:[…] }（原样，不排序不截断） */
  function selectHotTopics() {
    return runQuery(function (c) {
      return c.database
        .from(C.hot.table)
        .select('id, topic_date, rank, title, summary, hot_value, hot_text, url, source_key, source_name')
        .order('rank', { ascending: true })
        .limit(400);
    });
  }

  /* ---------- 读来源名单（Day 18 加，本来在 cloud.js） ----------
     表：config 里的 C.entry.sourceTable（sources）。

     为什么需要它：「新增一条」那张表单的下拉要填 sources 里的**真 id**。
     填一个库里不存在的东西，写进去会被外键顶回来 ——
     所以这份名单必须现读，不能在本地另写一份（那就是第二个来源了）。

     出参：{ ok:true, rows:[{ id, name, column_key, kind }] } */
  function selectSources() {
    return runQuery(function (c) {
      return c.database
        .from(C.entry.sourceTable)
        .select('id, name, column_key, kind')
        .order('column_key', { ascending: true });
    });
  }

  /* ---------- 读内容库三列的条目（Day 18 加，本来在 cloud.js） ----------
     表：config 里的 C.entry.table（contents），只取 kind='entry' 那些行。

     ⚠️ 尾巴上那个 sources(…) 是 PostgREST 的「一次查两张表」写法：
     靠 contents.source_id → sources.id 那个外键，把来源的字段一并取回
     （因为「这条属于哪一栏」存在 sources.column_key 上，不在内容本身上）。
     它比「查两次、再在页面里按 id 对上」稳 ——
     两次查之间库要是变了，拼出来的东西就是错的。

     排序：新的排前面。这样「刚加的那条」永远在第一栏最上面，一眼看得见。

     出参：{ ok:true, rows:[ {…contents 那一行的字段…, sources:{…}} ] } */
  function selectEntries() {
    return runQuery(function (c) {
      return c.database
        .from(C.entry.table)
        .select('id, source_id, kind, title, tag, media, dur, url, summary, detail, created_at, sources(name, platform, column_key, note)')
        .eq('kind', C.entry.kind)
        .order('created_at', { ascending: false })
        .limit(200);
    });
  }

  /* ---------- 查「同一条内容是不是已经有了」（Day 18 加，本来在 cloud.js） ----------
     用途：写入前的**第一道防线**（先查重，好给一句准的中文提示）。
     ⚠️ 它**不是安全措施** —— 页面代码可以被绕过，
     真正拦得住重复的是数据库那一侧的**唯一约束**（见 insertContent 里的 23505）。

     ⚠️ 只取 id 一列：这一问只关心「有没有」，把整行取回来是白费流量。

     出参：{ ok:true, rows:[{ id }] }（空数组 = 查过了，没有） */
  function selectEntryByTitle(sourceId, title) {
    return runQuery(function (c) {
      return c.database
        .from(C.entry.table)
        .select('id')
        .eq('source_id', sourceId)
        .eq('title', title)
        .limit(1);
    });
  }

  /* ============================================================
     二、写：往 contents 表插一行（Day 18 加，本来在 cloud.js）
     ============================================================
     ⚠️ 这张表只开了**很窄**一个口子：只给 INSERT（新增），
     **不给** UPDATE / DELETE。所以「谁能改、谁能删」那两扇门依然是关着的。
     上面那一层（cloud.js / 页面）**不需要**知道这件事 ——
     权限是数据库那侧的规矩，不是代码里的分支。

     入参：row —— 要写进去的那一行（字段由上层按契约拼好）
     出参：{ ok:true, row:{…} }
           { ok:false, reason:'no-sdk'|'no-client'|'write-rejected'|'empty-result', error? } */
  function insertContent(row) {
    return waitForSdk().then(function (WB) {
      if (!WB) return noSdk();

      var c = buildClient(WB);
      if (!c) return noClient();

      /* ⚠️ `.select()` 不能省：PostgREST 的写法里，insert 后面接 select
         才会**把写进去的那一行返回**（Prefer: return=representation）。
         不接的话只知道「没报错」，根本不知道存成了什么。 */
      return c.database
        .from(C.entry.table)
        .insert(row)
        .select()
        .then(function (res) {
          if (res && res.error) {
            /* code 是数据库原始错误码，**这里不翻译**。
               23505（唯一约束 / 主键冲突）该说成「这条已经在了」还是「存失败」，
               是这个项目的说法，属于接口层的事 —— 所以原样往上带，由 cloud.js 判。 */
            return { ok: false, reason: 'write-rejected', error: res.error };
          }

          var got = (res && res.data) || [];
          /* ⚠️⚠️ 空数组 = 一行也没动 = **没成功**（契约 2.6 ②）。
             这是这一块最容易写错的地方：行级权限把写入挡住时，PostgREST
             **不给 error**，只给一个空的 data。当成成功处理，就会出现
             「页面说存好了、库里什么都没有」——比报错还糟。
             ⚠️ 所以「写成功」的判据是**返回里有行**，不是「没报错」。 */
          if (!got.length) {
            return { ok: false, reason: 'empty-result', error: '数据库没有返回写入后的那一行' };
          }

          return { ok: true, row: got[0] };
        });
    }).catch(function (e) {
      return { ok: false, reason: 'write-rejected', error: String((e && e.message) || e) };
    });
  }

  window.GROWTH_DB = {
    /* 读 */
    selectHotTopics: selectHotTopics,
    selectSources: selectSources,
    selectEntries: selectEntries,
    selectEntryByTitle: selectEntryByTitle,
    /* 写 */
    insertContent: insertContent
  };

})();
