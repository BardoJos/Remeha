
const axios = require("axios");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const crypto = require("crypto");
const fs = require("fs");

class RemehaClient {
    constructor(options = {}) {
        this.email           = options.email;
        this.password        = options.password;
        this.tokenFile       = options.tokenFile || "/data/remeha-token.json";		
        this.baseLogin       = options.baseLogin;		
        this.baseTenant      = options.baseTenant;		
        this.baseApi         = options.baseApi;		
        this.clientId        = options.clientId;		
        this.policy          = options.policy;	
        this.redirectUri     = options.redirectUri;	
        this.scope           = options.scope;	
        this.subscriptionKey = options.subscriptionKey;
		
        this.jar = new CookieJar();

        this.http = wrapper(axios.create({
            jar: this.jar,
            timeout: 30000,
            maxRedirects: 10
        }));

        this.token = null;
    }

    async loadToken() {
        try {
            this.token = JSON.parse(
                fs.readFileSync(this.tokenFile, "utf8")
            );
        } catch (e) {
            this.token = null;
        }
    }

    async saveToken(token) {
        this.token = token;

        const tmp = this.tokenFile + ".tmp";

        fs.writeFileSync(tmp, JSON.stringify(token), {
            mode: 0o600
        });

        fs.renameSync(tmp, this.tokenFile);
    }

    base64url(buffer) {
        return buffer.toString("base64")
            .replace(/=/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_");
    }

    async login() {
        if (!this.email || !this.password) {
            throw new Error("Remeha credentials missing");
        }

        const state = this.base64url(crypto.randomBytes(32));
        const verifier = this.base64url(crypto.randomBytes(64));

        const challenge = this.base64url(
            crypto.createHash("sha256")
                .update(verifier)
                .digest()
        );

        // 1. Start OAuth login
        const authorize = await this.http.get(
            this.baseLogin + "/" + this.baseTenant + "/oauth2/v2.0/authorize",
            {
                params: {
                    response_type: "code",
                    client_id: this.clientId,
                    redirect_uri: this.redirectUri,
                    scope: "openid " + this.scope,
                    state,
                    code_challenge: challenge,
                    code_challenge_method: "S256",
                    p: this.policy,
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
            throw new Error("OAuth request-id missing");
        }

        const stateProperties = this.base64url(
            Buffer.from(JSON.stringify({ TID: requestId }))
        );

        // 2. Retrieve CSRF cookie
        const cookies = await this.jar.getCookies(this.baseLogin);

        const csrfCookie = cookies.find(
            c => c.key === "x-ms-cpim-csrf"
        );

        if (!csrfCookie) {
            throw new Error("Remeha CSRF-cookie missing");
        }

        const csrf = csrfCookie.value;

        // 3. Submit credentials
        const authResponse = await this.http.post(
            `${this.baseLogin}/${this.baseTenant}/${this.policy}/SelfAsserted`,
            new URLSearchParams({
                request_type: "RESPONSE",
                signInName: this.email,
                password: this.password
            }).toString(),
            {
                params: {
                    tx: "StateProperties=" + stateProperties,
                    p: this.policy
                },
                headers: {
                    "x-csrf-token": csrf,
                    "Content-Type": "application/x-www-form-urlencoded"
                }
            }
        );

        if (String(authResponse.data.status) !== "200") {
            throw new Error("Remeha login failed");
        }

        // 4. Complete authentication
        const callback = await this.http.get(
            `${this.baseLogin}/${this.baseTenant}/${this.policy}/api/CombinedSigninAndSignup/confirmed`,
            {
                params: {
                    rememberMe: "false",
                    csrf_token: csrf,
                    tx: "StateProperties=" + stateProperties,
                    p: this.policy
                },
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400
            }
        );

        const location = callback.headers.location;

        if (!location) {
            throw new Error("OAuth callback missing");
        }

        const callbackUrl = new URL(location, this.baseLogin);

        const code = callbackUrl.searchParams.get("code");
        const returnedState = callbackUrl.searchParams.get("state");

        if (!code || returnedState !== state) {
            throw new Error("Invalid OAuth callback of state");
        }

        // 5. Exchange authorization code
        return await this.requestToken({
            grant_type: "authorization_code",
            code,
            redirect_uri: this.redirectUri,
            code_verifier: verifier,
            client_id: this.clientId
        });
    }

    async requestToken(params) {
        const response = await this.http.post(
            `${this.baseLogin}/${this.baseTenant}/oauth2/v2.0/token`,
            new URLSearchParams(params).toString(),
            {
                params: { p: this.policy },
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                maxRedirects: 10
            }
        );

        const token = response.data;

        if (!token.access_token) {
            throw new Error("No access token received");
        }

        token.expires_at = Date.now() +
            (Number(token.expires_in || 3600) * 1000);

        await this.saveToken(token);

        return token;
    }

    async refreshToken() {
        if (!this.token || !this.token.refresh_token) {
            return this.login();
        }

        try {
            return await this.requestToken({
                grant_type: "refresh_token",
                refresh_token: this.token.refresh_token,
                client_id: this.clientId
            });
        } catch (error) {
            if (error.response?.status === 400) {
                throw new Error(
                    "Remeha refresh token rejected. Re-login required."
                );
            }
            throw error;
        }
    }

    async getAccessToken() {
        if (!this.token) {
            await this.loadToken();
        }

        if (!this.token) {
            await this.login();
        } else if (
            !this.token.expires_at ||
            Date.now() >= this.token.expires_at - 60000
        ) {
            await this.refreshToken();
        }

        return this.token.access_token;
    }

    async api(method, path, data = undefined) {
        const accessToken = await this.getAccessToken();

        try {
            const response = await this.http.request({
                method,
                url: this.baseApi + path,
                data,
                headers: {
                    Authorization: "Bearer " + accessToken,
                    "Ocp-Apim-Subscription-Key": this.subscriptionKey,
                    "Content-Type": "application/json"
                }
            });

            return response.data;
        } catch (error) {
            if (error.response?.status === 401) {
                await this.refreshToken();

                const retryToken = this.token.access_token;

                const retry = await this.http.request({
                    method,
                    url: this.baseApi + path,
                    data,
                    headers: {
                        Authorization: "Bearer " + retryToken,
                        "Ocp-Apim-Subscription-Key": this.subscriptionKey,
                        "Content-Type": "application/json"
                    }
                });

                return retry.data;
            }

            throw error;
        }
    }

    // Dashboard
    async getDashboard() {
        return this.api(
            "GET",
            "/homes/dashboard?t=" + Date.now()
        );
    }

    // Manual temperature
    async setManual(zoneId, setpoint) {
        return this.api(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/manual`,
            { roomTemperatureSetPoint: Number(setpoint) }
        );
    }

    // Schedule mode
    async setSchedule(zoneId, programId) {
        return this.api(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/schedule`,
            { heatingProgramId: Number(programId) }
        );
    }

    // Temporary override
    async setTemporaryOverride(zoneId, setpoint) {
        return this.api(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/temporary-override`,
            { roomTemperatureSetPoint: Number(setpoint) }
        );
    }

    // Off / anti-frost
    async setOff(zoneId) {
        return this.api(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/anti-frost`
        );
    }

    // Activate heating time program
    async activateHeatingProgram(zoneId, programId) {
        return this.api(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/time-programs/heating/${encodeURIComponent(programId)}/activate`
        );
    }

    // Fireplace mode
    async setFireplaceMode(zoneId, enabled) {
        return this.api(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/fireplacemode`,
            { fireplaceModeActive: Boolean(enabled) }
        );
    }

    // Appliance technical information
    async getTechnicalInformation(applianceId) {
        return this.api(
            "GET",
            `/appliances/${encodeURIComponent(applianceId)}/technicaldetails`
        );
    }

    // Today's consumption
    async getConsumptionToday(applianceId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const end = new Date(today);
        end.setHours(23, 59, 59, 0);

        const format = date => {
            return date.toISOString().replace("T", " ")
                .replace("Z", ".000Z");
        };

        const params = new URLSearchParams({
            startDate: format(today),
            endDate: format(end)
        });

        return this.api(
            "GET",
            `/appliances/${encodeURIComponent(applianceId)}/energyconsumption/daily?${params}`
        );
    }
}

module.exports = RemehaClient;
