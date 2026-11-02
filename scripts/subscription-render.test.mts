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
  renderMihomoProvider,
  renderSingBox,
  renderSubscription,
  normalizeFormat,
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

check('maxNodes 越界被夹到 1–500', () => {
  assert.equal(normalizeNodeFilter({ maxNodes: 99_999 }).maxNodes, 500);
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

console.log('\n[7] proxy-provider 片段');

check('provider 只出 proxies，不带 mixed-port / dns / rules', () => {
  const body = renderMihomoProvider('pool-a', PROXIES, 'now');
  assert.ok(body.includes('proxies:'));
  assert.ok(!/^mixed-port:/m.test(body), 'provider 里出现 mixed-port 会覆盖用户主配置的监听端口');
  assert.ok(!/^dns:/m.test(body), 'provider 里出现 dns 会覆盖用户调好的 DNS');
  assert.ok(!/^rules:/m.test(body), 'provider 里出现 rules 会覆盖用户的分流规则');
  assert.ok(!/^proxy-groups:/m.test(body), 'proxy-groups 属于用户主配置，不属于 provider');
});

check('provider 与整份配置的节点块逐字一致', () => {
  const provider = renderMihomoProvider('pool-a', PROXIES, 'now');
  const full = renderMihomo('pool-a', PROXIES, 'now', 'global', []);
  const pickNodes = (s: string): string[] => {
    const lines = s.split('\n');
    const start = lines.findIndex((l) => l === 'proxies:');
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const l = lines[i]!;
      if (l.startsWith('  - ') || l.startsWith('    ')) out.push(l);
      else break;
    }
    return out;
  };
  // 两处各写一份序列化逻辑，迟早会分叉成"整配置里有 udp、provider 里没有"，
  // 同一批节点在不同用法下行为不一致，而用户只会觉得"这订阅时好时坏"。
  assert.deepEqual(pickNodes(provider), pickNodes(full));
});

check('空池 provider 输出 proxies: [] 而不是空文件', () => {
  const body = renderMihomoProvider('pool-a', [], 'now');
  assert.ok(body.includes('proxies: []'), '空文件会让 mihomo 报 provider 解析失败');
});

check('provider 文件里写明引用方式', () => {
  const body = renderMihomoProvider('PUBLIC_EXPERIMENTAL', PROXIES, 'now');
  // 拿到一份只有 proxies 的 YAML，第一反应是"配置不完整"，所以用法必须写进文件
  assert.ok(body.includes('proxy-providers:'));
  assert.ok(body.includes('use: [public_experimental]'));
});

check('normalizeFormat 认 provider 的几种叫法', () => {
  assert.equal(normalizeFormat('clash-provider'), 'clash-provider');
  assert.equal(normalizeFormat('provider'), 'clash-provider');
  assert.equal(normalizeFormat('mihomo-provider'), 'clash-provider');
  // 拼错时退回默认值，而不是悄悄给一份整配置 —— 后者会覆盖用户的 config.yaml
  assert.equal(normalizeFormat('clash'), 'clash');
  assert.equal(normalizeFormat('singbox'), 'singbox');
});

console.log('\n[8] 出口国家过滤');

const GEO = [
  { protocol: 'SOCKS5' as const, host: 'a', quality_score: 90, p50_ms: 100, country_code: 'JP' },
  { protocol: 'SOCKS5' as const, host: 'b', quality_score: 80, p50_ms: 200, country_code: 'SG' },
  { protocol: 'SOCKS5' as const, host: 'c', quality_score: 70, p50_ms: 300, country_code: null },
];

check('国家白名单排除未知国家', () => {
  // 用户写 countries:[JP] 是要日本节点，一个还没探出出口 IP 的节点
  // 不能算作"可能是日本" —— 放进去只会让订阅里出现一堆不该有的节点
  const kept = applyNodeFilter(GEO, { countries: ['JP'] });
  assert.deepEqual(kept.map((r) => r.host), ['a']);
});

check('国家黑名单保留未知国家', () => {
  // 反过来，"不要中国节点"不代表"只要已知非中国的节点"
  const kept = applyNodeFilter(GEO, { excludeCountries: ['SG'] });
  assert.deepEqual(kept.map((r) => r.host), ['a', 'c']);
});

check('国家码归一化：小写转大写，三字母丢弃', () => {
  const f = normalizeNodeFilter({ countries: ['jp', 'Sg', 'JPN', '  us  ', ''] });
  assert.deepEqual(f.countries, ['JP', 'SG', 'US']);
});

check('国家过滤与协议过滤可叠加', () => {
  const mixed = [
    ...GEO,
    { protocol: 'HTTP' as const, host: 'd', quality_score: 95, p50_ms: 50, country_code: 'JP' },
  ];
  const kept = applyNodeFilter(mixed, { protocols: ['SOCKS5'], countries: ['JP'] });
  assert.deepEqual(kept.map((r) => r.host), ['a']);
});

check('命名模板支持 {country}，未知国家退化成 ??', () => {
  const named = applyNameTemplate(
    [
      { name: '', protocol: 'SOCKS5', server: '1.1.1.1', port: 1, country: 'JP' },
      { name: '', protocol: 'SOCKS5', server: '2.2.2.2', port: 2, country: null },
    ],
    'pf-{country}-{index}',
    'pool-a',
  );
  // 空串会让名字变成 pf--01，而 ?? 一眼能看出这个节点还没探出地区
  assert.deepEqual(named.map((p) => p.name), ['pf-JP-01', 'pf-??-02']);
});

console.log('\n[9] 健康检查口径：必须是能转发 TLS 才算健康');

// 这一节钉的是一个曾经真实发生过的故障：探针判定 connect_ok=false 的节点
// （能转发明文 HTTP、但建不起 CONNECT 隧道）用 http:// 探测照样返回 204，
// 被 url-test 判为健康并选中，用户打开任何 https 站点直接失败，
// 而客户端界面显示"已连接、延迟 80ms"。
// 口径一旦退回 http://，症状就是「显示正常但上不了网」。

check('mihomo 的 url-test 用 https 探测，不用 http', () => {
  const yaml = renderMihomo('pool-a', PROXIES, 'now');
  assert.ok(yaml.includes('    type: url-test'));
  assert.ok(
    yaml.includes('    url: https://www.gstatic.com/generate_204'),
    '探测地址必须是 https —— http:// 会让只能明文转发的节点伪装成健康',
  );
  assert.ok(!yaml.includes('url: http://www.gstatic.com'), '不能残留 http 探测地址');
});

check('mihomo 的健康检查间隔收紧到 3 分钟内（免费代理存活期很短）', () => {
  const yaml = renderMihomo('pool-a', PROXIES, 'now');
  const m = /^ {4}interval: (\d+)$/m.exec(yaml);
  assert.ok(m, 'url-test 必须带 interval');
  const secs = Number(m[1]);
  assert.ok(secs <= 180, `间隔 ${secs}s 太长，节点死后要等这么久才切换`);
  assert.ok(secs >= 60, `间隔 ${secs}s 太短，健康检查本身会成为负担`);
});

check('provider 片段里的用法示例与整份配置口径一致', () => {
  const yaml = renderMihomoProvider('pool-a', PROXIES, 'now');
  // 注释里写 http:// 会把人带进同一个坑：照抄示例，得到一份测不出问题的配置
  assert.ok(yaml.includes('#         url: https://www.gstatic.com/generate_204'));
  assert.ok(!yaml.includes('url: http://www.gstatic.com'));
});

check('sing-box 生成 urltest 自动选优组，而不是裸 selector', () => {
  const cfg = JSON.parse(renderSingBox('pool-a', PROXIES, 'now', 'rule'));
  const auto = cfg.outbounds.find((o: { type: string }) => o.type === 'urltest');
  assert.ok(auto, '必须有 urltest 组：几百个节点让用户逐个手点等于没有选择功能');
  assert.equal(auto.url, 'https://www.gstatic.com/generate_204');
  assert.ok(Array.isArray(auto.outbounds) && auto.outbounds.length === PROXIES.length);
  // 每个成员都必须是真实存在的节点 tag，否则 sing-box 启动即报错
  const tags = new Set(cfg.outbounds.map((o: { tag: string }) => o.tag));
  for (const t of auto.outbounds) assert.ok(tags.has(t), `urltest 引用了不存在的节点：${t}`);
});

check('sing-box 的 selector 默认指向 urltest，同时保留手动锁定', () => {
  const cfg = JSON.parse(renderSingBox('pool-a', PROXIES, 'now', 'rule'));
  const sel = cfg.outbounds.find((o: { tag: string }) => o.tag === 'pool-a');
  const auto = cfg.outbounds.find((o: { type: string }) => o.type === 'urltest');
  assert.equal(sel.type, 'selector');
  assert.equal(sel.default, auto.tag, '默认必须是自动选优');
  assert.equal(sel.outbounds[0], auto.tag, '自动组要排在第一位');
  // 自动组之外还要能选到每一个具体节点
  assert.equal(sel.outbounds.length, PROXIES.length + 1);
  // route.final 指向 selector，selector 再落到 urltest —— 链路不能断
  assertOutboundsExist(cfg);
  assert.equal(cfg.route.final, 'pool-a');
});

check('空池不生成 urltest / selector（空成员数组会让 sing-box 启动失败）', () => {
  const cfg = JSON.parse(renderSingBox('pool-a', [], 'now', 'rule'));
  assert.equal(cfg.outbounds.filter((o: { type: string }) => o.type === 'urltest').length, 0);
  assert.equal(cfg.outbounds.filter((o: { type: string }) => o.type === 'selector').length, 0);
  assert.equal(cfg.route.final, 'direct');
});

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
