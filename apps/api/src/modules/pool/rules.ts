import { invalid } from '../../shared/errors.js';

/**
 * 池规则 DSL → SQL WHERE 编译器。
 *
 * 安全前提：**字段名必须走白名单**。绝不允许把 predicate 里的键
 * 直接拼进 SQL —— 那是教科书级的注入面。这里每个可过滤字段都映射到
 * 一个固定的列表达式，未知字段直接报错。
 *
 * DSL 形态：
 *   { "all": [ {"field":"qualityScore","op":"gte","value":70},
 *              {"field":"protocol","op":"in","value":["SOCKS5","HTTP"]} ] }
 *   也支持 { "any": [...] } 与嵌套。
 */

const FIELDS: Record<string, string> = {
  qualityScore: 's.quality_score',
  p50Ms: 's.p50_ms',
  p95Ms: 's.p95_ms',
  successRate24h: 's.success_rate_24h',
  trustTier: 'e.trust_tier',
  protocol: 'e.protocol',
  originType: 'e.origin_type',
  lifecycleStatus: 'e.lifecycle_status',
  authorizationStatus: 'e.authorization_status',
  countryCode: 'COALESCE(i.country_code, e.expected_country)',
  networkType: 'i.network_type',
  asn: 'i.asn',
  host: 'e.host',
};

const ENUM_CAST: Record<string, string> = {
  trustTier: 'trust_tier',
  protocol: 'proxy_protocol',
  originType: 'origin_type',
  lifecycleStatus: 'lifecycle_status',
  authorizationStatus: 'authorization_status',
  networkType: 'network_type',
};

const OPS: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

export interface CompiledRule {
  sql: string;
  params: unknown[];
}

interface Predicate {
  all?: Predicate[];
  any?: Predicate[];
  field?: string;
  op?: string;
  value?: unknown;
}

export function compilePredicate(input: unknown, startIndex = 1): CompiledRule {
  const params: unknown[] = [];
  const sql = build(input as Predicate, params, startIndex);
  return { sql, params };
}

/**
 * 占位符编号。
 *
 * 不能写成 `$${params.length}` —— 外层查询可能已经占用了 `$1`（例如
 * `trust_tier = ANY($1::text[])`），此时谓词的第一个参数必须从 `$2` 开始。
 * 之前忽略了 `startIndex`，谓词的 `$1` 与外层的 `$1` 撞在一起，
 * 于是 `s.quality_score >= $1` 拿到的是一整个 text[]，
 * 报 `operator does not exist: numeric >= text[]`。
 * 这个错被 worker 的 try/catch 吞成一行日志，表现为"池成员从不刷新"。
 */
function ph(params: unknown[], startIndex: number): string {
  return `$${startIndex + params.length - 1}`;
}

function build(node: Predicate, params: unknown[], startIndex: number): string {
  if (!node || typeof node !== 'object') {
    throw invalid('规则谓词必须是对象');
  }

  if (Array.isArray(node.all)) {
    if (node.all.length === 0) return 'TRUE';
    return `(${node.all.map((n) => build(n, params, startIndex)).join(' AND ')})`;
  }
  if (Array.isArray(node.any)) {
    if (node.any.length === 0) return 'FALSE';
    return `(${node.any.map((n) => build(n, params, startIndex)).join(' OR ')})`;
  }

  const field = node.field;
  if (!field || typeof field !== 'string') {
    throw invalid('规则条件缺少 field');
  }
  const column = FIELDS[field];
  if (!column) {
    throw invalid(`规则字段不在白名单内: ${field}`, [
      { field: 'predicate.field', message: `允许的字段: ${Object.keys(FIELDS).join(', ')}` },
    ]);
  }

  const op = node.op ?? 'eq';
  const cast = ENUM_CAST[field];

  if (op === 'in' || op === 'notIn') {
    if (!Array.isArray(node.value) || node.value.length === 0) {
      throw invalid(`字段 ${field} 的 ${op} 需要一个非空数组`);
    }
    params.push(node.value);
    const placeholder = ph(params, startIndex);
    const expr = cast ? `${column}::text = ANY(${placeholder}::text[])` : `${column} = ANY(${placeholder})`;
    return op === 'in' ? expr : `NOT (${expr})`;
  }

  if (op === 'contains') {
    params.push(node.value);
    return `${column}::text LIKE '%' || ${ph(params, startIndex)} || '%'`;
  }

  const sqlOp = OPS[op];
  if (!sqlOp) {
    throw invalid(`不支持的运算符: ${op}`, [
      { field: 'predicate.op', message: `允许: ${[...Object.keys(OPS), 'in', 'notIn', 'contains'].join(', ')}` },
    ]);
  }

  params.push(node.value);
  const placeholder = ph(params, startIndex);
  return cast
    ? `${column}::text ${sqlOp} ${placeholder}::text`
    : `${column} ${sqlOp} ${placeholder}`;
}
