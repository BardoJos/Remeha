
"use strict";

const RemehaAuth = require("../lib/auth");
const RemehaAPI = require("../lib/api");

module.exports = function(RED) {

    function RemehaNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
        const credentials = RED.nodes.getCredentials(config.id) || {};

        const pollInterval = Math.max(
            30000,
            Number(config.pollInterval || 60) * 1000
        );

        let auth;
        let api;
        let timer = null;
        let busy = false;
        let stopped = false;

        let dashboard = null;
        let lastEnergy = 0;
        let technical = {};
        let energy = {};

        function status(fill, shape, text) {
            node.status({ fill, shape, text });
        }

        function createClient() {
            auth = new RemehaAuth({
                email: credentials.email,
                password: credentials.password,
                token: credentials.token || null,
                onToken: async token => {
                    await RED.nodes.addCredentials(config.id, {
                        ...credentials,
                        token
                    });
                }
            });

            api = new RemehaAPI(auth, config);
        }

        function buildSensors(data) {
            const sensors = [];

            for (const appliance of data.appliances || []) {
                const id = appliance.applianceId;

                sensors.push({
                    id,
                    name: appliance.houseName || id,
                    type: "appliance",
                    values: {
                        waterPressure: appliance.waterPressure,
                        online: appliance.applianceOnline,
                        connectionStatus:
                            appliance.applianceConnectionStatus,
                        errorStatus: appliance.errorStatus,
                        technical: technical[id] || {},
                        energy: energy[id] || {}
                    }
                });

                for (const zone of appliance.climateZones || []) {
                    sensors.push({
                        id: zone.climateZoneId,
                        name: zone.name,
                        type: "climate",
                        values: {
                            temperature: zone.roomTemperature,
                            setpoint: zone.setPoint,
                            mode: zone.zoneMode,
                            minimum: zone.setPointMin,
                            maximum: zone.setPointMax,
                            nextSetpoint: zone.nextSetpoint,
                            nextSwitchTime: zone.nextSwitchTime,
                            currentScheduleSetpoint:
                                zone.currentScheduleSetPoint,
                            fireplaceMode: zone.firePlaceModeActive,
                            activeProgram:
                                zone.activeHeatingClimateTimeProgramNumber
                        }
                    });
                }

                for (const zone of appliance.hotWaterZones || []) {
                    sensors.push({
                        id: zone.hotWaterZoneId,
                        name: zone.name,
                        type: "hotwater",
                        values: {
                            temperature: zone.dhwTemperature,
                            mode: zone.dhwZoneMode,
                            status: zone.dhwStatus
                        }
                    });
                }
            }

            return sensors;
        }

        async function update() {
            if (busy || stopped) return;

            busy = true;

            try {
                const data = await api.getDashboard();

                if (!data || !Array.isArray(data.appliances)) {
                    throw new Error("Ongeldig dashboard ontvangen");
                }

                dashboard = data;

                const now = Date.now();

                for (const appliance of data.appliances) {
                    const id = appliance.applianceId;

                    if (!technical[id]) {
                        try {
                            technical[id] =
                                await api.getTechnicalInformation(id);
                        } catch (error) {
                            node.warn(
                                "Technische informatie: " + error.message
                            );
                        }
                    }

                    if (now - lastEnergy >= 900000) {
                        try {
                            energy[id] =
                                await api.getConsumptionToday(id);
                        } catch (error) {
                            node.warn(
                                "Energy data: " + error.message
                            );
                        }
                    }
                }

                if (now - lastEnergy >= 900000) {
                    lastEnergy = now;
                }

                node.send([
					{
						topic: "remeha/dashboard",
						payload: data
					},
					{
						topic: "remeha/sensors",
						payload: buildSensors(data)
					},
					null
				]);

                status("green", "dot", "Connected");

            } catch (error) {
                status("red", "ring", "Error");

                node.error(
                    "Remeha update: " + error.message
                );

                node.send([
					null,
					null,
					{
						topic: "remeha/error",
						payload: {
							message: error.message,
							statusCode: error.response?.status
						}
					}
				]);
            } finally {
                busy = false;
            }
        }

        function findZone(id, type) {
            if (!dashboard) {
                throw new Error("Dashboard not yet available");
            }

            for (const appliance of dashboard.appliances || []) {
                const zones = type === "hotwater"
                    ? appliance.hotWaterZones || []
                    : appliance.climateZones || [];

                const zone = zones.find(z =>
                    (type === "hotwater"
                        ? z.hotWaterZoneId
                        : z.climateZoneId) === id
                );

                if (zone) return zone;
            }

            throw new Error("Zone not found: " + id);
        }

        async function command(p) {
            const id = p.zoneId;

            switch (p.action) {
                case "dashboard":
                    await update();
                    return dashboard;

                case "manual":
                    findZone(id, "climate");
                    return api.setManual(id, p.setpoint);

                case "schedule":
                    findZone(id, "climate");
                    return api.setSchedule(id, p.programId);

                case "temporary_override":
                    findZone(id, "climate");
                    return api.setTemporaryOverride(id, p.setpoint);

                case "off":
                    findZone(id, "climate");
                    return api.setOff(id);

                case "activate_program":
                    findZone(id, "climate");
                    return api.activateHeatingProgram(
                        id, p.programId
                    );

                case "fireplace":
                    findZone(id, "climate");
                    return api.setFireplace(id, p.enabled);

                case "technical":
                    return api.getTechnicalInformation(
                        p.applianceId
                    );

                case "consumption":
                    return api.getConsumptionToday(
                        p.applianceId
                    );

                default:
                    throw new Error(
                        "Unknown action: " + p.action
                    );
            }
        }

        createClient();

        status("yellow", "ring", "Connecting...");

        update();

        timer = setInterval(update, pollInterval);

        node.on("input", async function(msg, send, done) {
            send = send || node.send;

            try {
                if (!msg.payload || typeof msg.payload !== "object") {
                    throw new Error("msg.payload must be object (json)");
                }

                const result = await command(msg.payload);

                if (msg.payload.action !== "dashboard") {
                    await update();
                }

                send([
					null,
					null,
					{
						...msg,
						topic: "remeha/command",
						payload: {
							success: true,
							action: msg.payload.action,
							result
						}
					}
				]);

                if (done) done();

            } catch (error) {
                const errorMessage = {
                    ...msg,
                    topic: "remeha/error",
                    payload: {
                        success: false,
                        action: msg.payload?.action,
                        error: error.message,
                        statusCode: error.response?.status
                    }
                };

                send([
					null,
					null,
					{
						...msg,
						topic: "remeha/error",
						payload: {
							success: false,
							action: msg.payload?.action,
							error: error.message,
							statusCode: error.response?.status
						}
					}
				]);

                if (done) done(error);
            }
        });

        node.on("close", function() {
            stopped = true;

            if (timer) {
                clearInterval(timer);
                timer = null;
            }

            status("grey", "ring", "Stopped");
        });
    }

    RED.nodes.registerType("remeha-home", RemehaNode, {
        credentials: {
            email: { type: "text" },
            password: { type: "password" },
            token: { type: "password" }
        }
    });
};
