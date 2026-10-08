# Misskey 到 X 同步服务

接收 Misskey Webhook，把带 `#to_x` 的原创帖子异步发布到 X。服务使用 Rettiwt-API，在 SQLite 中保存队列和发布状态。

## 前置条件

已安装 Docker Engine、Docker Compose，并准备一个 X 发布账号和 HTTPS Webhook 地址。README 不包含 Docker 安装教程，请参考目标系统官方文档。

## 配置

```bash
git clone <仓库地址> misskey2x
cd misskey2x
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```env
# Rettiwt-API 的 Cookie Base64 字符串，不是 X Developer Portal API Key
API_KEY=

MISSKEY_WEBHOOK_SECRET=
REQUIRED_TAG=to_x
PORT=3000
DATABASE_PATH=/data/misskey-to-x.sqlite
MEDIA_ALLOWED_HOSTS=
RETTIWT_LOGGING=false
```

`API_KEY` 由 X 登录 Cookie `auth_token`、`ct0`、`twid` 组成。浏览器登录 X 后，在开发者工具 Console 中生成：

```js
btoa("auth_token=你的_auth_token;ct0=你的_ct0;twid=你的_twid;")
```

把输出的一整行填入 `API_KEY`。不要提交或公开 `.env`。`X_API_KEY`、`X_ACCESS_TOKEN` 等官方 OAuth 变量当前不会被读取。

## 启动

```bash
docker compose up -d --build
docker compose ps
curl http://127.0.0.1:3000/healthz
```

健康检查返回 `{"ok":true}` 即表示服务已启动。生产环境建议由 HTTPS 反向代理转发到本机 `3000` 端口。

查看日志：

```bash
docker compose logs -f app
```

服务输出单行 JSON 日志，包含接收时间、事件、Misskey note ID、原始正文和发送到 X 的正文。常见事件包括 `webhook_received`、`webhook_queued`、`x_publish_started`、`x_publish_completed`、`forward_completed`、`forward_retry_scheduled` 和 `forward_failed`。只看转发事件：

```bash
docker compose logs -f --no-log-prefix app | jq -c 'select(.event | test("webhook|publish|forward"))'
```

不要执行 `docker compose down -v`，否则会删除 SQLite 数据卷。

## Misskey Webhook

在 Misskey 管理界面创建 Webhook：

```text
URL: https://你的域名/webhooks/misskey
Secret: 与 MISSKEY_WEBHOOK_SECRET 完全一致
事件: Note posted
```

服务只接受 JSON，并使用 `X-Misskey-Hook-Secret` 校验请求。常见响应：

```text
202 queued       已进入队列
202 duplicate    note.id 已处理或已入队
202 ignored      未命中标签、回复、引用或 Renote
401 invalid_webhook_secret
```

`202 queued` 只表示任务已写入 SQLite，不代表 X 已发布。可查询最终状态：

```bash
command curl \
  --header 'X-Misskey-Hook-Secret: 你的MISSKEY_WEBHOOK_SECRET' \
  'https://你的域名/webhooks/misskey/status?note_id=你的note_id'
```

## 同步规则

- `REQUIRED_TAG` 是同步开关，默认 `to_x`，比较不区分大小写；控制标签不会出现在 X 正文。
- Misskey 自定义表情短码（例如 `:lty_9th_09:`）不会发布到 X；Unicode emoji 会保留。
- `#no_to_x` 没有特殊语义。
- 回复、引用、Renote 跳过；URL 中的标签不会触发同步。
- `cw` 会变成 `CW: ...` 前缀；长文会按 X 加权长度拆分为回复串。
- 支持 JPEG、PNG、WebP、GIF；单个附件最大 5 MB。视频、音频和无效附件跳过，文字继续发布。
- 附件只允许 HTTPS，可用 `MEDIA_ALLOWED_HOSTS` 限制域名。
- Misskey 的私密性不会映射到 X；发布前确认内容可以公开。

## 手工测试

此请求会把帖子加入队列；凭据有效时可能真实发布到 X：

```bash
command curl --request POST \
  --header 'Content-Type: application/json' \
  --header 'X-Misskey-Hook-Secret: 你的MISSKEY_WEBHOOK_SECRET' \
  --data-raw '{"type":"note","body":{"id":"manual-test-1","text":"#to_x test"}}' \
  'https://你的域名/webhooks/misskey'
```

## 开发验证

```bash
npm install
npm test
npm run check
docker compose config -q
```
