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
-- ③ 两张表都是「公开可读、客户端不许写」
--    —— 只建 SELECT 策略，**不建** INSERT / UPDATE / DELETE 策略：
--       前端不需要登录就能读（PRD 里「不做登录」这条不受影响），
--       而任何来自客户端的写入都会被数据库直接拒绝。内容只能由维护者用 SQL 录进来。
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
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
