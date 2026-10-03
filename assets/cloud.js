/* cloud.js —— 所有「读写云端」的逻辑。
   ============================================================
   建立于 Day 17（2026-10-03）。

   ⚠️ **这是全项目唯一允许碰云端的文件。**
   跟 store.js 是同一个思路（老项目 Day 6 规矩第 6 条）：
   把「数据从哪来」这件事关在一个文件里，页面代码一个字都不用知道
   数据是来自本地抽屉还是来自云端。以后要换数据源，只改这一个文件。

   【它读什么】
   云端数据库的 `hot_topics` 表 —— 每日真实热搜快照（来源：百度实时热搜）。
   这张表是只读的（Day 16 定的边界：网页只能读、不许写）。

   【它怎么写】
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

  /* 本地日期（北京时间），形如 2026-10-03。
     ⚠️ 不用 toISOString()：那个给的是 UTC，国内晚上 8 点后会算成第二天。 */
  function localDate() {
    var d = new Date();
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  window.GROWTH_CLOUD = {
    fetchHotTopics: fetchHotTopics,
    localDate: localDate
  };

})();
