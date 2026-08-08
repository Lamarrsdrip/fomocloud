# Hostinger deployment target

Use a VPS or Hostinger environment that supports long-running Node services, PostgreSQL and Redis.
The trading/listener workers must not be deployed as short-lived request-only functions.

Recommended:
- web: Node process behind Nginx
- admin: separate Node process/path or subdomain
- API: persistent Node process
- listener/executor/exits: systemd or PM2 managed workers
- PostgreSQL: managed/external or local hardened instance
- Redis: managed/external or local hardened instance
- TLS: Hostinger/Nginx/Let's Encrypt
- temporary domain: use Hostinger-provided temporary domain for testing, then switch production DNS

Do not enable LIVE execution during the first deployment. Verify the full simulation path, notifications,
email, admin config, database, queues and worker health first.
