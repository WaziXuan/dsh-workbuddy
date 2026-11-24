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
  python import_from_desktop.py --port 3822  # 指定端口（默认自动探测）
  python import_from_desktop.py --dry-run    # 只解密并打印账号信息，不导入
"""
import argparse
import json
import os
import socket
import sys
import urllib.error
import urllib.request

DEFAULT_SIGNIN_DIR = r"D:\Sandbox\workbuddy-auto-signin"
DEFAULT_TOKEN_FILE = os.path.join(os.path.expanduser("~"), ".dsh", "workbuddy", "http-token")
PROBE_PORTS = [3822, 3080, 8080, 8081, 5000, 3000]
SCAN_RANGE = range(3000, 4001)


def die(message, code=1):
    print("✗ " + message)
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


def request(port, path, token, payload=None, timeout=30):
    url = "http://127.0.0.1:%d%s" % (port, path)
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST" if body else "GET")
    req.add_header("Authorization", "Bearer %s" % token)
    if body:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


def is_panel(port, token):
    try:
        status, _ = request(port, "/workbuddy/state", token, timeout=2)
        return status == 200
    except Exception:
        return False


def discover_port(token, preferred):
    if preferred:
        if is_panel(preferred, token):
            return preferred
        die("端口 %d 上没有响应 dsh-workbuddy 面板（DSH 没启动？）" % preferred)
    for port in PROBE_PORTS:
        if is_panel(port, token):
            return port
    for port in SCAN_RANGE:
        if port in PROBE_PORTS:
            continue
        if is_panel(port, token):
            return port
    die("没有找到 dsh-workbuddy 面板端口。确认 DSH 正在运行，或用 --port 指定。")


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
    parser.add_argument("--dry-run", action="store_true", help="只解密并打印，不写入 DSH")
    parser.add_argument("--signin-dir", default=os.environ.get("WORKBUDDY_SIGNIN_DIR", DEFAULT_SIGNIN_DIR))
    parser.add_argument("--token-file", default=DEFAULT_TOKEN_FILE)
    args = parser.parse_args()

    session, auth_file, encrypted = resolve_session(load_signer(args.signin_dir))
    auth = session.get("auth", {})
    account = session.get("account", {})
    token = auth.get("accessToken", "")
    uid = account.get("uid", "")

    print("登录文件 : %s" % auth_file)
    print("凭据格式 : %s" % ("$wbEncrypted（已由 WorkBuddy 运行时解密）" if encrypted else "明文"))
    print("uid      : %s" % (uid or "(缺失)"))
    print("token    : len=%d head=%s…" % (len(token), token[:8]))
    if not token or not uid:
        die("登录态缺少 accessToken 或 uid，先在客户端里重新登录一次")

    if args.dry_run:
        print("（--dry-run，不写入 DSH）")
        return

    panel_token = read_panel_token(args.token_file)
    port = discover_port(panel_token, args.port)
    print("DSH 端口 : %d" % port)

    account_payload = build_account_payload(session)
    payload = {"text": json.dumps(account_payload, ensure_ascii=False)}
    if args.test:
        payload["test"] = True
    if args.replace:
        payload["replace"] = True

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
            _, catalog = request(port, "/workbuddy/catalog", panel_token, timeout=5)
            print("目录诊断：source=%s count=%s" % (catalog.get("source"), catalog.get("count")))
            ids = [m.get("id") for m in (catalog.get("models") or [])][:8]
            if ids:
                print("  示例模型：%s" % ", ".join(str(i) for i in ids))
        except Exception:
            pass
        die("导入失败：%s" % json.dumps(result, ensure_ascii=False)[:500])

    added = result.get("results", [])
    print("\n✓ 导入完成（HTTP %s）" % status)
    for item in added:
        mark = "✓" if item.get("ok") else "✗"
        label = item.get("name") or item.get("route") or "?"
        extra = "" if item.get("ok") else "  %s" % item.get("error", "")
        print("  %s %s%s" % (mark, label, extra))

    accounts = result.get("state", {}).get("accounts", [])
    pool = result.get("state", {}).get("pool") or {}
    print("\n账号池：%d 个账号" % len(accounts))
    if pool.get("url"):
        print("池地址：%s" % pool["url"])
    for item in accounts:
        print("  - %s  route=%s  models=%s  credential=%s" % (
            item.get("name", "?"),
            item.get("route", "?"),
            item.get("modelCount", "?"),
            "缺失" if item.get("credentialMissing") else "就绪",
        ))
    print("\n回 DSH 模型选择器选 WorkBuddy 即可。")


if __name__ == "__main__":
    main()
