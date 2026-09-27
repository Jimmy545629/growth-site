/* app.js —— 首页的渲染与交互。
   ============================================================
   分工（照老项目那套规矩，管用）：
     config.js → 所有常量
     rules.js  → 所有「算」的逻辑（纯函数，不碰存储、不碰页面）
     store.js  → 所有数据读写（唯一碰 localStorage 的文件）
     data.js   → 只有内容
     app.js    → 只负责「把内容画到页面上」+「收用户的点击」
   要改文字 → 只动 data.js；要改样子 → 只动 style.css；
   要改「算」的规则（比如连续天数怎么数）→ 只动 rules.js。

   一条铁律：**文字只用 textContent 写**，绝不拼 innerHTML。
   内容里只要有个 < > 或 & 符号，拼 HTML 就会让整页错乱。

   另一条（Day 10 换来的教训）：**同一个事实只允许有一个来源**。
   页面上任何数字，都必须当场从数据算出来，
   不许在这里写死一个、那里又写死一个。
   ============================================================ */

(function () {
  'use strict';

  var C = window.GROWTH_CONFIG;
  var R = window.GROWTH_RULES;
  var S = window.GROWTH_STORE;
  var D = window.GROWTH_DATA;

  /* 打卡是打在「今天」上的。但页面可能开着过夜（跨过零点），
     所以每次要用的时候现算一次，不在一开始缓存下来。 */
  function todayKey() { return S.todayKey(); }
  function doneIds() { return S.getDay(todayKey()); }

  /* ---------- 最小构建器 ----------
     h('div', { class: 'box' }, 子节点…)
     支持 class / text / 其它属性 / style 对象。子节点可以是元素、字符串、数组、null。 */
  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        var v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = String(v);   // 唯一的文字入口
        else if (k === 'style') { for (var s in v) { if (Object.prototype.hasOwnProperty.call(v, s)) node.style[s] = v[s]; } }
        else node.setAttribute(k, v);
      }
    }
    for (var i = 2; i < arguments.length; i++) add(node, arguments[i]);
    return node;
  }

  function add(parent, child) {
    if (child === null || child === undefined || child === false || child === '') return;
    if (Object.prototype.toString.call(child) === '[object Array]') {
      for (var i = 0; i < child.length; i++) add(parent, child[i]);
      return;
    }
    if (child.nodeType === 1) { parent.appendChild(child); return; }
    parent.appendChild(document.createTextNode(String(child)));
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* 标签：颜色通过 data-c 属性给，CSS 里配色（这样不用在 JS 里写颜色值） */
  function Tag(text, color) {
    return h('span', { class: 'tag', 'data-c': color || 'blue', text: text });
  }

  /* ============================================================
     一、顶部：元信息行
     ============================================================ */
  function renderMeta() {
    var box = document.getElementById('meta-row');
    clear(box);
    add(box, h('span', { text: '内容更新于 ' + D.meta.updated }));
    add(box, h('span', { class: 'entry-meta' }, h('span', { class: 'sep', text: '·' })));
    if (D.meta.isSample) {
      add(box, h('span', { class: 'meta-flag', text: '示例内容（版面确认用，非真实收录）' }));
    }
    /* 万一记录存不住（浏览器禁用存储 / 隐私模式），必须当面说清楚，
       不能让人以为「我的打卡好好的存着」。 */
    if (!S.isPersistent()) {
      add(box, h('span', { class: 'meta-flag', text: '这个浏览器不允许保存记录 · 本次打卡关掉页面就没了' }));
    }
    renderStreak();
  }

  /* 顶部「已连续自律 N 天」。
     这个数字以前是 data.js 里写死的 12 —— 现在一律从真实记录现算。 */
  function renderStreak() {
    var box = document.getElementById('streak');
    if (!box) return;
    clear(box);
    var n = R.streak(S.allDays(), todayKey(), C.minPerDay);
    if (n >= 1) {
      /* ⚠️ 这里必须套一层 h('span', …) 再 add 进去。
         因为 add() 只接收**一个**子节点，多传的会被直接丢掉 ——
         第一版写成 add(box, '已连续自律 ', h('b', …), ' 天')，
         结果数字和「天」字全没了，顶栏只剩一个「已连续自律」。
         多层子节点要用 h() 来装（h 里是循环处理每个子节点的）。 */
      add(box, h('span', {}, '已连续自律 ', h('b', { text: String(n) }), ' 天'));
    } else {
      add(box, '今天还没打卡');
    }
  }

  /* ============================================================
     二、三张统计卡
     ============================================================ */

  /* 「今天完成了几个行动」这件事只允许有一个来源：查记录里有哪些 id。
     Day 10 修过一次这里的毛病（统计卡把数字写死在 data.js 里，
     下面勾了框它纹丝不动）——现在改成从打卡记录现算，同一个毛病不会再回来。

     注意只数「当前列表里真的存在的项」：万一记录里留着某个已经删掉的
     旧 id，也不会被多算进去。 */
  function countDone() {
    var ids = doneIds();
    var n = 0;
    D.actions.forEach(function (a) { if (ids.indexOf(a.id) >= 0) n++; });
    return n;
  }

  /* 把完成情况翻译成统计卡需要的那三段文字 */
  function actionStat() {
    var ids = doneIds();
    var total = D.actions.length;
    var left = D.actions.filter(function (a) { return ids.indexOf(a.id) < 0; });
    return {
      value: String(total - left.length),
      unit: '/ ' + total,
      note: left.length === 0
        ? total + ' 项都做完了，保持住'
        : '还差「' + left.map(function (a) { return a.text; }).join('、') + '」'
    };
  }

  function renderStats() {
    var box = document.getElementById('stats');
    clear(box);
    var accents = ['var(--brand)', 'var(--warm)', 'var(--ok)'];

    D.stats.forEach(function (s, i) {
      /* 标了 from:'actions' 的那一张，用现算的值，而不是 data.js 里写的 */
      var v = s.from === 'actions' ? actionStat() : s;
      var card = h('article', { class: 'stat', style: { '--accent': accents[i % accents.length] } });
      add(card, h('p', { class: 'stat-label', text: s.label }));
      add(card, h('p', { class: 'stat-value' },
        v.value,
        h('small', { text: ' ' + v.unit })));
      add(card, h('p', { class: 'stat-note', text: v.note }));
      add(box, card);
    });
  }

  /* ============================================================
     三、今日语录卡（可以「换一句」，也可以「收藏」）
     ============================================================ */
  var quoteIndex = 0;

  /* 按 id 找一条语录。找不到返回 null。 */
  function quoteById(id) {
    for (var i = 0; i < D.quotes.length; i++) {
      if (D.quotes[i].id === id) return D.quotes[i];
    }
    return null;
  }

  function renderQuote() {
    var box = document.getElementById('quote-card');
    var q = D.quotes[quoteIndex];
    clear(box);

    add(box, h('p', { class: 'quote-kicker', text: '今日认知语录 · ' + (quoteIndex + 1) + ' / ' + D.quotes.length }));

    add(box, h('blockquote', { class: 'quote-text', text: q.text }));

    add(box, h('p', { class: 'quote-from' },
      h('b', { text: q.author }),
      h('span', { text: '·' }),
      h('span', { text: q.source }),
      Tag(q.platform, 'blue'),
      Tag(q.tag, tagColorOf(q.tag))
    ));

    add(box, h('p', { class: 'quote-insight' },
      h('b', { text: '怎么理解：' }), q.insight));

    add(box, h('p', { class: 'quote-action' },
      h('b', { text: '今日行动' }), h('span', { text: q.action })));

    /* 四个动作按钮 */
    var acts = h('div', { class: 'quote-acts' });

    var btnNext = h('button', { class: 'btn', type: 'button', id: 'btn-next', text: '换一句' });
    btnNext.addEventListener('click', function () {
      quoteIndex = (quoteIndex + 1) % D.quotes.length;
      renderQuote();
    });

    /* 收藏按钮。状态**从存储里读**，不是从这个变量记 ——
       Day 12 之前这里是个纯内存的对象（quoteSaved），刷新就没了，
       按钮还会骗人（看着是「已收藏」，其实什么都没存）。 */
    var saved = S.hasFavorite(q.id);
    var btnSave = h('button', {
      class: 'btn' + (saved ? ' is-on' : ''), type: 'button', id: 'btn-save',
      text: saved ? '已收藏' : '收藏',
      'aria-pressed': saved ? 'true' : 'false'
    });
    btnSave.addEventListener('click', function () {
      /* 先写进存储，再重画 —— 顺序反了就会「屏幕上变了、其实没存住」 */
      S.toggleFavorite(q.id);
      renderQuote();
    });

    var btnShare = h('button', { class: 'btn', type: 'button', id: 'btn-share', text: '生成分享图' });
    btnShare.addEventListener('click', function () {
      // 这一版先不真的画图，只给个反馈（按你说的「先做能看的首页」）
      alert('分享图功能还没做——先把版面定下来，再决定要不要做这一步。');
    });

    add(acts, btnNext);
    add(acts, btnSave);
    add(acts, btnShare);
    add(box, acts);

    /* 收藏列表。一条都没有时这个函数返回 null，add() 会直接跳过 —— 
       所以没收藏的时候，卡片跟以前长得一模一样，不会多出空壳子。 */
    add(box, renderFavorites());
  }

  /* 「我的收藏」：只读列表，点一条就跳到那一条。
     Day 12 之前收藏只存在内存里，刷新就没了，而且存的是「第几条」——
     改了语录顺序，收藏的就会跳到别的句子上去。现在两样都改了。 */
  function renderFavorites() {
    var ids = S.getFavorites();
    if (!ids.length) return null;

    var items = [];
    ids.forEach(function (id) {
      var q = quoteById(id);
      if (q) items.push(q);   /* 记录里留着已删掉的 id：跳过，不画出来 */
    });
    if (!items.length) return null;

    var wrap = h('div', { class: 'favs' });
    add(wrap, h('div', { class: 'favs-head' },
      h('span', { class: 'favs-title', text: '我的收藏' }),
      h('span', { class: 'favs-count', text: items.length + ' 条 · 点一条跳过去' })));

    var row = h('ul', { class: 'favs-list' });
    items.forEach(function (q) {
      var li = h('li', { class: 'fav-item', role: 'button', tabindex: '0',
        title: q.text + ' —— ' + q.author });
      add(li, h('span', { class: 'fav-text', text: q.text }));
      add(li, h('span', { class: 'fav-from', text: '— ' + q.author }));

      function go() {
        var at = D.quotes.indexOf(q);
        if (at >= 0) { quoteIndex = at; renderQuote(); }
      }
      li.addEventListener('click', go);
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
      add(row, li);
    });
    add(wrap, row);

    return wrap;
  }

  /* 按标签词给个颜色（不是白名单强约束，先做一版看的） */
  function tagColorOf(tag) {
    var map = {
      '思维模型': 'violet', '习惯养成': 'green', '心力': 'red',
      '时间管理': 'blue', '专注力': 'cyan', '学习方法': 'green',
      '决策': 'cyan'
    };
    return map[tag] || 'blue';
  }

  /* ============================================================
     四、今日自律行动卡（可以勾选，勾选会真的存下来）
     ============================================================ */
  function renderActions() {
    var box = document.getElementById('action-card');
    clear(box);
    var ids = doneIds();
    var total = D.actions.length;

    add(box, h('h2', { class: 'action-title', text: '今日自律行动' }));
    add(box, h('p', { class: 'action-sub', text: '点一下就算完成。记录只存在你自己的浏览器里，不上传、也不用登录。' }));

    var ul = h('ul', { class: 'action-list' });

    D.actions.forEach(function (a) {
      var on = ids.indexOf(a.id) >= 0;
      var li = h('li', {
        class: 'action-item' + (on ? ' is-done' : ''),
        role: 'button', tabindex: '0',
        'aria-pressed': on ? 'true' : 'false'
      });
      add(li, h('span', { class: 'action-box', text: '✓' }));
      add(li, h('span', { class: 'action-text' },
        a.text,
        h('span', { class: 'action-hint', text: a.hint })));

      function toggle() {
        /* 先写进记录，再重画 —— 顺序反了就会出现「屏幕上勾上了、
           其实没存住」这种骗人的状态。 */
        S.toggle(todayKey(), a.id);
        renderActions();
        renderStats();    /* 上面那张「今日行动」统计卡跟着一起变，两处永远说同一个数 */
        renderStreak();   /* 今天第一次打卡时，顶部连续天数也要跟着变 */
      }
      li.addEventListener('click', toggle);
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });

      add(ul, li);
    });

    add(box, ul);

    /* 最近几天的记录 —— 让「坚持」看得见，而不是只剩一个数字 */
    add(box, renderHistory(total));

    var done = countDone();   /* 同一个数只有这一处算法，跟统计卡共用 */
    add(box, h('p', { class: 'action-progress' },
      '今天已完成 ', h('b', { text: done + ' / ' + total }),
      done === total ? ' —— 全部完成，明天见。' : ' —— 别断在这儿。'));
  }

  /* 最近 N 天的小格子：每格一个方块，颜色越实表示那天完成得越多。
     鼠标停上去能看到那天的日期和数字（用浏览器自带的提示，不用自己画浮层）。 */
  function renderHistory(total) {
    var recent = R.recentDays(S.allDays(), todayKey(), C.historyDays);
    var sum = R.summary(recent, total);
    var wrap = h('div', { class: 'history' });

    add(wrap, h('div', { class: 'history-head' },
      h('span', { class: 'history-title', text: '最近 ' + recent.length + ' 天' }),
      h('span', { class: 'history-sum', text: sum.done + ' / ' + sum.possible + ' 项' })));

    var row = h('ul', { class: 'history-grid' });
    recent.forEach(function (d) {
      var state = d.count === 0 ? 'is-empty'
                : (d.count >= total ? 'is-full' : 'is-part');
      var li = h('li', {
        class: 'history-cell ' + state + (d.key === todayKey() ? ' is-today' : ''),
        title: d.key + ' 完成 ' + d.count + ' / ' + total + ' 项',
        'aria-label': d.key + ' 完成 ' + d.count + ' / ' + total + ' 项'
      });
      add(li, h('span', { class: 'history-day', text: d.label }));
      add(li, h('span', { class: 'history-num', text: String(d.count) }));
      add(row, li);
    });
    add(wrap, row);

    return wrap;
  }

  /* ============================================================
     五、三列内容榜单
     ============================================================ */
  function renderColumns() {
    var box = document.getElementById('columns');
    clear(box);

    D.columns.forEach(function (col) {
      var sec = h('section', { class: 'col', style: { '--accent': col.accent } });

      add(sec, h('div', { class: 'col-head' },
        h('h2', { class: 'col-title' },
          h('span', { class: 'dot' }), col.title),
        h('p', { class: 'col-note', text: col.note })));

      var list = h('ol', { class: 'col-list' });
      col.items.forEach(function (it, i) {
        add(list, renderEntry(it, i + 1));
      });
      add(sec, list);
      add(box, sec);
    });
  }

  function renderEntry(it, no) {
    var li = h('li', { class: 'entry' });

    add(li, h('span', { class: 'entry-no', text: no }));

    var body = h('div', { class: 'entry-body' });

    add(body, h('p', { class: 'entry-title', text: it.title }));

    /* 一行小字：标签 + 来源/人物 + 时间 */
    var meta = h('div', { class: 'entry-meta' });
    add(meta, Tag(it.tag, it.tagColor));
    if (it.person) {
      add(meta, h('span', { class: 'entry-person', text: it.person + ' · ' + it.role }));
    }
    if (it.origin) add(meta, h('span', { text: it.origin }));
    add(meta, h('span', { class: 'sep', text: '·' }));
    add(meta, h('span', { text: it.time }));
    add(body, meta);

    /* 语录/笔记类：一句话摘要 */
    if (it.note) {
      add(body, h('p', { class: 'entry-extra', text: it.note }));
    }

    /* 访谈：核心观点 + 金句 + 3 个行动点 */
    if (it.view) {
      var dl = h('dl', { class: 'entry-extra' });
      add(dl, h('dt', { text: '核心观点' }));
      add(dl, h('dd', { text: it.view }));
      add(dl, h('dt', { text: '金句' }));
      add(dl, h('dd', { text: '「' + it.quote + '」' }));
      add(body, dl);

      var ul = h('ul', { class: 'entry-steps' });
      it.steps.forEach(function (s) { add(ul, h('li', { text: s })); });
      add(body, ul);
    }

    /* 政策：一句话结论 + 对大学生的启示 + 相关技能 */
    if (it.conclusion) {
      var dl2 = h('dl', { class: 'entry-extra' });
      add(dl2, h('dt', { text: '一句话结论' }));
      add(dl2, h('dd', { text: it.conclusion }));
      add(dl2, h('dt', { text: '对大学生的启示' }));
      add(dl2, h('dd', { text: it.impact }));
      add(body, dl2);

      var skills = h('div', { class: 'entry-meta', style: { 'margin-top': '8px' } });
      add(skills, h('span', { text: '相关技能：' }));
      it.skills.forEach(function (s) { add(skills, Tag(s, 'green')); });
      add(body, skills);
    }

    add(li, body);
    return li;
  }

  /* ============================================================
     六、底部
     ============================================================ */
  function renderFoot() {
    var box = document.getElementById('foot');
    clear(box);
    add(box, h('p', {}, h('strong', { text: '关于这份内容：' }), D.footer.note));
    add(box, h('p', {}, h('strong', { text: '当前引用来源：' }), D.footer.sources.join('、')));
    /* 「计划收录」单独一行、单独标出来 —— 不许跟上面那行混在一起，
       免得看的人以为页面上的内容已经出自这些账号了。 */
    if (D.footer.plan) {
      add(box, h('p', { class: 'foot-plan', text: D.footer.plan }));
    }
    add(box, h('p', { text: D.footer.copyright }));
  }

  /* ============================================================
     启动
     ============================================================ */
  renderMeta();
  renderStats();
  renderQuote();
  renderActions();
  renderColumns();
  renderFoot();

})();
