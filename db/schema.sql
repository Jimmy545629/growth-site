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
  created_via TEXT        DEFAULT current_user
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

-- 校验改动有没有生效（这四条都应该有结果）：
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
