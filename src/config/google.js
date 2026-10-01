/**
 * Google Sign-In configuration.
 *
 * ONE VALUE, AND IT IS NOT A SECRET. Raahi uses Google Identity Services with
 * an ID token: the browser obtains a signed JWT from Google and this backend
 * verifies it against Google's published keys. No client secret takes part in
 * that exchange, so there is no client secret in this project at all — nothing
 * to leak, rotate, or keep out of Vite. The client id is public by design; it
 * appears in the page that renders the button and identifies which application
 * a token was minted for, which is precisely what the `audience` check uses.
 *
 * The authorization-code flow would need a secret, and would buy access to
 * Google's APIs on the person's behalf. Raahi only needs to know who they are.
 */
const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();

/**
 * Google's own issuer values, both of which it uses.
 *
 * Checked explicitly rather than left to the library's defaults, because the
 * issuer is one of the claims that decides whether a token is Google's at all.
 */
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Whether Google sign-in can be offered.
 *
 * A deployment without a client id is not broken — it simply does not offer
 * the button, and the password flow is untouched. Nothing here throws at boot.
 */
const configured = () => Boolean(clientId);

/**
 * The safe half, for the client and for the admin console.
 *
 * The client id is returned because the browser needs it to render Google's
 * button. It is the only value there is.
 */
function describe() {
  return {
    configured: configured(),
    clientId: clientId || null
  };
}

module.exports = { clientId, ISSUERS, configured, describe };
