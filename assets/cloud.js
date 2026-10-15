/* cloud.js —— **接口层**：页面跟云端之间说好的那几句话。
   ============================================================
   建立于 Day 17（2026-10-03）；**Day 19（2026-10-05）瘦身过一次**。

   【Day 19 做了什么，一句话】
   「查数据库」那一段（等 SDK、建连接、`.from().select()` / `.insert()`）
   整段搬去了 `assets/db.js`。**本文件从此不知道 SDK 长什么样。**
   这里只留下四件事：
     ① 校验入参（validateEntry —— 纯函数）
     ② 失败换成人话（FAIL_TEXT —— 读的原因 ＋ 写的错误码，页面上提示语的**唯一**来源。
        Day 23 从原来的 CODE_TEXT 扩成这一张总表）
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
   读接口返回 { ok:false, reason:…, message:'…中文…' }，
   由 app.js 把 message 如实说出来（Day 23 起页面不再自己翻中文），
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
     { ok:true, rows:[…] } 或 { ok:false, reason:…, message:… }。
     这样调用方只要记一套「ok + reason + message」，不用为多一个接口多学一种写法。
     ⚠️ message 是 Day 23 加的**中文提示**（原来只有英文 reason）——
     页面直接把它画出来就行，不用自己再翻一遍。
     ============================================================ */

  /* 读失败时的形状（Day 23 改）。
     ⚠️ 原来只有 reason（小写英文），**不带中文** —— 页面上要显示一句人话，
     就得各自去 data.js / app.js 里翻，于是「同一个原因」在三个地方
     各写了一句不一样的中文（内容库一套、热搜一套、表单一套）。
     现在跟写接口一个规矩：**失败就带一句用户看得懂的 message**。
     detail 只进控制台、不上页面（契约 2.4）。 */
  function readFail(reason, detail) {
    return { ok: false, reason: reason, message: failText(reason), detail: detail };
  }

  /* ---------- 01 · 读当日热搜 ----------
     入参：limit（要几条，默认按 config 里那个数）
           ⚠️ 这个 limit 来自地址里的 '?hot=N'（Day 17 余力加练），
           由 rules.js 的 hotLimitFromHash() 校验过（1~30 的整数），
           到这里已经是可信的；但函数本身仍然不假设它一定合法 ——
           外面的东西一律不当成「长得对」。
     出参：{ ok:true, rows:[…], date:'2026-10-03', updatedAt:'2026-10-06T22:50:11+08:00',
             total:过滤后这一天共几条, blocked:被词表挡掉几条 }
           { ok:false, reason:'no-sdk' | 'no-client' | 'query-failed' | 'empty', message:'…中文…' }
     ⚠️ updatedAt 是 Day 20 加的**新增字段**（原有字段一个没改），
        见 docs/api-contract.md。老字段 date / total / rows 的含义都没动。
     ⚠️ blocked 是 Day 27 晚加的另一个新增字段；**同时 total 的含义变窄了**：
        以前是「库里这一天共几条」，现在是「**过滤之后**这一天共几条」，
        页面上的「共 N 条」跟着一起变。两个数都不是编的，但说的不是一回事，
        所以 blocked 必须一起带出来（见下面那段注释）。 */
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
      /* 【Day 28 修】不赖后端排序，**自己从拿回来的行里算最大的那个日期**。
         ⚠️ 原来写的是 `all[0].topic_date`，注释写「最新那一天」，但 all[0] 并不是 ——
         查询是按 rank 排的（见 db.js 的 selectHotTopics），库里一有多天快照，
         谁排第一就不确定了，实测拿到的是**最早那天**（页面因此显示 12 天前的榜单）。
         ⚠️ 日期是 'YYYY-MM-DD' 纯文本，字典序就是时间序，直接比大小即可，
         不用转成 Date（一转就又要操心时区）。
         这一改跟 db.js 那条 `.order('topic_date')` 是**双保险**：
         任一边以后被改坏，另一边还拦得住。 */
      var latest = '';
      all.forEach(function (r) {
        var d = String(r.topic_date || '').slice(0, 10);
        if (d > latest) latest = d;
      });
      var rows = all.filter(function (r) {
        return String(r.topic_date || '').slice(0, 10) === latest;
      });

      /* Day 20 加：这份快照是**什么时候抓进云端**的（那一行的 fetched_at）。
         取这一份里**最晚**的那个时刻 —— 一行一个时间戳，理论上同一份快照
         是同一个值，但外面来的数据不假设它长得对，按最晚的算最稳。

         ⚠️ 别把它跟 date 搞混：date 说「这份数据是哪一天的」，
         updatedAt 说「我们是什么时候把它抓进来的」。
         某天忘了跑同步任务时，这两个数会一起往后停 —— 那正是要看出来的东西。 */
      var updatedAt = '';
      rows.forEach(function (r) {
        var s = r && r.fetched_at ? String(r.fetched_at) : '';
        if (!s) return;
        var t = new Date(s).getTime();
        if (isNaN(t)) return;
        if (!updatedAt || t > new Date(updatedAt).getTime()) updatedAt = s;
      });

      /* 【Day 27 晚加】内容过滤（词表在 config.hot.blockWords，理由写在那儿）。
         ⚠️ 为什么要**在这一层**滤，而不是等 app.js 画的时候再滤：
         页面是按 limit 先取前 N 条再来画的。要是先取 8 条、画的时候滤掉 3 条，
         榜上就只剩 5 条 —— 看着像缺了一块，而且实际展示数跟 limit 对不上。
         在这里「先滤掉、再取前 N 条」，展示数才是满的。

         ⚠️ 一个加载顺序上的坑，写下来免得以后有人踩：
         rules.js 在 cloud.js **后面**才加载（见 index.html 的顺序），
         所以这行**不能**写成文件开头那种 `var R = window.GROWTH_RULES`
         —— 那时候它还不存在。放在这个回调里取就没事：
         回调是异步跑的，那时所有脚本都加载完了。
         ⚠️ 取不到就**不过滤**（宁可多留一条，也不要因为一个加载问题把整块清空）。 */
      var R = window.GROWTH_RULES;
      var passed = (R && R.filterHotRows)
        ? R.filterHotRows(rows, C.hot.blockWords)
        : { kept: rows, blocked: [] };

      return {
        ok: true,
        rows: passed.kept.slice(0, n),
        date: latest,
        updatedAt: updatedAt,
        total: passed.kept.length,
        /* 被词表挡掉的条数 —— 页面拿它如实说一句，不悄悄吞掉。
           ⚠️ 注意 total 是**过滤之后**的数：页面上「共 N 条」说的一直是
           「这一天有几条是本站会展示的」，跟库里那 30 条不是一回事，
           所以必须把「略掉几条」也说出来，否则两个数对不上就是新的不实。 */
        blocked: passed.blocked.length
      };
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
           { ok:false, reason:'no-sdk' | 'no-client' | 'query-failed' | 'empty', message:'…中文…' }
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
           { ok:false, reason:'no-sdk' | 'no-client' | 'query-failed' | 'empty', message:'…中文…' } */
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

  /* ============================================================
     ★ 失败文案总表（Day 23 新）——「失败原因 → 中文」的**唯一一处**
     ============================================================
     改之前，这张表只有写 / 校验用的错误码（那时叫 CODE_TEXT）；
     读失败的几种说法散在 data.js（libraryFail）和 app.js
     （failHint / paintHot）里。结果是**同一个原因有三套中文** ——
     比如「云端组件没加载成功」，内容库说一种、热搜换一种、表单又说一种；
     而且热搜那一处**漏了「连接没建起来」这一种**，会直接落到「原因不明」。

     现在全部收在这一张表里：读失败（reason）和写 / 校验失败（code）
     都从这里取中文。页面（app.js）只负责把 message 画出来，**不许另写一句**。

     ⚠️ 键为什么有两种写法（这是契约定的，不是我随便起的名）：
       · 读接口的失败原因是**小写连字符**：'no-sdk' / 'no-client' /
         'query-failed' / 'empty'
       · 写 / 校验接口的错误码是**大写**：MISSING_TITLE / WRITE_FAILED / …
     两者说的其实是同一件事的，用下面的 FAIL_ALIAS 指过来 ——
     这样「云端没连上」那几句话**只有一份**，不会变成两处各写一句。 */
  var FAIL_TEXT = {
    /* ---------- 一、连不上：读、写都会遇到 ---------- */
    'no-sdk':        '云端组件没加载成功 —— 可能是没联网，也可能网络被拦了。',
    'no-client':     '云端连接没建起来 —— 多半是没联网。',

    /* ---------- 二、云端没给结果（读） ---------- */
    'query-failed':  '这次没读到云端的内容 —— 可能没联网，也可能只是一时抽风。',
    'empty':         '云端还没有这份数据 —— 不是坏了，是还没录进来。',

    /* ---------- 三、写 / 校验（Day 18 / Day 22 那套错误码） ---------- */
    MISSING_TITLE:    '标题不能为空',
    TITLE_TOO_LONG:   '标题太长了，最多 ' + C.entry.titleMax + ' 个字',
    MISSING_SOURCE:   '请选择一个来源',
    SUMMARY_TOO_LONG: '摘要太长了，最多 ' + C.entry.summaryMax + ' 个字',
    BAD_MEDIA:        '形态不认识，只能是 视频 / 文章 / 播客 / 长访谈',
    DUPLICATE:        '这条内容已经在库里了（同一个来源下标题不能重复）',
    MISSING_ID:       '不知道要动哪一条（缺少 id）',
    WRITE_FAILED:     '没存进去，稍后再试一次',
    PATCH_FAILED:     '没改成功，稍后再试一次',
    DELETE_FAILED:    '没删掉，稍后再试一次'
  };

  /* 写接口用的是大写码，跟读接口那两句说的是同一件事 —— 指过去，不另抄一份。
     ⚠️ 不这么做的话，「云端组件没加载成功」就会在这张表里被写成两份，
     那就等于没统一。 */
  var FAIL_ALIAS = { NO_SDK: 'no-sdk', NO_CLIENT: 'no-client' };

  /* 表里查不到时的兜底。**只有这一句**，别处不许再写「出了点问题」。 */
  var FAIL_FALLBACK = '这次没成功，稍后再试一次';

  /* 给一个失败原因 / 错误码，换回一句中文。 */
  function failText(key) {
    var k = FAIL_ALIAS[key] || key;
    return FAIL_TEXT[k] || FAIL_FALLBACK;
  }

  /* 写 / 校验失败：{ ok:false, code, message, detail }。
     message 是给用户看的中文；detail 只进控制台（契约 2.4）。 */
  function fail(code, detail) {
    return { ok: false, code: code, message: failText(code), detail: detail };
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

  /* ---------- 把 db.js 的**改**结果，翻译成契约要的形状（Day 22） ----------
     ⚠️ 和 entryWriteFail 分开写、不共用，是因为**失败的含义不一样**：
     新增失败说「没存进去」，改失败说「没改成功」—— 两句话给人的下一步动作不同。
     共用一个翻译器，就会出现「改了一条，却提示『没存进去』」这种看着像另一回事的话。
     ⚠️ 23505 在这里的含义也不同：不是「这条已经在了」，而是
     「你改成的新标题，跟**同来源下另一条**撞了」—— 所以另给一句话。 */
  function entryPatchFail(res) {
    if (res.reason === 'no-sdk') return fail('NO_SDK');
    if (res.reason === 'no-client') return fail('NO_CLIENT');
    if (res.error && String(res.error.code) === '23505') return fail('DUPLICATE', res.error);
    return fail('PATCH_FAILED', res.error || res.reason);
  }

  /* ---------- 把 db.js 的**删**结果，翻译成契约要的形状（Day 22） ---------- */
  function entryDeleteFail(res) {
    if (res.reason === 'no-sdk') return fail('NO_SDK');
    if (res.reason === 'no-client') return fail('NO_CLIENT');
    return fail('DELETE_FAILED', res.error || res.reason);
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

  /* ---------- 对外的主函数：改一条（Day 22 加） ----------
     入参：{ id, title, sourceId, summary?, media? }
           （和 postEntry 一样的四个内容字段，只是多了一个「改哪一条」的 id）
     出参：成功 { ok:true, id, title, source_id, kind, media, created_at, row }
           失败 { ok:false, code, message, detail? }

     ⚠️ 为什么这里**不做查重**（和 postEntry 明显不同）：
     postEntry 是「凭空多一条」，重名必须提前拦；
     改的却是**我自己这一条** —— 万一用户只改摘要、标题一个字没动，
     再查一次重就会把「我自己」查出来，把一次正常的修改误判成重复。
     所以这里的重名兜底**交给数据库的唯一约束**（撞了会回 23505，被翻成 DUPLICATE）。

     ⚠️ 只允许改这四样内容：标题 / 来源 / 摘要 / 形态。
     id、kind、created_via、created_at 是这一行的「身份」，一个字都不许动 ——
     改 kind 会把内容改成另一种数据、改 created_via 会冒充别人写的。
     数据库那一侧的策略里也写死了「这几样改了就不放行」（见 schema.sql Day 22 段），
     这里是第二道；两处都有，是因为页面代码可以被绕过。 */
  function patchEntry(input) {
    var it = input || {};

    var id = String(it.id == null ? '' : it.id).trim();
    if (!id) return Promise.resolve(fail('MISSING_ID'));

    /* 内容字段的校验**复用同一个 validateEntry**，不另抄一份规则。
       ⚠️ 抄一份迟早会变成「新增时说不超长、改的时候说超长」。 */
    var v = validateEntry(it);
    if (!v.ok) return Promise.resolve(v);

    var patch = {
      source_id: v.value.sourceId,
      title: v.value.title,
      media: v.value.media,
      summary: v.value.summary || null
    };

    return DB.updateContent({ id: id, source_id: patch.source_id, title: patch.title,
                              media: patch.media, summary: patch.summary })
      .then(function (w) {
        if (!w.ok) return entryPatchFail(w);

        var r = w.row;
        return {
          ok: true,
          id: r.id,
          title: r.title,          /* ← 取**改完之后库里的值**，不是我们发过去的副本 */
          source_id: r.source_id,
          kind: r.kind,
          media: r.media,
          created_at: r.created_at,
          row: r
        };
      }).catch(function (e) {
        return fail('PATCH_FAILED', String((e && e.message) || e));
      });
  }

  /* ---------- 对外的主函数：删一条，并**回查证明它真的没了**（Day 22 加） ----------
     入参：id —— 要删哪一条
     出参：成功 { ok:true, id, removed:true }
           失败 { ok:false, code, message, detail? }

     ⚠️⚠️ 这一步是今天最该讲清的地方：「删掉」怎么算数？
     只看「删除那一下没报错」是不够的 ——
     数据库把删除挡住时可能给的是「成功、删了 0 行」，不报错。
     所以这里删完之后**再查一次**（selectEntries），拿「那一行的 id 还在不在返回里」
     当证据：不在了才算真的删掉了。
     「没看到报错」不是证据，「回查之后确实不在」才是。 */
  function deleteEntry(id) {
    var wanted = String(id == null ? '' : id).trim();
    if (!wanted) return Promise.resolve(fail('MISSING_ID'));

    return DB.deleteContent(wanted).then(function (w) {
      if (!w.ok) return entryDeleteFail(w);

      /* 回查：把整张内容表重新读一遍，找那个 id 还在不在。 */
      return DB.selectEntries().then(function (r) {
        if (!r.ok) return entryDeleteFail(r);

        var rows = r.rows || [];
        for (var i = 0; i < rows.length; i++) {
          if (rows[i] && rows[i].id === wanted) {
            /* 删是「成功」回来的，可那一行**还在** ——
               说明数据库其实没删（最可能是权限没开）。
               这种情况必须当场说出来，绝不能报「删掉了」。 */
            return fail('DELETE_FAILED', '数据库说删了，但回查时这一行还在 —— 多半是删除权限没开');
          }
        }

        return { ok: true, id: wanted, removed: true };
      });
    }).catch(function (e) {
      return fail('DELETE_FAILED', String((e && e.message) || e));
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
    /* 写（Day 22）：改一条 / 删一条 */
    patchEntry: patchEntry,
    deleteEntry: deleteEntry,
    /* 校验单独也放出来：页面可以在打字的时候就先提示，不用等到提交。
       ⚠️ 放出来的只是**同一个函数**，不是另抄一份规则 ——
       否则「打字时说不超长、提交时说超长」这种事迟早发生。 */
    validateEntry: validateEntry,
    localDate: localDate
  };

})();
