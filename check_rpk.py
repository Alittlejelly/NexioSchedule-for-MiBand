from pathlib import Path
import re
import zipfile

js = Path(r"D:\mimoProject\build\pages\index\index.js").read_text(encoding="utf-8")
print("=== style keys ===")
for m in re.finditer(r'"(\.[a-zA-Z0-9_-]+|text|div|span)":\s*\{', js):
    start = m.start()
    snippet = js[start : start + 220].replace("\n", " ")
    print(snippet)
    print("---")

print("\n=== script module ===")
i = js.find("__scriptModule__")
print(js[i : i + 800] if i >= 0 else "missing")

print("\n=== template first 400 of type div ===")
j = js.find('"type": "div"')
print(js[j - 50 : j + 500] if j >= 0 else "missing")

print("\n=== rpk zip ===")
p = Path(r"D:\mimoProject\dist\com.example.bandschedule.debug.0.1.4.rpk")
if p.exists():
    with zipfile.ZipFile(p) as z:
        for n in z.namelist():
            print(n, z.getinfo(n).file_size)
