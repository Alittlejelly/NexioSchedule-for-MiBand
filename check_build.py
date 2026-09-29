import re
from pathlib import Path

js = Path(r"D:\mimoProject\build\pages\index\index.js").read_text(encoding="utf-8")
print("len", len(js))
print("header-block", "header-block" in js)
print("morningCourses", "morningCourses" in js)
print("shown", "shown" in js)
print("next-card", "next-card" in js)

# extract interesting snippets
keys = ["header-block", "next-card", "section-label", "course-card", "morningCourses", "shown", "for"]
for k in keys:
    idx = js.find(k)
    if idx >= 0:
        print("\n===", k, "===")
        print(js[max(0, idx - 80): idx + 120].replace("\n", " "))

# count uxp elements
print("\nux-type count", js.count("ux-type"))
print("div count markers", js.count('"div"'), js.count("'div'"))
