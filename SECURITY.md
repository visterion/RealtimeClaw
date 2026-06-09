# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in RealtimeClaw, please report it
responsibly. **Do not open a public issue.**

Use [GitHub's private vulnerability reporting](https://github.com/ufelmann/RealtimeClaw/security/advisories/new)
to submit a report. Only you and the maintainers can see it.

You will receive an acknowledgment within 48 hours and a detailed response
within 7 days.

## Scope

- RealtimeClaw bridge code (this repository)
- Home Assistant addon configuration
- Authentication and device pairing logic
- Speaker identification and security level enforcement

## Out of Scope

- Vulnerabilities in third-party dependencies (report upstream)
- xAI / OpenAI / Picovoice API security (report to those providers)
- Home Assistant core vulnerabilities (report to HA security team)

## Security Model

See the Security Model section in [README.md](README.md) for how speaker
identification and tool permissions work.
