# Misskey 到 X 同步服务

Misskey webhook 收到帖子后，服务只把带配置标签的原创帖子发布到 X。默认标签是 `#to_x`。服务使用 Rettiwt-API 7.1.4，并在 SQLite 中保存队列和发布状态，Docker 重启后可以继续处理。

## 先分清两种 API Key

当前代码只使用下面这个变量：

```env
API_KEY=Rettiwt_API_KEY
```

这里的 `API_KEY` 是 **Rettiwt-API 的登录 Cookie Base64 字符串**，不是 X Developer Portal 的 `API Key`。它由 X 账号 Cookie `auth_token`、`ct0`、`twid` 组成，权限等同于该账号的网页登录凭据。

官方 X Developer Portal 的 OAuth 1.0a 凭据通常叫：

```env
X_API_KEY=
X_API_KEY_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
```

当前服务没有读取这四个变量，也没有使用官方 OAuth API。把官方 `X_API_KEY` 填入当前服务的 `API_KEY` 会认证失败；把四个 `X_*` 变量加进 `.env` 也不会改变当前行为。

## 1. VPS 准备

以下命令适用于 Debian 12 和 Ubuntu 24.04。以 SSH 登录 VPS 后安装 Docker Engine 和 Compose 插件：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
. /etc/os-release
case "$ID" in
  debian) DOCKER_OS=debian ;;
  ubuntu) DOCKER_OS=ubuntu ;;
  *) echo "仅支持 Debian 或 Ubuntu" >&2; exit 1 ;;
esac
DOCKER_CODENAME=${UBUNTU_CODENAME:-$VERSION_CODENAME}
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/${DOCKER_OS}/gpg" | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${DOCKER_OS} ${DOCKER_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

教程中的 Docker 命令默认当前账号已加入 `docker` 组；加入该组可控制宿主机，权限等同 root：

```bash
sudo usermod -aG docker "$USER"
```

退出 SSH 后重新登录，再确认版本：

```bash
docker --version
docker compose version
```

如果启用了 UFW，至少允许 SSH、HTTP 和 HTTPS：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Compose 当前会把容器的 3000 端口发布到 VPS 所有网卡。临时直连测试需在 VPS 云防火墙额外允许 3000/tcp；生产环境应在云防火墙封锁外部 3000/tcp，仅开放 80/443，并使用 Caddy 或 Nginx 将 HTTPS 请求反向代理到 `127.0.0.1:3000`。Docker 发布端口可能绕过 UFW 规则，不要只靠 UFW 保护 3000。Misskey Webhook URL 应使用 HTTPS。

## 2. 下载项目并创建环境文件

```bash
git clone <你的仓库地址> misskey2x
cd misskey2x
cp .env.example .env
chmod 600 .env
```

`.env` 已被 `.gitignore` 排除。不要把它提交 Git、贴到聊天、写进截图或打印到日志。

## 3. 生成 Rettiwt `API_KEY`

Rettiwt-API 需要 X 登录 Cookie。建议使用单独的 X 账号，不要在公共电脑操作。

### 3.1 复制三个 Cookie

1. 浏览器打开 `https://x.com`，登录准备发布帖子的账号。
2. 按 `F12` 打开开发者工具。
3. Chrome/Chromium 进入 `Application -> Storage -> Cookies -> https://x.com`；Firefox 进入 `Storage -> Cookies -> https://x.com`。
4. 找到并复制下面三个 Cookie 的 **Value**，不要复制 Name：

```text
auth_token
ct0
twid
```

Cookie 可能在 `https://twitter.com` 域名下；如果 `x.com` 下找不到，也检查该域名。不要复制带空格、换行或引号的值。

### 3.2 在浏览器 Console 生成 Base64

打开开发者工具的 `Console`，把下面命令中的三个占位符替换为刚才的值：

```js
btoa("auth_token=你的_auth_token;ct0=你的_ct0;twid=你的_twid;")
```

Console 输出的一整行字符串就是 Rettiwt `API_KEY`。不要把这三个 Cookie 或输出字符串发给别人；若泄露，应在 X 中退出其他会话并重新登录以更新 Cookie。

### 3.3 写入 VPS `.env`

编辑文件：

```bash
nano .env
```

至少填写：

```env
API_KEY='这里粘贴Console输出的完整一行'
MISSKEY_WEBHOOK_SECRET='这里填写随机长字符串'
REQUIRED_TAG=to_x
PORT=3000
DATABASE_PATH=/data/misskey-to-x.sqlite
MEDIA_ALLOWED_HOSTS=
RETTIWT_LOGGING=false
```

Base64 结果通常包含 `+`、`/`、`=`；放在单引号中最稳妥。不要在等号两侧添加空格，也不要把三组 Cookie 分别填入三个变量。当前服务只需要最终 Base64 字符串：

```env
API_KEY='一整行Base64结果'
```

生成 Webhook secret：

```bash
openssl rand -hex 32
```

把输出复制到 `MISSKEY_WEBHOOK_SECRET`，并在 Misskey Webhook 中使用完全相同的值。不要执行会把 `.env` 全部打印出来的命令，例如 `docker compose config` 或 `cat .env`，因为输出可能泄露密钥。修改环境变量后，需重新创建容器才会读取新值：`docker compose up -d --force-recreate`。

### 3.4 不泄露密钥地检查变量已传入容器

```bash
docker compose run --rm app node -e "process.exit(process.env.API_KEY ? 0 : 1)"
```

返回码为 `0` 代表变量存在，不会打印密钥。也可以检查 Rettiwt CLI 能否加载：

```bash
docker compose run --rm app rettiwt help
```

这只检查 CLI 启动；真正发帖仍需要有效且未过期的 Cookie。

## 4. 官方 X `X_API_KEY` 应该怎么填

如果你手里的是 X Developer Portal 的四个 OAuth 1.0a 值，它们属于另一种认证方式：

```env
X_API_KEY='Developer Portal 中的 API Key'
X_API_KEY_SECRET='Developer Portal 中的 API Key Secret'
X_ACCESS_TOKEN='账号 Access Token'
X_ACCESS_TOKEN_SECRET='账号 Access Token Secret'
```

获取位置通常是 `developer.x.com -> Projects & Apps -> 你的 App -> Keys and Tokens`。发布权限需要 `Read and write`；修改权限后要重新生成 Access Token。

在 VPS 项目根目录编辑 `.env`，把对应值填入上面的四行即可。当前 Docker Compose 和 Rettiwt 适配器都不读取或传入这些变量，因此它们不会启用官方 OAuth，也不能替代 Rettiwt 的 `API_KEY`。如果要切换官方 X API，需要改写 `src/x.js` 的认证和发布实现。

## 5. 启动 Docker 服务

先确认 `.env` 权限：

```bash
chmod 600 .env
```

构建并后台启动：

```bash
docker compose up -d --build
docker compose ps
```

查看日志：

```bash
docker compose logs --tail=100 app
docker compose logs -f app
```

健康检查：

```bash
curl http://127.0.0.1:3000/healthz
```

预期：

```json
{"ok":true}
```

按本教程目录名运行时，数据位于 Docker volume `misskey2x_misskey_to_x_data`。Compose volume 名称由项目目录名加 `misskey_to_x_data` 组成。不要执行 `docker compose down -v`，否则会删除 SQLite，丢失去重记录、已发布帖子状态和待处理任务。

## 6. 配置 Misskey Webhook

在 Misskey 管理界面创建 Webhook：

```text
URL: https://你的域名/webhooks/misskey
Secret: 与 MISSKEY_WEBHOOK_SECRET 完全一致
事件: Note posted
```

如果暂时直接暴露 VPS 端口：

```text
URL: http://VPS公网IP:3000/webhooks/misskey
```

建议只启用 Note posted。服务自身还会过滤回复、引用和 Renote。所有 Misskey 可见性目前都会同步到公开的 X，包括 `followers`、`specified`、`direct`；私密帖子可能因此公开，启用前必须确认接受该行为。

Webhook 只接受 JSON，并使用 `X-Misskey-Hook-Secret` 校验请求。

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

## 7. 手工发送测试 Webhook

先确保服务运行。此命令会把 `#to_x` 内容加入队列；使用有效 `API_KEY` 时会真实发布到公开 X 账号。确认接受公开发布后再运行，并替换测试文本。下面命令适合 fish、bash 和 zsh：

```bash
command curl --verbose \
  --request POST \
  --header 'Content-Type: application/json' \
  --header 'X-Misskey-Hook-Secret: 你的MISSKEY_WEBHOOK_SECRET' \
  --data-raw '{"type":"note","body":{"id":"manual-test-1","text":"#to_x Docker test"}}' \
  'https://你的域名/webhooks/misskey'
```

预期返回 HTTP `202` 和类似结果：

```json
{"action":"queued","noteId":"manual-test-1"}
```

`202 queued` 只代表已写入 SQLite，不代表 X 已发布。查询最终状态：

```bash
command curl --verbose \
  --header 'X-Misskey-Hook-Secret: 你的MISSKEY_WEBHOOK_SECRET' \
  'https://你的域名/webhooks/misskey/status?note_id=manual-test-1'
```

成功状态中应有：

```json
{"status":"completed","published":{"0":"X帖子ID"}}
```

再次发送相同 `note.id` 会返回 `duplicate`，不会再次发布。没有 `#to_x` 的帖子会返回 `ignored`。

## 8. 同步规则

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

## 9. Rettiwt CLI

容器使用普通 `CMD`，可以覆盖执行 Rettiwt CLI：

```bash
docker compose run --rm app rettiwt help
docker compose run --rm app rettiwt user details <用户名>
docker compose run --rm app rettiwt tweet post '测试帖子'
```

CLI 同样读取 `.env` 中的 `API_KEY`。真实发帖前建议先用测试账号验证凭据和账号权限。

其中 `rettiwt tweet post` 会直接发布公开帖子。确认文本和账号后再执行。

## 10. 常见故障

- `API_KEY is required`：检查项目根目录 `.env` 是否有非空 `API_KEY`；用第 3.4 节的检查命令确认变量已传入容器。修改 `.env` 后执行 `docker compose up -d --force-recreate`。
- Rettiwt 返回认证或权限错误：`API_KEY` 必须是当前 X 登录 Cookie 的 Base64 值，不是 Developer Portal 的 API Key。Cookie 过期时重新生成并更新 `API_KEY`，然后重新创建容器。
- Webhook 返回 `401 invalid_webhook_secret`：核对 `.env` 的 `MISSKEY_WEBHOOK_SECRET` 与 Misskey Webhook Secret，注意不要多空格或换行；修改后重新创建容器。
- Webhook 返回 `202 queued`，X 却没帖子：`202` 只代表进入 SQLite 队列。用状态端点检查 `status`、`attempts` 和 `lastError`，同时查看 `docker compose logs --tail=100 app`。状态 `retry` 会等待退避时间；`dead` 需修复原因后用新的 Misskey note ID 重新触发，同一个 ID 会被当成重复任务。
- 图片没有出现在 X：查看状态中的 `media` 以及服务日志。无效、非支持类型、过大、非 HTTPS 或被安全规则拒绝的附件会跳过，正文仍会发布。

## 11. 开发验证

```bash
npm install
npm test
npm run check
docker compose config -q
```

测试不使用真实 X 账号，只 mock Rettiwt。生产发帖必须在 VPS 配置真实 `API_KEY` 后手工验证。
