# 碎碎念接本地模型（whisperSource: llm）

> 这一节讲 1.5.0 新增的「让桌宠用本机大模型现写碎碎念」：它是可选的，默认仍然走内置台词池。

## 一句话

`whisperSource: 'llm'` 时，桌宠每次冒泡前会问一下本机的 llama.cpp（OpenAI 兼容接口）现写一句；**模型没开、超时、返回不合格**都会自动回落到内置台词池，绝不因为模型掉线就沉默。

## 为什么要有它

内置台词池（`lib/whisper.js`，约 30 条按时段挑）零成本、零延迟、断网也能用，但句子是固定的，看久了会重复。
接本地模型后，同一句「照顾一下开发者」的意思每次都不一样：

```
别皱眉呀，Bug 只是代码在睡觉。
代码写得再好，也要记得按时吃饭呀。
别盯着屏幕啦，去喝口水歇一歇。
摸摸头啦，眼睛酸的话就眨眨眼哦。
```

实测：本机 RTX 4060 Laptop + Qwen3.5-4B（Vulkan）约 **250–350 ms** 出一句，不占云额度。

## 怎么开

改 `~/.dsh/profiles/desktop/cordis.patch.yml`，加一条（id 必须是 `dsh-wuwa-pet`）：

```yaml
- id: dsh-wuwa-pet
  config:
    whisperSource: llm
    whisperLlmUrl: http://127.0.0.1:8080/v1/chat/completions
```

重启 DSH 生效。**注意**：这个 patch 一旦写了 `config`，插件自己 `cordis.patch.yml` 里的其它字段（`cdpPort`、`tickMs`、`volume`…）仍来自插件默认值，不受影响。

## 先准备好本地模型

小模型推荐 4B（2.7 GB，8 GB 显存够用），用 `D:\local-ai` 里的启动脚本：

```bat
:: 直接双击，或在命令行启动
D:\local-ai\启动-4B-极速.bat
```

它内部的等价命令是：

```bat
llama-server.exe ^
  --model "D:\local-ai\models\Qwen3.5-4B-UD-Q4_K_XL.gguf" ^
  --chat-template-kwargs "{\"enable_thinking\":false}" ^
  --device Vulkan1 -ngl 99 --ctx-size 16384 --flash-attn on ^
  --host 127.0.0.1 --port 8080
```

> 换句话说：**地址是 `http://127.0.0.1:8080`（OpenAI 兼容）**，你换别的服务（Ollama 的 `/v1`、vLLM…）只要改 `whisperLlmUrl` 就行。

## 配置项全表

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `whisperSource` | `pool` | `pool` 内置台词池 / `llm` 本地模型现写 |
| `whisperLlmUrl` | `http://127.0.0.1:8080/v1/chat/completions` | OpenAI 兼容端点（`/v1/chat/completions`） |
| `whisperLlmModel` | 空 | 留空 = 自动取 `/v1/models` 里的第一个 |
| `whisperLlmTimeoutMs` | `30000` | 单次生成超时；超时即回退池子 |
| `whisperLlmPrompt` | 空 | 自定义人设，留空用内置的「陪写代码的小鲸鱼」人设 |

## 两个已埋好的坑

1. **首次推理很慢**：模型刚起来时第一句要 20 秒上下（chat template + KV 预热完毕后才 250 ms）。所以插件在第一次冒泡时**先用池子的句子**，同时后台跑一次预热，从第二次起才走模型——第一个气泡不会让你干等 20 秒。想立刻验证的话，先在浏览器里问一句 `http://127.0.0.1:8080` 把模型焐热。
2. **不会说重复句**：最近 5 句会作为「别再重复」提示一起发过去（提示词里已包含），实测三连不撞。

## 自检

```powershell
# 端点通不通、模型叫什么、出句质量如何
node D:\dsh-wuwa-pet\tools\test-whisper-llm.mjs
```

输出示例（4B，服务已就绪）：

```
探活 OK，model=D:\local-ai\models\Qwen3.5-4B-UD-Q4_K_XL.gguf，耗时 40 ms
[1] 340 ms → 「代码写得再好，也要记得按时吃饭呀。」
```

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 一直说话但都是老句子 | 模型没起 / 端口不对：浏览器打开 `http://127.0.0.1:8080/v1/models` 看有没有 JSON |
| 第一句等很久 | 正常，首句 20 s 上下；见上面「两个已埋好的坑」 |
| 提示 `json.exception.parse_error` | 启动参数里的 `--chat-template-kwargs` 被 shell 吞了引号，改用环境变量 `LLAMA_ARG_CHAT_TEMPLATE_KWARGS` |
| 提示音/气泡都不冒 | 那是 `whisperEnabled: false` 或桌宠没连上，跟模型无关 |

| 提示 `ECONNREFUSED 127.0.0.1:8080` | 模型没启动；双击 `D:\local-ai\启动-4B-极速.bat` |
| 4B 之外还试过 9B | 9B 要 5.6 GB 显存，出句更慢（约 1.5 s），日常碎碎念用 4B 更划算 |

## 与 1.4.1 的差别

| | 1.4.1（纯台词池） | 1.5.0（可接模型） |
| --- | --- | --- |
| 句子来源 | 内置约 30 条 | 池子 / 本机模型现写 |
| 每句话是否不同 | 会重复 | 不重复（带最近 5 句去重提示） |
| 延迟 | 瞬时 | 首次 20 s、之后 250–350 ms（首次自动用池子，不卡气泡） |
| 依赖 | 无 | 需本机 llama-server（不启动自动回退池子） |
| 成本 | 0 | 0（本地推理，不花云额度） |
