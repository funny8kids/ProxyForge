import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * 轻量双语层。
 * 与原型一致：以英文为键，中文为值；缺失时回退到英文而不是显示空白。
 * 主题与语言都持久化到 localStorage，刷新后保持。
 */

type Lang = 'en' | 'zh';
type Theme = 'dark' | 'light';

const ZH: Record<string, string> = {
  // 导航
  Overview: '总览',
  Topology: '拓扑',
  Resources: '资源',
  Verification: '验证',
  Pools: '资源池',
  Trust: '信任分级',
  Subscriptions: '订阅',
  Gateway: '网关',
  'AI Providers': 'AI 供应商',
  Audit: '审计',
  // 通用
  Search: '搜索',
  'Command Center': '指挥中心',
  'Network Resource Control Plane': '网络资源控制平面',
  'Sign out': '退出登录',
  'Sign in': '登录',
  Username: '用户名',
  Password: '密码',
  'Fixture data': '示例数据',
  'Worker errors': '后台任务异常',
  'Check the API log for the full stack': '完整堆栈见 API 日志',
  Live: '实时',
  Loading: '加载中',
  Refresh: '刷新',
  Reload: '重新编译',
  Cancel: '取消',
  Close: '关闭',
  Confirm: '确认',
  Details: '详情',
  Status: '状态',
  Health: '健康',
  Actions: '操作',
  Total: '总计',
  None: '无',
  // 概览
  'Total endpoints': '端点总数',
  Schedulable: '可调度',
  Healthy: '健康',
  Degraded: '降级',
  Quarantined: '已隔离',
  'Pending verification': '待验证',
  'Trust tiers': '信任分级',
  'Protocol mix': '协议分布',
  'Origin mix': '来源分布',
  'Quality trend': '质量趋势',
  'Top endpoints': '优质端点',
  'Gateway traffic': '网关流量',
  'Gateway eligible': '可进网关',
  'Public proxy health': '公开代理健康率',
  'Pending promotions': '待审晋升',
  // 资源
  Host: '主机',
  Port: '端口',
  Protocol: '协议',
  Tier: '分级',
  Quality: '质量',
  Latency: '延迟',
  Success: '成功率',
  'Last verified': '最近验证',
  'Probe schedule': '探测调度',
  Probing: '探测中',
  Idle: '空闲',
  Country: '国家',
  'No resources': '暂无资源',
  'Filter by tier': '按分级筛选',
  'All tiers': '全部分级',
  endpoints: '个端点',
  of: '/',
  nodes: '个节点',
  edges: '条边',
  Task: '任务',
  failed: '失败',
  'OpenAI compatible': 'OpenAI 兼容',
  Anthropic: 'Anthropic',
  Ollama: 'Ollama',
  Custom: '自定义',
  // 分级名（tierLabel 的输出走 t()）
  bound: '条已绑定',
  compiled: '个已编译',
  applied: '已生效',
  enabled: '启用中',
  superseded: '已被取代',
  unsigned: '未签名',
  // 审计资源类型
  endpoint: '端点',
  pool: '资源池',
  policy: '策略',
  gateway_instance: '网关实例',
  subscription: '订阅',
  ai_provider: 'AI 供应商',
  user: '用户',
  import_job: '导入任务',
  import_batch: '导入批次',
  'Base URL': '基础地址',
  Key: '密钥',
  on: '启用',
  off: '停用',
  ACTIVE: '生效中',
  Request: '请求',
  Unavailable: '不可用',
  Peak: '峰值',
  Name: '名称',
  Pool: '资源池',
  Format: '格式',
  healthy: '健康',
  degraded: '降级',
  unavailable: '不可用',
  'pending verification': '待验证',
  quarantined: '已隔离',
  discovered: '已发现',
  verified: '已验证',
  rejected: '已拒绝',
  Private: '私有',
  Verified: '已验证',
  Public: '公开',
  Quarantine: '隔离',
  'Resource detail': '资源详情',
  'Recent checks': '最近探测',
  Layer: '层',
  Reason: '原因',
  'Exit IP': '出口 IP',
  'Member of': '所属池',
  // 池
  Members: '成员',
  'Avg quality': '平均质量',
  Experimental: '实验池',
  'Allowed tiers': '允许分级',
  'Min quality': '最低质量',
  'Recompute members': '重算成员',
  Rules: '规则',
  'No pools': '暂无资源池',
  // 网关
  Policies: '策略',
  'Listen port': '监听端口',
  // 与 Policies 区分：这一列是选择算法（FASTEST / WEIGHTED…），不是策略本身
  Strategy: '算法',
  'Compiled config': '编译产物',
  Versions: '版本',
  Members2: '成员数',
  Warnings: '警告',
  'One policy = one listen port. Members are frozen at compile time — the data plane never calls back.':
    '一个策略对应一个监听端口，成员在编译期固化——数据面请求期绝不回源。',
  'avg quality score': '平均质量分',
  days: '天',
  // 信任
  'Gateway eligible only': '仅这两个分级可进网关',
  'Approve': '批准',
  'Reject': '拒绝',
  'Suggested tier': '建议分级',
  Confidence: '置信度',
  Rationale: '依据',
  Source: '来源',
  'No pending suggestions': '没有待处理的晋升建议',
  'AI can only suggest. Approval requires a different human reviewer.':
    'AI 只能提建议；批准必须由他人复核。',
  // 订阅
  'Token prefix': 'Token 前缀',
  Revision: '修订号',
  Signed: '已签名',
  Accesses: '访问次数',
  Expires: '过期时间',
  // AI
  Provider: '供应商',
  Models: '模型',
  'Monthly budget': '月度预算',
  'Spent': '已用',
  'Test connection': '连接测试',
  'Task routing': '任务路由',
  'Fallback chain': '降级链',
  'Never returns plaintext keys': '永不返回明文密钥',
  // 审计
  Time: '时间',
  Actor: '操作者',
  Action: '动作',
  Resource: '资源',
  'No events': '暂无事件',
  // 拓扑
  'Data plane': '数据面',
  'Control plane': '控制面',
  'Isolated': '隔离',
  'Formal chain': '正式链路',
  'Verified chain': '已验证链路',
  'Isolated path': '隔离链路',
  'Disabled': '已停用',
  'Hover to trace · click to pin': '悬停追踪 · 点击固定',
  'Esc to unpin': 'Esc 取消固定',
  'Public proxies never enter the formal gateway': '公开代理永不进入正式网关',
  'Isolation rules': '隔离规则',
  'Compile-time freeze': '编译期固化',
  'Routed to': '默认进入',
  ' by default. Only policies bound to the lab instance may reference it. Formal-chain members come from':
    '，只有绑到 lab 实例的策略才能引用它。正式链成员来自',
  ', a view that contains no public proxies.': ' 视图，该视图里不存在公开代理。',
  'May enter the formal gateway;': '可进正式网关；',
  'additionally requires': '还需',
  'One policy = one listen port. Members are written into the config at compile time. Requests never call back to the control plane — not a performance trade-off: once the HTTPS CONNECT tunnel is up, the control plane cannot read any request header, so per-request routing by header is not expressible in the protocol.':
    '一个策略对应一个监听端口，成员在编译期写进配置。请求期不回源控制面——这不是性能取舍：HTTPS CONNECT 隧道建立后，控制平面读不到任何请求头，按请求头动态选路在协议上根本不成立。',

  // 各屏说明文字（英文模式下不允许出现中文残留）
  'Only shown once, at creation time': '只在创建时出现一次',
  'Lower priority number is tried first': 'priority 数字小的先试',
  'Append-only; production must REVOKE UPDATE/DELETE from the app role':
    'append-only；生产环境需对应用角色 REVOKE UPDATE/DELETE',
  'Formal and experimental are physically separated': '正式与实验物理分离',
  'PUBLIC_PROXY may only join pools that declare it explicitly':
    'PUBLIC_PROXY 只能进显式声明的实验池',
  'The signed object is JCS-canonical JSON, not the YAML byte stream. A monotonic revision blocks replay.':
    '签名对象是 JCS 规范化 JSON，不是 YAML 字节流；revision 单调递增用于防重放。',
  'Signing keys': '签名密钥',
  'Private key lives only in the secrets table; the API never returns it':
    '私钥只在 secrets 表，API 永不返回',
  'Public key distribution:': '公钥分发：',
  'Client verification order: known signatureVersion → matching canonicalHash → Ed25519 verify → increasing revision → not expired.':
    '客户端校验顺序：signatureVersion 已知 → canonicalHash 一致 → Ed25519 验签 → revision 递增 → 未过期。',
  'Render endpoints': '渲染端点',
  'Token auth, not JWT': 'Token 认证，非 JWT',
  'Missing / revoked / expired all return 404, to prevent enumeration.':
    '不存在 / 已撤销 / 已过期 → 统一 404，防枚举。',
  'AI can only write suggestions, never change a tier directly':
    'AI 只能写建议表，不能直接改分级',
  revoked: '已撤销',
  'All statuses': '全部状态',
  'No compiled config yet': '尚未编译下发',
  'not compiled': '未编译',
  'Traffic (24h)': '流量（24 小时）',
  'hourly buckets': '个小时桶',
  'No traffic samples yet': '暂无流量采样',
  Instances: '网关实例',
  warning: '条告警',
  Control: '控制',
  System: '系统',
  'by quality score': '按质量分排序',
  '24h · connections / hour': '24 小时 · 每小时连接数',
  'min quality': '最低质量分',
  'Max members': '成员上限',
  active: '条生效',
  members: '成员',
  experimental: '实验',
  'Three hard rules': '三条铁律',
  'A PUBLIC_PROXY can never receive a gateway grant.': 'PUBLIC_PROXY 永远不能获得网关授权。',
  'No tier can be upgraded directly; a suggestion must be approved by a human.':
    '任何分级都不能直接提升，必须由人批准建议。',
  'The submitter of a suggestion can never be the one who approves it.':
    '建议的提交人不能同时是批准人。',
  // 资源抽屉 / 分页
  'Previous page': '上一页',
  'Next page': '下一页',
  Authorization: '授权状态',
  'Gateway grant': '网关授权',
  granted: '已授权',
  none: '无',
  Jitter: '抖动',
  'Consecutive failures': '连续失败',
  Authorized: '已授权',
  Restricted: '受限',
  Unknown: '未知',
  Revoked: '已撤销',
  // 探测失败原因
  'DNS failure': 'DNS 失败',
  'TCP refused': 'TCP 拒绝',
  'TCP timeout': 'TCP 超时',
  'TLS error': 'TLS 错误',
  'Protocol error': '协议错误',
  'Auth failed': '认证失败',
  'Exit IP mismatch': '出口 IP 不符',
  Timeout: '超时',
  Unstable: '不稳定',
  Flaky: '时好时坏',
  'Internal error': '内部错误',
  OK: '正常',
  // 信任分级页
  'Enforced server-side': '服务端强制',
  // 页眉分类行。
  // 原来这里直接重复页面标题（「资源」/「资源」），等于把同一个词写两遍：
  // 既占掉了页眉的位置，又没有提供任何信息。改成一句话说明这一屏负责什么。
  'Data plane map': '数据面拓扑',
  'Endpoint inventory': '端点清单',
  'Scheduling groups': '调度分组',
  'Compile & distribute': '编译与下发',
  'Tiers & promotion': '分级与晋升',
  'Signed distribution': '签名分发',
  'Suggestion engine': '建议生成',
  'Change trail': '变更留痕',
  // 审计操作者类型（System / Control 已在上面定义）
  User: '用户',
  'API key': 'API 密钥',
  Scheduler: '调度器',
  // 登录页
  Demo: '演示账号',
  'Session token is kept in this browser only': '会话令牌只保存在本浏览器',
  'A control plane for proxy endpoints: inventory, trust tiers, pools, and a compiler that freezes each policy into a gateway config.':
    '面向代理端点的控制平面：资源清单、信任分级、资源池，以及把每条策略固化成网关配置的编译器。',
  'PUBLIC_PROXY is isolated to a dedicated listener and can never receive a gateway grant.':
    'PUBLIC_PROXY 只能走独立监听器，永远拿不到网关授权。',
  'Subscriptions are signed with Ed25519 over JCS-canonical JSON, never over the YAML byte stream.':
    '订阅用 Ed25519 签名，签的是 JCS 规范化 JSON，不是 YAML 字节流。',
  'AI can only write a suggestion. Approving it requires a different human reviewer.':
    'AI 只能写建议，批准必须由另一位人工复核。',
  // 命令面板
  Core: '核心',
  'Jump to a screen…': '跳转到…',
  'No matching screen': '没有匹配的屏',
  Navigate: '选择',
  Open: '打开',
  // 订阅：创建 / 重签发 / 一次性 Token
  'New subscription': '新建订阅',
  'Pick a pool, then paste the URL into your client': '选一个资源池，再把地址粘进客户端',
  'No subscriptions yet': '还没有订阅',
  Reissue: '重签发',
  'Reissue token': '重签发 Token',
  'Reissue now': '确认重签发',
  'Creating…': '创建中…',
  'Working…': '处理中…',
  Create: '创建',
  Done: '完成',
  Copy: '复制',
  Copied: '已复制',
  Client: '客户端',
  'Subscription URL': '订阅地址',
  'This token is shown once and never again. The database only stores its hash.':
    '这个 Token 只显示这一次，库里只存它的哈希。',
  'Paste this into Clash / FlClash / Mihomo as a remote config URL.':
    '把它作为远程配置地址粘进 Clash / FlClash / Mihomo。',
  'Clients re-pull on their own schedule; revision bumps on every content change.':
    '客户端按自己的周期重新拉取；内容每次变化 revision 都会递增。',
  'The current URL stops working the moment you confirm. Any client still using it starts failing.':
    '确认后当前地址立即失效，还在用它的客户端会开始报错。',
  'The subscription itself, its revision and its version history are kept. Only the token is replaced.':
    '订阅本身、revision 和版本历史都保留，只替换 token。',
  'Subscription created': '订阅已创建',
  'Token reissued': 'Token 已重签发',
  'No pool available — create one first.': '没有可用资源池，请先创建一个。',
  'Only the Mihomo YAML renderer is implemented; every client below reads it.':
    '后端只实现了 Mihomo YAML 渲染器；下面这些客户端读的都是它。',
  'Sign with Ed25519': '用 Ed25519 签名',
  'Adds X-PF-Signature and X-PF-Revision headers. Clients may verify; the body stays standard YAML.':
    '响应头带上 X-PF-Signature 与 X-PF-Revision；正文仍是标准 YAML，不签名也不影响客户端加载。',
  // 资源：导入 / 授权 / 单点验证
  Import: '导入',
  'Importing…': '导入中…',
  'Import proxies': '导入代理',
  'One per line — plain host:port also works': '每行一个，纯 host:port 也可以',
  Endpoints: '端点',
  'Accepted: host:port · host:port:user:pass · scheme://host:port · scheme://user:pass@host:port':
    '支持：host:port · host:port:user:pass · scheme://host:port · scheme://user:pass@host:port',
  'Shadowsocks / VMess / Trojan / VLESS URLs are not supported — they are rejected line by line.':
    '不支持 Shadowsocks / VMess / Trojan / VLESS 链接，会逐行拒绝。',
  'Default protocol': '默认协议',
  'Used when a line has no scheme prefix.': '某行没有协议前缀时用它。',
  'Public proxy': '公开代理',
  'Private proxy': '自有代理',
  'Verified proxy': '已验证代理',
  'Defaults to the strictest tier. Promotion between tiers still goes through review.':
    '默认落在最严分级；跨分级提升仍需复核。',
  'I am allowed to use these proxies': '我有权使用这些代理',
  'Marks them AUTHORIZED. Without this they stay UNKNOWN and are filtered out of every subscription.':
    '勾选后标记为 AUTHORIZED；不勾则保持 UNKNOWN，会被所有订阅过滤掉。',
  Imported: '已导入',
  Duplicated: '重复',
  Skipped: '已跳过',
  Authorize: '授权',
  'Verify now': '立即验证',
  'Queued…': '已排队…',
  'Queue a probe for this endpoint': '为这个端点排一次探测',
  'Authorized. It can now be published through a subscription.': '已授权，现在可以通过订阅发布了。',
  'Verification queued': '验证已入队',
  'Authorization is UNKNOWN, so this endpoint is filtered out of every subscription even when it is healthy. Authorize it if you are allowed to use it.':
    '授权状态是 UNKNOWN，即使它是健康的，也会被所有订阅过滤掉。如果你有权使用，请授权。',
  // 来源采集
  'Discovery pipeline': '资源发现',
  Sources: '来源',
  'Import catalog': '导入目录',
  'Fetch every enabled source in sequence': '按顺序抓取全部启用的来源',
  'Sync all': '全部同步',
  'Syncing…': '同步中…',
  Sync: '同步',
  'Sync failed': '同步失败',
  Candidates: '候选',
  'across all sources': '全部来源合计',
  'Unique endpoints': '去重后端点',
  '{n} hosts': '{n} 个主机',
  'Pending review': '待处理',
  'waiting to be promoted': '等待晋级',
  Promoted: '已晋级',
  'now in the endpoint table': '已进入端点表',
  'No sources yet — import the built-in catalog to start.': '还没有来源 —— 先导入内置目录',
  Type: '类型',
  'Last sync': '上次同步',
  manual: '手动',
  never: '从未',
  Promote: '晋级',
  Enable: '启用',
  Disable: '停用',
  'Snapshot written': '快照已写入',
  'duplicate content': '内容重复',
  'new content': '新内容',
  'Entries parsed': '解析条目',
  'Candidates written': '写入候选',
  Duration: '耗时',
  '{n} sources available ({c} new, {u} refreshed)': '可用来源 {n} 个（新增 {c}，刷新 {u}）',
  'Content unchanged, snapshot already exists': '内容未变化，快照已存在',
  '{n} candidates': '{n} 条候选',
  '{ok}/{total} synced · {n} new candidates ({c} updated, {u} unchanged)':
    '已同步 {ok}/{total} 个来源 · 新增 {n} 条候选（{c} 个源有更新，{u} 个未变化）',
  'Promote candidates': '晋级候选',
  Pending: '待处理',
  pending: '待处理',
  'Promoting…': '晋级中…',
  'Batch size': '批次大小',
  'Trust tier': '信任分级',
  '{p} promoted · {d} duplicates · {r} left in queue': '已晋级 {p} 条 · 重复 {d} 条 · 队列剩余 {r} 条',
  'Promotion only moves candidates into PENDING_VERIFICATION. They still need to pass verification twice before a pool will accept them.':
    '晋级只是把候选搬进「待验证」。它们还要连续通过两次验证，才会被资源池接纳。',
  'I have the right to use these proxies. This declaration is written to the audit log.':
    '我确认有权使用这些代理。此声明会写入审计日志。',
  'Public lists are fetched, parsed and quarantined as candidates. Nothing reaches the endpoint table until you promote it.':
    '公开列表会被抓取、解析，先落进候选隔离区。在你确认晋级之前，它们不会进入端点表。',
  'Public lists mix in honeypots and compromised hosts. Verifying before routing real traffic through them is not optional.':
    '公开列表里混着蜜罐和被入侵的主机。拿它们跑真实流量之前，先验证不是可选项。',
  // 订阅：分流与过滤
  Settings: '设置',
  'Routing & filtering': '分流与过滤',
  'Routing mode': '分流模式',
  Global: '全局',
  Rule: '规则',
  Direct: '直连',
  'All traffic through the proxy': '全部流量走代理',
  'China direct, everything else proxied': '国内直连，其余走代理',
  'Everything direct — use it to isolate whether the proxy is the problem':
    '全部直连 —— 用来判断"是不是代理本身的问题"',
  Protocols: '协议',
  'None selected means all protocols': '不选等于全部协议',
  'Only the selected protocols are published': '只发布选中的协议',
  'Max latency': '延迟上限',
  'Max nodes': '节点上限',
  'Max latency drops nodes that have never been probed — "unknown" is not "fast".':
    '设了延迟上限会排除从未探测成功过的节点 —— "不知道快不快"不等于"快"。',
  'Exclude hosts': '排除主机',
  'Substring match, comma separated': '子串匹配，逗号分隔',
  'Name template': '命名模板',
  'Placeholders: {index} {protocol} {host} {port} {pool}. Duplicates get a suffix.':
    '占位符：{index} {protocol} {host} {port} {pool}；重名会自动加后缀。',
  'Append rules': '追加规则',
  'One rule per line, mihomo syntax. They run before the built-in rules. Any action other than DIRECT / REJECT means "go through this pool".':
    '每行一条，mihomo 语法。它们排在内建规则之前；动作除 DIRECT / REJECT 外一律理解为"走本池"。',
  Preview: '预览',
  'By protocol': '协议分布',
  'Sample names': '节点名示例',
  'No node matches this filter. Loosen the conditions before saving.':
    '没有节点满足这组条件，保存前请放宽条件。',
  'The token stays the same, so clients do not need to be re-imported. Revision bumps automatically because the rendered content changed.':
    'Token 不变，客户端不需要重新导入；因为渲染内容变了，revision 会自动递增。',
  Save: '保存',
  'Saving…': '保存中…',
  Saved: '已保存',
  Reset: '重置',

  // 来源质量
  FAILED: '失败',
  'auto-disabled': '已被系统自动停用',
  'Not enough imported endpoints to score yet': '已导入的端点太少，还不足以评分',

  // 告警与事件管道
  Alerts: '告警',
  'All clear — nothing is currently failing.': '一切正常 —— 当前没有失败项。',
  'Condition-based; clears itself when the cause goes away': '基于条件；原因消失后会自动关闭',
  '{n} open': '{n} 条未解决',
  Ack: '确认',
  acked: '已确认',
  Resolve: '标记解决',
  'Mark resolved manually': '手动标记为已解决',
  'Re-evaluate now': '立即重新评估',
  'Event pipeline': '事件管道',
  'Outbox → consumers → metrics / alerts': 'Outbox → 消费方 → 指标 / 告警',
  Published: '已发布',
  'Dead letters': '死信',
  Replay: '重放',
  'Re-run only the consumers that failed': '只重跑失败的消费方，已成功的不重复执行',
  'No events consumed yet.': '还没有事件被消费。',

  // 订阅导出
  Export: '导出',
  'Export subscription': '导出订阅',
  'Default format': '默认格式',
  'Download': '下载',
  'Download now': '立即下载',
  'Downloading…': '下载中…',
  default: '默认',
  '{client} reads this format.': '{client} 读这个格式。',
  'This is only the default — any subscription can be exported to all four formats later.':
    '这只是默认值 —— 任何订阅之后都能导出成全部四种格式。',
  'Downloads the same node set in another serialisation. The revision does not change.':
    '用另一种序列化方式下载同一份节点，revision 不变。',
  'Saved as {file}': '已保存为 {file}',
  'These exports carry the same node set but no signature. Signature headers only come with the token URL.':
    '这些导出是同一份节点，但不带签名。签名头只随 token 地址返回。',
  'format accepts mihomo / clash / singbox / base64 / plain. Overriding it does not bump the revision.':
    'format 支持 mihomo / clash / singbox / base64 / plain。覆盖它不会改变 revision。',
  'Revoked subscriptions cannot be exported': '已撤销的订阅不能导出',
};

interface I18nCtx {
  lang: Lang;
  theme: Theme;
  t: (key: string) => string;
  setLang: (l: Lang) => void;
  setTheme: (t: Theme) => void;
}

const Ctx = createContext<I18nCtx | null>(null);

function readStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  return fallback;
}

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const [lang, setLangState] = useState<Lang>(() => readStored('pf-lang', 'en', ['en', 'zh']));
  const [theme, setThemeState] = useState<Theme>(() => readStored('pf-theme', 'dark', ['dark', 'light']));

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('pf-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    try {
      localStorage.setItem('pf-lang', lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  const t = useCallback((key: string) => (lang === 'zh' ? ZH[key] ?? key : key), [lang]);
  const setLang = useCallback((l: Lang) => setLangState(l), []);
  const setTheme = useCallback((th: Theme) => setThemeState(th), []);

  const value = useMemo(() => ({ lang, theme, t, setLang, setTheme }), [lang, theme, t, setLang, setTheme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n 必须在 I18nProvider 内使用');
  return ctx;
}

export type { Lang, Theme };
