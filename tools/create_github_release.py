"""Create GitHub Release v1.1.1 and upload the signed RPK asset."""
import json
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

REPO = "Alittlejelly/NexioSchedule-for-MiBand"
TAG = "v1.1.1"
NAME = "NexioSchedule MiBand v1.1.1"
BODY = (
    "更新日志：\n"
    "1. 优化全局配色\n"
    "2. 新增正在上课卡片\n"
    "3. 从 1.1.1 版本开始可与正式版 Nexio 课程表通讯\n\n"
    "- 版本：1.1.1（versionCode 20）\n"
    "- 文件：`com.haooz.chedule.release.1.1.1.rpk`\n"
    "- 包名：`com.haooz.chedule`\n"
)
RPK = Path(r"D:\mimoProject\release\com.haooz.chedule.release.1.1.1.rpk")


def github_password() -> str:
    proc = subprocess.run(
        ["git", "credential", "fill"],
        input=b"protocol=https\nhost=github.com\n\n",
        capture_output=True,
        check=True,
    )
    for line in proc.stdout.decode().splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1]
    raise SystemExit("no github password in credential helper")


def request(method: str, url: str, token: str, data=None, content_type=None):
    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "mimo-desktop",
        "Accept": "application/vnd.github+json",
    }
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        err = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code} {method} {url}: {err}") from e


def api(method: str, path: str, token: str, payload=None):
    url = f"https://api.github.com{path}"
    data = None
    ctype = None
    if payload is not None:
        data = json.dumps(payload).encode()
        ctype = "application/json"
    return request(method, url, token, data=data, content_type=ctype)


def main() -> None:
    if not RPK.is_file():
        raise SystemExit(f"missing rpk: {RPK}")
    token = github_password()
    name = RPK.name

    try:
        rel = api("GET", f"/repos/{REPO}/releases/tags/{TAG}", token)
        print(f"existing release id={rel['id']} {rel['html_url']}")
    except RuntimeError as e:
        if "404" not in str(e):
            raise
        rel = api(
            "POST",
            f"/repos/{REPO}/releases",
            token,
            payload={
                "tag_name": TAG,
                "name": NAME,
                "body": BODY,
                "draft": False,
                "prerelease": False,
            },
        )
        print(f"created release id={rel['id']} {rel['html_url']}")

    upload_url = rel["upload_url"].split("{", 1)[0]
    url = f"{upload_url}?name={name}"
    data = RPK.read_bytes()
    asset = request(
        "POST",
        url,
        token,
        data=data,
        content_type="application/octet-stream",
    )
    print(f"uploaded asset id={asset.get('id')} {asset.get('browser_download_url')}")


if __name__ == "__main__":
    main()
