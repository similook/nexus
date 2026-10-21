"""Print the useful part of an Apple crash report (.ips): exception, termination reason and the
crashed thread's top frames. For CI annotations (ios-phase1.yml); the report itself stays an
artifact. A .ips file is one JSON header line followed by the JSON report."""

import json
import sys


def main(path: str) -> None:
    with open(path, encoding="utf-8", errors="replace") as handle:
        handle.readline()  # header
        report = json.loads(handle.read())
    exception = report.get("exception", {})
    print("exception:", exception.get("type"), exception.get("signal"), exception.get("subtype", ""))
    termination = report.get("termination", {})
    if termination:
        print("termination:", termination.get("namespace"), termination.get("indicator", ""), termination.get("reasons", ""))
    for key in ("asi", "lastExceptionBacktrace"):
        if key in report:
            print(key + ":", json.dumps(report[key])[:400])
    images = report.get("usedImages", [])
    threads = report.get("threads", [])
    crashed = next((t for t in threads if t.get("triggered")), threads[0] if threads else {})
    for frame in crashed.get("frames", [])[:14]:
        index = frame.get("imageIndex", -1)
        image = images[index].get("name", "?") if 0 <= index < len(images) else "?"
        print(f"  {image}  {frame.get('symbol', hex(frame.get('imageOffset', 0)))}")


if __name__ == "__main__":
    main(sys.argv[1])
