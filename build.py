#!/usr/bin/env python3
import os
import subprocess
import sys

version = open("VERSION").read().strip()
targets = [
    ("linux", "amd64", ""),
    ("linux", "arm64", ""),
    ("linux", "386", ""),
    ("darwin", "amd64", ""),
    ("darwin", "arm64", ""),
    ("windows", "amd64", ".exe"),
    ("windows", "386", ".exe"),
]

outdir = "dist"
os.makedirs(outdir, exist_ok=True)

for os_name, arch, ext in targets:
    name = f"mdnotes_{os_name}_{arch}_{version}{ext}"
    path = os.path.join(outdir, name)
    env = os.environ.copy()
    env["GOOS"] = os_name
    env["GOARCH"] = arch
    env["CGO_ENABLED"] = "0"
    cmd = ["go", "build", "-ldflags", f"-X main.version={version}", "-o", path, "."]
    print(f"building {name}...", end=" ", flush=True)
    r = subprocess.run(cmd, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        print("FAILED")
        print(r.stderr)
        sys.exit(1)
    print("ok")
