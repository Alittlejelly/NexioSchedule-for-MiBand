from pathlib import Path
import zipfile

p = Path(r"D:\mimoProject\dist\com.example.bandschedule.debug.0.1.4.rpk")
print("exists", p.exists(), "size", p.stat().st_size if p.exists() else 0)
print("mtime", p.stat().st_mtime if p.exists() else 0)
with zipfile.ZipFile(p) as z:
    for n in z.namelist():
        print(n, z.getinfo(n).file_size)

print("\n=== search alignSelf / rpk_info in all files ===")
with zipfile.ZipFile(p) as z:
    for n in z.namelist():
        if n.endswith("/"):
            continue
        data = z.read(n)
        try:
            text = data.decode("utf-8")
        except Exception:
            continue
        if "alignSelf" in text or "align-self" in text:
            print("ALIGN HIT", n)
        if "rpk_info" in text:
            print("RPK_INFO mention", n)
    names = z.namelist()
    print("has rpk_info.json", any("rpk_info" in n for n in names))
