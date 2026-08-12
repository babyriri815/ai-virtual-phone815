# Float Cloudflare 离线主动消息

这套流程把 Float 原本只能在网页开启时运行的主动消息，转交给用户自己的 Cloudflare Worker、D1 与 Web Push。角色提示词、世界书、近期聊天与绑定模型仍由 Float 原本的提示词生成器组装，不会改用另一套角色设定。

## Cloudflare Token 权限

建议建立专用 API Token，并只授予自己的帐号：

- Account Settings：Read
- Workers Scripts：Edit
- D1：Edit

Token 只在「设置 → 离线主动消息」部署时使用。它经由用户自己的 Float/Netlify API 呼叫 Cloudflare，不写入浏览器、GitHub 或 Worker。部署完成后，Float 只保存该 Worker 的专用连接 Token。

## 部署步骤

1. 先把包含本功能的 Float 分支部署到 Netlify。
2. 打开 Float 的「设置 → 离线主动消息」。
3. 贴上 Cloudflare API Token，读取帐号并选择目标帐号。
4. Worker 名称可留空；全新 Cloudflare 帐号若尚无 `workers.dev` 子网域，填一个尚未被使用的名称。
5. 按「部署」。流程会建立一个 Worker、一个 D1 数据库、每分钟执行一次的 Cron Trigger，并自动产生 VAPID 金钥。
6. 部署完成后按「允许通知并启用」。iPhone 必须先从 Safari 将 Float 加到主画面，再从主画面版本开启通知。

## 运作方式与限制

- 当 Float 原本的焦虑值规则排定主动消息时，完整提示会加密后交给 Worker；云端成功收下后，本机计时器会清掉，避免重复发送。
- 使用者在主动消息发出前继续聊天时，Float 会同时取消本机与云端排程。
- Web Push 不是资料库；Service Worker 会先写入离线收件匣，Float 下次开启也会从 Worker outbox 补拉未确认消息后才销帐。
- Cloudflare Cron 最小粒度是一分钟，所以实际送达可能比原定时间多等约 0–60 秒。
- 云端生成目前使用 OpenAI-compatible `/chat/completions` 格式。OpenAI、DeepSeek、OpenRouter、Groq 与大多数相容中转可用；Google Gemini 与 Anthropic 原生格式需改用相容中转。
- 暂停功能会取消 Float 记录中的尚未发送任务，但不会删除 Cloudflare Worker 或 D1。忘记本机设定也不会删除云端资源。
