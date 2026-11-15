# dsh-selftest

[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B67B4?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-amber?style=flat-square)](https://github.com/topics/dsh-plugin)
[![npm](https://img.shields.io/npm/v/dsh-selftest?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-selftest)
[![CI](https://github.com/Tirpitz-39/dsh-selftest/actions/workflows/ci.yml/badge.svg)](https://github.com/Tirpitz-39/dsh-selftest/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933.svg)](package.json)

[中文](README.md) | [English](README.en.md)

按「本次改了什么」自动推导检查，而不是靠模型记得要检查。

注册一个 `selftest` 工具，同时提供一个命令行入口；两者跑的是同一套逻辑。

## 它解决什么

AGENTS.md 里的「必须测试 / 必须检查」是写给人看的规则，忘了或糊弄了不会有任何反馈。
这个插件把它变成代码：

- 收集改动：`git status --porcelain`（含未跟踪文件）∪ 最近 N 分钟 mtime 变化（非 git 目录也能用）
- 按扩展名推导检查器，**不认识的扩展名记为 skip，绝不静默通过**
- 往上找 3 级，找到改动文件所属插件 / 项目的测试并跑一次
- 改动插件源码但该插件没有任何测试 → 直接 FAIL

## 和类似工具的区别

很多工具都做「按改动跑检查」，但触发时机和判定规则完全不同：

| 工具 | 触发时机 | 输入 | 覆盖 | 与 selftest 的关键差异 |
|---|---|---|---|---|
| [lint-staged](https://github.com/okonet/lint-staged) | `git commit` | 暂存区文件 | 配置好的 linter / formatter | 不跑测试；没有配置的类型会跳过；必须挂 git |
| [pre-commit](https://github.com/pre-commit/pre-commit) | `git commit` | 暂存区文件 | 任意 hook | hook 框架，不推导「该查什么」 |
| [lefthook](https://github.com/evilmartians/lefthook) | git hooks | 按 glob | 快速 hook 编排 | 调度器，不含检查推导 |
| [nx affected](https://github.com/nrwl/nx) | CI / 本地 | 项目图 | 构建 + 测试 | 需要项目接入 nx，重 |
| [danger-js](https://github.com/danger/danger-js) | PR / CI | 变更文件 | 自定义规则 | 在 CI 环节，不是本地即时 |
| **dsh-selftest** | **任意时刻（工具 / 命令行调用）** | git status + mtime | 语法 + 所属测试 + 无测试即失败 | 不依赖 git hook；不认识的扩展名显式 skip（附原因）；面向 AI agent 会话 |

简言之：它是给「AI 改完代码马上自检」用的，不是提交钩子，也不是 CI 系统。

## 检查矩阵

| 改动 | 检查 | 判定 |
|---|---|---|
| `.ps1` `.psm1` `.psd1` | PowerShell 解析器 + Windows PowerShell 5.1 编码规则（非 ASCII 无 BOM 视为缺陷） | 解析错误或编码缺陷即 fail |
| `.js` `.mjs` `.cjs` | 批量子进程：`vm.Script`/`vm.SourceTextModule` 语法检查 + 相对 import 解析 | 语法错误或相对 import 无法解析即 fail |
| `.json` | `JSON.parse`（容忍 BOM） | 解析失败即 fail |
| `.ts` `.tsx` | 有 `tsconfig.json` 时 `tsc -p <tsconfig> --noEmit`，否则逐文件 `tsc --noEmit`；仅在配置了 `tsc` 时启用 | 未配置则 skip |
| `.py` | `ruff check`，未配置则 `python -m py_compile` | 非 0 退出即 fail |
| `.sh` `.bash` | `bash -n`（PATH 探测） | 非 0 退出即 fail；无 bash 则 skip |
| `.yml` `.yaml` | 可选：配置 `DSH_SELFTEST_YAML`（如 python3 + PyYAML） | 未配置则 skip |
| 其它 | — | skip，附原因 |
| 所属测试 | `<dir>/test/*.mjs`（优先 `test.*` / `*.test.*` / `*.spec.*`），或 `package.json` 的 `scripts.test` | 非 0 退出即 fail |

测试发现向上最多 3 级：改 `plugins/dsh-guard/lib/index.js` 会找到 `plugins/dsh-guard/test/test.mjs` 并运行它。

## 安装

要求 Node.js 18+。

**从 npm 安装**（推荐）：

```bash
npm i -g dsh-selftest@0.2.1     # 全局命令行
npx dsh-selftest@0.2.1           # 或直接跑一次
```

**作为 DSH 插件**：`dsh plugin add dsh-selftest`（或把本包放进 profile 的 `node_modules`），在 DSH 里启用后即可使用 `selftest` 工具。

**独立命令行**：

```bash
node lib/cli.js                 # 检查当前目录的改动
node lib/cli.js --explain       # 只列计划
node lib/cli.js --files a.ps1,b.json
node lib/cli.js --quick         # 只做语法/JSON，不跑测试套件
node lib/cli.js --summary       # 手机上的短输出：结论、失败项、跳过数、证据路径
```

**可选依赖**（按需安装，缺了对应检查会 skip）：

- PowerShell 7（解析 `.ps1`）：`winget install Microsoft.PowerShell`
- git（收集改动）：通常已有
- `tsc` / `ruff`：想启用 `.ts` / `.py` 检查时再装

所有外部程序都是**探测**出来的：环境变量 → PATH → 常见安装位置（含 `$DSH_HOME` 下的 DSH 自带运行时），不写死路径。

## 用法

工具：

```
selftest                          # 检查当前会话工作区的改动
selftest { action: "plan" }       # 只列计划，不执行
selftest { root: "/path/to/tools", since: 60 }
selftest { files: ["a.ps1"] }     # 只查指定文件
selftest { prove: true }          # 检查器体检：先证明自己会红，再检查你的代码
```

命令行：

```
node lib/cli.js [root] [--explain] [--json] [--quiet] [--no-persist] [--prove]
```

`--prove` 是检查器自己的体检：用 9 个已知样本（坏 JS、坏 JSON、编码缺陷的 .ps1、失败的测试、
不存在的文件/root、未知扩展名、干净代码、空目录）逐个验证「该红的会红、该绿的会绿」。
检查器自己都没被验证过，就没资格检查别的代码。9/9 通过才算健康。

退出码：`0` 通过 / 无改动 / `--explain`；`1` 有失败；`2` 参数错误。

工具返回里带一条 `claimChecks`，可直接原样传给 `claim_plan`：

```json
{ "id": "selftest", "kind": "command", "title": "selftest 通过：…", "command": "<node> …cli.js --root … --no-persist --quiet" }
```

> `claimChecks` 依赖 DSH 的 claimcheck 插件提供 `claim_plan` / `claim_verify`；没有该插件的 Harness（例如手机端 DSH Go）可忽略这一项，直接看退出码。

## 语言

界面文本支持中文与英文。解析顺序：

1. `DSH_SELFTEST_LANG`（`zh` / `en`）
2. `LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE`
3. 系统 locale（`Intl`；中文系统默认中文，其余英文）

`--help`、`--json` 的 text、`--quiet` 行、`--prove` 输出、错误消息、`claimChecks` 标题都跟随所选语言。

## 证据

`<root>/.dsh/selftest/latest.json` 与 `runs/<id>.json`，保留最近 50 份（`keepRuns`）。

## 配置（环境变量，都有默认值）

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_SELFTEST_NODE` | 自动探测 | 语法检查与测试用的 node |
| `DSH_SELFTEST_PWSH` | 自动探测 | 解析 `.ps1` 的 PowerShell（Windows 上 `pwsh` → `powershell`） |
| `DSH_SELFTEST_PARSE_PS1` | 包内 `lib/parse-ps1.ps1` | 批量解析脚本（已随包发布，无需外部文件） |
| `DSH_SELFTEST_TSC` | 空 | 配置后启用 TypeScript 检查 |
| `DSH_SELFTEST_RUFF` | 空 | 配置后启用 ruff，否则 `py_compile` |
| `DSH_SELFTEST_GIT` | 自动探测 | git 可执行文件 |
| `DSH_SELFTEST_STRICT_PLUGINS` | `1` | `0` 关闭「插件无测试即失败」 |
| `DSH_SELFTEST_LANG` | 跟随系统 | 界面语言：`zh` / `en`（也认 `LC_ALL`/`LANG`；中文系统默认中文，其余英文） |
| `DSH_SELFTEST_SINCE_MINUTES` | 10（Linux 30） | mtime 回看窗口（分钟） |
| `DSH_SELFTEST_TIMEOUT_MS` | 120000（Linux 30000） | 单步超时 |
| `DSH_SELFTEST_MAX_FILES` | 500（Linux 200） | 收集文件上限 |
| `DSH_SELFTEST_MAX_DEPTH` | 4（Linux 6） | mtime 扫描深度 |
| `DSH_SELFTEST_EVIDENCE_DIR` | `<root>/.dsh/selftest`（Linux `$DSH_HOME/cache/selftest`） | 证据目录 |
| `DSH_SELFTEST_PLUGIN_ROOTS` | 空 | 额外插件根（逗号分隔绝对路径，其直接子目录视为插件） |
| `DSH_SELFTEST_QUICK` | `0` | `1` 等价 `--quick` |
| `DSH_SELFTEST_BASH` | 自动探测 | bash（`.sh` 的 `bash -n`） |
| `DSH_SELFTEST_YAML` | 空 | YAML 校验器可执行（如 `python3`，需能 `import yaml`）；空 = 跳过 YAML |

## 手机 / 低功耗平台

`process.platform === 'linux'` 时自动切到手机档默认值：mtime 窗口 30 分钟、扫描深度 6、单步超时 30 秒、文件上限 200、证据写到 `$DSH_HOME/cache/selftest`（workspace 可能只读或挂载）。

- `.ps1` 没有可用 PowerShell → 显式 skip（不是 spawn 失败）；`--prove` 把这一项标成 inconclusive，不计入「已证实」
- `.py` 没有 `python`/`python3` → 显式 skip
- 默认不跑 `npm test`（进程启动太贵）；有 `test/*.mjs` 就直接用 node 跑
- 工具层在 Linux 上自动传 `--summary`：只给结论行、失败项（最多 8 条）、跳过数和证据路径
- `selftest { quick: true }`（或 `--quick`）只做语法/JSON，不跑测试套件，适合「改完马上查」
- `.dsh`、`build`、`dist` 这类目录名只在 root **以下**才跳过；root 本身在 `/root/.dsh/...` 下照常工作
- `--files` 显式指定的文件永不跳过

## 覆盖完整性（partial）

结果不完整时 verdict 为 `partial`（退出码仍 0，不冒充失败）：文件被 `maxFiles` 截断、`maxDepth` 有更深目录未扫描、或有检查项因缺工具/缺 runner 被 skip。`coverage` 字段给出 `{ truncated, depthLimited, skippedTools }`，`sources.truncated` / `sources.depthLimited` 同步记录。

**node 探测**：Harness 宿主是 Electron，`process.execPath` 是 `DSH NEXT.exe` 而不是 node，
喂它 `--check` 必然失败。所以按 `DSH_SELFTEST_NODE` → 自身是 node → PATH → `$DSH_HOME` 自带运行时 的顺序探测。

## 工具层是薄壳

`selftest` 工具本身不执行任何检查逻辑：它把参数翻译成 CLI 参数，用**真正的 node** 起一个
`lib/cli.js --json` 子进程，再把 JSON 交回模型。

两个原因：

1. Harness 宿主是 Electron，`process.execPath` 是 `DSH NEXT.exe` 而不是 node，工具层必须自己探测可用的 node；
2. Harness 静态加载插件模块，**改 `lib/` 下的逻辑不会热更新**。把逻辑放进子进程后，改代码在下一次调用就生效，不必重启 Harness。

只有改 `lib/index.js` 本身（参数映射、工具描述）才需要重启一次。

### 结果必须是无损 JSON

工具返回值里不能出现 `undefined` 或 `NaN`：它们经过 `JSON.stringify` 会丢失，Harness 会拒绝整次调用并报
`value is not lossless JSON`。`lib/core.js` 的 `toLossless()` 在出口统一把 `undefined` 转成 `null`、把非有限数转成 `null`。

## 受限沙箱下的降级

`claim_verify` 执行的命令运行在沙箱里，**无法创建命名管道**（`spawn EPERM`），也可能不允许写工作区之外的路径。

处理方式：

- 管道 spawn 失败 → 自动改用 `stdio: 'inherit'` 重试，子进程输出直接转出，**退出码照常决定通过/失败**
- 临时文件（`.ps1` 批量列表）按 `%TEMP%` → cwd → 步骤目录 顺序回退
- `--no-persist` 让 claim 场景不写证据文件

因此 `lib/parse-ps1.ps1` 除了输出 JSON，还会在有坏文件时 `exit 1`——即使 stdout 捕获不到，结论也不会丢。

代价：受限环境里 `.ps1` 批次会塌缩成一行（拿不到逐文件明细），但 verdict 仍正确。

## 已知边界

- **验证不了用户侧现象**。语法对 ≠ 行为对，改完界面/命令仍然要自己跑一次。
- 文件收集靠 git + mtime，改了但既没提交也没在 N 分钟内改过的文件不会被发现。
- 测试发现只认约定目录，不解析代码里的测试标记。
- 沙箱里 `spawn` 被彻底禁止时无法工作（当前实测仅管道受限，继承模式可用）。
- 只扫绝对路径含 `\dev\plugins\<name>\` 的插件目录，其它位置的插件不会触发「无测试即失败」。
- 显式用 `--files` 指定、但实际不存在的文件会判 fail（不会悄悄当成“没有可查的”）。
- **会执行工作区里的代码**：`scripts.test`、`test/*.mjs` 都是直接 spawn 的。不可信仓库上先看测试内容再跑。
- 不内置 YAML 解析器：默认跳过 `.yml`/`.yaml`。配置 `DSH_SELFTEST_YAML`（能 `import yaml` 的解释器）后启用校验；校验器缺失会明确判 fail，不会假装通过。

## 开发与测试

```bash
node test/test.mjs       # 单元 + 端到端，27 个用例
node test/i18n.mjs       # 界面语言（zh / en），11 个用例
node test/mobile.mjs     # 手机/可移植性回归（.dsh root、git 子目录、缺工具、深度、quick），12 个用例
node test/gauntlet.mjs   # 「去酒吧点蛋炒饭」第一组，24 条断言
node test/gauntlet2.mjs  # 第二组（git/输入/输出契约），20 组场景、28 条断言
node test/gauntlet3.mjs  # 第三组（--prove 体检与参数组合），21 条断言
```

`gauntlet*.mjs` 不测功能，专测**它会不会骗人**：未知扩展名必须 skip 而不是静默通过、显式指定的文件不存在必须 fail、
二进制文件不能误判、卡死的测试超时必须判失败、500+ 文件截断必须显式标记、`--explain` 不能偷偷执行。

第二组还覆盖：git 未跟踪/已修改/删除、`node_modules` 跳过、`.ts` 无编译器时说明原因、不存在的 root 必须报错、
`--json` 严格可解析、exit code 契约（1=fail、2=参数错）、`--quiet` 单行、`--no-persist` 不落盘、证据文件结构、
中文与 emoji 路径、相对路径入参、Windows 大小写去重、5MB JSON、只读文件、损坏的 `.git`。

第三组专打 `--prove`：体检结果必须真红真绿（不是嘴上说）、不写证据、不弄脏 git 工作区、临时目录清理干净、
幂等、缺 root/带 `--files`/带 `--plan` 时行为明确。

27 个用例：prove 体检、git 输出解析、按扩展名分组、测试发现（test 文件优先于 scripts.test）、插件策略、报告落盘与清理、
`.ps1` 真实解析（无 pwsh 时跳过）、端到端 pass / fail / plan / 无改动、缺失文件 fail、工具注册形状。

夹具全部建在系统临时目录，不会拿真实工作区糊弄自己。

## 作者

大肥鱼（DSH 里的鲸鱼娘）· 在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上开发。

## License

MIT
