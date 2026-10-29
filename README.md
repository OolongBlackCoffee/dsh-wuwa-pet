# dsh-wuwa-pet

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520.11-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)

> 把 DeepSeek 的**余额 / 今日消耗 / 每轮花费**，直接弹在 [WuwaTappo](https://github.com/) 桌宠的头顶上。

一个 DeepSeek Harness（DSH）插件。它不替换桌宠，也不改 DSH 的界面——只是把账算清楚，然后借桌宠的气泡说出来。

![气泡效果](assets/screenshots/pet-bubbles.png)

---

## 它做什么

| 能力 | 说明 |
| --- | --- |
| **余额胶囊** | 桌宠头顶常驻一条：`余额 · 今日已用`，随对话自动刷新（默认 60 秒缓存） |
| **每轮消耗弹泡** | 一轮对话结束弹 `-¥0.0432 · 12,345 tok`，够用 5 秒自动收 |
| **提问 / 授权常驻提醒** | `ask_user_question` 或权限确认挂起时，琥珀色「等你回答」气泡**不会消失**，直到你处理完 |
| **峰谷倒计时** | 高峰/谷时切换前提醒，配合官方计价时段 |
| **自带账本** | 不装 `dsh-whale-widget` 也能算钱：按官方价目表在本地记账（`~/.dsh/.wuwa-pet-usage.json`） |
| **偶尔冒一句碎碎念** | 每隔几分钟在头顶冒一句，停几秒自己消失（**默认用内置台词池，不需要本地模型**） |
| **静音子智能体** | 子智能体的轮次默认不弹泡，避免刷屏 |

金额全部在本地算，**不向任何第三方服务器发送数据**。

---

## 环境要求

- **Windows**（脚本与桌宠都依赖 Windows）
- **DeepSeek Harness**（DSH）已安装并能正常登录账号
- **WuwaTappo 桌宠**（第三方桌宠，本仓库不包含、也不分发它）已安装
- **Node.js ≥ 20.11**（DSH 自带运行时即可）
- 想算钱还可选装 `dsh-whale-widget`——**不装也能用**，只是首次记账没有历史基线

---

## 安装

三种方式，按省事程度排序。**装完都要重启一次 DSH**，之后到 **插件 → 已安装** 里确认开关是打开的。

### A. 预构建包（推荐，免构建授权）

1. 到 [Releases](https://github.com/OolongBlackCoffee/dsh-wuwa-pet/releases/latest) 下载 `dsh-wuwa-pet-1.3.0.tgz`
2. 一条命令装上：

```powershell
dsh plugin add "C:\Users\你的用户名\Downloads\dsh-wuwa-pet-1.3.0.tgz"
```

也可以在 **插件 → 添加插件** 里直接选那个 `.tgz` 文件。

### B. 直接装 GitHub 仓库

```powershell
dsh plugin add https://github.com/OolongBlackCoffee/dsh-wuwa-pet
```

如果弹出「需要批准构建（allowBuilds）」，同意即可 —— 本插件**没有任何编译步骤**，这个批准只是让 pnpm 把依赖装完。

### C. 源码 + 目录链接（要改代码时用这种）

**1. 拿到代码**

```powershell
git clone https://github.com/OolongBlackCoffee/dsh-wuwa-pet.git D:\dsh-wuwa-pet
```

**2. 挂进 DSH 的 profile**

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop

# 以「目录链接」方式加入依赖（改动代码即时生效，不必重装）
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" add "link:D:\dsh-wuwa-pet"
```

> 没有全局 pnpm 时，用上面这种「直接跑 pnpm 的 mjs」写法最稳。装在别处就把路径换成你的 `pnpm`。

**3. 在 profile 的 `package.json` 里登记**

编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，在 `dsh.profile.bundles` 数组末尾加上包名：

```json
"bundles": [
  "……原有条目……",
  "dsh-wuwa-pet"
]
```

同时确认 `dependencies` 里有 `"dsh-wuwa-pet": "link:D:/dsh-wuwa-pet"`（上一步的 `pnpm add` 会自动写入）。

**4. 重启 DSH**

> 用 A/B 装的话，`dsh plugin add` 会自动写好依赖和 bundles，不需要手动改 `package.json`。

> 第一次加载时插件会自动跑一次 CDP 补丁（见下一节）。如果 WuwaTappo 正在运行，脚本会先关掉它再改、改完再拉起来。

---

## 关于「CDP 补丁」（重要）

桌宠的气泡是用 Chromium 远程调试协议（CDP）注入到 WuwaTappo 的页面里的，而 **WuwaTappo 默认不开放调试端口**。所以插件带了一个小脚本 `tools/deploy-cdp.ps1`，它在 WuwaTappo 的启动参数里补上：

```
--remote-allow-origins=* --remote-debugging-port=9222 --autoplay-policy=no-user-gesture-required
```

并保证参数区长度与原来完全一致（逐字节写入 + 尾部补空格），所以**不会破坏程序签名校验以外的任何结构**。

- **官方更新会覆盖掉这个补丁** —— 这正是插件默认 `autoDeploy: true` 的原因：每次 DSH 启动加载插件时，脚本会重新检测，没补就补。等价的命令行是：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "D:\dsh-wuwa-pet\tools\deploy-cdp.ps1" -Quiet
  ```

- 不想让它动你的程序？在插件配置里设 `"autoDeploy": false`，改为需要时手动跑上面的命令。
- 想彻底还原：`tools\还原CDP.bat`（脚本会从 `*.orig` 备份写回）。

> ⚠️ 这一步会修改 WuwaTappo **安装目录里的 exe**。脚本自身会留 `.orig` 备份，但请自行确认你接受这一行为；不做这一步，插件只是没有气泡可画，不会影响 DSH。

---

## 配置

配置写在 profile 的 `cordis.patch.yml`（插件条目下的 `config`）：

```yaml
- insert:
    - id: dsh-wuwa-pet
      name: dsh-wuwa-pet
      config:
        autoDeploy: true      # 加载时自动补 CDP 补丁
        cdpPort: 9222         # 与 deploy-cdp.ps1 注入的端口保持一致
        soundOn: true
        volume: 0.55
```

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `autoDeploy` | `true` | 插件加载时自动跑一次 CDP 补丁（WuwaTappo 更新后免手动） |
| `cdpPort` | `9222` | CDP 端口，必须与启动参数一致 |
| `tickMs` | `2500` | 忙时轮询间隔（毫秒） |
| `idleTickMs` | `8000` | 空闲时轮询间隔 |
| `balanceTtlMs` | `60000` | 余额缓存有效期 |
| `notifyOnTurnEnd` | `true` | 每轮结束弹消耗泡 |
| `muteSubagent` | `true` | 子智能体轮次不弹泡 |
| `notifyOnWait` | `true` | 提问/授权挂起时常驻提醒 |
| `waitTtlMs` | `180000` | 常驻提醒最长存活时间 |
| `questionTool` | `ask_user_question` | 视为「提问」的工具名 |
| `soundOn` / `volume` | `true` / `0.55` | 提示音开关与音量 |
| `toastMs` | `5000` | 普通气泡停留时长 |

---

## 数据与隐私

- 余额：通过 DSH 自己的账号通道读取，**只在内存里**。
- 用量：优先读 `dsh-whale-widget` 的本地账本（若安装）；否则用自带账本按官方价目表计算。
- 自带账本落盘在 `%USERPROFILE%\.dsh\.wuwa-pet-usage.json`，纯本地 JSON，删掉即重置。
- 插件**不联网上报**、不收集任何遥测。

计价口径（与官方高峰/谷时规则一致）：

- 工作日 09:00–12:00、14:00–18:00 为**高峰**，其余时段、周末与法定节假日为**谷时**
- 谷时单价（南向价，元 / 百万 token）：Flash 输入 0.02、缓存命中 1、输出 4；Pro 为上列三倍
- 金额以官方账单为准，这里是**估算**

---

## 排错

| 现象 | 处理 |
| --- | --- |
| 桌宠头顶没有气泡 | 看 `runtime-diag.json` 里 `link.connected` 是否为 `true`；为 `false` 说明 CDP 没连上——先确认 WuwaTappo 是用带调试端口的快捷方式启动的，再跑一次 `deploy-cdp.ps1` |
| 余额一直是「—」 | DSH 未登录账号，或账号接口暂时不可达 |
| 金额和我自己算的差一点 | 缓存命中价与时间边界（跨高峰）会导致尾差；以官方账单为准 |
| 端口被占用 | 把 `cdpPort` 和 `deploy-cdp.ps1 -Port` 改成同一个空闲端口 |
| 改完代码没生效 | 这是 `link:` 安装，重启 DSH 即可 |

---

## 目录结构

```
dsh-wuwa-pet/
├── lib/
│   ├── index.js        插件入口：事件、账本、气泡调度、自动部署
│   ├── balance.js      余额读取与缓存
│   ├── pricing.js      价目表与单轮计价
│   ├── ledger.js       与 dsh-whale-widget 账本对账（装了才用）
│   ├── selfledger.js   自带本地账本（聚合 / 对账 / seed）
│   ├── cdp.js          CDP 连接与页面发现
│   ├── inject.js       注入/重注入气泡脚本
│   ├── widget.js       注入到桌宠页面里的渲染层
│   └── wait.js         提问/授权挂起检测
├── tools/
│   ├── deploy-cdp.ps1      CDP 补丁（幂等，带 .orig 备份）
│   ├── 一键部署CDP.bat / 还原CDP.bat
│   ├── autostart-launch.ps1 开机自启（自动定位桌宠与 DSH 路径）
│   └── selftest-*.mjs     自检脚本
├── cordis.patch.yml    插件注册
└── screenshots.json    截图清单
```

自检：

```powershell
node tools\selftest-selfcost.mjs
node tools\selftest-ledger.mjs
node tools\test-smoke.mjs
```

---

## 变更记录

- **1.4.1** —— 新增「碎碎念」：每隔一段时间自己冒一句话，停几秒再自己消失（可关、可调周期、可换台词池）
- **1.4.0** —— 计费口径修复：今日金额不再被 whale 钱包差额覆盖，子代理轮次也计入账本
- **1.3.0** —— 插件加载时自动补 CDP 补丁（`autoDeploy`）；脚本去个人化（不再写死安装路径）；补截图与图标
- **1.2.0** —— 自带计价账本，不再依赖 `dsh-whale-widget`
- **1.1.0** —— 提问/授权挂起时常驻提醒
- **1.0.0** —— 初版：余额胶囊、每轮消耗泡、提示音

---

## 免责声明

本项目是**非官方**第三方插件，与 DeepSeek、WuwaTappo 的开发者均无关联。它会修改 WuwaTappo 安装目录下的可执行文件启动参数，请自行评估风险并做好备份；因使用本项目造成的任何问题由使用者自行承担。请遵守相关软件的服务条款。

## License

[MIT](LICENSE) © 2026 OolongBlackCoffee

---

# dsh-wuwa-pet (English)

A DeepSeek Harness plugin that shows your **DeepSeek balance and per-turn cost** as speech bubbles above a [WuwaTappo](https://github.com/) desktop pet.

**Features**

- Persistent balance capsule on the pet's head (balance + today's spend)
- Per-turn cost bubble: `-¥0.04 · 12,345 tok` (with sound, optional)
- Sticky amber "waiting for you" bubble while an `ask_user_question` or an approval is pending
- Peak/off-peak price awareness
- Built-in local cost ledger — no other plugin required (`%USERPROFILE%\.dsh\.wuwa-pet-usage.json`)

**Requirements**: Windows, DeepSeek Harness, Node.js ≥ 20.11, and a WuwaTappo desktop pet (not bundled).

**Install** (not on npm yet — two supported ways):

```powershell
# A. prebuilt tarball from Releases (no build step, no build approval)
dsh plugin add "%USERPROFILE%\Downloads\dsh-wuwa-pet-1.3.0.tgz"

# B. straight from GitHub
dsh plugin add https://github.com/OolongBlackCoffee/dsh-wuwa-pet

# C. from source, for hacking on it
git clone https://github.com/OolongBlackCoffee/dsh-wuwa-pet.git D:\dsh-wuwa-pet
cd $env:USERPROFILE\.dsh\profiles\desktop
node "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" add "link:D:\dsh-wuwa-pet"
# then add "dsh-wuwa-pet" to dsh.profile.bundles in package.json
```

Restart DSH once afterwards; the plugin shows up under **Plugins → Installed**.

The bubble layer is injected over CDP, so WuwaTappo must run with `--remote-debugging-port=9222`. `tools/deploy-cdp.ps1` patches the launcher arguments byte-for-byte (idempotent, keeps a `.orig` backup) and runs automatically on plugin load (`autoDeploy: true`). Set `"autoDeploy": false` to opt out.

**Privacy**: everything is local; no telemetry, no third-party requests. Costs are estimates — the official bill wins.

**License**: MIT. Not affiliated with DeepSeek or WuwaTappo.

## 十四、计费偏高修复（1.4.0，2026-10-28）

### 现象

桌宠的「今日已用 / 近 7 天」比自己逐轮加起来偏高，10-26 当天甚至到了 **¥22.98**。

### 根因（两处，都在自算账本的对账逻辑里）

1. **今天被「钱包差额」覆盖**：`reconcileHistory()` 每 60 秒把 `dsh-whale-widget` 的 `history[当天]` 抬进本插件账本（只升不降）。
   而 whale 的当日数字来自**余额观测**：`cur.delta += cur.lastBalance - remaining`（`dsh-whale-widget/lib/index.js:2646`、`apiTodayUsage()` L2663），
   它统计的是「钱包少了多少钱」，包含**子代理开销、其它窗口/其它工具的花费、以及充值时段的读数漂移**，与 token 明细不是一回事。
2. **子代理不计账**：`onTurnEnd()` 里 `if (cfg.muteSubagent && subagentSessions.has(sid)) return` 直接把子会话整轮跳过，
   于是自算明细**少了子代理那部分**，两边的差就被「钱包差额」补了上去 —— 两个错误互相掩盖，最终以偏高的那个数显示。

### 改法

- `lib/selfledger.js`
  - `seedFromWhale()`：**今天不再喂入** whale 的 history（历史天数照旧）。
  - `reconcileHistory()`：**今天永不改动**；历史天只有在**本插件没有任何事件明细**时才用 whale 的值兜底。
  - 新增 `repairDays()`：把「有明细的每一天」按明细重算，**只降不升**，一次性抹掉历史虚高；加载时自动跑。
- `lib/index.js`
  - 子代理轮次**照常记账**（`settleTurn(sid, attempt, quiet)`），`muteSubagent` 只负责不弹泡、不打扰。
  - `diag.costAudit` 新增对照：`{ todayEvents, todayWalletDelta, diff }`，能直接看出「钱包差额」比「逐轮合计」多多少。

### 实测

| 项目 | 修复前 | 修复后 |
|---|---|---|
| 今日（10-28） | ¥9.3998 | **¥8.6806**（= 30 轮事件合计） |
| 10-26 | ¥23.1786 | **¥6.0188** |
| 10-25 | ¥12.4205 | **¥10.8378** |
| 本周 | ¥50.3563 | **¥31.4236** |
| 抹掉合计 | — | **¥18.9425** |

自检：`node tools/selftest-selfcost.mjs` **39 项全过**（新增「今天不被钱包差额抬高」「有明细的历史天不被覆盖」「repairDays 只降不升且幂等」三条）；`node test-smoke.mjs` 全过。

> 注：钱包差额仍是**真实花费**的口径（含子代理）。现在两套数都有：显示用逐轮明细，`diag.costAudit` 里保留钱包差额做对照。差异主要来自「其它窗口/其它工具」的消耗。

## 十五、碎碎念（1.4.1，2026-10-28）

桌宠会**时不时自己冒一句话**，停几秒再自己消失——不是弹一个就永久挂在那儿的静态气泡。

### 行为

- 默认每 **5 分钟**左右说一句（可抖动 ±25%，避免整点打卡），气泡**停留 9 秒**后淡出并清空文本。
- 台词按**时段**挑（早上 / 白天 / 傍晚 / 深夜各一套），说完一句会**避免立刻重复**同一句。
- **不抢话**：如果此刻正有「等你回答 / 待授权」的琥珀色挂起泡、面板展开、或者光标正停在输入框/可编辑区，这一句会**跳过**，35 秒后再试。
- 气泡样式与消耗泡一致（白色圆角 + 下方小尾巴 + 鲸鱼前缀），`pointer-events: none`，不挡点击；点一下气泡会立刻收起。

### 配置（`cordis.patch.yml` 里 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `whisperEnabled` | `true` | 关掉就完全不说话 |
| `whisperEveryMs` | `300000` | 间隔（毫秒），最小 20000 |
| `whisperHoldMs` | `9000` | 气泡停留时长 |
| `whisperJitter` | `0.25` | 间隔抖动比例（0–0.9） |
| `whisperLines` | `[]` | 自定义台词池；留空用内置池 |

自定义台词池两种写法都认：

```yaml
whisperLines: ["今天也要好好的", "记得喝水～"]
# 或者按时段：
whisperLines:
  - { text: "早上好呀", when: morning }
  - { text: "夜深了，早点睡", when: night }
```

### 实现

- `lib/whisper.js`：台词池 + 时段筛选 + 避免重复 + 间隔抖动（纯逻辑，无 IO）。默认不调用任何模型，所以碎碎念本身零成本、离线可用。
- `lib/index.js`：15 秒 tick 的定时器（到点才说），页面说「此刻不方便」时 35 秒后重试；`dispose` 里随插件一起停。
- `lib/widget.js`（1.2.0）：独立的 `.dshw-whisper` 气泡节点，`show`/`out` 两态 + 360ms 淡出，淡出后才清空文本。
- 验收：`node tools/test-whisper-offline.mjs` —— 用 Edge headless 起一个假页面注入 widget，断言「出现 → 停留 → 自动消失」（实测 T+0.5s `show`/opacity 1、T+4.2s 已清空/opacity 0），并顺手截图 `assets/screenshots/whisper.png`。

## 十六、碎碎念接本地模型（1.5.0，2026-10-29）

**默认不需要任何本地模型**：内置台词池开箱即用，不装模型也能正常碎碎念。

想让每句话都不一样，才需要用下面这套：把碎碎念切到**本机 llama.cpp**（OpenAI 兼容接口）现写一句，实测 4B 模型 **250–350 ms** 出一句，不花云额度。

```yaml
- id: dsh-wuwa-pet
  config:
    whisperSource: llm
    whisperLlmUrl: http://127.0.0.1:8080/v1/chat/completions
```

- 新增配置：`whisperSource`（`pool`/`llm`，默认 `pool`）、`whisperLlmUrl`、`whisperLlmModel`（留空自动取第一个）、`whisperLlmTimeoutMs`（默认 30000）、`whisperLlmPrompt`（自定义人设）。
- **永不因为模型掉线而沉默**：模型没开 / 超时 / 返回不合格都自动回退内置台词池。
- 首次冒泡**先用池子的句子**，同时后台预热模型（首句推理要 20 秒上下），从第二次起才走模型。
- 最近 5 句会作为「别重复」提示一起发过去，实测三连不撞。

完整说明（含 llama-server 启动命令、配置全表、自检与排错）见 [`docs/whisper-llm.md`](docs/whisper-llm.md)。自检：`node tools/test-whisper-llm.mjs`。