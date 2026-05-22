module.exports = function(RED) {
    "use strict";

    const device = require("@chirpstack/chirpstack-api/api/device_grpc_pb");
    const device_pb = require("@chirpstack/chirpstack-api/api/device_pb");
    const app_service = require("@chirpstack/chirpstack-api/api/application_grpc_pb");
    const grpc = require("@grpc/grpc-js");
    const { resolveDevEui } = require("./lib/resolve-device");

    // ====================================================================
    //  ChirpStack Server Config Node
    // ====================================================================
    function ChirpStackServerNode(config) {
        RED.nodes.createNode(this, config);
        this.server = config.server;
        this.apiToken = this.credentials.apiToken;
    }

    RED.nodes.registerType("chirpstack-server", ChirpStackServerNode, {
        credentials: {
            apiToken: { type: "password" }
        }
    });

    // ====================================================================
    //  Unicast Downlink Node (chirpstack-enqueue)
    // ====================================================================
    function ChirpStackEnqueueNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const serverConfig = RED.nodes.getNode(config.server);
        if (!serverConfig) {
            node.error("Missing ChirpStack Server configuration");
            return;
        }

        const defaultServer = serverConfig.server;
        const defaultApiKey = serverConfig.apiToken;

        if (!defaultServer || !defaultApiKey) {
            node.error("ChirpStack server or API token not configured");
            return;
        }

        // Default clients (used when msg does not override server address)
        node.deviceClient = new device.DeviceServiceClient(
            defaultServer,
            grpc.credentials.createInsecure()
        );
        node.appClient = new app_service.ApplicationServiceClient(
            defaultServer,
            grpc.credentials.createInsecure()
        );

        node.status({ fill: "grey", shape: "ring", text: "Ready" });

        // ====================================================================
        //  Handle incoming messages
        // ====================================================================
        node.on("input", async function(msg) {

            // Resolve server and API key (msg overrides config)
            const server = msg.server || defaultServer;
            const apiKey = msg.apiKey || defaultApiKey;

            // Resolve device identifier (EUI or name)
            const identifier = config.devEui
                || msg.devEui
                || msg.devName
                || (msg.payload && (msg.payload.devEui || msg.payload.devName));

            // Resolve optional application ID for scoping name lookups
            const applicationId = config.applicationId
                || msg.applicationId
                || (msg.payload && msg.payload.applicationId)
                || null;

            // Resolve fPort
            const fPort = config.fPort
                || msg.fPort
                || (msg.payload && msg.payload.fPort)
                || 10;

            // Resolve confirmed flag
            let confirmed = false;
            if (typeof config.confirmed === "boolean") confirmed = config.confirmed;
            if (typeof msg.confirmed === "boolean") confirmed = msg.confirmed;
            if (msg.payload && typeof msg.payload.confirmed === "boolean")
                confirmed = msg.payload.confirmed;

            // Resolve data
            let data = (msg.payload && msg.payload.data !== undefined)
                ? msg.payload.data
                : msg.payload;

            if (!identifier) {
                node.error("Device identifier missing (devEui or devName)");
                node.status({ fill: "red", shape: "ring", text: "Missing device" });
                return;
            }

            // ====================================================================
            //  Convert payload to Buffer
            // ====================================================================
            let dataBuffer;
            try {
                if (Buffer.isBuffer(data)) {
                    dataBuffer = data;
                }
                else if (typeof data === "string") {
                    if (/^[0-9A-Fa-f]+$/.test(data) && data.length % 2 === 0) {
                        dataBuffer = Buffer.from(data, "hex");
                    }
                    else if (/^[A-Za-z0-9+/=]+$/.test(data)) {
                        dataBuffer = Buffer.from(data, "base64");
                    }
                    else {
                        dataBuffer = Buffer.from(data, "utf8");
                    }
                }
                else if (typeof data === "object" && data && data.type === "Buffer") {
                    dataBuffer = Buffer.from(data.data);
                }
                else {
                    throw new Error("Unsupported payload format");
                }
            }
            catch (err) {
                node.error("Payload conversion error: " + err.message);
                node.status({ fill: "red", shape: "ring", text: "Conversion error" });
                return;
            }

            // Debug logging
            if (config.debug) {
                node.warn("=== ChirpStack Unicast Enqueue ===");
                node.warn("identifier: " + identifier);
                node.warn("applicationId: " + applicationId);
                node.warn("fPort: " + fPort);
                node.warn("confirmed: " + confirmed);
                node.warn("data (hex): " + dataBuffer.toString("hex"));
                node.warn("data (base64): " + dataBuffer.toString("base64"));
            }

            // Authentication metadata
            const metadata = new grpc.Metadata();
            metadata.set("authorization", "Bearer " + apiKey);

            // Use per-message clients if server address differs from config
            let deviceClient = node.deviceClient;
            let appClient = node.appClient;
            let tempClients = null;

            if (server !== defaultServer) {
                deviceClient = new device.DeviceServiceClient(server, grpc.credentials.createInsecure());
                appClient = new app_service.ApplicationServiceClient(server, grpc.credentials.createInsecure());
                tempClients = [deviceClient, appClient];
            }

            node.status({ fill: "blue", shape: "dot", text: "Resolving..." });

            let devEui;
            try {
                devEui = await resolveDevEui(identifier, applicationId, appClient, deviceClient, metadata);
            }
            catch (err) {
                node.error("Device resolution error: " + err.message);
                node.status({ fill: "red", shape: "ring", text: "Resolution error" });
                msg.payload = { success: false };
                msg.error = { message: err.message };
                node.send(msg);
                if (tempClients) tempClients.forEach(c => c.close());
                return;
            }

            // ====================================================================
            //  Build the Enqueue request
            // ====================================================================
            const request = new device_pb.EnqueueDeviceQueueItemRequest();
            const queueItem = new device_pb.DeviceQueueItem();

            queueItem.setDevEui(devEui);
            queueItem.setFPort(fPort);
            queueItem.setConfirmed(confirmed);
            queueItem.setData(dataBuffer);

            request.setQueueItem(queueItem);

            node.status({ fill: "blue", shape: "dot", text: "Sending..." });

            // ====================================================================
            //  Send request
            // ====================================================================
            deviceClient.enqueue(request, metadata, (error, response) => {
                if (tempClients) tempClients.forEach(c => c.close());

                if (error) {
                    node.error("gRPC enqueue error: " + error.message);
                    node.status({ fill: "red", shape: "ring", text: "Error" });

                    msg.payload = { success: false };
                    msg.error = {
                        message: error.message,
                        code: error.code,
                        details: error.details
                    };

                    return node.send(msg);
                }

                const id = response.getId ? response.getId() : undefined;
                const fCnt = response.getFCnt ? response.getFCnt() : undefined;

                node.status({
                    fill: "green",
                    shape: "dot",
                    text: fCnt !== undefined ? "Sent (fCnt: " + fCnt + ")" : "Sent"
                });

                msg.payload = {
                    success: true,
                    id,
                    fCnt,
                    devEui,
                    fPort,
                    confirmed,
                    timestamp: new Date().toISOString()
                };

                node.send(msg);

                setTimeout(() => {
                    node.status({ fill: "grey", shape: "ring", text: "Ready" });
                }, 3000);
            });
        });

        // Cleanup on close
        node.on("close", function() {
            if (node.deviceClient) node.deviceClient.close();
            if (node.appClient) node.appClient.close();
        });
    }

    RED.nodes.registerType("chirpstack-enqueue", ChirpStackEnqueueNode);
};
