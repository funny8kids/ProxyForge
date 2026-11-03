-- 0019 · 记录同步尝试次数，让「内容多久才换一次」变成可测的量
--
-- 起因是发现自己算错了一件事。
--
-- 上一轮给「把同步周期统一压到 15 分钟」找依据时，用的是
-- `scripts/diag-sync-cadence.mts` 的输出：**重复率 0%**，10 次快照 10 个不同
-- content_hash，于是结论是「列表一直在换血，我们是欠采样的，一小时只看到
-- 换血过程的 1/6」。
--
-- 这个结论建立在一个循环论证上。`syncSource` 在 content_hash 命中时
-- **不写快照行**（直接 return `duplicateSnapshot: true`），所以
-- `source_snapshots` 里按定义只会有互不相同的 hash ——
-- `distinct / snaps` 恒等于 1，重复率恒等于 0%。那个 0% 不是测量结果，
-- 是这个指标在这套数据模型下**不可能不为 0**。
--
-- 同一份逻辑还污染了「换血间隔」：既然每条落库的快照都和上一条不同，
-- 相邻 hash 的间隔就等于快照间隔，也就是同步周期本身。脚本报的
-- 「换血间隔」其实是「同步周期」，换一个数字重跑会得到同一个答案。
--
-- 现网的日志给出了反证：`同步 3 个源（成功 3）新增候选 0` 反复出现 ——
-- 内容**经常**没变，重复率远不是 0%。
--
-- 所以补两个计数器。分母（尝试次数）必须被记下来，比值才有意义：
--   · sync_attempts    每次**成功取到内容** +1（新内容与重复内容都算）
--   · duplicate_syncs  content_hash 命中、未写快照时 +1
--
-- 拉取失败不计入 sync_attempts：那属于"源可不可用"，不是"内容换得多快"。
-- 混进来会让重复率随源站抖动而变，两件事必须分开看。
--
-- 真实重复率 = duplicate_syncs / sync_attempts；
-- 真实的换血周期 ≈ 观察窗口 / (sync_attempts - duplicate_syncs)。
-- 有了这两个数，周期该定多少就是算出来的，不是我说出来的。
--
-- 两个计数器都是累计值，不清零。要看**近期**重复率就用差值：
-- 隔一段时间各取一次，相减 —— 比引入时间窗口表更简单，也不需要迁移旧数据。
-- 默认 0 对历史行是诚实的：我们确实不知道过去重复了多少次。

ALTER TABLE resource_sources
  ADD COLUMN IF NOT EXISTS sync_attempts  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS duplicate_syncs bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN resource_sources.sync_attempts IS
  '同步尝试次数（含内容未变的尝试）。重复率的分母。';
COMMENT ON COLUMN resource_sources.duplicate_syncs IS
  'content_hash 命中、未写快照的次数。重复率的分子。';
