# UI-001 · Design System

> 适用范围：`prototype/index.html` 及后续 React 实现
> 版本：v2.0 · 与原型同步维护
> 定位：**Network Resource Control Plane**，不是 IP 管理后台
> 视觉方向：**Dark Intelligence Infrastructure** —— 精密控制台 + 数据可视化

---

## 1. 设计原则

| 原则 | 含义 | 反例 |
| --- | --- | --- |
| 减容器，加数字 | 用背景分层代替边框，把空间让给数据 | 每个模块一张带边框的白卡 |
| 一个主色，一个数据色 | 紫色只做品牌与交互，青色只做网络状态与数据 | 紫、蓝、青同时当主色 |
| 状态即语义 | 颜色只表达状态，不表达装饰 | 为了"好看"给健康项加渐变 |
| 沉默的默认态 | 正常的东西不抢注意力，异常才发光 | 全站 40 个徽章都在闪 |
| 控制面可信 | 任何界面元素都要能对应到一条后端规则 | 装饰性假图表、假指标 |
| 明度差优于描边 | 表面之间靠 2–3% 的明度差分层，边框只是补充 | 靠 1px 亮边框分割所有区域 |
| 克制优先于科技感 | 发光、渐变、玻璃拟态只在关键交互点出现一次 | 给所有元素加 glow |

**一句话**：这个产品的视觉价值来自「克制 + 密度 + 精确」，不来自发光和渐变。

---

## 2. 色彩系统

### 2.1 表面层级（深色为基准）

| Token | 深色 | 浅色 | 用途 |
| --- | --- | --- | --- |
| `--bg` | `#080B12` | `#F4F6FA` | 应用底色（叠 64px 网格纹理） |
| `--sidebar` | `#0D121D` | `#FFFFFF` | 侧边栏，比底色深一档 |
| `--surface` | `#121A29` | `#FFFFFF` | 面板基色 |
| `--elev` | `#182337` | `#FFFFFF` | 浮层、抽屉、命令面板 |
| `--panel-a` / `--panel-b` | `#121A29` / `#0F1626` | `#FFFFFF` / `#FBFCFE` | 面板纵向渐变两端 |
| `--line` | `rgba(255,255,255,.08)` | `rgba(15,23,42,.09)` | 行分隔线 |
| `--line-2` | `rgba(255,255,255,.11)` | `rgba(15,23,42,.15)` | 需要更强分隔时 |

### 2.2 叠加层：双主题的翻转机制

不写两套组件样式，只写一套**叠加层**，靠主题翻转方向：

```css
:root{                    /* 深色：叠加白色 */
  --ov-1:rgba(255,255,255,.022);
  --ov-2:rgba(255,255,255,.042);
  --ov-3:rgba(255,255,255,.058);
  --ov-4:rgba(255,255,255,.08);
  --ov-5:rgba(255,255,255,.11);
  --ov-6:rgba(255,255,255,.26);
  --line:var(--ov-4);
}
[data-theme="light"]{     /* 浅色：叠加黑色 */
  --ov-1:rgba(15,23,42,.025);
  --ov-2:rgba(15,23,42,.042);
  --ov-3:rgba(15,23,42,.058);
  --ov-4:rgba(15,23,42,.08);
  --ov-5:rgba(15,23,42,.1);
  --ov-6:rgba(15,23,42,.26);
  --line:rgba(15,23,42,.09);
}
```

所有半透明层（悬停底、分隔线、次要底色）一律引用 `--ov-*`，不写死 `rgba(255,255,255,…)`。这样新增一个主题只需要重定义 ~40 个 token。

> **坑**：`--ov-1:var(--ov-1)` 这种自引用是合法的 CSS，但会让令牌在计算期失效且不报错，表现为整站边框消失。批量替换令牌后必须跑一次自引用扫描。

### 2.3 文本层

| Token | 深色 | 浅色 | 用途 | 最小字号 |
| --- | --- | --- | --- | --- |
| `--text` | `#E8EDF7` | `#0E1526` | 主文本、数值 | 12px |
| `--text-2` | `#9AA5B8` | `#46536A` | 次要文本、说明 | 12px |
| `--text-3` | `#697386` | `#6B7789` | 辅助、占位 | **不低于 12px** |
| `--text-4` | `#4A5464` | `#98A2B3` | 极弱（分隔符、禁用） | 仅非阅读性 |

> 辅助信息不得低于 12px。原型中 9.5–11px 仅用于图表刻度（非阅读性文本）。

### 2.4 角色色（严格分工，不可互换）

| 角色 | Token | 深色 | 浅色 | 只允许用于 |
| --- | --- | --- | --- | --- |
| 品牌 / 交互 | `--violet` | `#8B7CFF` | `#6A5AF0` | 主按钮、选中态、当前节点、品牌 mark |
| 网络数据 | `--cyan` | `#36D6C3` | `#0C9C90` | 折线、热力图、吞吐、Verified 徽章 |
| 成功 | `--success` | `#36C99A` | `#0E9E74` | Healthy / Applied / pass |
| 警告 | `--warn` | `#E6AD61` | `#B4781F` | Degraded / Tight / 预算接近上限 |
| 危险 | `--danger` | `#F07885` | `#D2455A` | Quarantined / Failed / PUBLIC 徽章 |

每个角色色配三档：`--x`（主）、`--x-2`（浅，用于文本）、`--x-bg`（12% 透明，用于徽章底）。

**低透明度色晕统一用 `color-mix`，不写死 rgba**：

```css
/* ✅ 跟随主题 */
background:color-mix(in srgb,var(--danger) 12%,transparent);
/* ❌ 浅色主题下仍是亮粉 */
background:rgba(240,120,133,.12);
```

**硬约束**

- 紫 / 蓝 / 青**不可同时**作为主色。本项目没有蓝色角色。
- 紫色不得用于表达"健康"或"成功"，那会污染品牌语义。
- 青色不得用于按钮，它属于数据域。
- 危险色不得用于"强调"，只在真的出错时出现。
- **吞吐、流量、延迟一律青色**。曾经把吞吐折线画成紫色，属于语义违规。

---

## 3. 字体与字号

```css
--sans: "Inter","Geist",-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
--mono: "JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;
```

`font-feature-settings: "cv02","cv03","cv04","ss01"` — 打开 Inter 的单层 a/g 与斜线零，让 IP、端口、hash 更易分辨。

| 层级 | 字号 | 字重 | 字距 | 用途 |
| --- | --- | --- | --- | --- |
| 页面标题 | 24px | 560 | -0.03em | `h1.t-title` |
| 模块标题 | 15px | 540 | -0.01em | `h2.t-module` |
| 核心指标 | 30–34px | 560 | -0.035em | `.metric-value` |
| 遥测数值 | 23px | 560 | -0.035em | `.tele .t-v b` |
| 正文 / 表格 | 13px | 400 | 0 | 表格单元格 |
| 表格次要 | 11–12px | 400 | 0 | 地址、时间戳 |
| 标签 | 10.5px | 500 | 0.13em 大写 | `.metric-label`、`.sect-label` |
| 等宽数据 | 11–12px | 400 | 0 | IP、端口、hash、Token |

**规则**：所有数字用 `font-variant-numeric: tabular-nums`，否则刷新时数字会横向跳动。

**中英混排**：中文界面下不要给中文加 `letter-spacing`，只保留给全大写英文标签。中文标题用 `-0.01em` 而非 `-0.03em`，否则字挤在一起。

---

## 4. 空间与形状

| Token | 值 | 用途 |
| --- | --- | --- |
| 间距基数 | 4px | 所有间距为 4 的倍数 |
| 卡片内边距 | 16–20px | `.panel-head` / `.panel-body` |
| 网格间距 | 16px | `.grid{gap:16px}` |
| `--r-xs` | 6px | 徽章、筛选片 |
| `--r-sm` | 8px | 按钮、输入框 |
| `--r` | 12px | 面板 |
| `--r-lg` | 16px | 抽屉、浮层 |

**阴影只用于浮层**（抽屉、Toast、命令面板）。平面卡片用 `inset 0 1px 0 var(--ov-3)` 模拟顶部高光，而不是外阴影。

```css
.panel{
  background:linear-gradient(180deg,var(--panel-a) 0%,var(--panel-b) 100%);
  border-radius:var(--r-lg);
  box-shadow:var(--panel-shadow),0 0 0 1px var(--panel-border);
}
/* 浅色主题换成真实投影，靠白色卡片 + 轻投影建立层级 */
[data-theme="light"]{
  --panel-shadow:0 1px 2px rgba(16,24,40,.04),0 2px 6px -2px rgba(16,24,40,.08);
  --panel-border:rgba(15,23,42,.07);
}
```

### 4.1 背景纹理

底色叠一层 64px 网格，`--grid-line` 深色 `.02` 白 / 浅色 `.04` 黑。它只建立"这是一张工程图纸"的空间感，不参与信息表达。

```css
body{
  background-color:var(--bg);
  background-image:
    linear-gradient(var(--grid-line) 1px,transparent 1px),
    linear-gradient(90deg,var(--grid-line) 1px,transparent 1px);
  background-size:64px 64px;
  background-position:-1px -1px;
}
/* 极低强度品牌光晕，只出现在页面顶部两角 */
body::before{
  background:
    radial-gradient(820px 420px at 10% -8%, var(--glow-a), transparent 64%),
    radial-gradient(680px 360px at 94% -2%, var(--glow-b), transparent 62%);
}
```

---

## 5. 组件规范

### 5.0 系统状态带（§1 System Status）

页面第一屏的第一块。一行、一个容器、`lead` + 若干 `s-item` + 右对齐 `tail`，用竖线分隔。

```
[● SYSTEM OPERATIONAL] GATEWAY gost v3 · 127.0.0.1:8080 │ DATA PLANE 312 conns · 4 listeners │ … │ last sync 12s ago
```

- `lead` 用 `--success-bg` 底色，是整个界面唯一允许的"大面积绿色块"。
- 只放**能用一条命令验证**的事实（端口、连接数、outbox 延迟、积压），不放形容词。
- 不放"运行良好"这种无法证伪的表述。

### 5.1 指标带（替代四张卡片）

一个容器、四列、细线分隔。数字大，标签小，趋势放在脚注，**底部挂一条 26px 高的迷你曲线**。

```
┌───────────────────────────────────────────────┐
│ TOTAL ENDPOINTS │ HEALTHY │ MEDIAN LATENCY │ … │
│ 1,284           │ 973/1,284│ 61ms          │   │
│ ↑38 today       │ ↓1.4%   │ P50 · P95 148ms│   │
│  ╱╱╱╱╱╱         │ ╲╲╱╱    │ ╲╱╲╱╲        │   │
└───────────────────────────────────────────────┘
```

- 分隔用 `border-left:1px solid var(--line)`，不用卡片间隙。
- 迷你曲线 `viewBox="0 0 120 26" preserveAspectRatio="none"` + `vector-effect:non-scaling-stroke`，否则线宽会被压成 0.3px。
- **无变化的指标不画曲线，画一条虚线**（`--ov-6` + `stroke-dasharray:3 4`）。伪造波动比没有波动更糟。
- 趋势箭头颜色与语义一致（涨=success，跌=danger），但**端点数量涨跌不等于好坏**，此处涨用 success 表示"新增"。

### 5.2 表格

| 规则 | 说明 |
| --- | --- |
| 行高 | `padding:12px 16px`，约 41px |
| 分隔 | 行底 `1px solid rgba(255,255,255,.038)`，表头无底色 |
| 表头 | 10.5px 大写 + 0.13em 字距，颜色 `--text-3` |
| 主列 | 第一列用 `.cell-name`：名称 12.5px 主色 + 地址 11px 等宽次要色 |
| 数值列 | 等宽字体，右对齐 |
| 状态列 | 徽章，不用纯文字 |
| 悬停 | `background:rgba(139,124,255,.05)`，可点击行 `cursor:pointer` |

### 5.3 徽章（Badge）

低饱和：12% 透明底 + 浅色文字 + 6px 圆点。

```css
.pill{background:var(--x-bg);color:var(--x-2);border-radius:var(--r-xs);padding:0 8px;height:20px;font-size:11px}
.pill .dot{width:5px;height:5px;border-radius:99px;background:var(--x)}
```

变体：`ok` / `warn` / `bad` / `info`(cyan) / `brand`(violet) / `neutral`(灰)。

> 一屏内同色徽章超过 6 个，说明该维度不该用徽章表达，应改用表格列或分组。

### 5.4 筛选片（Chip）

按维度分组，组间用竖线或间距分隔，组内互斥。

```
TRUST  [All 1,284] [Verified 642] [Private 361] [Public 281]
LIFECYCLE  [All] [Healthy] [Degraded] [Quarantined]
PROTOCOL  [All] [SOCKS5] [HTTP] [HTTPS]
```

- 选中态：`background:var(--violet-bg); color:#D6CEFF`。
- 计数用等宽小字，跟随选中态变色。
- 筛选后必须同步更新底部计数（`Showing N of 1,284`）。

### 5.5 抽屉优先于模态框

端点详情、订阅签名详情一律用右侧抽屉（472px），不用居中模态。

- 遮罩 `rgba(5,7,11,.55)` + `backdrop-filter:blur(2px)`。
- 结构：`drawer-head`（标题 + 关闭）/ `drawer-body`（可滚动）/ `drawer-foot`（主操作 + 关闭）。
- 关闭方式：Esc、点遮罩、点关闭按钮 —— 三者都要有。
- `drawer-body` 必须 `min-height:0`，否则 footer 会被内容压扁。

### 5.6 Toast

右下角堆叠，2.4s 自动消失，左侧一个语义色圆点。用于确认"动作已排入队列"这类**不需要用户决策**的反馈。

### 5.7 供应商卡（Provider health）

AI 供应商不用表格，用三张等宽卡。每张卡 = 图标砖 + 名称/型号 + 状态徽章 + 三项指标 + 一条健康曲线。

```
┌────────────────────────────────────────┐
│ [◇] DeepSeek                [● Healthy]│
│     deepseek-main · 2 models           │
│ ───────────────────────────────────────│
│ LATENCY   MONTHLY   ERRORS             │
│ 842ms     $24.60    0.4%               │
│  ╱╲╱╲╱╲                                │
└────────────────────────────────────────┘
```

- 图标砖 36×36，圆角 11px，底色 `color-mix(in srgb,var(--x) 15%,transparent)` + `inset 0 0 0 1px` 同色 24%，字形用 `currentColor`。
- **不使用第三方商标**，用抽象字形表达品类（波=推理、分叉=路由、六边形=本地）。
- 停用的供应商曲线画虚线，不画平的实线 —— 表示"没有数据"而非"数据为零"。

### 5.8 路由链（Intelligent task routing）

任务 → 主模型 → 备用模型，用节点 + 箭头表达，**不用表格**。

```
ANALYZER  [deepseek-chat p100] ──▶ [claude-sonnet p200]              [● Ready]
CLASSIFIER[deepseek-chat p100] ──▶ [no fallback]                     [● Ready]
ASSISTANT [unbound]            ──▶ [no fallback]                     [503 fallback]
```

- 主节点用紫色 12% 底 + 26% 描边（品牌域），备用节点用中性 `--ov-2`。
- 空位用透明底 + `--ov-4` 描边 + `--text-3` 文字，宽度随文字变化是允许的。
- 箭头用 32px 横线 + 旋转 45° 的 1px 边框做 chevron，不用图标字体。
- 右侧状态列用 `margin-left:auto` 统一右对齐。

### 5.9 遥测条（Live telemetry）

地图/拓扑下方的一行四格，每格 = 指标名 + 大数字 + 环比 + 迷你曲线。用 `border-top` 与上方内容分隔，格间用 `border-left`。

- 数值 `23px / 560 / -0.035em`，单位 `11px mono / --text-3`，基线对齐。
- 环比用 `.up`（danger）/ `.down`（success），**但要读语义**：延迟下降是好事 → 用 success。
- 曲线颜色默认 `--cyan`；该格处于警示状态时整格加 `.warn` 类，曲线转 `--warn`。

---

## 6. 数据可视化规范

### 6.1 折线图（延迟 / 流量 / 吞吐）

**关键工程约束**：`preserveAspectRatio="none"` 会让坐标轴文字非等比变形。

正确做法 —— 曲线用 SVG 拉伸，刻度用 HTML：

```html
<div class="plot">
  <div class="yax"><span>130</span><span>100</span><span>70</span><span>40</span></div>
  <div class="plotarea"><svg viewBox="0 0 1000 200" preserveAspectRatio="none">…</svg></div>
</div>
<div class="xax"><span>00:00</span>…<span class="now">NOW</span></div>
```

- `.yax` 用 `grid-template-rows:repeat(4,1fr)`，标签在各行居中，网格线画在 12.5% / 37.5% / 62.5% / 87.5%。
- 描边必须加 `vector-effect="non-scaling-stroke"`，否则线宽随容器高度变化。
- P50 实线 + 渐变填充，P95 虚线（40% 透明度），当前时刻用紫色竖虚线 + 端点圆点。

### 6.2 热力图（区域 × 小时）

- **单色相明度递进，不用彩虹**。六档色阶 `--heat-0…--heat-5`：低延迟=深青，高延迟=亮青，只有越过阈值才转琥珀。

  | Token | 深色 | 浅色 |
  | --- | --- | --- |
  | `--heat-0` | `#16414A` | `#E4EFF0` |
  | `--heat-1` | `#1B555F` | `#DCEAEB` |
  | `--heat-2` | `#1C6670` | `#B6D6D6` |
  | `--heat-3` | `#23877F` | `#83BDBA` |
  | `--heat-4` | `#2FB3A6` | `#3F9E96` |
  | `--heat-5` | `#E6AD61` | `#B4781F` |

- 颜色**交给 CSS 令牌**，JS 只负责分档（`cell.dataset.lv = level(t)`）。这样切换主题不需要重绘 DOM。
- 阈值 `[.18,.36,.54,.72,.86]`，是按 P50 的 20–320ms 区间线性归一化后取的。
- 变化以**日节律**为主、噪声为辅，否则会变成随机散点，读者看不出趋势。
- 每个格子 `title` 给出「区域 · 小时 · 值」，不依赖 tooltip 库。

> 早期版本用四段色标（青→琥珀→珊瑚）连续插值，结果同一行里青、橙、粉交替，像随机噪点。**热力图必须让"更热"和"更亮"在视觉上同向**，否则读者无法排序。

### 6.3 堆叠柱（结果构成）

- 主结果（pass）用 50% 透明度作为底噪，异常段（degraded / failed）用满色 —— 让读者先看到异常。
- 柱底对齐，横轴每 4 格标一次时间。
- 通过率 98%+ 时异常段只有 1–2px，这是**真实数据**，不要为了好看放大它。

### 6.4 拓扑图

- 五列：Sources → Endpoints → Pools → Gateway → Consumers，列标题 9px 大写下划线。
- 节点 128×38，圆角 9px，右上角 2.6px 状态点；池节点 148×38（`PUBLIC_EXPERIMENTAL` 有 19 个字符）。
- **点击节点追踪有向路径**：向上游 + 向下游各走一次，路径节点青色描边，被选节点紫色描边，其余 32% 透明度。
- 公共池必须连到**独立的 lab 监听节点**，不能连到生产网关 —— 这是 SEC-001 §6.2 的视觉表达。

### 6.5 生命周期条

一条横向流水线，每段一个进度条 + 标签 + 数字：

```
DISCOVERED 128 │ VERIFYING 42 │ VERIFIED 964 │ POOLED 812 │ SUBSCRIBED 246 │ DEGRADED 87 │ QUARANTINED 14
```

Degraded / Quarantined 用警告色和危险色，其余用紫色系递进。

底部补一条**转化率 + 积压**行，把"流水线是否堵住"讲清楚：

```
discovered→verified 75.1% │ verified→pooled 84.2% │ pooled→subscribed 30.3%      Backlog 143  42 verifying · 87 degraded · 14 quarantined
```

- 转化率用等宽字体，积压总数用警告色。
- 积压必须拆到状态，只给一个总数等于没说。

### 6.6 全球网络地图（Topology 第一屏）

等距圆柱投影（equirectangular），`viewBox="0 0 1000 390"`，`x=(lon+180)/360*1000`，`y=(90-lat)/180*460`。

- 陆地用低多边形轮廓，`fill:var(--map-land)` + 1px `--map-land-line`，**刻意几何化**：不追求地理精度，追求"数据面示意图"的调性。
- 经纬网每 30° 一条，`--map-grid` 极低对比。
- 区域节点 = 透明热区（r=22）+ 光晕（r=16）+ 实心点（r=5）+ 代码 + 延迟。
  - 热区必须比视觉尺寸大，否则 `<g>` 的可点击区域只有圆点和文字，实测 hover 会漏。
- 所有长途链路汇聚到出口枢纽（SG），枢纽多一圈 `ring2` 做脉冲。
- 链路按延迟着色：正常 `--cyan` 54%，偏高 `--warn` 78%。
- 区域标签 16px / 延迟 12.5px mono —— 按 viewBox 缩放后实际约 11px / 8.6px，**不能再小**。

### 6.7 十字光标与异常标记（Network intelligence）

折线图 hover 读取精确值，用三个绝对定位的 HTML 元素叠在 SVG 上，而不是在 SVG 里画：

```
.plotarea{position:relative}
.xh   竖线 1px --ov-6
.xdot 7px 圆点 + 3px 青色光晕
.xtip 浮层：时间 + P50 + P95
```

- 数据从 `<path d="…">` 里正则解析坐标，避免维护第二份数据源。
- 异常时刻用 `.xmark` 竖线 + 底部标签，标签位置必须和竖线真实时间一致（`left: 13/24*100%`）。
- 区间切换（1H / 24H / 7D）用 `.seg` 分段控件，切换只改数据不重排布局。

---

## 7. 信息架构

```
Observe      Overview · Topology
Inventory    Resources · Verification · Resource Pools
Governance   Trust & Tiers
Delivery     Subscriptions · Gateway
Intelligence AI Providers
```

侧边栏 240px，分组标题 10px 大写 + 0.14em 字距。分组顺序对应「观测 → 资产 → 治理 → 交付 → 增强」，与三层平面架构一致。

---

## 8. 可访问性

| 项 | 要求 |
| --- | --- |
| 对比度 | 正文 ≥ 4.5:1，大字 ≥ 3:1（`--text` on `--surface` ≈ 13.8:1） |
| 键盘 | 抽屉 Esc 关闭；所有按钮可 Tab 聚焦，`:focus-visible` 紫色 2px 描边 |
| 触控目标 | 交互元素 ≥ 32px 高（桌面密度），移动端 ≥ 44px |
| 语义 | 表格用 `<table>`，抽屉用 `role="dialog"` + `aria-hidden` 切换 |
| 动效 | 过渡 ≤ 240ms，`--ease:cubic-bezier(.22,.61,.36,1)`；尊重 `prefers-reduced-motion` |

---

## 9. 禁止清单

| 禁止 | 原因 |
| --- | --- |
| 通用 AI Dashboard 模板风（四张等大卡片 + 圆角图标 + 渐变标题） | 无产品识别度 |
| 过度玻璃拟态 / 大面积 `backdrop-filter` | 数据密集界面会失去层次 |
| 大面积渐变背景 | 与"控制面"的冷峻气质冲突 |
| 无意义发光 / `box-shadow` 彩色外扩 | 注意力通胀 |
| 圆角 > 16px | 会让基础设施工具显得幼稚 |
| 每个模块相同的卡片形状 | 页面变成表格拼贴 |
| 装饰性假数据（无后端来源的图表） | 违反"控制面可信" |
| 失效按钮（点了没反应、也没有 disabled 态） | 原型验收硬指标 |
| 明文 API Key / Token | 安全硬规则，一律掩码 `sk-••••4f2a` |
| 在 SVG 表现属性里写 `var()` | 表现属性不解析自定义属性，必须改用 `style="fill:var(--x)"` |
| 彩虹热力图 | 无法表达"更热"，读者不能排序 |

---

## 10. 图标系统

单文件原型里用 **SVG sprite**，不引图标库。

```html
<svg style="display:none"><defs>
  <symbol id="i-overview" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round">…</symbol>
</defs></svg>

<svg class="ico-m"><use href="#i-overview"/></svg>
```

| 规格 | 值 |
| --- | --- |
| 画布 | 24×24 |
| 描边 | 1.6px（导航）/ 1.7–1.9px（动作） |
| 端点 | `round` |
| 颜色 | `currentColor`，跟随父级文本色 |
| 尺寸 | 导航 16px，顶栏 16px，按钮内 13px，供应商砖 19px |

**图标族**（共 23 个）：导航 9（overview / topology / resources / verification / pools / trust / subscriptions / gateway / ai）、系统 11（search / bell / sun / moon / plus / download / play / command / arrow / refresh / check）、供应商 3（deepseek 波 / openrouter 分叉 / ollama 六边形）。

**供应商图标不使用第三方商标**：用抽象字形表达品类语义，避免商标风险，也避免"logo 墙"把控制台变成集成商目录。

---

## 11. 双语与主题切换

### 11.1 主题

```js
function applyTheme(th){
  document.documentElement.setAttribute('data-theme', th);
  document.querySelectorAll('[data-theme-set]').forEach(b=>
    b.classList.toggle('on', b.dataset.themeSet === th));
  localStorage.setItem('pf-theme', th);
}
```

- `:root` 是深色，`[data-theme="light"]` 只覆盖 token。
- `color-scheme` 必须跟着切，否则原生滚动条、表单控件不会跟随。
- 主题初始化必须在首次绘制前完成，否则会闪白（FOUC）。

### 11.2 语言

以**渲染文本本身**为字典键，而不是给每个节点加 `data-i18n`：

```js
const I18N = { "Overview":"总览", "Command Center":"指挥中心", … };  // 500 条

function buildLangIndex(){                 // 一次性建索引
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n){
      if(!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if(n.parentElement.closest('script,style')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  // 记录 lead / trail 空白，替换时保留
}
```

优点：HTML 保持可读，新增文案只要在字典里补一条；改文案时字典键跟着改，不会出现"键还在、文本已变"的错位。

**必须处理的三个坑**：

1. **保留前后空白** —— 否则 `Hello <b>world</b>` 会粘成 `Helloworld`。
2. **HTML 实体** —— `Trust &amp; Tiers` 与 `Trust & Tiers` 是两个不同的文本节点，字典两条都要收。
3. **JS 生成的文案不会被 TreeWalker 索引** —— 提供 `onLang(fn)` 钩子，让动态文本（面包屑、拓扑统计、Toast）在切换后重新计算。

```js
const LANG_HOOKS = [];
function onLang(fn){ LANG_HOOKS.push(fn); }
// applyLang 末尾：LANG_HOOKS.forEach(f=>{ try{f();}catch(e){} });
```

**中文排版注意**：中文比英文短，但**不能因此放大字号**；相反要检查原来靠英文长度撑开的列（如「12 warn」在 40px 列里换行），给数字列加 `white-space:nowrap` + `min-width`。

---

## 12. 与后端契约的对应

| 界面元素 | 对应规则 |
| --- | --- |
| Resources 的 Trust 列 | `endpoint.trust_tier`（VERIFIED / PRIVATE / PUBLIC） |
| PUBLIC 徽章红色 + 抽屉内黄色警告块 | `SEC-001 §6.2`：公共代理永不进生产网关 |
| Trust 页的权限矩阵 | 三层 × 三列的授权矩阵，硬编码拒绝规则 |
| 晋升队列的 Approve 按钮 | `promotion_suggestions` 需 `reviewed_by`，AI 不能自批 |
| Subscriptions 的签名详情 | `X-PF-Signature-Alg` 等响应头 + JCS canonical hash |
| Gateway 的 `lab` 监听行 | 8095 端口，loopback-only，永不承载敏感流量 |
| AI 页的预算条 | 95% 降级到本地模型，100% 硬停 |

---

## 13. 验收清单

改完界面后逐条过：

| # | 检查项 | 判定方式 |
| --- | --- | --- |
| 1 | 深浅两主题 × 中英两语言，9 个页面全部无错位 | 4 组截图比对 |
| 2 | 无横向滚动条 | `document.documentElement.scrollWidth - clientWidth === 0` |
| 3 | 无未定义令牌 / 无自引用令牌 | 正则扫描 `var(--x)` 与 `--x:var(--x)` |
| 4 | `<style>` 之外无硬编码 hex | 正则扫描 body |
| 5 | 无 JS 报错 | 监听 `pageerror` / `console.error` |
| 6 | 命令面板、抽屉、筛选、排序、追踪、hover 全部可用 | 脚本化交互测试 |
| 7 | 每个按钮点击都有 Toast 或状态变化 | 逐个点击 |
| 8 | 数字全部 `tabular-nums`，切换时不抖动 | 目视 + computed style |
| 9 | 尊重 `prefers-reduced-motion` | 开启系统减弱动效后复查脉冲动画 |

---

**维护规则**：任何新增颜色、字号、间距必须先落进 `:root`，不得在组件内写魔法值。原型与本文档不同步时，以原型为准并回写本文档。
