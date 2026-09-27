/* store.js —— 所有数据读写。
   ============================================================
   ⚠️ **整个项目里，只有这个文件允许出现 localStorage。**
   （老项目 Day 6 定的规矩第 6 条，原因是：以后想换成云端数据库，
   只需要把这一个文件重写，页面代码一个字都不用动。）

   它做的事就三件：把记录读出来、写回去、告诉外面「存得住还是存不住」。

   加载顺序：config.js → rules.js → store.js → data.js → app.js
   ============================================================ */

(function () {
  'use strict';

  var C = window.GROWTH_CONFIG;
  var R = window.GROWTH_RULES;

  /* 存不住的时候（浏览器禁用存储 / 隐私模式 / 空间满了），
     退回在这块内存里放着 —— 页面照样能点，只是关掉就没了。
     留着这个兜底，是为了不让「打卡」整个功能直接崩掉。
     打卡和收藏各有一块，互不干扰。 */
  var memoryData = null;
  var memoryFav = null;

  var probed = false;      /* 有没有试过 localStorage 能不能用 */
  var usable = false;      /* 试的结果 */

  /* ---------- 探一下 localStorage 能不能用 ----------
     光判断「window.localStorage 存在」不够：有些浏览器里它存在，
     但一往里写就抛错。所以要真的写一个探针进去试试。 */
  function storage() {
    if (!probed) {
      probed = true;
      try {
        var s = window.localStorage;
        var probe = '__growth_probe__';
        s.setItem(probe, '1');
        s.removeItem(probe);
        usable = true;
      } catch (e) {
        usable = false;
      }
    }
    return usable ? window.localStorage : null;
  }

  function blank() {
    return { version: C.schemaVersion, days: {} };
  }

  function blankFav() {
    return { version: C.favSchemaVersion, ids: [] };
  }

  /* ---------- 读 ---------- */
  function readAll() {
    var s = storage();
    if (!s) return memoryData || (memoryData = blank());

    var raw = null;
    try { raw = s.getItem(C.storeKey); } catch (e) { return blank(); }
    if (!raw) return blank();

    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return blank(); }

    /* 下面全是「防脏」检查：读回来的东西是外面给的，
       不能假设它长得对，坏了一律当空的处理，绝不让整个页面报错。 */
    if (!data || typeof data !== 'object') return blank();
    if (data.version !== C.schemaVersion) return blank();
    if (!data.days || typeof data.days !== 'object') return blank();

    /* 逐天清洗：只留下「字符串数组」，顺手去重去空 */
    var clean = {};
    var keys = Object.keys(data.days);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var ids = R.cleanIds(data.days[k]);
      if (ids.length) clean[k] = ids;
    }
    data.days = clean;
    return data;
  }

  /* ---------- 写 ----------
     返回 true = 真写进浏览器了；false = 只能放内存，关掉页面就没了。 */
  function writeAll(data) {
    var s = storage();
    if (!s) { memoryData = data; return false; }
    try {
      s.setItem(C.storeKey, JSON.stringify(data));
      return true;
    } catch (e) {
      /* 常见原因：隐私模式、存储空间满、被浏览器策略拦下 */
      memoryData = data;
      return false;
    }
  }

  /* ---------- 收藏：另一只抽屉（Day 12 加） ----------
     结构和打卡一样：读坏了、版本对不上、存不住，一律按「空」处理，
     绝不让它把整个页面搞报错。 */

  function readFav() {
    var s = storage();
    if (!s) return memoryFav || (memoryFav = blankFav());

    var raw = null;
    try { raw = s.getItem(C.favKey); } catch (e) { return blankFav(); }
    if (!raw) return blankFav();

    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return blankFav(); }

    if (!data || typeof data !== 'object') return blankFav();
    if (data.version !== C.favSchemaVersion) return blankFav();
    /* ids 用 rules.js 那个清洗函数过一遍：去掉重复和非字符串 */
    return { version: C.favSchemaVersion, ids: R.cleanIds(data.ids) };
  }

  function writeFav(data) {
    var s = storage();
    if (!s) { memoryFav = data; return false; }
    try {
      s.setItem(C.favKey, JSON.stringify(data));
      return true;
    } catch (e) {
      memoryFav = data;
      return false;
    }
  }

  /* ---------- 对外 ---------- */
  window.GROWTH_STORE = {

    /* 记录能不能真的存住。页面靠它决定要不要提示「本次记录不会被保存」 */
    isPersistent: function () { return storage() !== null; },

    todayKey: function () { return R.dayKey(new Date()); },

    /* 某一天完成项 id 的数组；没记录就是空数组 */
    getDay: function (key) {
      var days = readAll().days;
      return R.cleanIds(days[key]);
    },

    /* 直接设定某一天的完成项 */
    setDay: function (key, ids) {
      var data = readAll();
      var clean = R.cleanIds(ids);
      if (clean.length) data.days[key] = clean;
      else delete data.days[key];    /* 一项都没完成 = 这天没有记录，不留空壳 */
      return writeAll(data);
    },

    /* 点一下：完成 / 取消完成。返回存过之后这一天的最新状态 */
    toggle: function (key, id) {
      var ids = window.GROWTH_STORE.getDay(key);
      var at = ids.indexOf(id);
      if (at >= 0) ids.splice(at, 1);
      else ids.push(id);
      window.GROWTH_STORE.setDay(key, ids);
      return window.GROWTH_STORE.getDay(key);
    },

    /* 全部记录，形如 { '2026-09-27': ['read', 'sport'] } */
    allDays: function () { return readAll().days; },

    /* ---------- 收藏（Day 12 加） ---------- */

    /* 收藏的语录 id 数组。顺序 = 收藏的先后顺序。
       ⚠️ 存的是 id 不是「第几条」—— 跟打卡同一个道理：
       以后改语录内容、调顺序、删掉一条，以前的收藏都不会错位。 */
    getFavorites: function () { return readFav().ids; },

    hasFavorite: function (id) { return readFav().ids.indexOf(id) >= 0; },

    countFavorites: function () { return readFav().ids.length; },

    /* 点一下：收藏 / 取消收藏。返回「操作完是不是收藏状态」 */
    toggleFavorite: function (id) {
      var ids = readFav().ids.slice();
      var at = ids.indexOf(id);
      if (at >= 0) ids.splice(at, 1);
      else ids.push(id);
      writeFav({ version: C.favSchemaVersion, ids: R.cleanIds(ids) });
      return at < 0;
    },

    /* 清空全部记录。界面上没有入口，只给验证脚本用。 */
    clearAll: function () {
      var s = storage();
      if (s) {
        try { s.removeItem(C.storeKey); } catch (e) {}
        try { s.removeItem(C.favKey); } catch (e) {}
      }
      memoryData = null;
      memoryFav = null;
    }

  };

})();
