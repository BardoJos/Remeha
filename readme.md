
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

1. Enter your Remeha email address.
2. Enter your password.
3. Select the polling interval.
4. Select the energy interval.
5. Deploy.

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

### Set Fireplace mode

    {
      "action": "fireplace",
      "zoneId": "ZONE_ID",
      "enabled": true
    }

### Get Hotwater eco

    {
      "action": "hotwater_eco",
      "zoneId": "ZONE_ID"
    }

### Set Hotwater schedule

    {
      "action": "hotwater_eco",
      "zoneId": "ZONE_ID"
    } 

### Set Hotwater comfort

    {
      "action": "hotwater_comfort",
      "zoneId": "ZONE_ID"
    } 

### Set Hotwater eco temperature
 
    {
      "action": "hotwater_eco_temperature",
      "zoneId": "ZONE_ID",
      "temperature": 21
    } 

### Set Hotwater comfort temperature
 
    {
      "action": "hotwater_comfort_temperature",
      "zoneId": "ZONE_ID",
      "temperature": 21
    } 

### Technical information

    {
      "action": "technical",
      "applianceId": "APPLIANCE_ID"
    }

### Get Energy consumption
 
- "action": "consumption"
- "action": "consumption_today"
- "action": "consumption_daily"
- "action": "consumption_monthly"
- "action": "consumption_yearly"

    {
      "action": "consumption",
      "applianceId": "APPLIANCE_ID"
    }

## Notes

The API is an undocumented third-party API.
Authentication and endpoints may change.

This project is not affiliated with Remeha or BDR Thermea.
Created with help from: AI, python projects
