"""把 page_tool.py 里 shared-core 一段原样抄进 audit_scan.py（两个脚本要各自独立可运行）。

    python -X utf8 tests/sync_shared_core.py          # 同步
    python -X utf8 tests/sync_shared_core.py --check  # 只检查，不一致退出码 1
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "skills" / "book2md1012" / "scripts" / "page_tool.py"
DST = ROOT / "skills" / "book2md1012" / "scripts" / "audit_scan.py"
BLOCK = re.compile(r"# >>> shared-core.*?# <<< shared-core\n", re.S)


def block(text: str) -> str:
    m = BLOCK.search(text)
    if not m:
        raise SystemExit("找不到 shared-core 标记")
    return m.group(0)


def main() -> int:
    src = SRC.read_text(encoding="utf-8")
    dst = DST.read_text(encoding="utf-8")
    want = block(src).replace("与 scripts/audit_scan.py", "与 scripts/page_tool.py")
    if "--check" in sys.argv:
        return 0 if block(dst) == want else 1
    DST.write_text(BLOCK.sub(lambda _: want, dst, count=1), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
