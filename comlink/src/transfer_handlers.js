import { generateUUID } from "./request_response";
import { createProxy } from "./asynclink";
export const throwMarker = Symbol("Comlink.thrown");
const transferCache = new WeakMap();
export function transfer(obj, transfers) {
    transferCache.set(obj, transfers);
    return obj;
}
export const isObject = (val) => (typeof val === "object" && val !== null) || typeof val === "function";
/**
 * Allows customizing the serialization of certain values.
 */
export const transferHandlers = new Map();
function isPlain(val) {
    return (typeof val === "undefined" ||
        typeof val === "string" ||
        typeof val === "boolean" ||
        typeof val === "number" ||
        Array.isArray(val) ||
        !val.constructor ||
        (val.constructor === Object &&
            Object.prototype.toString.call(val) === "[object Object]"));
}
function isSerializable(obj, transfers = []) {
    if (transfers.includes(obj)) {
        return true;
    }
    if (!isPlain(obj)) {
        return false;
    }
    for (var property in obj) {
        if (obj.hasOwnProperty(property)) {
            if (!isPlain(obj[property])) {
                return false;
            }
            if (typeof obj[property] == "object") {
                if (!isSerializable(obj[property], transfers)) {
                    return false;
                }
            }
        }
    }
    return true;
}
/**
 * Internal transfer handler to handle thrown exceptions.
 */
export const throwTransferHandler = {
    canHandle: (value) => isObject(value) && throwMarker in value,
    serialize({ value }) {
        let serialized;
        if (value instanceof Error) {
            serialized = {
                isError: true,
                value: {
                    message: value.message,
                    name: value.name,
                    stack: value.stack,
                },
            };
        }
        else {
            serialized = { isError: false, value };
        }
        return [serialized, []];
    },
    deserialize(serialized) {
        if (serialized.isError) {
            throw Object.assign(new Error(serialized.value.message), serialized.value);
        }
        throw serialized.value;
    },
};
export function toWireValue(ep, value) {
    for (const [name, handler] of transferHandlers) {
        if (handler.canHandle(value)) {
            const [serializedValue, transferables] = handler.serialize(value);
            return [
                {
                    type: "HANDLER" /* HANDLER */,
                    name,
                    value: serializedValue,
                },
                transferables,
            ];
        }
    }
    if (isSerializable(value, transferCache.get(value))) {
        return [
            {
                type: "RAW" /* RAW */,
                value,
            },
            transferCache.get(value) || [],
        ];
    }
    let store_key = storeNewValue(ep, value);
    return [
        {
            type: "ID" /* ID */,
            store_key,
            endpoint_uuid: ep[endpointUUID],
            ownkeys: Object.getOwnPropertyNames(value),
        },
        [],
    ];
}
export function fromWireValue(ep, value) {
    switch (value.type) {
        case "HANDLER" /* HANDLER */:
            return transferHandlers.get(value.name).deserialize(value.value);
        case "RAW" /* RAW */:
            return value.value;
        case "ID" /* ID */:
            let this_uuid = ep[endpointUUID];
            if (this_uuid === value.endpoint_uuid) {
                return storeGetValue(ep, value.store_key);
            }
            else {
                return createProxy(ep, value.store_key, []);
            }
    }
}
const proxyStore = Symbol("Comlink.proxyStore");
const endpointUUID = Symbol("Comlink.endpointUUID");
export function storeCreate(obj) {
    if (proxyStore in obj) {
        return;
    }
    obj[proxyStore] = { objects: new Map(), counter: new Uint32Array([1]) };
    obj[endpointUUID] = generateUUID();
}
export function storeGetValue(obj, key) {
    return obj[proxyStore].objects.get(key);
}
export function storeNewValue(obj, value) {
    if (!(proxyStore in obj)) {
        storeCreate(obj);
    }
    let { objects, counter } = obj[proxyStore];
    while (objects.has(counter[0])) {
        // Increment by two here (and below) because even integers are reserved
        // for singleton constants
        counter[0] += 2;
    }
    let key = counter[0];
    counter[0] += 2;
    objects.set(key, value);
    return key;
}
export function storeDeleteKey(obj, key) {
    let { objects } = obj[proxyStore];
    objects.delete(key);
    console.log("deleted", key, objects);
}
