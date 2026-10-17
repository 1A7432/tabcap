# If you know Chrome DevTools MCP

Names follow its tools (`take_snapshot` → `snapshot`, `list_network_requests` → `net list` …; the whole mapping is at the end of [recording.md](recording.md)). Three things differ:

1. **Refs are not uids.** A ref (`e12`, `f2/e7` in a frame) comes from `snapshot` or `find` and is bound to one node in one document; after a navigation or re-render the command fails with `stale-ref` — take a new snapshot.
2. **`net list` hides failed requests and `data:` URLs by default**, but counts them in `hidden: {failed, data}`; `--failed` shows only those, `--all` everything.
3. **`--snapshot` is optional.** `click`, `hover`, `fill`, `type`, `press-key`, `upload` return a fresh snapshot only with `--snapshot`.
