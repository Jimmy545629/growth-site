-- db/seed.sql
-- 「大学生成长网站」云端数据库 —— 种子数据
-- 建立于 Day 16（2026-10-02）。
--
-- ============================================================
-- 【这个文件干什么】
--   把两张表的初始数据灌进去，让表里有东西可查。
--   数据来源：项目里 assets/data.js 已经在用的那批内容（三列榜单 12 条 + 今日一篇 8 篇），
--   以及 PRD 第 9 节定下来的收录来源。
--
-- ============================================================
-- 【⚠️ 两条必须知道的规矩】
--
-- ① 这个文件**可以反复执行，不会报错、也不会插重复**。
--    做法是每条 INSERT 后面都跟 ON CONFLICT (id) DO UPDATE：
--    第一次执行是「插入」，第二次执行变成「拿同样的内容覆盖一遍」——
--    结果一样，所以叫「幂等」（同样的操作做几次，结果都一样）。
--    为什么必须这样：种子脚本经常要重跑（改了一行数据、换台电脑重建库），
--    如果第二次执行就报「主键重复」，那这个脚本就废了。
--
-- ② 这里的数据**全部来自 data.js，没有一条是现编的**。
--    PRD 硬约束 C4：页面上出现的每一条内容都必须能核到原始出处。
--    所以 url 字段**一律留空字符串**，不编网址 ——
--    编一个网址挂上去，比留空更糟。
--
-- ============================================================
-- 【怎么跑】
--   逐条执行（云数据库接口一次只吃一条语句）：
--     第 1 条 → sources 的 18 条来源
--     第 2 条 → contents 的前 10 条
--     第 3 条 → contents 的后 10 条
--   ⚠️ 顺序不能反：contents.source_id 是外键，来源必须先存在。
-- ============================================================


-- ---------- 第 1 条：18 个来源 ----------
-- 分三类：准备收录的账号（4 个）、内容实际用到的出处（14 个）。
-- ⚠️ 前 4 个账号目前**下面一条内容都没有** —— 这是如实反映现状（PRD 9.1：还没开始收录），
--    不是漏灌数据。等真的收录了，再往 contents 里插它们的内容。

INSERT INTO sources (id, name, platform, subject, column_key, kind, note) VALUES
  ('douyin-hanxiuyun',          '韩秀云讲经济',   '抖音',       '政策 · 经济 · 风口', 'policy',    'account',  '计划收录来源：经济学者讲政策与产业方向'),
  ('douyin-xiaoyan',            '学丞晓艳老师',   '抖音',       '认知 · 自律',        'cognition', 'account',  '计划收录来源：学习方法与自律习惯'),
  ('douyin-shisanyao',          '十三邀',         '抖音',       '名人访谈',           'interview', 'account',  '计划收录来源：人物深度访谈节目'),
  ('wechat-cctvnews',           '央视新闻',       '微信公众号', '政策 · 经济 · 风口', 'policy',    'account',  '计划收录来源：官方新闻号，用作政策原文的权威出处；形态是「文章」'),
  ('book-atomic-habits',        '《原子习惯》',   '书籍',       '认知 · 自律',        'cognition', 'book',     '詹姆斯·克利尔'),
  ('book-deep-work',            '《深度工作》',   '书籍',       '认知 · 自律',        'cognition', 'book',     '卡尔·纽波特'),
  ('book-essentialism',         '《精要主义》',   '书籍',       '认知 · 自律',        'cognition', 'book',     '格雷戈·麦吉沃恩'),
  ('book-effective-executive',  '《卓有成效的管理者》', '书籍', '认知 · 自律',        'cognition', 'book',     '彼得·德鲁克'),
  ('book-almanack-naval',       '《纳瓦尔宝典》', '书籍',       '认知 · 自律',        'cognition', 'book',     '纳瓦尔·拉维坎特'),
  ('speech-jobs-2005',          '乔布斯 2005 年斯坦福大学毕业典礼演讲', '公开演讲', '名人访谈', 'interview', 'speech', '史蒂夫·乔布斯'),
  ('speech-rowling-2008',       '罗琳 2008 年哈佛大学毕业典礼演讲',     '公开演讲', '名人访谈', 'interview', 'speech', 'J.K.罗琳'),
  ('speech-munger-1994',        '芒格 1994 年 USC 马歇尔商学院演讲',    '公开演讲', '名人访谈', 'interview', 'speech', '查理·芒格'),
  ('interview-zhangyiming',     '张一鸣访谈',     '公开访谈',   '名人访谈',           'interview', 'speech',   '字节跳动创始人'),
  ('interview-leijun',          '雷军访谈',       '公开访谈',   '名人访谈',           'interview', 'speech',   '小米创始人'),
  ('interview-huangzheng',      '黄峥访谈',       '公开访谈',   '名人访谈',           'interview', 'speech',   '拼多多创始人'),
  ('doc-official-policy',       '官方政策文件',   '官方文件',   '政策 · 经济 · 风口', 'policy',    'document', '政策类条目的出处；页面只做简报并要求点开官方原文'),
  ('note-reading-notes',        '读书笔记',       '读书笔记',   '认知 · 自律',        'cognition', 'document', '整理自公开出版物'),
  ('talk-public',               '公开演讲（未标注具体场次）', '公开演讲', '认知 · 自律', 'cognition', 'speech', '示例内容里出处未细化的一条，如实标注')
ON CONFLICT (id) DO UPDATE SET
  name       = EXCLUDED.name,
  platform   = EXCLUDED.platform,
  subject    = EXCLUDED.subject,
  column_key = EXCLUDED.column_key,
  kind       = EXCLUDED.kind,
  note       = EXCLUDED.note;


-- ---------- 第 2 条：contents 前 10 条（内容库三列） ----------
-- kind = 'entry' 表示这是「内容库」三列里的条目。
-- 注意 source_id 那一列 —— 它就是关联字段，指向上面 sources 表的 id。

INSERT INTO contents (id, source_id, kind, title, tag, media, dur, url, summary) VALUES
  ('entry-goal-vs-system', 'book-atomic-habits', 'entry',
   '为什么「定目标」几乎总是失败：目标给你方向，系统给你结果', '习惯养成', 'article', '约 6 分钟', '',
   '目标决定你去哪，流程决定你能不能到。真正管用的改法是动流程，不是加决心。'),

  ('entry-delayed-gratification', 'talk-public', 'entry',
   '延迟满足不是忍耐，而是把「现在的我」和「以后的我」看成同一个人', '决策', 'video', '约 18 分钟', '',
   '你之所以会冲动消费、刷到凌晨，是因为大脑把「以后的我」当成了陌生人。'),

  ('entry-three-things', 'book-essentialism', 'entry',
   '每天只做三件事：把事情减到能做完为止，比排满更重要', '时间管理', 'article', '约 5 分钟', '',
   '排满的清单只会让你天天失败。留白不是偷懒，是给意外和复盘留位置。'),

  ('entry-break-down', 'note-reading-notes', 'entry',
   '「学不会」多半不是笨，是没把它拆到足够小', '学习方法', 'article', '约 4 分钟', '',
   '拆到「下一步具体做什么」清楚为止，卡住的地方往往就是没拆开的地方。'),

  ('entry-phone-away', 'book-deep-work', 'entry',
   '把手机放到另一个房间，比任何「专注 App」都管用', '专注力', 'podcast', '约 35 分钟', '',
   '靠意志力对抗放在手边的手机，是一场必输的仗。改环境比改自己容易。'),

  ('entry-zhangyiming-delay', 'interview-zhangyiming', 'entry',
   '关于「延迟满足」：真正的差距在别人看不见的那几年', '成长心态', 'talk', '约 25 分钟', '',
   '他把「延迟满足感」看作一个人最底层的能力：愿不愿意为了更远的东西，放弃眼前看得见的那点好处。'),

  ('entry-leijun-fengkou', 'interview-leijun', 'entry',
   '关于「风口与勤奋」：站在风口上，猪都能飞', '趋势判断', 'talk', '约 22 分钟', '',
   '他这句话常被误解成「不用努力」。他真正的意思是：努力是门票，方向决定你努力的天花板。'),

  ('entry-huangzheng-benfen', 'interview-huangzheng', 'entry',
   '关于「本分」：做对的事，而不是容易的事', '价值观', 'talk', '约 30 分钟', '',
   '他讲「本分」不是老实，而是：先搞清楚自己该做什么，再去做，而不是别人做什么我就做什么。'),

  ('entry-policy-ai-industry', 'doc-official-policy', 'entry',
   '人工智能被明确列为重点发展的战略性新兴产业与新增长引擎', '产业方向', 'article', '约 5 分钟', '',
   'AI 从「可选项」变成「基础设施」，各行各业都要接。'),

  ('entry-policy-digital-economy', 'doc-official-policy', 'entry',
   '数字经济占 GDP 比重持续提升，传统行业数字化转型加速', '经济方向', 'article', '约 4 分钟', '',
   '增长的岗位在「懂业务 + 懂数据」的交叉地带。')
ON CONFLICT (id) DO UPDATE SET
  source_id = EXCLUDED.source_id,
  kind      = EXCLUDED.kind,
  title     = EXCLUDED.title,
  tag       = EXCLUDED.tag,
  media     = EXCLUDED.media,
  dur       = EXCLUDED.dur,
  url       = EXCLUDED.url,
  summary   = EXCLUDED.summary;


-- ---------- 第 3 条：contents 后 10 条（三列收尾 2 条 + 今日一篇 8 条） ----------
-- kind = 'read' 表示这是「今日一篇」里的一天一推。

INSERT INTO contents (id, source_id, kind, title, tag, media, dur, url, summary) VALUES
  ('entry-policy-graduate-jobs', 'doc-official-policy', 'entry',
   '高校毕业生就业促进措施持续加码，基层与新兴领域岗位扩容', '就业政策', 'article', '约 6 分钟', '',
   '政策性岗位和新兴行业岗位都在扩。'),

  ('entry-policy-manufacturing-digital', 'doc-official-policy', 'entry',
   '制造业数字化转型推进，工业软件与自动化人才缺口明显', '行业风口', 'article', '约 4 分钟', '',
   '「软硬结合」的岗位比纯软件更难被替代。'),

  ('jobs-stanford-2005', 'speech-jobs-2005', 'read',
   '把生命中的点连起来', '人生选择', 'video', '约 15 分钟', '',
   '这场演讲被引用了二十年，真正撑住它的是三个故事：退学之后去旁听书法课、被自己创办的公司开除、以及确诊癌症。三个故事其实在讲同一件事 —— 你在当下根本看不出某件事有什么用，只有回头看，那些点才连成一条线。'),

  ('rowling-harvard-2008', 'speech-rowling-2008', 'read',
   '失败的益处', '失败与韧性', 'video', '约 20 分钟', '',
   '她不讲「要坚持」，而是把两件常被混为一谈的事分开：贫穷是一种真实的限制，而失败不是 —— 失败只是把你身上那些不重要的东西剥掉，让你看清自己还剩什么。她也不把想象力说成「创造力」，而是「体谅别人处境的能力」。'),

  ('munger-usc-1994', 'speech-munger-1994', 'read',
   '普世智慧：为什么「拿着一把锤子，看什么都是钉子」', '思维模型', 'talk', '约 50 分钟', '',
   '他讲的「多元思维模型」不是让人什么都学一点，而是：手上要有好几把不同学科的工具，遇到问题时知道该拿哪一把。只有一把锤子的人，会把所有问题都看成钉子 —— 而且他自己察觉不到这一点。'),

  ('deep-work-natural', 'book-deep-work', 'read',
   '为什么「能连续专注两小时」正在变成稀缺能力', '专注力', 'article', '约 9 分钟', '',
   '这本书的论证其实很朴素：在一个人人都被打断的环境里，「能长时间不被打断地做一件事」本身就成了一种别人买不到的能力。剩下的问题是 —— 这种能力是练出来的，不是天生的，而大部分人的一天被切得太碎了。'),

  ('atomic-habits-identity', 'book-atomic-habits', 'read',
   '从「我要减肥」到「我是个运动的人」：习惯的根在身份，不在意志力', '习惯养成', 'article', '约 8 分钟', '',
   '它把「养成习惯」拆成三层：结果、过程、身份。大多数人从「我要瘦十斤」出发，所以每次没达标就自我否定；更稳的做法是从「我是个什么样的人」出发，让每一次小动作都是在给这个身份投票。'),

  ('drucker-effectiveness', 'book-effective-executive', 'read',
   '效能优先于效率：知识工作者的第一课', '时间管理', 'article', '约 8 分钟', '',
   '德鲁克把「效率」和「效能」分开，是这本书最值钱的一刀：效率是把事情做对，效能是做对的事情。很多人卡住不是因为不够努力，而是把一件根本不该做的事做得非常漂亮。'),

  ('naval-leverage', 'book-almanack-naval', 'read',
   '专长与杠杆：为什么「努力」本身不值钱', '财富与杠杆', 'podcast', '约 45 分钟', '',
   '他的核心说法是：努力本身是可以被替代的，值钱的是「你独有的专长」加上「杠杆」。杠杆有几种 —— 人、资本、以及「代码和媒体」这种复制成本几乎为零的东西。最后一种对没有资源的人最友好，因为它不需要谁批准你。'),

  ('policy-ai-talent', 'doc-official-policy', 'read',
   '人工智能被列为战略性新兴产业：这条政策对在校生意味着什么', '政策解读', 'article', '约 6 分钟', '',
   '政策把 AI 从「一个值得关注的行业」提升到了「基础设施」的位置。对还在读书的人来说，它影响的不是「要不要学 AI」，而是「会不会用 AI 做事」这件事，正在从加分项变成基础项 —— 就像当年的 Office。')
ON CONFLICT (id) DO UPDATE SET
  source_id = EXCLUDED.source_id,
  kind      = EXCLUDED.kind,
  title     = EXCLUDED.title,
  tag       = EXCLUDED.tag,
  media     = EXCLUDED.media,
  dur       = EXCLUDED.dur,
  url       = EXCLUDED.url,
  summary   = EXCLUDED.summary;
