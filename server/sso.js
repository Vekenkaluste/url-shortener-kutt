// Users who sign in through an identity provider (OIDC, IAP) instead of a Kutt
// password. The provider vouches for the email, so the user is created verified,
// with a random password that is never shown.

const bcrypt = require("bcryptjs");

const query = require("./queries");
const utils = require("./utils");

async function findOrCreateUser(email) {
  const user = await query.user.find({ email });
  if (user) return user;

  const salt = await bcrypt.genSalt(12);
  const password = await bcrypt.hash(utils.generateRandomPassword(), salt);
  try {
    await query.user.add({ email, password, verified: true });
  } catch (error) {
    // two first sign-ins at once: the other one created the user
    const existing = await query.user.find({ email });
    if (existing) return existing;
    throw error;
  }

  return query.user.update({ email }, {
    verification_token: null,
    verification_expires: null,
  });
}

module.exports = {
  findOrCreateUser,
};
