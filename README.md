# Misskey 到 X 同步服务

Misskey webhook 收到帖子后，服务只把带配置标签的原创帖子发布到 X。默认标签是 `#to_x`。服务使用 Rettiwt-API 7.1.4，并在 SQLite 中保存队列和发布状态，Docker 重启后可以继续处理。

## 重要说明

`API_KEY` 不是 X Developer Portal 的 OAuth API Key。Rettiwt 使用 X 登录 Cookie 的 Base64 字符串，包含 `auth_token`、`ct0`、`twid`。该凭据等同于账号登录凭据，必须只放在 VPS 的 `.env` 或 Secret 管理器，不要提交 Git 或打印日志。

按当前配置，Misskey 的 `public`、`followers`、`specified`、`direct` 等可见性都会同步到公开的 X。私密帖子可能因此公开，生产使用前请确认这是你的明确意图。

## 快速部署

在 VPS 上：

```bash
git clone <你的仓库地址> misskey2x
cd misskey2x
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```env
API_KEY=Rettiwt生成的Base64字符串
MISSKEY_WEBHOOK_SECRET=随机长字符串
REQUIRED_TAG=to_x
PORT=3000
DATABASE_PATH=/data/misskey-to-x.sqlite
MEDIA_ALLOWED_HOSTS=
RETTIWT_LOGGING=false
```

启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

数据位于 Docker volume `misskey2x_misskey_to_x_data`，不要删除该 volume，否则会丢失去重和任务状态。

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

## Misskey Webhook

在 Misskey 管理界面创建 Webhook：

```text
URL: http://VPS地址:3000/webhooks/misskey
Secret: 与 MISSKEY_WEBHOOK_SECRET 完全一致
事件: Note posted
```

建议通过反向代理提供 HTTPS。Webhook 服务只接受 JSON，并使用 `X-Misskey-Hook-Secret` 校验请求。

支持的响应：

```text
202 queued       已进入队列
202 duplicate    note.id 已处理或已入队
202 ignored      非原创、未命中标签或不支持的事件
400 invalid_json
401 invalid_webhook_secret
413 request_body_too_large
415 content_type_must_be_json
```

查询任务：

```bash
curl \
  -H 'X-Misskey-Hook-Secret: 你的secret' \
  'http://127.0.0.1:3000/webhooks/misskey/status?note_id=笔记ID'
```

`202 queued` 只代表已写入 SQLite，不代表 X 已发布。最终结果看状态端点和容器日志。

## 同步规则

- `REQUIRED_TAG` 可设置为其他标签，比较不区分大小写。
- 控制标签只作开关，不会出现在 X 正文；其他标签保留。
- URL 中的 `#to_x` 不会触发同步。
- 回复、引用、Renote 跳过；`#no_to_x` 没有特殊语义。
- `cw` 会变成 `CW: ...` 前缀。
- 长文按 X 加权长度拆成回复串，URL 和 grapheme 不会被切断。
- 支持 JPEG、PNG、WebP、GIF；每个附件最大 5 MB。
- 每条 X 帖子最多 4 张普通图片；GIF 单独成帖。
- 视频、音频、失效附件会跳过，文字仍继续发布。
- 附件只允许 HTTPS，并拒绝重定向、凭据 URL、私有/保留 IP；可用 `MEDIA_ALLOWED_HOSTS` 限制域名。

## Rettiwt CLI

容器使用普通 `CMD`，可以覆盖执行 Rettiwt CLI：

```bash
docker compose run --rm app rettiwt help
docker compose run --rm app rettiwt user details <用户名>
docker compose run --rm app rettiwt tweet post '测试帖子'
```

CLI 同样读取 `.env` 中的 `API_KEY`。真实发帖前建议先用测试账号验证凭据和账号权限。

## 开发验证

```bash
npm install
npm test
npm run check
docker compose config
```

测试不使用真实 X 账号，只 mock Rettiwt。生产发帖必须在 VPS 配置真实 `API_KEY` 后手工验证。
