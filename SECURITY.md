# Security

Please report vulnerabilities privately through [GitHub's security advisories](https://github.com/wusongbuaa/pandocs/security/advisories/new) rather than in a public issue. Say what you found and how to reproduce it. You should hear back within a few days.

## How it is put together

- Everything a page shows goes through a strict Content Security Policy, since it holds content written by many people and agents.
- Sessions, API tokens, password links and embed secrets are stored hashed, and shown once. What has to be sent on to other systems, such as Git tokens and webhook secrets, cannot be hashed. It is never shown again, and backups should be kept accordingly.
- Requests from anyone are limited in size before they are read, and in number per address. Behind a proxy, only the address it added counts. The server does this: an application that runs `packages/core` inside itself puts its own limits in front of it, since the handler only checks the size a request says it has.
- Agents can read, comment and propose. They cannot save, and they never see more than the person they work for.
- Visitors through an embedded page get only what was granted to their app by name.
- Restricted pages and the images only they use are never published to a shared directory.
- An upload is addressed by its SHA-256 within its space. Someone who can read a space can fetch any upload in it by that address, one only a restricted page uses included, which keeps images working in drafts not saved yet; the address cannot be guessed, and a page they cannot read does not show it to them. Someone with no login gets only what pages open to the public use.
