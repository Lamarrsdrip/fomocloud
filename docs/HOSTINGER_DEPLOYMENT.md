# Hostinger deployment target

The production split is **Hostinger static frontend + Windows VPS backend**. Hostinger does not run the trading workers. The VPS runs the API, MongoDB, Redis and persistent workers.
The trading/listener workers must not be deployed as short-lived request-only functions.

Recommended:
- web: Node process behind Nginx
- admin: separate Node process/path or subdomain
- API: persistent Node process
- listener/executor/exits: systemd or PM2 managed workers
- MongoDB: local hardened replica set on the VPS (or an explicitly chosen managed Mongo deployment)
- Redis: managed/external or local hardened instance
- TLS: Hostinger/Nginx/Let's Encrypt
- temporary domain: use Hostinger-provided temporary domain for testing, then switch production DNS

Do not enable LIVE execution during the first deployment. Verify the full simulation path, notifications,
email, admin config, database, queues and worker health first.
