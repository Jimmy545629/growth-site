/* app.js —— 把内容画到页面上、收用户的点击，并按地址切换视图。
   ============================================================
   分工（照老项目那套规矩，管用）：
     config.js → 所有常量（含路由前缀 route、读取延迟 listDelayMs）
     rules.js  → 所有「算」的逻辑（纯函数，含「地址 → 视图」那三个）
     store.js  → 所有数据读写（唯一碰 localStorage 的文件）
     data.js   → 只有内容（含三个视图的名字/说明、四种状态的说法）
     app.js    → 画 + 收点击 + 按地址切视图

   要改文字 → 只动 data.js；要改样子 → 只动 style.css；
   要改「算」的规则（比如连续天数怎么数）→ 只动 rules.js。

   三条铁律：
   ① **文字只用 textContent 写**，绝不拼 innerHTML。
      内容里只要有个 < > 或 & 符号，拼 HTML 就会让整页错乱。
   ② **同一个事实只允许有一个来源**（Day 10 换来的教训）：
      页面上任何数字，都必须当场从数据算出来。
   ③ **视图以地址为准**（Day 13）：界面显示哪一个视图、导航高亮哪一个，
      全都从地址栏现算。app.js 里那个 currentView 只是「上次画的是哪个」的
      缓存，用来避免重复重画 —— 它**不是**第二个说了算的地方。
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

  /* 按 id 找一条语录。找不到返回 null。 */
  function quoteById(id) {
    for (var i = 0; i < D.quotes.length; i++) {
      if (D.quotes[i].id === id) return D.quotes[i];
    }
    return null;
  }

  /* 按 id 找一条视图配置（名字/标题/说明） */
  function viewOf(id) {
    for (var i = 0; i < D.views.length; i++) {
      if (D.views[i].id === id) return D.views[i];
    }
    return null;
  }

  /* 视图的地址一律从 rules.js 现算，不许在这里手写 '#/home' 这种字面量 ——
     以后改前缀，只要改 config.js 一处。 */
  function hashOf(id) { return R.hashOfView(id, D.views, C.route); }

  /* ============================================================
     零、列表的四种状态（Day 13 加）
     ============================================================
     上线之后的列表一定会遇到四种情况，少画一种都是 bug：

       正常    —— 有内容，画出来
       空      —— 数据读回来了，但一条都没有
                 （分不清「真没有」和「坏了」，用户只能干瞪眼）
       加载中  —— 数据还在路上（以后接服务器就长这样）
       出错    —— 没读回来，而且**必须留一条重试的路**
                 （只写一句「出错了」，用户唯一能做的就是刷新）

     三个视图里所有列表都走这一个函数 —— 样子和说法才一致，改一处全改。
     ============================================================ */
  function ListState(state, opt) {
    var o = opt || {};

    /* 正常：没什么可包的，直接把要画的内容交出去 */
    if (state === 'ready') return o.rows || null;

    if (state === 'loading') {
      var lb = h('div', { class: 'state state-loading', role: 'status' });
      add(lb, h('p', { class: 'state-title', text: D.listStates.loading.title }));
      var sk = h('div', { class: 'skeleton', 'aria-hidden': 'true' });
      var n = o.rowsNum || C.skeletonRows;
      for (var i = 0; i < n; i++) add(sk, h('span', { class: 'skeleton-row' }));
      add(lb, sk);
      return lb;
    }

    if (state === 'empty') {
      var eb = h('div', { class: 'state state-empty', role: 'status' });
      add(eb, h('p', { class: 'state-mark', text: '∅', 'aria-hidden': 'true' }));
      add(eb, h('p', { class: 'state-title', text: o.title || D.listStates.empty.title }));
      if (o.hint || D.listStates.empty.hint) {
        add(eb, h('p', { class: 'state-hint', text: o.hint || D.listStates.empty.hint }));
      }
      /* 空状态最好给一条「接下来干什么」的路，别让人停在原地 */
      if (o.actionLabel) {
        var ab = h('button', { class: 'btn', type: 'button', text: o.actionLabel });
        ab.addEventListener('click', function () { if (o.onAction) o.onAction(); });
        add(eb, h('div', { class: 'state-acts' }, ab));
      }
      return eb;
    }

    if (state === 'error') {
      /* role="alert"：读屏软件会立刻把这句话念出来 —— 出错是要马上知道的 */
      var rb = h('div', { class: 'state state-error', role: 'alert' });
      add(rb, h('p', { class: 'state-mark', text: '!', 'aria-hidden': 'true' }));
      add(rb, h('p', { class: 'state-title', text: o.title || D.listStates.error.title }));
      add(rb, h('p', { class: 'state-hint', text: o.hint || D.listStates.error.hint }));
      /* ⚠️ 这里**不能写 id**。整个页面里这种状态块会被画好几处
         （内容库真列表一处、四种状态对照区一处、以后别处还会用），
         写死 id 就会出现「同一个 id 有好几个元素」——
         而 getElementById 只认文档里第一个，脚本/工具一点就点到别处那个去了。
         Day 13 验证时真踩到过：重试按钮点了没反应，就是因为点到了对照区那个。
         要用就用 class 定位。 */
      var btn = h('button', {
        class: 'btn btn-primary state-retry', type: 'button',
        text: D.listStates.error.retry
      });
      btn.addEventListener('click', function () { if (o.onRetry) o.onRetry(); });
      add(rb, h('div', { class: 'state-acts' }, btn));
      return rb;
    }

    return null;
  }

  /* ============================================================
     一、导航标签 + 按地址切视图（Day 13 加）
     ============================================================ */

  /* 导航栏。故意用真正的 <nav> + <a href="#/...">：
     就算 JS 出错没跑起来，点链接地址也会变；
     键盘能 Tab 过去、能按回车，浏览器「返回」键也天然管用。 */
  function renderTabs() {
    var box = document.getElementById('tabs');
    if (!box) return;
    clear(box);
    D.views.forEach(function (v) {
      add(box, h('a', {
        class: 'tab', href: hashOf(v.id), 'data-view': v.id, text: v.label
      }));
    });
  }

  /* 把导航栏上「当前是哪个」标出来。
     aria-current="page" 不只是给样式用的：读屏软件会念「当前页」，
     不然用户听完三个标签也不知道自己在哪一个。 */
  function markTabs(id) {
    var links = document.querySelectorAll('#tabs .tab');
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute('data-view') === id) links[i].setAttribute('aria-current', 'page');
      else links[i].removeAttribute('aria-current');
    }
  }

  /* 显示某一个视图（只负责「显示谁」这件事） */
  function showView(id) {
    D.views.forEach(function (v) {
      var el = document.getElementById('view-' + v.id);
      if (!el) return;
      if (v.id === id) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    });
    markTabs(id);

    /* 浏览器标签页上的标题也跟着变 —— 一眼能看出自己在哪一页 */
    var v = viewOf(id);
    document.title = (v ? v.title + ' · ' : '') + '大学生成长网站';

    /* 换页从头看起。不滚到顶的话，从长页面切到短页面会停在半空 */
    window.scrollTo(0, 0);
  }

  /* 进入某个视图时，把它的内容现画一遍。
     ⚠️ 每次进来都重画，不缓存 —— 打卡、收藏是可变的，
     缓存一份「上次的样子」就会出现「换了页面回来还是旧数字」。 */
  function enterView(id) {
    if (id === 'home') {
      /* 切回「今日」时把上一轮的反馈清掉 ——
         否则刚才那条「已记下…」会跟着页面回来，看着像刚点的。 */
      justToggled = null;
      notice = null;
      renderStats();
      renderQuote();
      renderActions();
    } else if (id === 'library') {
      renderLibraryHead();
      renderLibraryDemo();
      loadLibrary();
    } else if (id === 'me') {
      renderMeHead();
      renderMeFavorites();
      renderMeHistory();
    }
  }

  /* 「上次画的是哪个」——只是缓存，用来避免同一次切换里重复重画。
     真正的依据永远是地址栏，见 onRouteChange()。 */
  var currentView = null;

  function onRouteChange() {
    var id = R.viewIdFromHash(location.hash, D.views, C.route);
    var canonical = hashOf(id);

    /* 地址认不出来（空的 / 手打错一个字母）→ 把地址栏纠正成默认视图的地址。
       用 location.replace：不往历史里多塞一条，用户按「返回」不会退回错地址。
       万一改不动（比如本地 file:// 下被浏览器拦），也不要紧 —— 页面照样能看。 */
    if (location.hash !== canonical) {
      try { location.replace(canonical); } catch (e) { /* 忽略：改不了地址不影响看页面 */ }
    }

    if (id === currentView) return;   /* 同一个视图，不用重画 */
    currentView = id;
    showView(id);
    enterView(id);
  }

  /* ============================================================
     二、顶部：元信息行（三个视图共用）
     ============================================================ */
  function renderMeta() {
    var box = document.getElementById('meta-row');
    if (!box) return;
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
     三、视图一「今日」：三张统计卡
     ============================================================ */

  /* 「今天完成了几个行动」这件事只允许有一个来源：查记录里有哪些 id。
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
    if (!box) return;
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
     四、视图一「今日」：语录卡（可以「换一句」，也可以「收藏」）
     ============================================================ */
  var quoteIndex = 0;

  function renderQuote() {
    var box = document.getElementById('quote-card');
    if (!box) return;
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

    /* 三个动作按钮 */
    var acts = h('div', { class: 'quote-acts' });

    var btnNext = h('button', { class: 'btn', type: 'button', id: 'btn-next', text: '换一句' });
    btnNext.addEventListener('click', function () {
      quoteIndex = (quoteIndex + 1) % D.quotes.length;
      renderQuote();
    });

    /* 收藏按钮。状态**从存储里读**，不是从某个变量记 ——
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

    /* 收藏之后必须「看得见」—— Day 12 的教训：按完看不到任何结果，就不算一个功能。
       收藏**列表**现在搬到「我的」那页去了（Day 13 分视图），
       所以这里留一条明确的入口，并显示条数。 */
    var favCount = S.getFavorites().length;
    if (favCount) {
      add(box, h('p', { class: 'quote-more' },
        h('span', { text: '已收藏 ' + favCount + ' 条 · ' }),
        h('a', { href: hashOf('me'), text: '去「我的」看全部' })));
    }
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
     五、视图一「今日」：自律行动卡（可以勾选，勾选会真的存下来）
     ============================================================ */

  /* 打卡的「反馈」靠两个变量（Day 11 补）：
       justToggled —— 刚被点的那一项的 id。**只给它播「打勾」动效**；
                      不记这个的话，每次重画整列都会重播一遍动画，
                      看着像整列一起在闪，反而看不出是"我点的那一下"。
       notice      —— 点完之后要显示的那句提示。null = 不显示。 */
  var justToggled = null;
  var notice = null;
  var noticeTimer = null;

  function renderActions() {
    var box = document.getElementById('action-card');
    if (!box) return;
    clear(box);
    var ids = doneIds();
    var total = D.actions.length;

    add(box, h('h2', { class: 'action-title', text: '今日自律行动' }));
    add(box, h('p', { class: 'action-sub', text: '点一下就算完成。记录只存在你自己的浏览器里，不上传、也不用登录。' }));

    /* 「已记下」提示放在标题下面 —— 位置固定，不跟着列表长短跑 */
    add(box, renderNotice());

    var ul = h('ul', { class: 'action-list' });

    D.actions.forEach(function (a) {
      var on = ids.indexOf(a.id) >= 0;
      var li = h('li', {
        /* is-pop 只挂给「刚点的那一项」，动画因此只播一次 */
        class: 'action-item' + (on ? ' is-done' : '') + (a.id === justToggled ? ' is-pop' : ''),
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

        /* 这一下点完到底是「勾上」还是「取消」？**以存储里的结果为准**，
           不看界面上刚才的样子（界面可能是过期的）。 */
        var isOn = doneIds().indexOf(a.id) >= 0;

        /* 反馈（Day 11 补）：
           ① 只给刚点的这一项播动效；
           ② 明说一句「已记下 / 已取消」并带上今天到几项 ——
              不用用户自己去数下面那行小字。 */
        justToggled = a.id;
        notice = {
          on: isOn,
          text: (isOn ? '已记下：' : '已取消：') + a.text
                + ' · 今天 ' + countDone() + ' / ' + total
        };

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

    var done = countDone();   /* 同一个数只有这一处算法，跟统计卡共用 */
    add(box, h('p', { class: 'action-progress' },
      '今天已完成 ', h('b', { text: done + ' / ' + total }),
      done === total ? ' —— 全部完成，明天见。' : ' —— 别断在这儿。'));

    /* ⚠️ 「最近几天的记录」这块 Day 13 搬到「我的」那页了（renderMeHistory），
       不再塞在这张卡里 —— 打卡卡只管「今天」，历史去「我的」看。 */

    /* 「刚点的那一项」这个标记用完就撤 ——
       否则以后随便哪次重画，它都会再弹一遍动画。 */
    justToggled = null;
  }

  /* 点完打卡后那条提示（Day 11 补）。
     没点过时 notice 是 null，这里返回 null，add() 会直接跳过 ——
     所以平时卡片里不会挂着一条空提示。 */
  function renderNotice() {
    if (!notice) return null;

    var el = h('p', {
      class: 'action-notice' + (notice.on ? '' : ' is-off'),
      /* role=status：读屏软件会把这句话念出来，不用用户自己去界面里找 */
      role: 'status',
      text: notice.text
    });

    /* 停一会儿就淡出，然后整条摘掉 ——
       只淡出、不摘掉的话，卡片顶上会一直留着一块看不见的空白。
       先清掉上一次的定时器，免得连续点击时几个定时器互相抢。 */
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      el.classList.add('is-out');
      noticeTimer = setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 500);   /* 上面 opacity 过渡是 .45s，多留一点余量 */
    }, C.noticeMs);

    return el;
  }

  /* 最近 N 天的小格子：每格一个方块，颜色越实表示那天完成得越多。
     withHead=false 时不画自带的小标题（「我的」那页有自己的章节标题）。 */
  function renderHistory(total, withHead) {
    var recent = R.recentDays(S.allDays(), todayKey(), C.historyDays);
    var sum = R.summary(recent, total);
    var wrap = h('div', { class: 'history' });

    if (withHead !== false) {
      add(wrap, h('div', { class: 'history-head' },
        h('span', { class: 'history-title', text: '最近 ' + recent.length + ' 天' }),
        h('span', { class: 'history-sum', text: sum.done + ' / ' + sum.possible + ' 项' })));
    }

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
     六、视图二「内容库」：三列榜单 + 列表的四种状态（Day 13）
     ============================================================ */

  function renderLibraryHead() {
    var box = document.getElementById('library-head');
    if (!box) return;
    var v = viewOf('library');
    clear(box);
    if (!v) return;
    add(box, h('h2', { class: 'view-title', text: v.title }));
    add(box, h('p', { class: 'view-desc', text: v.desc }));
  }

  /* 内容库的数据源模式。
     'ok' = 正常有内容；'empty' = 数据回来了但一条都没有；'error' = 读失败。
     ⚠️ 这三个是**演示用的开关**，不是给用户的产品功能 ——
     因为现在内容是写在本地的，「空」和「出错」两种情况平时根本撞不上，
     不做一个开关就永远看不到这两种状态长什么样（清单要求四种都要看得到）。
     以后真接了后端，这三种情况会自己出现，那时把这块演示区删掉就行。 */
  var libMode = 'ok';
  var libState = 'loading';    /* 'loading' | 'ready' | 'empty' | 'error' */
  var libTimer = null;

  /* 模拟「去读内容」这件事。
     先立刻切成「加载中」，等 C.listDelayMs 之后再给结果 ——
     这就是以后接服务器的形状：先等，再出结果，也可能失败。 */
  function loadLibrary() {
    libState = 'loading';
    renderLibrary();

    if (libTimer) clearTimeout(libTimer);
    libTimer = setTimeout(function () {
      libTimer = null;
      if (libMode === 'error') libState = 'error';
      else if (libMode === 'empty') libState = 'empty';
      else libState = 'ready';
      renderLibrary();
      renderLibraryDemo();   /* 对照区里「现在用的是哪种」要跟着变 */
    }, C.listDelayMs);
  }

  function renderLibrary() {
    var box = document.getElementById('library-list');
    if (!box) return;
    clear(box);

    if (libState === 'loading' || libState === 'error') {
      add(box, ListState(libState, { onRetry: function () { loadLibrary(); } }));
      return;
    }
    if (libState === 'empty') {
      /* 空的时候**每一列各自**显示空状态，而不是整块替换掉 ——
         因为真实情况就是「某一列还没收录内容」，标题还在，列表是空的。 */
      add(box, renderColumns(emptyColumns()));
      return;
    }
    add(box, renderColumns(D.columns));
  }

  /* 把三列内容变成「空的」——每列标题保留、items 清空。
     ⚠️ 必须造**新的对象**，不能直接改 D.columns 里的 items：
     那样就把原始内容数据改坏了（这是「一个事实一个来源」的另一面）。 */
  function emptyColumns() {
    return D.columns.map(function (col) {
      return { key: col.key, title: col.title, note: col.note, accent: col.accent, items: [] };
    });
  }

  /* 「四种状态对照」演示区。
     四格并排 —— 一屏就能看到四种状态，正好用来对照检查有没有漏。
     下面那排按钮是开关：点了就把内容库切成对应的状态。 */
  function renderLibraryDemo() {
    var box = document.getElementById('library-demo');
    if (!box) return;
    clear(box);

    var wrap = h('section', { class: 'demo' });
    add(wrap, h('div', { class: 'demo-head' },
      h('h3', { class: 'demo-title', text: '四种状态对照' }),
      h('p', { class: 'demo-note', text: '开发演示区：上面四格是列表的四种样子。正式产品里不会给用户看到这一块 —— 它在这儿只是为了让四种状态能一眼对照、一个个检查。' })));

    var row = h('div', { class: 'demo-row' });
    var L = D.listStates.labels;
    var CAP = D.listStates.captions;

    /* 顺序固定成：空 → 加载中 → 出错 → 正常（从「最没内容」到「有内容」看下来） */
    var order = [
      { s: 'empty' },
      { s: 'loading' },
      { s: 'error' },
      { s: 'ready' }
    ];
    order.forEach(function (it) {
      var card = h('div', { class: 'demo-card' + (libState === it.s ? ' is-on' : '') });
      add(card, h('p', { class: 'demo-cap', text: L[it.s] }));
      add(card, h('div', { class: 'demo-body' }, demoBody(it.s)));
      add(card, h('p', { class: 'demo-foot', text: CAP[it.s] }));
      add(row, card);
    });
    add(wrap, row);

    var ctl = h('div', { class: 'demo-controls' });
    add(ctl, h('span', { class: 'demo-ctl-label', text: '把下面的内容库切成：' }));
    var modes = [
      { m: 'ok', label: '正常数据', attr: 'ok' },
      { m: 'empty', label: '空数据', attr: 'empty' },
      { m: 'error', label: '读取失败', attr: 'error' }
    ];
    modes.forEach(function (it) {
      var b = h('button', {
        class: 'btn' + (libMode === it.m ? ' is-on' : ''),
        type: 'button', 'data-lib-mode': it.attr,
        'aria-pressed': libMode === it.m ? 'true' : 'false',
        text: it.label
      });
      b.addEventListener('click', function () {
        libMode = it.m;
        loadLibrary();            /* 顺带会把对照区重画一遍 */
        renderLibraryDemo();
      });
      add(ctl, b);
    });
    add(wrap, ctl);

    add(box, wrap);
  }

  /* 对照格里那一小块列表。
     ⚠️ 走的是**同一个** ListState()，不是另画一套 ——
     否则对照出来的样子和真列表不一样，这个对照就没意义了。
     'ready' 用两条**真内容**（不是编的占位字），免得对照本身在说假话。 */
  function demoBody(s) {
    if (s === 'empty') return ListState('empty', {});
    if (s === 'loading') return ListState('loading', { rowsNum: 3 });
    if (s === 'error') return ListState('error', {});
    return ListState('ready', { rows: miniRows(2) });
  }

  /* 从第一列「认知 · 自律」里取前 n 条，画成小列表（对照区用） */
  function miniRows(n) {
    var col = D.columns[0];
    var out = h('ol', { class: 'col-list' });
    for (var i = 0; i < n && i < col.items.length; i++) {
      add(out, h('li', { class: 'entry' },
        h('span', { class: 'entry-no', text: i + 1 }),
        h('div', { class: 'entry-body' },
          h('p', { class: 'entry-title', text: col.items[i].title }))));
    }
    return out;
  }

  /* 三列榜单本体。cols 由调用方给：
     正常时是 D.columns，演示「空」时是 emptyColumns()。 */
  function renderColumns(cols) {
    var box = h('section', { class: 'columns', 'aria-label': '精选内容' });

    cols.forEach(function (col) {
      var sec = h('section', { class: 'col', style: { '--accent': col.accent } });

      add(sec, h('div', { class: 'col-head' },
        h('h2', { class: 'col-title' },
          h('span', { class: 'dot' }), col.title),
        h('p', { class: 'col-note', text: col.note })));

      if (!col.items.length) {
        /* 这一列没有内容 → 走空状态，而不是留一片空白 */
        add(sec, ListState('empty', {}));
      } else {
        var list = h('ol', { class: 'col-list' });
        col.items.forEach(function (it, i) {
          add(list, renderEntry(it, i + 1));
        });
        add(sec, list);
      }
      add(box, sec);
    });

    return box;
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
     七、视图三「我的」：收藏 + 打卡记录（Day 13 新分出来的）
     ============================================================ */

  function renderMeHead() {
    var box = document.getElementById('me-head');
    if (!box) return;
    var v = viewOf('me');
    clear(box);
    if (!v) return;
    add(box, h('h2', { class: 'view-title', text: v.title }));
    add(box, h('p', { class: 'view-desc', text: v.desc }));
  }

  /* 我的收藏。一条都没有时**显示空状态**，不是整块消失 ——
     Day 12 的做法是「没有就整块不出现」，那样用户会以为这功能没做。

     ⚠️ Day 13 起「显示空状态」替代了 PRD 里 AC-05b 的「整块不出现」，
     原因就写在清单里：四种状态都得有，空也是一种要有说明的状态。 */
  function renderMeFavorites() {
    var box = document.getElementById('me-favorites');
    if (!box) return;
    clear(box);

    var ids = S.getFavorites();
    var items = [];
    ids.forEach(function (id) {
      var q = quoteById(id);
      if (q) items.push(q);   /* 记录里留着已删掉的 id：跳过，不画出来 */
    });

    add(box, h('div', { class: 'me-head' },
      h('h2', { class: 'me-title', text: D.me.favTitle }),
      h('span', { class: 'me-count', text: items.length ? items.length + ' 条 · 点一条跳过去' : '' })));

    if (!items.length) {
      add(box, ListState('empty', {
        title: D.me.favEmptyTitle,
        hint: D.me.favEmptyHint,
        actionLabel: D.me.favEmptyAction,
        onAction: function () { location.hash = hashOf('home'); }
      }));
      return;
    }

    var row = h('ul', { class: 'favs-list' });
    items.forEach(function (q) {
      var li = h('li', { class: 'fav-item', role: 'button', tabindex: '0',
        title: q.text + ' —— ' + q.author });
      add(li, h('span', { class: 'fav-text', text: q.text }));
      add(li, h('span', { class: 'fav-from', text: '— ' + q.author }));

      function go() {
        var at = D.quotes.indexOf(q);
        if (at < 0) return;
        /* 把语录卡切到这一条，再跳到「今日」那页去看它。
           地址一变，onRouteChange 会把「今日」画出来 —— 顺序不能反：
           先改 quoteIndex，等那边重画时正好画的就是这一条。 */
        quoteIndex = at;
        location.hash = hashOf('home');
      }
      li.addEventListener('click', go);
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
      add(row, li);
    });
    add(box, row);
  }

  /* 打卡记录。7 天全是 0 的时候照样把格子画出来（「空」本身也是信息），
     再补一句「接下来干什么」，别让人盯着一排 0 发呆。 */
  function renderMeHistory() {
    var box = document.getElementById('me-history');
    if (!box) return;
    clear(box);

    var total = D.actions.length;
    var recent = R.recentDays(S.allDays(), todayKey(), C.historyDays);
    var sum = R.summary(recent, total);

    add(box, h('div', { class: 'me-head' },
      h('h2', { class: 'me-title', text: D.me.hisTitle }),
      h('span', { class: 'me-count', text: sum.done + ' / ' + sum.possible + ' 项' })));

    add(box, renderHistory(total, false));

    if (sum.done === 0) {
      add(box, h('p', { class: 'state-hint', style: { 'text-align': 'left' }, text: D.me.hisEmptyHint }));
    }
  }

  /* ============================================================
     八、底部（三个视图共用）
     ============================================================ */
  function renderFoot() {
    var box = document.getElementById('foot');
    if (!box) return;
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
  renderTabs();     /* 导航栏不依赖地址，先画 */
  renderMeta();     /* 元信息行 / 顶栏连续天数：三个视图共用，跟在哪一页无关 */
  renderFoot();

  /* 地址一变就跟着切视图（点导航标签、浏览器前进/返回，都会走到这里） */
  window.addEventListener('hashchange', onRouteChange);
  /* 首次打开也走同一条路：地址是 #/library 就直接进内容库 */
  onRouteChange();

})();
