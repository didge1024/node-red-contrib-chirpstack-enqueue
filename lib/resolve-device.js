"use strict";

const app_pb = require("@chirpstack/chirpstack-api/api/application_pb");
const device_pb = require("@chirpstack/chirpstack-api/api/device_pb");

function isEui(str) {
    return typeof str === "string" && /^[0-9a-fA-F]{16}$/.test(str);
}

function listApplicationIds(appClient, metadata) {
    return new Promise((resolve, reject) => {
        const req = new app_pb.ListApplicationsRequest();
        req.setLimit(1000);
        appClient.list(req, metadata, (err, res) => {
            if (err) return reject(err);
            resolve(res.getResultList().map(a => a.getId()));
        });
    });
}

function findDeviceInApp(deviceClient, applicationId, name, metadata) {
    return new Promise((resolve, reject) => {
        const req = new device_pb.ListDevicesRequest();
        req.setApplicationId(applicationId);
        req.setLimit(1000);
        deviceClient.list(req, metadata, (err, res) => {
            if (err) return reject(err);
            const match = res.getResultList().find(d => d.getName() === name);
            resolve(match ? match.getDevEui() : null);
        });
    });
}

async function resolveDevEui(identifier, applicationId, appClient, deviceClient, metadata) {
    if (isEui(identifier)) return identifier;

    const appIds = applicationId
        ? [applicationId]
        : await listApplicationIds(appClient, metadata);

    if (appIds.length === 0) {
        throw new Error("No applications accessible for this token");
    }

    for (const appId of appIds) {
        const eui = await findDeviceInApp(deviceClient, appId, identifier, metadata);
        if (eui) return eui;
    }

    throw new Error(`Device name not found: ${identifier}`);
}

module.exports = { isEui, resolveDevEui };
