-- db/schema.sql
-- 「大学生成长网站」云端数据库 —— 两张核心表的结构定义
-- 建立于 Day 16（2026-10-02）。
--
-- ============================================================
-- 【这两张表存什么 / 靠哪个字段关联】
--
--   sources   —— 内容的**出处**（一本书、一场演讲、一个准备收录的账号）
--   contents  —— 内容条目本身（内容库三列 ＋ 「今日一篇」）
--
--   关联字段：contents.source_id  →  sources.id
--   关系：**一个来源，对应多条内容**（一对多）
--
--   举例：来源「《原子习惯》」下面挂着 2 条内容；
--         来源「乔布斯 2005 斯坦福演讲」下面挂着 1 条内容。
--
-- ============================================================
-- 【三条设计决定，以及为什么】
--
-- ① contents.source_id 设成 NOT NULL
--    —— 这是 PRD 硬约束 C4「页面上出现的每一条内容，都必须能核到原始出处」的数据库版：
--       没有出处的条目，在数据库这一层就插不进来。
--       把约束写进表结构，比写在文档里管用 —— 文档靠自觉，结构靠报错。
--
-- ② 这两张表都**不碰用户数据**
--    —— 打卡、收藏仍然只存在用户自己浏览器的 localStorage 里，PRD 硬约束 C3 一个字都没改。
--       这两张表存的是「公开的、随时能再生成一份的内容」，不是「只有你才有的记录」。
--       这也正是今天敢开数据库的原因 —— 详见 .workbuddy/memory/2026-10-02.md。
--
-- ③ 两张表都「公开可读」；**客户端能不能写，两张表不一样**（Day 18 修订）
--    —— 原来这条写的是「两张表客户端都不许写」。Day 18 给 `contents`
--       开了一个**只允许新增**的口子（「内容库 → 新增一条」那张表单要能写进去）。
--       ⚠️ 开之前先把代价说清：这个项目不做登录，页面用的是**匿名身份**，
--       所以「能写」= **任何打开网页的人都能写一条**。
--       这是**知情之后才开的口子**，不是漏想 —— 详见 `docs/api-contract.md` 第三节。
--       · sources  —— 仍然只建 SELECT 策略，客户端一行都写不进去
--       · contents —— 多一条 INSERT 策略（**没有** UPDATE / DELETE）
--       · 两张表的 UPDATE / DELETE 依然全部关闭
--
-- ============================================================
-- 【怎么用这个文件】
--   它是一次性的建表脚本，可以在空库上原样重跑（全部带 IF NOT EXISTS / IF EXISTS）。
--   跑法：**逐条执行**。云数据库的接口一次只接受一条语句，多句会报
--   「cannot insert multiple commands into a prepared statement」。
-- ============================================================


-- ---------- 表 1：sources（内容的出处） ----------

CREATE TABLE IF NOT EXISTS sources (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL,
  platform    TEXT        NOT NULL,
  subject     TEXT,
  column_key  TEXT        NOT NULL,
  kind        TEXT        NOT NULL DEFAULT 'account',
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  sources            IS '内容的出处：准备收录的账号，以及页面上已用到的书 / 演讲 / 官方文件';
COMMENT ON COLUMN sources.id         IS '来源标识，小写英文，全站唯一；contents.source_id 引用的就是它';
COMMENT ON COLUMN sources.name       IS '来源名，如「韩秀云讲经济」「《原子习惯》」';
COMMENT ON COLUMN sources.platform   IS '平台：抖音 / 微信公众号 / 书籍 / 公开演讲 / 官方文件 等';
COMMENT ON COLUMN sources.subject    IS '主题，如「政策 · 经济 · 风口」';
COMMENT ON COLUMN sources.column_key IS '归到内容库哪一列：cognition / interview / policy';
COMMENT ON COLUMN sources.kind       IS '出处类型：account 账号 / book 书籍 / speech 演讲 / document 文件或笔记';
COMMENT ON COLUMN sources.note       IS '一句话备注';
COMMENT ON COLUMN sources.created_at IS '入库时间，默认当下';


-- ---------- 表 2：contents（内容条目） ----------

CREATE TABLE IF NOT EXISTS contents (
  id          TEXT        PRIMARY KEY,
  source_id   TEXT        NOT NULL REFERENCES sources(id),
  kind        TEXT        NOT NULL DEFAULT 'entry',
  title       TEXT        NOT NULL,
  tag         TEXT,
  media       TEXT        NOT NULL DEFAULT 'article',
  dur         TEXT,
  url         TEXT,
  summary     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 服务端留痕（Day 18 加）：这一行是从哪条通道写进来的。
  -- 默认值 current_user 由**数据库自己**填，前端改成别的值会被 INSERT 策略拒绝。
  created_via TEXT        DEFAULT current_user,
  -- 富字段（Day 18 加）：一个 jsonb，装「标题之外那些补充块」。
  -- ⚠️ 为什么用一个 jsonb，而不是拆成好几个固定列：
  --   三个栏目要存的东西**本来就不一样** ——
  --     认知：tagColor / origin
  --     访谈：tagColor / person / role / quote / steps[]
  --     政策：tagColor / origin / impact / skills[]
  --   拆成固定列的话，每一栏都会拖着一串用不上的空列；
  --   而且以后加一种栏目就得动表结构。jsonb 是「缺哪个键就不写」，正合适。
  detail      JSONB
);

COMMENT ON TABLE  contents            IS '内容条目：内容库三列（kind=entry）＋「今日一篇」（kind=read）';
COMMENT ON COLUMN contents.id         IS '内容标识，小写英文，全站唯一';
COMMENT ON COLUMN contents.source_id  IS '★关联字段★ 指向 sources.id —— 一个来源对应多条内容';
COMMENT ON COLUMN contents.kind       IS '条目归属：entry 内容库三列 / read 今日一篇';
COMMENT ON COLUMN contents.title      IS '标题';
COMMENT ON COLUMN contents.tag        IS '分类标签，一个词';
COMMENT ON COLUMN contents.media      IS '形态：video 视频 / article 文章 / podcast 播客 / talk 长访谈';
COMMENT ON COLUMN contents.dur        IS '大概多久看完，如「约 8 分钟」；没有就不写';
COMMENT ON COLUMN contents.url        IS '原链接。真实收录开始前故意留空 —— 编一个网址比没有网址更糟（PRD C4）';
COMMENT ON COLUMN contents.summary    IS '本站提炼的摘要，不是原文';
COMMENT ON COLUMN contents.created_at IS '入库时间，默认当下';
COMMENT ON COLUMN contents.created_via IS '服务端留痕（Day 18 加）：这一行是从哪条通道写进来的。匿名网页 = anon；维护者通道 = 管理员角色名。由数据库自己填，前端改成别的值会被 INSERT 策略拒绝';
COMMENT ON COLUMN contents.detail     IS '富字段（Day 18 加，三列榜单用）。按栏目不同：认知存 tagColor/origin；访谈存 tagColor/person/role/quote/steps；政策存 tagColor/origin/impact/skills。缺哪个键就不写。云端原本只存标题/标签/形态/时长/摘要，这几样是后补的（见本文件 Day 18 段 ⑤）';


-- ---------- 安全边界：公开可读，客户端不许写 ----------
-- 注意顺序：先建表、再开 RLS、最后才灌种子数据。
-- 反过来的话（先有数据再开 RLS）会把已有数据锁在外面。

ALTER TABLE sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE contents ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.sources  TO authenticated, anon;
GRANT SELECT ON TABLE public.contents TO authenticated, anon;

DROP POLICY IF EXISTS sources_read_all ON sources;
CREATE POLICY sources_read_all ON sources FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS contents_read_all ON contents;
CREATE POLICY contents_read_all ON contents FOR SELECT TO authenticated, anon USING (true);


-- ============================================================
-- 【Day 18 加】给 contents 开一个「只允许新增」的口子
-- ============================================================
--
-- 为什么开：页面上多了一张「内容库 → 新增一条」的小表单（见 docs/api-contract.md），
-- 它要让匿名网页能往这张表里写。这是全项目**第一次**让网页有写权限。
--
-- 为什么只开 INSERT：能写已经是有代价的（没登录，谁都能写），
-- 那就把门开到**刚好够用**为止 —— 能加不能改、也不能删。
-- 「谁能改、谁能删」那两扇门照旧关着（第 4 周做 PATCH / DELETE 时再单独议）。
--
-- ⚠️ 这里每一条都要能**重复跑**（这个文件本来就是「空库上能原样重跑」的），
-- 所以 ALTER 那两条写成「先 DROP IF EXISTS 再 ADD」，而不是直接 ADD。

-- ① 同一来源下标题不许重复 —— 这是「重复提交被拒」的**最终防线**。
--    页面提交前会先查一次（为了给一句准的中文提示），但那次拦不住并发；
--    真撞上了，靠的是这条唯一约束（数据库回 23505）。
ALTER TABLE contents DROP CONSTRAINT IF EXISTS contents_source_title_key;
ALTER TABLE contents ADD CONSTRAINT contents_source_title_key UNIQUE (source_id, title);

-- ② 列（Day 18 的服务端留痕）。IF NOT EXISTS 保证重复跑不报错。
ALTER TABLE contents ADD COLUMN IF NOT EXISTS created_via TEXT;
ALTER TABLE contents ALTER COLUMN created_via SET DEFAULT current_user;

-- ③ 门一：表级权限。原来 anon 只有 SELECT，这里补上 INSERT。
--    ⚠️ 只补 INSERT —— UPDATE / DELETE 一个字都不给。
GRANT INSERT ON TABLE public.contents TO anon;

-- ④ 门二：行级策略。这两道门缺一不可（漏了 GRANT 会得到形似策略失效的 42501）。
DROP POLICY IF EXISTS contents_insert_guard ON contents;
CREATE POLICY contents_insert_guard ON contents FOR INSERT TO anon, authenticated
  WITH CHECK (
    -- 只能往「内容库三列」那一类里写（kind='read' 是「今日一篇」，另一套逻辑，不许从页面加）
    kind = 'entry'
    AND source_id IS NOT NULL
    -- 长度跟 config.js 的 entry.titleMax / summaryMax 对齐，两边必须一致
    AND char_length(btrim(title)) BETWEEN 1 AND 60
    AND char_length(COALESCE(summary, '')) <= 200
    -- 形态只能是 config.js 里那四种
    AND media IN ('video', 'article', 'podcast', 'talk')
    -- ★ 服务端留痕不许伪造：只认数据库自己填的那个值。
    --   前端要是指定一个别的（比如假装自己是管理员），这一行直接进不来。
    AND created_via = current_user
  );

-- ⑤ 列：富字段（跟「内容库三列改读云端」一起加的）。
--    ⚠️ 为什么需要它：云端原来只存了 标题 / 标签 / 形态 / 时长 / 摘要，
--    而本地榜单里还躺着「金句」「3 个行动点」「对大学生的启示」「相关技能」——
--    照直切去读云端，这四样会**当场消失**。
--    所以顺序是「**先把云端补齐，再切去读云端**」，不是先切换再说。
ALTER TABLE contents ADD COLUMN IF NOT EXISTS detail JSONB;

-- ⑥ 把本地那 12 条（kind='entry'）的富字段搬进 detail。
--    ⚠️ 这一段是**一次性数据迁移**，只为补齐老内容。
--    以后从页面表单加的内容没有这些字段（表单只收标题 / 来源 / 形态 / 摘要），
--    detail 留空是**正常**的 —— 页面上会跳过那几行，不会留个空壳（见 app.js 的 renderEntry）。
--    ⚠️ 这里用 jsonb_build_object 而不是手写 JSON 字符串：
--    手写的话字符串里要塞一堆双引号，转义错一个字整条 SQL 就废了。
UPDATE contents AS c SET detail = v.d
FROM (VALUES
  ('entry-goal-vs-system',               jsonb_build_object('tagColor','blue','origin','《原子习惯》')),
  ('entry-delayed-gratification',        jsonb_build_object('tagColor','cyan','origin','公开演讲')),
  ('entry-three-things',                 jsonb_build_object('tagColor','violet','origin','《精要主义》')),
  ('entry-break-down',                   jsonb_build_object('tagColor','green','origin','读书笔记')),
  ('entry-phone-away',                   jsonb_build_object('tagColor','amber','origin','《深度工作》')),
  ('entry-zhangyiming-delay',            jsonb_build_object('tagColor','amber','person','张一鸣','role','字节跳动创始人',
                                     'quote','很多人二十多岁的时候，就已经把一辈子的选择做完了。',
                                     'steps', jsonb_build_array('把一个「想要但很急」的念头写下来，放 7 天再看','选一件「短期没反馈」的事，坚持 3 个月再看结果','每次想放弃时，记下原因——那是你真实的软肋清单'))),
  ('entry-leijun-fengkou',               jsonb_build_object('tagColor','blue','person','雷军','role','小米创始人',
                                     'quote','不要用战术上的勤奋，掩盖战略上的懒惰。',
                                     'steps', jsonb_build_array('每周花 30 分钟只看趋势，不看八卦','把你所在行业近 3 年的变化写成三句话','找一件「就算失败也值得做」的事先干起来'))),
  ('entry-huangzheng-benfen',            jsonb_build_object('tagColor','violet','person','黄峥','role','拼多多创始人',
                                     'quote','本分就是做好自己该做的事，而不是去抢别人的事。',
                                     'steps', jsonb_build_array('写下你当前身份最该做的一件正事','这周主动拒掉一件「不属于你」的事','月底回头看：你的时间花在哪了'))),
  ('entry-policy-ai-industry',           jsonb_build_object('tagColor','green','origin','官方文件','impact','会用 AI 工具已经成为像会用 Office 一样的基础项，而不是加分项','skills', jsonb_build_array('提示词工程','数据分析','AI 工具实操'))),
  ('entry-policy-digital-economy',       jsonb_build_object('tagColor','blue','origin','官方文件','impact','纯文科技能要配一门数据能力才更抗跌','skills', jsonb_build_array('SQL','Excel 建模','行业数据解读'))),
  ('entry-policy-graduate-jobs',         jsonb_build_object('tagColor','amber','origin','官方文件','impact','求职时别只盯大厂，看清政策倾斜的方向能多一条路','skills', jsonb_build_array('政策解读','简历匹配','面试表达'))),
  ('entry-policy-manufacturing-digital', jsonb_build_object('tagColor','violet','origin','官方文件','impact','工科背景的同学，叠加编程能力会明显更吃香','skills', jsonb_build_array('Python','自动化控制','工业软件')))
) AS v(id, d)
WHERE c.id = v.id;

-- 校验改动有没有生效（这几条都应该有结果）：
--   SELECT conname FROM pg_constraint WHERE conrelid = 'public.contents'::regclass;
--     → contents_pkey / contents_source_id_fkey / contents_source_title_key
--   SELECT name, cmd FROM pg_policies WHERE tablename = 'contents';
--     → contents_read_all(SELECT) / contents_insert_guard(INSERT)
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'contents' AND grantee IN ('anon','authenticated');
--     → anon 只有 INSERT / SELECT（**没有** UPDATE/DELETE）
--   SELECT column_name, column_default FROM information_schema.columns
--     WHERE table_name = 'contents' AND column_name = 'created_via';
--     → 默认值 = current_user
--   SELECT count(*) FILTER (WHERE detail IS NOT NULL) FROM contents WHERE kind = 'entry';
--     → 12（本地那 12 条的富字段已经搬进云端；从页面表单加的那条没有 detail，是正常的）
