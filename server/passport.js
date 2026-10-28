const { Strategy: LocalAPIKeyStrategy } = require("passport-localapikey-update");
const { Strategy: JwtStrategy, ExtractJwt } = require("passport-jwt");
const { Strategy: LocalStrategy } = require("passport-local");
const passport = require("passport");
const bcrypt = require("bcryptjs");

const query = require("./queries");
const env = require("./env");
const utils = require("./utils")
const sso = require("./sso");

const jwtOptions = {
  jwtFromRequest: req => req.cookies?.token,
  secretOrKey: env.JWT_SECRET
};

passport.use(
  new JwtStrategy(jwtOptions, async (payload, done) => {
    try {
      // 'sub' used to be the email address
      // this check makes sure to invalidate old JWTs where the sub is still the email address
      if (typeof payload.sub === "string" || !payload.sub) {
        return done(null, false);
      }
      const user = await query.user.find({ id: payload.sub });
      if (!user) return done(null, false);
      return done(null, user, payload);
    } catch (err) {
      return done(err);
    }
  })
);

if (!env.DISALLOW_LOGIN_FORM) {
  const localOptions = {
    usernameField: "email"
  };
  
  passport.use(
    new LocalStrategy(localOptions, async (email, password, done) => {
      try {
        const user = await query.user.find({ email });
        if (!user) {
          return done(null, false);
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
          return done(null, false);
        }
        return done(null, user);
      } catch (err) {
        return done(err);
      }
    })
  );
}


const localAPIKeyOptions = {
  apiKeyField: "apikey",
  apiKeyHeader: "x-api-key"
};

passport.use(
  new LocalAPIKeyStrategy(localAPIKeyOptions, async (apikey, done) => {
    try {
      const user = await query.user.find({ apikey });
      if (!user) {
        return done(null, false);
      }
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  })
);

if (env.IAP_ENABLED) {
  const { IapStrategy } = require("./iap");
  passport.use(new IapStrategy());
}

if (env.OIDC_ENABLED) {
  async function enableOIDC() {
    const requiredKeys = ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_SCOPE", "OIDC_EMAIL_CLAIM"];
    requiredKeys.forEach((key) => {
      if (!env[key]) {
        throw new Error(`Missing required env ${key}`);
      }
    });
    const { Issuer, Strategy: OIDCStrategy, UserinfoResponse } = await import("openid-client");
    const issuer = await Issuer.discover(env.OIDC_ISSUER).catch(function (error) {
        error.info = "Failed connecting to OIDC issuer.";
        throw error;
      });
    const client = new issuer.Client({
      client_id: env.OIDC_CLIENT_ID,
      client_secret: env.OIDC_CLIENT_SECRET,
      redirect_uris: [utils.getSiteURL() + "/login/oidc"],
      response_types: ["code"]
    });
  
    passport.use(
      "oidc",
      new OIDCStrategy(
        {
          client,
          params: {
            scope: env.OIDC_SCOPE,
            ...(env.OIDC_PROMPT ? { prompt: env.OIDC_PROMPT } : {})
          },
          passReqToCallback: true
        },
        async (req, tokenset, userinfo, done) => {
          try {
            const email = userinfo[env.OIDC_EMAIL_CLAIM];
            const user = await sso.findOrCreateUser(email);
            return done(null, user);
          } catch (err) {
            return done(err);
          }
        }
      )
    );
  }

  enableOIDC();
}
