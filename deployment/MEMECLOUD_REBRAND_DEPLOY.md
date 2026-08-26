# MemeCloud rebrand deployment

The source package is rebranded to MemeCloud. Existing live `fomocloud-*` NSSM services may still exist on the VPS.
Do not create duplicate workers blindly. Inventory existing services first, stop only the old app services, then migrate names
or keep legacy service names temporarily while pointing them to the new MemeCloud working directory. Do not touch XAU/MT5,
ClipForge, MongoDB/Redis instances belonging to other apps, or unrelated Caddy sites.

Before schema deployment, back up MongoDB. Hostinger frontend releases now come from the Git-connected Web App deployment history rather than manual `public_html` replacement.
Run install, Prisma generate/migration, typecheck, tests and build before restart.
LIVE_EXECUTION_ENABLED must remain false until the controlled owner live test passes.
