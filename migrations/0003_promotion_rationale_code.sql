-- =============================================================================
-- 0003 · 晋升建议的理由结构化为 code + params
-- -----------------------------------------------------------------------------
-- 问题：promotion_suggestions.rationale 是一段自然语言，被界面原样渲染。
--       它是**数据**（AI 生成），不参与前端 i18n，于是：
--         · 数据是英文 → 中文界面里漏出一整段英文；
--         · 数据是中文 → 英文界面里漏出一整段中文。
--       两边都不对。界面语言是用户偏好，不该由生成时刻的语言决定。
--
-- 变更性质：**扩展**（新增可空列 + 带默认值的 jsonb），不破坏既有行。
-- 兼容：rationale_code 为 NULL 时界面回退到 rationale 原文 ——
--       外部 LLM 产出的自由文本仍然能正常显示，只是不保证与界面语言一致。
-- =============================================================================

ALTER TABLE promotion_suggestions
    ADD COLUMN IF NOT EXISTS rationale_code   text,
    ADD COLUMN IF NOT EXISTS rationale_params jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN promotion_suggestions.rationale_code IS
    '理由的机器可读码，界面按当前语言渲染；为 NULL 时回退到 rationale 原文';
COMMENT ON COLUMN promotion_suggestions.rationale_params IS
    'rationale_code 的插值参数，例如 {"days": 12}';
