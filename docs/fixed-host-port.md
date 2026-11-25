# DSH 启动崩溃：`bad port`（host 端口随机到禁止端口）

> 症状：DSH 0.2.2-rc.5 启动即弹「应用无法启动或已意外停止」，日志
> `crash-*-host.log` 里是 `[TypeError: fetch failed] { [cause]: Error: bad port }`，
> 位置 `authenticateWebHost`，`phase: startup`。

## 结论先说

**和本插件的账号池无关，也和 provider 的 baseURL 无关。**

`authenticateWebHost(url)` 的 `url` 是 **DSH 自己的 Host 进程上报的 launch URL**
（`app.asar` 注释原文：*Authenticated URL reported by the owned Host process*），
不是 provider 端点。崩溃发生在壳与它自己后端的握手上。

## 为什么是必然

`@deepseek-ai/dsh-web-app` 的 patch 里：

```yaml
- id: webserver
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

桌面端传 `--port 0` → `server.listen(0)` → 端口交给系统随机分配。
本机 Windows 的动态端口范围可能是：

```
> netsh int ipv4 show dynamicport tcp
启动端口: 1024
端口数  : 13977        → 实际区间 1024–15000
```

而且分配器是**递增游标**（连续 `listen(0)` 会得到 3765、3766、3767…）。
游标走到 `5060` / `5061` 这一段时启动，Host 就绑到了
[WHATWG 禁止端口](https://fetch.spec.whatwg.org/#port-blocking)（SIP 端口），
壳再用 `fetch` 访问自己 → `bad port` → 启动期崩溃。

同表里落在 1024–15000 的还有：1719、1720、1723、2049、3659、4045、4190、
5060、5061、6000、6566、6665–6669、6679、6697、10080。

## 一个必须区分的事实

`bad port` 只由**禁止端口**产生，端口空着不会：

```
fetch http://127.0.0.1:5060  →  fetch failed / bad port
fetch http://127.0.0.1:5061  →  fetch failed / bad port
fetch http://127.0.0.1:5065  →  fetch failed / connect ECONNREFUSED   ← 只是没人监听
```

所以「账号池端口没起来 → 端口空 → 启动认证报 bad port」这个因果链是错的：
空端口只会 `ECONNREFUSED`。

## 修复：把 host 端口钉死

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，末尾追加：

```yaml
# 固定 Host 监听端口，避免 listen(0) 随机到 undici 的禁止端口（5060/5061 等）。
# patch 是整块替换 config，所以 webserver 的每个键都要写全。
- id: webserver
  name: "@deepseek-ai/dsh-host-webserver"
  inject: [webStartup]
  config:
    host: 127.0.0.1
    port: 47811
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
```

端口选择原则：落在 **15001–49151**（注册端口段），既不在 Windows 的
1024–15000 动态分配区间，也不在禁止端口表里。

Host 上报的是 `listen` 之后的**实际端口**，所以钉死之后壳照样能完成握手。

## 为什么会"偶尔"崩

不是偶发兼容性问题，是**概率性定时炸弹**：动态端口分配器递增，游标经过
禁止端口那段窗口时启动就会中。运行时间越长、启动次数越多，越容易碰到。

## 验证

不用启动 GUI，直接跑 Host：

```bash
# 找到运行时（版本号按本机调整）
cd ~/AppData/Local/cn.shandianshuo.desktop/dsh-runtimes/*/releases/windows-x64

./node.exe ./dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --port 0 --no-open --skip-auth
```

它会打印 `dsh web: http://127.0.0.1:<端口>/?token=…`。
传 `--port 0` 却打印出具体端口，说明上报的是实际监听端口——
这就是「钉死端口不会破坏握手」的证据。

改完 patch 后正常启动，面板端口应稳定为 `47811`。

## 注意

- **同一时间只能跑一个 DSH 实例**（端口被固定）。需要多实例就换成
  「从一组安全端口里挑一个空闲的」的写法。
- 账号池自己也固定了端口（`lib/pool.js` 里的 `47812`）。原因是 provider 的
  `baseURL` 在 patch 里写的是具体端口，池子若每次随机，重启后 provider 就会
  指向一个已关闭的端口——表现为「模型选择器里有模型，但每个请求都失败」。
  被占用时池子会回退系统分配，不影响可用性。
