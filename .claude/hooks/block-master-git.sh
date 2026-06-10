#!/usr/bin/env bash
# PreToolUse(Bash) guard for Claude Code tool calls (NOT your manual terminal git).
# Block: any `git push`, and `git commit` while HEAD is master. Feature-branch commits pass.
#
# FAIL CLOSED on anything we can't read as a well-formed command:
#   - unparseable JSON / missing python3      -> python exits non-zero
#   - schema drift: tool_input or command key ABSENT, or command not a string -> exit 3
# Only an EXPLICITLY PRESENT command (even an empty string) is allowed through. Keying on
# key PRESENCE (not the .get default) is what closes the renamed-schema silent fail-open.
input="$(cat)"
cmd="$(printf '%s' "$input" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)                      # unparseable JSON
ti = d.get("tool_input")
if not isinstance(ti, dict) or "command" not in ti:
    sys.exit(3)                      # schema drift: tool_input / command absent
c = ti["command"]
if not isinstance(c, str):
    sys.exit(3)                      # command present but not a string
print(c)                             # exit 0; c may be a legitimately-empty string
' 2>/dev/null)"
rc=$?
if [ "$rc" -ne 0 ]; then
  if [ -n "$input" ]; then
    echo "BLOCKED: git guard could not read a well-formed command from tool input (rc=$rc) — failing closed; fix .claude/hooks/block-master-git.sh." >&2
    exit 2
  fi
  exit 0   # no input at all -> nothing to guard
fi
if printf '%s' "$cmd" | grep -Eq '\bgit[[:space:]]+push\b'; then
  echo "BLOCKED: Claude Code must not 'git push' — pushes/merges are your action (no push until frames)." >&2
  exit 2
fi
if printf '%s' "$cmd" | grep -Eq '\bgit[[:space:]]+commit\b'; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ "$branch" = "master" ]; then
    echo "BLOCKED: direct commit to master — use a feature branch (develop-on-branch rule)." >&2
    exit 2
  fi
fi
exit 0
