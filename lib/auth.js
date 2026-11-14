
"use strict";

const axios = require("axios");
const crypto = require("crypto");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");

const BASE = "https://remehalogin.bdrthermea.net";
const TENANT = "/bdrb2cprod.onmicrosoft.com";
const POLICY = "B2C_1A_RPSignUpSignInNewRoomV3.1";

const CLIENT_ID =
    "6ce007c6-0628-419e-88f4-bee2e6418eec";

const REDIRECT_URI = "com.b2c.remehaapp://login-callback";

class RemehaAuth {
    constructor(config) {
        this.email = config.email;
        this.password = config.password;
        this.clientId = config.clientId || CLIENT_ID;
        this.token = config.token || null;
        this.onToken = config.onToken || (() => {});

        this.jar = new CookieJar();

        this.http = wrapper(axios.create({
            jar: this.jar,
            timeout: 30000
        }));

        this.refreshPromise = null;
    }

    b64(data) {
        return Buffer.from(data).toString("base64url");
    }

    async login() {
        const state = this.b64(crypto.randomBytes(32));
        const verifier = this.b64(crypto.randomBytes(64));

        const challenge = this.b64(
            crypto.createHash("sha256")
                .update(verifier)
                .digest()
        );

        const authorize = await this.http.get(
            `${BASE}${TENANT}/oauth2/v2.0/authorize`,
            {
                params: {
                    response_type: "code",
                    client_id: this.clientId,
                    redirect_uri: REDIRECT_URI,
                    scope:
                        "openid https://bdrb2cprod.onmicrosoft.com/iotdevice/user_impersonation offline_access",
                    state,
                    code_challenge: challenge,
                    code_challenge_method: "S256",
                    p: POLICY,
                    brand: "remeha",
                    lang: "en",
                    nonce: "defaultNonce",
                    prompt: "login",
                    signUp: "False"
                }
            }
        );

        const requestId = authorize.headers["x-request-id"];

        if (!requestId) {
            throw new Error("Remeha request ID is missing");
        }

        const stateProperties = this.b64(
            JSON.stringify({ TID: requestId })
        );

        const cookies = await this.jar.getCookies(BASE);

        const csrfCookie = cookies.find(
            cookie => cookie.key === "x-ms-cpim-csrf"
        );

        if (!csrfCookie) {
            throw new Error("Remeha CSRF-cookie is missing");
        }

        const csrf = csrfCookie.value;

        const credentials = new URLSearchParams({
            request_type: "RESPONSE",
            signInName: this.email,
            password: this.password
        });

        const authResponse = await this.http.post(
            `${BASE}${TENANT}/${POLICY}/SelfAsserted`,
            credentials.toString(),
            {
                params: {
                    tx: "StateProperties=" + stateProperties,
                    p: POLICY
                },
                headers: {
                    "x-csrf-token": csrf,
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                }
            }
        );

        if (String(authResponse.data.status) !== "200") {
            throw new Error("Remeha login failed");
        }

        const callback = await this.http.get(
            `${BASE}${TENANT}/${POLICY}/api/CombinedSigninAndSignup/confirmed`,
            {
                params: {
                    rememberMe: "false",
                    csrf_token: csrf,
                    tx: "StateProperties=" + stateProperties,
                    p: POLICY
                },
                maxRedirects: 0,
                validateStatus: status =>
                    status >= 200 && status < 400
            }
        );

        if (!callback.headers.location) {
            throw new Error("OAuth callback is missing");
        }

        const callbackUrl = new URL(callback.headers.location);

        const code = callbackUrl.searchParams.get("code");
        const returnedState = callbackUrl.searchParams.get("state");

        if (!code || returnedState !== state) {
            throw new Error("Ongeldige OAuth callback");
        }

        return this.requestToken({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
            client_id: this.clientId
        });
    }

    async requestToken(params) {
        const response = await this.http.post(
            `${BASE}${TENANT}/oauth2/v2.0/token`,
            new URLSearchParams(params).toString(),
            {
                params: { p: POLICY },
                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded"
                }
            }
        );

        const token = response.data;

        if (!token.access_token) {
            throw new Error("No access token received");
        }

        if (!token.refresh_token && this.token?.refresh_token) {
            token.refresh_token = this.token.refresh_token;
        }

        token.expires_at = Date.now() +
            Number(token.expires_in || 3600) * 1000;

        this.token = token;
        await this.onToken(token);

        return token;
    }

    async refresh() {
        if (this.refreshPromise) {
            return this.refreshPromise;
        }

        this.refreshPromise = (async () => {
            try {
                if (!this.token?.refresh_token) {
                    return await this.login();
                }

                return await this.requestToken({
                    grant_type: "refresh_token",
                    refresh_token: this.token.refresh_token,
                    client_id: this.clientId
                });
            } finally {
                this.refreshPromise = null;
            }
        })();

        return this.refreshPromise;
    }

    async getAccessToken() {
        if (
            !this.token ||
            !this.token.access_token ||
            !this.token.expires_at ||
            Date.now() >= this.token.expires_at - 60000
        ) {
            await this.refresh();
        }

        return this.token.access_token;
    }
}

module.exports = RemehaAuth;
