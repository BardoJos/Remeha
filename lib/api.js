
"use strict";

const axios = require("axios");

const BASE_URL = "https://api.bdrthermea.net/Mobile/api";

const SUBSCRIPTION_KEY =
    "df605c5470d846fc91e848b1cc653ddf";

class RemehaAPI {
    constructor(auth, config = {}) {
        this.auth = auth;
        this.subscriptionKey =
            config.subscriptionKey || SUBSCRIPTION_KEY;

        this.refreshPromise = null;
    }

    // ==========================================
    // AUTHENTICATION / HTTP
    // ==========================================

    async refreshAccessToken() {
        if (!this.refreshPromise) {
            this.refreshPromise = (async () => {
                await this.auth.refresh();

                const token = this.auth.token?.access_token;

                if (!token) {
                    throw new Error(
                        "Token refresh failed: access token missing"
                    );
                }

                return token;
            })();
        }

        try {
            return await this.refreshPromise;
        } finally {
            this.refreshPromise = null;
        }
    }

    async request(method, path, data) {
        const token = await this.auth.getAccessToken();

        const options = {
            method,
            url: BASE_URL + path,
            data,
            timeout: 30000,
            headers: {
                Authorization: `Bearer ${token}`,
                "Ocp-Apim-Subscription-Key":
                    this.subscriptionKey,
                "Content-Type": "application/json"
            }
        };

        try {
            const response = await axios(options);
            return response.data;
        } catch (error) {
            if (error.response?.status !== 401) {
                throw error;
            }

            await this.refreshAccessToken();

            options.headers.Authorization =
                `Bearer ${this.auth.token.access_token}`;

            const retry = await axios(options);
            return retry.data;
        }
    }

    // ==========================================
    // DASHBOARD
    // ==========================================

    getDashboard() {
        return this.request(
            "GET",
            `/homes/dashboard?t=${Date.now()}`
        );
    }

    // ==========================================
    // CLIMATE ZONES
    // ==========================================

    setManual(zoneId, temperature) {
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/manual`,
            {
                roomTemperatureSetPoint:
                    this.number(temperature, "temperature")
            }
        );
    }

    setSchedule(zoneId, programId) {
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/schedule`,
            {
                heatingProgramId:
                    this.number(programId, "programId")
            }
        );
    }

    setTemporaryOverride(zoneId, temperature) {
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/temporary-override`,
            {
                roomTemperatureSetPoint:
                    this.number(temperature, "temperature")
            }
        );
    }

    setOff(zoneId) {
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/anti-frost`
        );
    }

    activateHeatingProgram(zoneId, programId) {
        const id = this.programId(programId);

        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/time-programs/heating/${id}/activate`
        );
    }

    setFireplaceMode(zoneId, enabled) {
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/fireplacemode`,
            {
                fireplaceModeActive: Boolean(enabled)
            }
        );
    }

    setFireplace(zoneId, enabled) {
        return this.setFireplaceMode(zoneId, enabled);
    }

    // ==========================================
    // HEATING PROGRAMS
    // ==========================================

    // Read heating schedule (program 1, 2 or 3)
    getHeatingSchedule(zoneId, programId = 1) {
        const id = this.programId(programId);

        return this.request(
            "GET",
            `/climate-zones/${encodeURIComponent(zoneId)}/time-programs/heating/${id}`
        );
    }

    // Write heating schedule
    // Pass the schedule object returned by getHeatingSchedule()
    // after editing its switch points.
    setHeatingSchedule(zoneId, programId, schedule) {
        const id = this.programId(programId);

        if (
            !schedule ||
            typeof schedule !== "object" ||
            Array.isArray(schedule)
        ) {
            throw new Error("schedule must be an object");
        }

        return this.request(
            "PUT",
            `/climate-zones/${encodeURIComponent(zoneId)}/time-programs/heating/${id}`,
            schedule
        );
    }

    // ==========================================
    // ACTIVITIES / PRESETS
    // ==========================================

    getActivities(zoneId) {
        return this.request(
            "GET",
            `/climate-zones/${encodeURIComponent(zoneId)}/activities`
        );
    }

    // ==========================================
    // HOT WATER / DHW
    // ==========================================

    setHotWaterEco(zoneId) {
        return this.request(
            "POST",
            `/hot-water-zones/${encodeURIComponent(zoneId)}/modes/anti-frost`
        );
    }

    setHotWaterSchedule(zoneId) {
        return this.request(
            "POST",
            `/hot-water-zones/${encodeURIComponent(zoneId)}/modes/schedule`
        );
    }

    setHotWaterComfort(zoneId) {
        return this.request(
            "POST",
            `/hot-water-zones/${encodeURIComponent(zoneId)}/modes/continuous-comfort`
        );
    }

    setHotWaterEcoTemperature(zoneId, temperature) {
        return this.request(
            "POST",
            `/hot-water-zones/${encodeURIComponent(zoneId)}/reduced-setpoint`,
            {
                reducedSetpoint:
                    this.number(temperature, "temperature")
            }
        );
    }

    setHotWaterComfortTemperature(zoneId, temperature) {
        return this.request(
            "POST",
            `/hot-water-zones/${encodeURIComponent(zoneId)}/comfort-setpoint`,
            {
                comfortSetpoint:
                    this.number(temperature, "temperature")
            }
        );
    }

    // ==========================================
    // TECHNICAL INFORMATION
    // ==========================================

    getTechnicalInformation(applianceId) {
        return this.request(
            "GET",
            `/appliances/${encodeURIComponent(applianceId)}/technicaldetails`
        );
    }

    // ==========================================
    // ENERGY CONSUMPTION
    // ==========================================

    number(value, name) {
        const result = Number(value);

        if (!Number.isFinite(result)) {
            throw new Error(`Invalid ${name}`);
        }

        return result;
    }

    programId(value) {
        const id = this.number(value, "programId");

        if (!Number.isInteger(id) || id < 1 || id > 3) {
            throw new Error("programId must be 1, 2 or 3");
        }

        return id;
    }

    formatDate(value) {
        const date = new Date(value);

        if (Number.isNaN(date.getTime())) {
            throw new Error("Invalid date: " + value);
        }

        return date.toISOString().replace("T", " ");
    }

    getConsumption(applianceId, period, startDate, endDate) {
        const allowed = ["daily", "monthly", "yearly"];

        if (!allowed.includes(period)) {
            throw new Error("Invalid consumption period");
        }

        if (!startDate || !endDate) {
            throw new Error("startDate and endDate are required");
        }

        const start = new Date(startDate);
        const end = new Date(endDate);

        if (
            Number.isNaN(start.getTime()) ||
            Number.isNaN(end.getTime())
        ) {
            throw new Error("Invalid consumption dates");
        }

        if (start > end) {
            throw new Error("startDate must be before endDate");
        }

        const params = new URLSearchParams({
            startDate: this.formatDate(start),
            endDate: this.formatDate(end)
        });

        return this.request(
            "GET",
            `/appliances/${encodeURIComponent(applianceId)}/energyconsumption/${period}?${params}`
        );
    }

    getConsumptionDaily(applianceId, startDate, endDate) {
        return this.getConsumption(
            applianceId, "daily", startDate, endDate
        );
    }

    getConsumptionMonthly(applianceId, startDate, endDate) {
        return this.getConsumption(
            applianceId, "monthly", startDate, endDate
        );
    }

    getConsumptionYearly(applianceId, startDate, endDate) {
        return this.getConsumption(
            applianceId, "yearly", startDate, endDate
        );
    }

    getConsumptionToday(applianceId) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);

        const end = new Date();
        end.setHours(23, 59, 59, 999);

        return this.getConsumption(
            applianceId,
            "daily",
            start,
            end
        );
    }
}

module.exports = RemehaAPI;
