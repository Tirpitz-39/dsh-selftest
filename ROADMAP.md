# dsh-selftest 路线

> **定位：收尾强制自检工具。** 只回答一个问题——这次改动到底验过没有，结论可不可信。
> 不承担通用测试编排。基线：npm `latest` = 0.3.2，CI 9 job 全绿（ubuntu/windows × node 18/20/22/24 + macOS）。

## 现有能力（已完成）

- **改动收集**：git 工作区 + mtime 窗口；按扩展名派生检查器（`.ps1` 走 PowerShell 解析器 + BOM 规则、`.js/.mjs` 批量语法 + 相对 import 存在性、`.json` JSON.parse、`.sh` 走 `bash -n`、`.yml` 走可选 YAML 校验）
- **逐文件结论**：pass / fail / skip（带原因）/ partial
- **插件策略**：改动的插件没有测试 → fail（可降级为提示）
- **证据**：每次运行写 `<root>/.dsh/selftest/latest.json`（或配置的证据目录），逐文件签名 size + mtime + sha256 前 16 位
- **硬闸** `hardGate: nag`：写文件后，下一次非只读调用被拒一次；只认对准本会话 root 的 selftest
- **吹哨人**：轮末比对改动文件与证据签名，指名「改了但没验」的文件（warn / strict / off）
- **消费者入口** `--audit`：exit 0 fresh/partial/nothing、1 unverified/stale、2 参数错；`--json` 给 `{verdict,total,verified,unverified,artifactPath}`
- **检查器体检** `--prove`：用已知坏样本验证检查器自己会红（11 案）
- **发布链**：tag → 矩阵测试 → pack → 版本校验 → publish（幂等跳过已发布版本），`NPM_TOKEN` 已配

## 待打磨（都在这个定位内）

| 项 | 做什么 | 验收 |
|---|---|---|
| 证据 schema | `latest.json` 加 `schema: "dsh-selftest/evidence@1"` + 迁移策略 | 旧证据仍可读，新字段带版本 |
| `--audit` 消费者示例 | CI / git hook / 自研调度器 / claimcheck 四份可复制片段 | 照文档粘一行就能接，不用读源码 |
| 已知边界整理 | 伪造证据、符号链接、Linux 证据目录等边界写进 README，与 `test/attack.mjs` 一一对应 | 文档和测试对得上 |

## 明确不做

- ❌ **多语言测试编排**：pytest / cargo / go / TS runner —— 这是「跑项目测试」，不是「确认改动验过」
- ❌ 测试发现拓宽（colocated、monorepo `packages/*/test` 之类）
- ❌ 仓库级自定义 steps、lint 引擎配置
- ❌ 并行执行、增量缓存（改动文件本来就只收最近改过的，收益不抵复杂度）
- ❌ 新检查器类型扩展（TOML / Markdown / Dockerfile）
- ❌ GUI / 看板 / 遥测 / 市场生态

## 版本记录

| 版本 | 提交 | 内容 |
|---|---|---|
| 0.3.0 | `ba3b17b` | whistle / signature / `--audit` / hardGate / 攻击测试；`test/support` 随包（`04d0c8d`） |
| 0.3.1 | `73c0742` | 修 `readLatest` 忽略 `evidenceDir`：Linux（手机类平台）上 `--audit` 恒返回 `nothing` |
| 0.3.2 | `8654420` | README 安装命令不再钉死旧版本 |
