
# node-red-contrib-remeha-home

Standalone Remeha Home integration for Node-RED.

## Requirements

- Node-RED 4.x
- Node.js 20+
- A working Remeha Home account

## Installation

From your Node-RED user directory:

    npm install ./node-red-contrib-remeha-home

Restart Node-RED.

## Configuration

1. Add a Remeha Home node.
2. Enter your Remeha email address.
3. Enter your password.
4. Select the polling interval.
5. Deploy.

The node automatically starts retrieving the dashboard.

## Outputs

Output 1:
- Dashboard JSON

Output 2:
- Sensor data
- Command responses
- Errors

## Commands

### Get dashboard

    {
      "action": "dashboard"
    }

### Set manual temperature

    {
      "action": "manual",
      "zoneId": "ZONE_ID",
      "setpoint": 21
    }

### Set schedule

    {
      "action": "schedule",
      "zoneId": "ZONE_ID",
      "programId": 1
    }

### Temporary override

    {
      "action": "temporary_override",
      "zoneId": "ZONE_ID",
      "setpoint": 20
    }

### Off / frost protection

    {
      "action": "off",
      "zoneId": "ZONE_ID"
    }

### Activate heating program

    {
      "action": "activate_program",
      "zoneId": "ZONE_ID",
      "programId": 2
    }

### Fireplace mode

    {
      "action": "fireplace",
      "zoneId": "ZONE_ID",
      "enabled": true
    }

### Technical information

    {
      "action": "technical",
      "applianceId": "APPLIANCE_ID"
    }

### Energy consumption

    {
      "action": "consumption",
      "applianceId": "APPLIANCE_ID"
    }

## Notes

The API is an undocumented third-party API.
Authentication and endpoints may change.

This project is not affiliated with Remeha or BDR Thermea.
Basic code is found in a python project
