# HTTP Check Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `node check.js` start a Basic-authenticated HTTP server with `POST /check`.

**Architecture:** Keep the existing CLI/module file. Add small pure helpers for Basic auth, JSON responses, body parsing, logging middleware, and a `createServer()` factory so tests can inject a fake checker without TDLib.

**Tech Stack:** Node.js built-in `node:http`, existing `node:test`, no new runtime dependency.

---

### Task 1: HTTP API Behavior

**Files:**
- Modify: `test/check.test.js`
- Modify: `check.js`

- [ ] **Step 1: Write failing tests**

Add tests that start `createServer({ auth, checkUrl })` on an ephemeral port and assert:
- missing Basic auth returns `401`
- invalid body returns `400`
- valid `POST /check` calls the injected checker and returns its expanded JSON

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/check.test.js`
Expected: FAIL because `createServer` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add `createServer()`, `startServer()`, Basic auth validation, JSON body parsing, and request logging. Route only `POST /check`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/check.test.js`
Expected: PASS.

### Task 2: Entry Point And Docs

**Files:**
- Modify: `check.js`
- Modify: `README.md`

- [ ] **Step 1: Write failing tests**

Add tests for `shouldStartServer([]) === true` and `shouldStartServer(['--sources', 'urls.txt']) === false`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/check.test.js`
Expected: FAIL because `shouldStartServer` is not exported.

- [ ] **Step 3: Write minimal implementation**

Use `shouldStartServer(process.argv.slice(2))` in the module entry point. Server mode requires `TG_API_ID`, `TG_API_HASH`, `CHECK_AUTH_USER`, and `CHECK_AUTH_PASSWORD`; CLI mode keeps existing behavior.

- [ ] **Step 4: Update README**

Document server mode, env vars, endpoint, and curl example.

- [ ] **Step 5: Run full verification**

Run: `node --test`
Expected: PASS.
