import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Badge, Empty, ErrorNote, Panel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useI18n } from '../lib/i18n';
import { tierLabel } from '../lib/format';

/**
 * 拓扑：资源分级 → 资源池 → 策略（端口）→ 网关实例。
 *
 * 这张图要回答的唯一问题：**公开代理到底走到哪里去了**。
 * 答案必须是"走到 gost-lab 的独立监听器，且不经过正式链"——
 * 如果图上出现 PUBLIC_PROXY 直连 gost-primary 的边，就是 SEC-001 §6.2 被破坏了。
 */

interface Node {
  id: string;
  kind: 'tier' | 'pool' | 'policy' | 'instance';
  label: string;
  sub: string;
  /** 端口、地址这类值用等宽字体，和人读的名字区分开 */
  mono?: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  tone: 'violet' | 'cyan' | 'warn' | 'muted';
  /** 存活状态。null = 这一列不表达存活（分级只是分类，不是活对象） */
  live: boolean | null;
  isolated?: boolean;
}

interface Edge {
  from: string;
  to: string;
  tone: 'violet' | 'cyan' | 'warn' | 'muted';
  dashed?: boolean;
}

/**
 * 画布尺度。
 *
 * 宽度取 828 而不是 1000，是为了让 SVG 在 ~830px 宽的面板里**接近 1:1 渲染**。
 * 之前画布 1000 宽，被压到 0.83 倍，12px 的节点标题实际只有 10px，
 * 整个图看起来"虚"，像是把一张大图塞进了小框。
 */
const CANVAS_W = 840;
/* 分级列与实例列的文案最短，收窄 30~40px，把宽度让给中间两道需要走线的间隙。 */
const COL = { tier: 14, pool: 207, policy: 443, instance: 678 };
const NODE_W = { tier: 136, pool: 178, policy: 178, instance: 148 };
const NODE_H = 56;
const GAP = 22;
/** 列标题带：标题基线 20，分隔线 30，节点从 44 开始 */
const HEAD_H = 44;
const PAD_B = 16;
const R = 10;
const CORNER = 10;
/**
 * 端口错位。
 *
 * 多条边共用同一个出入点时，各让开 3.2px。不这么做的话，两条不同颜色的边
 * 会**精确重叠**在同一条水平线上，画出来是一条渐变色的线 ——
 * 既看不出是两条，也看不出哪条来自私有、哪条来自已验证。
 */
const PORT_GAP = 4.4;

const COLUMNS: Array<[keyof typeof COL, string]> = [
  ['tier', 'Trust tiers'],
  ['pool', 'Pools'],
  ['policy', 'Policies'],
  ['instance', 'Gateway'],
];

const TONE_COLOR: Record<Node['tone'], string> = {
  violet: 'var(--violet)',
  cyan: 'var(--cyan)',
  warn: 'var(--warn)',
  muted: 'var(--ov-6)',
};

const nodeColor = (tone: Node['tone']): string => TONE_COLOR[tone];
const edgeColor = (tone: Edge['tone']): string => TONE_COLOR[tone];

const TIER_RANK: Record<string, number> = { PRIVATE_PROXY: 0, VERIFIED_PROXY: 1, PUBLIC_PROXY: 2 };

/**
 * 边的走线。
 *
 * 最初用的是三次贝塞尔直连。两列之间一旦出现「完全二部」关系
 * （私有/已验证 都同时进 Static / Low Latency 两个池），四条曲线
 * 会在同一个点上交叉成一个 X —— 顺着线看过去分不清谁连谁，
 * 反而把这张图唯一要回答的问题（公开代理去了哪）搅浑了。
 *
 * 改成正交折线 + 独立车道：
 *   · 同行的边直接拉直线，保留「这条就是直的」这个视觉提示；
 *   · 需要拐弯的边在间隙里各占一条竖直车道，交叉变成十字而不是斜穿；
 *   · 端口不扇出 —— 多条边在同一条水平线上汇入同一个节点是**正确**的，
 *     那正是「两个分级都能进这个池」。给每条边错开 5px 反而会画出两条
 *     贴在一起的平行线，让人以为是两条不同的链路。
 */
function routeEdge(x1: number, y1: number, x2: number, y2: number, laneX: number): string {
  if (Math.abs(y2 - y1) < 1) return `M${x1},${y1} L${x2},${y1}`;
  const dy = y2 - y1;
  const r = Math.min(CORNER, Math.abs(dy) / 2, (laneX - x1) / 2, (x2 - laneX) / 2);
  const dir = dy > 0 ? 1 : -1;
  return (
    `M${x1},${y1} L${laneX - r},${y1}` +
    ` Q${laneX},${y1} ${laneX},${y1 + dir * r}` +
    ` L${laneX},${y2 - dir * r}` +
    ` Q${laneX},${y2} ${laneX + r},${y2}` +
    ` L${x2},${y2}`
  );
}

/** 图例：线型比文字更省地方，也更准确 */
const LEGEND: Array<[Edge['tone'], string, boolean]> = [
  ['violet', 'Formal chain', false],
  ['cyan', 'Verified chain', false],
  ['warn', 'Isolated path', true],
  ['muted', 'Disabled', false],
];

export function Topology(): JSX.Element {
  const { t } = useI18n();
  /** 悬停 = 临时预览；点击 = 固定。两者分开，否则鼠标一移开高亮就散了 */
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const active = pinned ?? hover;

  const pools = useAsync(() => api.pools(), []);
  const policies = useAsync(() => api.policies(), []);
  const instances = useAsync(() => api.gatewayInstances(), []);

  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPinned(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned]);

  const graph = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];

    const poolList = pools.data?.items ?? [];
    const policyList = policies.data?.items ?? [];
    const instList = instances.data?.items ?? [];

    // 只展示实际被池引用的分级，避免出现孤立节点
    const tierSet = new Set<string>();
    for (const p of poolList) for (const tier of p.allowedTiers) tierSet.add(tier);

    /**
     * 列内排序 = 减少交叉。
     *
     * 接口按名字/创建时间返回，和连接关系无关。之前照原样铺下来，
     * 「Static Stable 池 → :18080」这种一一对应的关系在图上全成了
     * 交叉的折线 —— 本来应该是三条水平直线。
     *
     * 用重心法（barycenter）排序：每一列按它连到上一列的平均位置排。
     * 一一对应的关系会自然对齐成直线，剩下的交叉才是真正必要的交叉。
     */
    const poolIndex = new Map(poolList.map((p, i) => [p.id, i]));

    const tierHits = new Map<string, number[]>();
    for (const p of poolList) {
      for (const tier of p.allowedTiers) {
        if (!tierSet.has(tier)) continue;
        const arr = tierHits.get(tier);
        if (arr) arr.push(poolIndex.get(p.id)!);
        else tierHits.set(tier, [poolIndex.get(p.id)!]);
      }
    }
    const bary = (xs: number[] | undefined): number =>
      xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 99;
    const tiers = [...tierSet].sort(
      (a, b) =>
        bary(tierHits.get(a)) - bary(tierHits.get(b)) || (TIER_RANK[a] ?? 9) - (TIER_RANK[b] ?? 9),
    );

    const sortedPolicies = [...policyList].sort(
      (a, b) => (poolIndex.get(a.poolId) ?? 99) - (poolIndex.get(b.poolId) ?? 99) || a.priority - b.priority,
    );

    const instHits = new Map<string, number[]>();
    sortedPolicies.forEach((pol, i) => {
      if (!pol.instanceId) return;
      const arr = instHits.get(pol.instanceId);
      if (arr) arr.push(i);
      else instHits.set(pol.instanceId, [i]);
    });
    const sortedInstances = [...instList].sort(
      (a, b) => bary(instHits.get(a.id)) - bary(instHits.get(b.id)) || a.name.localeCompare(b.name),
    );

    // 各列节点数不同，但必须共用同一条带：先把最高的一列算出来，
    // 其余列在带内垂直居中。之前用固定 420 高度居中，三节点列会被推到
    // y=145，列标题和第一个节点之间空出 130px，看着像渲染失败。
    const maxN = Math.max(tiers.length, poolList.length, sortedPolicies.length, sortedInstances.length, 1);
    const bandH = maxN * NODE_H + (maxN - 1) * GAP;
    const canvasH = HEAD_H + bandH + PAD_B;

    const layout = (n: number): number[] => {
      const totalH = n * NODE_H + (n - 1) * GAP;
      const start = HEAD_H + (bandH - totalH) / 2;
      return Array.from({ length: n }, (_, i) => start + i * (NODE_H + GAP));
    };

    const tierY = layout(tiers.length);
    tiers.forEach((tier, i) => {
      nodes.push({
        id: `tier:${tier}`,
        kind: 'tier',
        label: t(tierLabel[tier] ?? tier),
        sub: tier === 'PUBLIC_PROXY' ? t('Isolated') : t('Gateway eligible'),
        x: COL.tier,
        y: tierY[i]!,
        w: NODE_W.tier,
        h: NODE_H,
        tone: tier === 'PRIVATE_PROXY' ? 'violet' : tier === 'VERIFIED_PROXY' ? 'cyan' : 'warn',
        live: null,
        isolated: tier === 'PUBLIC_PROXY',
      });
    });

    const poolY = layout(poolList.length);
    poolList.forEach((p, i) => {
      nodes.push({
        id: `pool:${p.id}`,
        kind: 'pool',
        label: p.name,
        sub: `${p.memberCount} ${t('members')}${p.experimental ? ` · ${t('experimental')}` : ''}`,
        x: COL.pool,
        y: poolY[i]!,
        w: NODE_W.pool,
        h: NODE_H,
        tone: p.experimental ? 'warn' : 'cyan',
        live: p.health.healthy > 0,
        isolated: p.experimental,
      });
      for (const tier of p.allowedTiers) {
        if (!tierSet.has(tier)) continue;
        edges.push({
          from: `tier:${tier}`,
          to: `pool:${p.id}`,
          tone: tier === 'PUBLIC_PROXY' ? 'warn' : tier === 'PRIVATE_PROXY' ? 'violet' : 'cyan',
          dashed: tier === 'PUBLIC_PROXY',
        });
      }
    });

    const policyY = layout(sortedPolicies.length);
    sortedPolicies.forEach((pol, i) => {
      nodes.push({
        id: `policy:${pol.id}`,
        kind: 'policy',
        // 策略的身份是端口，不是名字 —— 配置文件里就是按端口对齐的
        label: `:${pol.listenPort}`,
        sub: `${pol.strategy}${pol.maxMembers ? ` · ≤${pol.maxMembers}` : ''}`,
        mono: true,
        x: COL.policy,
        y: policyY[i]!,
        w: NODE_W.policy,
        h: NODE_H,
        tone: pol.enabled ? 'violet' : 'muted',
        live: pol.enabled,
      });
      edges.push({
        from: `pool:${pol.poolId}`,
        to: `policy:${pol.id}`,
        tone: pol.enabled ? 'violet' : 'muted',
      });
      if (pol.instanceId) {
        edges.push({
          from: `policy:${pol.id}`,
          to: `inst:${pol.instanceId}`,
          tone: pol.enabled ? 'violet' : 'muted',
        });
      }
    });

    const instY = layout(sortedInstances.length);
    sortedInstances.forEach((inst, i) => {
      nodes.push({
        id: `inst:${inst.id}`,
        kind: 'instance',
        label: inst.name,
        sub: `${inst.bindHost}:${inst.httpPort}`,
        mono: true,
        x: COL.instance,
        y: instY[i]!,
        w: NODE_W.instance,
        h: NODE_H,
        tone: inst.name.includes('lab') ? 'warn' : 'cyan',
        live: inst.status === 'APPLIED',
        isolated: inst.name.includes('lab'),
      });
    });

    return { nodes, edges, canvasH };
  }, [pools.data, policies.data, instances.data, t]);

  const loading = pools.loading || policies.loading || instances.loading;
  const error = pools.error ?? policies.error ?? instances.error;

  // 有向一跳：上游 + 下游各一次，不做全图传播（否则点一个节点全亮，等于没高亮）
  const connected = useMemo(() => {
    if (!active) return null;
    const set = new Set<string>([active]);
    for (const e of graph.edges) {
      if (e.from === active) set.add(e.to);
      if (e.to === active) set.add(e.from);
    }
    return set;
  }, [active, graph.edges]);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  /** 每条边的最终 path，走线规则见 routeEdge 上方注释 */
  const paths = useMemo(() => {
    const cy = (n: Node): number => n.y + n.h / 2;
    const gapKey = (a: Node, b: Node): string => `${a.kind}>${b.kind}`;

    // 0. 端口错位：按「另一端的高度」给同一出/入点的边排序，
    //    再按序号均分。排序保证上边的来源走上边的端口，端口处不会交叉。
    const byOut = new Map<string, Edge[]>();
    const byIn = new Map<string, Edge[]>();
    const push = (m: Map<string, Edge[]>, k: string, e: Edge): void => {
      const arr = m.get(k);
      if (arr) arr.push(e);
      else m.set(k, [e]);
    };
    for (const e of graph.edges) {
      push(byOut, e.from, e);
      push(byIn, e.to, e);
    }
    const outOff = new Map<Edge, number>();
    const inOff = new Map<Edge, number>();
    const spread = (list: Edge[], far: 'to' | 'from', into: Map<Edge, number>): void => {
      const sorted = [...list].sort((x, y) => {
        const nx = byId.get(x[far]);
        const ny = byId.get(y[far]);
        return (nx ? cy(nx) : 0) - (ny ? cy(ny) : 0);
      });
      const n = sorted.length;
      sorted.forEach((e, i) => into.set(e, (i - (n - 1) / 2) * PORT_GAP));
    };
    for (const list of byOut.values()) spread(list, 'to', outOff);
    for (const list of byIn.values()) spread(list, 'from', inOff);

    const y1Of = (n: Node, e: Edge): number => cy(n) + (outOff.get(e) ?? 0);
    const y2Of = (n: Node, e: Edge): number => cy(n) + (inOff.get(e) ?? 0);

    // 1. 找出每个间隙里「需要拐弯」的边
    const turners = new Map<string, Edge[]>();
    for (const e of graph.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b || Math.abs(y1Of(a, e) - y2Of(b, e)) < 1) continue;
      push(turners, gapKey(a, b), e);
    }

    // 2. 车道按**目标**分配，而不是按边。
    //    同一个目标的入边共用一条竖直干线，汇流后走一条水平线进节点 ——
    //    这正是「两个分级都能进这个池」的正确画法，也天然把
    //    「私有→Static、已验证→Low Latency」这种对调关系画成干净的 H 形，
    //    而不是两条互相穿过的斜线。
    const laneX = new Map<string, number>();
    for (const [k, list] of turners) {
      const [sk, tk] = k.split('>') as [Node['kind'], Node['kind']];
      const targets = [...new Set(list.map((e) => e.to))]
        .map((id) => byId.get(id))
        .filter((n): n is Node => !!n)
        .sort((a, b) => cy(a) - cy(b));
      const gx0 = COL[sk] + NODE_W[sk];
      const gx1 = COL[tk];
      targets.forEach((tgt, i) => {
        const f = targets.length === 1 ? 0.5 : 0.28 + 0.44 * (i / (targets.length - 1));
        laneX.set(`${k}|${tgt.id}`, gx0 + (gx1 - gx0) * f);
      });
    }

    return graph.edges.map((e) => {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) return { e, d: '' };

      const y1 = y1Of(a, e);
      const y2 = y2Of(b, e);
      const gx0 = a.x + a.w;
      const gx1 = b.x;
      const lx = laneX.get(`${gapKey(a, b)}|${b.id}`) ?? gx0 + (gx1 - gx0) / 2;

      return {
        e,
        d: Math.abs(y1 - y2) < 1 ? `M${gx0},${y1} L${gx1},${y1}` : routeEdge(gx0, y1, gx1, y2, lx),
      };
    });
  }, [graph, byId]);

  /**
   * 入向箭头。
   *
   * 每个**节点**一个，画在节点左边框中点，而不是每条边一个。
   * 两条边汇入同一个池时，端口只差 4.4px，两个 6px 高的箭头会叠成一团；
   * 而且两条边的颜色不同（私有是紫、已验证是青），一个箭头染哪个色都是错的。
   * 箭头表达的是「流向」，不是「色调」，所以用中性色。
   */
  const arrows = useMemo(
    () =>
      graph.nodes
        .filter((n) => graph.edges.some((e) => e.to === n.id))
        .map((n) => ({ id: n.id, x: n.x - 5, y: n.y + n.h / 2 })),
    [graph],
  );

  return (
    <div className="screen">
      <div className="page-head">
        <div>
          <div className="t-eyebrow">{t('Data plane map')}</div>
          <h1 className="t-title">{t('Topology')}</h1>
          <p className="t-desc">{t('Public proxies never enter the formal gateway')}</p>
        </div>
        <div className="head-actions">
          <button
            className="btn ghost sm"
            onClick={() => {
              pools.reload();
              policies.reload();
              instances.reload();
            }}
          >
            <Icon name="refresh" size={13} />
            {t('Refresh')}
          </button>
        </div>
      </div>

      {error && <ErrorNote message={error} />}

      <Panel
        title={t('Data plane')}
        sub={`${graph.nodes.length} ${t('nodes')} · ${graph.edges.length} ${t('edges')}`}
        fill
      >
        {loading ? (
          <Skeleton rows={6} />
        ) : graph.nodes.length === 0 ? (
          <Empty text={t('No pools')} />
        ) : (
          <>
            <div className="topo-wrap">
              <svg
                viewBox={`0 0 ${CANVAS_W} ${graph.canvasH}`}
                className="topo-svg"
                role="img"
                aria-label={t('Data plane')}
                onClick={() => setPinned(null)}
                // 离开画布才清悬停。绑在节点上不行 —— 节点之间有间隙，
                // 从卡片移到缝隙的那一刻会先触发 leave，高亮闪一下再回来。
                onMouseLeave={() => setHover(null)}
              >
                <defs>
                  {/* 节点填充：顶部略亮、底部略沉，中间线性过渡。
                      深色下这是卡片"立起来"的唯一线索 —— 阴影在 SVG 里既贵又糊，
                      而纯平涂的矩形看起来像一张贴纸。差值必须小到看不出"条带"，
                      只能感觉到上下有一点点明度差。 */}
                  <linearGradient id="pf-topo-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" style={{ stopColor: 'var(--node-top)' }} />
                    <stop offset="55%" style={{ stopColor: 'var(--node-fill)' }} />
                    <stop offset="100%" style={{ stopColor: 'var(--node-fill-b)' }} />
                  </linearGradient>
                  <linearGradient id="pf-topo-fill-hot" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" style={{ stopColor: 'var(--node-hover)' }} />
                    <stop offset="55%" style={{ stopColor: 'var(--node-hover)' }} />
                    <stop offset="100%" style={{ stopColor: 'var(--node-fill)' }} />
                  </linearGradient>
                  <pattern id="pf-topo-dots" width="20" height="20" patternUnits="userSpaceOnUse">
                    <circle cx="1" cy="1" r="1" style={{ fill: 'var(--ov-2)' }} />
                  </pattern>
                </defs>

                {/* 点阵底纹：给画布一点"图纸"的质感，同时不干扰走线 */}
                <rect width={CANVAS_W} height={graph.canvasH} fill="url(#pf-topo-dots)" />

                {COLUMNS.map(([kind, label], i) => (
                  <g key={kind}>
                    {/* 序号：这张图的本质是一条流水线（分级→池→策略→实例），
                        编号比"这列有几个节点"更能说明它读的方向。 */}
                    <text
                      x={COL[kind]}
                      y={20}
                      style={{ fill: 'var(--text-4)', fontSize: 9, fontFamily: 'var(--mono)' }}
                    >
                      {String(i + 1).padStart(2, '0')}
                    </text>
                    {/* 标题从 +22 起，正好和节点卡里的标题左对齐 */}
                    <text
                      x={COL[kind] + 22}
                      y={20}
                      style={{
                        fill: 'var(--text-3)',
                        fontSize: 9.5,
                        fontWeight: 600,
                        letterSpacing: '.15em',
                        textTransform: 'uppercase',
                      }}
                    >
                      {t(label)}
                    </text>
                    <path
                      d={`M${COL[kind]},30 L${COL[kind] + NODE_W[kind]},30`}
                      style={{ stroke: 'var(--ov-4)', strokeWidth: 1 }}
                    />
                  </g>
                ))}

                {paths.map(({ e, d }, i) => {
                  if (!d) return null;
                  // 未参与高亮的边压到几乎看不见，但仍然保留 ——
                  // 直接不画会让「点了一个节点」看起来像图被重排了。
                  const dim = connected ? !(connected.has(e.from) && connected.has(e.to)) : false;
                  const col = edgeColor(e.tone);
                  return (
                    <g key={i}>
                      {/* 外发光：一条 5px 的淡描边垫在下面，细线才不像一根划痕 */}
                      <path
                        d={d}
                        style={{
                          fill: 'none',
                          stroke: col,
                          strokeWidth: 5,
                          opacity: dim ? 0.03 : 0.075,
                          strokeLinejoin: 'round',
                          vectorEffect: 'non-scaling-stroke',
                          transition: 'opacity .18s',
                        }}
                      />
                      <path
                        d={d}
                        style={{
                          fill: 'none',
                          stroke: col,
                          strokeWidth: dim ? 1 : 1.35,
                          opacity: dim ? 0.1 : 0.62,
                          strokeDasharray: e.dashed ? '4 4' : undefined,
                          strokeLinejoin: 'round',
                          vectorEffect: 'non-scaling-stroke',
                          transition: 'opacity .18s,stroke-width .18s',
                        }}
                      />
                    </g>
                  );
                })}

                {/* 箭头：数据面是单向的，没有箭头就只能算「连线」，不算「流向」 */}
                {arrows.map((a) => {
                  const dim = connected
                    ? !graph.edges.some((e) => e.to === a.id && connected.has(e.from))
                    : false;
                  return (
                    <path
                      key={a.id}
                      d={`M${a.x - 5},${a.y - 3.4} L${a.x},${a.y} L${a.x - 5},${a.y + 3.4}`}
                      style={{
                        fill: 'none',
                        stroke: 'var(--text-3)',
                        strokeWidth: 1.4,
                        opacity: dim ? 0.12 : 0.8,
                        strokeLinecap: 'round',
                        strokeLinejoin: 'round',
                        vectorEffect: 'non-scaling-stroke',
                        transition: 'opacity .18s',
                      }}
                    />
                  );
                })}

                {graph.nodes.map((n) => {
                  const dim = connected ? !connected.has(n.id) : false;
                  const isActive = active === n.id;
                  return (
                    <g
                      key={n.id}
                      className="topo-node"
                      onMouseEnter={() => setHover(n.id)}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setPinned((p) => (p === n.id ? null : n.id));
                      }}
                      style={{ opacity: dim ? 0.3 : 1, transition: 'opacity .18s' }}
                    >
                      <title>{`${n.label} · ${n.sub}`}</title>

                      {pinned === n.id && (
                        <rect
                          x={n.x - 3.5}
                          y={n.y - 3.5}
                          width={n.w + 7}
                          height={n.h + 7}
                          rx={R + 3}
                          style={{ fill: 'none', stroke: 'var(--violet)', strokeWidth: 1, opacity: 0.4 }}
                        />
                      )}

                      <rect
                        x={n.x}
                        y={n.y}
                        width={n.w}
                        height={n.h}
                        rx={R}
                        className="topo-card"
                        fill={isActive ? 'url(#pf-topo-fill-hot)' : 'url(#pf-topo-fill)'}
                        style={{
                          stroke: n.isolated
                            ? 'color-mix(in srgb, var(--warn) 52%, transparent)'
                            : isActive
                              ? 'color-mix(in srgb, var(--violet) 55%, transparent)'
                              : 'var(--ov-5)',
                          strokeWidth: 1,
                          strokeDasharray: n.isolated ? '5 4' : undefined,
                          transition: 'stroke .16s',
                        }}
                      />

                      {/* 类别色条：贴在左内边，比整块染色克制，也不会和状态色打架 */}
                      <rect
                        x={n.x + 11}
                        y={n.y + 14}
                        width={3}
                        height={n.h - 28}
                        rx={1.5}
                        style={{ fill: nodeColor(n.tone) }}
                      />

                      <text
                        x={n.x + 22}
                        y={n.y + 24}
                        style={{
                          fill: 'var(--text)',
                          fontSize: n.mono ? 12.5 : 12.5,
                          fontWeight: 550,
                          fontFamily: n.mono ? 'var(--mono)' : 'var(--sans)',
                          letterSpacing: n.mono ? '-.02em' : '-.006em',
                        }}
                      >
                        {n.label}
                      </text>
                      <text
                        x={n.x + 22}
                        y={n.y + 40}
                        style={{
                          fill: 'var(--text-3)',
                          fontSize: 10,
                          fontFamily: n.mono ? 'var(--mono)' : 'var(--sans)',
                          letterSpacing: n.mono ? '0' : '.005em',
                        }}
                      >
                        {n.sub}
                      </text>

                      {/* 存活点：分级是分类不是活对象，所以不画 */}
                      {n.live !== null && (
                        <>
                          <circle
                            cx={n.x + n.w - 15}
                            cy={n.y + n.h / 2}
                            r={5.5}
                            style={{
                              fill: n.live ? 'var(--success)' : 'var(--warn)',
                              opacity: 0.16,
                            }}
                          />
                          <circle
                            cx={n.x + n.w - 15}
                            cy={n.y + n.h / 2}
                            r={2.6}
                            style={{ fill: n.live ? 'var(--success)' : 'var(--warn)' }}
                          />
                        </>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="topo-legend">
              {/* 只列画布上真实出现的线型。摆一条「已停用」的灰线在没有任何
                  停用策略的图上，等于用图例讲一个不存在的状态。 */}
              {LEGEND.filter(([tone]) => graph.edges.some((e) => e.tone === tone)).map(
                ([tone, label, dashed]) => (
                  <span className="lg" key={label}>
                    <svg width="20" height="8" aria-hidden="true">
                      <path
                        d="M1,4 L19,4"
                        style={{
                          stroke: edgeColor(tone),
                          strokeWidth: 1.35,
                          opacity: 0.7,
                          strokeDasharray: dashed ? '4 3' : undefined,
                          fill: 'none',
                        }}
                      />
                    </svg>
                    {t(label)}
                  </span>
                ),
              )}
              <span className="lg-hint">
                {pinned ? t('Esc to unpin') : t('Hover to trace · click to pin')}
              </span>
            </div>
          </>
        )}
      </Panel>

      <div className="grid g-2" style={{ marginTop: 16 }}>
        <Panel title={t('Isolation rules')} sub="SEC-001 §6.2">
          <div
            className="panel-body prose-mono"
            style={{ display: 'grid', gap: 10, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.75 }}
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <Badge tone="warn">PUBLIC_PROXY</Badge>
              <span>
                {t('Routed to')} <span className="mono">PUBLIC_EXPERIMENTAL</span>
                {t(
                  ' by default. Only policies bound to the lab instance may reference it. Formal-chain members come from',
                )}{' '}
                <span className="mono">v_schedulable_endpoints</span>
                {t(', a view that contains no public proxies.')}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Badge tone="ok">VERIFIED / PRIVATE</Badge>
              <span>
                {t('May enter the formal gateway;')} <span className="mono">PRIVATE_PROXY</span>{' '}
                {t('additionally requires')} <span className="mono">explicit_gateway_grant</span>.
              </span>
            </div>
          </div>
        </Panel>

        <Panel title={t('Compile-time freeze')} sub="ADR-0007">
          <div
            className="panel-body prose-mono"
            style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.75 }}
          >
            {t(
              'One policy = one listen port. Members are written into the config at compile time. Requests never call back to the control plane — not a performance trade-off: once the HTTPS CONNECT tunnel is up, the control plane cannot read any request header, so per-request routing by header is not expressible in the protocol.',
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
