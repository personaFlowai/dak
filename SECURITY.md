# Security

Dak keeps everything on your Mac. The server listens on 127.0.0.1 only, checks the Host and Origin of every request, and requires the token in `~/.dak/token` (readable only by you). Remote agents use a separate key that can only send to you and read their own threads, and only while you keep a tunnel open.

Please report a security problem privately through [GitHub's advisory form](https://github.com/personaflowai/dak/security/advisories/new), not in a public issue.
