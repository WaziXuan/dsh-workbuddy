#!/usr/bin/env python3
"""从本机 WorkBuddy 登录态一键导入 DSH 账号池。

流程：
  1. 复用 D:\\Sandbox\\workbuddy-auto-signin 的 signin.py 读取并解密登录态
     （$wbEncrypted 由 WorkBuddy 自带运行时在子进程里解，密钥不出该进程）；
  2. 找到本地 DSH 的 dsh-workbuddy 面板端口，用 ~/.dsh/workbuddy/http-token 鉴权；
  3. 把会话 JSON POST 给 /workbuddy/import，由插件完成凭据写入、池启动与 provider 注册。

用法：
  python import_from_desktop.py              # 导入并应用
  python import_from_desktop.py --test       # 导入后顺带测一次模型连通性
  python import_from_desktop.py --port 2747  # 指定端口（默认自动探测）
  python import_from_desktop.py --probe      # 只定位面板端口（不读 token、不导入）
  python import_from_desktop.py --dry-run    # 只解密并打印账号信息，不导入
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

DEFAULT_SIGNIN_DIR = r"D:\Sandbox\workbuddy-auto-signin"
DSH_WORKBUDDY_DIR = os.path.join(os.path.expanduser("~"), ".dsh", "workbuddy")
DEFAULT_TOKEN_FILE = os.path.join(DSH_WORKBUDDY_DIR, "http-token")
ENDPOINT_FILE = os.path.join(DSH_WORKBUDDY_DIR, "endpoint.json")
PANEL_PATH = "/workbuddy/state"
PANEL_UNAUTHORIZED = "本地面板鉴权失败"
# DSH 的 webServer 端口是动态分配的（实测见过 2747），只探"在响的"端口才靠谱。
PREFERRED_PORTS = [3822, 2747, 3080, 8080, 8081, 3000, 5000]
DSH_PROCESS = re.compile(r"harness|dsh|deepseek|electron", re.I)


def say(message=""):
    """统一走一条输出，避免 Windows 控制台缓冲让人误以为卡死。"""
    print(message, flush=True)


def die(message, code=1):
    say("✗ " + message)
    sys.exit(code)


def load_signer(signin_dir):
    if not os.path.isdir(signin_dir):
        die("找不到自动签到仓库：%s（用 WORKBUDDY_SIGNIN_DIR 指定）" % signin_dir)
    sys.path.insert(0, signin_dir)
    try:
        import signin  # noqa: WPS433 —— 运行时才加载，路径由参数决定
    except Exception as error:
        die("加载 signin.py 失败：%s" % error)
    return signin


def resolve_session(signin):
    """读取本机登录态；加密字段交给 WorkBuddy 运行时解。"""
    auth_file, looked = signin.find_auth_file()
    if not auth_file:
        die("没有找到 WorkBuddy 登录文件，检查过：\n  " + "\n  ".join(looked))
    raw = signin.load_session(auth_file)
    encrypted = isinstance(raw.get("auth", {}).get("accessToken"), dict)
    try:
        session = signin.resolve_session(raw)
    except Exception as error:
        reason = getattr(error, "reason", None) or str(error)
        die("解析登录态失败：%s" % reason)
    return session, auth_file, encrypted


def read_panel_token(token_file):
    if not os.path.isfile(token_file):
        die("找不到面板 token：%s\n  先启动一次 DSH，插件会生成这个文件。" % token_file)
    with open(token_file, "r", encoding="utf-8") as handle:
        token = handle.read().strip()
    if not token:
        die("面板 token 文件是空的：%s" % token_file)
    return token


def probe_panel(port, timeout=1.5):
    """无鉴权探测：面板对未授权请求固定返回 401 + 「本地面板鉴权失败」。

    先确认端口是面板，之后才把 token 发过去 —— 绝不能把面板 key
    撒给本机所有监听端口。
    """
    url = "http://127.0.0.1:%d%s" % (port, PANEL_PATH)
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status, body = response.status, response.read(4096)
    except urllib.error.HTTPError as error:
        status, body = error.code, error.read(4096)
    except Exception:
        return False
    if status != 401:
        return False
    return PANEL_UNAUTHORIZED in body.decode("utf-8", "replace")


def listening_ports():
    """本机正在监听的端口 -> 进程名。找端口只能从这上面找，盲扫端口段纯浪费时间。"""
    found = {}
    try:
        if os.name == "nt":
            listing = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True, text=True, timeout=25, errors="replace",
            ).stdout
            names = {}
            try:
                tasks = subprocess.run(
                    ["tasklist", "/fo", "csv", "/nh"],
                    capture_output=True, text=True, timeout=25, errors="replace",
                ).stdout
                for line in tasks.splitlines():
                    cells = [cell.strip().strip('"') for cell in line.split('","')]
                    if len(cells) >= 2 and cells[1].isdigit():
                        names[cells[1]] = cells[0].strip('"')
            except Exception:
                pass
            for line in listing.splitlines():
                fields = line.split()
                if len(fields) < 5:
                    continue
                if fields[0].upper() != "TCP" or fields[3].upper() != "LISTENING":
                    continue
                port_text = fields[1].rsplit(":", 1)[-1]
                if port_text.isdigit():
                    found[int(port_text)] = names.get(fields[4], "")
        else:
            listing = subprocess.run(
                ["sh", "-c", "ss -ltnp 2>/dev/null || netstat -ltn 2>/dev/null"],
                capture_output=True, text=True, timeout=25, errors="replace",
            ).stdout
            for line in listing.splitlines():
                fields = line.split()
                if len(fields) < 4:
                    continue
                port_text = fields[3].rsplit(":", 1)[-1]
                if not port_text.isdigit():
                    continue
                name = ""
                match = re.search(r'users:\(\("([^"]+)"', " ".join(fields[5:]))
                if match:
                    name = match.group(1)
                found[int(port_text)] = name
    except Exception:
        return found
    return found


def recorded_port():
    """插件会把实际端口写进 endpoint.json；有就先信它（可能已过期，后面还会探一次）。"""
    try:
        with open(ENDPOINT_FILE, "r", encoding="utf-8") as handle:
            port = json.load(handle).get("port")
        return port if isinstance(port, int) and 0 < port < 65536 else None
    except Exception:
        return None


def candidate_ports():
    """按"最可能是面板"的顺序排候选端口，并带上来源说明。"""
    live = listening_ports()
    ordered, seen = [], set()

    def add(port, source):
        if isinstance(port, int) and 0 < port < 65536 and port not in seen:
            seen.add(port)
            ordered.append((port, source))

    add(recorded_port(), "插件记录的端口")
    for port in PREFERRED_PORTS:
        add(port, "常见端口")
    for port, name in sorted(live.items()):
        if DSH_PROCESS.search(name or ""):
            add(port, "DSH 进程 %s" % (name or "?"))
    for port, name in sorted(live.items()):
        add(port, "本机监听 %s" % (name or "?"))
    return ordered


def discover_port(preferred):
    if preferred:
        if probe_panel(preferred, timeout=3):
            return preferred
        die("端口 %d 上没有响应 dsh-workbuddy 面板（DSH 没启动？或端口变了）" % preferred)

    candidates = candidate_ports()
    say("正在探测本地面板端口（%d 个候选，只探真正在监听的）…" % len(candidates))
    for port, source in candidates:
        if probe_panel(port):
            return port
    die("没有找到 dsh-workbuddy 面板。确认 DSH 正在运行且插件已加载；或用 --port 指定端口。")


def request(port, path, token, payload=None, timeout=30):
    url = "http://127.0.0.1:%d%s" % (port, path)
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST" if body else "GET")
    req.add_header("Authorization", "Bearer %s" % token)
    if body:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def build_account_payload(session):
    """只挑插件需要的字段。

    不能整个 session 直接丢给插件：客户端会话里还有一个 `models` 字段，
    插件会把它当成"只导入这些模型"的过滤器，而它的 id 和本机产品目录对不上，
    结果就是 0 个模型。这里显式只带 accessToken / uid / 名称。
    """
    auth = session.get("auth") or {}
    account = session.get("account") or {}
    payload = {"accessToken": auth.get("accessToken"), "uid": account.get("uid")}
    for key in ("nickname", "displayName", "email"):
        value = account.get(key)
        if isinstance(value, str) and value.strip():
            payload["name"] = value.strip()
            break
    for key in ("enterpriseId", "tenantId"):
        value = account.get(key)
        if isinstance(value, str) and value.strip():
            payload["enterpriseId"] = value.strip()
            break
    declared = account.get("type") or account.get("accountType")
    if isinstance(declared, str) and declared.strip():
        payload["product"] = declared.strip()
    return payload


def main():
    parser = argparse.ArgumentParser(description="从本机 WorkBuddy 登录态导入 DSH 账号池")
    parser.add_argument("--port", type=int, default=0, help="DSH 面板端口（默认自动探测）")
    parser.add_argument("--test", action="store_true", help="导入后跑一次模型连通性测试")
    parser.add_argument("--replace", action="store_true", help="用本机账号替换现有账号池")
    parser.add_argument("--probe", action="store_true", help="只定位面板端口，不读 token、不导入")
    parser.add_argument("--dry-run", action="store_true", help="只解密并打印，不写入 DSH")
    parser.add_argument("--signin-dir", default=os.environ.get("WORKBUDDY_SIGNIN_DIR", DEFAULT_SIGNIN_DIR))
    parser.add_argument("--token-file", default=DEFAULT_TOKEN_FILE)
    args = parser.parse_args()

    if args.probe:
        port = discover_port(args.port)
        say("✓ 面板端口：%d" % port)
        return

    session, auth_file, encrypted = resolve_session(load_signer(args.signin_dir))
    auth = session.get("auth", {})
    account = session.get("account", {})
    token = auth.get("accessToken", "")
    uid = account.get("uid", "")

    say("登录文件 : %s" % auth_file)
    say("凭据格式 : %s" % ("$wbEncrypted（已由 WorkBuddy 运行时解密）" if encrypted else "明文"))
    say("uid      : %s" % (uid or "(缺失)"))
    say("token    : len=%d head=%s…" % (len(token), token[:8]))
    if not token or not uid:
        die("登录态缺少 accessToken 或 uid，先在客户端里重新登录一次")

    if args.dry_run:
        say("（--dry-run，不写入 DSH）")
        return

    port = discover_port(args.port)
    say("DSH 端口 : %d" % port)
    panel_token = read_panel_token(args.token_file)

    account_payload = build_account_payload(session)
    payload = {"text": json.dumps(account_payload, ensure_ascii=False)}
    if args.test:
        payload["test"] = True
    if args.replace:
        payload["replace"] = True

    say("正在导入（插件要写凭据、起池、注册 provider，稍等）…")
    try:
        status, result = request(port, "/workbuddy/import", panel_token, payload, timeout=180)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        die("导入失败 HTTP %s：%s" % (error.code, body[:500]))
    except Exception as error:
        die("导入失败：%s" % error)

    if not result.get("ok"):
        # 失败时顺带把插件读到的模型目录打出来，省得来回试
        try:
            _, catalog = request(port, "/workbuddy/catalog", panel_token, timeout=8)
            say("目录诊断：source=%s count=%s" % (catalog.get("source"), catalog.get("count")))
            ids = [m.get("id") for m in (catalog.get("models") or [])][:8]
            if ids:
                say("  示例模型：%s" % ", ".join(str(i) for i in ids))
        except Exception:
            pass
        die("导入失败：%s" % json.dumps(result, ensure_ascii=False)[:500])

    added = result.get("results", [])
    say("")
    say("✓ 导入完成（HTTP %s）" % status)
    for item in added:
        mark = "✓" if item.get("ok") else "✗"
        label = item.get("name") or item.get("route") or "?"
        extra = "" if item.get("ok") else "  %s" % item.get("error", "")
        say("  %s %s%s" % (mark, label, extra))

    state = result.get("state", {})
    accounts = state.get("accounts", [])
    pool = state.get("pool") or {}
    say("")
    say("账号池：%d 个账号" % len(accounts))
    if pool.get("url"):
        say("池地址：%s" % pool["url"])
    for item in accounts:
        say("  - %s  route=%s  models=%s  credential=%s" % (
            item.get("name", "?"),
            item.get("route", "?"),
            item.get("modelCount", "?"),
            "缺失" if item.get("credentialMissing") else "就绪",
        ))
        base = item.get("baseURL") or "(默认)"
        allow = "放行" if item.get("baseURLAllowed") else "被拒"
        say("    baseURL=%s（%s）" % (base, allow))
        balance = item.get("balance") or {}
        if balance.get("message"):
            say("    余额：%s" % balance["message"])
    say("")
    say("回 DSH 模型选择器选 WorkBuddy 即可。")


if __name__ == "__main__":
    main()
