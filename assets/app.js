/* app.js —— 首页的渲染与交互。
   ============================================================
   分工（照老项目那套规矩，管用）：
     data.js  → 只有内容，不碰页面
     app.js   → 只负责「把内容画到页面上」+「收用户的点击」
   要改文字 → 只动 data.js；要改样子 → 只动 style.css；这里只在改结构时才动。

   一条铁律：**文字只用 textContent 写**，绝不拼 innerHTML。
   内容里只要有个 < > 或 & 符号，拼 HTML 就会让整页错乱。
   ============================================================ */

(function () {
  'use strict';

  var D = window.GROWTH_DATA;

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
    document.getElementById('streak-days').textContent = String(D.meta.streakDays);
  }

  /* ============================================================
     二、三张统计卡
     ============================================================ */
  function renderStats() {
    var box = document.getElementById('stats');
    clear(box);
    var accents = ['var(--brand)', 'var(--warm)', 'var(--ok)'];

    D.stats.forEach(function (s, i) {
      var card = h('article', { class: 'stat', style: { '--accent': accents[i % accents.length] } });
      add(card, h('p', { class: 'stat-label', text: s.label }));
      add(card, h('p', { class: 'stat-value' },
        s.value,
        h('small', { text: ' ' + s.unit })));
      add(card, h('p', { class: 'stat-note', text: s.note }));
      add(box, card);
    });
  }

  /* ============================================================
     三、今日语录卡（可以「换一句」）
     ============================================================ */
  var quoteIndex = 0;
  var quoteSaved = {};

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

    var btnSave = h('button', {
      class: 'btn', type: 'button', id: 'btn-save',
      text: quoteSaved[quoteIndex] ? '已收藏' : '收藏'
    });
    btnSave.addEventListener('click', function () {
      quoteSaved[quoteIndex] = !quoteSaved[quoteIndex];
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
     四、今日自律行动卡（可以勾选）
     ============================================================ */
  function renderActions() {
    var box = document.getElementById('action-card');
    clear(box);

    add(box, h('h2', { class: 'action-title', text: '今日自律行动' }));
    add(box, h('p', { class: 'action-sub', text: '点一下就算完成，不用登录、不留痕迹' }));

    var ul = h('ul', { class: 'action-list' });

    D.actions.forEach(function (a, i) {
      var li = h('li', {
        class: 'action-item' + (a.done ? ' is-done' : ''),
        role: 'button', tabindex: '0',
        'aria-pressed': a.done ? 'true' : 'false'
      });
      add(li, h('span', { class: 'action-box', text: '✓' }));
      add(li, h('span', { class: 'action-text' },
        a.text,
        h('span', { class: 'action-hint', text: a.hint })));

      function toggle() {
        D.actions[i].done = !D.actions[i].done;
        renderActions();
      }
      li.addEventListener('click', toggle);
      li.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });

      add(ul, li);
    });

    add(box, ul);

    var done = D.actions.filter(function (a) { return a.done; }).length;
    add(box, h('p', { class: 'action-progress' },
      '今天已完成 ', h('b', { text: done + ' / ' + D.actions.length }),
      done === D.actions.length ? ' —— 全部完成，明天见。' : ' —— 别断在这儿。'));
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
