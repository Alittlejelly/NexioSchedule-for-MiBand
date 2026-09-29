from pathlib import Path

js = Path(r"D:\mimoProject\build\pages\index\index.js").read_text(encoding="utf-8")

# Find template root structure
idx = js.find('"type": "div"')
print("first type div at", idx)
print(js[idx:idx+2500])

print("\n\n==== END OF FILE TAIL ====")
print(js[-2000:])
