/* cloud.js —— 所有「读写云端」的逻辑。
   ============================================================
   建立于 Day 17（2026-10-03）。

   ⚠️ **这是全项目唯一允许碰云端的文件。**
   跟 store.js 是同一个思路（老项目 Day 6 规矩第 6 条）：
   把「数据从哪来」这件事关在一个文件里，页面代码一个字都不用知道
   数据是来自本地抽屉还是来自云端。以后要换数据源，只改这一个文件。

   【它读什么（Day 17）】
   云端数据库的 `hot_topics` 表 —— 每日真实热搜快照（来源：百度实时热搜）。
   这张表**只有 SELECT 权限**（Day 16 定的边界），网页一行也写不进去。

   【它写什么（Day 18）】
   云端数据库的 `contents` 表 —— 内容库的条目。
   ⚠️ Day 18 给这张表开了一个**很窄**的口子：只给 INSERT（新增），
   **不给** UPDATE / DELETE。所以「谁能改、谁能删」那两扇门依然是关着的。
   ⚠️ 为什么能写：这个项目不做登录（PRD 第 2 条），页面用的是匿名身份。
   代价是**任何打开网页的人都能调这个新增接口**。这条是**知情之后才开的口子**，
   不是漏想的 —— 写进了 docs/api-contract.md 第三节。

   【怎么调云端】
   用官方 SDK（@tencent-ai/workbuddy-cloud-sdk 的浏览器版本）。
   ⚠️ 这是**唯一**正确的调用方式，不许自己手写 fetch 去拼 /.cloud/…
   的地址 —— 那样会丢掉 SDK 负责的鉴权和会话管理。

   【断网 / 云端读不到会怎样】
   **不白屏、不报错、不假装有数据。**
   返回 { ok:false, reason:… }，由 app.js 决定显示「暂时读不到」还是
   退回本地内容。宁可如实说「这次没读到」，也不要编一条数据顶上
   （这是 PRD 硬约束 C4 的精神：不许编）。

   加载顺序（见 index.html）：config.js → cloud.js → rules.js → store.js
   → data.js → app.js
   ============================================================ */

(function () {
  'use strict';

  var C = window.GROWTH_CONFIG;

  /* SDK 的浏览器版本用 <script> 引进来，挂在 window.WorkBuddyCloud 上。
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

  /* 客户端只建一次（建两次会有两个会话，白白多打一倍请求）。 */
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

  /* ---------- 读当日热搜 ----------
     入参：limit（要几条，默认按 config 里那个数）
           ⚠️ 这个 limit 来自地址里的 '?hot=N'（Day 17 余力加练），
           由 rules.js 的 hotLimitFromHash() 校验过（1~30 的整数），
           到这里已经是可信的；但函数本身仍然不假设它一定合法 ——
           外面的东西一律不当成「长得对」。
     出参：{ ok:true, rows:[…], date:'2026-10-03', total:库内这一天共几条 }
           { ok:false, reason:'no-sdk' | 'no-client' | 'query-failed' | 'empty' } */
  function fetchHotTopics(limit) {
    var n = limit || C.hot.limit;

    /* 先等 SDK 到位（可能只等几十毫秒，也可能要几秒）。
       等不到才认「真的没有」—— 见上面 waitForSdk 的注释。 */
    return waitForSdk().then(function (WB) {
      if (!WB) return { ok: false, reason: 'no-sdk' };

      var c = buildClient(WB);
      if (!c) return { ok: false, reason: 'no-client' };

      /* 用 SDK 的数据库接口查。写法跟 supabase-js 一样：
         from(表).select(列).order(排序).limit(条数)
         结果装在 { data, error } 里。

         ⚠️ 按日期过滤这件事没写进查询里，而是取回后在前端筛：
         因为「今天」是按**浏览器本地时间**算的（见下面 localDate()），
         而数据库的 topic_date 是日期类型。让数据库来判断「今天」，
         时区会错位 —— README 里那条「日期一律用本地时间拼」的坑就是这样来的。 */
      return c.database
        .from(C.hot.table)
        .select('id, topic_date, rank, title, summary, hot_value, hot_text, url, source_key, source_name')
        .order('rank', { ascending: true })
        .limit(400)
        .then(function (res) {
          if (res && res.error) return { ok: false, reason: 'query-failed', detail: res.error };
          var all = (res && res.data) || [];
          if (!all.length) return { ok: false, reason: 'empty' };

          /* 取库里**最新那一天**的整份榜单，而不是死认「今天」。
             理由：首页不该在零点过后就空掉；而且如果某天忘了跑同步任务，
             显示最近一份「当日榜单」比显示空白有用得多。
             同时把日期一起返回，页面上要如实标出这份数据是哪天的。 */
          var latest = String(all[0].topic_date || '').slice(0, 10);
          var rows = all.filter(function (r) {
            return String(r.topic_date || '').slice(0, 10) === latest;
          });

          return { ok: true, rows: rows.slice(0, n), date: latest, total: rows.length };
        });
    }).catch(function (e) {
      return { ok: false, reason: 'query-failed', detail: e };
    });
  }

  /* ---------- 读来源列表（Day 18 加） ----------
     为什么需要它：「新增一条」那张表单的下拉要填 sources 里的**真 id**。
     填一个库里不存在的东西，写进去会被外键顶回来 ——
     所以这份名单必须现读，不能在本地另写一份（那就是第二个来源了）。

     出参：{ ok:true, rows:[{ id, name, column_key, kind }] }
           { ok:false, reason:'no-sdk' | 'no-client' | 'query-failed' | 'empty' }
     ⚠️ 形状跟 fetchHotTopics **故意保持一致**：调用方只需要记一套
     「ok + reason」，不用为了多一个接口多学一种写法。 */
  function fetchSources() {
    return waitForSdk().then(function (WB) {
      if (!WB) return { ok: false, reason: 'no-sdk' };

      var c = buildClient(WB);
      if (!c) return { ok: false, reason: 'no-client' };

      return c.database
        .from(C.entry.sourceTable)
        .select('id, name, column_key, kind')
        .order('column_key', { ascending: true })
        .then(function (res) {
          if (res && res.error) return { ok: false, reason: 'query-failed', detail: res.error };
          var rows = (res && res.data) || [];
          if (!rows.length) return { ok: false, reason: 'empty' };
          return { ok: true, rows: rows };
        });
    }).catch(function (e) {
      return { ok: false, reason: 'query-failed', detail: e };
    });
  }

  /* ============================================================
     二、写：新增一条内容（Day 18 加）
     ============================================================
     契约全文见 docs/api-contract.md 第二节 —— 下面每个函数的形状
     都是照着那份契约写的，改了这里就要同步改那份。

     一句话：**先校验 → 再查重 → 再写入 → 再读回 → 统一形状返回**。

     ⚠️ 为什么失败也走 resolve、不用 reject：
     调用方（页面）只需要一个「成功还是失败」的答案，不该被迫写 try/catch。
     throw 只留给真正的意外 bug。这样调用方永远只要看 result.ok。
     ============================================================ */

  /* 错误码 → 页面上显示的中文。
     ⚠️ 提示语**只有这一处**。页面不许自己再写一句差不多的话 ——
     同一个错误两种说法，看到的人会以为是两回事。 */
  var CODE_TEXT = {
    MISSING_TITLE:    '标题不能为空',
    TITLE_TOO_LONG:   '标题太长了，最多 ' + C.entry.titleMax + ' 个字',
    MISSING_SOURCE:   '请选择一个来源',
    SUMMARY_TOO_LONG: '摘要太长了，最多 ' + C.entry.summaryMax + ' 个字',
    BAD_MEDIA:        '形态不认识，只能是 视频 / 文章 / 播客 / 长访谈',
    DUPLICATE:        '这条内容已经在库里了（同一个来源下标题不能重复）',
    WRITE_FAILED:     '没存进去，稍后再试一次',
    NO_SDK:           '云端组件没加载成功，稍后再试',
    NO_CLIENT:        '云端连接没建起来，稍后再试'
  };

  function fail(code, detail) {
    return {
      ok: false,
      code: code,
      message: CODE_TEXT[code] || '出了点问题',
      detail: detail
    };
  }

  /* ---------- 入参校验（纯函数） ----------
     不碰网络、不改任何东西：给什么算什么，算什么返回什么。
     出参：{ ok:true, value:{…} } 或 { ok:false, code, message } */
  function validateEntry(input) {
    var it = input || {};

    /* 标题：**先去首尾空格，再判空、再判长度**。
       ⚠️ 顺序很重要 —— 先判长度后 trim，前后打一堆空格就算「超长」；
       判空时不 trim，一串空格就能蒙混过关当标题。 */
    var title = String(it.title == null ? '' : it.title).trim();
    if (!title) return fail('MISSING_TITLE');
    if (title.length > C.entry.titleMax) return fail('TITLE_TOO_LONG');

    /* 来源：必填。这是 PRD 硬约束 C4（每条内容都要能核到原始出处）
       在**接口这一层**的落实 —— 没有出处的条目，连库都进不去。 */
    var sourceId = String(it.sourceId == null ? '' : it.sourceId).trim();
    if (!sourceId) return fail('MISSING_SOURCE');

    /* 摘要：可以不填；填了就不能超长。 */
    var summary = String(it.summary == null ? '' : it.summary).trim();
    if (summary.length > C.entry.summaryMax) return fail('SUMMARY_TOO_LONG');

    /* 形态：**没填**就落默认值（不报错）；**填了个不认识的**才报错。
       ⚠️ 这两种情况必须分开 ——「没填」是正常，「填错」才要告诉他填错了。
       跟别处一个规矩：外面来的数据不许假设它长得对。 */
    var media = it.media;
    if (media === null || media === undefined || media === '') {
      media = C.mediaDefault;
    } else if (!C.media[media]) {
      return fail('BAD_MEDIA');
    }

    return {
      ok: true,
      value: { title: title, sourceId: sourceId, summary: summary, media: media }
    };
  }

  /* ---------- 生成主键 ----------
     形如 u-2026-10-04-k3f9a1。
     ⚠️ 为什么要一段随机尾巴：同一天会加好几条，只用日期必然撞主键。
     36 进制 4 位（0-9a-z）≈ 4.6 万种，同一天撞的概率极低；
     **真撞了也只是被数据库拒掉，不会写坏数据** ——
     所以这里不需要为「保证不撞」做额外功夫，保证数据不坏就够了。 */
  function makeEntryId() {
    var d = new Date();
    var p = function (x) { return String(x).padStart(2, '0'); };
    var day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    var tail = Math.floor(Math.random() * 46656).toString(36);
    while (tail.length < 3) tail = '0' + tail;
    return C.entry.idPrefix + '-' + day + '-' + tail;
  }

  /* ---------- 真正写进去，并把库里那一行读回来 ----------
     ⚠️ `.select()` 不能省：PostgREST 的写法里，insert 后面接 select
     才会**把写进去的那一行返回**（Prefer: return=representation）。
     不接的话只知道「没报错」，根本不知道存成了什么。 */
  function insertEntry(c, row) {
    return c.database
      .from(C.entry.table)
      .insert(row)
      .select()
      .then(function (res) {
        if (res && res.error) {
          /* 23505 = 唯一约束 / 主键冲突。**第二道防线在这里落地**：
             两个人同时提交同一条时，上面那次查重拦不住，数据库会把它顶回来。 */
          if (String(res.error.code) === '23505') return fail('DUPLICATE', res.error);
          return fail('WRITE_FAILED', res.error);
        }

        var got = (res && res.data) || [];
        /* ⚠️⚠️ 空数组 = 一行也没动 = **没成功**（契约 2.6 ②）。
           这是这一块最容易写错的地方：RLS 把写入挡住时，PostgREST
           **不给 error**，只给一个空的 data。当成成功处理，就会出现
           「页面说存好了、库里什么都没有」——比报错还糟。 */
        if (!got.length) return fail('WRITE_FAILED', '数据库没有返回写入后的那一行');

        var r = got[0];
        return {
          ok: true,
          id: r.id,
          title: r.title,          /* ← 全部取**库里的值**，不是入参的副本 */
          source_id: r.source_id,
          kind: r.kind,
          media: r.media,
          created_at: r.created_at,
          row: r
        };
      });
  }

  /* ---------- 对外的主函数 ----------
     入参：{ title, sourceId, summary?, media? }
     出参：成功 { ok:true, id, title, source_id, kind, media, created_at, row }
           失败 { ok:false, code, message, detail? } */
  function postEntry(input) {
    /* 本地能判的先判掉 —— 不用等一次网络往返就有中文提示。 */
    var v = validateEntry(input);
    if (!v.ok) return Promise.resolve(v);

    return waitForSdk().then(function (WB) {
      if (!WB) return fail('NO_SDK');
      var c = buildClient(WB);
      if (!c) return fail('NO_CLIENT');

      var row = {
        id: makeEntryId(),
        source_id: v.value.sourceId,
        kind: C.entry.kind,
        title: v.value.title,
        media: v.value.media,
        summary: v.value.summary || null
        /* ⚠️ created_at **故意不传**：表里有 DEFAULT now()，不传才会用默认值。
           传 null 不算「不传」—— 它会把默认值覆盖成 NULL（官方文档专门警告过这条）。
           同理 id：这项目主键是 TEXT、没有自增，所以由我们主动给。 */
      };

      /* 第一道防线：先查一次「同一个来源下这个标题有没有」。
         目的**不是安全**（页面代码可以被绕过），而是**给一句准的中文提示** ——
         否则只能等数据库抛一个 23505，用户看到的是一串英文错误码。 */
      return c.database
        .from(C.entry.table)
        .select('id')
        .eq('source_id', row.source_id)
        .eq('title', row.title)
        .limit(1)
        .then(function (res) {
          /* ⚠️ 查重自己失败时，**既不当作「没重复」放行、也不当作「重复」误拦** ——
             直接交给第二道防线去判。这一步本来就只是优化，它坏了不该改变结论。 */
          if (res && res.error) return insertEntry(c, row);
          if (res && res.data && res.data.length) return fail('DUPLICATE');
          return insertEntry(c, row);
        });
    }).catch(function (e) {
      /* 意外异常（比如 SDK 内部抛错）也收成一个统一的失败形状，不往页面上抛。 */
      return fail('WRITE_FAILED', String((e && e.message) || e));
    });
  }

  /* 本地日期（北京时间），形如 2026-10-03。
     ⚠️ 不用 toISOString()：那个给的是 UTC，国内晚上 8 点后会算成第二天。 */
  function localDate() {
    var d = new Date();
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  window.GROWTH_CLOUD = {
    /* 读（Day 17） */
    fetchHotTopics: fetchHotTopics,
    /* 读（Day 18）：新增表单的下拉要用 */
    fetchSources: fetchSources,
    /* 写（Day 18） */
    postEntry: postEntry,
    /* 校验单独也放出来：页面可以在打字的时候就先提示，不用等到提交。
       ⚠️ 放出来的只是**同一个函数**，不是另抄一份规则 ——
       否则「打字时说不超长、提交时说超长」这种事迟早发生。 */
    validateEntry: validateEntry,
    localDate: localDate
  };

})();
