# Security Policy

## Reporting a vulnerability

Report security vulnerabilities privately through GitHub's private vulnerability
reporting: open the **Security** tab of this repository and click **Report a
vulnerability**. Please do not open a public issue for a security bug.

This is a personal learning project rather than a commercially supported
product. Genuine security issues are still taken seriously and fixed.

## Scope

The harness runs LLM agents against a third-party game API and exposes a local
web dashboard. Scrutiny is most useful on the dashboard's authentication, the
handling of untrusted game and LLM text, secrets handling, and the container
and CI supply chain (pinned actions, image provenance, secret scanning).
