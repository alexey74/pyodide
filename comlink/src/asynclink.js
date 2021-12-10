var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { requestResponseMessage } from "./request_response";
import { fromWireValue, toWireValue, transfer, throwMarker, isObject, storeCreate, storeGetValue, storeDeleteKey, } from "./transfer_handlers";
import { ComlinkTask, syncResponse } from "./comlink_task";
// import { syncRequest, syncResponse } from "./synclink";
export const createEndpoint = Symbol("Comlink.endpoint");
export const releaseProxy = Symbol("Comlink.releaseProxy");
export function expose(obj_arg, ep = self) {
    storeCreate(ep);
    ep.addEventListener("message", function callback(ev) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!ev || !ev.data) {
                return;
            }
            const { id, type, path, store_key } = Object.assign({ path: [] }, ev.data);
            let obj;
            if (store_key) {
                obj = storeGetValue(ep, store_key);
            }
            else {
                obj = obj_arg;
            }
            const argumentList = (ev.data.argumentList || []).map((v) => fromWireValue(ep, v));
            let returnValue;
            try {
                const last = path.pop();
                let parent = path.reduce((obj, prop) => obj[prop], obj);
                const rawValue = last ? parent[last] : parent;
                if (!last) {
                    parent = undefined;
                }
                if (rawValue === undefined) {
                    switch (type) {
                        case "GET" /* GET */:
                        case "SET" /* SET */:
                            break;
                        default:
                            console.warn("Undefined", obj, path, last);
                            throw new Error("undefined!!");
                    }
                }
                switch (type) {
                    case "GET" /* GET */:
                        {
                            returnValue = rawValue;
                        }
                        break;
                    case "SET" /* SET */:
                        {
                            parent[last] = fromWireValue(ep, ev.data.value);
                            returnValue = true;
                        }
                        break;
                    case "APPLY" /* APPLY */:
                        {
                            if (last) {
                                returnValue = parent[last].apply(parent, argumentList);
                            }
                            else {
                                returnValue = rawValue.apply(parent, argumentList);
                            }
                        }
                        break;
                    case "CONSTRUCT" /* CONSTRUCT */:
                        {
                            const value = new rawValue(...argumentList);
                            returnValue = proxy(value);
                        }
                        break;
                    case "ENDPOINT" /* ENDPOINT */:
                        {
                            const { port1, port2 } = new MessageChannel();
                            expose(obj, port2);
                            returnValue = transfer(port1, [port1]);
                        }
                        break;
                    case "RELEASE" /* RELEASE */:
                        {
                            returnValue = undefined;
                        }
                        break;
                    case "DESTROY" /* DESTROY */:
                        {
                            storeDeleteKey(ep, store_key);
                            returnValue = undefined;
                        }
                        break;
                    default:
                        return;
                }
                returnValue = yield returnValue;
            }
            catch (value) {
                returnValue = { value, [throwMarker]: 0 };
            }
            const [wireValue, transferables] = toWireValue(ep, returnValue);
            if (ev.data.syncify) {
                syncResponse(ep, ev.data, wireValue);
            }
            else {
                ep.postMessage(Object.assign(Object.assign({}, wireValue), { id }), transferables);
            }
            if (type === "RELEASE" /* RELEASE */) {
                // detach and deactive after sending release response above.
                ep.removeEventListener("message", callback);
                closeEndPoint(ep);
            }
        });
    });
    if (ep.start) {
        ep.start();
    }
}
function isMessagePort(endpoint) {
    return endpoint.constructor.name === "MessagePort";
}
function closeEndPoint(endpoint) {
    if (isMessagePort(endpoint))
        endpoint.close();
}
export function wrap(ep, target) {
    return createProxy(ep, undefined, [], target);
}
function throwIfProxyReleased(isReleased) {
    if (isReleased) {
        throw new Error("Proxy has been released and is not useable");
    }
}
export function createProxy(ep, store_key, path = [], target = function () { }, keys = []) {
    let isProxyReleased = false;
    const proxy = new Proxy(target, {
        get(_target, prop) {
            throwIfProxyReleased(isProxyReleased);
            switch (prop) {
                case (Symbol.toStringTag):
                    return "ComlinkProxy";
                case (releaseProxy):
                    return () => {
                        new ComlinkTask(ep, {
                            type: "RELEASE" /* RELEASE */,
                            path: path.map((p) => p.toString()),
                        }, [], () => {
                            closeEndPoint(ep);
                            isProxyReleased = true;
                        });
                    };
                case ("__destroy__"):
                    if (!store_key) {
                        return () => { };
                    }
                    return () => {
                        return new ComlinkTask(ep, {
                            type: "DESTROY" /* DESTROY */,
                            store_key,
                        }, [], () => {
                            isProxyReleased = true;
                        });
                    };
                case ("then"):
                case ("schedule_async"):
                case ("schedule_sync"):
                case ("syncify"):
                    if (path.length === 0 && prop === "then") {
                        return { then: () => proxy };
                    }
                    let r = new ComlinkTask(ep, {
                        type: "GET" /* GET */,
                        store_key,
                        path: path.map((p) => p.toString()),
                    });
                    return r[prop].bind(r);
                default:
                    return createProxy(ep, store_key, [...path, prop]);
            }
        },
        set(_target, prop, rawValue) {
            throwIfProxyReleased(isProxyReleased);
            // FIXME: ES6 Proxy Handler `set` methods are supposed to return a
            // boolean. To show good will, we return true asynchronously ¯\_(ツ)_/¯
            const [value, transferables] = toWireValue(ep, rawValue);
            return requestResponseMessage(ep, {
                type: "SET" /* SET */,
                store_key,
                path: [...path, prop].map((p) => p.toString()),
                value,
            }, transferables).then((v) => fromWireValue(ep, v));
        },
        apply(_target, _thisArg, rawArgumentList) {
            throwIfProxyReleased(isProxyReleased);
            const last = path[path.length - 1];
            if (last === createEndpoint) {
                return requestResponseMessage(ep, {
                    type: "ENDPOINT" /* ENDPOINT */,
                }).then((v) => fromWireValue(ep, v));
            }
            // We just pretend that `bind()` didn’t happen.
            if (last === "bind") {
                return createProxy(ep, store_key, path.slice(0, -1));
            }
            if (last === "apply") {
                // temporary hack...
                rawArgumentList = rawArgumentList[1];
                path = path.slice(0, -1);
            }
            const [argumentList, transferables] = processArguments(ep, rawArgumentList);
            return new ComlinkTask(ep, {
                type: "APPLY" /* APPLY */,
                store_key,
                path: path.map((p) => p.toString()),
                argumentList,
            }, transferables);
        },
        construct(_target, rawArgumentList) {
            throwIfProxyReleased(isProxyReleased);
            const [argumentList, transferables] = processArguments(ep, rawArgumentList);
            return requestResponseMessage(ep, {
                type: "CONSTRUCT" /* CONSTRUCT */,
                store_key,
                path: path.map((p) => p.toString()),
                argumentList,
            }, transferables).then((v) => fromWireValue(ep, v));
        },
        ownKeys(_target) {
            return keys;
        },
    });
    return proxy;
}
function myFlat(arr) {
    return Array.prototype.concat.apply([], arr);
}
function processArguments(ep, argumentList) {
    const processed = argumentList.map((v) => toWireValue(ep, v));
    return [processed.map((v) => v[0]), myFlat(processed.map((v) => v[1]))];
}
export function windowEndpoint(w, context = self, targetOrigin = "*") {
    return {
        postMessage: (msg, transferables) => w.postMessage(msg, targetOrigin, transferables),
        addEventListener: context.addEventListener.bind(context),
        removeEventListener: context.removeEventListener.bind(context),
    };
}
export const proxyMarker = Symbol("Comlink.proxy");
export function proxy(obj) {
    return Object.assign(obj, { [proxyMarker]: true });
}
/**
 * Internal transfer handle to handle objects marked to proxy.
 */
export const proxyTransferHandler = {
    canHandle: (val) => isObject(val) && val[proxyMarker],
    serialize(obj) {
        const { port1, port2 } = new MessageChannel();
        expose(obj, port1);
        return [port2, [port2]];
    },
    deserialize(port) {
        port.start();
        return wrap(port);
    },
};
