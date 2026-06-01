# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/Tar4s/mtproto-checker/security/advisories/new).

Alternatively, email: **shackoor@protonmail.com**

Please include:

- Description of the issue
- Steps to reproduce
- Potential impact

I'll respond within 48 hours.

## Scope

This project runs a Node.js HTTP server with Basic Auth. Known considerations:

- Basic Auth credentials are sent in headers — always use HTTPS in production
- TDLib temp files (`.proxy-checker-td/`) are auto-cleaned after each run
- No user data is stored or persisted
