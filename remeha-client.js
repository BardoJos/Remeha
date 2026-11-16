
const axios = require("axios");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const crypto = require("crypto");
const fs = require("fs");

const BASE_LOGIN =
    "https://remehalogin.bdrthermea.net/bdrb2cprod.onmicrosoft.com";

const BASE_API =
    "https://api.bdrthermea.net/Mobile/api";

const CLIENT_ID =
    "6ce007c6-0628-419e-88f4-bee2e6418eec";

const POLICY = "B2C_1A_RPSignUpSignInNewRoomV3.1";

const REDIRECT_URI = "com.b2c.remehaapp://login-callback";

const SCOPE =
    "openid https://bdrb2cprod.onmicrosoft.com/iotdevice/user_impersonation offline_access";

const SUBSCRIPTION_KEY =
    "df605c5470d846fc91e848b1cc653ddf";

class RemehaClient {
    constructor(options = {}) {
        this.email = options.email;
        this.password = options.password;
        this.tokenFile = options.tokenFile || "/data/remeha-token.json";
        this.clientId = options.clientId || CLIENT_ID;
        this.subscriptionKey = options.subscriptionKey || SUBSCRIPTION_KEY;

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
            BASE_LOGIN + "/oauth2/v2.0/authorize",
            {
                params: {
                    response_type: "code",
                    client_id: this.clientId,
                    redirect_uri: REDIRECT_URI,
                    scope: SCOPE,
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
            throw new Error("OAuth request-id missing");
        }

        const stateProperties = this.base64url(
            Buffer.from(JSON.stringify({ TID: requestId }))
        );

        // 2. Retrieve CSRF cookie
        const cookies = await this.jar.getCookies(
            "https://remehalogin.bdrthermea.net"
        );

        const csrfCookie = cookies.find(
            c => c.key === "x-ms-cpim-csrf"
        );

        if (!csrfCookie) {
            throw new Error("Remeha CSRF-cookie missing");
        }

        const csrf = csrfCookie.value;

        // 3. Submit credentials
        const authResponse = await this.http.post(
            `${BASE_LOGIN}/${POLICY}/SelfAsserted`,
            new URLSearchParams({
                request_type: "RESPONSE",
                signInName: this.email,
                password: this.password
            }).toString(),
            {
                params: {
                    tx: "StateProperties=" + stateProperties,
                    p: POLICY
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
            `${BASE_LOGIN}/${POLICY}/api/CombinedSigninAndSignup/confirmed`,
            {
                params: {
                    rememberMe: "false",
                    csrf_token: csrf,
                    tx: "StateProperties=" + stateProperties,
                    p: POLICY
                },
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400
            }
        );

        const location = callback.headers.location;

        if (!location) {
            throw new Error("OAuth callback missing");
        }

        const callbackUrl = new URL(
            location,
            "https://remehalogin.bdrthermea.net"
        );

        const code = callbackUrl.searchParams.get("code");
        const returnedState = callbackUrl.searchParams.get("state");

        if (!code || returnedState !== state) {
            throw new Error("Invalid OAuth callback of state");
        }

        // 5. Exchange authorization code
        return await this.requestToken({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: verifier,
            client_id: this.clientId
        });
    }

    async requestToken(params) {
        const response = await this.http.post(
            `${BASE_LOGIN}/oauth2/v2.0/token`,
            new URLSearchParams(params).toString(),
            {
                params: { p: POLICY },
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                maxRedirects: 10
            }
        );

        const token = response.data;

        if (!token.access_token) {
            throw new Error("Access token not received");
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
                url: BASE_API + path,
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
                    url: BASE_API + path,
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

    // Eco mode / anti-frost
    async setHotWaterEco(hotWaterZoneId) {
        return this.api(
            "POST",
            `/hot-water-zones/${encodeURIComponent(hotWaterZoneId)}/modes/anti-frost`
        );
    }
	
	// Set Eco temperature
    async setHotWaterEcoTemperature(hotWaterZoneId, temperature) {
        return this.api(
            "POST",
            `/hot-water-zones/${encodeURIComponent(hotWaterZoneId)}/reduced-setpoint`,
            {
                reducedSetpoint: Number(temperature)
            }
        );
    }
	
	// Set Comfort temperature
    async setHotWaterComfortTemperature(hotWaterZoneId, temperature) {
        return this.api(
            "POST",
            `/hot-water-zones/${encodeURIComponent(hotWaterZoneId)}/comfort-setpoint`,
            {
                comfortSetpoint: Number(temperature)
            }
        );
    }
	
	// Comfort mode
    async setHotWaterComfort(hotWaterZoneId) {
        return this.api(
            "POST",
            `/hot-water-zones/${encodeURIComponent(hotWaterZoneId)}/modes/continuous-comfort`
        );
    }
	
	// Schedule mode
    async setHotWaterSchedule(hotWaterZoneId) {
        return this.api(
            "POST",
            `/hot-water-zones/${encodeURIComponent(hotWaterZoneId)}/modes/schedule`
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
	
    // ==============================
    // ENERGY CONSUMPTION
    // ==============================

    async getConsumption(applianceId, period, startDate, endDate) {

        const allowedPeriods = [
            "daily",
            "monthly",
            "yearly"
        ];

        if (!allowedPeriods.includes(period)) {
            throw new Error(
                "not a valid period. Use daily, monthly or yearly."
            );
        }

        if (!startDate || !endDate) {
            throw new Error(
                "startDate and endDate are mandatory"
            );
        }

        const formatDate = date => {
            return new Date(date)
                .toISOString()
                .replace("T", " ");
        };

        const params = new URLSearchParams({
            startDate: formatDate(startDate),
            endDate: formatDate(endDate)
        });

        return this.api(
            "GET",
            `/appliances/${encodeURIComponent(applianceId)}/energyconsumption/${period}?${params}`
        );
    }

    // Daily consumption
    async getConsumptionDaily(applianceId, startDate, endDate) {
        return this.getConsumption(
            applianceId,
            "daily",
            startDate,
            endDate
        );
    }

    // Monthly consumption
    async getConsumptionMonthly(applianceId, startDate, endDate) {
        return this.getConsumption(
            applianceId,
            "monthly",
            startDate,
            endDate
        );
    }

    // Yearly consumption
    async getConsumptionYearly(applianceId, startDate, endDate) {
        return this.getConsumption(
            applianceId,
            "yearly",
            startDate,
            endDate
        );
    }
	
    // Today's consumption
    async getConsumptionToday(applianceId) {

        const today = new Date();

        const start = new Date(today);
        start.setHours(0, 0, 0, 0);

        const end = new Date(today);
        end.setHours(23, 59, 59, 999);

        return this.getConsumption(
            applianceId,
            "daily",
            start,
            end
        );
    }
}

module.exports = RemehaClient;
