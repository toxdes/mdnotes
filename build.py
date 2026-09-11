#!/usr/bin/env python3
import os
import shutil
import subprocess
import sys

version = open("VERSION").read().strip()
targets = [
    ("linux", "amd64", ""),
    ("linux", "arm64", ""),
    ("darwin", "amd64", ""),
    ("darwin", "arm64", ""),
    ("windows", "amd64", ".exe"),
]

outdir = "dist"
os.makedirs(outdir, exist_ok=True)

upx = shutil.which("upx")

for os_name, arch, ext in targets:
    name = f"vylk_{os_name}_{arch}_{version}{ext}"
    path = os.path.join(outdir, name)
    env = os.environ.copy()
    env["GOOS"] = os_name
    env["GOARCH"] = arch
    env["CGO_ENABLED"] = "0"
    ldflags = f"-s -w -X main.version={version}"
    cmd = ["go", "build", "-trimpath", "-ldflags", ldflags, "-o", path, "."]
    print(f"building {name}...", end=" ", flush=True)
    r = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        print("FAILED")
        print(r.stderr)
        sys.exit(1)
    print("ok")
    if upx and os_name == "linux":
        print(f"  compressing...", end=" ", flush=True)
        subprocess.run([upx, "-q", "-o", path + ".tmp", path], check=True)
        os.replace(path + ".tmp", path)
        size = os.path.getsize(path)
        print(f"{size // 1024}K")
