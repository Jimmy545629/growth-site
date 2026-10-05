/* cloud.js —— **接口层**：页面跟云端之间说好的那几句话。
   ============================================================
   建立于 Day 17（2026-10-03）；**Day 19（2026-10-05）瘦身过一次**。

   【Day 19 做了什么，一句话】
   「查数据库」那一段（等 SDK、建连接、`.from().select()` / `.insert()`）
   整段搬去了 `assets/db.js`。**本文件从此不知道 SDK 长什么样。**
   这里只留下四件事：
     ① 校验入参（validateEntry —— 纯函数）
     ② 错误码换成中文（CODE_TEXT —— 页面上提示语的**唯一**来源）
     ③ 编排（postEntry：先校验 → 再查重 → 再写入 → 再读回）
     ④ 保证返回的形状跟契约一致（docs/api-contract.md）

   ⚠️ **本文件 = 页面契约的唯一实现**。
   对外那 6 个名字（fetchHotTopics / fetchEntries / fetchSources /
   postEntry / validateEntry / localDate）和它们返回的 JSON 字段，
   **一个字都不许改** —— 页面（app.js）和 docs/api-contract.md 都照着它写。
   要改就得先改契约那份文档，两边一起改。

   【为什么要这么分】
   把「我们的规矩」（校验、中文说法、契约形状）和「数据库的事」（表、列、查询）
   放在不同文件里，改一边不会顺手碰坏另一边。
   ⚠️ 拆的时候刻意守住一条：**只搬家，不改行为** ——
   所以 app.js **一行都没改**（这正是拆得对不对的判据）。

   【三层往下怎么走】
     页面 app.js
       ↓ 只调 GROWTH_CLOUD 这几个函数
     接口层 cloud.js（本文件）—— 校验 / 中文提示 / 编排 / 契约形状
       ↓ 只调 GROWTH_DB 那几个函数
     数据访问层 db.js —— 等 SDK / 建连接 / 查什么表取哪些列
       ↓
     云端数据库

   【断网 / 云端读不到会怎样】
   **不白屏、不报错、不假装有数据。**
   读接口返回 { ok:false, reason:… }，由 app.js 决定把「这次没读到」如实说出来，
   并给一个「重试」的出口。宁可说「这次没读到」，也不要编一条数据顶上
   （这是 PRD 硬约束 C4 的精神：不许编）。
   ⚠️ Day 18 起，内容库三列**不再退回本地内容** —— 因为本地那份已经删了，
   内容只有云端一份。读不到就是读不到，页面如实说，不是「降级显示旧数据」。

   加载顺序（见 index.html）：config.js → db.js → cloud.js → rules.js
   → store.js → data.js → app.js
   ============================================================ */

(function () {
  'use strict';

  var C = window.GROWTH_CONFIG;
  /* ⚠️ 本文件所有的「读云端 / 写云端」都通过它 —— db.js 是全项目唯一
     跟云端数据库说话的文件。这里连 window.WorkBuddyCloud 都不出现。 */
  var DB = window.GROWTH_DB;

  /* ============================================================
     一、读接口
     ============================================================
     三条读接口（热搜 / 内容库三列 / 来源名单）**故意共用同一种形状**：
     { ok:true, rows:[…] } 或 { ok:false, reason:… }。
     这样调用方只要记一套「ok + reason」，不用为多一个接口多学一种写法。
     ============================================================ */

  /* 读失败时的形状。detail 只进控制台、不上页面（契约 2.4）。 */
  function readFail(reason, detail) {
    return { ok: false, reason: reason, detail: detail };
  }

  /* ---------- 01 · 读当日热搜 ----------
     入参：limit（要几条，默认按 config 里那个数）
           ⚠️ 这个 limit 来自地址里的 '?hot=N'（Day 17 余力加练），
           由 rules.js 的 hotLimitFromHash() 校验过（1~30 的整数），
           到这里已经是可信的；但函数本身仍然不假设它一定合法 ——
           外面的东西一律不当成「长得对」。
     出参：{ ok:true, rows:[…], date:'2026-10-03', total:库内这一天共几条 }
           { ok:false, reason:'no-sdk' | 'no-client' | 'query-failed' | 'empty' } */
  function fetchHotTopics(limit) {
    var n = limit || C.hot.limit;

    return DB.selectHotTopics().then(function (res) {
      if (!res.ok) return readFail(res.reason, res.error);

      var all = res.rows || [];
      if (!all.length) return readFail('empty');

      /* 取库里**最新那一天**的整份榜单，而不是死认「今天」。
         理由：首页不该在零点过后就空掉；而且如果某天忘了跑同步任务，
         显示最近一份「当日榜单」比显示空白有用得多。
         同时把日期一起返回，页面上要如实标出这份数据是哪天的。

         ⚠️ 「今天是哪天」这件事**必须在这一层按浏览器本地时间算**，
         不能交给数据库 —— topic_date 是日期类型，让数据库判「今天」时区会错位。 */
      var latest = String(all[0].topic_date || '').slice(0, 10);
      var rows = all.filter(function (r) {
        return String(r.topic_date || '').slice(0, 10) === latest;
      });

      return { ok: true, rows: rows.slice(0, n), date: latest, total: rows.length };
    }).catch(function (e) {
      return readFail('query-failed', e);
    });
  }

  /* ---------- 03 · 读内容库三列的条目（Day 18 加） ----------
     为什么需要它：Day 18 把「内容库三列」从「读本地 data.js」改成「读云端」。
     改的原因很直白 ——「新增一条」写的是云端，榜单读的是本地，
     两处内容各活各的，加完一条在榜单里看不见。
     那是最容易让人以为「页面坏了」的一种设计。

     出参：{ ok:true, rows:[ {…contents 那一行的字段…, sources:{…}} ], total }
           { ok:false, reason:'no-sdk' | 'no-client' | 'query-failed' | 'empty' }
     ⚠️ 这一层**只取数、不分组**：分组是页面的事。
        「N 天前」怎么算也是页面的事（rules.js 的 daysAgo()）。
        这里只负责把数据原样带回去，形状跟契约一致。 */
  function fetchEntries() {
    return DB.selectEntries().then(function (res) {
      if (!res.ok) return readFail(res.reason, res.error);

      var rows = res.rows || [];
      if (!rows.length) return readFail('empty');
      return { ok: true, rows: rows, total: rows.length };
    }).catch(function (e) {
      return readFail('query-failed', e);
    });
  }

  /* ---------- 04 · 读来源列表（Day 18 加） ----------
     为什么需要它：「新增一条」那张表单的下拉要填 sources 里的**真 id**。
     填一个库里不存在的东西，写进去会被外键顶回来 ——
     所以这份名单必须现读，不能在本地另写一份（那就是第二个来源了）。

     出参：{ ok:true, rows:[{ id, name, column_key, kind }] }
           { ok:false, reason:'no-sdk' | 'no-client' | 'query-failed' | 'empty' } */
  function fetchSources() {
    return DB.selectSources().then(function (res) {
      if (!res.ok) return readFail(res.reason, res.error);

      var rows = res.rows || [];
      if (!rows.length) return readFail('empty');
      return { ok: true, rows: rows };
    }).catch(function (e) {
      return readFail('query-failed', e);
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

  /* ---------- 把 db.js 的写入结果，翻译成契约要的形状 ----------
     ⚠️ 这一步就是「接口层」的核心动作：底下的 reason 是**数据库的说法**，
     契约里的 code 是**这个项目的说法**，翻译只发生在这一处。
     ① no-sdk / no-client：连接就没建起来，跟数据库无关；
     ② 23505：唯一约束顶回来的（**第二道防线** —— 两个人同时提交同一条时，
        上面那次查重拦不住，数据库会把它拒掉）；
     ③ 其余（含 empty-result：一行也没写成）：一律 WRITE_FAILED。 */
  function entryWriteFail(res) {
    if (res.reason === 'no-sdk') return fail('NO_SDK');
    if (res.reason === 'no-client') return fail('NO_CLIENT');
    if (res.error && String(res.error.code) === '23505') return fail('DUPLICATE', res.error);
    return fail('WRITE_FAILED', res.error || res.reason);
  }

  /* ---------- 对外的主函数 ----------
     入参：{ title, sourceId, summary?, media? }
     出参：成功 { ok:true, id, title, source_id, kind, media, created_at, row }
           失败 { ok:false, code, message, detail? } */
  function postEntry(input) {
    /* 本地能判的先判掉 —— 不用等一次网络往返就有中文提示。 */
    var v = validateEntry(input);
    if (!v.ok) return Promise.resolve(v);

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
    return DB.selectEntryByTitle(row.source_id, row.title).then(function (res) {
      /* ⚠️ 连接没建起来：直接说，不用再白跑一次写入。 */
      if (res.reason === 'no-sdk') return fail('NO_SDK');
      if (res.reason === 'no-client') return fail('NO_CLIENT');

      /* 有重复 → 当场拦下，不写。 */
      if (res.ok && res.rows && res.rows.length) return fail('DUPLICATE');

      /* ⚠️ 查重自己失败时（res.ok 为假、但连接是好的）：
         **既不当作「没重复」放行、也不当作「重复」误拦** ——
         直接交给第二道防线（数据库的唯一约束）去判。
         这一步本来就只是优化，它坏了不该改变结论。 */
      return DB.insertContent(row).then(function (w) {
        if (!w.ok) return entryWriteFail(w);

        var r = w.row;
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
    /* 读（Day 18）：内容库三列的条目 ＋ 新增表单的下拉 */
    fetchEntries: fetchEntries,
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
