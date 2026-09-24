#!/usr/bin/env bash
# Integration tests: mock suite (writes, no network) + real API suite
# (read-only, public Zotero library of documentation user 475425).
set -e
cd "$(dirname "$0")/.."

node test/mock-zotero.js &
MOCKPID=$!
sleep 1
PORT=$(cat test/.mock-port)
node test/run-tests.js "$PORT"
RC=$?
kill $MOCKPID 2>/dev/null || true
rm -f test/.mock-port

node test/run-tests.js real
exit $RC
