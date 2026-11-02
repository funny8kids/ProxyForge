import { exec, q1 } from './client.js';
import { open, seal } from '../shared/crypto.js';

/**
 * 从环境变量注入 AI 供应商密钥。
 *
 * 为什么不在种子数据里写死密钥：
 *   1. 仓库是公开的，密钥一旦进 git 就等于泄露，且会留在历史里；
 *   2. 密钥轮换应该只是改一个环境变量再重启，而不是跑一次 `db:reset`。
 *
 * 幂等：每次启动都会调，但只有「库里没有」或「库里的值与环境变量不一致」时才写。
 * 比较方式是真解密后比对 —— 信封加密每次 nonce 都不同，直接比密文永远不相等。
 */
export interface BootstrapResult {
  applied: boolean;
  providerKey: string | null;
  detail: string;
}

const TARGETS: Array<{ providerKey: string; envVar: string; label: string }> = [
  { providerKey: 'deepseek-main', envVar: 'PF_DEEPSEEK_API_KEY', label: 'DeepSeek' },
];

export async function bootstrapAiFromEnv(): Promise<BootstrapResult[]> {
  const results: BootstrapResult[] = [];

  for (const target of TARGETS) {
    const plain = (process.env[target.envVar] ?? '').trim();
    if (!plain) {
      results.push({
        applied: false, providerKey: target.providerKey,
        detail: `未设置 ${target.envVar}`,
      });
      continue;
    }

    const provider = await q1<{ id: string; api_key_ref: string | null }>(
      'SELECT id, api_key_ref FROM ai_providers WHERE key = $1',
      [target.providerKey],
    );
    if (!provider) {
      results.push({
        applied: false, providerKey: target.providerKey,
        detail: `ai_providers 里没有 key=${target.providerKey}，跳过`,
      });
      continue;
    }

    // 已有密钥时先解密比对，避免每次启动都重写 secrets
    if (provider.api_key_ref) {
      const existing = await q1<{ ciphertext: string; nonce: string; key_version: number }>(
        `SELECT encode(ciphertext,'base64') AS ciphertext, encode(nonce,'base64') AS nonce, key_version
         FROM secrets WHERE ref = $1`,
        [provider.api_key_ref],
      );
      if (existing) {
        try {
          const current = open({
            ciphertext: Buffer.from(existing.ciphertext, 'base64'),
            nonce: Buffer.from(existing.nonce, 'base64'),
            keyVersion: existing.key_version,
          });
          if (current === plain) {
            results.push({
              applied: false, providerKey: target.providerKey,
              detail: '密钥未变化，沿用已存密文',
            });
            continue;
          }
        } catch {
          // 解不开（主密钥换过）→ 按"需要重写"处理
        }
      }
    }

    const ref = `secret://ai/${target.providerKey}`;
    const env = seal(plain);
    await exec(
      `INSERT INTO secrets (ref, kind, ciphertext, nonce, key_version, description)
       VALUES ($1,'AI_API_KEY',$2,$3,$4,$5)
       ON CONFLICT (ref) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext,
             nonce = EXCLUDED.nonce,
             key_version = EXCLUDED.key_version`,
      [ref, env.ciphertext, env.nonce, env.keyVersion, `AI Provider ${target.label}（来自环境变量）`],
    );
    await exec(
      'UPDATE ai_providers SET api_key_ref = $2, enabled = true, updated_at = now() WHERE id = $1',
      [provider.id, ref],
    );

    results.push({
      applied: true, providerKey: target.providerKey,
      detail: `已从 ${target.envVar} 注入密钥（AES-256-GCM 信封加密）`,
    });
  }

  return results;
}
