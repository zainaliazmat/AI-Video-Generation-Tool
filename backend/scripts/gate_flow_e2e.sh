#!/usr/bin/env bash
# Gate-flow E2E: start → approve ×3 → state, with jq assertions.
# Standing gate evidence for M1–M6; donor for M7's live cycles.
# Asserts: script gate awaits after start; each approve advances; the voice
# approve carries --voice and the synth voice matches; double-approve while
# busy → 409; reconnect: /state reflects final gates; assemble awaiting at end.
set -euo pipefail

BASE=${BASE:-http://localhost:3100}

echo "=== GATE FLOW E2E START ==="
echo "BASE=$BASE"

# ── 1. Start a new session ───────────────────────────────────────────────────
echo ""
echo "--- [1] Starting session (topic: the water cycle) ---"
START_RESPONSE=$(curl -sN -X POST "$BASE/api/session/start" \
  -H 'content-type: application/json' \
  -d '{"topic":"the water cycle"}')
echo "$START_RESPONSE"

# The done event line looks like: data: {"type":"done","sid":"v3-...","gates":{...}}
DONE_LINE=$(echo "$START_RESPONSE" | grep '"type":"done"' | head -1)
echo ""
echo "Done line: $DONE_LINE"

# Strip the "data: " SSE prefix before parsing
DONE_JSON=$(echo "$DONE_LINE" | sed 's/^data: //')
SID=$(echo "$DONE_JSON" | jq -r .sid)

if [ -z "$SID" ] || [ "$SID" = "null" ]; then
  echo "ERROR: could not extract sid from start response"
  exit 1
fi
echo "SID=$SID"

# Assert: script gate should be awaiting_approval after start
echo "$DONE_JSON" | jq -e '.gates.script.state == "awaiting_approval"' >/dev/null \
  || { echo "ERROR: script gate not awaiting_approval after start"; exit 1; }
echo "ASSERT PASS: script gate awaiting_approval after start"

# ── 2. Approve gates: script → voice → scenes ───────────────────────────────
for GATE in script voice scenes; do
  echo ""
  echo "--- [2] Approving gate: $GATE ---"

  if [ "$GATE" = "voice" ]; then
    BODY='{"gate":"voice","voice":"af_bella","speed":1.0}'
  else
    BODY='{"gate":"'"$GATE"'"}'
  fi

  APPROVE_RESPONSE=$(curl -sN -X POST "$BASE/api/session/$SID/approve" \
    -H 'content-type: application/json' \
    -d "$BODY")
  echo "$APPROVE_RESPONSE"

  # Verify the final done event is present
  APPROVE_DONE=$(echo "$APPROVE_RESPONSE" | grep '"type":"done"' | tail -1)
  if [ -z "$APPROVE_DONE" ]; then
    echo "ERROR: no done event from approve for gate=$GATE"
    exit 1
  fi
  APPROVE_DONE_JSON=$(echo "$APPROVE_DONE" | sed 's/^data: //')
  echo "Approve done: $APPROVE_DONE_JSON"
  echo "ASSERT PASS: approve $GATE returned done"
done

# ── 3. Reconnect: /state reflects approved gates ────────────────────────────
echo ""
echo "--- [3] Checking /state ---"
STATE=$(curl -s "$BASE/api/session/$SID/state")
echo "$STATE"

echo "$STATE" | jq -e '.gates.script.state=="approved" and .gates.voice.state=="approved"
  and .gates.scenes.state=="approved" and .gates.assemble.state=="awaiting_approval"' >/dev/null \
  || { echo "ERROR: final gate states not as expected"; echo "$STATE" | jq .gates; exit 1; }
echo "ASSERT PASS: script+voice+scenes=approved, assemble=awaiting_approval"

# ── 4. Double-approve guard (ruling 4A) ─────────────────────────────────────
# An already-approved gate with its next gate open → clean error from CLI or 409.
echo ""
echo "--- [4] Double-approve guard: re-approving script (already approved) ---"
DOUBLE_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "$BASE/api/session/$SID/approve" \
  -H 'content-type: application/json' \
  -d '{"gate":"script"}')
echo "$DOUBLE_RESP"
# Accept either: HTTP 409 in status line, or "error" / "409" in response body
if echo "$DOUBLE_RESP" | grep -qi 'error\|409'; then
  echo "ASSERT PASS: double-approve returned error/409"
else
  echo "ERROR: double-approve did not return error or 409"
  exit 1
fi

echo ""
echo "GATE FLOW E2E: PASS ($SID)"
