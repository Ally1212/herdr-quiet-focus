import json
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

TOOL_CALLS = {"function_call", "custom_tool_call", "web_search_call", "image_generation_call", "local_shell_call", "tool_search_call"}
MAX_READ_BYTES = 2 * 1024 * 1024


def active_rollout(pid):
    lsof = shutil.which("lsof")
    if not lsof:
        return None
    result = subprocess.run(
        [lsof, "-a", "-p", str(pid), "-Ffan"],
        capture_output=True, text=True, timeout=1,
    )
    paths = set()
    writable = False
    for field in result.stdout.splitlines():
        if field.startswith("f"):
            writable = False
        elif field.startswith("a"):
            writable = field[1:] in {"w", "u"}
        elif field.startswith("n") and writable:
            path = Path(field[1:])
            if path.is_absolute() and "sessions" in path.parts and path.match("rollout-*.jsonl"):
                paths.add(path)
    if len(paths) == 1:
        return paths.pop()
    return None


def recent_tool_calls(path, now):
    cutoff = now - timedelta(seconds=15)
    with path.open("rb") as rollout:
        offset = max(0, rollout.seek(0, 2) - MAX_READ_BYTES)
        rollout.seek(offset)
        if offset:
            rollout.readline(MAX_READ_BYTES)
        lines = rollout.read(MAX_READ_BYTES).splitlines()

    calls = []
    seen = set()
    for line in reversed(lines):
        try:
            record = json.loads(line)
            if record["type"] != "response_item" or record["payload"]["type"] not in TOOL_CALLS:
                continue
            at = datetime.fromisoformat(record["timestamp"].replace("Z", "+00:00"))
            if not cutoff <= at <= now:
                continue
            payload = record["payload"]
            call_id = payload.get("call_id") or payload.get("id")
            if call_id:
                if call_id in seen:
                    continue
                seen.add(call_id)
            calls.append(int(at.timestamp() * 1000))
            if len(calls) == 6:
                break
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
    return calls


if __name__ == "__main__":
    command, value = sys.argv[1:]
    if command == "locate":
        path = active_rollout(int(value))
        print(json.dumps(str(path) if path else None))
    elif command == "recent":
        print(json.dumps(recent_tool_calls(Path(value), datetime.now(timezone.utc))))
