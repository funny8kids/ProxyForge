/**
 * 订阅渲染回归测试。
 *
 * 覆盖三种分流模式 × 两种结构化格式，外加过滤与命名的边界。
 * 断言的重点不是"字符串长什么样"，而是**这些配置能不能被客户端加载**：
 *   · mihomo 的 rules 必须是合法 YAML 序列（整行引用，不能半引用）
 *   · sing-box 的 route.rules 里出现的每个 outbound 必须真实存在
 *   · 空池不能 MATCH 到一个没有成员的组
 *
 * 跑法：npm run test:render
 */
import assert from 'node:assert/strict';
import {
  renderMihomo,
  renderSingBox,
  renderSubscription,
  normalizeRoutingMode,
  type ExportProxy,
} from '../apps/api/src/modules/subscription/render.js';
import { applyNameTemplate, applyNodeFilter, normalizeNodeFilter } from '../apps/api/src/modules/subscription/filter.js';

let pass = 0;
let fail = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${(err as Error).message.split('\n').join('\n    ')}`);
  }
}

const PROXIES: ExportProxy[] = [
  { name: 'pf-01', protocol: 'SOCKS5', server: '1.2.3.4', port: 1080 },
  { name: 'pf-02', protocol: 'HTTP', server: '5.6.7.8', port: 8080, username: 'u', password: 'p' },
  { name: 'pf-03', protocol: 'SOCKS4', server: '9.9.9.9', port: 1081 },
];

/** 把 mihomo 输出的 rules 段抽出来，用于逐行断言 */
function rulesOf(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.indexOf('rules:');
  assert.ok(start >= 0, '输出里没有 rules 段');
  return lines
    .slice(start + 1)
    .filter((l) => l.startsWith('  - '))
    .map((l) => l.slice(4));
}

console.log('\n[1] mihomo · 三种分流模式');

check('global：只有一条 MATCH 指向本池', () => {
  const rules = rulesOf(renderMihomo('pool-a', PROXIES, 'now', 'global'));
  assert.deepEqual(rules, ['"MATCH,pool-a"']);
});

check('rule：内网 + CN 直连，末尾 MATCH 走代理', () => {
  const rules = rulesOf(renderMihomo('pool-a', PROXIES, 'now', 'rule'));
  assert.ok(rules.some((r) => r.includes('GEOIP,CN,DIRECT')), '缺少 GEOIP,CN');
  assert.ok(rules.some((r) => r.includes('IP-CIDR,10.0.0.0/8,DIRECT,no-resolve')), '缺少内网段');
  assert.equal(rules.at(-1), '"MATCH,pool-a"', '末尾必须是 MATCH 到池');
});

check('direct：末尾 MATCH 直连', () => {
  const rules = rulesOf(renderMihomo('pool-a', PROXIES, 'now', 'direct'));
  assert.equal(rules.at(-1), '"MATCH,DIRECT"');
});

check('rule 模式带 DNS 段，global 模式不带', () => {
  assert.ok(renderMihomo('p', PROXIES, 'now', 'rule').includes('enhanced-mode: fake-ip'));
  assert.ok(!renderMihomo('p', PROXIES, 'now', 'global').includes('enhanced-mode'));
});

console.log('\n[2] 用户自写规则');

check('用户规则排在内建规则之前', () => {
  const rules = rulesOf(
    renderMihomo('pool-a', PROXIES, 'now', 'rule', ['DOMAIN-SUFFIX,example.com,DIRECT']),
  );
  assert.equal(rules[0], '"DOMAIN-SUFFIX,example.com,DIRECT"');
});

check('组名写错时归到本池，不产出悬空组引用', () => {
  const rules = rulesOf(renderMihomo('pool-a', PROXIES, 'now', 'global', ['DOMAIN,x.com,自动选择']));
  assert.deepEqual(rules, ['"DOMAIN,x.com,pool-a"', '"MATCH,pool-a"']);
});

check('非法行（空行 / 注释 / 缺值）被丢弃而不是渲染出去', () => {
  const rules = rulesOf(
    renderMihomo('pool-a', PROXIES, 'now', 'global', ['', '# 注释', 'DOMAIN-SUFFIX', '   ']),
  );
  assert.deepEqual(rules, ['"MATCH,pool-a"']);
});

check('direct 模式下用户规则仍然生效', () => {
  const rules = rulesOf(renderMihomo('p', PROXIES, 'now', 'direct', ['DOMAIN,a.com,REJECT']));
  assert.deepEqual(rules, ['"DOMAIN,a.com,REJECT"', '"MATCH,DIRECT"']);
});

console.log('\n[3] 空池');

check('mihomo 空池走直连，不 MATCH 到空组', () => {
  const yaml = renderMihomo('pool-a', [], 'now', 'global');
  assert.ok(yaml.includes('proxies: []'));
  assert.deepEqual(rulesOf(yaml), ['MATCH,DIRECT']);
});

check('sing-box 空池 final 指向 direct', () => {
  const cfg = JSON.parse(renderSingBox('pool-a', [], 'now', 'rule'));
  assert.equal(cfg.route.final, 'direct');
  assert.ok(!cfg.outbounds.some((o: { tag: string }) => o.tag === 'pool-a'), '空池不该建 selector');
});

console.log('\n[4] sing-box 结构合法性');

function assertOutboundsExist(cfg: { outbounds: Array<{ tag: string }>; route: { rules: Array<{ outbound: string }>; final: string } }): void {
  const tags = new Set(cfg.outbounds.map((o) => o.tag));
  for (const r of cfg.route.rules) {
    assert.ok(tags.has(r.outbound), `规则引用了不存在的 outbound：${r.outbound}`);
  }
  assert.ok(tags.has(cfg.route.final), `final 引用了不存在的 outbound：${cfg.route.final}`);
}

check('rule 模式：所有 outbound 引用都存在', () => {
  const cfg = JSON.parse(renderSingBox('pool-a', PROXIES, 'now', 'rule'));
  assertOutboundsExist(cfg);
  assert.equal(cfg.route.final, 'pool-a');
});

check('rule 模式：GEOIP 转成 rule_set，不用已被移除的 geoip 字段', () => {
  const cfg = JSON.parse(renderSingBox('pool-a', PROXIES, 'now', 'rule'));
  assert.ok(Array.isArray(cfg.route.rule_set) && cfg.route.rule_set.length === 1);
  assert.equal(cfg.route.rule_set[0].tag, 'geoip-cn');
  assert.ok(cfg.route.rule_set[0].url.endsWith('/geoip-cn.srs'));
  assert.ok(cfg.route.rules.some((r: { rule_set?: string }) => r.rule_set === 'geoip-cn'));
  assert.ok(!JSON.stringify(cfg.route.rules).includes('"geoip"'), '不该出现 geoip 字段');
});

check('direct 模式：final 是 direct', () => {
  const cfg = JSON.parse(renderSingBox('pool-a', PROXIES, 'now', 'direct'));
  assertOutboundsExist(cfg);
  assert.equal(cfg.route.final, 'direct');
});

check('无法映射的规则记进 ignoredRules，不静默消失', () => {
  const cfg = JSON.parse(renderSingBox('pool-a', PROXIES, 'now', 'global', ['RULE-SET,my-set,DIRECT']));
  assert.deepEqual(cfg._proxyforge.ignoredRules, ['RULE-SET,my-set']);
});

check('SOCKS4 带 version 字段，否则会被当成 SOCKS5 握手', () => {
  const cfg = JSON.parse(renderSingBox('pool-a', PROXIES, 'now', 'global'));
  const s4 = cfg.outbounds.find((o: { tag: string }) => o.tag === 'pf-03');
  assert.equal(s4.version, '4');
  assert.equal(s4.username, undefined, 'SOCKS4 不该带用户名');
});

console.log('\n[5] 过滤与命名');

const ROWS = [
  { protocol: 'SOCKS5' as const, host: 'a.example.com', quality_score: '90', p50_ms: 80 },
  { protocol: 'SOCKS5' as const, host: 'b.example.com', quality_score: '40', p50_ms: 900 },
  { protocol: 'HTTP' as const, host: 'c.example.com', quality_score: '85', p50_ms: 120 },
  { protocol: 'HTTP' as const, host: 'd.amazonaws.com', quality_score: '95', p50_ms: null },
];

check('协议白名单', () => {
  const kept = applyNodeFilter(ROWS, { protocols: ['SOCKS5'] });
  assert.equal(kept.length, 2);
});

check('质量下限', () => {
  const kept = applyNodeFilter(ROWS, { minQuality: 86 });
  assert.deepEqual(kept.map((r) => r.host), ['a.example.com', 'd.amazonaws.com']);
});

check('延迟上限会排除"从未探测成功"的节点', () => {
  const kept = applyNodeFilter(ROWS, { maxLatencyMs: 200 });
  assert.deepEqual(kept.map((r) => r.host), ['a.example.com', 'c.example.com']);
});

check('主机名黑名单是子串匹配', () => {
  const kept = applyNodeFilter(ROWS, { excludeHosts: ['amazonaws'] });
  assert.equal(kept.length, 3);
});

check('maxNodes 越界被夹到 1–200', () => {
  assert.equal(normalizeNodeFilter({ maxNodes: 99_999 }).maxNodes, 200);
  assert.equal(normalizeNodeFilter({ maxNodes: 0 }).maxNodes, 1);
  assert.equal(normalizeNodeFilter({ maxNodes: 'abc' }).maxNodes, undefined);
});

check('未知字段被忽略，非法协议被剔除', () => {
  const f = normalizeNodeFilter({ protocols: ['socks5', 'telnet'], foo: 1 });
  assert.deepEqual(f.protocols, ['SOCKS5']);
  assert.equal((f as Record<string, unknown>)['foo'], undefined);
});

check('命名模板占位符替换', () => {
  const out = applyNameTemplate(PROXIES, '{pool}-{protocol}-{index}', 'pool-a');
  assert.equal(out[0]!.name, 'pool-a-socks5-01');
});

check('模板重名自动加后缀（mihomo 会拒绝重名配置）', () => {
  const out = applyNameTemplate(PROXIES, '{protocol}', 'pool-a');
  assert.deepEqual(out.map((p) => p.name), ['socks5', 'http', 'socks4']);
  const dup = applyNameTemplate([PROXIES[0]!, PROXIES[0]!], 'same', 'p');
  assert.deepEqual(dup.map((p) => p.name), ['same', 'same #2']);
});

check('空模板沿用默认名字', () => {
  assert.equal(applyNameTemplate(PROXIES, '   ', 'p')[0]!.name, 'pf-01');
});

console.log('\n[6] 格式分发');

check('未知 routingMode 回落到 global', () => {
  assert.equal(normalizeRoutingMode('bogus'), 'global');
  assert.equal(normalizeRoutingMode('rule'), 'rule');
});

check('renderSubscription 把 options 透传给两种结构化格式', () => {
  const yaml = renderSubscription('mihomo', 'pool-a', PROXIES, 'now', { routingMode: 'direct' });
  assert.ok(yaml.body.includes('"MATCH,DIRECT"'));
  const json = renderSubscription('singbox', 'pool-a', PROXIES, 'now', { routingMode: 'direct' });
  assert.equal(JSON.parse(json.body).route.final, 'direct');
});

check('base64 / plain 不受分流设置影响（它们不带规则）', () => {
  const a = renderSubscription('plain', 'pool-a', PROXIES, 'now', { routingMode: 'global' });
  const b = renderSubscription('plain', 'pool-a', PROXIES, 'now', { routingMode: 'rule' });
  assert.equal(a.body, b.body);
});

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
