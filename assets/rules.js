/* rules.js —— 所有「算」的逻辑。
   ============================================================
   这个文件里的函数**全都是纯的**：给它数据，它给你结果，
   不碰 localStorage、不碰页面、不记自己的状态。

   这么分有三个好处（老项目 Day 6 就是这么定的）：
     1. 同一个数只有一个算法，不会两处算出两个答案；
     2. 可以不开浏览器、直接在命令行里跑测试（本项目的
        verify-checkin-rules.mjs 就是这么测的）；
     3. 以后换存储（浏览器换数据库），这个文件一个字都不用改。

   加载顺序：config.js → rules.js → store.js → data.js → app.js
   ============================================================ */

(function () {
  'use strict';

  var C = window.GROWTH_CONFIG;

  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /* ------------------------------------------------------------
     一、日期
     ------------------------------------------------------------ */

  /* 把 Date 变成 'YYYY-MM-DD'
     ⚠️ 这里有个特别容易踩的坑，写下来免得以后忘：
     不能用 date.toISOString().slice(0, 10)。
     toISOString() 给的是 **UTC 时间**（世界统一时间），
     中国是 UTC+8，比它早 8 小时 —— 所以**晚上 8 点以后**用它算出来的
     日期是「明天」，那你晚上 11 点打的卡会被记到第二天去，
     第二天早上打开一看「今天已经打过了」，整个记录就乱了。
     所以要自己用 getFullYear / getMonth / getDate 拼，这三个拿的是本地时间。 */
  function dayKey(date) {
    var d = date || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* 'YYYY-MM-DD' → Date（本地时间的当天 00:00）
     不用 new Date('2026-09-27')：那种写法有些浏览器按 UTC 解析，又是一样的坑。 */
  function fromKey(key) {
    var p = String(key).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  /* 加减天数，返回一个新的 Date（不改原来那个） */
  function shiftDay(date, days) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
  }

  /* 'YYYY-MM-DD' 是星期几 */
  function weekdayOf(key) { return WEEK[fromKey(key).getDay()]; }

  /* 给页面上显示用的短标签：'今' / '昨' / '三'
     故意只用**一个字**：行动卡里那排格子很窄，两三个字放不下。 */
  function dayLabel(key, todayKey) {
    if (key === todayKey) return '今';
    if (key === dayKey(shiftDay(fromKey(todayKey), -1))) return '昨';
    return WEEK[fromKey(key).getDay()];
  }

  /* ------------------------------------------------------------
     二、一天的完成情况
     ------------------------------------------------------------ */

  /* 一天存的是「完成项 id 的数组」，比如 ['read', 'sport']
     这个函数把它清一遍：去掉重复、去掉非字符串，返回干净的数组。
     为什么要清：数据是从浏览器里读回来的，万一被手改过或坏了，
     不能因为它让整个页面报错。 */
  function cleanIds(ids) {
    if (Object.prototype.toString.call(ids) !== '[object Array]') return [];
    var seen = {};
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var v = ids[i];
      if (typeof v !== 'string' || v === '') continue;
      if (seen[v]) continue;
      seen[v] = true;
      out.push(v);
    }
    return out;
  }

  function countDone(ids) { return cleanIds(ids).length; }

  /* 这天算不算「打过卡」 */
  function isChecked(ids, minPerDay) {
    var min = minPerDay || C.minPerDay;
    return countDone(ids) >= min;
  }

  /* ------------------------------------------------------------
     三、连续天数
     ------------------------------------------------------------ */

  /* days     —— 全部记录，形如 { '2026-09-27': ['read'] }
     todayKey —— 今天
     返回连续打卡了几天。

     规则说清楚（不然下次自己都忘）：
       · 从今天往回一天天数，哪天没打卡就停在哪儿；
       · **今天还没打卡时，从昨天开始数** —— 否则每天早上一打开
         就看到「连续 0 天」，昨天明明打了卡，感觉像被清零了；
       · 「这天打过卡」= 当天至少完成 minPerDay 项。 */
  function streak(days, todayKey, minPerDay) {
    var cursor = fromKey(todayKey);
    if (!isChecked(days[todayKey], minPerDay)) cursor = shiftDay(cursor, -1);

    var n = 0;
    var guard = 0;
    while (isChecked(days[dayKey(cursor)], minPerDay)) {
      n++;
      cursor = shiftDay(cursor, -1);
      guard++;
      if (guard > C.streakLimit) break;   /* 防呆：数据异常时不至于转不出来 */
    }
    return n;
  }

  /* ------------------------------------------------------------
     四、最近 N 天（给行动卡下面那排格子用）
     ------------------------------------------------------------ */

  /* 返回从「最早那天」到「今天」的数组，方便按顺序画格子 */
  function recentDays(days, todayKey, n) {
    var count = n || C.historyDays;
    var today = fromKey(todayKey);
    var out = [];
    for (var i = count - 1; i >= 0; i--) {
      var k = dayKey(shiftDay(today, -i));
      var ids = cleanIds(days[k]);
      out.push({
        key: k,
        label: dayLabel(k, todayKey),
        count: ids.length,
        checked: isChecked(ids)
      });
    }
    return out;
  }

  /* 最近 N 天的汇总：完成了几项 / 一共几项（一共 = 天数 × 每天项数） */
  function summary(recent, perDay) {
    var done = 0;
    for (var i = 0; i < recent.length; i++) done += recent[i].count;
    return { done: done, possible: recent.length * perDay, days: recent.length };
  }

  /* ------------------------------------------------------------
     四·B、行动项：默认项 + 自己加的项（Day 14 加）
     ------------------------------------------------------------
     为什么放在 rules.js：这里是「算」——
     把两份清单合成一份、把外面的脏数据洗干净、给新项起个不撞的名字。
     全都不碰存储、不碰页面，所以命令行里就能测。 */

  /* 洗一遍「自己添加的项」。
     数据是从浏览器里读回来的（也可能刚从输入框来），
     不能假设它长得对：entry 不是对象、id 是空的、文字是空白、
     文字超长、同一个 id 出现两次 —— 一律处理掉，绝不让页面报错。 */
  function cleanCustom(list, maxText, maxCount) {
    var maxLen = maxText || C.customTextMax;
    var maxN = maxCount || C.customMax;
    if (Object.prototype.toString.call(list) !== '[object Array]') return [];

    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || typeof a !== 'object') continue;

      var id = (typeof a.id === 'string') ? a.id : '';
      var text = (typeof a.text === 'string') ? a.text : '';
      /* 前后空白去掉；只留空白的项等于没写 */
      text = text.replace(/^\s+|\s+$/g, '');
      if (!id || !text) continue;
      if (seen[id]) continue;
      seen[id] = true;

      /* 超长就砍掉尾巴 —— 比整条丢掉好：用户至少看得见自己写的东西 */
      if (text.length > maxLen) text = text.slice(0, maxLen);

      var hint = (typeof a.hint === 'string') ? a.hint.slice(0, 40) : '';
      out.push({ id: id, text: text, hint: hint });
      if (out.length >= maxN) break;
    }
    return out;
  }

  /* 两份清单合成「今天要做的所有事」：默认项在前，自己加的在后。
     每一项都带 custom 标记 —— 页面靠它决定「这一项能不能删」。 */
  function allActions(defaults, custom) {
    var out = [];
    var defs = (Object.prototype.toString.call(defaults) === '[object Array]') ? defaults : [];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      if (!d || typeof d !== 'object') continue;
      if (typeof d.id !== 'string' || !d.id) continue;
      if (typeof d.text !== 'string' || !d.text) continue;
      out.push({ id: d.id, text: d.text, hint: d.hint || '', custom: false });
    }
    var mine = cleanCustom(custom);
    for (var j = 0; j < mine.length; j++) {
      out.push({ id: mine[j].id, text: mine[j].text, hint: mine[j].hint, custom: true });
    }
    return out;
  }

  /* 给新加的一项起个名字（id）。
     ⚠️ 为什么不让它自己去拿 Date.now()：那样它就不是纯函数了
     （同样输入会得到不同结果，命令行里没法测）。
     所以时间戳由外面传进来，这里只负责「保证不和已有的撞」。 */
  function customId(seed, taken) {
    var base = 'c' + String(seed);
    var used = (Object.prototype.toString.call(taken) === '[object Array]') ? taken : [];
    var id = base;
    var n = 1;
    while (used.indexOf(id) >= 0) { n++; id = base + '-' + n; }
    return id;
  }

  /* 某一天的「明细」——「我的」里点开某一格要看的东西。
     返回当天做了哪几项（带文字），以及「记录里留着、但现在列表里已经没有」的项。
     ⚠️ 最后那一类**必须单独列出来，不许悄悄丢掉**：
     用户删掉一个自定义项之后，以前打过卡的那天不能因此少算一项。 */
  function dayDetail(days, key, acts, todayKey) {
    var ids = cleanIds(days ? days[key] : null);
    var list = (Object.prototype.toString.call(acts) === '[object Array]') ? acts : [];

    var done = [];
    var gone = [];
    for (var i = 0; i < ids.length; i++) {
      var hit = null;
      for (var j = 0; j < list.length; j++) {
        if (list[j] && list[j].id === ids[i]) { hit = list[j]; break; }
      }
      if (hit) done.push({ id: hit.id, text: hit.text, hint: hit.hint || '' });
      else gone.push(ids[i]);
    }

    return {
      key: key,
      label: dayLabel(key, todayKey),
      weekday: weekdayOf(key),
      done: done,
      gone: gone,
      count: ids.length,
      total: list.length,
      checked: isChecked(ids)
    };
  }

  /* ------------------------------------------------------------
     四·C、内容形态徽标（Day 15 加）
     ------------------------------------------------------------
     为什么这两件事在 rules.js 而不是 app.js：
     「这条是视频还是文章」「徽标上该写什么字」是**算**出来的，
     不是画出来的。放这里就能不开浏览器直接跑测试。 */

  /* 取一条内容的形态键。
     ⚠️ 认不出来的值（空、数字、拼错的字、字段整个没有）一律回落到
     C.mediaDefault —— 不许因为这个让页面报错，也不许在页面上印出
     「undefined」这种东西。 */
  function mediaKey(item) {
    var m = (item && typeof item === 'object') ? item.media : '';
    var list = C.media || {};
    if (typeof m === 'string' && list[m]) return m;
    return C.mediaDefault || 'article';
  }

  /* 洗一下时长 / 长度（'12:30' / '约 8 分钟' / '42 分钟'） */
  function cleanDur(dur) {
    if (typeof dur !== 'string') return '';
    return dur.replace(/^\s+|\s+$/g, '').slice(0, 12);
  }

  /* 徽标上那一行字：有 dur 就是 '文章 · 约 8 分钟'，没有就只写 '文章'。
     ⚠️ 没有 dur 时**不许留一个孤零零的间隔号** —— 那是没做完的样子。 */
  function mediaBadge(item) {
    var k = mediaKey(item);
    var def = (C.media && C.media[k]) || { label: '文章' };
    var dur = cleanDur(item && item.dur);
    return dur ? def.label + ' · ' + dur : def.label;
  }

  /* ------------------------------------------------------------
     四·D、「今日一篇」（Day 15 加）
     ------------------------------------------------------------ */

  /* 洗一篇「今日一篇」的候选。
     跟 cleanCustom 同一个态度：读回来的东西不假设它长得对，
     缺 id / 缺标题的一律丢掉，要点最多留 5 条。 */
  function cleanRead(item) {
    if (!item || typeof item !== 'object') return null;

    var id = (typeof item.id === 'string') ? item.id.replace(/\s+/g, '') : '';
    var title = (typeof item.title === 'string')
      ? item.title.replace(/^\s+|\s+$/g, '') : '';
    if (!id || !title) return null;

    var points = [];
    if (Object.prototype.toString.call(item.points) === '[object Array]') {
      for (var i = 0; i < item.points.length && points.length < 5; i++) {
        var p = item.points[i];
        if (typeof p !== 'string') continue;
        p = p.replace(/^\s+|\s+$/g, '');
        if (p) points.push(p);
      }
    }

    return {
      id: id,
      title: title,
      media: mediaKey(item),
      dur: cleanDur(item.dur),
      tag: (typeof item.tag === 'string') ? item.tag : '',
      /* ⚠️ url 允许是空字符串 —— 那就表示「原链接还没填」，
         页面上会**如实写出来**，不许编一个网址顶上。 */
      url: (typeof item.url === 'string') ? item.url.replace(/^\s+|\s+$/g, '') : '',
      origin: (typeof item.origin === 'string') ? item.origin : '',
      summary: (typeof item.summary === 'string') ? item.summary : '',
      points: points,
      use: (typeof item.use === 'string') ? item.use : ''
    };
  }

  function cleanReads(list) {
    if (Object.prototype.toString.call(list) !== '[object Array]') return [];
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var r = cleanRead(list[i]);
      if (!r) continue;
      if (seen[r.id]) continue;      /* 同一个 id 出现两次，只留第一份 */
      seen[r.id] = true;
      out.push(r);
    }
    return out;
  }

  /* 这天是「起算日之后的第几天」。
     ⚠️ 算法说明：两端都取**本地时间的当天 00:00** 再相减，
     这样白天黑夜都不影响结果（不会因为晚上打开就差一天）。
     不用 toISOString —— 那个按 UTC 算，中国比它早 8 小时，
     晚上 8 点以后会算出「明天」（AGENTS.md 第 4 条第 8 项）。 */
  function dayNumber(key, epochKey) {
    var epoch = fromKey(epochKey || C.readEpoch || '2026-01-01');
    var d = fromKey(key);
    return Math.round((d.getTime() - epoch.getTime()) / 86400000);
  }

  /* 今天该推哪一篇。三条必须守住的点：

     1. **确定性** —— 同一天刷新一百次都必须是同一篇。
        ⚠️ 所以**不许用 Math.random()**：随机会让「今天这篇」自己变，
        用户会以为是自己记错了；而且随机的东西**没法写测试**。
     2. **按顺序轮换** —— 顺着列表往下走，不是哈希打散。
        这样不会出现「连着三天推同一篇」。
     3. **负数也要对** —— 把系统日期拨到起算日之前时，
        JS 的 % 会给出负数，直接当数组下标会取到 undefined。
        所以补一次 `+ arr.length`（这是取模运算的标准写法）。 */
  function pickDaily(list, key, epochKey) {
    var arr = cleanReads(list);
    if (!arr.length) return null;
    var n = dayNumber(key, epochKey);
    var i = ((n % arr.length) + arr.length) % arr.length;
    return arr[i];
  }

  /* ------------------------------------------------------------
     五、视图地址（Day 13 加）
     ------------------------------------------------------------
     为什么这三个函数放在 rules.js 而不是 app.js：
       它们是**纯函数** —— 给一段地址，算出「这是哪个视图」，
       不碰地址栏、不碰页面。所以不用开浏览器就能测
       （verify-day13-rules.mjs 里就是这么测的）。
       app.js 那边只负责「读一下地址栏 → 问这里 → 照着画」。 */

  /* 把地址栏里那段 hash 洗成「干净的视图名」。
       '#/library'  '#/library/'  '#/Library?x=1'  'library'  →  'library'
     认不出来（比如 'xxx'）也照样返回 'xxx'，交给下面那个函数兜底。 */
  function viewKey(hash) {
    var s = String(hash === null || hash === undefined ? '' : hash);
    if (s.charAt(0) === '#') s = s.slice(1);
    while (s.charAt(0) === '/') s = s.slice(1);
    var cut = s.indexOf('?');
    if (cut >= 0) s = s.slice(0, cut);
    cut = s.indexOf('#');
    if (cut >= 0) s = s.slice(0, cut);
    while (s.length && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
    return s.toLowerCase();
  }

  /* 地址 → 视图 id。
     ⚠️ 认不出来一律回默认视图：用户手打错一个字母，不该看到白屏。 */
  function viewIdFromHash(hash, views, route) {
    var list = (views && views.length) ? views : [];
    var want = viewKey(hash);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id).toLowerCase() === want) return list[i].id;
    }
    return (route && route.defaultId) || (list[0] ? list[0].id : '');
  }

  /* 视图 id → 应该写进地址栏的那段 hash（认不出来就回默认视图的地址）。
     这一条和上面那条是**一对**：来回换算不会丢信息。
     地址栏里的地址一律由这里生成，不许在别处手写 '#/home' 这种字面量 ——
     否则以后改前缀，就会漏掉几处。 */
  function hashOfView(id, views, route) {
    var list = (views && views.length) ? views : [];
    var prefix = (route && route.prefix) || '#/';
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return prefix + list[i].id;
    }
    var fallback = (route && route.defaultId) || (list[0] ? list[0].id : '');
    return prefix + fallback;
  }

  /* 从地址里读「这次要几条热点」（Day 17 加，余力加练）。
     地址形如 '#/home?hot=5' → 5；没写 / 写坏了一律返回 fallback。

     ⚠️ 为什么要有这条：这样同一份页面能当「接口」用 ——
     想看 3 条就 '#/home?hot=3'，想看全部就 '#/home?hot=30'，
     不用改代码、不用重新部署。这是纯静态站能做到的最接近「接口参数」的东西。

     ⚠️ 三条规矩，跟其它「外面来的数据」一样：
     ① 认不出来**不报错**，静默回落到 fallback（写坏一个地址不该看到白屏）；
     ② 只收 1 ~ max 之间的整数，别的全扔（比如 hot=0、hot=-3、hot=abc、
        hot=99999 —— 99999 会把页面撑爆，必须夹住）；
     ③ 不认小数点（hot=2.5 直接当认不出来），因为它要的是「条数」，不是尺寸。 */
  function hotLimitFromHash(hash, fallback, max) {
    var s = String(hash === null || hash === undefined ? '' : hash);
    var at = s.indexOf('?');
    if (at < 0) return fallback;
    var q = s.slice(at + 1);
    var m = /(?:^|&)hot=([^&]*)/.exec(q);
    if (!m) return fallback;
    var raw = decodeURIComponent(m[1]);
    if (!/^\d+$/.test(raw)) return fallback;
    var n = parseInt(raw, 10);
    var cap = (typeof max === 'number' && max > 0) ? max : 30;
    if (n < 1 || n > cap) return fallback;
    return n;
  }

  window.GROWTH_RULES = {
    dayKey: dayKey,
    fromKey: fromKey,
    shiftDay: shiftDay,
    weekdayOf: weekdayOf,
    dayLabel: dayLabel,
    cleanIds: cleanIds,
    countDone: countDone,
    isChecked: isChecked,
    streak: streak,
    recentDays: recentDays,
    summary: summary,
    /* Day 14 加：行动项合并 / 清洗 / 起名 / 某天明细 */
    cleanCustom: cleanCustom,
    allActions: allActions,
    customId: customId,
    dayDetail: dayDetail,
    /* Day 15 加：内容形态徽标 / 今日一篇 */
    mediaKey: mediaKey,
    cleanDur: cleanDur,
    mediaBadge: mediaBadge,
    cleanRead: cleanRead,
    cleanReads: cleanReads,
    dayNumber: dayNumber,
    pickDaily: pickDaily,
    /* Day 13 加 */
    viewKey: viewKey,
    viewIdFromHash: viewIdFromHash,
    hashOfView: hashOfView,
    /* Day 17 加：地址里的 hot=N 条数限制（余力加练那条） */
    hotLimitFromHash: hotLimitFromHash
  };

})();
