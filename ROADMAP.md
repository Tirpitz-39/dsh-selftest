# dsh-selftest 技术路线

> 基线：2026-11-16，npm `latest` = **0.3.2**，CI 9 job 全绿（ubuntu/windows × node 18/20/22/24 + macOS）。
> 这份文件是路线图，不是承诺。每项落地后在上面勾掉、写提交号；顺序可以按实际痛点调整。

排序原则：**先用起来 → 懂项目 → 可信与快 → 可运营**。

## P0 · 把 0.3.0 真正发出去（已完成）

| 项 | 做什么 | 验收 | 状态 |
|---|---|---|---|
| 发布 0.3.0 | commit + push + CI 绿；npm publish | `npm view dsh-selftest version` = 0.3.0 | ✅ 0.3.0（`ba3b17b`），现 latest 0.3.2（`8654420`） |
| release workflow | 打 tag → 矩阵测试 → 自动 publish（建议 npm OIDC trusted publishing，免 token） | 打一个预演 tag，Actions 自动发布成功 | ⚠️ 文件已就绪（`.github/workflows/release.yml`），**未配 `NPM_TOKEN` / OIDC**，打 tag 会红 |
| 沙箱测试统一 | EPERM 的 skip 抽成公共 helper | 各套件复用同一个 helper，CI 里 0 意外失败 | ✅ `test/support/sandbox.mjs`（0.3.0 起随包发布） |
| CI 补 macOS | 现在只有 ubuntu + windows | macOS 跑通一次 `npm test` | ✅ macOS 单 Node 22 作业 |

P0 的教训：0.3.0 上线后 CI 红了 6 轮才绿——**Linux 被当作手机类平台，证据默认写到 `~/.dsh/cache/selftest`，而 `--audit`/吹哨人读证据时硬编码 `<root>/.dsh`**，等于每台 Linux 主机上审计恒失效。0.3.1 修掉（`73c0742`）。教训写在这里：凡涉及运行环境判断的改动，必须有 Linux 路径的断言。

## P1 · 让检查器「懂项目」（M，约 1 周）

当前最大的能力空白：Python 只验语法、TS 测试一刀切 skip、测试发现只认少数目录。

| 项 | 做什么 | 验收 |
|---|---|---|
| **pytest 探测** | 改动 `.py` + 存在 `pyproject.toml`/`pytest.ini`/`conftest.py`/`setup.cfg`/`tox.ini` → `pytest -q` | 真实 Python 项目上改一个 `.py`，selftest 真的跑 pytest 并拿到真实退出码 |
| **Cargo / Go** | `Cargo.toml` + `.rs` → `cargo test`；`go.mod` + `.go` → `go test ./...` | 假 fixture 验证探测与命令生成；本机没有工具链就 skip 带原因 |
| **TS 测试不再一刀切 skip** | 探测 `tsx`/`vitest`/`jest`/`node --experimental-strip-types`，有 runner 就跑 | 一个 `.test.ts` 能真跑；没有 runner 时 skip 原因写清 |
| **测试发现拓宽** | colocated `*.test.*`/`*.spec.*`、Python `test_*.py`、monorepo 的 `packages/*/test` | 单测覆盖三种布局，不再只认 `test/` `tests/` `__tests__/` |
| **仓库级配置 `.dsh/selftest.json` V1** | `steps[]`（自定义命令）+ `ignore[]`，与内置步骤合并 | 用本仓库做首个用例：配 ESLint 和覆盖率门槛两条自定义 step |

顺序理由：pytest 第一（本机 Python 代码多，现在只验语法）；TS 第二；cargo/go 第三（本机无工具链，收益主要靠外部用户）。

## P2 · 让判定可信、让执行变快（M，1–2 周）

| 项 | 做什么 | 验收 |
|---|---|---|
| **增量执行** | 复用 0.3.0 的 per-file 签名：签名没变且上次通过的文件直接复用结论，只跑受影响的测试 | 大仓库（>500 文件）第二次运行耗时下降 ≥50%，且结果与全量一致 |
| **并行测试步骤** | 多个测试套件并发跑，输出按文件保序 | 本仓库各套测试总耗时下降；失败信息不串行 |
| **证据 schema 化** | `latest.json` 加 `schema: "dsh-selftest/evidence@1"` 与迁移策略 | 旧证据仍可读；新字段有版本 |
| **检查器按需扩展** | TOML、Markdown 链接（可配）、Dockerfile 语法（可配） | 每项独立可关，不影响默认行为 |
| **`--audit` 消费者文档** | CI / git hook / 自研调度器 / claimcheck 四份可复制示例 | 照文档粘一行就能接，不用读源码 |

增量排前面：这是「大仓库慢」的唯一解，也是 `--audit` 敢在 CI 里天天跑的前提。

## P3 · 运营与生态（L，持续）

- hardGate 白名单可配置 + 一次性豁免（`--skip-audit`）
- 手机档（DSH Go）：pytest/cargo 这类命令在 proot 下的成本评估，默认 skip 带原因
- 外部消费者接入：claimcheck 的 `claim_plan` 直接吃 `checks`；社区调度器接入
- 性能基线：把「收集 + 检查 + 测试」三段的耗时写进 CI，防止退化

## 优先级依据

1. **发布链 > 一切**：能力不在 npm 上等于零
2. **pytest > TS > cargo/go**：按本机代码分布排
3. **增量 > 并行**：增量省的是真金白银，并行只省等待
4. **lint/覆盖率不内置**：用 P1 的自定义 steps 实现，保持「检查器只做推导、不做全套 lint 引擎」的定位

## 明确不做

- ❌ 内置 ESLint / Prettier / 格式化 —— 交给项目自己的工具
- ❌ 安全扫描 / 依赖漏洞审计 —— 不是它的定位
- ❌ 覆盖率引擎 —— 只做门槛判定，不做统计
- ❌ GUI / 看板 —— 证据是 JSON，谁要看谁渲染
- ❌ 遥测 / 上报 —— 零网络

## 版本记录

| 版本 | 提交 | 内容 |
|---|---|---|
| 0.3.0 | `ba3b17b` | whistle / signature / `--audit` / hardGate / 攻击测试；`test/support` 随包（`04d0c8d`） |
| 0.3.1 | `73c0742` | 修 `readLatest` 忽略 `evidenceDir`：Linux（手机类平台）上 `--audit` 恒返回 `nothing` |
| 0.3.2 | `8654420` | README 安装命令不再钉死旧版本 |
