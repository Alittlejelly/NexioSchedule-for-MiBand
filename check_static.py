from pathlib import Path

js = Path(r"D:\mimoProject\build\pages\index\index.js").read_text(encoding="utf-8")
keys = [
    "probe",
    "ff3b30",
    "周日",
    "2026年9月27日",
    "下节课",
    "大学英语",
    "4小时25分钟后",
    "下午课程",
    "未开始",
    "ffffff",
    "100%",
]
for k in keys:
    print(k, "=>", k in js)
