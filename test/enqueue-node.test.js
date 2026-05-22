"use strict";
const assert = require("assert");
const sinon = require("sinon");
const proxyquire = require("proxyquire").noCallThru();

// ---------------------------------------------------------------------------
// Minimal RED mock — replaces node-red-node-test-helper.
// No dependency on the node-red package itself.
// ---------------------------------------------------------------------------
function makeRED() {
    const nodeMap = new Map();
    const types = {};

    const RED = {
        nodes: {
            createNode(node, config) {
                const handlers = {};
                node.on = (evt, fn) => { handlers[evt] = fn; };
                // _emit awaits async input handlers so tests can assert after send()
                node._emit = async (evt, ...args) => {
                    const result = handlers[evt]?.(...args);
                    if (result instanceof Promise) await result;
                };
                node.status = sinon.stub();
                node.error  = sinon.stub();
                node.warn   = sinon.stub();
                node.send   = sinon.stub();
                node.id     = config.id;
                nodeMap.set(config.id, node);
            },
            getNode: id => nodeMap.get(id) || null,
            registerType(typeName, Ctor) {
                types[typeName] = Ctor;
            }
        },
        // Instantiate a node type with given config + credentials
        _instantiate(typeName, config, credentials) {
            const Ctor = types[typeName];
            const node = { credentials: credentials || {} };
            Ctor.call(node, config);
            return node;
        }
    };

    return RED;
}

// ---------------------------------------------------------------------------
// Shared gRPC stub (Metadata class + createInsecure)
// ---------------------------------------------------------------------------
const grpcStub = {
    credentials: { createInsecure: sinon.stub().returns({}) },
    Metadata: class {
        constructor() { this._entries = {}; }
        set(k, v) { this._entries[k] = v; }
    }
};

// ---------------------------------------------------------------------------
// Helper: load chirpstack-enqueue with stubbed gRPC clients
// ---------------------------------------------------------------------------
function loadNode({ enqueueResult, enqueueError }) {
    class DeviceClient {
        enqueue(req, meta, cb) { cb(enqueueError || null, enqueueResult || null); }
        list(req, meta, cb)    { cb(null, { getResultList: () => [] }); }
        close() {}
    }
    class AppClient {
        list(req, meta, cb) { cb(null, { getResultList: () => [] }); }
        close() {}
    }

    return proxyquire("../chirpstack-enqueue", {
        "@grpc/grpc-js": grpcStub,
        "@chirpstack/chirpstack-api/api/device_grpc_pb":      { DeviceServiceClient: DeviceClient },
        "@chirpstack/chirpstack-api/api/application_grpc_pb": { ApplicationServiceClient: AppClient },
        "@chirpstack/chirpstack-api/api/device_pb": require("@chirpstack/chirpstack-api/api/device_pb"),
        "./lib/resolve-device": require("../lib/resolve-device")
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("chirpstack-enqueue node", () => {

    it("enqueues successfully when devEui is provided directly", async () => {
        const nodeModule = loadNode({
            enqueueResult: { getId: () => "test-uuid-1234", getFCnt: () => 42 }
        });
        const RED = makeRED();
        nodeModule(RED);

        RED._instantiate("chirpstack-server",
            { id: "srv", server: "localhost:8080" },
            { apiToken: "test-api-key" }
        );
        const n1 = RED._instantiate("chirpstack-enqueue",
            { id: "n1", server: "srv", devEui: "0102030405060708", fPort: 10 }
        );

        await n1._emit("input", { payload: "deadbeef" });

        assert.strictEqual(n1.send.calledOnce, true);
        const msg = n1.send.firstCall.args[0];
        assert.strictEqual(msg.payload.success, true);
        assert.strictEqual(msg.payload.id, "test-uuid-1234");
        assert.strictEqual(msg.payload.devEui, "0102030405060708");
        assert.strictEqual(msg.payload.fCnt, 42);
    });

    it("sends error output when enqueue gRPC call fails", async () => {
        const grpcError = Object.assign(new Error("UNAVAILABLE"), { code: 14, details: "server unreachable" });
        const nodeModule = loadNode({ enqueueError: grpcError });
        const RED = makeRED();
        nodeModule(RED);

        RED._instantiate("chirpstack-server",
            { id: "srv", server: "localhost:8080" },
            { apiToken: "test-api-key" }
        );
        const n1 = RED._instantiate("chirpstack-enqueue",
            { id: "n1", server: "srv", devEui: "0102030405060708", fPort: 10 }
        );

        await n1._emit("input", { payload: "deadbeef" });

        assert.strictEqual(n1.send.calledOnce, true);
        const msg = n1.send.firstCall.args[0];
        assert.strictEqual(msg.payload.success, false);
        assert.strictEqual(msg.error.code, 14);
    });

    it("sends error output when device identifier is missing", async () => {
        const nodeModule = loadNode({ enqueueResult: { getId: () => "x", getFCnt: () => 1 } });
        const RED = makeRED();
        nodeModule(RED);

        RED._instantiate("chirpstack-server",
            { id: "srv", server: "localhost:8080" },
            { apiToken: "test-api-key" }
        );
        const n1 = RED._instantiate("chirpstack-enqueue",
            { id: "n1", server: "srv", fPort: 10 }  // no devEui in config
        );

        await n1._emit("input", { payload: "deadbeef" });  // no devEui in msg

        assert.strictEqual(n1.send.calledOnce, true);
        const msg = n1.send.firstCall.args[0];
        assert.strictEqual(msg.payload.success, false);
        assert.ok(msg.error.message.includes("Device identifier missing"));
    });

    it("msg.devEui overrides config.devEui", async () => {
        const nodeModule = loadNode({
            enqueueResult: { getId: () => "uuid-from-msg", getFCnt: () => 1 }
        });
        const RED = makeRED();
        nodeModule(RED);

        RED._instantiate("chirpstack-server",
            { id: "srv", server: "localhost:8080" },
            { apiToken: "test-api-key" }
        );
        const n1 = RED._instantiate("chirpstack-enqueue",
            { id: "n1", server: "srv", devEui: "aabbccdd11223344", fPort: 10 }
        );

        await n1._emit("input", { payload: "deadbeef", devEui: "0102030405060708" });

        const msg = n1.send.firstCall.args[0];
        assert.strictEqual(msg.payload.devEui, "0102030405060708");
    });

    it("msg.apiKey is used in place of config apiToken", async () => {
        let capturedMeta = null;
        class DeviceClientCapture {
            enqueue(req, meta, cb) {
                capturedMeta = meta;
                cb(null, { getId: () => "x", getFCnt: () => 1 });
            }
            list(req, meta, cb) { cb(null, { getResultList: () => [] }); }
            close() {}
        }
        const nodeModule = proxyquire("../chirpstack-enqueue", {
            "@grpc/grpc-js": grpcStub,
            "@chirpstack/chirpstack-api/api/device_grpc_pb":      { DeviceServiceClient: DeviceClientCapture },
            "@chirpstack/chirpstack-api/api/application_grpc_pb": { ApplicationServiceClient: class { list(r,m,cb){cb(null,{getResultList:()=>[]})} close(){} } },
            "@chirpstack/chirpstack-api/api/device_pb": require("@chirpstack/chirpstack-api/api/device_pb"),
            "./lib/resolve-device": require("../lib/resolve-device")
        });

        const RED = makeRED();
        nodeModule(RED);

        RED._instantiate("chirpstack-server",
            { id: "srv", server: "localhost:8080" },
            { apiToken: "default-key" }
        );
        const n1 = RED._instantiate("chirpstack-enqueue",
            { id: "n1", server: "srv", devEui: "0102030405060708", fPort: 10 }
        );

        await n1._emit("input", { payload: "deadbeef", apiKey: "override-key" });

        assert.ok(capturedMeta._entries["authorization"].includes("override-key"));
    });
});
