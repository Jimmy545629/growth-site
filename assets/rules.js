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
    /* Day 13 加 */
    viewKey: viewKey,
    viewIdFromHash: viewIdFromHash,
    hashOfView: hashOfView
  };

})();
