#!/usr/bin/env python3
"""ci-redact.py — mask secrets in text read on stdin before it leaves the runner.

The CI failure reporter posts test output (failing names, assertion diffs) in a
public PR comment. A test that prints a header or an env value would publish a
token there. This masks the values of the given environment variables and
anything shaped like a well-known token, and writes the result to stdout.

Usage: ci-redact.py [ENV_NAME ...] < text
"""
import os
import re
import sys

PATTERNS = [
    r"gh[pousr]_[A-Za-z0-9]{20,}",          # GitHub tokens
    r"github_pat_[A-Za-z0-9_]{20,}",
    r"sk-[A-Za-z0-9_-]{16,}",               # OpenAI / Anthropic style keys
    r"aoc_[A-Za-z0-9_-]{8,}",               # OneCLI agent tokens
    r"(?i)(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{12,}",
    r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}",  # JWTs
]


def redact(text: str, secrets: list[str]) -> str:
    for value in sorted({s for s in secrets if len(s) >= 6}, key=len, reverse=True):
        text = text.replace(value, "[redacted]")
    for p in PATTERNS:
        text = re.sub(p, "[redacted]", text)
    return text


if __name__ == "__main__":
    values = [os.environ.get(name, "") for name in sys.argv[1:]]
    sys.stdout.write(redact(sys.stdin.read(), values))
