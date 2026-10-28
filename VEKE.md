# Kutt on the Veke platform

This is a fork of [thedevs-network/kutt](https://github.com/thedevs-network/kutt).
It shortens the unsubscribe links in SMS messages: Bloomreach sends the message
to Frends, Frends asks Kutt for a short link, and the short link goes into the
SMS. Short links live on `s.veke.fi`.

Keep changes to upstream code small and in this list, so the fork can follow
upstream releases.

## Changes from upstream

| Change | Files |
|---|---|
| Login through Google Cloud IAP (`IAP_*` settings) | `server/iap.js`, `server/env.js`, `server/passport.js`, `server/handlers/auth.handler.js` |
| OIDC and IAP share the code that creates a user on first sign-in | `server/sso.js`, `server/passport.js` |
| Requests to the IAP UI host (`IAP_DOMAIN`) skip the custom domain lookup | `server/handlers/links.handler.js` |
| `create-admin` is disabled when IAP is on | `server/routes/auth.routes.js` |
| No password, logout or delete-account UI when IAP is on | `server/views/settings.hbs`, `server/views/partials/header.hbs`, `server/handlers/locals.handler.js` |
| `/api/health` answers before any middleware, with no database query | `server/server.js`, `server/routes/routes.js` |
| Graceful shutdown on `SIGTERM` | `server/server.js` |
| Platform Dockerfile and build workflow; upstream Docker Hub workflows removed | `Dockerfile`, `.dockerignore`, `.github/workflows/build.yaml` |
| Compose setups run the migrations and pass `.env` in, since the image does neither | `docker-compose*.yml` |

## How access works

One deployment, two hostnames:

| Hostname | IAP | Serves |
|---|---|---|
| `url-shortener-kutt.<stage>.veke.fi` | yes | The UI and the full API, for Veke users |
| `s.veke.fi` (`s.test.veke.fi` on test) | no | Short link redirects, and link creation for integrations |

**Users** sign in with their `vekenkaluste.fi` Google account through IAP.
There are no Kutt passwords. A user is created on first visit, and the emails
in `IAP_ADMIN_EMAILS` become admins. Removing an email from that list does not
demote the user; do that in the admin panel. A banned user gets an error page
instead of being logged out, because IAP would sign them straight back in.

**Integrations** (Frends, Bloomreach) call `POST https://s.veke.fi/api/v2/links`
with an `X-API-KEY` header. A key belongs to a Kutt user: sign in to the UI as
the integration's account, open Settings and generate it. Links created with
the key are owned by that account and can be managed in the UI.

Anonymous links are disabled (`DISALLOW_ANONYMOUS_LINKS=true`), because link
creation is reachable without IAP. Without a valid key it is refused.

## How the IAP login works

IAP adds a JWT signed by Google to every request it lets through
(`x-goog-iap-jwt-assertion`). `server/iap.js` verifies it: Google's signature,
the IAP issuer, expiry, the `hd` claim against `IAP_HOSTED_DOMAIN`, and the
audience against `IAP_AUDIENCE`. Anything else is "not signed in".

The plain-text `x-goog-authenticated-user-*` headers are never used: requests
to `s.veke.fi` do not pass IAP, so a client could set them.

`IAP_AUDIENCE` is the prefix `/projects/<project number>/`. The full audience
names the load balancer's backend service, which GKE creates from the
declarative IAP config, so its id is not known in advance. The prefix check
rejects assertions issued for any other project.

### Known limitation: assertions from other apps in the project

The prefix check does not reject an assertion that IAP issued for another
IAP-protected app in the same GCP project. IAP sends that app a signed
assertion for each of its users. Its owner, or anyone who takes it over, could
send such an assertion to Kutt on `s.veke.fi`, which has no IAP in front of it.
Kutt would sign the request in as that user, for the few minutes the assertion
is valid. That includes Kutt admins who have used the other app.

This is accepted for now. It goes away once Kutt can check the exact audience,
i.e. when the backend service id is known to the deployment.

## Configuration

Settings that differ from upstream defaults:

| Variable | Value |
|---|---|
| `DEFAULT_DOMAIN` | `s.veke.fi` (`s.test.veke.fi` on test) |
| `DB_CLIENT` | `pg` |
| `IAP_ENABLED` | `true` |
| `IAP_HOSTED_DOMAIN` | `vekenkaluste.fi` |
| `IAP_AUDIENCE` | `/projects/<project number>/`, per stage |
| `IAP_ADMIN_EMAILS` | comma-separated admin emails |
| `IAP_DOMAIN` | `url-shortener-kutt.<stage>.veke.fi` |
| `DISALLOW_LOGIN_FORM` | `true` |
| `DISALLOW_REGISTRATION` | `true` |
| `DISALLOW_ANONYMOUS_LINKS` | `true` |

## Database migrations

The image starts the server only. Migrations run as a separate step with the
same image before a new version rolls out:

```sh
node node_modules/knex/bin/cli.js migrate:latest
```

## Running locally

There is no IAP on a laptop, so run with IAP off and the login form on:

```sh
cp .example.env .env   # IAP_ENABLED=false, DISALLOW_LOGIN_FORM=false
npm install
npm run migrate
npm run dev
```

The upstream `docker-compose*.yml` setups work too, with the same `.env`: they
run the migrations before starting the server.
