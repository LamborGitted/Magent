# Magent

Magent 是一个面向 AI Agent Harness 的环境管理器，目标是像 Conda 管理 Python 环境一样，隔离和管理 Pi、DSH、Codex 等工具的配置、凭据、会话、Skills、插件与其他状态。

> 当前处于早期 CLI MVP 阶段。现阶段实现的是 **Harness 状态目录隔离**，不是完整的安全沙箱，也不是严格的所有资源隔离。

## 项目定位

Magent 负责：

- 创建和删除独立的 Agent 环境
- 为不同环境准备独立的 Harness 状态目录
- 通过 Harness 官方环境变量重定向配置与运行状态
- 在保留当前项目工作目录的情况下启动真实 Harness
- 将参数、终端输入输出和退出码透明传递给 Harness

Magent 当前不负责：

- 实现新的 Agent
- 多 Agent 任务编排
- Docker、VM、进程或网络安全隔离
- Git worktree 管理
- 后台服务与端口管理
- Web UI

## 技术栈

- Node.js 22+
- TypeScript（ESM）
- pnpm 11
- Commander：CLI 命令解析
- Zod：Manifest 校验
- smol-toml：TOML 读写
- tsup：构建
- Vitest：测试

## 当前支持

### 命令

```bash
magent env create <name>
magent env list
magent env info <name>
magent env remove <name> --yes

magent run <environment> <harness> [args...]
magent home
```

`env list` 和 `env info` 支持 `--json`。

### Harness Adapter

| Harness | 可执行文件 | 注入的环境变量 | 独立状态目录 |
|---|---|---|---|
| Pi | `pi` | `PI_CODING_AGENT_DIR` | `<env>/harnesses/pi/agent` |
| DSH | `dsh` | `DSH_HOME` | `<env>/harnesses/dsh/home` |
| Codex | `codex` | `CODEX_HOME` | `<env>/harnesses/codex/home` |

Magent 不包含这些 Harness。对应命令必须已经安装并能够从 `PATH` 找到。

## 安装与开发

```bash
cd ./repo/Magent
corepack pnpm install
```

开发模式：

```bash
corepack pnpm dev -- --help
corepack pnpm dev -- env create mini
corepack pnpm dev -- run mini dsh web
```

构建和检查：

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
node dist/cli.js --help
```

链接为全局命令：

```bash
corepack pnpm build
corepack pnpm link --global
magent --help
```

## 快速使用

创建环境：

```bash
magent env create mini
```

查看环境：

```bash
magent env list
magent env info mini
```

运行 Harness：

```bash
magent run mini pi
magent run mini dsh web
magent run mini codex --help
```

Harness 参数会原样传递。例如：

```bash
magent run mini dsh web --port 3000
```

等价于：

```bash
DSH_HOME="$HOME/.local/share/magent/envs/mini/harnesses/dsh/home" \
  dsh web --port 3000
```

删除环境：

```bash
magent env remove mini --yes
```

删除操作目前会直接递归删除整个环境目录。Magent 尚未实现运行实例检查、停止确认和回收站。

## 数据目录

默认遵循 XDG：

```text
${XDG_DATA_HOME:-~/.local/share}/magent
```

可以使用 `MAGENT_HOME` 覆盖完整数据根目录：

```bash
MAGENT_HOME=/tmp/magent-test magent env list
```

查看当前实际目录：

```bash
magent home
```

创建 `mini` 后的目录结构：

```text
~/.local/share/magent/
└── envs/
    └── mini/
        ├── env.toml
        ├── harnesses/
        │   ├── pi/
        │   │   └── agent/
        │   ├── dsh/
        │   │   └── home/
        │   └── codex/
        │       └── home/
        ├── packages/
        └── state/
```

`env.toml` 示例：

```toml
schemaVersion = 1
id = "802c6759-9d8a-4c35-8641-dd7e7c683bf0"
name = "mini"
createdAt = "2026-08-18T16:40:14.269Z"
```

## 工作原理

执行：

```bash
magent run mini pi
```

内部流程：

```text
解析 CLI 参数
    ↓
读取并校验 mini/env.toml
    ↓
获取 Pi Harness Adapter
    ↓
设置 PI_CODING_AGENT_DIR=<mini>/harnesses/pi/agent
    ↓
使用当前工作目录启动 pi
    ↓
继承 stdin/stdout/stderr
    ↓
将 Pi 退出码返回给当前 Shell
```

核心调用接近：

```ts
spawn("pi", args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: "<mini>/harnesses/pi/agent",
  },
  stdio: "inherit",
});
```

Magent 不经过 Shell 拼接命令，参数会作为数组直接传递给子进程。

## 当前隔离边界

### 已实现

- 每个环境拥有独立 Manifest 和目录
- Pi 的 `PI_CODING_AGENT_DIR` 独立
- DSH 的 `DSH_HOME` 独立
- Codex 的 `CODEX_HOME` 独立
- Harness 的交互式终端可正常使用
- 当前项目工作目录保持不变
- Harness 的退出码会传递给调用方

### 尚未完全隔离

#### Pi 全局 Agent Skills

Pi 除了扫描：

```text
$PI_CODING_AGENT_DIR/skills
```

还会独立扫描：

```text
~/.agents/skills
```

后者不受 `PI_CODING_AGENT_DIR` 控制。因此，如果宿主机存在：

```text
~/.agents/skills/find-skills/SKILL.md
```

新创建的 Magent 环境仍可能发现 `find-skills`。

临时严格关闭 Skills 自动发现：

```bash
magent run mini pi --no-skills
```

Pi 支持通过重复的 `--skill <path>` 显式加载指定 Skill，但 Magent 尚未自动注入环境级 Skill 路径。

#### Pi 项目 Context Files

Magent 当前使用调用者的工作目录启动 Harness：

```ts
cwd: process.cwd()
```

Pi 会从当前目录向父目录发现：

```text
AGENTS.override.md
AGENTS.md
CLAUDE.md
```

因此，在 `./repo/Magent` 中启动 Pi 时，它可能发现父目录中的：

```text
/home/lantxx/workspace/AGENTS.md
```

这是 Pi 的项目上下文机制，不受 `PI_CODING_AGENT_DIR` 和项目 Trust 控制。

临时关闭 Context Files：

```bash
magent run mini pi --no-context-files
# 或
magent run mini pi -nc
```

### 当前没有提供的安全隔离

Magent 不会隔离：

- `$HOME` 中未被 Harness 状态变量覆盖的其他文件
- 当前项目文件系统
- 操作系统进程
- 网络和端口
- Docker daemon
- 环境变量与宿主机密钥
- CPU、内存和磁盘资源

因此，不应把当前版本作为执行不可信代码的安全边界。

## Pi 的临时严格启动方式

如果希望尽量减少 Pi 自动发现的外部资源，目前可以执行：

```bash
magent run mini pi \
  --no-context-files \
  --no-skills \
  --no-extensions \
  --no-prompt-templates \
  --no-themes
```

这只是在 Pi 资源加载层面减少外部输入，仍然不是文件系统、进程或网络沙箱。

计划中的 Magent 接口：

```bash
magent run mini pi --isolation strict
```

该选项目前尚未实现。

## 当前代码结构

```text
src/
├── cli.ts                       # CLI 命令和错误出口
└── core/
    ├── environment-store.ts     # 环境创建、读取、列出、删除
    ├── harnesses.ts             # Harness Adapter 和进程启动
    ├── manifest.ts              # Manifest 类型、创建与校验
    └── paths.ts                 # XDG/MAGENT_HOME 路径解析

test/
└── environment-store.test.ts
```

## 已知限制

- 没有 `magent doctor` 和 Harness 自动探测
- 没有 Harness 版本约束与兼容性检查
- 没有严格隔离模式
- 没有环境级 Skills 安装和绑定
- 没有环境克隆、导入和导出
- 没有 Runtime ID、PID、日志与进程状态记录
- 没有后台 Daemon、Surface 或 Service 管理
- 没有并发操作锁
- 损坏的环境在 `env list` 中会被忽略，但暂无修复命令
- 删除环境不会检查是否存在相关运行进程
- Signal 退出码映射目前只特别处理 `SIGINT` 和 `SIGTERM`

## 下一阶段

建议按以下顺序继续：

1. 增加 `magent doctor` 和 Harness 探测
2. 为 Adapter 增加启动参数注入能力
3. 实现 `--isolation project-aware|strict`
4. 实现环境级 Skills 目录和显式加载
5. 增加 `magent env clone/export/import`
6. 增加 Runtime 记录、日志和停止能力
7. 再评估 Daemon、pi-web 等 Surface 管理

## 测试状态

当前测试覆盖：

- 创建环境及目录结构
- 读取和校验 Manifest
- 环境列表排序
- 非法名称与重复名称拒绝
- 删除环境

运行：

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

当前项目仍处于实验阶段，Manifest、目录结构和 CLI 参数都可能发生不兼容变化。
