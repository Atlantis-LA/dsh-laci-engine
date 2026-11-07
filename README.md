# dsh-laci-engine

> LACI 与 dsh-laci-engine 最初由 **Atlantis** 创建，MIT License。

给 DSH Desktop 用的本地模型调度插件：在左侧栏加一个「模型调度」入口，内嵌并托管
**LACI 模型调度中心**（本插件自带 `laci/`，不需要另外安装网页端）。

```
DSH 左侧栏「模型调度」
  └─ /laci/  →  插件内置的 LACI 控制台（127.0.0.1:3102）
                 └─ 管理引擎 / 模型：导入、加载、关闭、显存预估、思考等级
                 └─ 网关 127.0.0.1:8096/v1（DSH 的 provider 指这里）
```

## 环境

- Windows 10/11
- DSH Desktop 0.2.x
- 不需要单独安装 Node：插件用 DSH 自带的 Node 启动内置控制台
- 手动调试控制台时才需要 Node 22+（见文末）

## 安装

### 方式 A：插件市场（推荐）

在 DSH 的 Plugins / 插件页面搜索 `dsh-laci-engine`，安装并启用，重启 DSH。
（市场安装走 npm 包；本包已包含 `laci/`，装完即可用。）

### 方式 B：手动安装 zip

1. 把 `dsh-laci-engine` 文件夹放到一个稳定位置，例如：
   `%USERPROFILE%\.dsh\plugins\dsh-laci-engine`
2. 进入 DSH 的 profile 目录（默认 `%USERPROFILE%\.dsh\profiles\desktop`），用 DSH 自带的 pnpm 链接：
   ```powershell
   cd $env:USERPROFILE\.dsh\profiles\desktop
   pnpm add "link:$env:USERPROFILE\.dsh\plugins\dsh-laci-engine"
   ```
3. 确认该目录 `package.json` 的 `dsh.profile.bundles` 里有 `dsh-laci-engine`。
4. 重启 DSH。左侧栏出现「模型调度」。

> 升级：替换插件文件夹（或 `pnpm update dsh-laci-engine`）后重启 DSH。数据在单独的目录里，不会被覆盖。
>
> **升级网页端后必须重启控制台**：插件发现 3102 已经有旧控制台会直接复用，页面仍是旧代码。
> 先在任务管理器结束占用 3102 的旧 `node.exe`（或重启 DSH），再让插件重新拉起。
>
> 旧版把模型存在 `<插件根>\data`；新包检测到会继续沿用。如果改用 npm 更新，建议先把
> 那份 `data` 复制到 `%USERPROFILE%\.dsh\laci-engine`，或在 profile 里设置 `console.home`
> 指过去，避免包目录被替换时丢模型。

## 第一次打开

点左侧栏「模型调度」。插件会自动启动内置控制台（127.0.0.1:3102），第一次会显示空列表。

- 控制台数据目录：`%USERPROFILE%\.dsh\laci-engine`
  - `config.json`：端口（3102 / 8096）
  - `data\engines\`、`data\models\`：引擎 / 模型定义
  - `data\instances.json`：运行时实例
  - `logs\console.out.log`：控制台日志
  - `logs\inst-*.log`：每个实例的引擎日志
- 如果检测到旧版插件旁边的 `data\`（`<插件根>\data\config.json`），会优先沿用，升级不丢模型。

控制台没起来时，面板会显示「控制台没在跑」卡片；点「启动控制台」，或看
`%USERPROFILE%\.dsh\laci-engine\logs\console.out.log`。

## 导入模型

控制台底部有三个入口：

### 1. 导入整合包（最常见）

适合网盘下载的整合包（文件夹里有 `.bat` / `.exe` + 模型文件）：

1. 点「+ 导入整合包」，选文件夹。
2. 扫描结果会列启动脚本、引擎、模型；多个脚本时选一个。
3. 启动方式：
   - **按参数运行**：能改参数（推荐，前提是 bat 能拆开）
   - **原样运行**：最稳，但参数改不了
4. 点「试启动」，等日志出现端口 / `ready`；探不到端口可以手填。
5. 点「导入」。之后引擎卡片里会出现模型行，点「加载」。

### 2. 导入引擎（自己下的 exe / bat）

适合 ninfer、自己配的 llama.cpp 等：

1. 点「+ 导入引擎」，选启动文件。
2. 填默认端口、工作目录、解释器（.py / .ps1 才需要）。
3. 参数模板按引擎文档填；可用变量：`{model}`、`{port}`、`{host}`、`{modelId}`、
   `{maxContext}`、`{kvWindow}`、`{kvDtype}`、`{thinkingEffort}`、`{thinkingBudget}` 等。
4. 点「试启动」；成功后保存。
5. 进引擎卡片，点「+ 添加模型」，选模型文件，填模型 id / 名称 / 参数。

### 3. 云端模型

「+ 导入引擎」→ 类型选「云端」→ 填 `baseURL`（要带 `/v1`）、API key、模型清单。
云端模型不占显存、不用加载，网关直接转发；key 存在 `data\secrets.json`，不会写进引擎档案。

## 配置

点模型行打开配置页：

- **上下文 / KV 窗口 / 量化 / 预填块 / headroom**：显存上的 KV 参数
- **主机 KV**：钉在主机内存里的那份（不占显存）
- **投机解码**：MTP / dflash，草稿数 1–15；开了池会明显变小
- **视觉**：resident / overlay / cpu 三种驻留；cpu 会强制最大合并 ≤ 256
- **思考等级**：能不能调由引擎决定
  - `config` 模式（如 Strata）：写回引擎配置文件的 `reasoning_effort` /
    `reasoning_budget_tokens`，会先备份 `.bak-*`
  - `argv` 模式（如 ninfer）：写模型档案，启动时进 `--default-reasoning-effort` /
    `--default-thinking-budget`
  - 探测不到就显示「不适用」，不会给一个点了没反应的控件
  - 「允许请求覆盖」由网关执行（D4）：关掉时，请求里的 `reasoning_effort` 会被剥掉

改完保存：`idle` 直接生效；`ready` 提示重启，可点「保存并重启」。

## 加载 / 关闭

- 点「加载」：先算显存/内存；不够会弹「预计 / 可用 / 缺口 / 依据」，点「仍然加载」可强起。
- 点「关闭」：如果有请求在跑，会问「等它结束 / 强制关闭」。
- 加载中/出错时点「日志」看最后几行；引擎的 FATAL 会写进实例错误和日志。

## 接入 DSH

控制台底部「接入 DSH」会生成 provider YAML：

1. 点「接入 DSH」→ 复制。
2. 打开 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，找到 `llm-pi-ai`
   的 `providers` 段，用复制的内容替换/更新 `kvmem-local.models`。
3. `baseURL` 应为 `http://127.0.0.1:8096/v1`（本插件网关）。
4. 重启 DSH，模型选择器里会出现本地模型。

> `apiKeyEnv: LACI_LOCAL_API_KEY` 只是占位：本地网关不校验 key，环境变量有没有都行。
> 只导出 `kind: chat` 的模型；`caps.tools=false` 的模型不会进列表（避免 DSH 静默降级）。

## 端口 / 数据

| 东西 | 默认 |
|---|---|
| 控制台 | `127.0.0.1:3102` |
| 网关 | `127.0.0.1:8096/v1` |
| 引擎实例 | 18095 起（按模型/引擎自动往上找） |
| 数据 | `%USERPROFILE%\.dsh\laci-engine` |

端口可在 profile 的 `cordis.patch.yml` 里改：
```yaml
- id: laci-engine
  config:
    console:
      port: 3102
      gatewayPort: 8096
```
注意：`console.port` 必须和 `config.json` 的 `consolePort` 一致，`gatewayPort` 必须和
`gatewayPort` 一致，否则插件会明确报错（不会空等）。

## 排错

| 现象 | 处理 |
|---|---|
| 左侧栏没有「模型调度」 | 插件没启用 / profile bundles 里没有 `dsh-laci-engine` / 重启 DSH |
| 面板「控制台没在跑」 | 看 `%USERPROFILE%\.dsh\laci-engine\logs\console.out.log`；3102 被占用就改端口 |
| 控制台报 config.json 端口不一致 | 把 `consolePort` / `gatewayPort` 改成 3102 / 8096，或删掉该文件让插件重建 |
| 模型加载失败 | 看实例日志最后几行；8 GB 卡注意 `NINFER_KV_WINDOW`、KV 量化、MTP/视觉的显存代价 |
| DSH 里看不到模型 | 重新「接入 DSH」→ 粘贴 → 重启；确认 `baseURL` 是 8096 |
| 加载后 DSH 对话 503 | 模型没加载 / 实例 error；回控制台看状态 |

## 安全

控制台只监听 `127.0.0.1`，但它的 API 能**执行任意引擎程序**、列出目录、弹系统对话框。
不要把 3102 / 8096 暴露到局域网；不要在不可信环境里开放 `host` 配置。

## 旧接口说明

`/laci-engine/load`、`/laci-engine/close` 是早期“插件自己拉 ninfer”的接口，保留兼容但默认不指向
任何机器路径；正常使用请走控制台。`lib/model-bridge.js` 与 `lib/tool-guard.js` 默认关闭
（它们按旧 LACI / 旧工具面写），不要在没改代码的情况下打开。

## 手动调试控制台

一般不需要。确实要单独跑内置网页时：

```powershell
$env:LACI_HOME = "$env:USERPROFILE\.dsh\laci-engine"
cd <插件目录>\laci
node server.mjs
```

前提是 `node` 在你的 PATH 里（Node 22+），并且数据目录里已有 3102/8096 的 `config.json`。
正常用户请让插件启动，不要同时手动开一份，避免端口冲突。

## 作者 / 许可

LACI（Local AI Control Interface）与 dsh-laci-engine 最初由 **Atlantis** 创建。

本项目使用 **MIT License**，全文见 `LICENSE`。二次分发或修改时请保留版权声明；
也欢迎在 README 或项目主页注明原始出处。

贡献者名单见 `AUTHORS.md`。
