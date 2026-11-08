# 变更说明书：公网路径（mount + app segment）

## 目标

在反向代理（如 CDSW `/proxy/{id}/…`）后，dashboard、chat、plugins、apps、`/api`、`/v1` 均以统一公网形态访问：

```text
{mount}/{appSegment}{internal}
```

示例：`/proxy/1080/cursor-agent/chat`、`/proxy/1080/agent-7f3k9a/v1/chat/completions`。

## 设计要点

| 项 | 行为 |
|----|------|
| `CURSOR_BRIDGE_APP_SEGMENT` | 可配置，默认 `cursor-agent`；CAI 无配置时持久化随机 `agent-*` |
| mount | 每请求从 pathname 解析，**无** `CURSOR_BRIDGE_MOUNT` |
| `/healthz` | 始终在进程根路径，供 CAI 探针 |
| 虚拟路径根 `/`、`/index.html`、`/{mount}/` | 返回 bootstrap HTML，跳转 `{mount}/{appSegment}/` |
| HTML | 服务端注入 `__BRIDGE_PUBLIC_BASE__` 并重写 `href`/`src` |
| JS | `public/bridge-path.js` + `bridgePath()` / `apiFetch` |
| 出站 URL | `publicPath(internal, mount, appSegment)` |
| 直连（无 segment） | 本地兼容 `/v1`、`/api` 等（见 [PUBLIC-PATH.md](./PUBLIC-PATH.md)） |

## 变更文件清单

### 新增

- `src/lib/http-public-path.ts` — 拆分/拼接路径
- `src/lib/bridge-incoming-path.ts` — 入站规范化
- `src/lib/bridge-request-context.ts` — 请求上下文
- `src/lib/bridge-html.ts` — bootstrap + HTML 重写
- `src/lib/app-segment.ts` — 段名解析与持久化
- `public/bridge-path.js`
- `docs/PUBLIC-PATH.md`、本说明书

### 修改

- `src/lib/request-listener.ts` — 入口 strip
- `src/lib/config.ts` — `appSegment`
- `src/lib/admin-dashboard.ts` — `serveBridgeHtml`、`/api/config`
- `src/lib/dynamic-apps.ts` — 重定向与列表 URL
- `src/lib/plugins/public-origin.ts` — `resolvePublicAppBase`
- `src/lib/server.ts` — 注册保留段、启动日志
- `public/app.js`、`chat-app.js`、`plugins-app.js`、`wiki.js`、`upstream-sync-banner.js`
- 测试夹具 `appSegment`
- `.env.example`、`README.md`（env 表）

## 验证

```bash
npm run typecheck && npm run build && npm test
```

手动：

1. `GET /healthz` → `ok`
2. `GET /` → bootstrap
3. `GET /cursor-agent/` → dashboard
4. `GET /proxy/1080/cursor-agent/api/config` → JSON 含 `appSegment`、`publicBase`

## 运维约定

反代须保留完整 path（或仅在边缘处理根路径跳转）。详见 [PUBLIC-PATH.md](./PUBLIC-PATH.md)。
