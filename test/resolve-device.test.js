"use strict";
const assert = require("assert");
const sinon = require("sinon");
const { isEui, resolveDevEui } = require("../lib/resolve-device");

describe("isEui", () => {
    it("returns true for a valid 16-char lowercase hex EUI", () => {
        assert.strictEqual(isEui("0102030405060708"), true);
    });
    it("returns true for uppercase hex EUI", () => {
        assert.strictEqual(isEui("AABBCCDDEEFF0011"), true);
    });
    it("returns false for a human-readable device name", () => {
        assert.strictEqual(isEui("my-sensor"), false);
    });
    it("returns false for a hex string of wrong length", () => {
        assert.strictEqual(isEui("010203040506"), false);
    });
    it("returns false for undefined", () => {
        assert.strictEqual(isEui(undefined), false);
    });
    it("returns false for empty string", () => {
        assert.strictEqual(isEui(""), false);
    });
});

describe("resolveDevEui", () => {
    it("returns the EUI directly when identifier is a valid EUI", async () => {
        const result = await resolveDevEui("0102030405060708", null, null, null, null);
        assert.strictEqual(result, "0102030405060708");
    });

    it("resolves a device name across all applications", async () => {
        const metadata = {};
        const appClient = { list: sinon.stub() };
        const deviceClient = { list: sinon.stub() };

        const appListRes = {
            getResultList: () => [
                { getId: () => "app-uuid-1" },
                { getId: () => "app-uuid-2" }
            ]
        };
        appClient.list.callsArgWith(2, null, appListRes);

        const devListRes1 = {
            getResultList: () => [
                { getName: () => "other-device", getDevEui: () => "aaaaaaaaaaaaaaaa" }
            ]
        };
        const devListRes2 = {
            getResultList: () => [
                { getName: () => "my-sensor", getDevEui: () => "0102030405060708" }
            ]
        };
        deviceClient.list
            .onFirstCall().callsArgWith(2, null, devListRes1)
            .onSecondCall().callsArgWith(2, null, devListRes2);

        const result = await resolveDevEui("my-sensor", null, appClient, deviceClient, metadata);
        assert.strictEqual(result, "0102030405060708");
    });

    it("scopes the search to the provided applicationId and skips listing apps", async () => {
        const metadata = {};
        const appClient = { list: sinon.stub() };
        const deviceClient = { list: sinon.stub() };

        const devListRes = {
            getResultList: () => [
                { getName: () => "my-sensor", getDevEui: () => "0102030405060708" }
            ]
        };
        deviceClient.list.callsArgWith(2, null, devListRes);

        const result = await resolveDevEui("my-sensor", "specific-app-id", appClient, deviceClient, metadata);
        assert.strictEqual(result, "0102030405060708");
        sinon.assert.notCalled(appClient.list);
    });

    it("throws when device name is not found in any application", async () => {
        const metadata = {};
        const appClient = { list: sinon.stub() };
        const deviceClient = { list: sinon.stub() };

        const appListRes = { getResultList: () => [{ getId: () => "app-1" }] };
        appClient.list.callsArgWith(2, null, appListRes);

        const devListRes = { getResultList: () => [] };
        deviceClient.list.callsArgWith(2, null, devListRes);

        await assert.rejects(
            resolveDevEui("unknown-device", null, appClient, deviceClient, metadata),
            /Device name not found: unknown-device/
        );
    });

    it("throws when no applications are accessible for the token", async () => {
        const metadata = {};
        const appClient = { list: sinon.stub() };

        const appListRes = { getResultList: () => [] };
        appClient.list.callsArgWith(2, null, appListRes);

        await assert.rejects(
            resolveDevEui("my-sensor", null, appClient, null, metadata),
            /No applications accessible for this token/
        );
    });

    it("rejects when ApplicationService.List returns a gRPC error", async () => {
        const metadata = {};
        const appClient = { list: sinon.stub() };
        appClient.list.callsArgWith(2, new Error("UNAUTHENTICATED"), null);

        await assert.rejects(
            resolveDevEui("my-sensor", null, appClient, null, metadata),
            /UNAUTHENTICATED/
        );
    });

    it("rejects when DeviceService.List returns a gRPC error", async () => {
        const metadata = {};
        const appClient = { list: sinon.stub() };
        const deviceClient = { list: sinon.stub() };

        const appListRes = { getResultList: () => [{ getId: () => "app-1" }] };
        appClient.list.callsArgWith(2, null, appListRes);
        deviceClient.list.callsArgWith(2, new Error("PERMISSION_DENIED"), null);

        await assert.rejects(
            resolveDevEui("my-sensor", null, appClient, deviceClient, metadata),
            /PERMISSION_DENIED/
        );
    });
});
