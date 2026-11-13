
"use strict";

const axios = require("axios");

class RemehaAPI {
    constructor(auth, config) {
        this.auth = auth;		
        this.baseApi         = config.baseApi;	
        this.subscriptionKey = config.subscriptionKey;
    }

    async request(method, path, data) {
        const token = await this.auth.getAccessToken();

        const options = {
            method,
            url: this.baseApi + path,
            data,
            timeout: 30000,
            headers: {
                Authorization: `Bearer ${token}`,
                "Ocp-Apim-Subscription-Key": this.subscriptionKey,
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

            await this.auth.refresh();

            options.headers.Authorization =
                `Bearer ${this.auth.token.access_token}`;

            const retry = await axios(options);
            return retry.data;
        }
    }

    getDashboard() {
        return this.request(
            "GET",
            `/homes/dashboard?t=${Date.now()}`
        );
    }

    setManual(zoneId, temperature) {
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/manual`,
            {
                roomTemperatureSetPoint: Number(temperature)
            }
        );
    }

    setSchedule(zoneId, programId) {
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/schedule`,
            {
                heatingProgramId: Number(programId)
            }
        );
    }

    setTemporaryOverride(zoneId, temperature) {
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/temporary-override`,
            {
                roomTemperatureSetPoint: Number(temperature)
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
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/time-programs/heating/${Number(programId)}/activate`
        );
    }

    setFireplace(zoneId, enabled) {
        return this.request(
            "POST",
            `/climate-zones/${encodeURIComponent(zoneId)}/modes/fireplacemode`,
            {
                fireplaceModeActive: Boolean(enabled)
            }
        );
    }

    getTechnicalInformation(applianceId) {
        return this.request(
            "GET",
            `/appliances/${encodeURIComponent(applianceId)}/technicaldetails`
        );
    }

    getConsumptionToday(applianceId) {
        const start = new Date();
        start.setHours(0, 0, 0, 0);

        const end = new Date(start);
        end.setHours(23, 59, 59, 0);

        const format = date =>
            date.toISOString().replace("T", " ")
                .replace("Z", ".000Z");

        const params = new URLSearchParams({
            startDate: format(start),
            endDate: format(end)
        });

        return this.request(
            "GET",
            `/appliances/${encodeURIComponent(applianceId)}/energyconsumption/daily?${params}`
        );
    }
}

module.exports = RemehaAPI;
