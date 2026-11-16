
"use strict";

const RemehaAuth = require("../lib/auth");
const RemehaAPI = require("../lib/api");

module.exports = function(RED) {
	
	function RemehaAccountNode(config) {

		RED.nodes.createNode(this, config);

		const node = this;

		node.getCredentials = function() {

			const credentials = node.credentials || {};

			return {
				email: credentials.email,
				password: credentials.password,
				token: credentials.token || null
			};
		};

		node.updateToken = async function(token) {

			const credentials = node.getCredentials();

			await RED.nodes.addCredentials(node.id, {
				email: credentials.email,
				password: credentials.password,
				token: token
			});
		};
	}
	
    function RemehaHomeNode(config) {
        RED.nodes.createNode(this, config);

        const node = this;
		const account = RED.nodes.getNode(config.account);

		if (!account) {
			node.error("Remeha account not configured");
			return;
		}
		
        const pollingEnabled = config.pollingEnabled !== false;

        const pollInterval = Math.max(
            30000,
            Number(config.pollInterval || 60) * 1000
        );
		
		const energyPollingEnabled =
			config.energyPollingEnabled !== false;

		const energyInterval = Math.max(
			1,
			Number(config.energyInterval || 15)
		) * 60 * 1000;

        let auth;
        let api;
        let timer = null;
        let stopped = false;

        let dashboard = null;
        let lastEnergy = 0;

        let technical = {};
        let energy = {};

        function status(fill, shape, text) {
            node.status({ fill, shape, text });
        }

        function createClient() {

			const credentials = account.getCredentials();

			if (!credentials.email || !credentials.password) {
				throw new Error(
					"Remeha email or password is missing"
				);
			}

			auth = new RemehaAuth({

				email: credentials.email,
				password: credentials.password,
				token: credentials.token,

				onToken: async token => {
					await account.updateToken(token);
				}
			});

			api = new RemehaAPI(auth, config);
		}

        // ==========================================
        // BUILD SENSOR DATA
        // ==========================================

        function buildSensors(data) {
            const sensors = [];

            for (const appliance of data.appliances || []) {

                const id = appliance.applianceId;

                // Appliance
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

                // Climate zones
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

                            fireplaceMode:
                                zone.firePlaceModeActive,

                            activeProgram:
                                zone.activeHeatingClimateTimeProgramNumber
                        }
                    });
                }

                // Hot water zones
                for (const zone of appliance.hotWaterZones || []) {

                    sensors.push({
                        id: zone.hotWaterZoneId,
                        name: zone.name,
                        type: "hotwater",

                        values: {
                            temperature: zone.dhwTemperature,
                            mode: zone.dhwZoneMode,
                            status: zone.dhwStatus,

                            ecoSetpoint: zone.reducedSetpoint,
                            comfortSetpoint: zone.comfortSetpoint
                        }
                    });
                }
            }

            return sensors;
        }
		
		let updatePromise = null;

		// ==========================================
		// DASHBOARD UPDATE
		// ==========================================

		function update() {

			// Node will shutdown
			if (stopped) {
				return Promise.resolve(dashboard);
			}

			// update active: return same promise
			if (updatePromise) {
				return updatePromise;
			}

			updatePromise = (async function() {

				try {

					const data = await api.getDashboard();

					if (!data || !Array.isArray(data.appliances)) {
						throw new Error("Invalid dashboard received");
					}

					dashboard = data;

					const now = Date.now();

					const refreshEnergy =
						energyPollingEnabled &&
						(
							!lastEnergy ||
							now - lastEnergy >= energyInterval
						);

					for (const appliance of data.appliances) {

						if (stopped) break;

						const id = appliance.applianceId;

						// Technical information
						if (!technical[id]) {
							try {
								technical[id] =
									await api.getTechnicalInformation(id);

							} catch (error) {
								node.warn(
									"Technical information: " +
									error.message
								);
							}
						}

						// Energy consumption
						if (refreshEnergy) {
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

					if (refreshEnergy) {
						lastEnergy = now;
					}

					if (!stopped) {

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
					}

					return dashboard;

				} catch (error) {

					status("red", "ring", "Error");

					node.error(
						"Remeha update: " + error.message
					);

					if (!stopped) {
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
					}

					throw error;

				}

			})().finally(() => {

				// Update is finished, next update is allowed
				updatePromise = null;

			});

			return updatePromise;
		}

			async function ensureDashboard() {

			// Wait when update already busy
			if (updatePromise) {
				await updatePromise;
			}

			// Dashboard missing: get
			if (
				!dashboard ||
				!Array.isArray(dashboard.appliances)
			) {
				await update();
			}

			if (
				!dashboard ||
				!Array.isArray(dashboard.appliances)
			) {
				throw new Error(
					"Unable to retrieve dashboard"
				);
			}

			return dashboard;
		}


        // ==========================================
        // FIND ZONES AND APPLIANCES
        // ==========================================

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

        function findAppliance(id) {

            if (!dashboard) {
                throw new Error("Dashboard not yet available");
            }

            const appliance = dashboard.appliances.find(
                item => item.applianceId === id
            );

            if (!appliance) {
                throw new Error("Appliance not found: " + id);
            }

            return appliance;
        }

        // ==========================================
        // COMMAND HANDLER
        // ==========================================

        async function command(p) {

            const id = p.zoneId;

			// Actions die dashboardinformatie nodig hebben
			const dashboardActions = [
				"manual",
				"schedule",
				"temporary_override",
				"off",
				"activate_program",
				"fireplace",
				"hotwater_eco",
				"hotwater_schedule",
				"hotwater_comfort",
				"hotwater_eco_temperature",
				"hotwater_comfort_temperature",
				"technical",
				"consumption",
				"consumption_today",
				"consumption_daily",
				"consumption_monthly",
				"consumption_yearly"
			];

			if (dashboardActions.includes(p.action)) {
				await ensureDashboard();
			}
			
            switch (p.action) {

                // ----------------------------------
                // DASHBOARD
                // ----------------------------------

                case "dashboard":
                    await update();
                    return dashboard;

                // ----------------------------------
                // CLIMATE
                // ----------------------------------

                case "manual":
                    findZone(id, "climate");

                    return api.setManual(
                        id,
                        p.setpoint
                    );

                case "schedule":
                    findZone(id, "climate");

                    return api.setSchedule(
                        id,
                        p.programId
                    );

                case "temporary_override":
                    findZone(id, "climate");

                    return api.setTemporaryOverride(
                        id,
                        p.setpoint
                    );

                case "off":
                    findZone(id, "climate");

                    return api.setOff(id);

                case "activate_program":
                    findZone(id, "climate");

                    return api.activateHeatingProgram(
                        id,
                        p.programId
                    );

                case "fireplace":
                    findZone(id, "climate");

                    return api.setFireplaceMode(
                        id,
                        p.enabled
                    );

                // ----------------------------------
                // HOT WATER / DHW
                // ----------------------------------

                case "hotwater_eco":
                    findZone(id, "hotwater");

                    return api.setHotWaterEco(id);

                case "hotwater_schedule":
                    findZone(id, "hotwater");

                    return api.setHotWaterSchedule(id);

                case "hotwater_comfort":
                    findZone(id, "hotwater");

                    return api.setHotWaterComfort(id);

                case "hotwater_eco_temperature":
                    findZone(id, "hotwater");

                    if (p.temperature === undefined) {
                        throw new Error(
                            "temperature is required"
                        );
                    }

                    return api.setHotWaterEcoTemperature(
                        id,
                        p.temperature
                    );

                case "hotwater_comfort_temperature":
                    findZone(id, "hotwater");

                    if (p.temperature === undefined) {
                        throw new Error(
                            "temperature is required"
                        );
                    }

                    return api.setHotWaterComfortTemperature(
                        id,
                        p.temperature
                    );

                // ----------------------------------
                // TECHNICAL INFORMATION
                // ----------------------------------

                case "technical":

                    findAppliance(p.applianceId);

                    return api.getTechnicalInformation(
                        p.applianceId
                    );

                // ----------------------------------
                // ENERGY CONSUMPTION
                // ----------------------------------

                // Legacy action
                case "consumption":
                case "consumption_today":

                    findAppliance(p.applianceId);

                    return api.getConsumptionToday(
                        p.applianceId
                    );

                case "consumption_daily":

                    findAppliance(p.applianceId);

                    return api.getConsumptionDaily(
                        p.applianceId,
                        p.startDate,
                        p.endDate
                    );

                case "consumption_monthly":

                    findAppliance(p.applianceId);

                    return api.getConsumptionMonthly(
                        p.applianceId,
                        p.startDate,
                        p.endDate
                    );

                case "consumption_yearly":

                    findAppliance(p.applianceId);

                    return api.getConsumptionYearly(
                        p.applianceId,
                        p.startDate,
                        p.endDate
                    );

                default:

                    throw new Error(
                        "Unknown action: " + p.action
                    );
            }
        }

        // ==========================================
        // INITIALIZATION
        // ==========================================

        createClient();

        if (pollingEnabled) {

            status("yellow", "ring", "Connecting...");

            update().catch(() => {});

			timer = setInterval(() => {
				update().catch(() => {});
			}, pollInterval);

        } else {

            status("blue", "ring", "Manual...");
        }

        // ==========================================
        // INPUT
        // ==========================================

        node.on("input", async function(msg, send, done) {

            send = send || node.send;
            try {

				// Convert string to JSON
				if (typeof msg.payload === "string") {
					try {
						msg.payload = JSON.parse(msg.payload);
					} catch (error) {
						throw new Error(
							"msg.payload contains invalid JSON: " + error.message
						);
					}
				}
				
                if (
                    !msg.payload ||
                    typeof msg.payload !== "object" ||
                    Array.isArray(msg.payload)
                ) {
                    throw new Error(
                        "msg.payload must be object (json)"
                    );
                }
				
				// Action validation
				if (
					typeof msg.payload.action !== "string" ||
					!msg.payload.action.trim()
				) {
					throw new Error(
						"msg.payload.action must be a non-empty string"
					);
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

        // ==========================================
        // CLOSE
        // ==========================================

        node.on("close", function() {

            stopped = true;

            if (timer) {
                clearInterval(timer);
                timer = null;
            }

            status("grey", "ring", "Stopped");
        });
    }
	
	RED.nodes.registerType(
        "remeha-account",
        RemehaAccountNode,
        {
            credentials: {
                email: { type: "text" },
                password: { type: "password" },
                token: { type: "password" }
            }
        }
    );

    RED.nodes.registerType(
        "remeha-home",
        RemehaHomeNode
    );

};