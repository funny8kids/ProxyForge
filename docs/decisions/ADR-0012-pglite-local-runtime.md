# ADR-0012：本地运行时用 PGlite，worker 默认内嵌；PG 数组列在模块边界归一化

- 状态：Accepted
- 日期：2026-11-01
- 相关：[ADR-0011](./ADR-0011-typescript-primary.md)、[ADR-0002](./ADR-0002-three-planes.md)、[ARCH-001](../architecture/01-system-architecture.md)

## 背景

主干改用 TypeScript 后，数据库跑在 **PGlite** 上——PostgreSQL 16 编译成 WASM，进程内运行，数据落在一个目录里。它让 `schema-v1.sql` 能原样执行，但也带来两个只在真实运行时才暴露的约束。

### 约束一：PGlite 是单写者

PGlite 不是"一个可以多进程连的 PG 服务"，它**独占**自己的 data 目录。第二个进程打开同一目录会直接 `RuntimeError: Aborted()` 崩在 `initdb` 阶段，而不是给一个"数据库被占用"的友好错误。

而 ADR-0002 要求数据面与控制面分离：控制面挂掉，网关仍要转发。按字面实现就是两个进程（`api` + `worker`），于是本地开发必然自撞。

更糟的是进程被强杀后会残留 `postmaster.pid`，之后**每次**启动都 Aborted，看起来像目录永久损坏。

### 约束二：PG 的 ENUM 数组列在驱动层没有稳定表示

`resource_pools.allowed_tiers` 是 `trust_tier[]`，`policies.protocol_filter` 是 `proxy_protocol[]`。这两个自定义 ENUM 的 OID 不在 PGlite 内置的类型解析表里，于是同一列**有时**返回 `string[]`，**有时**返回 PG 的字面量字符串 `"{PRIVATE_PROXY,VERIFIED_PROXY}"`。

这个不确定性造成了一个非常隐蔽的 bug：策略编译器拿到的是字符串，`value.length > 0` 恒为真，于是给 SQL 加上了「成员分级必须在集合里」的过滤——而集合本身是个空集合。结果是**编译成功、告警为零、成员数为 0**。种子里 `gost-primary` 一直是 0 成员，直到把编译过程单独跑一遍才定位到。

## 决策

### 1. worker 默认内嵌在 API 进程里

`PF_WORKER_MODE` 两个值：

| 值 | 行为 | 用途 |
| --- | --- | --- |
| `embedded`（默认） | worker 循环以 `startWorker()` 挂在 API 进程内，随进程退出 | 本地开发、单机演示 |
| `process` | 独立进程跑 `worker/main.ts` | 接真实 PostgreSQL 后恢复 ADR-0002 的部署形态 |

`worker/main.ts` 因此被改造成**可被 import 的模块**：导出 `startWorker(): () => void`，只有被当作入口直接执行时才 `main()`。这样同一份循环代码在两种模式下完全一致，不存在"开发跑的逻辑和生产不是一套"。

### 2. 崩溃自愈只搬锁文件，不删数据

打开失败时检查 `postmaster.pid` / `.s.PGSQL.5432.lock*` 是否存在；存在则**移到** `.data/stale-locks/`（保留取证）后重试一次，不存在则原样抛出。不做 `rm -rf`，不自动重建目录。

### 3. 数组列在模块边界一律归一化

新增 `apps/api/src/shared/pg-array.ts` 的 `toTextArray(value): string[]`，处理三种输入：真数组、`{a,b}` 字面量（含引号与转义）、空串/`{}`。

**规则：任何从数据库读出的数组列，进入业务逻辑前必须过 `toTextArray`。** 归一化点放在模块边界（`applyPolicies`、`compilePolicy` 的入参），而不是散落在每个查询里——这样新增查询不会漏。

### 4. 编译结果必须自证

种子与 `POST /gateway/reload` 都会打印 `memberCount` 与告警码。**成员数为 0 且告警为空**是一个必须报警的状态：它意味着过滤条件把所有人排除了，而没有任何规则被触发。

## 后果

**正面**

- 本地一条 `npm run dev` 就能起完整系统，不需要容器、不需要外部 PG。
- 换真 PG 时只改一个环境变量，业务代码零改动。
- 数组列的问题被收敛到两个入口，不会再以「静默 0 成员」的形式复发。

**负面**

- `embedded` 模式下 API 崩溃会连带 worker 停止，与 ADR-0002 的可用性目标相反。**这只在开发形态下可接受**，README 与 `.env.example` 都标注了这一点。
- 单写者意味着不能并行跑两个 `npm run dev`；端口冲突之外还多一个数据目录冲突。
- `toTextArray` 是一层防御性代码，理论上接真 PG 后可以删掉。**但不删**：换驱动时它仍然是廉价保险，代价是每次调用一次 `Array.isArray`。

## 替代方案

| 方案 | 否决理由 |
| --- | --- |
| 用 Docker 起真 PG | 本机无 Docker（见 ADR-0011） |
| worker 用独立 data 目录 | 两个 PGlite 实例看到的是两份数据，等于没有共享状态 |
| worker 改成"由 API 定时触发" | 就是 embedded，只是说法不同；显式建模成 worker 循环更接近生产形态 |
| 把数组列改成 `text` 存 JSON | 放弃数据库层的类型约束，与「schema 不降级」冲突 |
| 在驱动层注册自定义 OID parser | PGlite 的 parser 注册接口不稳定；且归一化在业务边界更可控 |
