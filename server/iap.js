// Login through Google Cloud Identity-Aware Proxy (IAP).
//
// When Kutt runs behind IAP, every request that passed IAP carries a JWT signed
// by Google in the x-goog-iap-jwt-assertion header. This strategy verifies that
// assertion and signs the request in as the Kutt user with the same email,
// creating the user on first visit. It fails closed: a missing, expired, forged
// or foreign assertion means "not signed in", and the next strategy is tried.
//
// The plain-text x-goog-authenticated-user-* headers are never read. They are
// only trustworthy if nothing can reach Kutt without passing IAP, which is not
// true when some routes (short link redirects, the API) are served without it.

const { createRemoteJWKSet, jwtVerify } = require("jose");
const { Strategy } = require("passport");

const { ROLES } = require("./consts");
const query = require("./queries");
const sso = require("./sso");
const env = require("./env");

const IAP_ISSUER = "https://cloud.google.com/iap";
const IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";
const ASSERTION_HEADER = "x-goog-iap-jwt-assertion";

// jose caches the keys and refetches them when it meets an unknown key id
let remoteJwks;

// the audience names the backend service the assertion was issued for, e.g.
// /projects/<project number>/global/backendServices/<id>. GKE creates the backend
// service from the declarative IAP config, so its id is not known in advance and
// only the /projects/<project number>/ prefix is checked. that rejects assertions
// issued for other projects, but not those issued for another IAP-protected app
// in the same project; together with s.veke.fi, which serves Kutt without IAP,
// such an app could replay its users' assertions to Kutt. accepted, see VEKE.md
function audienceMatches(aud, prefix) {
  const audiences = Array.isArray(aud) ? aud : aud ? [aud] : [];
  return audiences.some(value => value.startsWith(prefix));
}

// returns the verified email address, or null
async function verifyAssertion(assertion, options) {
  if (!assertion) return null;

  const keys = options.keys || (remoteJwks ??= createRemoteJWKSet(new URL(IAP_JWKS_URL)));
  try {
    const { payload } = await jwtVerify(assertion, keys, {
      issuer: IAP_ISSUER,
      algorithms: ["ES256"],
    });
    if (payload.hd !== options.hostedDomain || typeof payload.email !== "string") {
      return null;
    }
    if (!audienceMatches(payload.aud, options.audiencePrefix)) {
      return null;
    }
    return payload.email.toLowerCase();
  } catch (error) {
    console.warn(`Rejected IAP assertion: ${error.code || error.message}`);
    return null;
  }
}

function parseEmails(list) {
  return list
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

// user ids by email. the user queries cache users by id, not by email, so
// looking a known user up by id lets every request after the first one use
// that cache. the map only holds users of the hosted domain, so it stays small
const userIds = new Map();

async function findUser(email) {
  const id = userIds.get(email);
  if (id) {
    const user = await query.user.find({ id });
    // the user may have been deleted, or their email changed, since
    if (user?.email === email) return user;
    userIds.delete(email);
  }
  return sso.findOrCreateUser(email);
}

async function signIn(email, adminEmails) {
  let user = await findUser(email);
  if (!user) return null;

  // IAP has verified the email, so a user waiting for an email confirmation
  // (e.g. made in the admin panel) does not need one
  if (!user.verified) {
    user = await query.user.update({ id: user.id }, {
      verified: true,
      verification_token: null,
      verification_expires: null,
    });
  }

  // only ever promotes; removing an email from the list does not demote,
  // so an admin made in the admin panel keeps their role
  if (adminEmails.includes(email) && user.role !== ROLES.ADMIN) {
    user = await query.user.update({ id: user.id }, { role: ROLES.ADMIN });
  }

  userIds.set(email, user.id);
  return user;
}

class IapStrategy extends Strategy {
  constructor(options = {}) {
    super();
    this.name = "iap";
    this.options = {
      hostedDomain: options.hostedDomain ?? env.IAP_HOSTED_DOMAIN,
      audiencePrefix: options.audiencePrefix ?? env.IAP_AUDIENCE,
      adminEmails: parseEmails(options.adminEmails ?? env.IAP_ADMIN_EMAILS),
      keys: options.keys,
    };
  }

  authenticate(req) {
    verifyAssertion(req.get(ASSERTION_HEADER), this.options)
      .then(email => email && signIn(email, this.options.adminEmails))
      .then(
        user => {
          // the auth handler's callback throws to reject a request, e.g. when no
          // strategy signed the user in or the user is banned. this runs outside
          // the middleware's call stack, so hand the throw back to passport as an
          // error, the same way the jwt strategy's verify callback does
          try {
            // tells the auth handler that logging out will not sign the user out
            user ? this.success(user, { iap: true }) : this.fail();
          } catch (error) {
            this.error(error);
          }
        },
        error => this.error(error)
      )
      .catch(error => console.error("IAP authentication error:\n", error));
  }
}

module.exports = {
  IapStrategy,
  verifyAssertion,
};
