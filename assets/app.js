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
  var G = window.GROWTH_CLOUD;   /* Day 17：所有云端读写都在 cloud.js，这里只是用它的结果 */

  /* 打卡是打在「今天」上的。但页面可能开着过夜（跨过零点），
     所以每次要用的时候现算一次，不在一开始缓存下来。 */
  function todayKey() { return S.todayKey(); }
  function doneIds() { return S.getDay(todayKey()); }

  /* 「今天要做的事」= 默认 3 项（data.js）+ 自己加的项（浏览器存储里）。
     ⚠️ **全页只有这一个来源**（AGENTS 第 4 条第 9 项，「同一个事实只允许有一个来源」）：
     统计卡的分母、行动列表、进度文字、「我的」里的完成度，全都走这里。
     哪一处要是自己去拼 D.actions，就会重新长回 Day 10 那个「同一屏两个数」的毛病。 */
  function allActions() { return R.allActions(D.actions, S.getCustomActions()); }

  /* 删除类操作统一走这里（AGENTS 第 4 条第 11 项）。
     现在只有一个地方用：删掉自己加的某一项行动。
     为什么要封装而不是随手写 window.confirm：以后再加删除入口时，
     不会有人图省事直接写 confirm()，把「说清会丢什么、能不能撤销」那一段漏掉。 */
  function confirmDanger(title, lines) {
    var msg = title + '\n\n';
    for (var i = 0; i < lines.length; i++) msg += '· ' + lines[i] + '\n';
    return window.confirm(msg);
  }

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
      /* 切走再回来，「加一项」的输入行收起来（Day 14）——
         不然回来时半截没写完的字还挂在那儿，像没关好的抽屉。 */
      addingCustom = false;
      addMsg = '';
      renderStats();
      renderQuote();
      renderActions();
      renderDailyRead();   /* Day 15：今日一篇 */
      renderHot();         /* Day 17：今日热点（真实热搜，从云端读） */
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

  /* ⚠️ 光记「哪个视图」不够（Day 17 余力加练踩到的）：
     地址从 '#/home' 改成 '#/home?hot=3' 时，视图还是 home，
     如果只看视图名就直接 return，页面上那 8 条根本不会变成 3 条 ——
     地址变了、页面没动，看起来就像「这个参数没用」。
     → 所以缓存要连**和显示有关的参数**一起记，两个都相同才敢跳过重画。 */
  var currentHot = null;

  function onRouteChange() {
    var id = R.viewIdFromHash(location.hash, D.views, C.route);
    var hot = R.hotLimitFromHash(location.hash, C.hot.limit, C.hot.limitMax);

    /* ⚠️⚠️ 这里**不能**直接拿 hashOf(id) 去和 location.hash 比（Day 17 余力加练踩到）。
       因为 hashOf(id) 只会给出 '#/home'，而地址里可能带着 '?hot=3' ——
       一比就「不相等」，于是 location.replace 会把用户写的参数**抹掉**。
       表现就是：你输 ?hot=3，页面闪一下又变回 8 条，参数像没生效过。
       → 正确做法：**只把认不出来的部分纠正掉** ——
         认得出视图 id 就把参数原样保留，认不出才回默认地址。 */
    var wantKey = R.viewKey(location.hash);
    var known = false;
    for (var i = 0; i < D.views.length; i++) {
      if (String(D.views[i].id).toLowerCase() === wantKey) { known = true; break; }
    }
    if (!known) {
      try { location.replace(hashOf(id)); } catch (e) { /* 忽略：改不了地址不影响看页面 */ }
    }

    /* ⚠️ 这里**不能**因为「视图没变」就提前 return：还要比 hot 参数 ——
       见上面 currentHot 的注释。 */
    if (id === currentView && hot === currentHot) return;
    currentView = id;
    currentHot = hot;
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
    allActions().forEach(function (a) { if (ids.indexOf(a.id) >= 0) n++; });
    return n;
  }

  /* 把完成情况翻译成统计卡需要的那三段文字 */
  function actionStat() {
    var ids = doneIds();
    var acts = allActions();
    var total = acts.length;
    var left = acts.filter(function (a) { return ids.indexOf(a.id) < 0; });
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

  /* 行动卡里「自己加一项」那块的状态（Day 14 加）：
       addingCustom —— 输入行有没有展开着
       addMsg       —— 展开时下面那句话（比如「写点什么再加吧」）；空的就不显示 */
  var addingCustom = false;
  var addMsg = '';

  /* 输入行刚画出来要能直接打字，不然用户还得再点它一下。
     为什么单独写成函数：重画会把 input 换成一个新的，得重新去找到它。 */
  function focusAddInput() {
    var el = document.getElementById('input-add-action');
    if (el) el.focus();
  }

  function renderActions() {
    var box = document.getElementById('action-card');
    if (!box) return;
    clear(box);
    var ids = doneIds();
    var acts = allActions();
    var total = acts.length;

    add(box, h('h2', { class: 'action-title', text: '今日自律行动' }));
    add(box, h('p', { class: 'action-sub', text: '点一下就算完成。记录只存在你自己的浏览器里，不上传、也不用登录。' }));

    /* 「已记下」提示放在标题下面 —— 位置固定，不跟着列表长短跑 */
    add(box, renderNotice());

    var ul = h('ul', { class: 'action-list' });

    acts.forEach(function (a) {
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

      /* 只有**自己加的**项才给「×」。默认那 3 项不给 —— PRD 6.5 定死了不许删。 */
      if (a.custom) {
        var del = h('button', {
          class: 'action-del', type: 'button',
          'aria-label': '删除「' + a.text + '」',
          title: '删除这一项', text: '×'
        });
        del.addEventListener('click', function (e) {
          /* ⚠️ 这句不能省：不拦下来的话，点「×」会连这一行的勾选一起触发
             （li 上挂着 toggle），表现就是「删掉的同时还顺手打了一次卡」。 */
          e.stopPropagation();
          if (!confirmDanger('「' + a.text + '」—— ' + D.actionAdd.delTitle, D.actionAdd.delLines)) return;
          S.removeCustomAction(a.id);
          notice = null;        /* 刚删掉的东西，别再挂着它的提示 */
          renderActions();
          renderStats();
          renderStreak();
          if (currentView === 'me') renderMeHistory();   /* 顺手把「我的」那页的完成度也刷新 */
        });
        /* 键盘同理：不拦的话，焦点在「×」上按回车会先把这一行勾上 */
        del.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        });
        add(li, del);
      }

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

    /* ---------- 自己加一项（Day 14 加） ----------
       ⚠️ 放在**列表下面**，点了当场变成一行输入框。
       PRD 6.4 写死了「不设子视图、不做弹窗」，所以这里走的是「就地展开」：
       地址栏不变、不新开页面、不遮住别的内容。 */
    add(box, renderActionAdd(acts));

    /* ⚠️ 「最近几天的记录」这块 Day 13 搬到「我的」那页了（renderMeHistory），
       不再塞在这张卡里 —— 打卡卡只管「今天」，历史去「我的」看。 */

    /* 「刚点的那一项」这个标记用完就撤 ——
       否则以后随便哪次重画，它都会再弹一遍动画。 */
    justToggled = null;
  }

  /* 「+ 添加一项」那一块。收起时是一个按钮，展开时是「输入框 + 加上 + 取消」。 */
  function renderActionAdd(acts) {
    var T = D.actionAdd;
    var wrap = h('div', { class: 'action-add' });

    /* 只数「自己加的」有几项 —— 不能拿 acts.length 减 D.actions.length 去凑，
       万一 data.js 里有一项写坏了被 allActions 过滤掉，那个减法就错了。 */
    var mine = acts.filter(function (a) { return a.custom; });
    var full = mine.length >= C.customMax;

    if (!addingCustom) {
      if (full) {
        add(wrap, h('p', { class: 'action-add-note', text: T.fullMsg }));
      } else {
        var btn = h('button', {
          class: 'btn action-add-btn', type: 'button', id: 'btn-add-action', text: T.openBtn
        });
        btn.addEventListener('click', function () {
          addingCustom = true;
          addMsg = '';
          renderActions();
          focusAddInput();
        });
        add(wrap, btn);
      }
      /* 上限那个数字只在 config.js 一处，这里拼进来 —— 文案里不许再写一个数字 */
      add(wrap, h('p', { class: 'action-add-hint',
        text: T.hint + ' ' + C.customMax + ' ' + T.hintUnit }));
      return wrap;
    }

    /* ---- 展开状态 ---- */
    var input = h('input', {
      class: 'action-add-input', type: 'text', id: 'input-add-action',
      maxlength: String(C.customTextMax), placeholder: T.placeholder,
      'aria-label': '自己想加的一项行动'
    });

    function submit() {
      var text = String(input.value || '').replace(/^\s+|\s+$/g, '');
      /* 空的 / 只打了空格：**不提交、也不弹报错**，就在下面写一句人话。
         少一个打断 —— 用户没填就是没填，不需要被教育。 */
      if (!text) {
        addMsg = T.emptyMsg;
        renderActions();
        focusAddInput();
        return;
      }
      var taken = acts.map(function (a) { return a.id; });
      var res = S.addCustomAction(text, R.customId(Date.now(), taken));
      if (!res.ok) {
        /* 存不下要**如实说**是哪一种原因，不能默默不生效 */
        addMsg = res.reason === 'full' ? T.fullMsg : T.emptyMsg;
        renderActions();
        focusAddInput();
        return;
      }
      addingCustom = false;
      addMsg = '';
      renderActions();
      renderStats();   /* 分母变了，上面那张统计卡跟着变 —— 两处永远是同一个数 */
    }

    var ok = h('button', { class: 'btn btn-primary', type: 'button', id: 'btn-add-confirm', text: T.confirm });
    ok.addEventListener('click', submit);

    var cancel = h('button', { class: 'btn', type: 'button', id: 'btn-add-cancel', text: T.cancel });
    cancel.addEventListener('click', function () {
      addingCustom = false;
      addMsg = '';
      renderActions();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
    });

    add(wrap, h('div', { class: 'action-add-row' }, input, ok, cancel));
    add(wrap, h('p', { class: 'action-add-hint',
      text: T.hint + ' ' + C.customMax + ' ' + T.hintUnit }));
    if (addMsg) add(wrap, h('p', { class: 'action-add-msg', role: 'status', text: addMsg }));

    return wrap;
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

  /* 「我的」里哪一天是展开着的（Day 14 加）。null = 全都收起。
     ⚠️ 一次只记一天 —— PRD 6.6 定的「一次只展开一格」。
     这个变量只属于界面状态，不进存储：刷新后收起是正常且想要的。 */
  var openDayKey = null;

  /* 最近 N 天的小格子：每格一个方块，颜色越实表示那天完成得越多。
     withHead=false 时不画自带的小标题（「我的」那页有自己的章节标题）。

     Day 14 加：格子**可以点**了。点一下就在下面**就地展开**那一天，
     看当天具体做了什么 —— 以前只有一个数字，想知道上周三干了什么没任何入口。
     ⚠️ 走的是「就地展开」，不是弹窗、也不是新页面（PRD 6.4 不许做弹窗）。 */
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
      var isOpen = d.key === openDayKey;
      var tip = d.key + ' 完成 ' + d.count + ' / ' + total + ' 项';
      var li = h('li', {
        class: 'history-cell ' + state
             + (d.key === todayKey() ? ' is-today' : '')
             + (isOpen ? ' is-open' : ''),
        /* 和行动项同一个做法：li 挂 role=button + tabindex，键盘能 Tab 到、回车能开 */
        role: 'button', tabindex: '0',
        'aria-expanded': isOpen ? 'true' : 'false',
        title: tip,
        'aria-label': tip + '，回车看当天做了什么'
      });
      add(li, h('span', { class: 'history-day', text: d.label }));
      add(li, h('span', { class: 'history-num', text: String(d.count) }));

      function pick() {
        /* 再点同一格 = 收起（同一个按钮管开和关）；点别的格 = 换成那一格。 */
        openDayKey = (openDayKey === d.key) ? null : d.key;
        renderMeHistory();
      }
      li.addEventListener('click', pick);
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });

      add(row, li);
    });
    add(wrap, row);

    /* 展开的那一天，就地画在格子下面 */
    if (openDayKey) add(wrap, renderDayDetail(openDayKey, total));

    return wrap;
  }

  /* 某一天的明细。数字和清单全部由 R.dayDetail() 现算 —— 页面不自己拼。 */
  function renderDayDetail(key, total) {
    var d = R.dayDetail(S.allDays(), key, allActions(), todayKey());
    var box = h('div', { class: 'day-detail' });

    add(box, h('p', { class: 'day-detail-head' },
      h('b', { text: key }),
      h('span', { class: 'day-detail-wd', text: ' 周' + d.weekday }),
      h('span', { class: 'day-detail-count',
        text: D.me.dayCountLead + ' ' + d.count + ' / ' + D.me.dayCountJoin + ' ' + d.total + ' ' + D.me.dayCountUnit })));

    if (!d.done.length && !d.gone.length) {
      add(box, h('p', { class: 'day-detail-empty', text: D.me.dayEmpty }));
      return box;
    }

    var ul = h('ul', { class: 'day-detail-list' });
    d.done.forEach(function (a) {
      add(ul, h('li', { class: 'day-detail-item' },
        h('span', { class: 'day-detail-box', text: '✓' }),
        h('span', { class: 'day-detail-text', text: a.text })));
    });
    /* 记录里留着、但现在的列表里已经没有的项（一般是自定义项被删了）。
       ⚠️ 照样列出来、照样算进上面那个数 ——
       不许因为「查不到它叫什么」就把它悄悄抹掉，否则那天看起来会像少做了一项。
       ⚠️ 这里**故意不显示那个 id**：`c1790764607332` 这种是给机器看的编号，
       给人看等于一句黑话（第一版显示过，截图一看全是乱码感，删掉）。 */
    d.gone.forEach(function (id) {
      add(ul, h('li', { class: 'day-detail-item is-gone' },
        h('span', { class: 'day-detail-box', text: '✓' }),
        h('span', { class: 'day-detail-text', text: D.me.dayGone })));
    });
    add(box, ul);

    return box;
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

    /* 一行小字：形态徽标 + 标签 + 来源/人物 + 时间 */
    var meta = h('div', { class: 'entry-meta' });
    /* ⚠️ 形态徽标要画（Day 15，F13）——
       在这之前，页面上**根本看不出「这条是视频还是文章」**，
       可是一条 30 秒的视频和一篇 8 分钟的文章，花的时间差十几倍。
       徽标上的字由 rules.js 的 mediaBadge() 算：
       有 dur 就是「文章 · 约 6 分钟」，没有就只写「文章」；
       media 认不出来时回落到「文章」，**不报错、也不印 undefined**。 */
    add(meta, h('span', { class: 'media-badge' }, R.mediaBadge(it)));
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
     再补一句「接下来干什么」，别让人盯着一排 0 发呆。

     Day 14 加：格子可点，点开就地看那一天。上面补一句说明 ——
     不写的话，没人会去点一个方块（他能看见的是「一个数字」，看不出能点）。 */
  function renderMeHistory() {
    var box = document.getElementById('me-history');
    if (!box) return;
    clear(box);

    var total = allActions().length;
    var recent = R.recentDays(S.allDays(), todayKey(), C.historyDays);
    var sum = R.summary(recent, total);

    add(box, h('div', { class: 'me-head' },
      h('h2', { class: 'me-title', text: D.me.hisTitle }),
      h('span', { class: 'me-count', text: sum.done + ' / ' + sum.possible + ' 项' })));

    add(box, h('p', { class: 'me-hint', text: D.me.hisHint }));

    add(box, renderHistory(total, false));

    if (sum.done === 0) {
      add(box, h('p', { class: 'state-hint', style: { 'text-align': 'left' }, text: D.me.hisEmptyHint }));
    }
  }

  /* ============================================================
     七·B、视图一「今日」的「今日一篇」（Day 15 加，C 方案）
     ============================================================
     一天只推**一条**长内容，读完就算今天过完。

     为什么不做成「内容库」里的第 4 条列表：
     长内容如果只加进那三列里，它会立刻变成第 4 个「收藏夹黑洞」——
     一篇要读 8 分钟的文章混在一堆 30 秒视频里，手会自己划过去。
     所以节奏跟「今日语录」一样：**每天只给你今天这一份。** */

  function renderDailyRead() {
    var box = document.getElementById('daily-read');
    if (!box) return;
    clear(box);

    var T = D.dailyRead || {};

    /* 今天该推哪一篇**由日期决定**（rules.js 的 pickDaily）——
       同一天刷新多少次、切走视图再切回来，都是同一篇；第二天自动换下一篇。
       ⚠️ 不许用 Math.random()：随机会让「今天这篇」自己变，
       用户会以为是自己记错了，而且随机的东西没法写测试。 */
    var one = R.pickDaily(D.reads, todayKey());

    /* 池子空了 → **整张卡不画**（不是画一个空壳）。
       空壳会让人以为页面坏了，这跟「列表四种状态」是同一条道理。 */
    if (!one) return;

    var card = h('article', { class: 'daily-read-card', 'aria-label': T.kicker });

    /* 卡头：标题 + 形态徽标 + 示例内容标记 */
    var head = h('div', { class: 'dr-head' });
    add(head, h('p', { class: 'dr-kicker', text: T.kicker }));
    add(head, h('span', { class: 'media-badge' }, R.mediaBadge(one)));
    /* ⚠️ 「示例内容」这一格不能省：
       现在池子里全是示例，不写这一句，看的人会以为已经是真实收录了。 */
    add(head, h('span', { class: 'dr-sample', text: '示例内容' }));
    add(card, head);

    add(card, h('p', { class: 'dr-lead', text: T.lead }));
    add(card, h('h3', { class: 'dr-title', text: one.title }));
    add(card, h('p', { class: 'dr-origin' },
      h('span', { class: 'dr-origin-label', text: '来源：' }),
      one.origin));

    /* 摘要：挂一个「本站提炼」的小标记，别让人以为是原文 */
    add(card, h('p', { class: 'dr-summary' },
      h('span', { class: 'dr-mine', text: T.mineLabel }),
      h('span', { text: one.summary })));

    if (one.points && one.points.length) {
      var pl = h('ul', { class: 'dr-points' });
      one.points.forEach(function (p) { add(pl, h('li', { text: p })); });
      add(card, h('div', { class: 'dr-points-wrap' },
        h('p', { class: 'dr-sub', text: T.pointsTitle }),
        pl));
    }

    if (one.use) {
      add(card, h('p', { class: 'dr-use' },
        h('b', { text: T.useLabel }),
        h('span', { text: one.use })));
    }

    /* 动作区：「读完了」+（有链接时）「去读原文」 */
    var acts = h('div', { class: 'dr-acts' });

    var read = S.hasRead(one.id);
    var btnDone = h('button', {
      class: 'btn btn-primary' + (read ? ' is-on' : ''),
      type: 'button', id: 'btn-read-done',
      text: read ? T.doneText : T.doneBtn,
      'aria-pressed': read ? 'true' : 'false'
    });
    btnDone.addEventListener('click', function () {
      /* ⚠️ 先写存储，再重画 —— 顺序反了就是「屏幕上变了、其实没存住」。
         Day 12 收藏那边踩过这个坑，这里照同一条规矩走。 */
      S.toggleRead(one.id);
      renderDailyRead();
    });
    add(acts, btnDone);

    /* ⚠️ 没有 url 时**不许留一个点了没反应的按钮**（AC-45）——
       编一个假链接比没有链接更糟：那是硬约束 C4 里说的「编造」。 */
    if (one.url) {
      add(acts, h('a', {
        class: 'btn', href: one.url,
        target: '_blank', rel: 'noopener noreferrer',
        text: T.readBtn
      }));
    }
    add(card, acts);

    if (!one.url) {
      add(card, h('p', { class: 'dr-nolink', text: T.noLink }));
    }
    add(card, h('p', { class: 'dr-undo', text: T.undoHint }));

    add(box, card);
  }

  /* ============================================================
     七之二、今日热点（Day 17 加）
     ============================================================
     这是**页面上第一块真正的云端数据**：条目来自云端数据库的 hot_topics 表，
     由 db/sync-hot.mjs 每天从公开热搜接口抓一次写进去。

     ⚠️ 三个「不许」：
     ① 不许把读不到悄悄吞掉 —— 读不到就如实说，绝不编数据顶上（PRD C4）。
     ② 不许在这里直接写 fetch 或拼云端地址 —— 所有云端逻辑在 cloud.js，
        这个函数只管「把拿到的画出来」。
     ③ 不许给它挂「示例内容」标记 —— 它是真实的，跟上面那些示例内容不是一回事；
        但必须如实标出「哪一天的榜单」和「来源」，让人能自己去核对。 */
  /* limit 从哪来：地址里的 '?hot=N'（Day 17 余力加练）。
     没写就用 config.js 里那个默认条数；写坏了也回默认。 */
  function hotLimit() {
    return R.hotLimitFromHash(location.hash, C.hot.limit, C.hot.limitMax);
  }

  function renderHot() {
    var box = document.getElementById('hot');
    if (!box) return;
    clear(box);

    var T = (D.hot || {});
    var n = hotLimit();

    /* 加载中：先把骨架画出来，别让页面在这一块空着。
       云端请求再快也有个来回，留白会让人以为「这里本来就没东西」。 */
    var card = h('article', { class: 'hot-card', 'aria-label': T.title });
    var head = h('div', { class: 'hot-head' });
    add(head, h('h2', { class: 'hot-title', text: T.title }));
    add(head, h('span', { class: 'hot-loading', id: 'hot-status', text: T.loading }));
    /* ⚠️ 用户自己用 ?hot=N 指定了条数时，把这句说出来 ——
       不然他会以为「怎么只显示 3 条」，还以为是页面坏了。 */
    if (n !== C.hot.limit) {
      add(head, h('span', { class: 'hot-param', text: T.paramTag.replace('{n}', String(n)) }));
    }
    add(card, head);

    var list = h('ol', { class: 'hot-list', id: 'hot-list' });
    add(card, list);
    add(box, card);

    for (var i = 0; i < n; i++) {
      add(list, h('li', { class: 'hot-row is-skeleton' },
        h('span', { class: 'hot-rank hot-skeleton' }),
        h('span', { class: 'hot-text hot-skeleton' })));
    }

    /* 真正去读云端。读回来之后再把骨架换成真数据。 */
    G.fetchHotTopics(n).then(function (res) {
      /* 页面可能已经切走了（比如用户点了「内容库」），这时 box 不在文档里了 ——
         不去动它，免得往一个已经不在的节点上画东西。 */
      if (!box.isConnected && document.getElementById('hot') !== box) return;
      paintHot(box, T, res, n);
    }).catch(function () {
      paintHot(box, T, { ok: false, reason: 'query-failed' }, n);
    });
  }

  /* 把结果画出来。三种结局，每一种都要说人话：
       成功   → 榜单 + 「哪一天的榜单」+ 来源（可核对）
       读不到 → 一句实话 + 原因分类，不给假数据
       空库   → 说明「今天的还没同步」，也不编 */
  function paintHot(box, T, res, limit) {
    clear(box);

    if (!res || !res.ok) {
      var why = T.failUnknown;
      if (res && res.reason === 'no-sdk') why = T.failNoSdk;
      else if (res && res.reason === 'empty') why = T.failEmpty;
      else if (res && res.reason === 'query-failed') why = T.failQuery;

      var card = h('article', { class: 'hot-card is-fail', 'aria-label': T.title });
      var head = h('div', { class: 'hot-head' });
      add(head, h('h2', { class: 'hot-title', text: T.title }));
      add(head, h('span', { class: 'hot-loading', text: T.failTag }));
      add(card, head);
      add(card, h('p', { class: 'hot-fail-msg', text: why }));
      /* 重试按钮：读不到时给一个「再试一次」的出口，而不是让人去猜。
         用 textContent 写文字，不拼 HTML（AGENTS 铁律第 1 条）。 */
      add(card, h('button', {
        class: 'btn', type: 'button', id: 'btn-hot-retry', text: T.retry
      }));
      add(box, card);
      box.querySelector('#btn-hot-retry').addEventListener('click', function () { renderHot(); });
      return;
    }

    var card2 = h('article', { class: 'hot-card', 'aria-label': T.title });
    var head2 = h('div', { class: 'hot-head' });
    add(head2, h('h2', { class: 'hot-title', text: T.title }));

    /* ★ 关键的一行：如实标出这份数据是哪一天的榜单。
       为什么必须有：数据是从云端读的、一天一份快照，页面上不写日期，
       看的人就分不清「这是刚才的」还是「这是昨天的」。
       真实数据的可信度，靠的就是这种「能被核对」的细节。 */
    add(head2, h('span', { class: 'hot-date', text: (T.dateLabel || '') + res.date }));

    /* ⚠️ 「你指定了 N 条」这个标记必须**也**画在这里（Day 17 余力加练踩到的）。
       第一版只画在「加载中」那版卡片上，而 paintHot 一上来就 clear(box)
       把整块清掉重画 —— 结果数据一回来，标记就跟着没了。
       表现是：你输 ?hot=3，页面上真只显示 3 条，但**没有任何一处告诉你
       「这是你要的 3 条」**，看起来就像页面出了毛病。
       —— 教训：凡是「用户这次操作的回声」，都必须画在**最终那版**上，
          画在中间态（加载中）里等于没画。 */
    if (typeof limit === 'number' && limit !== C.hot.limit) {
      add(head2, h('span', { class: 'hot-param', text: T.paramTag.replace('{n}', String(limit)) }));
    }
    add(card2, head2);

    var list = h('ol', { class: 'hot-list' });
    res.rows.forEach(function (r) {
      var li = h('li', { class: 'hot-row' });
      /* 名次。用文字型序号，纯装饰性的灰字。 */
      add(li, h('span', { class: 'hot-rank', text: String(r.rank) }));

      /* 标题：有原链接就做成可点的 <a>（跳百度看这条热搜的原始页面），
         没有链接就退化成纯文字 —— 不给一个点不动的假链接。 */
      var textWrap = h('span', { class: 'hot-text' });
      if (r.url) {
        add(textWrap, h('a', {
          class: 'hot-link', href: r.url, target: '_blank', rel: 'noopener noreferrer',
          text: r.title
        }));
      } else {
        add(textWrap, h('span', { text: r.title }));
      }
      if (r.summary) {
        add(textWrap, h('span', { class: 'hot-desc', text: r.summary }));
      }
      add(li, textWrap);

      /* 热度值。云端源不给就是 null —— 这时**留空**，不编一个数出来。 */
      if (r.hot_text) {
        add(li, h('span', { class: 'hot-value', text: r.hot_text }));
      }
      add(list, li);
    });
    add(card2, list);

    /* 底部：来源标注 + 一条「去核对」的出口。
       这是 PRD C4「每条内容都能核到原始出处」在热点这块的落实：
       来源写清楚（百度实时热搜），点任意一条能跳到原始搜索结果页。
       ⚠️ 「共 N 条」说的是**库里这一天一共多少条**，不是「显示了几个」——
       显示几个由上面那个「这次显示 N 条」的标记负责，两个数不能混。 */
    var foot = h('p', { class: 'hot-src' });
    add(foot, h('span', { text: (T.srcLabel || '') + (res.rows[0] ? res.rows[0].source_name : '') }));
    add(foot, h('span', { class: 'sep', text: '·' }));
    add(foot, h('span', { text: (T.totalLabel || '').replace('{n}', String(res.total || res.rows.length)) }));
    /* 清单明确要求「显示条数」这件事在页面上有交代 ——
       这里是全条目（没截断）还是被 limit 截过，一眼要能看出来。 */
    if (typeof limit === 'number' && res.total > limit) {
      add(foot, h('span', { class: 'sep', text: '·' }));
      add(foot, h('span', { text: (T.showLabel || '').replace('{n}', String(limit)) }));
    }
    add(card2, foot);

    add(box, card2);
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
