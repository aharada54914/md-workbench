#!/usr/bin/env python3
"""Run unchanged upstream checks; persist failures as well as passes (stdlib only)."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import time

UPSTREAM = "c5aecc311f5295e872002309dcf72cfd96a8ad84"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    source, out = args.source.resolve(), args.out.resolve()
    if source == out or source in out.parents:
        parser.error("--out must be outside --source")
    out.mkdir(parents=True, exist_ok=True)
    records = []
    report = {"schema": 1, "expected_sha": UPSTREAM,
              "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "os": platform.platform(), "python": sys.version,
              "architecture": platform.machine(),
              "runner_image": {k: os.environ.get(k) for k in ("ImageOS", "ImageVersion", "RUNNER_OS")},
              "steps": records}
    env = dict(os.environ, CI="true", NO_COLOR="1", CARGO_TERM_COLOR="never")
    env["PLAYWRIGHT_JSON_OUTPUT_FILE"] = str(out / "playwright.json")

    def persist():
        (out / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def run(name, argv, timeout=600, blocked_by=None):
        item = {"id": name, "argv": argv, "cwd": str(source)}
        records.append(item)
        if blocked_by:
            item.update(status="blocked", reason=blocked_by, exit_code=None)
            persist()
            return False
        executable = shutil.which(argv[0])
        if not executable:
            item.update(status="blocked", reason=f"Executable not found: {argv[0]}", exit_code=None)
            persist()
            return False
        command = [executable, *argv[1:]]
        if os.name == "nt" and executable.lower().endswith((".cmd", ".bat")):
            command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/s", "/c", subprocess.list2cmdline(command)]
        print(f"\n=== {name}: {argv} ===", flush=True)
        start = time.monotonic()
        item["log"] = name + ".log"
        try:
            with (out / item["log"]).open("wb") as log:
                proc = subprocess.Popen(command, cwd=source, env=env, stdout=log,
                                        stderr=subprocess.STDOUT, start_new_session=(os.name != "nt"))
                try:
                    code = proc.wait(timeout=timeout)
                    item.update(exit_code=code, status="passed" if code == 0 else "failed")
                except subprocess.TimeoutExpired:
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], stdout=log, stderr=subprocess.STDOUT)
                    else:
                        os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                    item.update(exit_code=None, status="timed_out", timeout_seconds=timeout)
        except OSError as exc:
            item.update(exit_code=None, status="blocked", reason=str(exc))
        item["seconds"] = round(time.monotonic() - start, 3)
        persist()
        if (out / item["log"]).exists():
            text = (out / item["log"]).read_text(encoding="utf-8", errors="replace")
            print(text[-12000:], flush=True)
        print(f"=== {name}: {item['status']} ===", flush=True)
        return item["status"] == "passed"

    persist()
    if not run("source-sha", ["git", "rev-parse", "HEAD"]):
        return 1
    actual = (out / "source-sha.log").read_text().strip()
    report["actual_sha"] = actual
    if actual != UPSTREAM:
        report["fatal"] = "Refusing to call a different commit the upstream baseline"
        persist()
        return 1
    protected = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"]
    report["input_sha256"] = {p: hashlib.sha256((source / p).read_bytes()).hexdigest() for p in protected}
    report["upstream_cargo_lock_present"] = (source / "src-tauri/Cargo.lock").is_file()
    for name, argv in [("node-version", ["node", "--version"]), ("pnpm-version", ["pnpm", "--version"]),
                       ("rustc-version", ["rustc", "-Vv"]), ("cargo-version", ["cargo", "-V"]),
                       ("git-version", ["git", "--version"])]:
        run(name, argv)
    installed = run("install", ["pnpm", "install", "--frozen-lockfile"], timeout=900)
    blocked = None if installed else "Dependency install did not pass"
    run("unit", ["pnpm", "test:run"], timeout=900, blocked_by=blocked)
    run("frontend-build", ["pnpm", "build"], timeout=900, blocked_by=blocked)
    browser_cmd = ["pnpm", "exec", "playwright", "install"]
    if platform.system() == "Linux":
        browser_cmd.append("--with-deps")
    browser_ok = run("browser-install", browser_cmd + ["chromium"], timeout=900, blocked_by=blocked)
    run("e2e", ["pnpm", "test:e2e", "--reporter=list,json"], timeout=900,
        blocked_by=None if installed and browser_ok else "Dependencies/browser not available")
    # Upstream does not ship Cargo.lock. Record this explicit resolution, never silently freeze it.
    locked = run("cargo-lock", ["cargo", "generate-lockfile", "--manifest-path", "src-tauri/Cargo.toml"], timeout=900)
    lock = source / "src-tauri/Cargo.lock"
    if lock.exists():
        shutil.copy2(lock, out / "Cargo.lock")
        report["generated_cargo_lock_sha256"] = hashlib.sha256(lock.read_bytes()).hexdigest()
    run("rust-tests", ["cargo", "test", "--locked", "--manifest-path", "src-tauri/Cargo.toml"], timeout=1500,
        blocked_by=None if locked else "Cargo dependency resolution failed")
    run("native-build", ["cargo", "build", "--locked", "--manifest-path", "src-tauri/Cargo.toml"], timeout=1500,
        blocked_by=None if locked else "Cargo dependency resolution failed")
    run("source-unchanged", ["git", "diff", "--exit-code", "--", "src", "src-tauri/src", *protected])
    report["finished_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    report["passed"] = all(s["status"] == "passed" for s in records)
    persist()
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as summary:
            summary.write(f"## T01 upstream baseline — {report['os']}\n\nCommit: `{actual}`\n\n")
            summary.write("| Step | Result | Exit | Seconds |\n|---|---|---:|---:|\n")
            for s in records:
                summary.write(f"| {s['id']} | {s['status']} | {s.get('exit_code')} | {s.get('seconds', '—')} |\n")
            summary.write("\nBrowser E2E uses upstream Tauri mocks; this is not OS association, IME, sandbox, or performance acceptance. No native app or AI CLI is launched.\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
