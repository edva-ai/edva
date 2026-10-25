#!/bin/bash
# edva-email-label.sh — find a recently-sent agent-address email by subject
# in the user's inbox and apply the `edva-out` label.
#
# Spawned in the background by bin/email-send after a successful self-send.
# SMTP2Go delivery + Gmail indexing typically take 5-30s, so we poll a few times.

SUBJECT="$1"
[ -z "$SUBJECT" ] && exit 0

GMAIL_ACTION="$(dirname "$0")/gmail-action"
[ -x "$GMAIL_ACTION" ] || exit 0

# Wait for delivery + Gmail indexing.
sleep 30

# Use Gmail search via gmail-action's underlying Gmail token. Easiest path: list
# unread, grep for the subject, then label. We do this through a small Node
# one-liner so we use the same OAuth path as gmail-action.
NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
LIB="$(dirname "$0")/../lib"

MSG_ID=$("$NODE_BIN" -e "
const { getAccessToken } = require('${LIB}/google-auth.js');
const agent = require('${LIB}/instance.cjs').instanceValue('agent_email');
(async () => {
  try {
    if (!agent) return;
    const tok = await getAccessToken();
    const q = encodeURIComponent('from:' + agent + ' subject:\"' + process.argv[1].replace(/\"/g, '') + '\" newer_than:1d');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + q + '&maxResults=1', { headers: { Authorization: 'Bearer ' + tok } });
    const j = await r.json();
    if (j.messages && j.messages[0]) console.log(j.messages[0].id);
  } catch (e) {}
})();
" "$SUBJECT" 2>/dev/null)

[ -z "$MSG_ID" ] && exit 0

"$GMAIL_ACTION" label "$MSG_ID" edva-out >/dev/null 2>&1
